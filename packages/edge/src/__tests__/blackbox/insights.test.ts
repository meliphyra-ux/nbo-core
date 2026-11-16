// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Black-box: Speed Insights on the dev edge (script, beacons, drain, tag).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import { buildScript } from "../../insights/script.js";
import { insightsTag } from "../../insights/inject.js";
import { bucketIndex } from "../../insights/histogram.js";
import { pickSticky } from "../../sticky.js";
import {
  adminPut,
  edgeImpl,
  send,
  startBackend,
  startEdge,
  type FakeBackend,
  type Reply,
  type RunningEdge,
} from "./harness.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SCRIPT = "/_nbo/insights/v1/script.js";
const VITALS = "/_nbo/insights/v1/vitals";
const NAV = { "sec-fetch-dest": "document" };

// page answers with the given chunks, each written separately with a pause,
// so the edge receives a tag split across reads.
function page(
  res: ServerResponse,
  chunks: (string | Buffer)[],
  headers: Record<string, string> = {},
  status = 200,
): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  let i = 0;
  const next = () => {
    if (i >= chunks.length) return void res.end();
    res.write(chunks[i++]!);
    setTimeout(next, 15);
  };
  next();
}

function decoded(r: Reply): string {
  const enc = String(r.headers["content-encoding"] ?? "").toLowerCase();
  if (enc === "gzip") return gunzipSync(r.raw).toString("utf8");
  if (enc === "br") return brotliDecompressSync(r.raw).toString("utf8");
  return r.raw.toString("utf8");
}

