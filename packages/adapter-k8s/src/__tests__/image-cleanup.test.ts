// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each image builder assembles a throwaway build context and removes it
// afterwards. A failing removal (seen for real: EROFS once the disk had
// gone read-only) must never replace the build's own error, and must not
// fail a build that worked. Docker and the removal are both faked.
const state = vi.hoisted(() => ({ buildError: undefined as Error | undefined, rmError: undefined as Error | undefined, rmCalls: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rm: vi.fn(async (path: string, opts?: Parameters<typeof real.rm>[1]) => {
      state.rmCalls.push(String(path));
      if (state.rmError && String(path).includes("nbo-")) throw state.rmError;
      return real.rm(path, opts);
    }),
  };
});

vi.mock("../run.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../run.js")>();
  return {
    ...real,
    run: vi.fn(async () => {
      if (state.buildError) throw state.buildError;
      return "";
    }),
  };
});

const { buildImage, buildFunctionImage, buildIsrcacheImage } = await import("../image.js");

async function fixture(): Promise<{ nboDir: string; cliDeployDir: string; bundleDir: string; functionJSON: string }> {
  const dir = await mkdtemp(join(tmpdir(), "adapter-k8s-cleanup-"));
  const nboDir = join(dir, "app");
  await mkdir(join(nboDir, "static"), { recursive: true });
  await writeFile(join(nboDir, "manifest.json"), "{}");
  const cliDeployDir = join(dir, "cli-deploy");
  await mkdir(join(cliDeployDir, "dist"), { recursive: true });
  await writeFile(join(cliDeployDir, "dist", "main.js"), "// cli\n");
  const bundleDir = join(dir, "bundle");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "index.mjs"), "export default {}\n");
  const functionJSON = join(dir, "function.json");
  await writeFile(functionJSON, "{}");
  return { nboDir, cliDeployDir, bundleDir, functionJSON };
}

const builders: [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>][] = [
  ["buildImage", (f) => buildImage(f.nboDir, f.cliDeployDir, "nbo-app-x:1")],
  ["buildFunctionImage", (f) => buildFunctionImage(f.bundleDir, f.functionJSON, "nbo-fn-x:1")],
  ["buildIsrcacheImage", (f) => buildIsrcacheImage(f.cliDeployDir, "nbo-isrcache:1")],
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.buildError = undefined;
  state.rmError = undefined;
  state.rmCalls.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe.each(builders)("%s build context cleanup", (_name, build) => {
  it("rethrows the build's own error when removing the context also fails", async () => {
    const f = await fixture();
    state.buildError = new Error("docker build failed: no space left on device");
    state.rmError = Object.assign(new Error("EROFS: read-only file system, rmdir '/tmp/nbo-image-x'"), { code: "EROFS" });
    await expect(build(f)).rejects.toThrow("docker build failed: no space left on device");
    expect(state.rmCalls.length).toBeGreaterThan(0);
  });

  it("does not fail a build that worked when removing the context fails, and says so", async () => {
    const f = await fixture();
    state.rmError = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    await expect(build(f)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not remove"));
  });

  it("still removes the context", async () => {
    const f = await fixture();
    await build(f);
    expect(state.rmCalls.some((p) => /nbo-(image|fn-image|isrcache-image)-/.test(p))).toBe(true);
  });
});
