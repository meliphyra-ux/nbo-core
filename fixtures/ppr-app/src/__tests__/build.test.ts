// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// A real `next build` takes well over a minute — too slow for a
// routine unit-test run, and this project's own established convention
// (packages/cli/src/__tests__/main.test.ts's identical skipIf) is not
// to run one from inside a vitest test. This suite reads whatever a
// real build already produced; the real verify script
// (scripts/verify-slice5-ppr.sh) always builds fresh before running
// anything, including this one.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nboDir = join(appDir, ".nbo");

describe.skipIf(!existsSync(nboDir))("a real cacheComponents build", () => {
  it("writes an x-nbo-ppr prerender entry and declares the extension", () => {
    const prerender = JSON.parse(readFileSync(join(nboDir, "prerender.json"), "utf8"));
    const entry = prerender.prerenders.find((p: { id: string }) => p.id === "/");
    expect(entry).toBeDefined();
    expect(typeof entry["x-nbo-ppr"].postponedState).toBe("string");
    expect(entry["x-nbo-ppr"].postponedState.length).toBeGreaterThan(0);

    const manifest = JSON.parse(readFileSync(join(nboDir, "manifest.json"), "utf8"));
    expect(manifest.requires.extensions).toContainEqual({ id: "x-nbo-ppr", version: "1", critical: true });
  });
});
