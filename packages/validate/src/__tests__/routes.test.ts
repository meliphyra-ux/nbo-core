// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { checkRoutePatterns } from "../routes.js";

describe("checkRoutePatterns", () => {
  it("accepts an ordinary anchored pattern", () => {
    const routes = { version: 1, fallback: [{ id: "ok", match: { path: "^/blog/" }, action: { type: "rewrite", path: "/blog" } }] };
    expect(checkRoutePatterns(routes)).toHaveLength(0);
  });

  it("rejects a lookahead as not valid RE2, naming the pattern", () => {
    const routes = { version: 1, fallback: [{ id: "bad", match: { path: "^/(?=admin)" }, action: { type: "rewrite", path: "/" } }] };
    const errs = checkRoutePatterns(routes);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain("^/(?=admin)");
  });

  it("rejects \\C, \\c and \\u escapes that re2 accepts but Go's regexp.Compile does not", () => {
    for (const pattern of ["\\C", "\\cA", "\\u0041"]) {
      const routes = { version: 1, fallback: [{ id: "bad", match: { path: pattern }, action: { type: "rewrite", path: "/" } }] };
      const errs = checkRoutePatterns(routes);
      expect(errs.length, `expected ${pattern} to be rejected`).toBeGreaterThan(0);
    }
  });

  it("names RE2 routers, not Go, in the JS-only escape message", () => {
    const routes = { version: 1, fallback: [{ id: "bad", match: { path: "\\C" }, action: { type: "rewrite", path: "/" } }] };
    const msg = checkRoutePatterns(routes)[0]!.message;
    expect(msg).toContain("other RE2 routers do not accept");
    expect(msg).not.toContain("Go");
  });

  it("rejects \\u{...} escapes, as the router does", () => {
    for (const pattern of ["\\u{41}", "^/a\\u{1F600}$"]) {
      const routes = { version: 1, fallback: [{ id: "bad", match: { path: pattern }, action: { type: "rewrite", path: "/" } }] };
      const errs = checkRoutePatterns(routes);
      expect(errs.length, `expected ${pattern} to be rejected`).toBeGreaterThan(0);
      expect(errs[0]!.message).toContain(pattern);
    }
  });

  it("accepts an escaped backslash before C, c, u (the router accepts them)", () => {
    for (const pattern of ["\\\\C", "\\\\cA", "\\\\u0041", "\\\\u{41}"]) {
      const routes = { version: 1, fallback: [{ id: "ok", match: { path: pattern }, action: { type: "rewrite", path: "/" } }] };
      expect(checkRoutePatterns(routes), pattern).toEqual([]);
    }
  });

  it("does not throw on a null rule entry", () => {
    const routes = { version: 1, fallback: [null] };
    expect(() => checkRoutePatterns(routes)).not.toThrow();
  });

  it("checks pathNot the same way it checks path", () => {
    const routes = { version: 1, fallback: [{ id: "bad", match: { path: "^/", pathNot: "(?!x)" }, action: { type: "rewrite", path: "/" } }] };
    expect(checkRoutePatterns(routes)).toHaveLength(1);
  });
});

describe("checkRoutePatterns on prerender.json", () => {
  it("rejects a prerender match that is not RE2, naming prerender.json", () => {
    const prerender = { version: 1, prerenders: [{ id: "/p", match: "^/(?=p)" }] };
    const errs = checkRoutePatterns({ version: 1 }, prerender);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('prerender.json: prerender "/p": match "^/(?=p)" does not compile as RE2');
  });

  it("accepts an ordinary prerender match and tolerates junk", () => {
    expect(checkRoutePatterns({ version: 1 }, { version: 1, prerenders: [{ id: "/p", match: "^/p$" }, null] })).toEqual([]);
  });
});
