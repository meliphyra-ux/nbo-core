// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// entry-shim.mjs resolves dispatch.json/next-dispatch.json/route modules
// relative to its OWN location (see its `here`), not this test file's —
// so the fixtures below must land one level up, next to entry-shim.mjs
// itself, not in this __tests__ directory.
const here = join(dirname(fileURLToPath(import.meta.url)), "..");

beforeEach(() => {
  mkdirSync(join(here, "routes"));
  // Mimics the shape invoking-entrypoints.mdx documents: handler(req, res, ctx).
  writeFileSync(
    join(here, "routes", "home.js"),
    `exports.handler = async function (req, res) {
       if (req.url === "/stream") {
         res.writeHead(200);
         for (const chunk of ["chunk0", "chunk1", "chunk2"]) {
           res.write(chunk);
           await new Promise((r) => setTimeout(r, 50));
         }
         res.end();
         return;
       }
       res.writeHead(200, { "x-handled-by": "home" });
       res.end("home:" + req.url);
     };`,
  );
  writeFileSync(
    join(here, "dispatch.json"),
    JSON.stringify({ routes: { home: { pathname: "/" }, stream: { pathname: "/stream" } } }),
  );
  writeFileSync(join(here, "next-dispatch.json"), JSON.stringify({ home: "routes/home.js", stream: "routes/home.js" }));
});

afterEach(() => {
  rmSync(join(here, "routes"), { recursive: true, force: true });
  rmSync(join(here, "dispatch.json"), { force: true });
  rmSync(join(here, "next-dispatch.json"), { force: true });
});

