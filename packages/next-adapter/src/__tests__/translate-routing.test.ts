// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { translateRoutes, translateMiddleware, translatePrerenders, assertSlice2Scope } from "../translate-routing.js";

describe("translateRoutes", () => {
  it("emits one exact-match afterFiles rule per app page/route, rewriting to the ssr function", () => {
    const rules = translateRoutes({
      appPages: [{ id: "page-/", pathname: "/" }],
      appRoutes: [{ id: "route-/api/hello", pathname: "/api/hello" }],
    });
    expect(rules).toEqual([
      { id: "page-/", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } },
      { id: "route-/api/hello", match: { path: "^/api/hello$" }, action: { type: "rewrite", function: "ssr" } },
    ]);
  });
});

describe("translateMiddleware", () => {
  it("builds one beforeFiles rule per matcher for nodejs-runtime middleware", () => {
    const rules = translateMiddleware([{ source: "/", sourceRegex: "^/$" }]);
    expect(rules).toEqual([
      { id: "middleware-0", match: { path: "^/$" }, action: { type: "middleware", function: "middleware" } },
    ]);
  });

  it("drops Next's own injected x-prerender-revalidate missing condition", () => {
    const rules = translateMiddleware([
      { source: "/", sourceRegex: "^/$", missing: [{ type: "header", key: "x-prerender-revalidate", value: "token" }] },
    ]);
    expect(rules).toEqual([
      { id: "middleware-0", match: { path: "^/$" }, action: { type: "middleware", function: "middleware" } },
    ]);
  });

  it("throws naming the matcher when a user-authored has/missing condition is present", () => {
    expect(() =>
      translateMiddleware([{ source: "/api", sourceRegex: "^/api$", has: [{ type: "header", key: "x-custom" }] }]),
    ).toThrow(/x-custom/);
  });
});

