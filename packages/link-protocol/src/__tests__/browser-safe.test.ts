// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

describe("browser safety", () => {
  it("no source file imports node:", () => {
    const dir = fileURLToPath(new URL("..", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/from\s+["']node:/);
      expect(text, f).not.toMatch(/require\(/);
      expect(text, f).not.toMatch(/import\(\s*["']node:/);
    }
  });
});
