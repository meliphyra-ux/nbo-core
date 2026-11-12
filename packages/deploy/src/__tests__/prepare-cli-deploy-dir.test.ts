// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { rm, readdir, readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { prepareCliDeployDir } from "../kubernetes-target.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const cliDistDir = join(repoRoot, "packages", "cli", "dist");

// Deliberately its own file, with nothing mocked — this is the one
// test in this package that exercises the real toolchain end to end
// (no skip guard, matching Go's own un-skip-guarded
// TestCrossCompileLinuxBinary_ReturnsADifferentPathEachCall this test
// replaces; its own real-toolchain cost moved from `go build` to
// `pnpm deploy`). kubernetes-target.test.ts mocks ../run.js for its
// own closure-wiring tests, which would otherwise silently turn this
// into a no-op mock call instead of a real deploy if it lived there.
//
// On Windows, this is also the one real proof in this whole plan that
// the cross-spawn swap (run.ts) actually resolves the pnpm .cmd-shim
// problem (Review Focus) — a plain spawn("pnpm", ...) fails with
// ENOENT here, confirmed directly during this task's own research.
describe("prepareCliDeployDir", () => {
  it("returns a different, real, non-empty directory each call", async () => {
    const dir1 = await prepareCliDeployDir();
    const dir2 = await prepareCliDeployDir();
    try {
      expect(dir1).not.toBe(dir2);
      expect(await readdir(dir1)).not.toHaveLength(0);
      expect(await readdir(dir2)).not.toHaveLength(0);
    } finally {
      // Go's own crossCompileLinuxBinary never cleaned up its temp
      // dir either (real, intentional parity there) — but a test
      // calling the real deploy on every run shouldn't accumulate a
      // full node_modules per call forever.
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  }, 60000);

  // Final-review finding C1: this function must build @nbo/cli (and
  // its workspace dependencies) fresh from current source itself,
  // never trust that whoever last ran `pnpm build` left a correct
  // dist/ lying around — Go's own crossCompileLinuxBinary always
  // compiled fresh from source on every call; a TS port that instead
  // `pnpm deploy`s whatever dist/ happens to already exist on disk
  // would silently ship stale or entirely missing compiled output.
  // Confirmed directly before this fix: deleting @nbo/cli's own
  // dist/ and calling prepareCliDeployDir() produced a deploy
  // directory with no dist/main.js in it at all.
  it("builds @nbo/cli fresh even when its dist/ is missing beforehand", async () => {
    await rm(cliDistDir, { recursive: true, force: true });

    const dir = await prepareCliDeployDir();
    try {
      const mainJs = await readFile(join(dir, "dist", "main.js"), "utf8");
      expect(mainJs.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  // Final-review finding C2: pnpm's own default (non-hoisted)
  // "isolated" linker resolves a transitive dependency (one @nbo/cli
  // doesn't depend on directly, only through @nbo/validate/@nbo/router)
  // ONLY via a virtual-store symlink chain that relies on the package
  // using it (@nbo/validate) continuing to live inside that same
  // virtual store — confirmed directly: dereference-copying (or
  // Docker COPYing) the deploy output elsewhere breaks that chain,
  // because the top-level @nbo/validate entry ends up isolated from
  // its own sibling dependencies once relocated. Hoisted linking
  // puts every dependency — direct or transitive — as a real,
  // self-contained top-level node_modules entry, which survives
  // being copied or moved anywhere, including into a Docker build
  // context. ajv is never a direct dependency of @nbo/cli itself —
  // only @nbo/validate's own — so its presence as a real top-level
  // entry is a direct proof hoisting is actually in effect, not an
  // accident of it already being there for some other reason.
  it("hoists a transitive dependency to a real top-level node_modules entry, so it survives relocation", async () => {
    const dir = await prepareCliDeployDir();
    try {
      const st = await lstat(join(dir, "node_modules", "ajv"));
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});
