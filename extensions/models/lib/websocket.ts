/**
 * A small RFC 6455 WebSocket client that runs over any Deno byte stream.
 *
 * Deno's built-in `WebSocket` cannot trust a self-signed certificate for one
 * connection: a custom `HttpClient` with extra CA certificates forces HTTP/2,
 * which TrueNAS does not offer. Opening the TLS connection ourselves with
 * `Deno.connectTls({ caCerts })` and speaking the WebSocket protocol on top
 * lets us pin the appliance's own certificate instead of disabling
 * verification. Only what a JSON-RPC client needs is implemented: text
 * messages, fragmentation, ping/pong and close.
 *
 * @module
 */

/** The subset of `Deno.Conn` this client uses, so tests can supply their own. */
export interface ByteStream {
  /** Read into `p`, resolving to the byte count, or `null` at end of stream. */
  read(p: Uint8Array): Promise<number | null>;
  /** Write `p`, resolving to the number of bytes written. */
  write(p: Uint8Array): Promise<number>;
  /** Close the underlying connection. */
  close(): void;
}

/** Thrown for protocol violations and unexpected closes. */
export class WebSocketError extends Error {
  /** Create an error with the given message. */
  constructor(message: string) {
    super(message);
    this.name = "WebSocketError";
  }
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Refuse single messages larger than this, so a broken peer cannot exhaust memory. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** `base64(sha1(key + GUID))`, the value the server must echo in `Sec-WebSocket-Accept`. */
export async function acceptKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    encoder.encode(key + GUID),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Encode one masked client frame (clients must mask, RFC 6455 §5.3). */
export function encodeFrame(
  opcode: number,
  payload: Uint8Array,
  mask: Uint8Array = crypto.getRandomValues(new Uint8Array(4)),
): Uint8Array {
  const len = payload.length;
  const header = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const frame = new Uint8Array(header + 4 + len);
  frame[0] = 0x80 | opcode; // FIN + opcode
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    new DataView(frame.buffer).setUint16(2, len);
  } else {
    frame[1] = 0x80 | 127;
    new DataView(frame.buffer).setBigUint64(2, BigInt(len));
  }
  frame.set(mask, header);
  for (let i = 0; i < len; i++) frame[header + 4 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

/** Buffered reader that hands out exact byte counts from a stream. */
class Reader {
  private buf: Uint8Array = new Uint8Array(0);

  constructor(private readonly stream: ByteStream, initial?: Uint8Array) {
    if (initial) this.buf = initial;
  }

  async fill(): Promise<void> {
    const chunk = new Uint8Array(64 * 1024);
    const n = await this.stream.read(chunk);
    if (n === null) throw new WebSocketError("connection closed by peer");
    const next = new Uint8Array(this.buf.length + n);
    next.set(this.buf);
    next.set(chunk.subarray(0, n), this.buf.length);
    this.buf = next;
  }

  async take(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Read up to and including `\r\n\r\n`; returns the text before it. */
  async headers(limit = 16 * 1024): Promise<string> {
    for (;;) {
      // Search bytes, not decoded text: frame bytes may already follow the headers.
      for (let i = 0; i + 3 < this.buf.length; i++) {
        if (
          this.buf[i] === 13 && this.buf[i + 1] === 10 && this.buf[i + 2] === 13 &&
          this.buf[i + 3] === 10
        ) {
          const head = new TextDecoder().decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 4);
          return head;
        }
      }
      if (this.buf.length > limit) throw new WebSocketError("handshake response too large");
      await this.fill();
    }
  }
}

/** One open WebSocket connection. Create it with {@link WebSocketClient.open}. */
export class WebSocketClient {
  private closed = false;

  private constructor(
    private readonly stream: ByteStream,
    private readonly reader: Reader,
  ) {}

  /**
   * Perform the opening handshake over an already-connected stream.
   * `host` goes in the `Host` header; `path` is the resource, e.g. `/api/current`.
   */
  static async open(
    stream: ByteStream,
    host: string,
    path: string,
  ): Promise<WebSocketClient> {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n");
    await stream.write(encoder.encode(request));

    const reader = new Reader(stream);
    const head = await reader.headers();
    const [status, ...lines] = head.split("\r\n");
    if (!/^HTTP\/1\.1 101\b/.test(status)) {
      throw new WebSocketError(`handshake refused: ${status}`);
    }
    const headers = new Map(
      lines.map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
      }),
    );
    if (headers.get("sec-websocket-accept") !== await acceptKey(key)) {
      throw new WebSocketError("handshake failed: bad Sec-WebSocket-Accept");
    }
    return new WebSocketClient(stream, reader);
  }

  /** Send one text message. */
  async send(text: string): Promise<void> {
    if (this.closed) throw new WebSocketError("socket is closed");
    await this.writeAll(encodeFrame(OP_TEXT, encoder.encode(text)));
  }

  /**
   * Wait for the next complete text message. Pings are answered and pongs
   * ignored along the way; a close frame or end of stream throws.
   */
  async receive(): Promise<string> {
    const parts: Uint8Array[] = [];
    let size = 0;
    let messageOp: number | null = null;
    for (;;) {
      const [b0, b1] = await this.reader.take(2);
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      if (len === 126) {
        len = new DataView((await this.reader.take(2)).buffer).getUint16(0);
      } else if (len === 127) {
        const big = new DataView((await this.reader.take(8)).buffer).getBigUint64(0);
        if (big > BigInt(MAX_MESSAGE_BYTES)) throw new WebSocketError("frame too large");
        len = Number(big);
      }
      const mask = (b1 & 0x80) !== 0 ? await this.reader.take(4) : null;
      const payload = await this.reader.take(len);
      if (mask) { for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4]; }

      if (opcode === OP_PING) {
        await this.writeAll(encodeFrame(OP_PONG, payload));
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_CLOSE) {
        this.closed = true;
        const code = payload.length >= 2 ? new DataView(payload.buffer).getUint16(0) : 1005;
        const reason = new TextDecoder().decode(payload.subarray(2));
        this.stream.close();
        throw new WebSocketError(`closed by peer (${code}${reason ? `: ${reason}` : ""})`);
      }
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (messageOp !== null) throw new WebSocketError("new message before previous one finished");
        messageOp = opcode;
      } else if (opcode !== OP_CONTINUATION || messageOp === null) {
        throw new WebSocketError(`unexpected opcode ${opcode}`);
      }

      size += payload.length;
      if (size > MAX_MESSAGE_BYTES) throw new WebSocketError("message too large");
      parts.push(payload);
      if (!fin) continue;

      const whole = new Uint8Array(size);
      let off = 0;
      for (const p of parts) {
        whole.set(p, off);
        off += p.length;
      }
      try {
        return decoder.decode(whole);
      } catch {
        throw new WebSocketError("message is not valid UTF-8");
      }
    }
  }

  /** Send a close frame (best effort) and close the connection. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writeAll(encodeFrame(OP_CLOSE, new Uint8Array([0x03, 0xe8]))); // 1000 normal
    } catch {
      // the peer may already be gone; closing is all that matters
    }
    this.stream.close();
  }

  /** Close the connection immediately, without a close frame. Unblocks a pending `receive`. */
  abort(): void {
    this.closed = true;
    try {
      this.stream.close();
    } catch {
      // already closed
    }
  }

  private async writeAll(data: Uint8Array): Promise<void> {
    let off = 0;
    while (off < data.length) off += await this.stream.write(data.subarray(off));
  }
}
