/**
 * A fake TrueNAS JSON-RPC server for tests: a real WebSocket server on
 * 127.0.0.1 whose methods are plain functions.
 *
 * @module
 */
import type { ByteStream } from "./websocket.ts";

/** A method handler: return the result, or throw `{ code, message, data }` to send an error. */
export type Handler = (params: unknown[]) => unknown;

/** A running fake server. */
export interface FakeTrueNas {
  /** Connector to pass as `_connect`, so the client reaches this server over plain TCP. */
  connect: () => Promise<ByteStream>;
  /** Every call received, in order. */
  calls: { method: string; params: unknown[] }[];
  /** Stop the server. */
  close: () => Promise<void>;
}

/** Start a fake server. `auth.login_ex` succeeds unless a handler overrides it. */
export function fakeTrueNas(
  methods: Record<string, Handler>,
  opts: { notifyFirst?: boolean } = {},
): FakeTrueNas {
  const calls: FakeTrueNas["calls"] = [];
  const handlers: Record<string, Handler> = {
    "auth.login_ex": () => ({ response_type: "SUCCESS" }),
    ...methods,
  };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname !== "/api/current") return new Response("not found", { status: 404 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      calls.push({ method: msg.method, params: msg.params });
      if (opts.notifyFirst) {
        socket.send(
          JSON.stringify({ jsonrpc: "2.0", method: "collection_update", params: { msg: "changed" } }),
        );
      }
      const handler = handlers[msg.method];
      if (!handler) {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
        return;
      }
      try {
        const result = await handler(msg.params ?? []);
        if (result === NO_REPLY) return;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      } catch (err) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: err }));
      }
    };
    return response;
  });
  const port = server.addr.port;
  return {
    calls,
    connect: () => Deno.connect({ hostname: "127.0.0.1", port }),
    close: () => server.shutdown(),
  };
}

/** Return this from a handler to never answer the call (for timeout tests). */
export const NO_REPLY = Symbol("no reply");

/** A TrueNAS-style method error, as the middleware sends it. */
export function callError(errname: string, reason: string): unknown {
  return {
    code: -32001,
    message: "Method call error",
    data: { error: 22, errname, reason, trace: { formatted: "Traceback (most recent call last): ..." } },
  };
}
