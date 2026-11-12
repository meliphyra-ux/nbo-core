// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { isHashedAsset } from "./cli.js";

describe("isHashedAsset", () => {
  it("treats a Vite-hashed bundle path as immutable-eligible", () => {
    expect(isHashedAsset("/assets/app.abc123.js")).toBe(true);
  });

  it("treats an unhashed root-level file as not immutable-eligible", () => {
    expect(isHashedAsset("/favicon.ico")).toBe(false);
  });
});
