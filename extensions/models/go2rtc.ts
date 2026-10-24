/**
 * `@moeealii/go2rtc`: list a go2rtc server's camera streams and check that
 * each one actually produces video, by asking go2rtc for a fresh frame.
 *
 * @module
 */
import { z } from "npm:zod@4.6.5";
import { getJson, joinUrl, redactUrl, request, type RequestOptions } from "./lib/http.ts";
import { instanceName, now } from "./lib/names.ts";

/** Global arguments shared by every method. */
export const GlobalArgs = z.object({
  url: z.string().regex(/^https?:\/\/[^/\s]+(\/.*)?$/, "url must be http(s)://host[:port]")
    .describe("Base URL of go2rtc's API, e.g. http://nas.lan:1984"),
  username: z.string().optional().describe("Basic-auth user, when go2rtc's api.username is set"),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Basic-auth password. Supply it from a vault",
  ),
  timeoutSeconds: z.number().int().min(1).max(120).default(15).describe("Per-request timeout"),
});

/** Parsed global arguments. */
export type Go2rtcGlobalArgs = z.infer<typeof GlobalArgs>;

/** Shape of a `stream` resource. */
const StreamSchema = z.object({
  name: z.string(),
  sources: z.array(z.string()).describe("Producer URLs with any credentials removed"),
  activeProducers: z.number().describe("Producers currently connected to their camera"),
  consumers: z.number().describe("Clients currently watching"),
  timestamp: z.string(),
});

/** Shape of a `health` resource. */
const HealthSchema = z.object({
  name: z.string(),
  online: z.boolean().describe("go2rtc returned a JPEG frame for this stream"),
  latencyMs: z.number(),
  frameBytes: z.number(),
  error: z.string().nullable(),
  timestamp: z.string(),
});

/** Shape of the `healthSummary` resource. */
const HealthSummarySchema = z.object({
  online: z.array(z.string()),
  offline: z.array(z.string()),
  timestamp: z.string(),
});

/** Arguments of `health`. */
const HealthArgs = z.object({
  streams: z.array(z.string()).optional().describe("Streams to check; all of them when omitted"),
});

type Handle = { name: string };
interface Ctx {
  globalArgs: Go2rtcGlobalArgs;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(spec: string, name: string, data: Record<string, unknown>): Promise<Handle>;
}
/** Test hook: lets tests substitute fetch. */
type Injected = { _fetch?: typeof fetch };

function options(context: Ctx, args: Injected): RequestOptions {
  const g = context.globalArgs;
  const headers: Record<string, string> = {};
  if (g.username) headers.authorization = `Basic ${btoa(`${g.username}:${g.password ?? ""}`)}`;
  return { headers, timeoutMs: g.timeoutSeconds * 1000, signal: context.signal, fetch: args._fetch };
}

/** An untyped object as returned by the go2rtc API. */
// deno-lint-ignore no-explicit-any
type Raw = Record<string, any>;

/** Map one entry of `/api/streams` onto the `stream` resource. */
export function toStream(name: string, s: Raw | null): z.infer<typeof StreamSchema> {
  const producers: Raw[] = Array.isArray(s?.producers) ? s!.producers : [];
  const consumers: Raw[] = Array.isArray(s?.consumers) ? s!.consumers : [];
  return {
    name,
    sources: producers.map((p) => redactUrl(String(p.url ?? p.source ?? ""))).filter(Boolean),
    // An idle producer only has its url; a connected one also reports its media/receivers.
    activeProducers: producers.filter((p) => p.medias || p.receivers || p.remote_addr).length,
    consumers: consumers.length,
    timestamp: now(),
  };
}

/** Swamp behavior definition for `@moeealii/go2rtc`. */
export const model = {
  type: "@moeealii/go2rtc",
  version: "2026.10.24.1",
  globalArguments: GlobalArgs,
  resources: {
    stream: {
      description: "One configured stream and who is using it",
      schema: StreamSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    health: {
      description: "Whether one stream produced a frame",
      schema: HealthSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    healthSummary: {
      description: "Which streams are online and offline",
      schema: HealthSummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    streams: {
      description: "Write one stream resource per configured stream (sources, producers, viewers)",
      kind: "list",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        const all = await getJson<Record<string, Raw | null>>(
          joinUrl(context.globalArgs.url, "/api/streams"),
          options(context, args),
        );
        const handles = [];
        for (const [name, s] of Object.entries(all ?? {})) {
          handles.push(
            await context.writeResource("stream", instanceName("stream", name), toStream(name, s)),
          );
        }
        context.logger.info("{count} streams configured", { count: handles.length });
        return { dataHandles: handles };
      },
    },
    health: {
      description: "Fetch a fresh JPEG frame from each stream; write per-stream health and a summary",
      kind: "read",
      arguments: HealthArgs,
      execute: async (args: z.infer<typeof HealthArgs> & Injected, context: Ctx) => {
        const opts = options(context, args);
        const names = args.streams ??
          Object.keys(
            await getJson<Record<string, unknown>>(joinUrl(context.globalArgs.url, "/api/streams"), opts) ??
              {},
          );
        // Cameras are independent; check them side by side so one dead camera doesn't stall the rest.
        const results = await Promise.all(names.map(async (name) => {
          const started = performance.now();
          try {
            const res = await request(
              joinUrl(context.globalArgs.url, `/api/frame.jpeg?src=${encodeURIComponent(name)}`),
              opts,
            );
            const bytes = (await res.arrayBuffer()).byteLength;
            const jpeg = (res.headers.get("content-type") ?? "").includes("image/jpeg") && bytes > 0;
            const latencyMs = Math.round(performance.now() - started);
            return {
              name,
              online: jpeg,
              frameBytes: bytes,
              latencyMs,
              error: jpeg ? null : "response was not a JPEG frame",
            };
          } catch (e) {
            return {
              name,
              online: false,
              frameBytes: 0,
              latencyMs: Math.round(performance.now() - started),
              error: (e as Error).message,
            };
          }
        }));

        const handles = [];
        for (const r of results) {
          handles.push(
            await context.writeResource("health", instanceName("health", r.name), {
              name: r.name,
              online: r.online,
              latencyMs: r.latencyMs,
              frameBytes: r.frameBytes,
              error: r.error,
              timestamp: now(),
            }),
          );
        }
        const summary = {
          online: results.filter((r) => r.online).map((r) => r.name),
          offline: results.filter((r) => !r.online).map((r) => r.name),
          timestamp: now(),
        };
        handles.push(await context.writeResource("healthSummary", "health-summary", summary));
        context.logger.info("{online}/{total} streams online; offline: {offline}", {
          online: summary.online.length,
          total: results.length,
          offline: summary.offline.join(", ") || "none",
        });
        return { dataHandles: handles };
      },
    },
  },
};
