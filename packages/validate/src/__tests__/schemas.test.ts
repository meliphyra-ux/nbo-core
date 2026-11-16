// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { compiledSchemas } from "../schemas.js";

describe("compiledSchemas", () => {
  it("accepts a minimal well-formed manifest", () => {
    const manifest = {
      specVersion: "1.0",
      build: { id: "b_test", createdAt: "2026-01-01T00:00:00Z", framework: { name: "static" } },
      requires: { capabilities: [], extensions: [] },
      functions: [],
      digests: {},
    };
    expect(compiledSchemas.manifest(manifest)).toBe(true);
  });

  it("rejects a manifest carrying an undeclared top-level field", () => {
    const manifest = {
      specVersion: "1.0",
      build: { id: "b_test", createdAt: "2026-01-01T00:00:00Z", framework: { name: "static" } },
      requires: { capabilities: [], extensions: [] },
      functions: [],
      digests: {},
      somethingMadeUp: true,
    };
    expect(compiledSchemas.manifest(manifest)).toBe(false);
  });

  it("validates manifest.build.createdAt as a real date-time", () => {
    const manifest = {
      specVersion: "1.0",
      build: { id: "b_test", createdAt: "not-a-date", framework: { name: "static" } },
      requires: { capabilities: [], extensions: [] },
      functions: [],
      digests: {},
    };
    expect(compiledSchemas.manifest(manifest)).toBe(false);
  });

  it("accepts a prerender.json entry carrying x-nbo-ppr", () => {
    const prerender = {
      version: 1,
      prerenders: [
        {
          id: "/ppr-demo",
          match: "^/ppr-demo$",
          function: "ssr",
          revalidateSec: 0,
          expireSec: 0,
          onMiss: "blocking",
          bypassToken: { env: "NBO_PRERENDER_BYPASS" },
          "x-nbo-ppr": { postponedState: "abc" },
        },
      ],
    };
    expect(compiledSchemas.prerender(prerender)).toBe(true);
  });

  it("rejects an x-nbo-ppr object missing postponedState", () => {
    const prerender = {
      version: 1,
      prerenders: [
        {
          id: "/ppr-demo",
          match: "^/ppr-demo$",
          function: "ssr",
          revalidateSec: 0,
          expireSec: 0,
          onMiss: "blocking",
          bypassToken: { env: "NBO_PRERENDER_BYPASS" },
          "x-nbo-ppr": {},
        },
      ],
    };
    expect(compiledSchemas.prerender(prerender)).toBe(false);
  });
});

// Spec 1.0: names the draft promised but nothing implements are reserved
// (rejected by the schema), and extendable objects accept `x-` keys.

function baseManifest(): Record<string, unknown> {
  return {
    specVersion: "1.0",
    build: { id: "b_test", createdAt: "2026-01-01T00:00:00Z", framework: { name: "nextjs" } },
    requires: {
      capabilities: ["fn.streaming", "prerender.isr", "prerender.onDemand", "images.optimize"],
      extensions: [],
    },
    routing: { trailingSlash: "never", cleanUrls: true, caseSensitive: true },
    functions: ["ssr", "middleware"],
    crons: [
      {
        id: "nightly",
        schedule: "0 3 * * *",
        timezone: "UTC",
        target: { function: "ssr", path: "/api/cron", method: "POST" },
      },
    ],
    digests: {},
  };
}

function baseFunction(): Record<string, unknown> {
  return {
    name: "ssr",
    runtime: { kind: "node", version: ">=22" },
    handler: { style: "fetch", entry: "index.mjs", export: "default" },
    artifact: { type: "bundle", path: "bundle/", digest: `sha256:${"0".repeat(64)}`, files: "bundle.index.json" },
    concurrency: "multi",
  };
}

function baseRule(): Record<string, unknown> {
  return { id: "r1", match: { path: "^/a$" }, action: { type: "rewrite", function: "ssr" } };
}

function routesWith(rule: Record<string, unknown>): Record<string, unknown> {
  return { version: 1, afterFiles: [rule] };
}

function baseStaticEntry(): Record<string, unknown> {
  return {
    file: "index.html",
    digest: `sha256:${"0".repeat(64)}`,
    size: 1,
    contentType: "text/html; charset=utf-8",
    cache: "revalidate",
  };
}

function basePrerenderConfig(): Record<string, unknown> {
  return {
    id: "/isr",
    match: "^/isr$",
    function: "ssr",
    revalidateSec: 60,
    expireSec: 31536000,
    tags: ["group:1"],
    seeds: { "/isr": { file: "/isr" } },
    onMiss: "blocking",
    allowQuery: [],
    varyHeaders: [],
    bypassToken: { env: "NBO_PRERENDER_BYPASS" },
  };
}

