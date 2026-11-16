// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { stripProjectRoot } from "../project-root.js";

describe("stripProjectRoot", () => {
  it("strips a matching repo-relative prefix", () => {
    expect(stripProjectRoot("fixtures/next-app/.next/server/app/page.js", "fixtures/next-app")).toBe(
      ".next/server/app/page.js",
    );
  });

  it("normalizes backslash separators on both sides before comparing (observed on Windows builds)", () => {
    expect(stripProjectRoot("fixtures\\next-app\\.next\\server\\app\\page.js", "fixtures\\next-app\\")).toBe(
      ".next/server/app/page.js",
    );
  });

  it("leaves a path with no matching prefix unchanged (still normalized)", () => {
    expect(stripProjectRoot("node_modules\\.pnpm\\next@16.4.2\\node_modules\\@swc\\helpers", "fixtures/next-app")).toBe(
      "node_modules/.pnpm/next@16.4.2/node_modules/@swc/helpers",
    );
  });
});
