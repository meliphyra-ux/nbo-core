// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Vitest globalSetup: gives each test run its own temp folder and removes it
// afterwards, so tests that call mkdtemp(tmpdir()) never leave folders behind.
// Workers inherit TEMP/TMP/TMPDIR, so os.tmpdir() points at the run folder.
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let runDir;

export async function setup() {
  const base = tmpdir();
  mkdirSync(base, { recursive: true });
  runDir = await mkdtemp(join(base, "nbo-test-run-"));
  process.env.TEMP = runDir;
  process.env.TMP = runDir;
  process.env.TMPDIR = runDir;
  // Git must never read or lock the user's real global config during tests.
  const gitGlobal = join(runDir, "gitconfig-global");
  await writeFile(gitGlobal, "");
  process.env.GIT_CONFIG_GLOBAL = gitGlobal;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
}

export async function teardown() {
  if (!runDir) return;
  try {
    await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.warn(`could not remove ${runDir}: ${err instanceof Error ? err.message : err}`);
  }
}
