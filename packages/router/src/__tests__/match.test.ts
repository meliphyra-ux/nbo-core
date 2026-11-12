// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { compileMatch, substitute } from "../match.js";

describe("compileMatch", () => {
  it("compiles path as RE2", () => {
    const cm = compileMatch({ path: "^/blog/(?P<slug>[^/]+)$" });
    const { ok, groups } = cm.test("/blog/hello", "GET");
    expect(ok).toBe(true);
    expect(groups.slug).toBe("hello");
  });

  it("rejects an unsupported lookahead", () => {
    expect(() => compileMatch({ path: "^/(?=admin)" })).toThrow();
  });

  it("pathNot excludes matches", () => {
    const cm = compileMatch({ path: "^/", pathNot: "\\.[A-Za-z0-9]+$" });
    expect(cm.test("/settings/profile", "GET").ok).toBe(true);
    expect(cm.test("/assets/app.js", "GET").ok).toBe(false);
  });

  it("methods restrict matching", () => {
    const cm = compileMatch({ path: "^/api/", methods: ["POST"] });
    expect(cm.test("/api/x", "GET").ok).toBe(false);
    expect(cm.test("/api/x", "POST").ok).toBe(true);
  });

  it("rejects has/missing as unsupported", () => {
    expect(() => compileMatch({ path: "^/", has: [{ type: "cookie", key: "beta" }] })).toThrow();
  });

  it("rejects \\C, \\c and \\u escapes re2 accepts but Go's regexp.Compile does not", () => {
    // Confirmed directly via `go run` against real regexp.Compile:
    // all 5 are rejected by Go. Same gap @nbo/validate's own
    // checkRoutePatterns found and closed for routes.json's own
    // schema-level check (sub-project 2's final review) — the
    // router is a second, independent place patterns reach `new
    // RE2(...)`, so it needs its own guard, not inherited protection.
    for (const pattern of ["\\C", "\\cA", "\\cZ", "\\u0041", "\\u{41}"]) {
      expect(() => compileMatch({ path: pattern }), `expected ${pattern} to be rejected`).toThrow();
    }
  });

  it("does not reject an escaped backslash followed by a literal C (real RE2, not the \\C escape)", () => {
    // \\C (two real backslash characters then C) is ordinary,
    // unambiguous RE2 syntax — an escaped literal backslash followed
    // by a literal C — confirmed accepted by real Go regexp.Compile.
    // @nbo/validate's own guard has a real bug here (flagged by this
    // sub-project's own final review): it matches on backslash-count
    // without checking parity, so it wrongly rejects this valid
    // pattern too. This router's own guard must not repeat that bug.
    expect(() => compileMatch({ path: "\\\\C" })).not.toThrow();
    expect(() => compileMatch({ path: "\\\\cA" })).not.toThrow();
  });
});

describe("substitute", () => {
  it("substitutes named and numbered groups", () => {
    expect(substitute("/docs/$rest", { rest: "v2/intro" })).toBe("/docs/v2/intro");
    expect(substitute("/one/$1/two", { "1": "x" })).toBe("/one/x/two");
  });

  it("leaves an unknown token naming an Object.prototype member unchanged", () => {
    // Final review: `key in groups` resolves inherited properties
    // too, so a token like $constructor or $toString was being
    // "substituted" with Object.prototype's own method source text
    // instead of being left as-is the way Go leaves any unknown
    // token untouched.
    for (const tok of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"]) {
      expect(substitute(`/$${tok}`, {})).toBe(`/$${tok}`);
    }
  });
});

describe("compileMatch groups", () => {
  it("keeps a named group literally called __proto__", () => {
    // Bracket-assigning "__proto__" onto a plain {} tries to set the
    // prototype instead of creating an own property, silently
    // dropping the group — Go's own map has no such special case.
    const cm = compileMatch({ path: "^/(?P<__proto__>x)$" });
    const { ok, groups } = cm.test("/x", "GET");
    expect(ok).toBe(true);
    expect(groups.__proto__).toBe("x");
    expect(Object.prototype.hasOwnProperty.call(groups, "__proto__")).toBe(true);
  });
});
