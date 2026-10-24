/**
 * `@me__zlxp/truenas`: read the health of a TrueNAS SCALE system (version,
 * pools, apps, alerts) and start or stop its apps, over the JSON-RPC
 * WebSocket API that TrueNAS 25.10 and later use.
 *
 * @module
 */
import { z } from "npm:zod@4.6.5";
import { TrueNasClient, type TrueNasOptions } from "./lib/truenas_client.ts";
import { instanceName, now, percent } from "./lib/names.ts";

/** Global arguments shared by every method. */
export const GlobalArgs = z.object({
  host: z.string().regex(/^[A-Za-z0-9.\-:\[\]]+$/, "host is a hostname or IP, without scheme or path")
    .describe("Hostname or IP address of the NAS, e.g. nas.example.com or 192.0.2.10"),
  port: z.number().int().min(1).max(65535).default(443).describe("HTTPS port of the web UI"),
  username: z.string().default("truenas_admin").describe("User the API key belongs to"),
  apiKey: z.string().min(1).meta({ sensitive: true })
    .describe("API key (Credentials → API Keys). Supply it from a vault"),
  certificatePem: z.string().optional().describe(
    "PEM of the NAS's own certificate to pin. Needed for the default self-signed certificate; " +
      "omit it when the NAS has a certificate from a trusted CA",
  ),
  timeoutSeconds: z.number().int().min(1).max(600).default(30).describe("Per-call timeout"),
});

/** Parsed global arguments. */
export type TrueNasGlobalArgs = z.infer<typeof GlobalArgs>;

/** Shape of the `system` resource. */
const SystemSchema = z.object({
  hostname: z.string(),
  version: z.string(),
  model: z.string(),
  cores: z.number(),
  memoryBytes: z.number(),
  uptimeSeconds: z.number(),
  timestamp: z.string(),
});

/** Shape of a `pool` resource. */
const PoolSchema = z.object({
  name: z.string(),
  status: z.string().describe("ONLINE, DEGRADED, FAULTED, OFFLINE, ..."),
  healthy: z.boolean(),
  warning: z.boolean(),
  statusDetail: z.string().nullable(),
  sizeBytes: z.number(),
  allocatedBytes: z.number(),
  freeBytes: z.number(),
  usedPercent: z.number(),
  scrubState: z.string().nullable().describe("State of the last scrub or resilver, e.g. FINISHED"),
  scrubErrors: z.number(),
  timestamp: z.string(),
});

/** Shape of an `app` resource. */
const AppSchema = z.object({
  name: z.string(),
  state: z.string().describe("RUNNING, STOPPED, DEPLOYING, CRASHED or STOPPING"),
  running: z.boolean(),
  version: z.string(),
  upgradeAvailable: z.boolean(),
  imageUpdatesAvailable: z.boolean(),
  timestamp: z.string(),
});

/** Shape of the `alerts` resource. */
const AlertsSchema = z.object({
  total: z.number(),
  critical: z.number().describe("CRITICAL, ALERT and EMERGENCY alerts"),
  errors: z.number(),
  warnings: z.number(),
  alerts: z.array(z.object({ level: z.string(), klass: z.string(), text: z.string(), raisedAt: z.string() })),
  timestamp: z.string(),
});

/** Arguments of `startApp` and `stopApp`. */
const AppNameArgs = z.object({
  name: z.string().min(1).describe("App name as shown in Apps, e.g. immich"),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300).describe("How long to wait for the job"),
});

type Handle = { name: string };
interface Ctx {
  globalArgs: TrueNasGlobalArgs;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(spec: string, name: string, data: Record<string, unknown>): Promise<Handle>;
}
/** Test hook: lets tests connect to a fake server instead of the NAS. */
type Injected = { _connect?: TrueNasOptions["connect"] };

