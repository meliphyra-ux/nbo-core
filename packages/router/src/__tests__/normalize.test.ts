// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { normalizePath } from "../normalize.js";

describe("normalizePath", () => {
  it("decodes unreserved percent-escapes", () => {
    expect(normalizePath("/%7Euser", "never")).toBe("/~user");
  });

  it("does not decode reserved escapes", () => {
    // %2F is a reserved escape (encodes "/") and must NOT be decoded,
    // or a path segment could smuggle a slash past routing rules.
    expect(normalizePath("/a%2Fb", "never")).toBe("/a%2Fb");
  });

  it("resolves dot segments", () => {
    expect(normalizePath("/a/b/../c", "never")).toBe("/a/c");
  });

  it("does not let dot segments escape the root", () => {
    expect(normalizePath("/a/../../b", "never")).toBe("/b");
  });

  it("trailing slash never strips a trailing slash", () => {
    expect(normalizePath("/blog/", "never")).toBe("/blog");
    expect(normalizePath("/", "never")).toBe("/");
  });

  it("trailing slash always adds a trailing slash", () => {
    expect(normalizePath("/blog", "always")).toBe("/blog/");
  });

  it("trailing slash preserve leaves it alone", () => {
    expect(normalizePath("/blog", "preserve")).toBe("/blog");
    expect(normalizePath("/blog/", "preserve")).toBe("/blog/");
  });

  it("decodes a multi-byte UTF-8 percent-encoded sequence without corrupting it", () => {
    // %C3%A9 is "é" (U+00E9) UTF-8-encoded as two bytes — neither byte
    // is independently "unreserved", so decodeUnreserved must leave the
    // whole two-byte escape alone, not decode one byte of it in
    // isolation and corrupt the sequence.
    expect(normalizePath("/caf%C3%A9", "never")).toBe("/caf%C3%A9");
  });
});
