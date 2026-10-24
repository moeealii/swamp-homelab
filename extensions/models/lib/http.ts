/**
 * JSON over HTTP with a timeout and errors that say what failed, for the
 * Immich and go2rtc behaviors.
 *
 * @module
 */

/** An HTTP request that failed or returned a non-2xx status. */
export class HttpError extends Error {
  /** Create an error for a failed request. */
  constructor(
    message: string,
    /** HTTP status, when a response was received. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Options for {@link request}. */
export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Cancels the request together with the timeout. */
  signal?: AbortSignal;
  /** Allows tests to substitute fetch. */
  fetch?: typeof fetch;
}

/** Strip credentials from a URL so it can be logged or stored. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^/@]*@/, "//");
  }
}

/** Join a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** GET (by default) a URL; returns the response once its status is known to be 2xx. */
export async function request(
  url: string,
  opts: RequestOptions,
  method = "GET",
): Promise<Response> {
  const signals = [AbortSignal.timeout(opts.timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method,
      headers: { accept: "application/json", ...opts.headers },
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    const err = e as Error;
    const why = err.name === "TimeoutError"
      ? `timed out after ${Math.round(opts.timeoutMs / 1000)}s`
      : err.message;
    throw new HttpError(`${method} ${redactUrl(url)}: ${why}`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300).trim();
    const hint = res.status === 401 || res.status === 403 ? " (check the API key and its permissions)" : "";
    throw new HttpError(
      `${method} ${redactUrl(url)}: HTTP ${res.status}${hint}${body ? `: ${body}` : ""}`,
      res.status,
    );
  }
  return res;
}

/** GET a URL and parse the JSON body. */
export async function getJson<T>(url: string, opts: RequestOptions): Promise<T> {
  const res = await request(url, opts);
  try {
    return await res.json() as T;
  } catch {
    throw new HttpError(`GET ${redactUrl(url)}: response is not JSON`);
  }
}
