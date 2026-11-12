// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { canonicalize, sha256Hex, digestOf, contentId } from "../digest.js";

describe("canonicalize", () => {
  it("sorts object keys", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("is stable across repeated calls", () => {
    const value = { files: { "/b": 1, "/a": 2 }, version: 1 };
    expect(canonicalize(value)).toBe(canonicalize(value));
  });
});

describe("digestOf", () => {
  it("returns a sha256: prefixed hex digest", () => {
    const d = digestOf({ a: 1 });
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for equivalent objects with different key order", () => {
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
  });
});

describe("sha256Hex", () => {
  it("matches a known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("contentId", () => {
  it("excludes the build block", () => {
    const a = { specVersion: "1.0", build: { id: "b_one", createdAt: "2026-01-01T00:00:00Z" }, functions: [] };
    const b = { specVersion: "1.0", build: { id: "b_two", createdAt: "2026-06-15T12:00:00Z" }, functions: [] };
    expect(contentId(a)).toBe(contentId(b));
  });

  it("differs when non-build fields differ", () => {
    const a = { specVersion: "1.0", build: { id: "b1" }, functions: [] };
    const b = { specVersion: "1.0", build: { id: "b1" }, functions: ["ssr"] };
    expect(contentId(a)).not.toBe(contentId(b));
  });

  it("returns a sha256:-prefixed 64-hex-char digest", () => {
    expect(contentId({ specVersion: "1.0" })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is unaffected by key order", () => {
    expect(contentId({ a: 1, b: 2 })).toBe(contentId({ b: 2, a: 1 }));
  });

  it("succeeds when there is no build key at all", () => {
    expect(contentId({ specVersion: "1.0", functions: [] })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not strip a nested field also named build", () => {
    const withNested = { specVersion: "1.0", config: { build: "x" } };
    const withoutNested = { specVersion: "1.0", config: {} };
    expect(contentId(withNested)).not.toBe(contentId(withoutNested));
  });
});
