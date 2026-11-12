// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter, type Decision } from "@nbo/router";
import { createStore } from "@nbo/isrcache";
import type { Resolver, FetchHandler } from "@nbo/funcproxy";
import type { ServeState, PrerenderConfig } from "../serve.js";
import { prerenderCacheKey, handlePrerender, handleRevalidate, backgroundWrites, BACKGROUND_WRITE_LIMIT } from "../prerender.js";
import { createFakeCacheService } from "./fake-cache-service.js";

const originalBypassEnv = process.env.TEST_NBO_PRERENDER_BYPASS;
afterEach(() => {
  if (originalBypassEnv === undefined) delete process.env.TEST_NBO_PRERENDER_BYPASS;
  else process.env.TEST_NBO_PRERENDER_BYPASS = originalBypassEnv;
});

function testPrerenderConfig(overrides: Partial<PrerenderConfig> = {}): PrerenderConfig {
  return {
    id: "blog-detail",
    match: "^/blog/.+$",
    function: "ssr",
    revalidateSec: 300,
    expireSec: 86400,
    onMiss: "blocking",
    bypassToken: { env: "TEST_NBO_PRERENDER_BYPASS" },
    ...overrides,
  };
}

function newTestState(cfg: PrerenderConfig, resolve?: Resolver, resolveCache?: Resolver): ServeState {
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

function stubResolver(fn: (request: Request) => Promise<Response>): Resolver {
  const handler: FetchHandler = fn;
  return () => handler;
}

function prerenderDecision(cfg: PrerenderConfig): Decision {
  return { kind: "prerender", prerenderRoute: { id: cfg.id, matchPath: cfg.match, functionName: cfg.function } };
}

// pprState is a state whose /blog/hello seed is the given shell.
async function pprState(cfg: PrerenderConfig, resolve?: Resolver, shell = "shell|", resolveCache?: Resolver): Promise<ServeState> {
  const state = newTestState(cfg, resolve, resolveCache);
  state.nboDir = await mkdtemp(join(tmpdir(), "serve-prerender-ppr-"));
  await mkdir(join(state.nboDir, "static"), { recursive: true });
  await writeFile(join(state.nboDir, "static", "blog-hello.html"), shell);
  state.index.set("/blog/hello", { file: "blog-hello.html", contentType: "text/html; charset=utf-8", cache: "revalidate" });
  return state;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
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

describe("handlePrerender", () => {
  it("a fresh cache hit serves the cached body and never calls the function", async () => {
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    let calledFunction = false;
    const resolve = stubResolver(async () => {
      calledFunction = true;
      return new Response("should not be called");
    });
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = newTestState(cfg, resolve, resolveCache);

    const request = new Request("http://x/blog/hello");
    const key = prerenderCacheKey(request, cfg);
    cacheStore.set(key, { body: new TextEncoder().encode("cached body") }, cfg.revalidateSec, cfg.expireSec);

    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cached body");
    expect(calledFunction).toBe(false);
  });

  it("a stale cache hit serves immediately and triggers exactly one background regeneration", async () => {
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    let functionCalls = 0;
    const resolve = stubResolver(async () => {
      functionCalls++;
      return new Response("fresh body");
    });
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = newTestState(cfg, resolve, resolveCache);

    const request = new Request("http://x/blog/hello");
    const key = prerenderCacheKey(request, cfg);
    cacheStore.set(key, { body: new TextEncoder().encode("stale body") }, 0, cfg.expireSec);

    let regenDoneKey: string | undefined;
    state.onRegenDone = (k) => (regenDoneKey = k);

    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("stale body");

    await waitFor(() => regenDoneKey === key);
    expect(functionCalls).toBe(1);
  });

  it("onMiss: blocking on a true cache miss calls the function, caches, and serves it", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    const cacheStore = createStore();
    const resolve = stubResolver(async () => new Response("rendered body"));
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = newTestState(cfg, resolve, resolveCache);
    const request = new Request("http://x/blog/hello");

    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("rendered body");

    const key = prerenderCacheKey(request, cfg);
    expect(cacheStore.get(key)?.entry.body).toEqual(new TextEncoder().encode("rendered body"));
  });

  it("onMiss: shell serves the configured seed without calling the function, and still regenerates", async () => {
    const cfg = testPrerenderConfig({ onMiss: "shell" });
    const cacheStore = createStore();
    let functionCalls = 0;
    const resolve = stubResolver(async () => {
      functionCalls++;
      return new Response("regenerated");
    });
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = newTestState(cfg, resolve, resolveCache);
    state.nboDir = await mkdtemp(join(tmpdir(), "serve-prerender-"));
    await mkdir(join(state.nboDir, "static"), { recursive: true });
    await writeFile(join(state.nboDir, "static", "blog-hello.html"), "seed body");
    state.index.set("/blog/hello", { file: "blog-hello.html", contentType: "text/html; charset=utf-8", cache: "revalidate" });

    let regenDoneKey: string | undefined;
    state.onRegenDone = (k) => (regenDoneKey = k);

    const request = new Request("http://x/blog/hello");
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("seed body");

    // The regeneration is fire-and-forget: with no real I/O delay in
    // this test's own stubs, it can finish before handlePrerender
    // itself even returns, so asserting "zero calls so far" would be
    // racy. The real invariant -- exactly one regeneration, serving
    // the seed rather than waiting on it -- is what onRegenDone proves.
    const key = prerenderCacheKey(request, cfg);
    await waitFor(() => regenDoneKey === key);
    expect(functionCalls).toBe(1);
  });

  it("onMiss: shell with no matching seed is a clean 404, not a crash", async () => {
    const cfg = testPrerenderConfig({ onMiss: "shell" });
    const state = newTestState(cfg);
    const request = new Request("http://x/blog/hello");
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.status).toBe(404);
  });

  it("draft mode always calls the function and never reads or writes the cache", async () => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    let functionCalls = 0;
    const resolve = stubResolver(async () => {
      functionCalls++;
      return new Response("draft body");
    });
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = newTestState(cfg, resolve, resolveCache);

    const request = new Request("http://x/blog/hello", { headers: { cookie: "__nbo_bypass=secret-bypass" } });
    const key = prerenderCacheKey(request, cfg);
    cacheStore.set(key, { body: new TextEncoder().encode("cached body") }, cfg.revalidateSec, cfg.expireSec);

    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(await res.text()).toBe("draft body");
    expect(functionCalls).toBe(1);
    // the cache entry set up above must be untouched -- draft mode
    // skips the cache entirely, in both directions
    expect(cacheStore.get(key)?.entry.body).toEqual(new TextEncoder().encode("cached body"));
  });

  // Final-review finding I2: render() throwing (no resolver, or the
  // resolved handler itself throwing) must still produce a clean
  // response, not a rejection.
  it("a function that rejects during draft-mode render is a clean 502", async () => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    const cfg = testPrerenderConfig();
    const resolve = stubResolver(async () => {
      throw new Error("boom");
    });
    const state = newTestState(cfg, resolve);
    const request = new Request("http://x/blog/hello", { headers: { cookie: "__nbo_bypass=secret-bypass" } });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.status).toBe(502);
  });

  it("a function that rejects during onMiss: blocking render is a clean 502", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    const resolve = stubResolver(async () => {
      throw new Error("boom");
    });
    const state = newTestState(cfg, resolve);
    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(res.status).toBe(502);
  });

  // Final-review finding C1 (second instance): render()'s own
  // header-copying had the same Set-Cookie-overwrite bug as
  // handleFunction.
  it("a blocking render that sets two Set-Cookie values caches and serves both", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    const resolve = stubResolver(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response("rendered", { headers });
    });
    const state = newTestState(cfg, resolve);
    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(res.headers.getSetCookie().sort()).toEqual(["a=1", "b=2"]);
  });

  // Final-review finding I2: a malformed 200 from the cache service
  // must read as a clean miss, matching Go's own treatment, not a
  // rejection.
  it("a malformed 200 from the cache service reads as a clean miss", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    let renderCalls = 0;
    const resolve = stubResolver(async () => {
      renderCalls++;
      return new Response("rendered");
    });
    const resolveCache: Resolver = () => async () => new Response("not json", { status: 200 });
    const state = newTestState(cfg, resolve, resolveCache);
    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(renderCalls).toBe(1);
  });

  // Real bug found reviewing this feature: Next's own client never
  // sends a "next-resume" request itself (confirmed directly — zero
  // references anywhere in next/dist/client) — the platform must do
  // the resume call internally, on every GET, and splice the result
  // after the shell in one response. This test pins that whole
  // mechanism: a GET triggers exactly one internal call shaped exactly
  // like the real protocol (POST, next-resume: 1, x-matched-path, the
  // config's own postponedState as the body), and the combined
  // response is the shell bytes followed by the function's bytes.
  it("serves the shell followed by a real internal resume call for a GET on a ppr-flagged route", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "the-postponed-state" } });
    let capturedRequest: Request | undefined;
    let capturedBody: string | undefined;
    const resolve = stubResolver(async (req) => {
      capturedRequest = req;
      capturedBody = await req.text();
      return new Response("|resumed", { status: 200 });
    });
    const cacheStore = createStore();
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = newTestState(cfg, resolve, resolveCache);
    state.nboDir = await mkdtemp(join(tmpdir(), "serve-prerender-ppr-"));
    await mkdir(join(state.nboDir, "static"), { recursive: true });
    await writeFile(join(state.nboDir, "static", "blog-hello.html"), "shell|");
    state.index.set("/blog/hello", { file: "blog-hello.html", contentType: "text/html; charset=utf-8", cache: "revalidate" });

    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shell||resumed");
    expect(capturedRequest!.method).toBe("POST");
    expect(capturedRequest!.headers.get("next-resume")).toBe("1");
    expect(capturedRequest!.headers.get("x-matched-path")).toBe("/blog/hello");
    expect(capturedBody).toBe("the-postponed-state");

    const key = prerenderCacheKey(new Request("http://x/blog/hello"), cfg);
    expect(cacheStore.get(key)).toBeUndefined();
  });

  // Server actions (and any other non-GET/HEAD request Next's own
  // client sends to this same route — a POST is never "give me the
  // whole document") must reach the function for real, not get the
  // static shell or an internal resume call of their own.
  it("forwards a non-GET/HEAD request (e.g. a server action) straight to the function, not through shell+resume", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let capturedBody: string | undefined;
    const resolve = stubResolver(async (req) => {
      capturedBody = await req.text();
      return new Response("action result", { status: 200 });
    });
    const state = newTestState(cfg, resolve);

    const request = new Request("http://x/blog/hello", { method: "POST", headers: { "next-action": "abc123" }, body: "action-payload" });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("action result");
    expect(capturedBody).toBe("action-payload");
  });

  // The 200 and the shell are on the wire before the resume answers, so
  // a failed resume can't change the status: the visitor keeps the shell
  // with its fallback, in a closed document. postponedState is
  // platform-only, so a rejected resume is a build fault, not a client
  // error, and it is logged.
  it("closes the document after the shell when the function rejects the resume, without caching it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
      const resolve = stubResolver(async () => new Response("bad postponed state", { status: 422 }));
      const cacheStore = createStore();
      const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
      const state = await pprState(cfg, resolve, "shell body", resolveCache);

      const request = new Request("http://x/blog/hello");
      const res = await handlePrerender(state, request, prerenderDecision(cfg));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("shell body</body></html>");
      expect(errors).toHaveBeenCalledOnce();
      expect(String(errors.mock.calls[0]![0])).toContain("422");
      expect(cacheStore.get(prerenderCacheKey(request, cfg))).toBeUndefined();
    } finally {
      errors.mockRestore();
    }
  });

  it("closes the document after the shell when the function call throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
      const state = await pprState(cfg, stubResolver(async () => { throw new Error("function unreachable"); }), "shell body");
      const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("shell body</body></html>");
      expect(String(errors.mock.calls[0]![0])).toContain("function unreachable");
    } finally {
      errors.mockRestore();
    }
  });

  it("closes the document when the function's body dies partway through", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
      const resolve = stubResolver(async () => {
        let n = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (n++ === 0) controller.enqueue(new TextEncoder().encode("partial"));
            else controller.error(new Error("function died"));
          },
        });
        return new Response(body);
      });
      const state = await pprState(cfg, resolve);
      const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
      expect(await res.text()).toBe("shell|partial</body></html>");
      expect(errors).toHaveBeenCalledOnce();
    } finally {
      errors.mockRestore();
    }
  });

  // The dynamic hole renders for this visitor: cookies() and headers() in
  // it must see the real request, or personalised content renders
  // logged-out.
  it("gives the resume the visitor's headers and query string, minus what only suits the original request", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "the-postponed-state" } });
    let captured: Request | undefined;
    const resolve = stubResolver(async (req) => {
      captured = req;
      return new Response(`cookie=${req.headers.get("cookie")}`);
    });
    const state = await pprState(cfg, resolve);
    const request = new Request("http://x/blog/hello?tab=2", {
      headers: {
        cookie: "session=abc",
        "user-agent": "visitor-agent",
        "if-none-match": '"etag"',
        range: "bytes=0-1",
        "content-length": "7",
        "content-type": "application/x-visitor",
        "accept-encoding": "gzip, br",
      },
    });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));

    expect(await res.text()).toBe("shell|cookie=session=abc");
    expect(captured!.url).toBe("http://x/blog/hello?tab=2");
    expect(captured!.headers.get("user-agent")).toBe("visitor-agent");
    expect(captured!.headers.has("if-none-match")).toBe(false);
    expect(captured!.headers.has("range")).toBe(false);
    expect(captured!.headers.has("content-length")).toBe(false);
    expect(captured!.headers.get("content-type")).not.toBe("application/x-visitor");
    // The function's bytes go straight after the uncompressed shell.
    expect(captured!.headers.get("accept-encoding")).toBe("identity");
    expect(captured!.headers.get("next-resume")).toBe("1");
    expect(captured!.headers.get("x-matched-path")).toBe("/blog/hello");
  });

  it("aborts the resume when the visitor disconnects", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let captured: Request | undefined;
    const resolve = stubResolver((req) => {
      captured = req;
      return new Promise<Response>(() => {});
    });
    const state = await pprState(cfg, resolve);
    const visitor = new AbortController();
    const res = await handlePrerender(state, new Request("http://x/blog/hello", { signal: visitor.signal }), prerenderDecision(cfg));
    await res.body!.getReader().read();

    expect(captured!.signal.aborted).toBe(false);
    visitor.abort();
    expect(captured!.signal.aborted).toBe(true);
  });

  it("aborts the resume and releases the function's body when the reader cancels", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let captured: Request | undefined;
    let bodyCancelled = false;
    const resolve = stubResolver(async (req) => {
      captured = req;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
        },
        cancel() {
          bodyCancelled = true;
        },
      }));
    });
    const state = await pprState(cfg, resolve);
    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();

    expect(captured!.signal.aborted).toBe(true);
    expect(bodyCancelled).toBe(true);
  });

  it("sends the shell before the function has answered at all", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const answer = deferred();
    let called = false;
    const resolve = stubResolver(async () => {
      called = true;
      await answer.promise;
      return new Response("|resumed");
    });
    const state = await pprState(cfg, resolve);
    const pending = handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    const res = await Promise.race([pending, new Promise<undefined>((r) => setTimeout(() => r(undefined), 500))]);
    if (!res) {
      answer.release();
      await pending;
      throw new Error("handlePrerender waited for the function before responding");
    }
    const reader = res.body!.getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("shell|");
    // Concurrent with the shell, not started by reading past it.
    expect(called).toBe(true);

    answer.release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("|resumed");
    expect((await reader.read()).done).toBe(true);
  });

  it("pipes the function's body chunk by chunk after the shell", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const second = deferred();
    const encoder = new TextEncoder();
    const resolve = stubResolver(async () =>
      new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("one"));
          await second.promise;
          controller.enqueue(encoder.encode("two"));
          controller.close();
        },
      })),
    );
    const state = await pprState(cfg, resolve);
    const pending = handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    const res = await Promise.race([pending, new Promise<undefined>((r) => setTimeout(() => r(undefined), 500))]);
    if (!res) {
      second.release();
      await pending;
      throw new Error("handlePrerender buffered the function's body before responding");
    }
    const reader = res.body!.getReader();
    const decode = (v: Uint8Array | undefined) => new TextDecoder().decode(v);

    expect(decode((await reader.read()).value)).toBe("shell|");
    expect(decode((await reader.read()).value)).toBe("one");
    second.release();
    expect(decode((await reader.read()).value)).toBe("two");
    expect((await reader.read()).done).toBe(true);
  });

  // The page can hold one visitor's cookies-based render: no shared cache
  // may keep it, whatever a route's own header rule says.
  it("marks GET and HEAD answers of a ppr-flagged route private, over any route header rule", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const state = await pprState(cfg, stubResolver(async () => new Response("resumed")));
    const decision: Decision = { ...prerenderDecision(cfg), headerOps: [{ set: { "cache-control": "public, max-age=3600", "x-rule": "kept" } }] };
    for (const method of ["GET", "HEAD"]) {
      const res = await handlePrerender(state, new Request("http://x/blog/hello", { method }), decision);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-rule")).toBe("kept");
      await res.text();
    }
    const plain = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(plain.headers.get("cache-control")).toBe("private, no-store");
    await plain.text();
  });

  it("answers a HEAD on a ppr-flagged route from the shell, with no function call", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let functionCalls = 0;
    const resolve = stubResolver(async () => {
      functionCalls++;
      return new Response("resumed");
    });
    const state = await pprState(cfg, resolve);
    const res = await handlePrerender(state, new Request("http://x/blog/hello", { method: "HEAD" }), prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("");
    expect(functionCalls).toBe(0);
  });

  // A client-side navigation asks for the page's RSC payload, not the
  // document, so the HTML shell and the resume have no part in its answer.
  it("resumes a client-side navigation: POST, next-resume, empty body, with the router's headers", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let captured: Request | undefined;
    let sentBody: string | undefined;
    const resolve = stubResolver(async (req) => {
      captured = req;
      sentBody = await req.text();
      return new Response("rsc payload", { headers: { "content-type": "text/x-component", "set-cookie": "a=1" } });
    });
    const state = await pprState(cfg, resolve);
    const request = new Request("http://x/blog/hello?_rsc=abc", {
      headers: { rsc: "1", "next-router-state-tree": "tree", "next-url": "/from", cookie: "session=abc", "next-action": "evil", "if-none-match": '"e"' },
    });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(await res.text()).toBe("rsc payload");
    expect(res.headers.get("content-type")).toBe("text/x-component");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("set-cookie")).toBe("a=1");
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toBe("http://x/blog/hello?_rsc=abc");
    expect(sentBody).toBe("");
    expect(captured!.headers.get("next-resume")).toBe("1");
    expect(captured!.headers.get("x-matched-path")).toBe("/blog/hello");
    expect(captured!.headers.get("rsc")).toBe("1");
    expect(captured!.headers.get("next-router-state-tree")).toBe("tree");
    expect(captured!.headers.get("next-url")).toBe("/from");
    expect(captured!.headers.get("cookie")).toBe("session=abc");
    expect(captured!.headers.has("next-action")).toBe(false);
    expect(captured!.headers.has("if-none-match")).toBe(false);
  });

  it("streams a client-side navigation instead of buffering it", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const gate = deferred();
    const encoder = new TextEncoder();
    const resolve = stubResolver(async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("first|"));
          await gate.promise;
          controller.enqueue(encoder.encode("second"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/x-component" } });
    });
    const state = await pprState(cfg, resolve);
    const res = await handlePrerender(state, new Request("http://x/blog/hello", { headers: { rsc: "1" } }), prerenderDecision(cfg));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first|");
    gate.release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second");
  });

  it("answers a client-side navigation with a 502 when the function call throws", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const state = await pprState(
      cfg,
      stubResolver(async () => {
        throw new Error("boom");
      }),
    );
    const res = await handlePrerender(state, new Request("http://x/blog/hello", { headers: { rsc: "1" } }), prerenderDecision(cfg));
    expect(res.status).toBe(502);
  });

  it("keeps a static prefetch on the function's static path, with no resume", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let captured: Request | undefined;
    const resolve = stubResolver(async (req) => {
      captured = req;
      return new Response("static flight", { headers: { "content-type": "text/x-component" } });
    });
    const state = await pprState(cfg, resolve);
    const request = new Request("http://x/blog/hello?_rsc=abc", { headers: { rsc: "1", "next-router-prefetch": "1" } });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(await res.text()).toBe("static flight");
    expect(captured!.method).toBe("GET");
    expect(captured!.headers.has("next-resume")).toBe(false);
  });

  it("resumes a runtime prefetch (next-router-prefetch: 2), which Next treats as dynamic", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let captured: Request | undefined;
    const resolve = stubResolver(async (req) => {
      captured = req;
      return new Response("flight");
    });
    const state = await pprState(cfg, resolve);
    await handlePrerender(state, new Request("http://x/blog/hello", { headers: { rsc: "1", "next-router-prefetch": "2" } }), prerenderDecision(cfg));
    expect(captured!.method).toBe("POST");
    expect(captured!.headers.get("next-router-prefetch")).toBe("2");
  });

  it("keeps a document resume free of a visitor's router and action headers", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let captured: Request | undefined;
    const resolve = stubResolver(async (req) => {
      captured = req;
      return new Response("resumed");
    });
    const state = await pprState(cfg, resolve);
    const request = new Request("http://x/blog/hello", {
      headers: {
        "next-action": "evil",
        "next-router-state-tree": "tree",
        "next-router-prefetch": "1",
        "next-router-segment-prefetch": "/x",
        "next-url": "/from",
        "x-prerender-revalidate": "guess",
        rsc: "0",
      },
    });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    await res.text();
    for (const h of ["next-action", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url", "x-prerender-revalidate", "rsc"]) {
      expect(captured!.headers.has(h), h).toBe(false);
    }
  });

  it("gives draft mode on a ppr-flagged route a whole fresh render: an empty resume, uncached", async () => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const cacheStore = createStore();
    let captured: Request | undefined;
    let sentBody: string | undefined;
    const resolve = stubResolver(async (req) => {
      captured = req;
      sentBody = await req.text();
      return new Response("<!DOCTYPE html>whole</html>", { status: 200, headers: { "content-type": "text/html", "cache-control": "s-maxage=31536000" } });
    });
    const state = await pprState(cfg, resolve, "shell|", () => createFakeCacheService(cacheStore));

    const request = new Request("http://x/blog/hello", { headers: { cookie: "__nbo_bypass=secret-bypass" } });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(await res.text()).toBe("<!DOCTYPE html>whole</html>");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(captured!.method).toBe("POST");
    expect(captured!.headers.get("next-resume")).toBe("1");
    expect(sentBody).toBe("");
    expect(cacheStore.get(prerenderCacheKey(request, cfg))).toBeUndefined();
  });

  it("passes a draft render's own status through, since nothing has been sent yet", async () => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const resolve = stubResolver(async () => new Response(null, { status: 307, headers: { location: "/elsewhere" } }));
    const state = await pprState(cfg, resolve);
    const request = new Request("http://x/blog/hello", { headers: { cookie: "__nbo_bypass=secret-bypass" } });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/elsewhere");
  });

  it("varies a ppr document on the headers that turn it into an RSC answer", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const state = await pprState(cfg, stubResolver(async () => new Response("resumed")));
    for (const method of ["GET", "HEAD"]) {
      const res = await handlePrerender(state, new Request("http://x/blog/hello", { method }), prerenderDecision(cfg));
      expect(res.headers.get("vary")).toBe("rsc, next-router-state-tree, next-router-prefetch");
      await res.body?.cancel();
    }
  });

  it("finds the seed and resumes by the rewrite's destination, not the visitor's path", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    let captured: Request | undefined;
    const resolve = stubResolver(async (req) => {
      captured = req;
      return new Response("resumed");
    });
    const state = await pprState(cfg, resolve);
    const res = await handlePrerender(state, new Request("http://x/alias?tab=2"), { ...prerenderDecision(cfg), prerenderPath: "/blog/hello" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shell|resumed");
    expect(captured!.url).toBe("http://x/blog/hello?tab=2");
    expect(captured!.headers.get("x-matched-path")).toBe("/blog/hello");
  });

  it("renders and caches a rewritten ISR route under the destination", async () => {
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    let captured: Request | undefined;
    const resolve = stubResolver(async (req) => {
      captured = req;
      return new Response("page");
    });
    const state = newTestState(cfg, resolve, () => createFakeCacheService(cacheStore));
    const res = await handlePrerender(state, new Request("http://x/alias"), { ...prerenderDecision(cfg), prerenderPath: "/blog/hello" });
    expect(await res.text()).toBe("page");
    expect(captured!.url).toBe("http://x/blog/hello");
    expect(cacheStore.get(prerenderCacheKey(new Request("http://x/blog/hello"), cfg))).toBeDefined();
    expect(cacheStore.get(prerenderCacheKey(new Request("http://x/alias"), cfg))).toBeUndefined();
  });

  it("a GET on a ppr-flagged route with no matching seed is a clean 404, not a crash", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "opaque-state-1" } });
    const state = newTestState(cfg);
    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(res.status).toBe(404);
  });
});