/** Open a session from the global arguments, run `fn`, and always close it. */
export async function withSession<T>(
  g: TrueNasGlobalArgs,
  fn: (c: TrueNasClient) => Promise<T>,
  connect?: TrueNasOptions["connect"],
): Promise<T> {
  const client = await TrueNasClient.connect({
    host: g.host,
    port: g.port,
    username: g.username,
    apiKey: g.apiKey,
    certificatePem: g.certificatePem,
    timeoutMs: g.timeoutSeconds * 1000,
    connect,
  });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** An untyped object as returned by the TrueNAS API. */
// deno-lint-ignore no-explicit-any
type Raw = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** Check that a query method returned a list, so a changed API fails with a clear message. */
export function asList(method: string, value: unknown): Raw[] {
  if (!Array.isArray(value)) {
    throw new Error(`${method}: expected a list, got ${value === null ? "null" : typeof value}`);
  }
  return value;
}

/** Map one `pool.query` entry onto the `pool` resource. */
export function toPool(p: Raw): z.infer<typeof PoolSchema> {
  const size = num(p.size);
  const allocated = num(p.allocated);
  return {
    name: String(p.name),
    status: String(p.status ?? "UNKNOWN"),
    healthy: p.healthy === true,
    warning: p.warning === true,
    statusDetail: typeof p.status_detail === "string" ? p.status_detail : null,
    sizeBytes: size,
    allocatedBytes: allocated,
    freeBytes: num(p.free),
    usedPercent: percent(allocated, size),
    scrubState: typeof p.scan?.state === "string" ? p.scan.state : null,
    scrubErrors: num(p.scan?.errors),
    timestamp: now(),
  };
}

/** Map one `app.query` entry onto the `app` resource. */
export function toApp(a: Raw): z.infer<typeof AppSchema> {
  return {
    name: String(a.name),
    state: String(a.state ?? "UNKNOWN"),
    running: a.state === "RUNNING",
    version: String(a.human_version ?? a.version ?? ""),
    upgradeAvailable: a.upgrade_available === true,
    imageUpdatesAvailable: a.image_updates_available === true,
    timestamp: now(),
  };
}

const CRITICAL = new Set(["CRITICAL", "ALERT", "EMERGENCY"]);

/** Summarise `alert.list` (dismissed alerts are left out). */
export function toAlerts(list: Raw[]): z.infer<typeof AlertsSchema> {
  const active = list.filter((a) => a.dismissed !== true);
  const date = (d: unknown) => {
    const ms = typeof d === "object" && d !== null ? num((d as Raw).$date) : num(d);
    return ms ? new Date(ms).toISOString() : "";
  };
  return {
    total: active.length,
    critical: active.filter((a) => CRITICAL.has(a.level)).length,
    errors: active.filter((a) => a.level === "ERROR").length,
    warnings: active.filter((a) => a.level === "WARNING").length,
    alerts: active.map((a) => ({
      level: String(a.level),
      klass: String(a.klass ?? ""),
      text: String(a.formatted ?? a.text ?? ""),
      raisedAt: date(a.datetime),
    })),
    timestamp: now(),
  };
}

/** Swamp behavior definition for `@me__zlxp/truenas`. */
export const model = {
  type: "@me__zlxp/truenas",
  version: "2026.10.24.1",
  globalArguments: GlobalArgs,
  resources: {
    system: {
      description: "Version, hardware and uptime",
      schema: SystemSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    pool: {
      description: "One ZFS pool's health and capacity",
      schema: PoolSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    app: {
      description: "One app's state and available updates",
      schema: AppSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    alerts: {
      description: "Active (undismissed) alerts",
      schema: AlertsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "pinned-certificate-is-pem": {
      description: "certificatePem, when given, is a PEM certificate",
      labels: ["policy"],
      execute: (context: { globalArgs: TrueNasGlobalArgs }) => {
        const pem = context.globalArgs.certificatePem;
        return Promise.resolve(
          !pem || /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)
            ? { pass: true }
            : { pass: false, errors: ["certificatePem is not a PEM certificate (BEGIN/END CERTIFICATE)"] },
        );
      },
    },
  },
  methods: {
    info: {
      description: "Write the system resource: version, hostname, model, cores, memory, uptime",
      kind: "read",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        context.logger.info("Reading system info from {host}", { host: context.globalArgs.host });
        const info = await withSession(context.globalArgs, (c) => c.call<Raw>("system.info"), args._connect);
        const handle = await context.writeResource("system", "system", {
          hostname: String(info.hostname),
          version: String(info.version),
          model: String(info.model ?? ""),
          cores: num(info.cores),
          memoryBytes: num(info.physmem),
          uptimeSeconds: num(info.uptime_seconds),
          timestamp: now(),
        });
        context.logger.info("{hostname} runs {version}, up {days} days", {
          hostname: info.hostname,
          version: info.version,
          days: Math.floor(num(info.uptime_seconds) / 86400),
        });
        return { dataHandles: [handle] };
      },
    },
    pools: {
      description: "Write one pool resource per ZFS pool (status, health, capacity, last scrub)",
      kind: "list",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        context.logger.info("Reading ZFS pools from {host}", { host: context.globalArgs.host });
        const pools = await withSession(
          context.globalArgs,
          (c) => c.call<unknown>("pool.query").then((r) => asList("pool.query", r)),
          args._connect,
        );
        const handles = [];
        for (const raw of pools) {
          const pool = toPool(raw);
          handles.push(await context.writeResource("pool", instanceName("pool", pool.name), pool));
          context.logger.info("pool {name}: {status}, {used}% used", {
            name: pool.name,
            status: pool.status,
            used: pool.usedPercent,
          });
        }
        return { dataHandles: handles };
      },
    },
    apps: {
      description: "Write one app resource per installed app (state, version, updates)",
      kind: "list",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        context.logger.info("Reading apps from {host}", { host: context.globalArgs.host });
        const apps = await withSession(
          context.globalArgs,
          (c) => c.call<unknown>("app.query").then((r) => asList("app.query", r)),
          args._connect,
        );
        const handles = [];
        for (const raw of apps) {
          const app = toApp(raw);
          handles.push(await context.writeResource("app", instanceName("app", app.name), app));
        }
        const down = apps.map(toApp).filter((a) => !a.running).map((a) => `${a.name} (${a.state})`);
        context.logger.info("{count} apps, not running: {down}", {
          count: apps.length,
          down: down.join(", ") || "none",
        });
        return { dataHandles: handles };
      },
    },
    alerts: {
      description: "Write the alerts resource: counts by severity and every undismissed alert",
      kind: "list",
      arguments: z.object({}),
      execute: async (args: Injected, context: Ctx) => {
        context.logger.info("Reading alerts from {host}", { host: context.globalArgs.host });
        const list = await withSession(
          context.globalArgs,
          (c) => c.call<unknown>("alert.list").then((r) => asList("alert.list", r)),
          args._connect,
        );
        const summary = toAlerts(list);
        const handle = await context.writeResource("alerts", "alerts", summary);
        context.logger.info(
          "{total} active alerts ({critical} critical, {errors} errors, {warnings} warnings)",
          summary,
        );
        return { dataHandles: [handle] };
      },
    },
    startApp: {
      description: "Start an app and wait for the start job to finish; writes the app's new state",
      arguments: AppNameArgs,
      execute: (args: z.infer<typeof AppNameArgs> & Injected, context: Ctx) =>
        changeAppState("app.start", args, context),
    },
    stopApp: {
      description: "Stop an app and wait for the stop job to finish; writes the app's new state",
      arguments: AppNameArgs,
      execute: (args: z.infer<typeof AppNameArgs> & Injected, context: Ctx) =>
        changeAppState("app.stop", args, context),
    },
  },
};

async function changeAppState(
  method: "app.start" | "app.stop",
  args: z.infer<typeof AppNameArgs> & Injected,
  context: Ctx,
): Promise<{ dataHandles: Handle[] }> {
  const target = method === "app.start" ? "RUNNING" : "STOPPED";
  context.logger.info("{method} {name}: connecting", { method, name: args.name });
  const app = await withSession(context.globalArgs, async (c) => {
    const query = () =>
      c.call<unknown>("app.query", [[["name", "=", args.name]]]).then((r) => asList("app.query", r));
    const found = await query();
    if (found.length === 0) throw new Error(`no app named "${args.name}"`);
    if (found[0].state === target) {
      // Already where we want it: nothing to do, and no job to wait for.
      context.logger.info("{name} is already {state}; nothing to do", { name: args.name, state: target });
      return toApp(found[0]);
    }
    context.logger.info("{method} {name} (currently {state})", {
      method,
      name: args.name,
      state: found[0].state,
    });
    await c.job(method, [args.name], args.timeoutSeconds * 1000);
    const [after] = await query();
    return toApp(after ?? found[0]);
  }, args._connect);
  const handle = await context.writeResource("app", instanceName("app", app.name), app);
  context.logger.info("{name} is now {state}", { name: app.name, state: app.state });
  return { dataHandles: [handle] };
}
