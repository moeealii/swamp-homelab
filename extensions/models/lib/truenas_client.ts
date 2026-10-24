/**
 * JSON-RPC 2.0 client for the TrueNAS API (`wss://<host>/api/current`).
 *
 * TrueNAS 25.10 and later removed the REST API; everything goes through this
 * WebSocket. API keys are only ever sent over TLS: TrueNAS revokes a key that
 * is used over plain HTTP, so there is deliberately no `ws://` option.
 *
 * @module
 */

import { type ByteStream, WebSocketClient } from "./websocket.ts";

/** Connection settings for {@link TrueNasClient.connect}. */
export interface TrueNasOptions {
  /** Hostname or IP address of the NAS. */
  host: string;
  /** HTTPS port, normally 443. */
  port: number;
  /** User the API key belongs to. */
  username: string;
  /** API key from the TrueNAS UI (Credentials → API Keys). */
  apiKey: string;
  /**
   * PEM of the NAS's own (usually self-signed) certificate. When set, only
   * that certificate is trusted and the hostname check is skipped, since the
   * default TrueNAS certificate is issued to `localhost`. When unset, the
   * system trust store and normal hostname verification apply.
   */
  certificatePem?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
  /** Opens the transport. Defaults to TLS; tests inject a plain socket. */
  connect?: (opts: TrueNasOptions) => Promise<ByteStream>;
}

/** A JSON-RPC error returned by the TrueNAS middleware. */
export class TrueNasError extends Error {
  /** Create an error from a JSON-RPC error object. */
  constructor(
    message: string,
    /** JSON-RPC error code, e.g. -32001 for a method call error. */
    readonly code?: number,
    /** TrueNAS error name, e.g. `ENOTAUTHENTICATED` or `EINVAL`. */
    readonly errname?: string,
  ) {
    super(message);
    this.name = "TrueNasError";
  }
}

interface RpcError {
  code?: number;
  message?: string;
  data?: { errname?: string; reason?: string };
}

/** Turn a JSON-RPC error object into a readable error (TrueNAS tracebacks are dropped). */
export function rpcError(method: string, err: RpcError): TrueNasError {
  const reason = err.data?.reason ?? err.message ?? "unknown error";
  return new TrueNasError(`${method}: ${reason}`, err.code, err.data?.errname);
}

/** Open a TLS connection that trusts the pinned certificate when one is given. */
export function connectTls(opts: TrueNasOptions): Promise<ByteStream> {
  return Deno.connectTls({
    hostname: opts.host,
    port: opts.port,
    ...(opts.certificatePem
      ? { caCerts: [opts.certificatePem], unsafelyDisableHostnameVerification: true }
      : {}),
  });
}

/** An authenticated session. Calls are sequential; one request is in flight at a time. */
export class TrueNasClient {
  private nextId = 0;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly ws: WebSocketClient,
    private readonly timeoutMs: number,
  ) {}

  /** Connect, upgrade to WebSocket and log in with the API key. */
  static async connect(opts: TrueNasOptions): Promise<TrueNasClient> {
    const stream = await (opts.connect ?? connectTls)(opts);
    let ws: WebSocketClient;
    try {
      ws = await withTimeout(
        WebSocketClient.open(stream, opts.host, "/api/current"),
        opts.timeoutMs,
        () => stream.close(),
        "WebSocket handshake",
      );
    } catch (e) {
      stream.close();
      throw e;
    }
    const client = new TrueNasClient(ws, opts.timeoutMs);
    try {
      const res = await client.call<{ response_type: string }>("auth.login_ex", [{
        mechanism: "API_KEY_PLAIN",
        username: opts.username,
        api_key: opts.apiKey,
        login_options: { user_info: false },
      }]);
      if (res?.response_type !== "SUCCESS") {
        const why: Record<string, string> = {
          AUTH_ERR: "the API key or username was rejected",
          EXPIRED: "the API key has expired",
          OTP_REQUIRED: "this account requires a one-time password, which API keys cannot provide",
        };
        throw new TrueNasError(
          `login failed: ${why[res?.response_type] ?? res?.response_type ?? "no response"}`,
        );
      }
    } catch (e) {
      await client.close();
      throw e;
    }
    return client;
  }

  /** Call a method and return its result, or throw a {@link TrueNasError}. */
  call<T = unknown>(method: string, params: unknown[] = [], timeoutMs = this.timeoutMs): Promise<T> {
    // Serialise calls so replies are read in order on the single socket.
    const run = this.queue.then(() => this.exchange<T>(method, params, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Run a job method (e.g. `app.start`) and wait for it to finish. Job methods
   * return a job id; `core.job_wait` returns the job's result or raises its error.
   */
  async job<T = unknown>(method: string, params: unknown[], timeoutMs: number): Promise<T> {
    const id = await this.call<unknown>(method, params);
    if (typeof id !== "number") return id as T; // already finished synchronously
    return await this.call<T>("core.job_wait", [id], timeoutMs);
  }

  /** Close the session. */
  async close(): Promise<void> {
    await this.ws.close();
  }

  private async exchange<T>(method: string, params: unknown[], timeoutMs: number): Promise<T> {
    const id = ++this.nextId;
    await this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return await withTimeout(
      (async () => {
        for (;;) {
          const msg = JSON.parse(await this.ws.receive());
          if (msg.id !== id) continue; // a notification, or a reply to an abandoned call
          if (msg.error) throw rpcError(method, msg.error);
          return msg.result as T;
        }
      })(),
      timeoutMs,
      () => this.ws.abort(),
      method,
    );
  }
}

/** Reject after `ms`, running `onTimeout` (which should unblock the pending work). */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      reject(new TrueNasError(`${what}: timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    if (timedOut) work.catch(() => {}); // the aborted work rejects too; that is expected
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
