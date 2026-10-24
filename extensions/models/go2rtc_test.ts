import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261010.50";
import { model, toStream } from "./go2rtc.ts";

const globalArgs = { url: "http://go2rtc.test:1984", timeoutSeconds: 5 };

// deno-lint-ignore no-explicit-any
type Ctx = any;

const STREAMS = {
  front_door: {
    producers: [{ url: "rtsp://admin:hunter2@192.0.2.20:554/live", medias: ["video, recvonly, H264"] }],
    consumers: [{ remote_addr: "192.0.2.50" }],
  },
  backyard: { producers: [{ url: "rtsp://192.0.2.21/live" }], consumers: null },
};

function fakeGo2rtc(frames: Record<string, Response>) {
  const auth: (string | null)[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    auth.push(new Headers(init?.headers).get("authorization"));
    if (url.pathname === "/api/streams") {
      return Promise.resolve(
        new Response(JSON.stringify(STREAMS), { headers: { "content-type": "application/json" } }),
      );
    }
    const src = url.searchParams.get("src") ?? "";
    return Promise.resolve(frames[src] ?? new Response("stream not found", { status: 404 }));
  }) as typeof fetch;
  return { impl, auth };
}

const jpeg = () =>
  new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } });

Deno.test("streams: writes each stream with credentials stripped from its source URLs", async () => {
  const api = fakeGo2rtc({});
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  await model.methods.streams.execute({ _fetch: api.impl }, context as Ctx);
  const [front, back] = getWrittenResources();
  assertEquals(front.name, "stream-front_door");
  assertEquals(front.data.sources, ["rtsp://192.0.2.20:554/live"]);
  assertEquals([front.data.activeProducers, front.data.consumers], [1, 1]);
  assertEquals([back.data.activeProducers, back.data.consumers], [0, 0]);
  for (const r of getWrittenResources()) assertEquals(JSON.stringify(r.data).includes("hunter2"), false);
});

Deno.test("health: a stream is online only if go2rtc returns a JPEG frame", async () => {
  const api = fakeGo2rtc({
    front_door: jpeg(),
    backyard: new Response("dial tcp 192.0.2.21:554: i/o timeout", { status: 500 }),
  });
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...globalArgs, username: "admin", password: "pw" },
  });
  await model.methods.health.execute({ _fetch: api.impl }, context as Ctx);
  const byName = Object.fromEntries(getWrittenResources().map((r) => [r.name, r.data]));
  assertEquals(byName["health-front_door"].online, true);
  assertEquals(byName["health-front_door"].frameBytes, 4);
  assertEquals(byName["health-backyard"].online, false);
  assertStringIncludes(String(byName["health-backyard"].error), "i/o timeout");
  assertEquals(byName["summary"].offline, ["backyard"]);
  assertEquals(api.auth.every((a) => a === `Basic ${btoa("admin:pw")}`), true);
});

Deno.test("health: can check a chosen subset of streams", async () => {
  const api = fakeGo2rtc({ backyard: jpeg() });
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  await model.methods.health.execute({ streams: ["backyard"], _fetch: api.impl }, context as Ctx);
  assertEquals(getWrittenResources().map((r) => r.name), ["health-backyard", "summary"]);
});

Deno.test("toStream: handles a stream with no producers or consumers", () => {
  const s = toStream("empty", null);
  assertEquals([s.sources, s.activeProducers, s.consumers], [[], 0, 0]);
});

Deno.test("health: a camera named summary does not overwrite the summary", async () => {
  const api = fakeGo2rtc({ summary: jpeg() });
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  await model.methods.health.execute({ streams: ["summary"], _fetch: api.impl }, context as Ctx);
  const names = getWrittenResources().map((r) => r.name);
  assertEquals(names, ["health-summary", "summary"]);
  assertEquals(new Set(names).size, names.length);
});