describe("translatePrerenders", () => {
  const baseEntry = {
    route: "blog",
    pathname: "/blog",
    groupId: "g1",
    fallback: { filePath: "blog.html", initialRevalidate: 300, initialExpiration: 86400 },
    config: { allowQuery: ["page"], allowHeader: ["accept-language"] },
  };

  it("maps one entry's field names per the adapter skeleton's own mapping", () => {
    const configs = translatePrerenders([baseEntry]);
    expect(configs).toEqual([
      {
        id: "/blog",
        match: "^/blog$",
        function: "ssr",
        revalidateSec: 300,
        expireSec: 86400,
        tags: ["group:g1"],
        seeds: { "/blog": { file: "/blog" } },
        onMiss: "blocking",
        allowQuery: ["page"],
        varyHeaders: ["accept-language"],
        bypassToken: { env: "NBO_PRERENDER_BYPASS" },
      },
    ]);
  });

  it("omits a seed entirely when the prerender has no fallback file", () => {
    const configs = translatePrerenders([
      { ...baseEntry, fallback: { initialRevalidate: 300, initialExpiration: 86400 } },
    ]);
    expect(configs[0].seeds).toEqual({});
  });

  it("filters out Next's own internal _not-found and _global-error prerenders", () => {
    const configs = translatePrerenders([{ ...baseEntry, pathname: "/_not-found", route: "not-found" }, baseEntry]);
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe("/blog");
  });

  it("derives id from pathname, not route — a real build emits one route shared by an HTML page and its .rsc data variant, as two distinct pathnames", () => {
    const configs = translatePrerenders([baseEntry, { ...baseEntry, pathname: "/blog.rsc" }]);
    expect(configs.map((c) => c.id)).toEqual(["/blog", "/blog.rsc"]);
  });

  it("filters Next's own internal revalidation-protocol headers out of varyHeaders — varying by them would fragment the cache on a token that changes per request", () => {
    const configs = translatePrerenders([
      {
        ...baseEntry,
        config: {
          ...baseEntry.config,
          allowHeader: [
            "host",
            "x-matched-path",
            "x-prerender-revalidate",
            "x-prerender-revalidate-if-generated",
            "x-next-revalidated-tags",
            "x-next-revalidate-tag-token",
            "accept-language",
          ],
        },
      },
    ]);
    expect(configs[0].varyHeaders).toEqual(["accept-language"]);
  });

  it("never writes the seed's real, absolute build-machine filesystem path into prerender.json (breaks determinism across builds/machines) — static.index.json is the authoritative file reference", () => {
    const configs = translatePrerenders([
      {
        ...baseEntry,
        fallback: { ...baseEntry.fallback, filePath: "C:\\Users\\someone\\repo\\.next\\server\\app\\blog.html" },
      },
    ]);
    expect(configs[0].seeds["/blog"].file).toBe("/blog");
  });

  it("throws naming the route when initialRevalidate is not a number (revalidate: false is not yet supported)", () => {
    expect(() =>
      translatePrerenders([{ ...baseEntry, fallback: { ...baseEntry.fallback, initialRevalidate: false } }]),
    ).toThrow(/\/blog/);
  });

  it("maps a PARTIALLY_STATIC prerender entry to an x-nbo-ppr field, with revalidateSec/expireSec as 0 (unused for PPR)", () => {
    const prerenders = [
      {
        pathname: "/ppr-demo",
        route: "/ppr-demo",
        groupId: 0,
        config: { renderingMode: "PARTIALLY_STATIC", allowQuery: [], allowHeader: [] },
        fallback: {
          filePath: "/abs/path/ppr-demo.html",
          postponedState: "opaque-state-1",
          initialStatus: 200,
          initialRevalidate: false,
        },
      },
    ];
    const [entry] = translatePrerenders(prerenders);
    expect(entry.revalidateSec).toBe(0);
    expect(entry.expireSec).toBe(0);
    expect(entry["x-nbo-ppr"]).toEqual({ postponedState: "opaque-state-1" });
    expect(entry.seeds).toEqual({ "/ppr-demo": { file: "/ppr-demo" } });
  });

  it("drops a PARTIALLY_STATIC entry with no filePath (the .rsc client-nav companion — out of scope, Partial Prefetching is a separate deferred feature)", () => {
    const prerenders = [
      {
        pathname: "/ppr-demo.rsc",
        route: "/ppr-demo",
        groupId: 0,
        config: { renderingMode: "PARTIALLY_STATIC", allowQuery: [], allowHeader: [] },
        fallback: { postponedState: "opaque-state-1", initialRevalidate: false },
      },
    ];
    expect(translatePrerenders(prerenders)).toEqual([]);
  });

  // Real build output confirmed directly (fixtures/ppr-app's own
  // /plain-static page): cacheComponents marks every app page
  // PARTIALLY_STATIC by default, including a page with no dynamic hole
  // at all — such a page is not a PPR route (nothing to resume), so it
  // must not throw the way an actual missing-postponedState bug would;
  // it gets the same long-lived onMiss: "shell" treatment Next's own
  // build output calls "Static" with a "1y" Expire.
  it("treats a PARTIALLY_STATIC entry with a shell but no postponedState as a long-lived static entry, not a PPR route", () => {
    const prerenders = [
      {
        pathname: "/plain-static",
        route: "/plain-static",
        groupId: 0,
        config: { renderingMode: "PARTIALLY_STATIC", allowQuery: [], allowHeader: [] },
        fallback: { filePath: "/abs/path/plain-static.html", postponedState: undefined, initialRevalidate: false },
      },
    ];
    const [entry] = translatePrerenders(prerenders);
    expect(entry.onMiss).toBe("shell");
    expect(entry.revalidateSec).toBe(31536000);
    expect(entry.expireSec).toBe(31536000);
    expect(entry["x-nbo-ppr"]).toBeUndefined();
    expect(entry.seeds).toEqual({ "/plain-static": { file: "/plain-static" } });
  });
});