// Minimal mode writes s-maxage for the platform to read. A shared cache that
// ignores Vary would otherwise store flight data at the page's URL.
describe("forwarded flight data", () => {
  const flight = (cacheControl: string) => stubResolver(async () => new Response("flight", { headers: { "content-type": "text/x-component", "cache-control": cacheControl } }));

  it("is private on an ISR route, with no s-maxage", async () => {
    const cfg = testPrerenderConfig();
    const state = newTestState(cfg, flight("s-maxage=31536000"));
    const res = await handlePrerender(state, new Request("http://x/blog/hello?_rsc=abc", { headers: { rsc: "1" } }), prerenderDecision(cfg));
    expect(res.headers.get("cache-control")).toBe("private");
  });

  it("is private on a static prefetch of a PPR route, with no s-maxage", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "s" } });
    const state = await pprState(cfg, flight("s-maxage=31536000"));
    const request = new Request("http://x/blog/hello?_rsc=abc", { headers: { rsc: "1", "next-router-prefetch": "1" } });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.headers.get("cache-control")).toBe("private");
  });

  it("keeps a no-store the function asked for", async () => {
    const cfg = testPrerenderConfig();
    const state = newTestState(cfg, flight("private, no-cache, no-store, max-age=0, must-revalidate"));
    const res = await handlePrerender(state, new Request("http://x/blog/hello?_rsc=abc", { headers: { rsc: "1" } }), prerenderDecision(cfg));
    expect(res.headers.get("cache-control")).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
  });

  it("leaves a server action's answer as the function wrote it", async () => {
    const cfg = testPrerenderConfig({ "x-nbo-ppr": { postponedState: "s" } });
    const state = await pprState(cfg, flight("no-cache"));
    const request = new Request("http://x/blog/hello", { method: "POST", headers: { rsc: "1", "next-action": "abc" }, body: "[]" });
    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("handlePrerender and RSC requests", () => {
  // The function answers like Next: flight data for rsc, a page otherwise.
  function nextLike(calls: Request[]): Resolver {
    return stubResolver(async (req) => {
      calls.push(req);
      return req.headers.get("rsc") === "1"
        ? new Response("flight", { headers: { "content-type": "text/x-component" } })
        : new Response("<html>page</html>", { headers: { "content-type": "text/html" } });
    });
  }
  const rscRequest = () => new Request("http://x/blog/hello?_rsc=abc", { headers: { rsc: "1" } });
  const plainRequest = () => new Request("http://x/blog/hello");

  it("onMiss: blocking: an rsc request goes to the function and leaves the cache alone, so the next plain GET gets HTML", async () => {
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    const calls: Request[] = [];
    const state = newTestState(cfg, nextLike(calls), () => createFakeCacheService(cacheStore));

    const rsc = await handlePrerender(state, rscRequest(), prerenderDecision(cfg));
    expect(await rsc.text()).toBe("flight");
    expect(cacheStore.get(prerenderCacheKey(plainRequest(), cfg))).toBeUndefined();

    const page = await handlePrerender(state, plainRequest(), prerenderDecision(cfg));
    expect(page.headers.get("content-type")).toBe("text/html");
    expect(await page.text()).toBe("<html>page</html>");
  });

  it("an rsc request never reads a cached page", async () => {
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    const calls: Request[] = [];
    const state = newTestState(cfg, nextLike(calls), () => createFakeCacheService(cacheStore));

    await (await handlePrerender(state, plainRequest(), prerenderDecision(cfg))).text();
    const rsc = await handlePrerender(state, rscRequest(), prerenderDecision(cfg));
    expect(rsc.headers.get("content-type")).toBe("text/x-component");
    expect(await rsc.text()).toBe("flight");
  });

  it("onMiss: shell: an rsc request gets flight data, no seed and no regeneration", async () => {
    const cfg = testPrerenderConfig({ onMiss: "shell" });
    const cacheStore = createStore();
    const calls: Request[] = [];
    const state = await pprState(cfg, nextLike(calls), "seed", () => createFakeCacheService(cacheStore));
    let regens = 0;
    state.onRegenDone = () => regens++;

    const rsc = await handlePrerender(state, rscRequest(), prerenderDecision(cfg));
    expect(await rsc.text()).toBe("flight");
    expect(regens).toBe(0);
    expect(cacheStore.get(prerenderCacheKey(plainRequest(), cfg))).toBeUndefined();
  });

  it("a stale entry: an rsc request doesn't trigger the regeneration", async () => {
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    const calls: Request[] = [];
    const state = newTestState(cfg, nextLike(calls), () => createFakeCacheService(cacheStore));
    const key = prerenderCacheKey(plainRequest(), cfg);
    cacheStore.set(key, { body: new TextEncoder().encode("stale page"), header: {} }, 0, 3600);
    let regens = 0;
    state.onRegenDone = () => regens++;

    await (await handlePrerender(state, rscRequest(), prerenderDecision(cfg))).text();
    expect(regens).toBe(0);
    expect(new TextDecoder().decode(cacheStore.get(key)!.entry.body)).toBe("stale page");
  });

  it("a render stored for every visitor carries no router or action headers", async () => {
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    const calls: Request[] = [];
    const state = newTestState(cfg, nextLike(calls), () => createFakeCacheService(cacheStore));
    const request = new Request("http://x/blog/hello", {
      headers: {
        rsc: "0",
        "next-router-state-tree": "tree",
        "next-router-prefetch": "1",
        "next-router-segment-prefetch": "/x",
        "next-url": "/from",
        "next-action": "evil",
        "next-hmr-refresh": "1",
      },
    });
    await (await handlePrerender(state, request, prerenderDecision(cfg))).text();
    for (const h of ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url", "next-action", "next-hmr-refresh"]) {
      expect(calls[0]!.headers.has(h), h).toBe(false);
    }
  });

  it("varies cached and seed answers on the headers that select an RSC answer", async () => {
    const cfg = testPrerenderConfig({ onMiss: "shell" });
    const cacheStore = createStore();
    const state = await pprState(cfg, nextLike([]), "seed", () => createFakeCacheService(cacheStore));
    const seed = await handlePrerender(state, plainRequest(), prerenderDecision(cfg));
    expect(seed.headers.get("vary")).toBe("rsc, next-router-state-tree, next-router-prefetch");

    cacheStore.set(prerenderCacheKey(plainRequest(), cfg), { body: new TextEncoder().encode("page"), header: { vary: ["accept, RSC"] } }, 60, 3600);
    const cached = await handlePrerender(state, plainRequest(), prerenderDecision(cfg));
    expect(cached.headers.get("vary")).toBe("accept, RSC, next-router-state-tree, next-router-prefetch");
  });
});

describe("prerenderCacheKey", () => {
  it("is unaffected by a query param not in allowQuery", () => {
    const cfg = testPrerenderConfig({ allowQuery: ["page"] });
    const a = prerenderCacheKey(new Request("http://x/blog/hello?other=1"), cfg);
    const b = prerenderCacheKey(new Request("http://x/blog/hello?other=2"), cfg);
    expect(a).toBe(b);
  });

  it("changes when a listed allowQuery param's value changes", () => {
    const cfg = testPrerenderConfig({ allowQuery: ["page"] });
    const a = prerenderCacheKey(new Request("http://x/blog/hello?page=1"), cfg);
    const b = prerenderCacheKey(new Request("http://x/blog/hello?page=2"), cfg);
    expect(a).not.toBe(b);
  });

  it("changes when a listed varyHeaders header's value changes", () => {
    const cfg = testPrerenderConfig({ varyHeaders: ["x-locale"] });
    const a = prerenderCacheKey(new Request("http://x/blog/hello", { headers: { "x-locale": "en" } }), cfg);
    const b = prerenderCacheKey(new Request("http://x/blog/hello", { headers: { "x-locale": "fr" } }), cfg);
    expect(a).not.toBe(b);
  });

  // Final-review finding I1: Request.url.pathname stays percent-
  // encoded for non-ASCII characters (confirmed directly:
  // new URL("http://x/blog/café").pathname is "/blog/caf%C3%A9"), but
  // Go's own r.URL.Path is already fully decoded — the hash input
  // must use the decoded form to match, not silently fragment the
  // cache between a client that sends one encoding style and another.
  it("hashes the fully-decoded path, not the percent-encoded one", () => {
    const cfg = testPrerenderConfig({ match: "^/blog/café$" });
    const got = prerenderCacheKey(new Request("http://x/blog/café"), cfg);
    const expected = createHash("sha256").update("path:/blog/café").digest("base64url");
    expect(got).toBe(expected);
  });
});

describe("handleRevalidate", () => {
  it("a missing bearer token is a clean 401, never reaching the cache service", async () => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    let cacheServiceCalled = false;
    const cfg = testPrerenderConfig();
    const resolveCache: Resolver = () => async () => {
      cacheServiceCalled = true;
      return new Response(null, { status: 204 });
    };
    const state = newTestState(cfg, undefined, resolveCache);
    const res = await handleRevalidate(state, new Request("http://x/_nbo/revalidate", { method: "POST", body: JSON.stringify({ tags: ["blog"] }) }));
    expect(res.status).toBe(401);
    expect(cacheServiceCalled).toBe(false);
  });

  it("a wrong bearer token is a clean 401", async () => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    const cfg = testPrerenderConfig();
    const state = newTestState(cfg, undefined, () => async () => new Response(null, { status: 204 }));
    const res = await handleRevalidate(
      state,
      new Request("http://x/_nbo/revalidate", { method: "POST", headers: { authorization: "Bearer wrong" }, body: JSON.stringify({ tags: ["blog"] }) }),
    );
    expect(res.status).toBe(401);
  });

  it("the correct token forwards the request body to the cache service's own /invalidate", async () => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    const cfg = testPrerenderConfig();
    const cacheStore = createStore();
    cacheStore.set("k1", { body: new Uint8Array(), tags: ["blog"] }, 10, 10);
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = newTestState(cfg, undefined, resolveCache);

    const res = await handleRevalidate(
      state,
      new Request("http://x/_nbo/revalidate", {
        method: "POST",
        headers: { authorization: "Bearer secret-bypass" },
        body: JSON.stringify({ tags: ["blog"] }),
      }),
    );
    expect(res.status).toBe(204);
    expect(cacheStore.get("k1")).toBeUndefined();
  });

  it.each([["[]"], ['["blog"]'], ["null"], ['"blog"']])("a body of %s is a 400, never reaching the cache service", async (body) => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    let cacheServiceCalled = false;
    const cfg = testPrerenderConfig();
    const resolveCache: Resolver = () => async () => {
      cacheServiceCalled = true;
      return new Response(null, { status: 204 });
    };
    const state = newTestState(cfg, undefined, resolveCache);
    const res = await handleRevalidate(state, new Request("http://x/_nbo/revalidate", { method: "POST", headers: { authorization: "Bearer secret-bypass" }, body }));
    expect(res.status).toBe(400);
    expect(cacheServiceCalled).toBe(false);
  });
});

