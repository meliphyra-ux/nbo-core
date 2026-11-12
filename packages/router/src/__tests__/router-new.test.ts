// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createRouter } from "../router.js";

describe("createRouter", () => {
  it("rejects an invalid prerender match pattern", () => {
    expect(() => createRouter({ version: 1, prerenders: [{ id: "bad", matchPath: "(unclosed", functionName: "ssr" }] }, "never")).toThrow();
  });

  it("rejects unsupported action types", () => {
    expect(() => createRouter({ version: 1, beforeFiles: [{ id: "bogus", match: { path: "^/" }, action: { type: "bogus" } }] }, "never")).toThrow();
  });

  it("rejects a rewrite with neither path nor function", () => {
    expect(() => createRouter({ version: 1, afterFiles: [{ id: "bad", match: { path: "^/$" }, action: { type: "rewrite" } }] }, "never")).toThrow();
  });

  it("still rejects an external URL rewrite (out of scope)", () => {
    expect(() => createRouter({ version: 1, afterFiles: [{ id: "proxy", match: { path: "^/$" }, action: { type: "rewrite", url: "https://example.com" } }] }, "never")).toThrow();
  });

  it("rejects a prerender matchPath using a JS-only escape Go's regexp.Compile does not accept", () => {
    // Final review: no code anywhere checked prerender patterns for
    // Go-dialect parity (not even @nbo/validate) — this router's own
    // compile-time gate is the only one, so it has to apply here too,
    // not just to ordinary route rules' match.path/pathNot.
    expect(() => createRouter({ version: 1, prerenders: [{ id: "bad", matchPath: "\\C", functionName: "ssr" }] }, "never")).toThrow();
  });

  it("accepts the middleware action type", () => {
    expect(() => createRouter({ version: 1, beforeFiles: [{ id: "mw", match: { path: "^/" }, action: { type: "middleware", function: "middleware" } }] }, "never")).not.toThrow();
  });
});
