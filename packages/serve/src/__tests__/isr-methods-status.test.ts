// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { createRouter, type Decision } from "@nbo/router";
import { createStore } from "@nbo/isrcache";
import type { Resolver } from "@nbo/funcproxy";
import type { ServeState, PrerenderConfig } from "../serve.js";
import { prerenderCacheKey, handlePrerender } from "../prerender.js";
import { createMiddlewareInvoker } from "../middleware.js";
import { createFakeCacheService } from "./fake-cache-service.js";

// ISR caching only applies to GET/HEAD, renders for the cache are always
// GETs, and the cache keeps a render's status, so deleted pages (404) and
// redirects are cached like Next does, while 5xx never are.

function cfgWith(overrides: Partial<PrerenderConfig> = {}): PrerenderConfig {
  return {
    id: "blog-detail",
    match: "^/blog/.+$",
    function: "ssr",
    revalidateSec: 300,
    expireSec: 86400,
    onMiss: "blocking",
    bypassToken: { env: "TEST_NBO_ISR_METHODS_BYPASS" },
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

interface Seen {
  method: string;
  body: string;
  range: string | null;
}

function recording(seen: Seen[], respond: (req: Request) => Response | Promise<Response> = () => new Response("page body")): Resolver {
  return () => async (req: Request) => {
    seen.push({ method: req.method, body: req.body ? await req.text() : "", range: req.headers.get("range") });
    return respond(req);
  };
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

const page = "http://x/blog/hello";
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe("ISR request methods", () => {
  it("a HEAD miss renders with GET, caches the full page, and answers the HEAD with no body", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const seen: Seen[] = [];
    const state = stateWith(cfg, recording(seen), () => createFakeCacheService(store));
    const request = new Request(page, { method: "HEAD" });

    const res = await handlePrerender(state, request, decision(cfg));

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(seen[0]?.method).toBe("GET");
    // The write runs in the background, after the answer.
    await vi.waitFor(() => expect(text(store.get(prerenderCacheKey(request, cfg))?.entry.body)).toBe("page body"));
  });

  it("a stale hit triggered by HEAD regenerates with GET", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const seen: Seen[] = [];
    const state = stateWith(
      cfg,
      recording(seen, () => new Response("fresh")),
      () => createFakeCacheService(store),
    );
    const request = new Request(page, { method: "HEAD" });
    const key = prerenderCacheKey(request, cfg);
    store.set(key, { body: new TextEncoder().encode("stale") }, 0, cfg.expireSec);
    let done: string | undefined;
    state.onRegenDone = (k) => (done = k);

    await handlePrerender(state, request, decision(cfg));
    await waitFor(() => done === key);

    expect(seen[0]?.method).toBe("GET");
    expect(text(store.get(key)?.entry.body)).toBe("fresh");
  });

  it("a POST to an ISR page goes straight to the function with its body and never touches the cache", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const seen: Seen[] = [];
    const state = stateWith(
      cfg,
      recording(seen, () => new Response("action result")),
      () => createFakeCacheService(store),
    );
    const getKey = prerenderCacheKey(new Request(page), cfg);
    store.set(getKey, { body: new TextEncoder().encode("cached page") }, 300, cfg.expireSec);

    const res = await handlePrerender(state, new Request(page, { method: "POST", body: "form=1", headers: { "next-action": "abc" } }), decision(cfg));

    expect(await res.text()).toBe("action result");
    expect(seen).toEqual([{ method: "POST", body: "form=1", range: null }]);
    expect(text(store.get(getKey)?.entry.body)).toBe("cached page");
  });

  it("a render for the cache drops Range", async () => {
    const cfg = cfgWith();
    const seen: Seen[] = [];
    const state = stateWith(cfg, recording(seen), () => createFakeCacheService(createStore()));
    await handlePrerender(state, new Request(page, { headers: { range: "bytes=0-10" } }), decision(cfg));
    expect(seen[0]?.range).toBeNull();
  });
});

describe("ISR keeps the render's status", () => {
  it("caches a 404 and serves it as 404 from the cache", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const seen: Seen[] = [];
    const state = stateWith(
      cfg,
      recording(seen, () => new Response("not here", { status: 404 })),
      () => createFakeCacheService(store),
    );

    const first = await handlePrerender(state, new Request(page), decision(cfg));
    await vi.waitFor(() => expect(store.get(prerenderCacheKey(new Request(page), cfg))).toBeDefined());
    const second = await handlePrerender(state, new Request(page), decision(cfg));

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await second.text()).toBe("not here");
    expect(seen).toHaveLength(1);
  });

  it("caches a permanent redirect with its Location", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const seen: Seen[] = [];
    const state = stateWith(
      cfg,
      recording(seen, () => new Response(null, { status: 308, headers: { location: "/blog/new" } })),
      () => createFakeCacheService(store),
    );

    await handlePrerender(state, new Request(page), decision(cfg));
    await vi.waitFor(() => expect(store.get(prerenderCacheKey(new Request(page), cfg))).toBeDefined());
    const second = await handlePrerender(state, new Request(page), decision(cfg));

    expect(second.status).toBe(308);
    expect(second.headers.get("location")).toBe("/blog/new");
    expect(seen).toHaveLength(1);
  });

  it("a page deleted since it was cached: the stale regeneration's 404 replaces it", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const state = stateWith(
      cfg,
      recording([], () => new Response("gone", { status: 404 })),
      () => createFakeCacheService(store),
    );
    const request = new Request(page);
    const key = prerenderCacheKey(request, cfg);
    store.set(key, { body: new TextEncoder().encode("old post") }, 0, cfg.expireSec);
    let done: string | undefined;
    state.onRegenDone = (k) => (done = k);

    await handlePrerender(state, request, decision(cfg));
    await waitFor(() => done === key);
    const after = await handlePrerender(state, new Request(page), decision(cfg));

    expect(after.status).toBe(404);
  });

  it("never caches a 5xx: a stale page survives a failing regeneration", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const state = stateWith(
      cfg,
      recording([], () => new Response("boom", { status: 503 })),
      () => createFakeCacheService(store),
    );
    const request = new Request(page);
    const key = prerenderCacheKey(request, cfg);
    store.set(key, { body: new TextEncoder().encode("good page") }, 0, cfg.expireSec);
    let done: string | undefined;
    state.onRegenDone = (k) => (done = k);

    await handlePrerender(state, request, decision(cfg));
    await waitFor(() => done === key);

    expect(text(store.get(key)?.entry.body)).toBe("good page");
    expect(store.get(key)?.entry.status ?? 200).toBe(200);
  });

  it("an entry stored without a status (older NBO) is served as 200", async () => {
    const cfg = cfgWith();
    const store = createStore();
    const state = stateWith(cfg, recording([]), () => createFakeCacheService(store));
    store.set(prerenderCacheKey(new Request(page), cfg), { body: new TextEncoder().encode("legacy") }, 300, cfg.expireSec);
    const res = await handlePrerender(state, new Request(page), decision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("legacy");
  });
});

describe("middleware answering with a null-body status", () => {
  it("a 204 (CORS preflight) yields a decision with no body", async () => {
    const resolve: Resolver = () => async () => new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
    const outcome = await createMiddlewareInvoker(resolve, new Request("http://x/api", { method: "OPTIONS" }))("middleware", "/api", "OPTIONS");
    expect(outcome.continue).toBe(false);
    expect(outcome.response?.middlewareStatus).toBe(204);
    expect(outcome.response?.middlewareBody).toBeUndefined();
  });
});