describe("compiledSchemas: 1.0 base shapes", () => {
  it("accepts today's writer shapes", () => {
    expect(compiledSchemas.manifest(baseManifest())).toBe(true);
    expect(compiledSchemas.function(baseFunction())).toBe(true);
    expect(compiledSchemas.routes(routesWith(baseRule()))).toBe(true);
    expect(compiledSchemas.staticIndex({ files: { "/": baseStaticEntry() } })).toBe(true);
    expect(compiledSchemas.prerender({ version: 1, prerenders: [basePrerenderConfig()] })).toBe(true);
  });

  it("accepts the middleware rule, the SPA fallback and a 404 error page", () => {
    const routes = {
      version: 1,
      beforeFiles: [
        { id: "middleware-0", match: { path: "^/m" }, action: { type: "middleware", function: "middleware" } },
      ],
      fallback: [
        {
          id: "spa-fallback",
          match: { path: "^/", pathNot: "\\.[A-Za-z0-9]+$" },
          action: { type: "rewrite", path: "/" },
        },
      ],
      error: { "404": { file: "/404" } },
    };
    expect(compiledSchemas.routes(routes)).toBe(true);
  });

  it("accepts a redirect with location and a 308 status", () => {
    expect(
      compiledSchemas.routes(
        routesWith({ id: "r", match: { path: "^/old$" }, action: { type: "redirect", location: "/new", status: 308 } }),
      ),
    ).toBe(true);
  });

  it("accepts the PPR placeholder shape the Next adapter writes", () => {
    const ppr = {
      ...basePrerenderConfig(),
      revalidateSec: 0,
      expireSec: 0,
      onMiss: "blocking",
      "x-nbo-ppr": { postponedState: "abc" },
    };
    expect(compiledSchemas.prerender({ version: 1, prerenders: [ppr] })).toBe(true);
  });
});

describe("compiledSchemas: reserved names are rejected", () => {
  it('rejects runtime.kind "edge"', () => {
    expect(compiledSchemas.function({ ...baseFunction(), runtime: { kind: "edge" } })).toBe(false);
  });

  it('rejects concurrency "single"', () => {
    expect(compiledSchemas.function({ ...baseFunction(), concurrency: "single" })).toBe(false);
  });

  it("rejects a function group", () => {
    expect(compiledSchemas.function({ ...baseFunction(), group: "g1" })).toBe(false);
  });

  it.each([
    ["platform", "linux/amd64"],
    ["placement", { region: "near-data" }],
    ["scaling", { min: 0, max: 10 }],
    ["env", { required: ["API_KEY"] }],
    ["bindings", [{ name: "db", type: "postgres" }]],
  ])("rejects the reserved function field %s", (field, value) => {
    expect(compiledSchemas.function({ ...baseFunction(), [field]: value })).toBe(false);
  });

  it('rejects runtime.kind "container" and "python"', () => {
    expect(compiledSchemas.function({ ...baseFunction(), runtime: { kind: "container" } })).toBe(false);
    expect(compiledSchemas.function({ ...baseFunction(), runtime: { kind: "python" } })).toBe(false);
  });

  it('rejects the "transform" action', () => {
    expect(compiledSchemas.routes(routesWith({ ...baseRule(), action: { type: "transform" } }))).toBe(false);
  });

  it("rejects a rewrite url", () => {
    expect(
      compiledSchemas.routes(routesWith({ ...baseRule(), action: { type: "rewrite", url: "https://example.com/" } })),
    ).toBe(false);
  });

  it("rejects match.has", () => {
    expect(
      compiledSchemas.routes(
        routesWith({ ...baseRule(), match: { path: "^/a$", has: [{ type: "header", key: "x", value: { eq: "1" } }] } }),
      ),
    ).toBe(false);
  });

  it("rejects match.missing", () => {
    expect(
      compiledSchemas.routes(
        routesWith({
          ...baseRule(),
          match: { path: "^/a$", missing: [{ type: "header", key: "x", value: { eq: "1" } }] },
        }),
      ),
    ).toBe(false);
  });

  it('rejects error["500"]', () => {
    expect(compiledSchemas.routes({ version: 1, error: { "500": { file: "/500" } } })).toBe(false);
  });

  it("rejects a 404 error page served by a function", () => {
    expect(compiledSchemas.routes({ version: 1, error: { "404": { function: "ssr" } } })).toBe(false);
  });

  it("rejects static variants", () => {
    expect(
      compiledSchemas.staticIndex({
        files: { "/": { ...baseStaticEntry(), variants: { br: `sha256:${"1".repeat(64)}` } } },
      }),
    ).toBe(false);
  });

  it('rejects the "cron" capability', () => {
    expect(compiledSchemas.manifest({ ...baseManifest(), requires: { capabilities: ["cron"], extensions: [] } })).toBe(
      false,
    );
  });

  it('rejects the "route.middleware" capability', () => {
    expect(
      compiledSchemas.manifest({ ...baseManifest(), requires: { capabilities: ["route.middleware"], extensions: [] } }),
    ).toBe(false);
  });

  it('rejects the "cron" capability on a function', () => {
    expect(compiledSchemas.function({ ...baseFunction(), requires: ["cron"] })).toBe(false);
  });

  it("rejects cleanUrls: false", () => {
    expect(
      compiledSchemas.manifest({
        ...baseManifest(),
        routing: { trailingSlash: "never", cleanUrls: false, caseSensitive: true },
      }),
    ).toBe(false);
  });

  it("rejects caseSensitive: false", () => {
    expect(
      compiledSchemas.manifest({
        ...baseManifest(),
        routing: { trailingSlash: "never", cleanUrls: true, caseSensitive: false },
      }),
    ).toBe(false);
  });

  it("rejects a cron timezone other than UTC (Europe/Paris)", () => {
    const crons = [
      {
        id: "n",
        schedule: "0 3 * * *",
        timezone: "Europe/Paris",
        target: { function: "ssr", path: "/c", method: "POST" },
      },
    ];
    expect(compiledSchemas.manifest({ ...baseManifest(), crons })).toBe(false);
  });

  it("rejects a cron method that isn't an upper-case HTTP method", () => {
    const crons = [{ id: "n", schedule: "0 3 * * *", target: { function: "ssr", path: "/c", method: "post" } }];
    expect(compiledSchemas.manifest({ ...baseManifest(), crons })).toBe(false);
  });

  it('rejects the function name "SSR" in function.json', () => {
    expect(compiledSchemas.function({ ...baseFunction(), name: "SSR" })).toBe(false);
  });

  it('rejects the function name "SSR" in manifest.functions', () => {
    expect(compiledSchemas.manifest({ ...baseManifest(), functions: ["SSR"] })).toBe(false);
  });

  it("rejects redirect status 303", () => {
    expect(
      compiledSchemas.routes(
        routesWith({ id: "r", match: { path: "^/old$" }, action: { type: "redirect", location: "/new", status: 303 } }),
      ),
    ).toBe(false);
  });

  it("rejects a redirect without a status", () => {
    expect(
      compiledSchemas.routes(
        routesWith({ id: "r", match: { path: "^/old$" }, action: { type: "redirect", location: "/new" } }),
      ),
    ).toBe(false);
  });
});

