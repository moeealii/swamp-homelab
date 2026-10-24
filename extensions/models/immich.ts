/**
 * `@me__zlxp/immich`: library statistics, disk usage, background queues and
 * albums from an Immich server's REST API (Immich 2.x and 3.x).
 *
 * @module
 */
import { z } from "npm:zod@4.6.5";
import { getJson, joinUrl, type RequestOptions } from "./lib/http.ts";
import { instanceName, now } from "./lib/names.ts";

/** Global arguments shared by every method. */
export const GlobalArgs = z.object({
  url: z.string().regex(/^https?:\/\/[^/\s]+(\/.*)?$/, "url must be http(s)://host[:port]")
    .describe("Base URL of the Immich server, e.g. http://nas.example.com:2283 (without /api)"),
  apiKey: z.string().min(1).meta({ sensitive: true })
    .describe("Immich API key (Account Settings → API Keys). Supply it from a vault"),
  timeoutSeconds: z.number().int().min(1).max(300).default(30).describe("Per-request timeout"),
});

/** Parsed global arguments. */
export type ImmichGlobalArgs = z.infer<typeof GlobalArgs>;

/** Shape of the `library` resource. */
const LibrarySchema = z.object({
  version: z.string(),
  photos: z.number(),
  videos: z.number(),
  usageBytes: z.number().describe("Bytes used by all users' assets"),
  users: z.number(),
  timestamp: z.string(),
});

/** Shape of the `disk` resource. */
const DiskSchema = z.object({
  sizeBytes: z.number(),
  usedBytes: z.number(),
  availableBytes: z.number(),
  usedPercent: z.number(),
  timestamp: z.string(),
});

/** Shape of a `queue` resource. */
const QueueSchema = z.object({
  name: z.string().describe("e.g. thumbnailGeneration, smartSearch, faceDetection"),
  paused: z.boolean(),
  active: z.number(),
  waiting: z.number(),
  delayed: z.number(),
  failed: z.number(),
  completed: z.number(),
  timestamp: z.string(),
});

/** Shape of the `queues` summary resource. */
const QueuesSummarySchema = z.object({
  busy: z.array(z.string()).describe("Queues with active or waiting work"),
  failed: z.array(z.string()).describe("Queues with failed jobs"),
  paused: z.array(z.string()),
  backlog: z.number().describe("Active + waiting jobs across all queues"),
  timestamp: z.string(),
});

/** Shape of an `album` resource. */
const AlbumSchema = z.object({
  id: z.string(),
  name: z.string(),
  assets: z.number(),
  shared: z.boolean(),
  updatedAt: z.string(),
  lastAssetAt: z.string().nullable(),
  timestamp: z.string(),
});

type Handle = { name: string };
interface Ctx {
  globalArgs: ImmichGlobalArgs;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(spec: string, name: string, data: Record<string, unknown>): Promise<Handle>;
}
/** Test hook: lets tests substitute fetch. */
type Injected = { _fetch?: typeof fetch };

function api<T>(context: Ctx, path: string, args: Injected): Promise<T> {
  const g = context.globalArgs;
  const opts: RequestOptions = {
    headers: { "x-api-key": g.apiKey },
    timeoutMs: g.timeoutSeconds * 1000,
    signal: context.signal,
    fetch: args._fetch,
  };
  return getJson<T>(joinUrl(g.url, `/api/${path}`), opts);
}

/** An untyped object as returned by the Immich API. */
// deno-lint-ignore no-explicit-any
type Raw = Record<string, any>;

/** Map one `/api/queues` entry onto the `queue` resource. */
export function toQueue(q: Raw): z.infer<typeof QueueSchema> {
  const s = q.statistics ?? {};
  return {
    name: String(q.name),
    paused: q.isPaused === true,
    active: Number(s.active) || 0,
    waiting: Number(s.waiting) || 0,
    delayed: Number(s.delayed) || 0,
    failed: Number(s.failed) || 0,
    completed: Number(s.completed) || 0,
    timestamp: now(),
  };
}

