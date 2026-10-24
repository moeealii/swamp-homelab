import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261010.50";
import { model } from "./immich.ts";

const globalArgs = { url: "http://immich.test:2283/", apiKey: "immich-key", timeoutSeconds: 5 };

// deno-lint-ignore no-explicit-any
type Ctx = any;

/** A fetch that serves canned JSON by path and records the requests. */
function fakeImmich(routes: Record<string, unknown>, status = 200) {
  const seen: { url: string; key: string | null }[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), key: new Headers(init?.headers).get("x-api-key") });
    if (status !== 200) {
      return Promise.resolve(new Response('{"message":"Authentication required"}', { status }));
    }
    const body = routes[url.pathname];
    return Promise.resolve(
      body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  return { impl, seen };
}

Deno.test("library: combines version and statistics, sending the API key", async () => {
  const api = fakeImmich({
    "/api/server/version": { major: 3, minor: 3, patch: 5 },
    "/api/server/statistics": {
      photos: 51234,
      videos: 1880,
      usage: 812_000_000_000,
      usageByUser: [{}, {}, {}],
    },
  });
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  await model.methods.library.execute({ _fetch: api.impl }, context as Ctx);
  assertEquals(getWrittenResources()[0].data, {
    ...getWrittenResources()[0].data,
    version: "3.3.5",
    photos: 51234,
    videos: 1880,
    usageBytes: 812_000_000_000,
    users: 3,
  });
  assertEquals(api.seen.map((s) => s.key), ["immich-key", "immich-key"]);
  assertEquals(api.seen[0].url, "http://immich.test:2283/api/server/version", "no doubled slash");
});

Deno.test("queues: one resource per queue plus a summary of busy, failing and paused ones", async () => {
  const api = fakeImmich({
    "/api/queues": [
      {
        name: "thumbnailGeneration",
        isPaused: false,
        statistics: { active: 2, waiting: 40, failed: 0, completed: 9, delayed: 0, paused: 0 },
      },
      {
        name: "faceDetection",
        isPaused: false,
        statistics: { active: 0, waiting: 0, failed: 3, completed: 1, delayed: 0, paused: 0 },
      },
      {
        name: "smartSearch",
        isPaused: true,
        statistics: { active: 0, waiting: 0, failed: 0, completed: 0, delayed: 0, paused: 0 },
      },
    ],
  });
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  await model.methods.queues.execute({ _fetch: api.impl }, context as Ctx);
  const written = getWrittenResources();
  assertEquals(written.map((w) => w.name), [
    "queue-thumbnailGeneration",
    "queue-faceDetection",
    "queue-smartSearch",
    "queues",
  ]);
  const summary = written[3].data;
  assertEquals([summary.busy, summary.failed, summary.paused, summary.backlog], [
    ["thumbnailGeneration"],
    ["faceDetection"],
    ["smartSearch"],
    42,
  ]);
});

Deno.test("disk and albums: map the raw byte fields and album metadata", async () => {
  const api = fakeImmich({
    "/api/server/storage": {
      diskSizeRaw: 1000,
      diskUseRaw: 600,
      diskAvailableRaw: 400,
      diskUsagePercentage: 60,
      diskSize: "1 KiB",
    },
    "/api/albums": [{
      id: "a1",
      albumName: "Hajj 2026",
      assetCount: 312,
      shared: true,
      updatedAt: "2026-07-01T00:00:00Z",
    }],
  });
  const disk = createModelTestContext({ globalArgs });
  await model.methods.disk.execute({ _fetch: api.impl }, disk.context as Ctx);
  assertEquals(disk.getWrittenResources()[0].data.usedPercent, 60);

  const albums = createModelTestContext({ globalArgs });
  await model.methods.albums.execute({ _fetch: api.impl }, albums.context as Ctx);
  const [album] = albums.getWrittenResources();
  assertEquals([album.name, album.data.name, album.data.assets, album.data.lastAssetAt], [
    "album-a1",
    "Hajj 2026",
    312,
    null,
  ]);
});

Deno.test("errors: a bad key says so and writes nothing", async () => {
  const api = fakeImmich({}, 401);
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  await assertRejects(
    () => model.methods.disk.execute({ _fetch: api.impl }, context as Ctx),
    Error,
    "HTTP 401 (check the API key and its permissions)",
  );
  assertEquals(getWrittenResources().length, 0);
});
