// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { canonicalize } from "@nbo/digest";
import { canonicalJson } from "../canonical.js";

describe("canonicalJson", () => {
  const values: unknown[] = [
    { b: 1, a: { z: 1, y: [3, 2, 1] } },
    { é: 1, a: 2, 中: 3, "😀": 4 },
    { n: 1e21, m: 1e-7 },
    { z: -0, y: 0 },
    [
      { b: 1, a: 2 },
      { d: [{ f: 1, e: 2 }], c: null },
    ],
  ];
  it("matches @nbo/digest's canonicalize", () => {
    for (const v of values) expect(canonicalJson(v)).toBe(canonicalize(v));
  });
  it("throws on undefined", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
  it("throws on a non-finite number and a cycle", () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => canonicalJson(c)).toThrow(TypeError);
  });
});
