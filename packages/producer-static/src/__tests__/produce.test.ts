// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produce } from "../produce.js";

let buildDir: string;
let outDir: string;

beforeEach(() => {
  buildDir = mkdtempSync(join(tmpdir(), "nbo-produce-build-"));
  outDir = mkdtempSync(join(tmpdir(), "nbo-produce-out-"));
});

afterEach(() => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

describe("produce", () => {
  it("writes a real manifest.json and returns its own content id", async () => {
    writeFileSync(join(buildDir, "index.html"), "hi");

    const result = await produce(buildDir, outDir);

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.build.framework.name).toBe("static");
    expect(typeof result.contentId).toBe("string");
    expect(result.contentId.startsWith("sha256:")).toBe(true);
  });

  it("writes a fallback route to the root when opts.spa is true", async () => {
    writeFileSync(join(buildDir, "index.html"), "hi");

    await produce(buildDir, outDir, { spa: true });

    const routes = JSON.parse(readFileSync(join(outDir, "routes.json"), "utf8"));
    expect(routes.fallback?.[0]?.id).toBe("spa-fallback");
  });

  it("writes no fallback route when opts.spa is omitted", async () => {
    writeFileSync(join(buildDir, "index.html"), "hi");

    await produce(buildDir, outDir);

    const routes = JSON.parse(readFileSync(join(outDir, "routes.json"), "utf8"));
    expect(routes.fallback ?? []).toHaveLength(0);
  });
});
