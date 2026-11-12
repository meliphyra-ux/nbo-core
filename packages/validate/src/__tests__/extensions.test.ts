// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { checkExtensionKeys } from "../extensions.js";

const prerenderWith = (key: string) => ({
  version: 1,
  prerenders: [{ id: "/ppr", match: "^/ppr$", function: "ssr", [key]: { postponedState: "abc" } }],
});

describe("checkExtensionKeys", () => {
  it("refuses an undeclared x-nbo-pp on a prerender config, naming prerender.json and the key", () => {
    const errs = checkExtensionKeys([{ rel: "prerender.json", doc: prerenderWith("x-nbo-pp") }], new Set(["x-nbo-ppr"]));
    expect(errs.map((e) => e.message)).toEqual(['prerender.json: prerenders[0]: extension key "x-nbo-pp" is not declared in requires.extensions']);
  });

  it("accepts a declared x-nbo-ppr", () => {
    expect(checkExtensionKeys([{ rel: "prerender.json", doc: prerenderWith("x-nbo-ppr") }], new Set(["x-nbo-ppr"]))).toEqual([]);
  });

  it("accepts a declared non-critical x-acme-tag on a route rule", () => {
    const routes = { version: 1, afterFiles: [{ id: "r", match: { path: "^/" }, action: { type: "rewrite", function: "ssr" }, "x-acme-tag": "blue" }] };
    expect(checkExtensionKeys([{ rel: "routes.json", doc: routes }], new Set(["x-acme-tag"]))).toEqual([]);
  });

  it("walks all five extendable object kinds", () => {
    const declared = new Set<string>();
    const errs = checkExtensionKeys(
      [
        { rel: "manifest.json", doc: { specVersion: "1.0", "x-acme-a": 1 } },
        { rel: "functions/ssr/function.json", doc: { name: "ssr", "x-acme-b": 1 } },
        { rel: "routes.json", doc: { version: 1, onMatch: [{ id: "h", "x-acme-c": 1 }] } },
        { rel: "prerender.json", doc: { version: 1, prerenders: [{ id: "p", "x-acme-d": 1 }] } },
        { rel: "static.index.json", doc: { files: { "/a": { file: "a", "x-acme-e": 1 } } } },
      ],
      declared,
    );
    expect(errs.map((e) => e.message)).toEqual([
      'manifest.json: (root): extension key "x-acme-a" is not declared in requires.extensions',
      'functions/ssr/function.json: (root): extension key "x-acme-b" is not declared in requires.extensions',
      'routes.json: onMatch[0]: extension key "x-acme-c" is not declared in requires.extensions',
      'prerender.json: prerenders[0]: extension key "x-acme-d" is not declared in requires.extensions',
      'static.index.json: files["/a"]: extension key "x-acme-e" is not declared in requires.extensions',
    ]);
  });

  it("does not throw on malformed input", () => {
    expect(() =>
      checkExtensionKeys(
        [
          { rel: "manifest.json", doc: null },
          { rel: "routes.json", doc: { afterFiles: [null, 3] } },
          { rel: "prerender.json", doc: { prerenders: "x" } },
          { rel: "static.index.json", doc: { files: { "/": null } } },
        ],
        new Set(),
      ),
    ).not.toThrow();
  });
});
