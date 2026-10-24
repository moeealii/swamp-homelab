import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261010.50";
import { model, toAlerts, toPool } from "./truenas.ts";
import { callError, fakeTrueNas, NO_REPLY } from "./lib/fake_truenas.ts";

const globalArgs = {
  host: "nas.test",
  port: 443,
  username: "truenas_admin",
  apiKey: "1-test-key",
  timeoutSeconds: 5,
};

// deno-lint-ignore no-explicit-any
type Ctx = any;

Deno.test("info: logs in with the API key and writes the system resource", async () => {
  const nas = fakeTrueNas({
    "system.info": () => ({
      hostname: "truenas",
      version: "27.0.0",
      model: "AMD Ryzen 5",
      cores: 12,
      physmem: 68_719_476_736,
      uptime_seconds: 3 * 86400 + 5,
    }),
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({ globalArgs });
    await model.methods.info.execute({ _connect: nas.connect }, context as Ctx);

    assertEquals(nas.calls[0], {
      method: "auth.login_ex",
      params: [{
        mechanism: "API_KEY_PLAIN",
        username: "truenas_admin",
        api_key: "1-test-key",
        login_options: { user_info: false },
      }],
    });
    const [system] = getWrittenResources();
    assertEquals(system.specName, "system");
    assertEquals(system.data.version, "27.0.0");
    assertEquals(system.data.memoryBytes, 68_719_476_736);
  } finally {
    await nas.close();
  }
});

Deno.test("login: a rejected key fails before anything is written", async () => {
  const nas = fakeTrueNas({ "auth.login_ex": () => ({ response_type: "AUTH_ERR" }) });
  try {
    const { context, getWrittenResources } = createModelTestContext({ globalArgs });
    await assertRejects(
      () => model.methods.info.execute({ _connect: nas.connect }, context as Ctx),
      Error,
      "the API key or username was rejected",
    );
    assertEquals(getWrittenResources().length, 0);
    assertEquals(nas.calls.map((c) => c.method), ["auth.login_ex"]);
  } finally {
    await nas.close();
  }
});

Deno.test("pools: one resource per pool with capacity and scrub state", async () => {
  const nas = fakeTrueNas({
    "pool.query": () => [
      {
        name: "tank",
        status: "ONLINE",
        healthy: true,
        warning: false,
        size: 1000,
        allocated: 735,
        free: 265,
        scan: { function: "SCRUB", state: "FINISHED", errors: 0 },
      },
      {
        name: "fast",
        status: "DEGRADED",
        healthy: false,
        warning: true,
        status_detail: "One or more devices are faulted",
        size: 0,
      },
    ],
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({ globalArgs });
    await model.methods.pools.execute({ _connect: nas.connect }, context as Ctx);
    const pools = getWrittenResources();
    assertEquals(pools.map((p) => p.name), ["pool-tank", "pool-fast"]);
    assertEquals(pools[0].data.usedPercent, 73.5);
    assertEquals(pools[0].data.scrubState, "FINISHED");
    assertEquals(pools[1].data.healthy, false);
    assertEquals(pools[1].data.usedPercent, 0, "unknown size does not divide by zero");
  } finally {
    await nas.close();
  }
});

Deno.test("apps: replies are matched by id even when notifications arrive first", async () => {
  const nas = fakeTrueNas({
    "app.query": () => [
      { name: "immich", state: "RUNNING", human_version: "v3.3.5", upgrade_available: true },
      { name: "plex", state: "CRASHED", version: "1.0" },
    ],
  }, { notifyFirst: true });
  try {
    const { context, getWrittenResources, getLogs } = createModelTestContext({ globalArgs });
    await model.methods.apps.execute({ _connect: nas.connect }, context as Ctx);
    const apps = getWrittenResources();
    assertEquals(apps.map((a) => [a.name, a.data.running, a.data.upgradeAvailable]), [
      ["app-immich", true, true],
      ["app-plex", false, false],
    ]);
    assert(getLogs().some((l) => JSON.stringify(l).includes("plex (CRASHED)")));
  } finally {
    await nas.close();
  }
});

Deno.test("startApp: runs the job, waits for it, and writes the new state", async () => {
  let state = "STOPPED";
  const nas = fakeTrueNas({
    "app.query": () => [{ name: "immich", state }],
    "app.start": () => 4242,
    "core.job_wait": ([id]) => {
      assertEquals(id, 4242);
      state = "RUNNING";
      return null;
    },
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({ globalArgs });
    await model.methods.startApp.execute(
      { name: "immich", timeoutSeconds: 60, _connect: nas.connect },
      context as Ctx,
    );
    assertEquals(nas.calls.map((c) => c.method), [
      "auth.login_ex",
      "app.query",
      "app.start",
      "core.job_wait",
      "app.query",
    ]);
    assertEquals(nas.calls[1].params, [[["name", "=", "immich"]]]);
    assertEquals(getWrittenResources()[0].data.state, "RUNNING");
  } finally {
    await nas.close();
  }
});

Deno.test("stopApp: an unknown app fails before any job starts", async () => {
  const nas = fakeTrueNas({ "app.query": () => [] });
  try {
    const { context } = createModelTestContext({ globalArgs });
    await assertRejects(
      () =>
        model.methods.stopApp.execute(
          { name: "nope", timeoutSeconds: 60, _connect: nas.connect },
          context as Ctx,
        ),
      Error,
      'no app named "nope"',
    );
    assert(!nas.calls.some((c) => c.method === "app.stop"));
  } finally {
    await nas.close();
  }
});

Deno.test("errors: the middleware's reason is shown, its traceback is not", async () => {
  const nas = fakeTrueNas({
    "alert.list": () => Promise.reject(callError("EPERM", "[EPERM] Not authorized")),
  });
  try {
    const { context } = createModelTestContext({ globalArgs });
    const err = await assertRejects(() =>
      model.methods.alerts.execute({ _connect: nas.connect }, context as Ctx)
    );
    assertStringIncludes((err as Error).message, "alert.list: [EPERM] Not authorized");
    assert(!(err as Error).message.includes("Traceback"));
  } finally {
    await nas.close();
  }
});

Deno.test("timeouts: a call that never gets an answer fails instead of hanging", async () => {
  const nas = fakeTrueNas({ "pool.query": () => NO_REPLY });
  try {
    const { context } = createModelTestContext({ globalArgs: { ...globalArgs, timeoutSeconds: 1 } });
    await assertRejects(
      () => model.methods.pools.execute({ _connect: nas.connect }, context as Ctx),
      Error,
      "pool.query: timed out after 1s",
    );
  } finally {
    await nas.close();
  }
});

Deno.test("toAlerts: ignores dismissed alerts and counts by severity", () => {
  const summary = toAlerts([
    {
      level: "CRITICAL",
      klass: "ZpoolCapacityCritical",
      formatted: "Pool tank is 95% full",
      datetime: { $date: 0 },
    },
    {
      level: "WARNING",
      klass: "SMART",
      formatted: "Disk sda has 8 reallocated sectors",
      datetime: { $date: 1_700_000_000_000 },
    },
    { level: "ERROR", klass: "Old", formatted: "dismissed", dismissed: true },
  ]);
  assertEquals([summary.total, summary.critical, summary.warnings, summary.errors], [2, 1, 1, 0]);
  assertEquals(summary.alerts[1].raisedAt, "2023-11-14T22:13:20.000Z");
});

Deno.test("toPool: tolerates missing fields from an exported or offline pool", () => {
  const pool = toPool({ name: "old", status: "OFFLINE" });
  assertEquals([pool.sizeBytes, pool.usedPercent, pool.scrubState, pool.healthy], [0, 0, null, false]);
});

Deno.test("pinned-certificate-is-pem: rejects something that is not a certificate", async () => {
  const check = model.checks["pinned-certificate-is-pem"].execute;
  assertEquals(await check({ globalArgs: { ...globalArgs, certificatePem: "hello" } } as Ctx), {
    pass: false,
    errors: ["certificatePem is not a PEM certificate (BEGIN/END CERTIFICATE)"],
  });
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  assertEquals(await check({ globalArgs: { ...globalArgs, certificatePem: pem } } as Ctx), { pass: true });
});

Deno.test("startApp: an app that is already running is left alone", async () => {
  const nas = fakeTrueNas({ "app.query": () => [{ name: "immich", state: "RUNNING" }] });
  try {
    const { context, getWrittenResources } = createModelTestContext({ globalArgs });
    await model.methods.startApp.execute(
      { name: "immich", timeoutSeconds: 60, _connect: nas.connect },
      context as Ctx,
    );
    assertEquals(nas.calls.map((c) => c.method), ["auth.login_ex", "app.query"], "no job was started");
    assertEquals(getWrittenResources()[0].data.state, "RUNNING");
  } finally {
    await nas.close();
  }
});

Deno.test("asList: a non-list result fails with the method name", async () => {
  const nas = fakeTrueNas({ "pool.query": () => ({ unexpected: true }) });
  try {
    const { context } = createModelTestContext({ globalArgs });
    await assertRejects(
      () => model.methods.pools.execute({ _connect: nas.connect }, context as Ctx),
      Error,
      "pool.query: expected a list, got object",
    );
  } finally {
    await nas.close();
  }
});
