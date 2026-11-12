// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlanArgs, runPlan } from "../plan.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-cli-plan-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(requiredCapabilities: string[]): void {
  const manifest = {
    specVersion: "1.0",
    build: { id: "b_test", createdAt: "2026-10-22T00:00:00Z", framework: { name: "static" } },
    requires: { capabilities: requiredCapabilities, extensions: [] },
    functions: [],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

describe("parsePlanArgs", () => {
  it("parses dir and --target", () => {
    expect(parsePlanArgs(["dir", "--target", "kubernetes"])).toEqual({ dir: "dir", target: "kubernetes" });
  });

  it("defaults target to empty when --target is missing", () => {
    expect(parsePlanArgs(["dir"])).toEqual({ dir: "dir", target: "" });
  });
});

describe("runPlan", () => {
  it("returns 0 when the plan is OK", async () => {
    writeManifest([]);

    expect(await runPlan([dir, "--target", "kubernetes"])).toBe(0);
  });

  it("returns 1 when the plan fails (a capability the adapter doesn't support)", async () => {
    writeManifest(["fn.edge"]);

    expect(await runPlan([dir, "--target", "kubernetes"])).toBe(1);
  });

  it("returns 1 with a clear message for an unknown target, never silently treating it as kubernetes", async () => {
    writeManifest([]);

    expect(await runPlan([dir, "--target", "cloudrun"])).toBe(1);
  });
});