describe("black-box: Speed Insights", () => {
  let edge: RunningEdge;
  let app: FakeBackend;
  let other: FakeBackend;
  // The page each test wants the app to serve next.
  let respond: (res: ServerResponse, path: string) => void = (res) =>
    page(res, ["<html><head></head><body>x</body></html>"]);

  beforeAll(async () => {
    app = await startBackend("app");
    other = await startBackend("other");
    app.setHandler((req, res) => respond(res, req.url ?? "/"));
    edge = await startEdge({ mode: "dev" });
    expect(
      (
        await adminPut(edge.adminUrl, "si.test", {
          backends: [{ id: "env_a", url: app.url, weight: 1 }],
          insights: { enabled: true, inject: true, sampleRate: 50 },
        })
      ).status,
    ).toBe(204);
    await adminPut(edge.adminUrl, "si10.test", {
      backends: [{ id: "env_a", url: app.url, weight: 1 }],
      insights: { enabled: true, inject: false, sampleRate: 10 },
    });
    await adminPut(edge.adminUrl, "manual.test", {
      backends: [
        { id: "env_a", url: app.url, weight: 50 },
        { id: "env_b", url: other.url, weight: 50 },
      ],
      insights: { enabled: true, inject: false, sampleRate: 100 },
    });
  }, 30_000);
  afterAll(async () => {
    await edge?.stop();
    await Promise.all([app?.close(), other?.close()]);
  });

  const get = (host: string, path: string, headers: Record<string, string> = {}, method = "GET") =>
    send(`${edge.dataUrl}${path}`, { method, headers: { host, ...headers } });
  const beacon = (host: string, body: unknown, headers: Record<string, string> = {}) =>
    send(`${edge.dataUrl}${VITALS}`, {
      method: "POST",
      headers: { host, "user-agent": UA, "content-type": "text/plain", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const drain = async () => {
    const r = await send(`${edge.adminUrl}/insights/drain`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    return JSON.parse(r.body) as { batches: Record<string, unknown>[] };
  };

  it("serves the script's exact bytes and headers per sample rate, on GET and HEAD, without a cookie", async () => {
    for (const [host, rate] of [
      ["si.test", 50],
      ["si10.test", 10],
    ] as const) {
      const r = await get(host, SCRIPT, NAV);
      expect(r.status).toBe(200);
      expect(r.raw.equals(Buffer.from(buildScript(rate), "utf8")), `script for ${rate}`).toBe(true);
      expect(r.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(r.headers["cache-control"]).toBe("public, max-age=3600");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(r.headers["x-nbo-edge-backend"]).toBeUndefined();
    }
    const head = await get("si.test", SCRIPT, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.raw.length).toBe(0);
    expect(head.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(head.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("answers 404 for other paths under the insights prefix and for a POST to the script", async () => {
    const seen = app.seen.length;
    for (const [path, method] of [
      ["/_nbo/insights/v1/other", "GET"],
      [SCRIPT, "POST"],
    ] as const) {
      const r = await get("si.test", path, {}, method);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body).toBe("not found");
    }
    expect(app.seen.length).toBe(seen);
  });

  it("takes a valid beacon with 204 and answers 405 with Allow: POST to other methods", async () => {
    const ok = await beacon("si.test", {
      metric: "LCP",
      value: 1200,
      route: "/",
      device: "desktop",
      environmentId: "env_a",
      contentId: "c1",
    });
    expect(ok.status).toBe(204);
    expect(ok.raw.length).toBe(0);
    for (const method of ["GET", "PUT"]) {
      const r = await get("si.test", VITALS, {}, method);
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe("POST");
    }
    await drain();
  });

  const good = { metric: "INP", value: 80, route: "/a", device: "mobile" };
  const badBeacons: [string, unknown][] = [
    ["not JSON", "{nope"],
    ["an array", [good]],
    ["an unknown metric", { ...good, metric: "FID" }],
    ["a string value", { ...good, value: "80" }],
    ["a negative value", { ...good, value: -1 }],
    ["a timing over 120 s", { ...good, metric: "LCP", value: 120_001 }],
    ["a CLS over 10", { ...good, metric: "CLS", value: 10.5 }],
    ["a route that is not a string", { ...good, route: 5 }],
    ["a route that is not a path", { ...good, route: "users/1" }],
    ["a protocol-relative route", { ...good, route: "//evil.example/x" }],
    ["a route over 200 characters", { ...good, route: "/" + "a".repeat(200) }],
    ["an unknown device", { ...good, device: "tablet" }],
    ["a bad environmentId", { ...good, environmentId: "env a" }],
    ["a bad contentId", { ...good, contentId: "x/y" }],
    ["a body over 2 KB", { ...good, contentId: "a".repeat(100), pad: "x".repeat(2100) }],
  ];

  it.each(badBeacons)("answers 400 to a beacon with %s", async (_name, body) => {
    const r = await beacon("si.test", body);
    expect(r.status).toBe(400);
    expect(r.body.startsWith("edge: invalid beacon: ")).toBe(true);
  });

  it("answers 204 but counts nothing for bots, an empty user-agent and an unknown environment", async () => {
    await drain();
    const b = { metric: "FCP", value: 300, route: "/", device: "desktop", environmentId: "env_a" };
    expect((await beacon("si.test", b, { "user-agent": "Googlebot/2.1" })).status).toBe(204);
    expect((await beacon("si.test", b, { "user-agent": "" })).status).toBe(204);
    expect((await beacon("si.test", b, { "user-agent": "Mozilla/5.0 HeadlessChrome/130" })).status).toBe(204);
    expect((await beacon("si.test", { ...b, environmentId: "env_zzz" })).status).toBe(204);
    // A manual tag (no environmentId) without a visitor cookie is not counted either.
    const { environmentId: _e, ...noEnv } = b;
    expect((await beacon("si.test", noEnv)).status).toBe(204);
    expect((await drain()).batches).toEqual([]);
  });

  it("drains histograms in the control-plane's shape, normalising routes and bucketing values", async () => {
    await drain();
    expect(
      (
        await beacon("si.test", {
          metric: "LCP",
          value: 1234.5,
          route: "/users/12345/posts?x=1",
          device: "desktop",
          environmentId: "env_a",
          contentId: "dep-1",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await beacon("si.test", {
          metric: "LCP",
          value: 1234.5,
          route: "/users/999/posts",
          device: "desktop",
          environmentId: "env_a",
          contentId: "dep-1",
        })
      ).status,
    ).toBe(204);
    expect(
      (await beacon("si.test", { metric: "CLS", value: 0.07, route: "/", device: "mobile", environmentId: "env_a" }))
        .status,
    ).toBe(204);
    const { batches } = await drain();
    expect(batches).toHaveLength(2);
    const lcp = batches.find((x) => x.metric === "LCP")!;
    const cls = batches.find((x) => x.metric === "CLS")!;
    expect(Object.keys(lcp).sort()).toEqual([
      "buckets",
      "contentId",
      "count",
      "device",
      "environmentId",
      "host",
      "metric",
      "minute",
      "route",
    ]);
    expect(lcp).toMatchObject({
      host: "si.test",
      environmentId: "env_a",
      contentId: "dep-1",
      route: "/users/[id]/posts",
      device: "desktop",
      count: 2,
    });
    expect(lcp.buckets).toEqual({ [String(bucketIndex("LCP", 1234.5))]: 2 });
    expect(String(lcp.minute)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/);
    expect(cls).toMatchObject({
      host: "si.test",
      environmentId: "env_a",
      contentId: "",
      route: "/",
      device: "mobile",
      count: 1,
    });
    expect(cls.buckets).toEqual({ [String(bucketIndex("CLS", 0.07))]: 1 });
    // A drain empties the aggregator.
    expect((await drain()).batches).toEqual([]);
  });

  it("attributes a manual-tag beacon to the backend the visitor's cookie picks", async () => {
    await drain();
    const id = randomBytes(16).toString("hex");
    const expected = pickSticky(
      {
        host: "manual.test",
        backends: [
          { id: "env_a", url: app.url, weight: 50, insecureSkipVerify: false },
          { id: "env_b", url: other.url, weight: 50, insecureSkipVerify: false },
        ],
      },
      id,
    ).id;
    expect(
      (
        await beacon(
          "manual.test",
          { metric: "TTFB", value: 90, route: "/p", device: "desktop" },
          { cookie: `nbo_v=${id}` },
        )
      ).status,
    ).toBe(204);
    const { batches } = await drain();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ host: "manual.test", environmentId: expected, metric: "TTFB" });
  });

  // inOneMinute runs a scenario on a fresh host and drains its batches,
  // retrying when the beacons straddled a minute boundary (the limits are
  // per minute, so a split run proves nothing).
  async function inOneMinute(
    name: string,
    scenario: (host: string) => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const host = `${name}-${attempt}.test`;
      await adminPut(edge.adminUrl, host, {
        backends: [{ id: "env_a", url: app.url, weight: 1 }],
        insights: { enabled: true, inject: false, sampleRate: 100 },
      });
      await drain();
      await scenario(host);
      const batches = (await drain()).batches.filter((b) => b.host === host);
      if (new Set(batches.map((b) => b.minute)).size === 1) return batches;
    }
    throw new Error("every attempt straddled a minute boundary");
  }

  it("folds routes past 100 per host per minute into (other), keeping routes already seen", async () => {
    const batches = await inOneMinute("limit-routes", async (host) => {
      for (let i = 1; i <= 105; i++) {
        expect(
          (
            await beacon(host, {
              metric: "FCP",
              value: 100,
              route: `/page-r${i}`,
              device: "desktop",
              environmentId: "env_a",
            })
          ).status,
        ).toBe(204);
      }
      // A route admitted before the cap is still its own route.
      await beacon(host, { metric: "FCP", value: 100, route: "/page-r1", device: "desktop", environmentId: "env_a" });
    });
    const byRoute = new Map(batches.map((b) => [b.route as string, b.count as number]));
    expect(byRoute.size).toBe(101);
    expect(byRoute.get("(other)")).toBe(5);
    expect(byRoute.get("/page-r1")).toBe(2);
    expect(byRoute.get("/page-r100")).toBe(1);
    expect(byRoute.has("/page-r101")).toBe(false);
  }, 60_000);

  it("keeps 5 content ids per environment per minute; later ones count under an empty content id", async () => {
    const batches = await inOneMinute("limit-cids", async (host) => {
      for (let i = 1; i <= 7; i++) {
        expect(
          (
            await beacon(host, {
              metric: "TTFB",
              value: 50,
              route: "/",
              device: "mobile",
              environmentId: "env_a",
              contentId: `dep-${i}`,
            })
          ).status,
        ).toBe(204);
      }
      await beacon(host, {
        metric: "TTFB",
        value: 50,
        route: "/",
        device: "mobile",
        environmentId: "env_a",
        contentId: "dep-1",
      });
    });
    const byContent = new Map(batches.map((b) => [b.contentId as string, b.count as number]));
    expect([...byContent.keys()].sort()).toEqual(["", "dep-1", "dep-2", "dep-3", "dep-4", "dep-5"]);
    expect(byContent.get("")).toBe(2);
    expect(byContent.get("dep-1")).toBe(2);
    expect(byContent.get("dep-5")).toBe(1);
  }, 60_000);

  // Not tested over HTTP: the 1000 beacons/host/second rate cap (timing-bound,
  // flaky on a loaded machine) and the 100k-key cap; Rust unit tests cover them.

  const tag = (contentId = "") => insightsTag({ environmentId: "env_a", contentId, sampleRate: 50 });

  it("inserts the tag before a chunk-split </HEAD>, drops content-length and weakens a strong ETag", async () => {
    const html = "<html><HEAD><title>t</title></HEAD><body>hi</body></html>";
    respond = (res) =>
      page(res, ["<html><HEAD><title>t</title></HE", "AD><body>hi</body></html>"], {
        "x-nbo-deployment-id": 'dep"1<',
        etag: '"abc"',
        "content-length": String(html.length),
      });
    const r = await get("si.test", "/", NAV);
    expect(r.status).toBe(200);
    expect(r.body).toBe(`<html><HEAD><title>t</title>${tag('dep"1<')}</HEAD><body>hi</body></html>`);
    expect(r.body).toContain('data-d="dep&quot;1&lt;"');
    expect(r.headers["content-length"]).toBeUndefined();
    expect(r.headers.etag).toBe('W/"abc"');
    // A weak ETag stays as it is.
    respond = (res) => page(res, ["<head></head>"], { etag: 'W/"w"' });
    expect((await get("si.test", "/", NAV)).headers.etag).toBe('W/"w"');
  });

  it("Review Focus 3: </head> split across chunks, in mixed case, or absent (then </body>, then nothing)", async () => {
    const cases: { name: string; chunks: string[]; want: string }[] = [
      {
        name: "split </he|ad>",
        chunks: ["<html><head><title>x</title></he", "ad><body></body></html>"],
        want: `<html><head><title>x</title>${tag()}</head><body></body></html>`,
      },
      { name: "split <|/head>", chunks: ["<head><", "/head>"], want: `<head>${tag()}</head>` },
      { name: "split one byte at a time", chunks: [..."<head></HeAd>x"], want: `<head>${tag()}</HeAd>x` },
      {
        name: "mixed case",
        chunks: ["<HTML><HeAd></hEaD><BODY></BODY>"],
        want: `<HTML><HeAd>${tag()}</hEaD><BODY></BODY>`,
      },
      {
        name: "large chunk after a held tail",
        chunks: ["<p>x</p></h", "ead>" + "y".repeat(200)],
        want: `<p>x</p>${tag()}</head>${"y".repeat(200)}`,
      },
      {
        name: "no </head>: before </body>",
        chunks: ["<html><body>hi</bo", "dy></html>"],
        want: `<html><body>hi${tag()}</body></html>`,
      },
      {
        name: "</body> before </head>",
        chunks: ["<body></body><head></head>"],
        want: `<body>${tag()}</body><head></head>`,
      },
      { name: "neither: unchanged", chunks: ["<p>no tags here</p>", "</he"], want: "<p>no tags here</p></he" },
      {
        name: "only the first </head>",
        chunks: ["<head></head><head></head>"],
        want: `<head>${tag()}</head><head></head>`,
      },
    ];
    for (const c of cases) {
      respond = (res) => page(res, c.chunks);
      const r = await get("si.test", "/", NAV);
      expect(r.body, c.name).toBe(c.want);
    }
  });

  it("leaves pages alone when the tag must not go in", async () => {
    const body = "<html><head></head><body></body></html>";
    const cases: {
      name: string;
      headers: Record<string, string>;
      reqHeaders?: Record<string, string>;
      status?: number;
      method?: string;
    }[] = [
      { name: "a fetch() of HTML", headers: {}, reqHeaders: { "sec-fetch-dest": "empty", accept: "text/html" } },
      { name: "no navigation headers", headers: {}, reqHeaders: {} },
      { name: "a 404 page", headers: {}, status: 404 },
      { name: "plain text", headers: { "content-type": "text/plain" } },
      { name: "UTF-16", headers: { "content-type": "text/html; charset=utf-16" } },
      { name: "no-transform", headers: { "cache-control": "public, no-transform" } },
      { name: "a POST", headers: {}, method: "POST" },
    ];
    for (const c of cases) {
      respond = (res) => page(res, [body], { etag: '"e"', ...c.headers }, c.status ?? 200);
      const r = await send(`${edge.dataUrl}/`, {
        method: c.method ?? "GET",
        headers: { host: "si.test", ...(c.reqHeaders ?? NAV) },
        body: c.method === "POST" ? "x" : undefined,
      });
      expect(r.body, c.name).toBe(body);
      expect(r.headers.etag, c.name).toBe('"e"');
    }
    // inject off: the site adds the tag itself.
    respond = (res) => page(res, [body]);
    expect((await get("si10.test", "/", NAV)).body).toBe(body);
  });

  it("Review Focus 2 (inject on): a gzip or brotli page gets the tag and arrives decodable", async () => {
    const body = "<html><head><title>z</title></head><body>compressed</body></html>";
    for (const [enc, data] of [
      ["gzip", gzipSync(body)],
      ["br", brotliCompressSync(body)],
    ] as const) {
      respond = (res) =>
        page(res, [data], { "content-encoding": enc, "content-length": String(data.length), vary: "accept-encoding" });
      const r = await get("si.test", "/", { ...NAV, "accept-encoding": "gzip, deflate, br" });
      expect(r.status).toBe(200);
      expect(decoded(r), enc).toBe(`<html><head><title>z</title>${tag()}</head><body>compressed</body></html>`);
      if (r.headers["content-length"] !== undefined) expect(Number(r.headers["content-length"])).toBe(r.raw.length);
    }
  });

  // Intended difference 1: the Rust edge passes compressed answers through;
  // the Node edge's fetch() decompresses them, so these run only on Rust.
  const rustOnly = edgeImpl() === "rust" ? it : it.skip;
  const compressed = (body: string) =>
    [
      ["gzip", gzipSync(body)],
      ["br", brotliCompressSync(body)],
    ] as const;

  rustOnly(
    "Review Focus 2 (pass-through): with inject off, a gzip or brotli page keeps its bytes and content-encoding",
    async () => {
      for (const [enc, data] of compressed("<html><head></head><body>inject off</body></html>")) {
        respond = (res) =>
          page(res, [data], {
            "content-encoding": enc,
            "content-length": String(data.length),
            vary: "accept-encoding",
          });
        const r = await get("si10.test", "/", { ...NAV, "accept-encoding": "gzip, deflate, br" });
        expect(r.status).toBe(200);
        expect(r.headers["content-encoding"], enc).toBe(enc);
        expect(r.raw.equals(data), enc).toBe(true);
      }
    },
  );

  rustOnly(
    "Review Focus 2 (pass-through): a compressed asset (a script, an image) keeps its bytes and content-encoding with inject on",
    async () => {
      for (const [path, type] of [
        ["/app.js", "text/javascript"],
        ["/logo.svg", "image/svg+xml"],
      ] as const) {
        for (const [enc, data] of compressed("<html><head></head><body>not a page</body></html>")) {
          respond = (res) =>
            page(res, [data], { "content-type": type, "content-encoding": enc, "content-length": String(data.length) });
          const r = await get("si.test", path, { "accept-encoding": "gzip, deflate, br" });
          expect(r.status).toBe(200);
          expect(r.headers["content-encoding"], `${path} ${enc}`).toBe(enc);
          expect(r.raw.equals(data), `${path} ${enc}`).toBe(true);
        }
      }
    },
  );

  // Five cases from the Speed Insights and live builds spec ("For the Rust
  // edge"); both edges must pass them.
  it("passes an unknown content-encoding (x-custom, gzip + x-custom) through with its bytes", async () => {
    const data = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x42, 0x43]);
    for (const enc of ["x-custom", "gzip, x-custom"]) {
      respond = (res) => {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-encoding": enc,
          "content-length": String(data.length),
        });
        res.end(data);
      };
      const r = await get("si.test", "/blob", { "accept-encoding": "gzip, deflate, br" });
      expect(r.status).toBe(200);
      expect(r.headers["content-encoding"], enc).toBe(enc);
      expect(r.raw.equals(data), enc).toBe(true);
    }
  });

  it("keeps content-encoding: gzip on a HEAD answer and on a 304", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "text/javascript", "content-encoding": "gzip", "content-length": "123" });
      res.end();
    };
    const head = await get("si.test", "/app.js", { "accept-encoding": "gzip" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.raw.length).toBe(0);

    respond = (res) => {
      res.writeHead(304, { "content-encoding": "gzip", etag: '"e1"' });
      res.end();
    };
    const notModified = await get("si.test", "/app.js", { "accept-encoding": "gzip", "if-none-match": '"e1"' });
    expect(notModified.status).toBe(304);
    expect(notModified.headers["content-encoding"]).toBe("gzip");
    expect(notModified.raw.length).toBe(0);
  });

  it("puts a page's x-nbo-deployment-id in the tag's data-d and passes the header on unchanged", async () => {
    const id = `sha256:${"ab".repeat(32)}`;
    respond = (res) => page(res, ["<html><head></head><body>d</body></html>"], { "x-nbo-deployment-id": id });
    const r = await get("si.test", "/", NAV);
    expect(r.status).toBe(200);
    expect(r.body).toBe(`<html><head>${tag(id)}</head><body>d</body></html>`);
    expect(r.body).toContain(`data-d="${id}"`);
    expect(r.headers["x-nbo-deployment-id"]).toBe(id);
  });

  it("passes x-nbo-carried-from on unchanged", async () => {
    const value = `sha256:${"cd".repeat(32)}`;
    respond = (res) => page(res, ["<html><head></head><body>c</body></html>"], { "x-nbo-carried-from": value });
    for (const headers of [NAV, {}]) {
      const r = await get("si.test", "/", headers);
      expect(r.status).toBe(200);
      expect(r.headers["x-nbo-carried-from"]).toBe(value);
    }
  });
});
