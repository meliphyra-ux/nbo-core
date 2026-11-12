// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createRegistry, type InsightsSettings } from "../registry.js";
import { createProxyHandler } from "../proxy.js";
import { createAdminMux } from "../admin.js";
import { createAggregator } from "../insights/aggregator.js";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36";
const PAGE = "<!doctype html><html><head><title>t</title></head><body>hello</body></html>";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function backend(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
  });
}

const ON: InsightsSettings = { enabled: true, inject: true, sampleRate: 100 };

async function setup(insights: InsightsSettings | undefined, respond?: (req: IncomingMessage, res: ServerResponse) => void) {
  const hits: string[] = [];
  const url = await backend((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (respond) return respond(req, res);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(PAGE), "x-nbo-deployment-id": "sha256:feed" });
    res.end(PAGE);
  });
  const registry = createRegistry();
  registry.set("app.test", [{ id: "env_k8s", url, weight: 1, insecureSkipVerify: false }], insights);
  const aggregator = createAggregator();
  return { hits, aggregator, handler: createProxyHandler(registry, { insights: aggregator }), admin: createAdminMux(registry, { insights: aggregator }) };
}

const TAG = '<script defer src="/_nbo/insights/v1/script.js" data-e="env_k8s" data-d="sha256:feed" data-s="100"></script>';

function get(path = "/", init: RequestInit & { headers?: Record<string, string> } = {}) {
  return new Request(`http://edge${path}`, {
    ...init,
    headers: { host: "app.test", "user-agent": CHROME, "sec-fetch-dest": "document", accept: "text/html", ...(init.headers ?? {}) },
  });
}

describe("proxy with Speed Insights", () => {
  it("inserts the tag into HTML with the picked backend's id and the deployment id, dropping content-length", async () => {
    const { handler } = await setup(ON);
    const res = await handler(get());
    expect(await res.text()).toBe(PAGE.replace("</head>", `${TAG}</head>`));
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("set-cookie")).toMatch(/^nbo_v=/);
  });

  it("inserts into a gzip-compressed page (the edge sees the decompressed body)", async () => {
    const { handler } = await setup(ON, (_req, res) => {
      const gz = gzipSync(PAGE);
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": gz.length, "x-nbo-deployment-id": "sha256:feed" });
      res.end(gz);
    });
    const res = await handler(get("/", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toContain(`${TAG}</head>`);
  });

  it("uses an empty data-d when the response has no deployment id", async () => {
    const { handler } = await setup(ON, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    expect(await (await handler(get())).text()).toContain('data-e="env_k8s" data-d=""');
  });

  it.each([
    ["the host has insights off", undefined, undefined, "GET"],
    ["insertion is manual", { ...ON, inject: false }, undefined, "GET"],
    ["insights are disabled", { ...ON, enabled: false }, undefined, "GET"],
    ["the method is POST", ON, undefined, "POST"],
    ["the status is 404", ON, 404, "GET"],
  ] as const)("leaves the page untouched when %s", async (_name, insights, status, method) => {
    const { handler } = await setup(insights, (_req, res) => {
      res.writeHead(status ?? 200, { "content-type": "text/html", "content-length": Buffer.byteLength(PAGE) });
      res.end(PAGE);
    });
    const res = await handler(get("/", { method }));
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(PAGE)));
    expect(await res.text()).toBe(PAGE);
  });

  it("leaves non-HTML untouched", async () => {
    const { handler } = await setup(ON, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"head":"</head>"}');
    });
    expect(await (await handler(get())).text()).toBe('{"head":"</head>"}');
  });

  it("serves the script itself on an enabled host, without reaching the backend or setting a cookie", async () => {
    const { handler, hits } = await setup({ ...ON, sampleRate: 25 });
    const res = await handler(get("/_nbo/insights/v1/script.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("onLCP");
    expect(hits).toEqual([]);
  });

  it("passes insights paths through to the backend on a host with insights off", async () => {
    const { handler, hits } = await setup(undefined);
    await handler(get("/_nbo/insights/v1/script.js"));
    expect(hits).toEqual(["GET /_nbo/insights/v1/script.js"]);
  });

  it("takes beacons on an enabled host and drains them from the admin API", async () => {
    const { handler, hits, admin } = await setup(ON);
    const body = JSON.stringify({ metric: "INP", value: 120, route: "/p/9", device: "desktop", environmentId: "env_k8s", contentId: "sha256:feed" });
    const res = await handler(get("/_nbo/insights/v1/vitals", { method: "POST", body }));
    expect(res.status).toBe(204);
    expect(hits).toEqual([]);

    const drained = await (await admin(new Request("http://admin/insights/drain"))).json();
    expect(drained.batches).toHaveLength(1);
    expect(drained.batches[0]).toMatchObject({ host: "app.test", environmentId: "env_k8s", route: "/p/[id]", metric: "INP", count: 1 });
    expect((await (await admin(new Request("http://admin/insights/drain"))).json()).batches).toEqual([]);
  });

  it("weakens a strong ETag on a page it changed, and keeps a weak one", async () => {
    const { handler } = await setup(ON, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", etag: '"abc"' });
      res.end(PAGE);
    });
    expect((await handler(get())).headers.get("etag")).toBe('W/"abc"');
    const weak = await setup(ON, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", etag: 'W/"abc"' });
      res.end(PAGE);
    });
    expect((await weak.handler(get())).headers.get("etag")).toBe('W/"abc"');
  });

  it("keeps a strong ETag when nothing was inserted", async () => {
    const { handler } = await setup({ ...ON, inject: false }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", etag: '"abc"' });
      res.end(PAGE);
    });
    expect((await handler(get())).headers.get("etag")).toBe('"abc"');
  });

  it("leaves HTML fetched by a script untouched", async () => {
    const { handler } = await setup(ON);
    const res = await handler(get("/", { headers: { "sec-fetch-dest": "empty", accept: "text/html" } }));
    expect(await res.text()).toBe(PAGE);
  });

  it("relays a 304 untouched on an enabled host", async () => {
    const { handler } = await setup(ON, (_req, res) => {
      res.writeHead(304, { etag: '"abc"' });
      res.end();
    });
    const res = await handler(get("/", { headers: { "if-none-match": '"abc"' } }));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(res.body).toBeNull();
  });

  it("relays a HEAD for a page untouched on an enabled host", async () => {
    const { handler } = await setup(ON);
    const res = await handler(get("/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(PAGE)));
    expect(await res.text()).toBe("");
  });

  it("answers HEAD for the script without a body", async () => {
    const { handler, hits } = await setup(ON);
    const res = await handler(get("/_nbo/insights/v1/script.js", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toBe("");
    expect(hits).toEqual([]);
  });
});
