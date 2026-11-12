// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { resolveStatic } from "../nbopath.js";

describe("resolveStatic", () => {
  it("resolves an ordinary file value under static/", () => {
    const result = resolveStatic("/nbo", "index.html");
    expect(result).toEqual({ ok: true, path: expect.stringContaining("static") });
  });

  it("rejects a value that climbs out of static/ via ..", () => {
    expect(resolveStatic("/nbo", "../secret.txt")).toEqual({ ok: false });
  });

  it("rejects a value that climbs out via a mixed separator", () => {
    expect(resolveStatic("/nbo", "..\\secret.txt")).toEqual({ ok: false });
  });
});