// settledWithin reports whether p settles within ms of real time.
async function settledWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("production ISR: content-id keys and cache failures", () => {
  it("a scoped key is the content id, a dot, then the unscoped hash", () => {
    const cfg = testPrerenderConfig();
    const request = new Request("http://x/blog/hello");
    const key = prerenderCacheKey(request, cfg, "abc");
    expect(key.startsWith("abc.")).toBe(true);
    expect(key).toBe(`abc.${prerenderCacheKey(request, cfg)}`);
  });

  it("the new build never serves a page the old build stored in the shared cache", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    const cacheStore = createStore();
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const stateA = newTestState(cfg, stubResolver(async () => new Response("old build page")), resolveCache);
    stateA.deploymentId = "A";
    let bCalls = 0;
    const stateB = newTestState(
      cfg,
      stubResolver(async () => {
        bCalls++;
        return new Response("new build page");
      }),
      resolveCache,
    );
    stateB.deploymentId = "B";

    const resA = await handlePrerender(stateA, new Request("http://x/blog/x"), prerenderDecision(cfg));
    expect(await resA.text()).toBe("old build page");
    const keyA = prerenderCacheKey(new Request("http://x/blog/x"), cfg, "A");
    await waitFor(() => cacheStore.get(keyA) !== undefined);

    const resB = await handlePrerender(stateB, new Request("http://x/blog/x"), prerenderDecision(cfg));
    expect(await resB.text()).toBe("new build page");
    expect(bCalls).toBe(1);
  });

  it("a cache handler that throws is a miss: the function's page, 200", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    const resolveCache: Resolver = () => async () => {
      throw new Error("cache unreachable");
    };
    const state = newTestState(cfg, stubResolver(async () => new Response("rendered")), resolveCache);
    state.deploymentId = "A";

    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("rendered");
  });

  it("a cache answering 500 is a miss", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    const resolveCache: Resolver = () => async () => new Response("boom", { status: 500 });
    const state = newTestState(cfg, stubResolver(async () => new Response("rendered")), resolveCache);

    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("rendered");
  });

  it("a cache read that never answers is a miss after 2 s: the page arrives within 2.5 s", async () => {
    vi.useFakeTimers();
    try {
      const cfg = testPrerenderConfig({ onMiss: "blocking" });
      const resolveCache: Resolver = () => () => new Promise<Response>(() => {});
      const state = newTestState(cfg, stubResolver(async () => new Response("rendered")), resolveCache);

      let settled: Response | undefined;
      void handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg)).then((r) => (settled = r));
      await vi.advanceTimersByTimeAsync(1900);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBeDefined();
      expect(settled!.status).toBe(200);
      expect(await settled!.text()).toBe("rendered");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cache PUT that never answers doesn't delay a blocking answer", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    let putSeen = false;
    const resolveCache: Resolver = () => async (request: Request) => {
      if (request.method === "PUT") {
        putSeen = true;
        return new Promise<Response>(() => {});
      }
      return new Response(null, { status: 404 });
    };
    const state = newTestState(cfg, stubResolver(async () => new Response("rendered")), resolveCache);

    const answer = handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(await settledWithin(answer, 500)).toBe(true);
    expect(await (await answer).text()).toBe("rendered");
    expect(putSeen).toBe(true);
  });

  it("a cache PUT that rejects is ignored", async () => {
    const cfg = testPrerenderConfig({ onMiss: "blocking" });
    const resolveCache: Resolver = () => async (request: Request) => {
      if (request.method === "PUT") throw new Error("cache down");
      return new Response(null, { status: 404 });
    };
    const state = newTestState(cfg, stubResolver(async () => new Response("rendered")), resolveCache);

    const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("rendered");
  });

  it("the stale and shell paths read and write under the content-id key", async () => {
    const cfg = testPrerenderConfig({ onMiss: "shell" });
    const cacheStore = createStore();
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = await pprState(cfg, stubResolver(async () => new Response("regenerated")), "seed", resolveCache);
    state.deploymentId = "A";
    let regenKey: string | undefined;
    state.onRegenDone = (k) => (regenKey = k);
    const request = new Request("http://x/blog/hello");
    const keyA = prerenderCacheKey(request, cfg, "A");

    const res = await handlePrerender(state, request, prerenderDecision(cfg));
    expect(await res.text()).toBe("seed");
    await waitFor(() => regenKey === keyA);
    expect(new TextDecoder().decode(cacheStore.get(keyA)!.entry.body)).toBe("regenerated");

    cacheStore.set(keyA, { body: new TextEncoder().encode("stale A") }, 0, cfg.expireSec);
    regenKey = undefined;
    const res2 = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
    expect(await res2.text()).toBe("stale A");
    await waitFor(() => regenKey === keyA);
  });
});

