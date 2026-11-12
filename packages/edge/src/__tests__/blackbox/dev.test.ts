// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Black-box: dev-mode data plane (routing, stickiness, headers, timeouts).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer as createHttps } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { pickSticky } from "../../sticky.js";
import type { Backend, Target } from "../../registry.js";
import { adminPut, createTestCa, freePort, send, sendRaw, startBackend, startEdge, type FakeBackend, type RunningEdge } from "./harness.js";

const HEADER_TIMEOUT_MS = 1000;
// The conformance transcript both edges must pass (packages/conformance).
const TRANSCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/transcripts/platform/edge/01-revalidate-fanout.json");
const COOKIE_RE = /^nbo_v=([0-9a-f]{32}); Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax$/;
const SECURE_COOKIE_RE = /^nbo_v=([0-9a-f]{32}); Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure$/;

const visitorId = () => randomBytes(16).toString("hex");

describe("black-box: dev mode data plane", () => {
  let edge: RunningEdge;
  let a: FakeBackend;
  let b: FakeBackend;
  let c: FakeBackend;

  beforeAll(async () => {
    [a, b, c] = await Promise.all([startBackend("a"), startBackend("b"), startBackend("c")]);
    edge = await startEdge({ mode: "dev", env: { NBO_EDGE_HEADER_TIMEOUT_MS: String(HEADER_TIMEOUT_MS) } });
  }, 30_000);
  afterAll(async () => {
    await edge?.stop();
    await Promise.all([a?.close(), b?.close(), c?.close()]);
  });

  const get = (host: string, path = "/", headers: Record<string, string> = {}) => send(`${edge.dataUrl}${path}`, { headers: { host, ...headers } });

  it("closes an idle keep-alive connection about 5 s after its response (Node's keepAliveTimeout)", async () => {
    const socket = netConnect({ host: "127.0.0.1", port: edge.ports.data });
    let answeredAt = 0;
    let text = "";
    const closedAfter = await new Promise<number>((resolve, reject) => {
      socket.on("data", (c: Buffer) => {
        text += c.toString("utf8");
        if (!answeredAt) answeredAt = Date.now();
      });
      socket.on("close", () => resolve(Date.now() - answeredAt));
      socket.on("error", reject);
      socket.write("GET / HTTP/1.1\r\nHost: unknown.test\r\n\r\n");
      setTimeout(() => socket.destroy(), 15_000);
    });
    expect(text).toMatch(/^HTTP\/1\.1 404/);
    expect(answeredAt).toBeGreaterThan(0);
    expect(closedAfter).toBeGreaterThanOrEqual(4000);
    expect(closedAfter).toBeLessThan(12_000);
  }, 20_000);

  it("answers 404 with the edge's text for an unknown host", async () => {
    const r = await get("unknown.test");
    expect(r.status).toBe(404);
    expect(r.body).toBe("edge: no target registered for host unknown.test");
  });

  it("normalises the Host header: case, port and a trailing dot", async () => {
    expect((await adminPut(edge.adminUrl, "norm.test", { backends: [{ url: a.url, weight: 1 }] })).status).toBe(204);
    for (const host of ["Norm.Test", "norm.test.", "NORM.test:8080"]) {
      const r = await get(host);
      expect(r.status, host).toBe(200);
      expect(r.body).toBe("a");
    }
  });

  it("honours a weighted split, never picks weight 0, and names the backend in x-nbo-edge-backend", async () => {
    await adminPut(edge.adminUrl, "split.test", {
      backends: [
        { url: a.url, weight: 1 },
        { url: b.url, weight: 3 },
        { url: c.url, weight: 0 },
      ],
    });
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const byName: Record<string, string> = { a: a.url, b: b.url, c: c.url };
    for (let i = 0; i < 400; i++) {
      const r = await get("split.test", "/asset.js");
      expect(r.status).toBe(200);
      counts[r.body]!++;
      expect(r.headers["x-nbo-edge-backend"]).toBe(byName[r.body]);
      expect(r.headers["x-backend"]).toBe(r.body);
    }
    expect(counts.c).toBe(0);
    expect(counts.b).toBeGreaterThan(240);
    expect(counts.b).toBeLessThan(360);
  }, 60_000);

  it("Review Focus 1: a cookie's pick is stable and equals pickSticky for 1/99, 33/33/34 and a backend without id", async () => {
    const configs: { host: string; backends: Backend[] }[] = [
      {
        host: "rf1-a.test",
        backends: [
          { id: "env_a", url: a.url, weight: 1, insecureSkipVerify: false },
          { id: "env_b", url: b.url, weight: 99, insecureSkipVerify: false },
        ],
      },
      {
        host: "rf1-b.test",
        backends: [
          { id: "env_a", url: a.url, weight: 33, insecureSkipVerify: false },
          { id: "env_b", url: b.url, weight: 33, insecureSkipVerify: false },
          { id: "env_c", url: c.url, weight: 34, insecureSkipVerify: false },
        ],
      },
      {
        host: "rf1-c.test",
        backends: [
          { url: a.url, weight: 50, insecureSkipVerify: false },
          { id: "env_b", url: b.url, weight: 50, insecureSkipVerify: false },
          { url: c.url, weight: 0, insecureSkipVerify: false },
        ],
      },
    ];
    for (const cfg of configs) {
      expect((await adminPut(edge.adminUrl, cfg.host, { backends: cfg.backends })).status).toBe(204);
      const target: Target = { host: cfg.host, backends: cfg.backends };
      for (let i = 0; i < 40; i++) {
        const id = visitorId();
        const expected = pickSticky(target, id).url;
        for (let n = 0; n < 2; n++) {
          const r = await get(cfg.host, "/", { cookie: `nbo_v=${id}` });
          expect(r.headers["x-nbo-edge-backend"], `${cfg.host} ${id}`).toBe(expected);
          expect(r.headers["set-cookie"]).toBeUndefined();
        }
      }
    }
  }, 60_000);

  it("sets the visitor cookie only on document navigations, without Secure over plain http", async () => {
    await adminPut(edge.adminUrl, "cookie.test", {
      backends: [
        { id: "env_a", url: a.url, weight: 50 },
        { id: "env_b", url: b.url, weight: 50 },
      ],
    });
    const target: Target = {
      host: "cookie.test",
      backends: [
        { id: "env_a", url: a.url, weight: 50, insecureSkipVerify: false },
        { id: "env_b", url: b.url, weight: 50, insecureSkipVerify: false },
      ],
    };

    for (const headers of [{ "sec-fetch-dest": "document" }, { accept: "text/html,application/xhtml+xml;q=0.9" }, { "sec-fetch-dest": " Document " }]) {
      const r = await get("cookie.test", "/", headers);
      const cookies = r.headers["set-cookie"] ?? [];
      expect(cookies, JSON.stringify(headers)).toHaveLength(1);
      const m = COOKIE_RE.exec(cookies[0]!);
      expect(m, cookies[0]).not.toBeNull();
      // The new visitor is served by the backend their new id picks.
      expect(r.headers["x-nbo-edge-backend"]).toBe(pickSticky(target, m![1]!).url);
    }

    for (const headers of [{}, { "sec-fetch-dest": "image", accept: "text/html" }, { accept: "application/json" }, { "sec-fetch-dest": "empty" }]) {
      const r = await get("cookie.test", "/", headers);
      expect(r.status).toBe(200);
      expect(r.headers["set-cookie"], JSON.stringify(headers)).toBeUndefined();
    }

    // A valid cookie is kept; a malformed one is replaced on a navigation.
    expect((await get("cookie.test", "/", { "sec-fetch-dest": "document", cookie: `nbo_v=${visitorId()}` })).headers["set-cookie"]).toBeUndefined();
    const bad = await get("cookie.test", "/", { "sec-fetch-dest": "document", cookie: "nbo_v=NOTHEX" });
    expect(bad.headers["set-cookie"]?.[0]).toMatch(COOKIE_RE);
  });

  it("marks the cookie Secure when a TLS terminator says the visitor used https", async () => {
    await adminPut(edge.adminUrl, "secure.test", { backends: [{ url: a.url, weight: 1 }] });
    for (const headers of [{ "x-forwarded-proto": "https" }, { forwarded: 'for=1.2.3.4;proto="https"' }]) {
      const r = await get("secure.test", "/", { "sec-fetch-dest": "document", ...headers });
      expect(r.headers["set-cookie"]?.[0], JSON.stringify(headers)).toMatch(SECURE_COOKIE_RE);
    }
  });

  it("keeps the backend's own Set-Cookie headers next to the edge's", async () => {
    await adminPut(edge.adminUrl, "both-cookies.test", { backends: [{ url: c.url, weight: 1 }] });
    c.setHandler((_req, res) => {
      res.setHeader("set-cookie", ["app=1; Path=/", "other=2; Path=/"]);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("c");
    });
    try {
      const r = await get("both-cookies.test", "/", { "sec-fetch-dest": "document" });
      const cookies = r.headers["set-cookie"] ?? [];
      expect(cookies).toHaveLength(3);
      expect(cookies).toContain("app=1; Path=/");
      expect(cookies).toContain("other=2; Path=/");
      expect(cookies.some((v) => COOKIE_RE.test(v))).toBe(true);
    } finally {
      c.setHandler((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "x-backend": "c" });
        res.end("c");
      });
    }
  });

  it("strips nbo_v from the forwarded Cookie header, dropping a header left empty", async () => {
    await adminPut(edge.adminUrl, "strip.test", { backends: [{ url: a.url, weight: 1 }] });
    const id = visitorId();
    await get("strip.test", "/one", { cookie: `a=1; nbo_v=${id}; b=2` });
    expect(a.seen.at(-1)!.url).toBe("/one");
    expect(a.seen.at(-1)!.headers.cookie).toBe("a=1; b=2");
    await get("strip.test", "/two", { cookie: `nbo_v=${id}` });
    expect(a.seen.at(-1)!.url).toBe("/two");
    expect(a.seen.at(-1)!.headers.cookie).toBeUndefined();
  });

  it("Review Focus 5: drops hop-by-hop headers, Connection-named headers and the relay headers a visitor sends", async () => {
    await adminPut(edge.adminUrl, "hop.test", { backends: [{ url: b.url, weight: 1 }] });
    // Raw bytes: a Node client refuses to send Trailer without a chunked body.
    const answer = await sendRaw(
      edge.ports.data,
      [
        "GET /hop HTTP/1.1",
        "Host: hop.test",
        "Connection: x-secret, X-Other-Secret",
        "X-Secret: 1",
        "X-Other-Secret: 2",
        "Keep-Alive: timeout=5",
        "Proxy-Connection: keep-alive",
        "TE: trailers",
        "Trailer: x-trailer",
        "Upgrade: websocket",
        "X-Nbo-Relay-Token: stolen",
        "X-Nbo-Upstream: evil.nbo-p-x.svc.cluster.local:8080",
        "X-Kept: yes",
        "",
        "",
      ].join("\r\n"),
    );
    expect(answer.startsWith("HTTP/1.1 200")).toBe(true);
    const seen = b.seen.at(-1)!;
    expect(seen.url).toBe("/hop");
    for (const h of ["x-secret", "x-other-secret", "keep-alive", "proxy-connection", "te", "trailer", "upgrade", "x-nbo-relay-token", "x-nbo-upstream"]) {
      expect(seen.headers[h], h).toBeUndefined();
    }
    expect(String(seen.headers.connection ?? "")).not.toMatch(/secret/i);
    expect(seen.headers["x-kept"]).toBe("yes");
  });

  it("closes the connection without an answer on CONNECT, forwarding nothing", async () => {
    await adminPut(edge.adminUrl, "connect.test", { backends: [{ url: b.url, weight: 1 }] });
    const before = b.seen.length;
    const answer = await sendRaw(edge.ports.data, "CONNECT connect.test:443 HTTP/1.1\r\nHost: connect.test\r\n\r\n");
    expect(answer).toBe("");
    expect(b.seen.length).toBe(before);
  });

  it("sets x-forwarded-host from the Host header and x-forwarded-proto from the visitor's scheme", async () => {
    await adminPut(edge.adminUrl, "fwd.test", { backends: [{ url: a.url, weight: 1 }] });
    await get("fwd.test", "/f1", { "x-forwarded-host": "evil.example" });
    expect(a.seen.at(-1)!.headers["x-forwarded-host"]).toBe("fwd.test");
    expect(a.seen.at(-1)!.headers["x-forwarded-proto"]).toBe("http");
    // Dev mode believes a TLS terminator in front of it.
    await get("fwd.test", "/f2", { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.1" });
    // Dev mode passes the visitor's x-forwarded-for through (only cluster mode replaces it).
    expect(a.seen.at(-1)!.headers["x-forwarded-for"]).toBe("198.51.100.1");
    expect(a.seen.at(-1)!.headers["x-forwarded-proto"]).toBe("https");
    // The backend's own Host is its URL's, not the visitor's.
    expect(a.seen.at(-1)!.headers.host).toBe(new URL(a.url).host);
  });

  it("joins the backend's path and query with the visitor's", async () => {
    await adminPut(edge.adminUrl, "join.test", { backends: [{ url: `${a.url}/base?x=1`, weight: 1 }] });
    await get("join.test", "/a/b?y=2");
    expect(a.seen.at(-1)!.url).toBe("/base/a/b?x=1&y=2");
    await adminPut(edge.adminUrl, "join2.test", { backends: [{ url: `${a.url}/base/`, weight: 1 }] });
    await get("join2.test", "/c");
    expect(a.seen.at(-1)!.url).toBe("/base/c");
  });

  it("streams a request body to the backend and copies the backend's status and headers back", async () => {
    await adminPut(edge.adminUrl, "post.test", { backends: [{ url: c.url, weight: 1 }] });
    c.setHandler((req, res, body) => {
      res.writeHead(201, { "content-type": "application/json", "x-custom": "kept" });
      res.end(JSON.stringify({ method: req.method, body: body.toString("utf8") }));
    });
    try {
      const r = await send(`${edge.dataUrl}/submit`, { method: "POST", headers: { host: "post.test", "content-type": "text/plain" }, body: "hello edge" });
      expect(r.status).toBe(201);
      expect(r.headers["x-custom"]).toBe("kept");
      expect(r.headers["x-nbo-edge-backend"]).toBe(c.url);
      expect(JSON.parse(r.body)).toEqual({ method: "POST", body: "hello edge" });
    } finally {
      c.setHandler((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "x-backend": "c" });
        res.end("c");
      });
    }
  });

  it("passes a backend's 401 to a visitor POST with a body (not a 502)", async () => {
    await adminPut(edge.adminUrl, "post401.test", { backends: [{ url: c.url, weight: 1 }] });
    c.setHandler((_req, res, body) => {
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Bearer realm="app"' });
      res.end(`sign in first (${body.toString("utf8")})`);
    });
    try {
      const r = await send(`${edge.dataUrl}/api/login`, { method: "POST", headers: { host: "post401.test", "content-type": "text/plain" }, body: "name=a" });
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toBe('Bearer realm="app"');
      expect(r.body).toBe("sign in first (name=a)");
      const put = await send(`${edge.dataUrl}/api/login`, { method: "PUT", headers: { host: "post401.test", "content-type": "text/plain" }, body: "name=b" });
      expect(put.status).toBe(401);
      expect(put.body).toBe("sign in first (name=b)");
    } finally {
      c.setHandler((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "x-backend": "c" });
        res.end("c");
      });
    }
  });

  it("starts the header timeout after the upload: a request body trickling for longer than it still gets the answer", async () => {
    const upload = await startBackend("upload");
    upload.setHandler((_req, res, body) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`got ${body.length}`);
    });
    try {
      await adminPut(edge.adminUrl, "upload.test", { backends: [{ url: upload.url, weight: 1 }] });
      const chunks = 8;
      const gap = 300; // chunks * gap = 2.4 s, well past HEADER_TIMEOUT_MS
      const started = Date.now();
      const got = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const port = new URL(edge.dataUrl).port;
        const req = httpRequest(
          { host: "127.0.0.1", port, method: "POST", path: "/upload", headers: { host: "upload.test", "content-type": "application/octet-stream" }, agent: false },
          (res) => {
            let text = "";
            res.on("data", (c: Buffer) => (text += c.toString("utf8")));
            res.on("end", () => resolve({ status: res.statusCode!, body: text }));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        let sent = 0;
        const next = () => {
          if (sent === chunks) return void req.end();
          req.write("x".repeat(1000));
          sent++;
          setTimeout(next, gap);
        };
        next();
      });
      expect(Date.now() - started).toBeGreaterThan(HEADER_TIMEOUT_MS * 2);
      expect(got.status).toBe(200);
      expect(got.body).toBe(`got ${chunks * 1000}`);
    } finally {
      await upload.close();
    }
  }, 20_000);

  it("streams a response body as it arrives, with no body timeout", async () => {
    const slow = await startBackend("slow");
    let lastSentAt = 0;
    const gap = HEADER_TIMEOUT_MS + 500;
    slow.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.flushHeaders();
      setTimeout(() => {
        res.write("first-");
        setTimeout(() => {
          res.write("middle-");
          setTimeout(() => {
            lastSentAt = Date.now();
            res.end("last");
          }, gap);
        }, gap);
      }, gap);
    });
    try {
      await adminPut(edge.adminUrl, "stream.test", { backends: [{ url: slow.url, weight: 1 }] });
      const got = await new Promise<{ status: number; chunks: { at: number; text: string }[] }>((resolve, reject) => {
        const port = new URL(edge.dataUrl).port;
        const req = httpRequest({ host: "127.0.0.1", port, path: "/", headers: { host: "stream.test" }, agent: false }, (res) => {
          const chunks: { at: number; text: string }[] = [];
          res.on("data", (c: Buffer) => chunks.push({ at: Date.now(), text: c.toString("utf8") }));
          res.on("end", () => resolve({ status: res.statusCode!, chunks }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });
      expect(got.status).toBe(200);
      expect(got.chunks.map((c) => c.text).join("")).toBe("first-middle-last");
      // Not buffered: the first bytes reached the visitor before the backend sent its last.
      expect(got.chunks[0]!.text.startsWith("first-")).toBe(true);
      expect(got.chunks[0]!.at).toBeLessThan(lastSentAt);
    } finally {
      await slow.close();
    }
  }, 20_000);

  it("verifies backend certificates unless the backend sets insecureSkipVerify", async () => {
    // A certificate from a CA the edge has never heard of.
    const ca = await createTestCa();
    const leaf = await ca.leaf({ ip: ["127.0.0.1"] });
    const tlsBackend = await startBackend("tls", (listener) => createHttps({ cert: leaf.cert, key: leaf.key }, listener));
    try {
      await adminPut(edge.adminUrl, "strict.test", { backends: [{ url: tlsBackend.url, weight: 1 }] });
      const strict = await get("strict.test", "/strict");
      expect(strict.status).toBe(502);
      expect(strict.body.startsWith("edge: ")).toBe(true);
      expect(tlsBackend.seen).toHaveLength(0);
      await adminPut(edge.adminUrl, "insecure.test", { backends: [{ url: tlsBackend.url, weight: 1, insecureSkipVerify: true }] });
      const insecure = await get("insecure.test", "/insecure");
      expect(insecure.status).toBe(200);
      expect(insecure.body).toBe("tls");
      expect(tlsBackend.seen.at(-1)!.url).toBe("/insecure");
      // The flag is per backend: the strict target still refuses.
      expect((await get("strict.test", "/strict")).status).toBe(502);
    } finally {
      await tlsBackend.close();
    }
  });

  it("passes a 3xx through without following it", async () => {
    const r3 = await startBackend("redirect");
    r3.setHandler((_req, res) => {
      res.writeHead(302, { location: "/next" });
      res.end("moved");
    });
    try {
      await adminPut(edge.adminUrl, "redirect.test", { backends: [{ url: r3.url, weight: 1 }] });
      const r = await get("redirect.test", "/start");
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe("/next");
      expect(r.body).toBe("moved");
      expect(r3.seen.map((s) => s.url)).toEqual(["/start"]);
    } finally {
      await r3.close();
    }
  });

  it("answers 502 within the header timeout when a backend never answers", async () => {
    const silent = await startBackend("silent");
    silent.setHandler(() => {
      /* never answers */
    });
    try {
      await adminPut(edge.adminUrl, "silent.test", { backends: [{ url: silent.url, weight: 1 }] });
      const started = Date.now();
      const r = await get("silent.test");
      const elapsed = Date.now() - started;
      expect(r.status).toBe(502);
      expect(r.body.startsWith("edge: ")).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(HEADER_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(HEADER_TIMEOUT_MS + 4000);
    } finally {
      await silent.close();
    }
  });

  it("answers 502 starting with edge: when the backend refuses the connection", async () => {
    const port = await freePort();
    await adminPut(edge.adminUrl, "down.test", { backends: [{ url: `http://127.0.0.1:${port}`, weight: 1 }] });
    const r = await get("down.test");
    expect(r.status).toBe(502);
    expect(r.body.startsWith("edge: ")).toBe(true);
  });

  it("sends the Speed Insights paths to the app on a host without Speed Insights", async () => {
    await adminPut(edge.adminUrl, "no-insights.test", { backends: [{ url: a.url, weight: 1 }] });
    const r = await get("no-insights.test", "/_nbo/insights/v1/script.js");
    expect(r.status).toBe(200);
    expect(r.body).toBe("a");
    expect(a.seen.at(-1)!.url).toBe("/_nbo/insights/v1/script.js");
  });

  it("passes a backend answer with 150 headers through", async () => {
    const many = await startBackend("many");
    try {
      many.setHandler((_req, res) => {
        const h: Record<string, string> = { "content-type": "text/plain" };
        for (let i = 0; i < 150; i++) h[`x-many-${i}`] = `v${i}`;
        res.writeHead(200, h);
        res.end("ok");
      });
      await adminPut(edge.adminUrl, "many-headers.test", { backends: [{ url: many.url, weight: 1 }] });
      const r = await get("many-headers.test");
      expect(r.status).toBe(200);
      expect(r.body).toBe("ok");
      for (let i = 0; i < 150; i++) expect(r.headers[`x-many-${i}`]).toBe(`v${i}`);
    } finally {
      await many.close();
    }
  });

  it("answers 431 when a visitor's request headers add up to more than 16 KB", async () => {
    const big = "a".repeat(6000);
    const answer = await sendRaw(edge.ports.data, `GET / HTTP/1.1\r\nHost: big.test\r\nX-A: ${big}\r\nX-B: ${big}\r\nX-C: ${big}\r\n\r\n`);
    expect(answer).toMatch(/^HTTP\/1\.1 431/);
  });
});

// POST /_nbo/revalidate goes to every backend of the host (0% ones too), so
// one revalidation reaches every cloud that serves the address.
describe("black-box: revalidation fan-out", () => {
  const SECRET = "Bearer s3cret";
  const FANOUT_TIMEOUT_MS = 1500;
  let edge: RunningEdge;
  let p: FakeBackend;
  let q: FakeBackend;
  let r: FakeBackend;
  // Each backend checks the secret the way an app does.
  const appLike: Parameters<FakeBackend["setHandler"]>[0] = (req, res) => {
    res.writeHead(req.headers.authorization === SECRET ? 204 : 401);
    res.end();
  };

  beforeAll(async () => {
    [p, q, r] = await Promise.all([startBackend("p"), startBackend("q"), startBackend("r")]);
    edge = await startEdge({ mode: "dev", env: { NBO_EDGE_HEADER_TIMEOUT_MS: String(FANOUT_TIMEOUT_MS) } });
  }, 30_000);
  afterAll(async () => {
    await edge?.stop();
    await Promise.all([p?.close(), q?.close(), r?.close()]);
  });
  beforeEach(() => {
    for (const b of [p, q, r]) {
      b.seen.length = 0;
      b.setHandler(appLike);
    }
  });

  const revalidate = (host: string, body: string | Buffer, headers: Record<string, string> = {}) =>
    send(`${edge.dataUrl}/_nbo/revalidate`, { method: "POST", body, headers: { host, "content-type": "application/json", authorization: SECRET, ...headers } });

  async function register(host: string, backends: unknown[]): Promise<void> {
    expect((await adminPut(edge.adminUrl, host, { backends })).status).toBe(204);
  }

  it("Review Focus 5: sends the same body, secret and content type to every backend, a 0% one too, and answers 204", async () => {
    await register("fan.test", [
      { id: "env_p", url: p.url, weight: 1 },
      { id: "env_q", url: q.url, weight: 0 },
    ]);
    const body = JSON.stringify({ tags: ["posts", "home"], paths: ["/blog/x"] });
    const res = await revalidate("fan.test", body, { "sec-fetch-dest": "document" });
    expect(res.status).toBe(204);
    expect(res.headers["x-nbo-edge-fanout"]).toBe("2");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["x-nbo-edge-backend"]).toBeUndefined();
    for (const b of [p, q]) {
      expect(b.seen).toHaveLength(1);
      const seen = b.seen[0]!;
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/_nbo/revalidate");
      expect(seen.body).toBe(body);
      expect(seen.headers.authorization).toBe(SECRET);
      expect(seen.headers["content-type"]).toBe("application/json");
      expect(seen.headers["x-forwarded-host"]).toBe("fan.test");
      expect(seen.headers["x-forwarded-proto"]).toBe("http");
    }
  });

  it("Review Focus 5: 204 and 401 give 502 naming both backends and their statuses", async () => {
    await register("fan-mixed.test", [
      { id: "env_p", url: p.url, weight: 50 },
      { id: "env_q", url: q.url, weight: 50 },
    ]);
    q.setHandler((_req, res) => {
      res.writeHead(401);
      res.end("no");
    });
    const res = await revalidate("fan-mixed.test", '{"tags":["a"]}');
    expect(res.status).toBe(502);
    expect(res.headers["x-nbo-edge-fanout"]).toBe("2");
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual({
      backends: [
        { id: "env_p", status: 204 },
        { id: "env_q", status: 401 },
      ],
    });
  });

  it("a host can't be registered with no backends, so a revalidation for it is an unknown host's 404", async () => {
    expect((await adminPut(edge.adminUrl, "fan-empty.test", { backends: [] })).status).toBe(400);
    const res = await revalidate("fan-empty.test", '{"tags":["a"]}');
    expect(res.status).toBe(404);
    expect(res.body).toBe("edge: no target registered for host fan-empty.test");
    for (const b of [p, q, r]) expect(b.seen).toHaveLength(0);
  });

  it("Review Focus 5: 401 from every backend stays a plain 401", async () => {
    await register("fan-401.test", [
      { id: "env_p", url: p.url, weight: 1 },
      { id: "env_q", url: q.url, weight: 1 },
    ]);
    const res = await revalidate("fan-401.test", '{"tags":["a"]}', { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(res.headers["x-nbo-edge-fanout"]).toBe("2");
    expect(p.seen).toHaveLength(1);
    expect(q.seen).toHaveLength(1);
  });

  it("names a backend without an id by its URL, and an unreachable one with status 0", async () => {
    const downUrl = `http://127.0.0.1:${await freePort()}`;
    await register("fan-down.test", [
      { url: p.url, weight: 1 },
      { url: downUrl, weight: 1 },
    ]);
    const res = await revalidate("fan-down.test", '{"paths":["/"]}');
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({
      backends: [
        { id: p.url, status: 204 },
        { id: downUrl, status: 0 },
      ],
    });
  });

  it("gives a backend that never answers status 0 once its limit passes, without waiting on it", async () => {
    await register("fan-silent.test", [
      { id: "env_p", url: p.url, weight: 1 },
      { id: "env_r", url: r.url, weight: 1 },
    ]);
    r.setHandler(() => {
      /* never answers */
    });
    const started = Date.now();
    const res = await revalidate("fan-silent.test", '{"tags":["a"]}');
    const elapsed = Date.now() - started;
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({
      backends: [
        { id: "env_p", status: 204 },
        { id: "env_r", status: 0 },
      ],
    });
    expect(elapsed).toBeGreaterThanOrEqual(FANOUT_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(FANOUT_TIMEOUT_MS + 4000);
  });

  it("answers 413 for a body over 64 KiB before calling any backend", async () => {
    await register("fan-big.test", [
      { id: "env_p", url: p.url, weight: 1 },
      { id: "env_q", url: q.url, weight: 1 },
    ]);
    const res = await revalidate("fan-big.test", JSON.stringify({ tags: ["x".repeat(70 * 1024)] }));
    expect(res.status).toBe(413);
    expect(res.headers["x-nbo-edge-fanout"]).toBe("2");
    expect(p.seen).toHaveLength(0);
    expect(q.seen).toHaveLength(0);
  });

  it("accepts a body of exactly 64 KiB", async () => {
    await register("fan-edge-size.test", [{ id: "env_p", url: p.url, weight: 1 }]);
    const body = Buffer.alloc(65536, 0x61);
    const res = await revalidate("fan-edge-size.test", body);
    expect(res.status).toBe(204);
    expect(p.seen[0]!.body.length).toBe(65536);
  });

  it("proxies GET /_nbo/revalidate to one backend as usual", async () => {
    await register("fan-get.test", [
      { id: "env_p", url: p.url, weight: 1 },
      { id: "env_q", url: q.url, weight: 1 },
    ]);
    for (const b of [p, q]) b.setHandler((_req, res) => res.writeHead(200).end("got"));
    const res = await send(`${edge.dataUrl}/_nbo/revalidate`, { headers: { host: "fan-get.test" } });
    expect(res.status).toBe(200);
    expect(res.body).toBe("got");
    expect(res.headers["x-nbo-edge-fanout"]).toBeUndefined();
    expect(p.seen.length + q.seen.length).toBe(1);
  });

  it("passes the conformance transcript platform/edge/01-revalidate-fanout.json", async () => {
    await register("fan-transcript.test", [
      { id: "env_p", url: p.url, weight: 1 },
      { id: "env_q", url: q.url, weight: 0 },
    ]);
    const tr = JSON.parse(readFileSync(TRANSCRIPT, "utf8")) as {
      method: string;
      path: string;
      headers?: Record<string, string>;
      body?: string;
      expectStatus: number;
      expectHeaderPatterns?: Record<string, string>;
    };
    const res = await send(`${edge.dataUrl}${tr.path}`, { method: tr.method, body: tr.body, headers: { host: "fan-transcript.test", ...(tr.headers ?? {}) } });
    expect(res.status).toBe(tr.expectStatus);
    for (const [name, pattern] of Object.entries(tr.expectHeaderPatterns ?? {})) {
      expect(String(res.headers[name.toLowerCase()] ?? ""), name).toMatch(new RegExp(`^(?:${pattern})$`));
    }
    expect(p.seen).toHaveLength(1);
    expect(q.seen).toHaveLength(1);
  });
});
