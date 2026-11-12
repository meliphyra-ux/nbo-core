// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFromDir } from "../load.js";

async function writeLoadFixture(dir: string, functionNames: string[]): Promise<void> {
  const manifest = {
    specVersion: "1.0",
    build: { id: "b1", createdAt: "2026-10-22T00:00:00Z", framework: { name: "static" } },
    requires: { capabilities: [], extensions: [] },
    functions: functionNames.slice(0, 1),
    digests: {},
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const name of functionNames) {
    const fnDir = join(dir, "functions", name);
    await mkdir(fnDir, { recursive: true });
    const fn = {
      name,
      runtime: { kind: "node" },
      handler: { style: "fetch", entry: "index.mjs", export: "default" },
      artifact: { type: "bundle", path: "bundle/", digest: "sha256:00", files: "bundle.index.json" },
      concurrency: "multi",
    };
    await writeFile(join(fnDir, "function.json"), JSON.stringify(fn));
  }
}

describe("loadFromDir", () => {
  it("loads the manifest and every named function", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planner-"));
    await writeLoadFixture(dir, ["ssr"]);

    const { manifest, functions } = await loadFromDir(dir);

    expect(manifest.functions).toEqual(["ssr"]);
    expect(functions.ssr?.name).toBe("ssr");
  });

  it("returns an empty functions map for a static-only build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planner-"));
    await writeLoadFixture(dir, []);

    const { functions } = await loadFromDir(dir);

    expect(Object.keys(functions)).toHaveLength(0);
  });

  it("names the missing function and fails when its function.json is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planner-"));
    const manifest = {
      specVersion: "1.0",
      build: { id: "b1", createdAt: "2026-10-22T00:00:00Z", framework: { name: "static" } },
      requires: { capabilities: [], extensions: [] },
      functions: ["ssr"],
      digests: {},
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    // no functions/ssr/function.json written

    await expect(loadFromDir(dir)).rejects.toThrow(/ssr/);
  });

  it("does not let a function named __proto__ corrupt the functions map's own prototype", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planner-"));
    await writeLoadFixture(dir, ["__proto__"]);

    const { functions } = await loadFromDir(dir);

    expect(Object.hasOwn(functions, "__proto__")).toBe(true);
    expect(functions["__proto__"]?.name).toBe("__proto__");
  });
});