/** Swamp behavior definition for `@me__zlxp/immich`. */
export const model = {
  type: "@me__zlxp/immich",
  version: "2026.10.24.1",
  globalArguments: GlobalArgs,
  resources: {
    library: {
      description: "Server version and library totals",
      schema: LibrarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    disk: {
      description: "Upload volume capacity",
      schema: DiskSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    queue: {
      description: "One background queue's job counts",
      schema: QueueSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    queues: {
      description: "Which queues are busy, failing or paused",
      schema: QueuesSummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    album: {
      description: "One album's size and activity",
      schema: AlbumSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    library: {
      description: "Write the library resource: version and photo, video and storage totals (admin key)",
      kind: "read",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        context.logger.info("Reading library statistics from {url}", { url: context.globalArgs.url });
        const [version, stats] = await Promise.all([
          api<Raw>(context, "server/version", args),
          api<Raw>(context, "server/statistics", args),
        ]);
        const data = {
          version: `${version.major}.${version.minor}.${version.patch}`,
          photos: Number(stats.photos) || 0,
          videos: Number(stats.videos) || 0,
          usageBytes: Number(stats.usage) || 0,
          users: Array.isArray(stats.usageByUser) ? stats.usageByUser.length : 0,
          timestamp: now(),
        };
        const handle = await context.writeResource("library", "library", data);
        context.logger.info("Immich {version}: {photos} photos, {videos} videos", data);
        return { dataHandles: [handle] };
      },
    },
    disk: {
      description: "Write the disk resource: capacity of the upload volume",
      kind: "read",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        context.logger.info("Reading storage from {url}", { url: context.globalArgs.url });
        const s = await api<Raw>(context, "server/storage", args);
        const data = {
          sizeBytes: Number(s.diskSizeRaw) || 0,
          usedBytes: Number(s.diskUseRaw) || 0,
          availableBytes: Number(s.diskAvailableRaw) || 0,
          usedPercent: Number(s.diskUsagePercentage) || 0,
          timestamp: now(),
        };
        const handle = await context.writeResource("disk", "disk", data);
        context.logger.info("upload volume {used}% used", { used: data.usedPercent });
        return { dataHandles: [handle] };
      },
    },
    queues: {
      description: "Write one queue resource per background queue, plus a queues summary",
      kind: "list",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        context.logger.info("Reading job queues from {url}", { url: context.globalArgs.url });
        const queues = (await api<Raw[]>(context, "queues", args)).map(toQueue);
        const handles = [];
        for (const q of queues) {
          handles.push(await context.writeResource("queue", instanceName("queue", q.name), q));
        }
        const summary = {
          busy: queues.filter((q) => q.active + q.waiting > 0).map((q) => q.name),
          failed: queues.filter((q) => q.failed > 0).map((q) => q.name),
          paused: queues.filter((q) => q.paused).map((q) => q.name),
          backlog: queues.reduce((n, q) => n + q.active + q.waiting, 0),
          timestamp: now(),
        };
        handles.push(await context.writeResource("queues", "queues", summary));
        context.logger.info("{backlog} jobs queued; failing: {failed}", {
          backlog: summary.backlog,
          failed: summary.failed.join(", ") || "none",
        });
        return { dataHandles: handles };
      },
    },
    albums: {
      description: "Write one album resource per album the key's user can see",
      kind: "list",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        context.logger.info("Reading albums from {url}", { url: context.globalArgs.url });
        const albums = await api<Raw[]>(context, "albums", args);
        const handles = [];
        for (const a of albums) {
          handles.push(
            await context.writeResource("album", instanceName("album", String(a.id)), {
              id: String(a.id),
              name: String(a.albumName ?? ""),
              assets: Number(a.assetCount) || 0,
              shared: a.shared === true,
              updatedAt: String(a.updatedAt ?? ""),
              lastAssetAt: typeof a.lastModifiedAssetTimestamp === "string"
                ? a.lastModifiedAssetTimestamp
                : null,
              timestamp: now(),
            }),
          );
        }
        context.logger.info("{count} albums", { count: albums.length });
        return { dataHandles: handles };
      },
    },
  },
};