describe("entry-shim", () => {
  it("loads next-dispatch.json's __setupNodeEnv module before handling any request", async () => {
    writeFileSync(join(here, "setup-node-env.js"), "globalThis.__NBO_TEST_SETUP_RAN = true;");
    writeFileSync(
      join(here, "next-dispatch.json"),
      JSON.stringify({ __setupNodeEnv: "setup-node-env.js", home: "routes/home.js", stream: "routes/home.js" }),
    );
    delete (globalThis as any).__NBO_TEST_SETUP_RAN;
    try {
      // Cache-busting query string: entry-shim.mjs is ESM-cached per
      // specifier, and the other tests in this file already imported the
      // plain "../entry-shim.mjs" specifier with different next-dispatch.json
      // content baked into that cached instance's closure.
      const { default: shim } = await import(`../entry-shim.mjs?setup-test`);
      await shim.fetch(new Request("http://x/"));
      expect((globalThis as any).__NBO_TEST_SETUP_RAN).toBe(true);
    } finally {
      delete (globalThis as any).__NBO_TEST_SETUP_RAN;
      rmSync(join(here, "setup-node-env.js"), { force: true });
    }
  });

  it("bridges a Fetch Request to the Next-style handler and back", async () => {
    const { default: shim } = await import("../entry-shim.mjs");
    const response = await shim.fetch(new Request("http://x/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-handled-by")).toBe("home");
    expect(await response.text()).toBe("home:/");
  });

  it("streams rather than buffers", async () => {
    const { default: shim } = await import("../entry-shim.mjs");
    const response = await shim.fetch(new Request("http://x/stream"));
    const reader = response.body!.getReader();
    const start = Date.now();
    const first = await reader.read();
    const firstAt = Date.now() - start;
    while (!(await reader.read()).done) {
      // drain the stream
    }
    const totalAt = Date.now() - start;
    expect(first.done).toBe(false);
    expect(firstAt).toBeLessThan(totalAt / 2);
  });

  it("returns 404 for a pathname with no dispatch entry", async () => {
    const { default: shim } = await import("../entry-shim.mjs");
    const response = await shim.fetch(new Request("http://x/does-not-exist"));
    expect(response.status).toBe(404);
  });

  // Real bug found running Slice 4's ISR verify script for real: Next's
  // own internal incremental cache (the same route-module render path
  // this shim calls into) serves ITS OWN stale-then-background-regen
  // behavior unless told this is an on-demand revalidation — so a
  // request this shim forwarded came back with the SAME stale body
  // across repeated calls, even past the page's revalidateSec, because
  // Next itself decided to serve from its own per-process cache rather
  // than truly re-rendering. Confirmed directly (a real next build's own
  // compiled route handler, called repeatedly outside this shim): adding
  // x-prerender-revalidate set to the build's own previewModeId (from
  // .next/prerender-manifest.json, already traced into every function's
  // bundle for Next's own internal preview-cookie validation) forces a
  // genuinely fresh render every time. NBO's own prerender.ts (the
  // platform's shared, cross-replica cache) is meant to be the sole ISR
  // cache authority — Next's own per-process one must never activate at
  // all, for any request, which is why this is set unconditionally here
  // rather than only for calls prerender.ts marks as a regeneration.
  it("always forces Next's own on-demand revalidation via x-prerender-revalidate", async () => {
    writeFileSync(
      join(here, "routes", "echo-prerender-revalidate.js"),
      `exports.handler = async function (req, res) {
         res.writeHead(200);
         res.end(String(req.headers["x-prerender-revalidate"]));
       };`,
    );
    writeFileSync(join(here, "dispatch.json"), JSON.stringify({ routes: { home: { pathname: "/" } } }));
    writeFileSync(join(here, "next-dispatch.json"), JSON.stringify({ home: "routes/echo-prerender-revalidate.js" }));
    mkdirSync(join(here, ".next"), { recursive: true });
    writeFileSync(
      join(here, ".next", "prerender-manifest.json"),
      JSON.stringify({ preview: { previewModeId: "test-preview-mode-id" } }),
    );
    try {
      const { default: shim } = await import("../entry-shim.mjs?prerender-revalidate-test");
      const response = await shim.fetch(new Request("http://x/"));
      expect(await response.text()).toBe("test-preview-mode-id");
    } finally {
      rmSync(join(here, "routes", "echo-prerender-revalidate.js"), { force: true });
      rmSync(join(here, ".next"), { recursive: true, force: true });
    }
  });

  // Real bug found reviewing PPR resume support: forcing
  // x-prerender-revalidate unconditionally (the test above) also makes
  // the compiled handler's own checkIsOnDemandRevalidate treat a PPR
  // resume request as an on-demand ISR revalidation, which discards
  // the real postponed state entirely (`let postponed =
  // !isOnDemandRevalidate && ... ? minimalPostponed : undefined` in
  // app-page-runtime.js) and falls back to a full fresh render instead
  // of resuming — confirmed directly (a real resume POST came back as
  // a complete second document, not a continuation fragment). A
  // next-resume request must never get this header at all.
  it("does not force x-prerender-revalidate on a next-resume request", async () => {
    writeFileSync(
      join(here, "routes", "echo-prerender-revalidate.js"),
      `exports.handler = async function (req, res) {
         res.writeHead(200);
         res.end(String(req.headers["x-prerender-revalidate"]));
       };`,
    );
    writeFileSync(join(here, "dispatch.json"), JSON.stringify({ routes: { home: { pathname: "/" } } }));
    writeFileSync(join(here, "next-dispatch.json"), JSON.stringify({ home: "routes/echo-prerender-revalidate.js" }));
    mkdirSync(join(here, ".next"), { recursive: true });
    writeFileSync(
      join(here, ".next", "prerender-manifest.json"),
      JSON.stringify({ preview: { previewModeId: "test-preview-mode-id" } }),
    );
    try {
      const { default: shim } = await import("../entry-shim.mjs?no-revalidate-on-resume-test");
      const response = await shim.fetch(
        new Request("http://x/", { method: "POST", headers: { "next-resume": "1" }, body: "postponed-state" }),
      );
      expect(await response.text()).toBe("undefined");
    } finally {
      rmSync(join(here, "routes", "echo-prerender-revalidate.js"), { force: true });
      rmSync(join(here, ".next"), { recursive: true, force: true });
    }
  });

  // Real bug found while implementing PPR resume support: the compiled
  // app-page handler only honors a next-resume request when it reads
  // request meta minimalMode as true (getRequestMeta(req,
  // 'minimalMode')), set from whatever this shim passes as ctx.requestMeta
  // -- confirmed directly by reading next/dist/build/templates/
  // app-page-runtime.js's own handler(req, res, ctx) { setRequestMeta(req,
  // ctx.requestMeta) } call.
  it("passes minimalMode: true in requestMeta so the compiled handler honors PPR resume requests", async () => {
    writeFileSync(
      join(here, "routes", "echo-request-meta.js"),
      `exports.handler = async function (req, res, ctx) {
         res.writeHead(200);
         res.end(JSON.stringify(ctx.requestMeta));
       };`,
    );
    writeFileSync(join(here, "dispatch.json"), JSON.stringify({ routes: { home: { pathname: "/" } } }));
    writeFileSync(join(here, "next-dispatch.json"), JSON.stringify({ home: "routes/echo-request-meta.js" }));
    try {
      const { default: shim } = await import("../entry-shim.mjs?request-meta-test");
      const response = await shim.fetch(new Request("http://x/"));
      const requestMeta = JSON.parse(await response.text());
      expect(requestMeta.minimalMode).toBe(true);
    } finally {
      rmSync(join(here, "routes", "echo-request-meta.js"), { force: true });
    }
  });

  // minimalMode keeps each rendered page in an in-memory response cache
  // for 10 seconds, even on an on-demand revalidation, unless the request
  // has an invocation id of its own (next/dist/server/response-cache).
  // Found running verify-slice4-isr-local.sh: without one, draft mode and
  // revalidation got the previous render back.
  it("gives every request its own x-invocation-id, whatever the caller sent", async () => {
    writeFileSync(
      join(here, "routes", "echo-invocation-id.js"),
      `exports.handler = async function (req, res) {
         res.writeHead(200);
         res.end(String(req.headers["x-invocation-id"]));
       };`,
    );
    writeFileSync(join(here, "dispatch.json"), JSON.stringify({ routes: { home: { pathname: "/" } } }));
    writeFileSync(join(here, "next-dispatch.json"), JSON.stringify({ home: "routes/echo-invocation-id.js" }));
    try {
      const { default: shim } = await import("../entry-shim.mjs?invocation-id-test");
      const ask = () =>
        shim
          .fetch(new Request("http://x/", { headers: { "x-invocation-id": "from-a-visitor" } }))
          .then((r: Response) => r.text());
      const [first, second] = [await ask(), await ask()];
      expect(first).not.toBe("undefined");
      expect(first).not.toBe("from-a-visitor");
      expect(first).not.toBe(second);
    } finally {
      rmSync(join(here, "routes", "echo-invocation-id.js"), { force: true });
    }
  });

  // A redirect is the app's answer to the visitor. Following it here
  // would serve the target's body under the original URL.
  it("passes a redirect through to the caller instead of following it", async () => {
    writeFileSync(
      join(here, "routes", "redirecting.js"),
      `exports.handler = async function (req, res) {
         if (req.url === "/target") {
           res.writeHead(200);
           res.end("followed");
           return;
         }
         res.writeHead(307, { location: "/target" });
         res.end();
       };`,
    );
    writeFileSync(
      join(here, "dispatch.json"),
      JSON.stringify({ routes: { home: { pathname: "/" }, target: { pathname: "/target" } } }),
    );
    writeFileSync(
      join(here, "next-dispatch.json"),
      JSON.stringify({ home: "routes/redirecting.js", target: "routes/redirecting.js" }),
    );
    try {
      const { default: shim } = await import("../entry-shim.mjs?redirect-test");
      const response = await shim.fetch(new Request("http://x/"));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("/target");
    } finally {
      rmSync(join(here, "routes", "redirecting.js"), { force: true });
    }
  });

  it("keeps every Set-Cookie across the loopback hop", async () => {
    writeFileSync(
      join(here, "routes", "cookies.js"),
      `exports.handler = async function (req, res) {
         res.writeHead(200, { "set-cookie": ["a=1; Path=/", "b=2; Path=/"] });
         res.end("ok");
       };`,
    );
    writeFileSync(join(here, "dispatch.json"), JSON.stringify({ routes: { home: { pathname: "/" } } }));
    writeFileSync(join(here, "next-dispatch.json"), JSON.stringify({ home: "routes/cookies.js" }));
    try {
      const { default: shim } = await import("../entry-shim.mjs?cookies-test");
      const response = await shim.fetch(new Request("http://x/"));
      expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    } finally {
      rmSync(join(here, "routes", "cookies.js"), { force: true });
    }
  });

  it("drops the loopback connection when the caller disconnects, so the render stops", async () => {
    writeFileSync(
      join(here, "routes", "hanging.js"),
      `exports.handler = async function (req, res) {
         res.on("close", () => { globalThis.__NBO_TEST_RENDER_CLOSED = res.writableFinished === false; });
         res.writeHead(200);
         res.write("first");
       };`,
    );
    writeFileSync(join(here, "dispatch.json"), JSON.stringify({ routes: { home: { pathname: "/" } } }));
    writeFileSync(join(here, "next-dispatch.json"), JSON.stringify({ home: "routes/hanging.js" }));
    delete (globalThis as any).__NBO_TEST_RENDER_CLOSED;
    try {
      const { default: shim } = await import("../entry-shim.mjs?disconnect-test");
      const caller = new AbortController();
      const response = await shim.fetch(new Request("http://x/", { signal: caller.signal }));
      await response.body!.getReader().read();
      caller.abort();
      await expect.poll(() => (globalThis as any).__NBO_TEST_RENDER_CLOSED, { timeout: 3000 }).toBe(true);
    } finally {
      delete (globalThis as any).__NBO_TEST_RENDER_CLOSED;
      rmSync(join(here, "routes", "hanging.js"), { force: true });
    }
  });

  it("handles two concurrent requests to different routes correctly", async () => {
    const { default: shim } = await import("../entry-shim.mjs");
    const [a, b] = await Promise.all([
      shim.fetch(new Request("http://x/")).then((r: Response) => r.text()),
      shim.fetch(new Request("http://x/")).then((r: Response) => r.text()),
    ]);
    expect(a).toBe("home:/");
    expect(b).toBe("home:/");
  });

  // The route module each of these serves: a file of its own, because a
  // module is cached by its path.
  function serveRoute(name: string, source: string): void {
    writeFileSync(join(here, "routes", name), source);
    writeFileSync(join(here, "dispatch.json"), JSON.stringify({ routes: { home: { pathname: "/" } } }));
    writeFileSync(join(here, "next-dispatch.json"), JSON.stringify({ home: `routes/${name}` }));
  }

  it("answers 500 when Next's handler throws, instead of leaving the caller waiting", async () => {
    serveRoute("handler-throws.js", `exports.handler = async function () { throw new Error("handler blew up"); };`);
    const { default: shim } = await import("../entry-shim.mjs?handler-throws");
    const res = await shim.fetch(new Request("http://x/", { signal: AbortSignal.timeout(2000) }));
    expect(res.status).toBe(500);
  });

  it("a route module that fails to load fails each request, and leaves the process up", async () => {
    serveRoute("bad-module.js", `throw new Error("bad module");`);
    const { default: shim } = await import("../entry-shim.mjs?bad-module");
    const first = await shim.fetch(new Request("http://x/", { signal: AbortSignal.timeout(2000) }));
    expect(first.status).toBe(500);
    const second = await shim.fetch(new Request("http://x/", { signal: AbortSignal.timeout(2000) }));
    expect(second.status).toBe(500);
  });

  it("resets the connection when Next's handler throws after it started answering", async () => {
    serveRoute(
      "late-throw.js",
      `exports.handler = async function (req, res) { res.writeHead(200); res.write("partial"); await new Promise((r) => setTimeout(r, 20)); throw new Error("late"); };`,
    );
    const { default: shim } = await import("../entry-shim.mjs?late-throw");
    const res = await shim.fetch(new Request("http://x/", { signal: AbortSignal.timeout(2000) }));
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });

  it("keeps Next's internal cache tags away from visitors", async () => {
    serveRoute(
      "cache-tags.js",
      `exports.handler = async function (req, res) { res.writeHead(200, { "x-next-cache-tags": "_N_T_/layout", "x-kept": "yes" }); res.end("ok"); };`,
    );
    const { default: shim } = await import("../entry-shim.mjs?cache-tags");
    const res = await shim.fetch(new Request("http://x/"));
    expect(res.headers.has("x-next-cache-tags")).toBe(false);
    expect(res.headers.get("x-kept")).toBe("yes");
  });
});
