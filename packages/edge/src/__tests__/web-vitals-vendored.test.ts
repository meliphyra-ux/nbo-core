// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Rust edge serves the web-vitals IIFE from its own vendored copy
// (packages/edge-rs/assets). It must stay byte-equal to the copy this
// package serves from node_modules, so both edges send the same script.
describe("vendored web-vitals", () => {
  it("packages/edge-rs/assets/web-vitals.iife.js equals node_modules/web-vitals' copy", () => {
    const require = createRequire(import.meta.url);
    const distDir = dirname(require.resolve("web-vitals"));
    const fromPackage = readFileSync(join(distDir, "web-vitals.iife.js"));
    const vendored = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "edge-rs", "assets", "web-vitals.iife.js"));
    expect(vendored.equals(fromPackage)).toBe(true);
    // The package.json is not in web-vitals' exports map; it sits above dist/.
    const { version } = JSON.parse(readFileSync(join(distDir, "..", "package.json"), "utf8")) as { version: string };
    expect(version).toBe("6.2.3");
  });
});
