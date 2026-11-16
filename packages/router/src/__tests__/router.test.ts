// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createRouter } from "../router.js";
import type { StaticExists, MiddlewareInvoker, HeaderOp } from "../router.js";
import type { Rule } from "../rule.js";

function staticSet(...paths: string[]): StaticExists {
  const set = new Set(paths);
  return (p) => set.has(p);
}

// noMiddleware fails any test that reaches it loudly — every
// pre-existing test fixture in this file has no middleware rule, so
// the invoker must never actually be called for any of them (this
// plan's own Review Focus: middleware support must be strictly
// additive).
const noMiddleware: MiddlewareInvoker = (fn) => {
  throw new Error("unexpected middleware invocation: " + fn);
};

function chainRules(n: number): Rule[] {
  const rules: Rule[] = [];
  for (let i = 0; i < n; i++) {
    rules.push({ id: `hop${i}`, match: { path: `^/r${i}$` }, action: { type: "rewrite", path: `/r${i + 1}` } });
  }
  return rules;
}

describe("route", () => {
  it("matches a prerender route before the implicit filesystem check", async () => {
    const rt = createRouter(
      { version: 1, prerenders: [{ id: "blog-detail", matchPath: "^/blog/(?P<slug>[^/]+)$", functionName: "ssr" }] },
      "never",
    );
    // staticSet("/blog/hello") simulates a seeded page already present
    // in static.index.json — proving the prerender check runs first,
    // "so seeded ISR pages never bypass their cache" (docs/nbo-spec.md:251).
    const dec = await rt.route("/blog/hello", "GET", staticSet("/blog/hello"), noMiddleware);
    expect(dec.kind).toBe("prerender");
    expect(dec.prerenderRoute?.id).toBe("blog-detail");
  });

  it("records the path a prerender route matched", async () => {
    const rt = createRouter(
      { version: 1, prerenders: [{ id: "blog-detail", matchPath: "^/blog/(?P<slug>[^/]+)$", functionName: "ssr" }] },
      "never",
    );
    const dec = await rt.route("/blog/hello", "GET", staticSet(), noMiddleware);
    expect(dec.prerenderPath).toBe("/blog/hello");
  });

  // A seed is also a static file, so without this a rewrite onto a seeded
  // route would serve the raw seed: for PPR, a shell that never finishes.
  for (const phase of ["beforeFiles", "afterFiles", "fallback"] as const) {
    it(`a ${phase} rewrite onto a seeded prerender route is that route, not its static seed`, async () => {
      const rt = createRouter(
        {
          version: 1,
          [phase]: [{ id: "alias", match: { path: "^/alias$" }, action: { type: "rewrite", path: "/blog/hello" } }],
          prerenders: [{ id: "blog-detail", matchPath: "^/blog/(?P<slug>[^/]+)$", functionName: "ssr" }],
        },
        "never",
      );
      const dec = await rt.route("/alias", "GET", staticSet("/blog/hello"), noMiddleware);
      expect(dec.kind).toBe("prerender");
      expect(dec.prerenderRoute?.id).toBe("blog-detail");
      expect(dec.prerenderPath).toBe("/blog/hello");
    });

    it(`a ${phase} rewrite onto an unseeded prerender route is that route`, async () => {
      const rt = createRouter(
        {
          version: 1,
          [phase]: [{ id: "alias", match: { path: "^/alias$" }, action: { type: "rewrite", path: "/blog/hello" } }],
          prerenders: [{ id: "blog-detail", matchPath: "^/blog/(?P<slug>[^/]+)$", functionName: "ssr" }],
        },
        "never",
      );
      const dec = await rt.route("/alias", "GET", staticSet(), noMiddleware);
      expect(dec.kind).toBe("prerender");
      expect(dec.prerenderPath).toBe("/blog/hello");
    });
  }

  it("a middleware rewrite onto a seeded prerender route keeps the middleware's header ops", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [
          { id: "mw", match: { path: "^/alias$" }, action: { type: "middleware", function: "middleware" } },
        ],
        prerenders: [{ id: "blog-detail", matchPath: "^/blog/(?P<slug>[^/]+)$", functionName: "ssr" }],
      },
      "never",
    );
    const invoke: MiddlewareInvoker = () => ({
      continue: true,
      rewritePath: "/blog/hello",
      mergeHeaders: [{ set: { "x-mw": "1" } }],
    });
    const dec = await rt.route("/alias", "GET", staticSet("/blog/hello"), invoke);
    expect(dec.kind).toBe("prerender");
    expect(dec.prerenderPath).toBe("/blog/hello");
    expect(dec.headerOps).toEqual([{ set: { "x-mw": "1" } }]);
  });

  it("a non-matching path still reaches the implicit filesystem check", async () => {
    const rt = createRouter(
      { version: 1, prerenders: [{ id: "blog-detail", matchPath: "^/blog/(?P<slug>[^/]+)$", functionName: "ssr" }] },
      "never",
    );
    const dec = await rt.route("/about", "GET", staticSet("/about"), noMiddleware);
    expect(dec.kind).toBe("serve");
  });

  it("a direct static hit serves", async () => {
    const rt = createRouter({ version: 1 }, "never");
    const dec = await rt.route("/", "GET", staticSet("/"), noMiddleware);
    expect(dec.kind).toBe("serve");
    expect(dec.staticPath).toBe("/");
  });

  it("a beforeFiles redirect ends routing even if the static path exists", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [
          {
            id: "old-docs",
            match: { path: "^/docs/v1/(?P<rest>.*)$" },
            action: { type: "redirect", location: "/docs/$rest", status: 308 },
          },
        ],
      },
      "never",
    );
    const dec = await rt.route("/docs/v1/intro", "GET", staticSet("/docs/v1/intro"), noMiddleware);
    expect(dec.kind).toBe("redirect");
    expect(dec.redirectLocation).toBe("/docs/intro");
    expect(dec.redirectStatus).toBe(308);
  });

  it("a fallback rewrite serves index for a deep link", async () => {
    const rt = createRouter(
      {
        version: 1,
        fallback: [
          {
            id: "spa-fallback",
            match: { path: "^/", pathNot: "\\.[A-Za-z0-9]+$" },
            action: { type: "rewrite", path: "/" },
          },
        ],
      },
      "never",
    );
    const dec = await rt.route("/settings/profile", "GET", staticSet("/"), noMiddleware);
    expect(dec.kind).toBe("serve");
    expect(dec.staticPath).toBe("/");
  });

  it("a fallback rewrite miss still gives a clean NotFound", async () => {
    const rt = createRouter(
      {
        version: 1,
        fallback: [
          {
            id: "spa-fallback",
            match: { path: "^/", pathNot: "\\.[A-Za-z0-9]+$" },
            action: { type: "rewrite", path: "/" },
          },
        ],
      },
      "never",
    );
    const dec = await rt.route("/settings/profile", "GET", staticSet(), noMiddleware);
    expect(dec.kind).toBe("notFound");
  });

  it("a missing asset still 404s even with a fallback rule", async () => {
    const rt = createRouter(
      {
        version: 1,
        fallback: [
          {
            id: "spa-fallback",
            match: { path: "^/", pathNot: "\\.[A-Za-z0-9]+$" },
            action: { type: "rewrite", path: "/" },
          },
        ],
      },
      "never",
    );
    const dec = await rt.route("/assets/missing.js", "GET", staticSet("/"), noMiddleware);
    expect(dec.kind).toBe("notFound");
  });

  it("onMatch headers apply to a static hit", async () => {
    const rt = createRouter(
      {
        version: 1,
        onMatch: [
          {
            id: "blog-cache",
            match: { path: "^/blog/" },
            action: { type: "headers", set: { "cdn-cache-control": "max-age=60" } },
            continue: true,
          },
        ],
      },
      "never",
    );
    const dec = await rt.route("/blog/hello", "GET", staticSet("/blog/hello"), noMiddleware);
    expect(dec.kind).toBe("serve");
    expect(dec.headerOps).toHaveLength(1);
    expect(dec.headerOps?.[0]!.set?.["cdn-cache-control"]).toBe("max-age=60");
  });

  it("a rewrite loop stops at eight with LoopDetected", async () => {
    const rt = createRouter(
      {
        version: 1,
        fallback: [
          { id: "bounce", match: { path: "^/a$" }, action: { type: "rewrite", path: "/b" } },
          { id: "bounce2", match: { path: "^/b$" }, action: { type: "rewrite", path: "/a" } },
        ],
      },
      "never",
    );
    const dec = await rt.route("/a", "GET", staticSet(), noMiddleware);
    expect(dec.kind).toBe("loopDetected");
  });

  it("exactly eight distinct rewrites serves", async () => {
    const rt = createRouter({ version: 1, fallback: chainRules(8) }, "never");
    const dec = await rt.route("/r0", "GET", staticSet("/r8"), noMiddleware);
    expect(dec.kind).toBe("serve");
    expect(dec.staticPath).toBe("/r8");
  });

  it("nine distinct rewrites trips LoopDetected", async () => {
    const rt = createRouter({ version: 1, fallback: chainRules(9) }, "never");
    const dec = await rt.route("/r0", "GET", staticSet(), noMiddleware);
    expect(dec.kind).toBe("loopDetected");
  });

  // Final review: every existing rewrite-cap test exercises only the
  // fallback phase, so a routeRequest that created a fresh {count:0}
  // per phase (rather than one object shared across all three
  // drivePhase calls) would still pass them. These two tests span
  // beforeFiles + afterFiles + fallback in one request to prove the
  // cap really is a single request-wide total: 1 + 1 + 6 = 8 must
  // serve, 1 + 1 + 7 = 9 must LoopDetected.
  it("the rewrite cap is a single total shared across beforeFiles+afterFiles+fallback: 8 serves", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [{ id: "b", match: { path: "^/start$" }, action: { type: "rewrite", path: "/mid" } }],
        afterFiles: [{ id: "a", match: { path: "^/mid$" }, action: { type: "rewrite", path: "/r0" } }],
        fallback: chainRules(6),
      },
      "never",
    );
    const dec = await rt.route("/start", "GET", staticSet("/r6"), noMiddleware);
    expect(dec.kind).toBe("serve");
    expect(dec.staticPath).toBe("/r6");
  });

  it("the rewrite cap is a single total shared across beforeFiles+afterFiles+fallback: 9 trips LoopDetected", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [{ id: "b", match: { path: "^/start$" }, action: { type: "rewrite", path: "/mid" } }],
        afterFiles: [{ id: "a", match: { path: "^/mid$" }, action: { type: "rewrite", path: "/r0" } }],
        fallback: chainRules(7),
      },
      "never",
    );
    // No "/r7" in the static set, deliberately — ruling out "this is
    // just an ordinary 404" as an alternative explanation, the same
    // way the original NineDistinctRewritesTripsLoopDetected test
    // does; the cap must trip before staticExists is even checked.
    const dec = await rt.route("/start", "GET", staticSet(), noMiddleware);
    expect(dec.kind).toBe("loopDetected");
  });

  it("a fallback header rule does not duplicate across retries", async () => {
    const rt = createRouter(
      {
        version: 1,
        fallback: [
          {
            id: "cache-header",
            match: { path: "^/" },
            action: { type: "headers", set: { "x-foo": "bar" } },
            continue: true,
          },
          { id: "hop1", match: { path: "^/deep$" }, action: { type: "rewrite", path: "/mid" } },
          { id: "hop2", match: { path: "^/mid$" }, action: { type: "rewrite", path: "/" } },
        ],
      },
      "never",
    );
    const dec = await rt.route("/deep", "GET", staticSet("/"), noMiddleware);
    expect(dec.kind).toBe("serve");
    expect(dec.staticPath).toBe("/");
    expect(dec.headerOps).toHaveLength(1);
    expect(dec.headerOps?.[0]!.set?.["x-foo"]).toBe("bar");
  });

  it("header ops from different rules with the same id both apply", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [
          {
            id: "security-headers",
            match: { path: "^/" },
            action: { type: "headers", set: { "x-frame-options": "DENY" } },
            continue: true,
          },
        ],
        onMatch: [
          {
            id: "security-headers",
            match: { path: "^/" },
            action: { type: "headers", set: { "cdn-cache-control": "max-age=60" } },
            continue: true,
          },
        ],
      },
      "never",
    );
    const dec = await rt.route("/", "GET", staticSet("/"), noMiddleware);
    expect(dec.kind).toBe("serve");
    expect(dec.headerOps).toHaveLength(2);
    expect(dec.headerOps?.[0]!.set?.["x-frame-options"]).toBe("DENY");
    expect(dec.headerOps?.[1]!.set?.["cdn-cache-control"]).toBe("max-age=60");
  });

  it("rewrite to a function ends routing with a Function decision", async () => {
    const rt = createRouter(
      { version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] },
      "never",
    );
    const dec = await rt.route("/", "GET", () => false, noMiddleware);
    expect(dec.kind).toBe("function");
    expect(dec.functionName).toBe("ssr");
  });

  it("a function rewrite never checks the filesystem more than once", async () => {
    let calls = 0;
    const rt = createRouter(
      { version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] },
      "never",
    );
    await rt.route(
      "/",
      "GET",
      () => {
        calls++;
        return true;
      },
      noMiddleware,
    );
    expect(calls).toBe(1); // only the one implicit filesystem check before afterFiles runs
  });

  it("no matching function route still gives NotFound", async () => {
    const rt = createRouter(
      {
        version: 1,
        afterFiles: [{ id: "ssr", match: { path: "^/known$" }, action: { type: "rewrite", function: "ssr" } }],
      },
      "never",
    );
    const dec = await rt.route("/unknown", "GET", () => false, noMiddleware);
    expect(dec.kind).toBe("notFound");
  });

  // Guards against a gap middleware's own rewrite support exposed: a
  // beforeFiles rewrite.path rule changes the path *before* a later
  // phase's rule dispatches that new path to a function — the same
  // property the middleware rewrite test below pins, but via an
  // ordinary (non-middleware) rewrite.path rule, proving this isn't
  // specific to middleware's own code path in runPhase.
  it("a plain path rewrite to a function carries the rewritten functionPath", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [{ id: "redirect-old", match: { path: "^/old$" }, action: { type: "rewrite", path: "/new" } }],
        afterFiles: [{ id: "ssr", match: { path: "^/new$" }, action: { type: "rewrite", function: "ssr" } }],
      },
      "never",
    );
    const dec = await rt.route("/old", "GET", staticSet(), noMiddleware);
    expect(dec.kind).toBe("function");
    expect(dec.functionName).toBe("ssr");
    expect(dec.functionPath).toBe("/new");
  });

  it("middleware next continues routing unchanged", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [{ id: "mw", match: { path: "^/" }, action: { type: "middleware", function: "middleware" } }],
        afterFiles: [{ id: "ssr", match: { path: "^/page$" }, action: { type: "rewrite", function: "ssr" } }],
      },
      "never",
    );
    let invoked = false;
    const dec = await rt.route("/page", "GET", staticSet(), (fn, path) => {
      invoked = true;
      expect(fn).toBe("middleware");
      expect(path).toBe("/page");
      return { continue: true };
    });
    expect(invoked).toBe(true);
    expect(dec.kind).toBe("function");
    expect(dec.functionName).toBe("ssr");
  });

  it("middleware rewrite continues with the new path", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [{ id: "mw", match: { path: "^/old$" }, action: { type: "middleware", function: "middleware" } }],
        afterFiles: [{ id: "ssr", match: { path: "^/new$" }, action: { type: "rewrite", function: "ssr" } }],
      },
      "never",
    );
    const dec = await rt.route("/old", "GET", staticSet(), () => ({ continue: true, rewritePath: "/new" }));
    expect(dec.kind).toBe("function");
    expect(dec.functionName).toBe("ssr");
    expect(dec.functionPath).toBe("/new");
  });

  it("a middleware final response ends routing without consulting later rules", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [{ id: "mw", match: { path: "^/" }, action: { type: "middleware", function: "middleware" } }],
        afterFiles: [{ id: "ssr", match: { path: "^/blocked$" }, action: { type: "rewrite", function: "ssr" } }],
      },
      "never",
    );
    const dec = await rt.route("/blocked", "GET", staticSet(), () => ({
      continue: false,
      response: { kind: "middlewareHandled", middlewareStatus: 403, middlewareBody: Buffer.from("nope") },
    }));
    expect(dec.kind).toBe("middlewareHandled");
    expect(dec.middlewareStatus).toBe(403);
    expect(dec.middlewareBody?.toString()).toBe("nope");
  });

  it("middleware merge headers always apply", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [{ id: "mw", match: { path: "^/" }, action: { type: "middleware", function: "middleware" } }],
      },
      "never",
    );
    const dec = await rt.route("/missing", "GET", staticSet(), () => ({
      continue: true,
      mergeHeaders: [{ set: { "Set-Cookie": "a=b" } }],
    }));
    expect(dec.headerOps).toHaveLength(1);
    expect(dec.headerOps?.[0]!.set?.["Set-Cookie"]).toBe("a=b");
  });

  // Guards against a real bug found running the real Cloud Run verify
  // script (per the Go source's own comment on this test): a
  // middleware response setting two Set-Cookie values must get both
  // of them onto the final decision, not just the last one —
  // HeaderOp.set is single-valued, so mergeHeaders must carry one
  // HeaderOp per value, not one HeaderOp whose set map collapses
  // repeated keys to their last write.
  it("middleware merge headers carry every value of a multi-valued header", async () => {
    const rt = createRouter(
      {
        version: 1,
        beforeFiles: [{ id: "mw", match: { path: "^/" }, action: { type: "middleware", function: "middleware" } }],
      },
      "never",
    );
    const mergeHeaders: HeaderOp[] = [{ append: { "Set-Cookie": "a=1" } }, { append: { "Set-Cookie": "b=2" } }];
    const dec = await rt.route("/missing", "GET", staticSet(), () => ({ continue: true, mergeHeaders }));
    expect(dec.headerOps).toHaveLength(2);
  });
});
