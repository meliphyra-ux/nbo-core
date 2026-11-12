// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createRouter, type Decision } from "@nbo/router";
import { createStore } from "@nbo/isrcache";
import type { Resolver } from "@nbo/funcproxy";
import type { ServeState, PrerenderConfig } from "../serve.js";
import { prerenderCacheKey, handlePrerender } from "../prerender.js";
import { createFakeCacheService } from "./fake-cache-service.js";

// A browser revisiting an ISR page sends If-None-Match with the ETag
// Next gave it. Next answers such a request with 304 and no body. The
// ISR render must never pass those conditional headers on (the render
// is for the cache, not for this one browser), never cache anything
// but a 200, and never build a 304/204 Response with a body (Node's
// Response constructor throws "Invalid response status code 304").

const BYPASS_ENV = "TEST_NBO_CONDITIONAL_BYPASS";
afterEach(() => {
  delete process.env[BYPASS_ENV];
});

function cfgWith(overrides: Partial<PrerenderConfig> = {}): PrerenderConfig {
  return {
    id: "blog-detail",
    match: "^/blog/.+$",
    function: "ssr",
    revalidateSec: 300,
    expireSec: 86400,
    onMiss: "blocking",
    bypassToken: { env: BYPASS_ENV },
    ...overrides,
  };
}

function stateWith(cfg: PrerenderConfig, resolve: Resolver, resolveCache?: Resolver): ServeState {
  return {
    nboDir: "",
    index: new Map(),
    router: createRouter({ version: 1 }, "never"),
    resolve,
    resolveCache,
    prerenders: [cfg],
    images: undefined,
    regenInFlight: new Set(),
  };
}

function decision(cfg: PrerenderConfig): Decision {
  return { kind: "prerender", prerenderRoute: { id: cfg.id, matchPath: cfg.match, functionName: cfg.function } };
}

// nextLike behaves like a Next.js page handler: 304 with no body when
// the request's If-None-Match matches its ETag, otherwise the page.
function nextLike(seen: Request[], body = "page body"): Resolver {
  return () => async (req: Request) => {
    seen.push(req);
    if (req.headers.get("if-none-match") === '"etag-1"') return new Response(null, { status: 304, headers: { etag: '"etag-1"' } });
    return new Response(body, { status: 200, headers: { etag: '"etag-1"', "content-type": "text/html" } });
  };
}

function conditional(url = "http://x/blog/hello"): Request {
  return new Request(url, { headers: { "if-none-match": '"etag-1"', "if-modified-since": "Tue, 03 Nov 2026 10:00:00 GMT" } });
}

function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (cond()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, 5);
    };
    check();
  });
}

describe("ISR render with a conditional request", () => {
  it("onMiss: blocking with If-None-Match renders the full page, serves 200 and caches the full body", async () => {
    const cfg = cfgWith({ onMiss: "blocking" });
    const store = createStore();
    const seen: Request[] = [];
    const state = stateWith(cfg, nextLike(seen), () => createFakeCacheService(store));
    const request = conditional();

    const res = await handlePrerender(state, request, decision(cfg));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("page body");
    expect(seen[0]?.headers.get("if-none-match")).toBeNull();
    expect(seen[0]?.headers.get("if-modified-since")).toBeNull();
    const cached = store.get(prerenderCacheKey(request, cfg));
    expect(new TextDecoder().decode(cached?.entry.body)).toBe("page body");
  });

  it("a stale hit regenerated from a conditional request caches the full page, not an empty 304 body", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const seen: Request[] = [];
    const state = stateWith(cfg, nextLike(seen, "fresh body"), () => createFakeCacheService(store));
    const request = conditional();
    const key = prerenderCacheKey(request, cfg);
    store.set(key, { body: new TextEncoder().encode("stale body") }, 0, cfg.expireSec);
    let done: string | undefined;
    state.onRegenDone = (k) => (done = k);

    const res = await handlePrerender(state, request, decision(cfg));
    expect(await res.text()).toBe("stale body");
    await waitFor(() => done === key);

    expect(seen[0]?.headers.get("if-none-match")).toBeNull();
    expect(new TextDecoder().decode(store.get(key)?.entry.body)).toBe("fresh body");
  });

  it("a background regeneration that fails with 500 keeps the stale page", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const resolve: Resolver = () => async () => new Response("boom", { status: 500 });
    const state = stateWith(cfg, resolve, () => createFakeCacheService(store));
    const request = new Request("http://x/blog/hello");
    const key = prerenderCacheKey(request, cfg);
    store.set(key, { body: new TextEncoder().encode("stale body") }, 0, cfg.expireSec);
    let done: string | undefined;
    state.onRegenDone = (k) => (done = k);

    await handlePrerender(state, request, decision(cfg));
    await waitFor(() => done === key);

    expect(new TextDecoder().decode(store.get(key)?.entry.body)).toBe("stale body");
  });

  it("onMiss: blocking that renders a 500 serves it but does not cache it", async () => {
    const cfg = cfgWith({ onMiss: "blocking" });
    const store = createStore();
    let calls = 0;
    const resolve: Resolver = () => async () => {
      calls++;
      return calls === 1 ? new Response("boom", { status: 500 }) : new Response("page body");
    };
    const state = stateWith(cfg, resolve, () => createFakeCacheService(store));

    const first = await handlePrerender(state, new Request("http://x/blog/hello"), decision(cfg));
    expect(first.status).toBe(500);
    const second = await handlePrerender(state, new Request("http://x/blog/hello"), decision(cfg));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("page body");
  });

  it("draft mode passes the browser's conditional request through and relays a 304 without throwing", async () => {
    process.env[BYPASS_ENV] = "secret";
    const cfg = cfgWith();
    const seen: Request[] = [];
    const state = stateWith(cfg, nextLike(seen));
    const request = new Request("http://x/blog/hello", { headers: { "if-none-match": '"etag-1"', cookie: "__nbo_bypass=secret" } });

    const res = await handlePrerender(state, request, decision(cfg));

    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("etag")).toBe('"etag-1"');
  });
});
