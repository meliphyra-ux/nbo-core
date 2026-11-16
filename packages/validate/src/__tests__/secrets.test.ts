// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksHighEntropy, scanForSecrets } from "../secrets.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-validate-secrets-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scanForSecrets", () => {
  it("flags a planted AWS-style key in manifest.json", () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ build: { id: "AKIAABCDEFGHIJKLMNOP" } }));
    const errs = scanForSecrets(dir);
    const found = errs.some((e) => e.message.includes("manifest.json") && e.message.includes("AKIA"));
    expect(found).toBe(true);
  });

  it("flags a PEM private-key header planted in a function's function.json", () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ functions: ["ssr"] }));
    mkdirSync(join(dir, "functions", "ssr"), { recursive: true });
    writeFileSync(
      join(dir, "functions", "ssr", "function.json"),
      JSON.stringify({ name: "ssr", leaked: "-----BEGIN RSA PRIVATE KEY-----" }),
    );
    const errs = scanForSecrets(dir);
    const found = errs.some((e) => e.message.includes("function.json") && e.message.includes("BEGIN RSA PRIVATE KEY"));
    expect(found).toBe(true);
  });

  it("returns no errors against a real build's own sha256 digests and build id", () => {
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        specVersion: "1.0",
        build: { id: "b_test", createdAt: "2026-10-22T00:00:00Z" },
        functions: [],
        digests: {
          "static.index.json": "sha256:" + "a".repeat(64),
          "routes.json": "sha256:" + "b".repeat(64),
        },
      }),
    );
    expect(scanForSecrets(dir)).toHaveLength(0);
  });
});

describe("scanForSecrets malformed input", () => {
  it("does not throw when a functions entry is not a string", () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ functions: [123, null] }));
    expect(() => scanForSecrets(dir)).not.toThrow();
  });
});

describe("looksHighEntropy", () => {
  it("does not flag a content-hashed static asset path", () => {
    expect(looksHighEntropy("/_next/static/media/4fa387ec64143e14-s.2tuy5pz7dlieh.woff2")).toBe(false);
  });
});
