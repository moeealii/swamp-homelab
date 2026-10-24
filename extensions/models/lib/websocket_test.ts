import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { acceptKey, type ByteStream, encodeFrame, WebSocketClient } from "./websocket.ts";

Deno.test("acceptKey: matches the example in RFC 6455 section 1.3", async () => {
  assertEquals(await acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

Deno.test("encodeFrame: uses 7-bit, 16-bit and 64-bit lengths at the right sizes, always masked", () => {
  const mask = new Uint8Array([1, 2, 3, 4]);
  assertEquals(encodeFrame(1, new Uint8Array(125), mask).slice(0, 2), new Uint8Array([0x81, 0x80 | 125]));
  assertEquals(
    encodeFrame(1, new Uint8Array(126), mask).slice(0, 4),
    new Uint8Array([0x81, 0x80 | 126, 0, 126]),
  );
  const big = encodeFrame(1, new Uint8Array(65536), mask);
  assertEquals(big.slice(0, 2), new Uint8Array([0x81, 0x80 | 127]));
  assertEquals(new DataView(big.buffer).getBigUint64(2), 65536n);
  const hi = encodeFrame(1, new TextEncoder().encode("hi"), mask);
  assertEquals(hi.slice(6), new Uint8Array(["h".charCodeAt(0) ^ 1, "i".charCodeAt(0) ^ 2]));
});

/** A stream that replays a server's bytes and records what the client writes. */
function scripted(serverBytes: Uint8Array[]): ByteStream & { written: Uint8Array[]; queue: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return {
    written,
    queue: serverBytes,
    read: (p) => {
      const next = serverBytes.shift();
      if (!next) return Promise.resolve(null);
      p.set(next);
      return Promise.resolve(next.length);
    },
    write: (p) => {
      written.push(p.slice());
      return Promise.resolve(p.length);
    },
    close: () => {},
  };
}

/** Build the server's 101 response for whatever key the client sends. */
async function handshake(
  stream: ReturnType<typeof scripted>,
  frames: Uint8Array[],
): Promise<WebSocketClient> {
  // The client writes its request before reading, so compute the reply lazily.
  const origRead = stream.read;
  let answered = false;
  stream.read = async (p) => {
    if (!answered) {
      answered = true;
      const req = new TextDecoder().decode(stream.written[0]);
      const key = req.match(/Sec-WebSocket-Key: (.+)\r\n/)![1];
      const head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${await acceptKey(key)}\r\n\r\n`;
      // Frames may arrive in the same packet as the headers.
      const first = frames.shift() ?? new Uint8Array();
      stream.queue.push(...frames); // the rest arrive as later reads
      const bytes = new Uint8Array([...new TextEncoder().encode(head), ...first]);
      p.set(bytes);
      return bytes.length;
    }
    return origRead(p);
  };
  return await WebSocketClient.open(stream, "nas", "/api/current");
}

const serverFrame = (b0: number, payload: string) => {
  const bytes = new TextEncoder().encode(payload);
  return new Uint8Array([b0, bytes.length, ...bytes]); // servers do not mask
};

Deno.test("receive: reassembles fragments and answers pings in between", async () => {
  const stream = scripted([]);
  const ws = await handshake(stream, [
    serverFrame(0x01, '{"id":'), // text, not final
    serverFrame(0x89, "are you there"), // ping, final
    serverFrame(0x80, "1}"), // continuation, final
  ]);
  assertEquals(await ws.receive(), '{"id":1}');
  const pong = stream.written[1];
  assertEquals(pong[0], 0x8a, "a pong frame was sent");
  assertEquals(pong[1] & 0x7f, "are you there".length);
});

Deno.test("receive: a close frame ends the session with its code and reason", async () => {
  const stream = scripted([]);
  const reason = new TextEncoder().encode("bye");
  const ws = await handshake(stream, [new Uint8Array([0x88, 2 + reason.length, 0x03, 0xe9, ...reason])]);
  await assertRejects(() => ws.receive(), Error, "closed by peer (1001: bye)");
});

Deno.test("open: refuses a server that answers with the wrong accept key", async () => {
  const head = "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: wrong\r\n\r\n";
  const stream = scripted([new TextEncoder().encode(head)]);
  await assertRejects(
    () => WebSocketClient.open(stream, "nas", "/api/current"),
    Error,
    "bad Sec-WebSocket-Accept",
  );
});

Deno.test("open: reports an HTTP error instead of upgrading", async () => {
  const stream = scripted([new TextEncoder().encode("HTTP/1.1 404 Not Found\r\n\r\n")]);
  await assertRejects(
    () => WebSocketClient.open(stream, "nas", "/api/current"),
    Error,
    "handshake refused: HTTP/1.1 404",
  );
});