describe("production ISR: a cache that accepts and never answers", () => {
  // hungCache answers reads with 404 and never answers a write or an
  // invalidation.
  const hungCache: Resolver = () => async (request: Request) => {
    if (request.method === "GET") return new Response(null, { status: 404 });
    return new Promise<Response>(() => {});
  };

  it("a hung write is given up after 5 s", async () => {
    vi.useFakeTimers();
    try {
      const cfg = testPrerenderConfig({ onMiss: "blocking" });
      const state = newTestState(cfg, stubResolver(async () => new Response("rendered")), hungCache);
      const before = backgroundWrites.inFlight;
      const res = await handlePrerender(state, new Request("http://x/blog/hung"), prerenderDecision(cfg));
      expect(await res.text()).toBe("rendered");
      await vi.advanceTimersByTimeAsync(0);
      expect(backgroundWrites.inFlight).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(backgroundWrites.inFlight).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("background writes beyond the cap are skipped and counted, not queued", async () => {
    vi.useFakeTimers();
    try {
      const cfg = testPrerenderConfig({ onMiss: "blocking" });
      const state = newTestState(cfg, stubResolver(async () => new Response("rendered")), hungCache);
      const startInFlight = backgroundWrites.inFlight;
      const startSkipped = backgroundWrites.skipped;
      const total = BACKGROUND_WRITE_LIMIT + 6;
      for (let i = 0; i < total; i++) {
        const res = await handlePrerender(state, new Request(`http://x/blog/p${i}`), prerenderDecision(cfg));
        expect(res.status).toBe(200);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(backgroundWrites.inFlight).toBe(BACKGROUND_WRITE_LIMIT);
      expect(backgroundWrites.skipped - startSkipped).toBe(total - (BACKGROUND_WRITE_LIMIT - startInFlight));
      await vi.advanceTimersByTimeAsync(5000);
      expect(backgroundWrites.inFlight).toBe(startInFlight);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hung write during a regeneration releases the page for the next one", async () => {
    vi.useFakeTimers();
    try {
      const cfg = testPrerenderConfig({ onMiss: "shell" });
      const state = await pprState(cfg, stubResolver(async () => new Response("regenerated")), "seed", hungCache);
      let done = false;
      state.onRegenDone = () => (done = true);

      const res = await handlePrerender(state, new Request("http://x/blog/hello"), prerenderDecision(cfg));
      expect(await res.text()).toBe("seed");
      await vi.advanceTimersByTimeAsync(0);
      expect(state.regenInFlight.size).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).toBe(true);
      expect(state.regenInFlight.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a revalidation the cache never answers is a 502 after 5 s", async () => {
    vi.useFakeTimers();
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    try {
      const cfg = testPrerenderConfig();
      const state = newTestState(cfg, undefined, hungCache);
      let settled: Response | undefined;
      void handleRevalidate(state, new Request("http://x/_nbo/revalidate", { method: "POST", headers: { authorization: "Bearer secret-bypass" }, body: JSON.stringify({ tags: ["a"] }) })).then((r) => (settled = r));
      await vi.advanceTimersByTimeAsync(4900);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200);
      expect(settled?.status).toBe(502);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a revalidation whose cache call throws is a 502, not a rejection", async () => {
    process.env.TEST_NBO_PRERENDER_BYPASS = "secret-bypass";
    const cfg = testPrerenderConfig();
    const state = newTestState(cfg, undefined, () => async () => {
      throw new Error("cache down");
    });
    const res = await handleRevalidate(state, new Request("http://x/_nbo/revalidate", { method: "POST", headers: { authorization: "Bearer secret-bypass" }, body: JSON.stringify({ paths: ["/x"] }) }));
    expect(res.status).toBe(502);
  });
});