describe("translatePrerenders with a hole-less cacheComponents page that has a lifetime", () => {
  it("keeps Next's numeric revalidate and expiry, as ordinary ISR", () => {
    const [entry] = translatePrerenders([
      {
        pathname: "/cache-life",
        route: "/cache-life",
        groupId: 0,
        config: { renderingMode: "PARTIALLY_STATIC", allowQuery: [], allowHeader: [] },
        fallback: {
          filePath: "/abs/path/cache-life.html",
          postponedState: undefined,
          initialRevalidate: 60,
          initialExpiration: 3600,
        },
      },
    ]);
    expect(entry.revalidateSec).toBe(60);
    expect(entry.expireSec).toBe(3600);
    expect(entry.onMiss).toBe("blocking");
    expect(entry["x-nbo-ppr"]).toBeUndefined();
  });

  it("still fails loudly when a numeric revalidate comes with no expiry", () => {
    expect(() =>
      translatePrerenders([
        {
          pathname: "/cache-life",
          route: "/cache-life",
          groupId: 0,
          config: { renderingMode: "PARTIALLY_STATIC", allowQuery: [], allowHeader: [] },
          fallback: { filePath: "/abs/path/cache-life.html", initialRevalidate: 60 },
        },
      ]),
    ).toThrow(/initialExpiration/);
  });
});

describe("assertSlice2Scope", () => {
  it("no longer throws for nodejs-runtime middleware", () => {
    expect(() =>
      assertSlice2Scope({
        middleware: { runtime: "nodejs", pathname: "/_middleware" },
        prerenders: [],
        pages: [],
        pagesApi: [],
        appPages: [],
        appRoutes: [],
      }),
    ).not.toThrow();
  });

  it("still throws naming middleware when it compiled to the edge runtime", () => {
    expect(() =>
      assertSlice2Scope({
        middleware: { runtime: "edge", pathname: "/_middleware" },
        prerenders: [],
        pages: [],
        pagesApi: [],
        appPages: [],
        appRoutes: [],
      }),
    ).toThrow(/edge runtime/i);
  });

  it("no longer throws for a prerender/ISR output — Slice 4's ISR item lifts this cut", () => {
    expect(() =>
      assertSlice2Scope({
        prerenders: [{ id: "p1", pathname: "/blog" }],
        pages: [],
        pagesApi: [],
        appPages: [],
        appRoutes: [],
      }),
    ).not.toThrow();
  });
  it("throws naming the route when a Pages Router output is present", () => {
    expect(() =>
      assertSlice2Scope({
        pages: [{ id: "x", pathname: "/old" }],
        pagesApi: [],
        appPages: [],
        appRoutes: [],
        prerenders: [],
      }),
    ).toThrow(/\/old/);
  });
  it("throws naming the route when an edge runtime output is present", () => {
    expect(() =>
      assertSlice2Scope({
        appPages: [{ id: "e1", pathname: "/edge", runtime: "edge" }],
        appRoutes: [],
        pagesApi: [],
        pages: [],
        prerenders: [],
      }),
    ).toThrow(/\/edge/);
  });
  it("throws naming the route when a dynamic segment is present", () => {
    expect(() =>
      assertSlice2Scope({
        appPages: [{ id: "d1", pathname: "/blog/[slug]" }],
        appRoutes: [],
        pagesApi: [],
        pages: [],
        prerenders: [],
      }),
    ).toThrow(/\/blog\/\[slug\]/);
  });
  it("tolerates Next's own internal _not-found and _global-error static pages", () => {
    expect(() =>
      assertSlice2Scope({
        prerenders: [
          { id: "n1", pathname: "/_not-found" },
          { id: "g1", pathname: "/_global-error" },
        ],
        pages: [],
        pagesApi: [],
        appPages: [],
        appRoutes: [],
      }),
    ).not.toThrow();
  });

  it("tolerates internal segment-tree pathnames using backslash separators (observed on Windows builds)", () => {
    expect(() =>
      assertSlice2Scope({
        prerenders: [{ id: "g2", pathname: "\\_global-error.segments\\_tree.segment.rsc" }],
        pages: [],
        pagesApi: [],
        appPages: [],
        appRoutes: [],
      }),
    ).not.toThrow();
  });

  it("passes for a plain dynamic (force-dynamic) app page and a route handler", () => {
    expect(() =>
      assertSlice2Scope({
        appPages: [{ id: "p1", pathname: "/", runtime: "nodejs" }],
        appRoutes: [{ id: "r1", pathname: "/api/hello", runtime: "nodejs" }],
        pagesApi: [],
        pages: [],
        prerenders: [],
      }),
    ).not.toThrow();
  });
});
