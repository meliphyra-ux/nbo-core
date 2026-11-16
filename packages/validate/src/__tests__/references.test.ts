// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { checkReferences } from "../references.js";

const manifest = { functions: ["ssr", "middleware"] };
const staticIndex = { files: { "/": {}, "/404": {}, "/isr": {} } };

function prerenderDoc(fn: string, seedFile: string) {
  return {
    version: 1,
    prerenders: [{ id: "/isr", match: "^/isr$", function: fn, seeds: { "/isr": { file: seedFile } } }],
  };
}

describe("checkReferences", () => {
  it("accepts declared functions and existing static keys", () => {
    const routes = {
      version: 1,
      beforeFiles: [{ id: "mw", match: { path: "^/" }, action: { type: "middleware", function: "middleware" } }],
      afterFiles: [{ id: "api", match: { path: "^/api" }, action: { type: "rewrite", function: "ssr" } }],
      error: { "404": { file: "/404" } },
    };
    expect(checkReferences({ manifest, routes, staticIndex, prerender: prerenderDoc("ssr", "/isr") })).toEqual([]);
  });

  it("refuses a rewrite to an undeclared function in any phase", () => {
    for (const phase of ["beforeFiles", "afterFiles", "fallback", "onMatch"]) {
      const routes = {
        version: 1,
        [phase]: [{ id: "r1", match: { path: "^/" }, action: { type: "rewrite", function: "nope" } }],
      };
      expect(checkReferences({ manifest, routes }).map((e) => e.message)).toEqual([
        'routes.json: rule "r1": function "nope" is not declared in manifest functions',
      ]);
    }
  });

  it("refuses a middleware rule naming an undeclared function", () => {
    const routes = {
      version: 1,
      beforeFiles: [{ id: "mw", match: { path: "^/" }, action: { type: "middleware", function: "edge-mw" } }],
    };
    expect(checkReferences({ manifest, routes }).map((e) => e.message)).toEqual([
      'routes.json: rule "mw": function "edge-mw" is not declared in manifest functions',
    ]);
  });

  it("refuses a prerender naming an undeclared function", () => {
    expect(
      checkReferences({ manifest, staticIndex, prerender: prerenderDoc("gone", "/isr") }).map((e) => e.message),
    ).toEqual(['prerender.json: prerender "/isr": function "gone" is not declared in manifest functions']);
  });

  it("refuses a 404 error page that is not a static key", () => {
    const routes = { version: 1, error: { "404": { file: "/missing" } } };
    expect(checkReferences({ manifest, routes, staticIndex }).map((e) => e.message)).toEqual([
      'routes.json: error "404": file "/missing" is not a static.index.json key',
    ]);
  });

  it("refuses a seed whose file is not a static key, checking .file not the seed key", () => {
    expect(
      checkReferences({ manifest, staticIndex, prerender: prerenderDoc("ssr", "/other") }).map((e) => e.message),
    ).toEqual(['prerender.json: prerender "/isr": seed "/isr": file "/other" is not a static.index.json key']);
  });

  it("skips static-key checks when static.index.json could not be read", () => {
    const routes = { version: 1, error: { "404": { file: "/missing" } } };
    expect(checkReferences({ manifest, routes })).toEqual([]);
  });

  it("does not throw on malformed input", () => {
    expect(() =>
      checkReferences({
        manifest: null,
        routes: { beforeFiles: [null, { action: null }] },
        prerender: { prerenders: [null] },
      }),
    ).not.toThrow();
  });
});