describe("compiledSchemas: x- extension keys", () => {
  it("accepts x-acme-tag on the manifest root", () => {
    expect(compiledSchemas.manifest({ ...baseManifest(), "x-acme-tag": { any: 1 } })).toBe(true);
  });

  it("accepts x-acme-tag on the function root", () => {
    expect(compiledSchemas.function({ ...baseFunction(), "x-acme-tag": "v" })).toBe(true);
  });

  it("accepts x-acme-tag on a route rule", () => {
    expect(compiledSchemas.routes(routesWith({ ...baseRule(), "x-acme-tag": true }))).toBe(true);
  });

  it("accepts x-acme-tag on a prerender config", () => {
    expect(
      compiledSchemas.prerender({ version: 1, prerenders: [{ ...basePrerenderConfig(), "x-acme-tag": [1] }] }),
    ).toBe(true);
  });

  it("accepts x-acme-tag on a static-index entry", () => {
    expect(compiledSchemas.staticIndex({ files: { "/": { ...baseStaticEntry(), "x-acme-tag": 1 } } })).toBe(true);
  });

  it("rejects a key that doesn't fit the x- pattern (x-acme)", () => {
    expect(compiledSchemas.function({ ...baseFunction(), "x-acme": 1 })).toBe(false);
  });

  it("rejects an x- key on an object that isn't extendable (route action)", () => {
    expect(
      compiledSchemas.routes(
        routesWith({ ...baseRule(), action: { type: "rewrite", function: "ssr", "x-acme-tag": 1 } }),
      ),
    ).toBe(false);
  });

  it("still rejects x-nbo-ppr without postponedState next to the x- rule", () => {
    expect(compiledSchemas.prerender({ version: 1, prerenders: [{ ...basePrerenderConfig(), "x-nbo-ppr": {} }] })).toBe(
      false,
    );
  });
});

describe("compiledSchemas: $id", () => {
  it("uses urn:nbo:spec:v1:<file stem>", () => {
    expect(compiledSchemas.manifest.schema).toMatchObject({ $id: "urn:nbo:spec:v1:manifest" });
    expect(compiledSchemas.function.schema).toMatchObject({ $id: "urn:nbo:spec:v1:function" });
    expect(compiledSchemas.routes.schema).toMatchObject({ $id: "urn:nbo:spec:v1:routes" });
    expect(compiledSchemas.staticIndex.schema).toMatchObject({ $id: "urn:nbo:spec:v1:static-index" });
    expect(compiledSchemas.prerender.schema).toMatchObject({ $id: "urn:nbo:spec:v1:prerender" });
    expect(compiledSchemas.bundleIndex.schema).toMatchObject({ $id: "urn:nbo:spec:v1:bundle-index" });
  });
});
