// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { buildImage } from "@nbo/adapter-k8s";
import { prepareCliDeployDir } from "../kubernetes-target.js";
import { run } from "../run.js";

let dockerAvailable = true;
try {
  execFileSync("docker", ["--version"]);
} catch {
  dockerAvailable = false;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// Final-review finding C2, closing proof: every other image.test.ts
// fixture (in @nbo/adapter-k8s) uses a PLACEHOLDER cli-deploy dir
// (a dist/main.js stub, no real node_modules at all) and never
// actually starts the built image's container — so neither the
// cross-platform native-addon fix (sharp/re2) nor the transitive-
// dependency hoisting fix (ajv, unreachable under pnpm's default
// isolated linker once the deploy dir is relocated into a Docker
// build context — confirmed directly during this finding's own
// investigation) was ever exercised by a real build-and-run before
// this test. This is the one test in the whole rewrite that uses a
// REAL `prepareCliDeployDir()` output, in a REAL `buildImage`, and
// actually starts the container and serves a real HTTP request from
// it — proving the full chain a person deploying a real app depends
// on, not just that `docker build` exits 0.
describe.skipIf(!dockerAvailable)("a real pnpm-deployed @nbo/cli artifact, built and run for real", () => {
  it("serves a real .nbo site's content over HTTP from inside the built image", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "cli-deploy-image-nbo-"));
    // The built producer (pnpm build), as verify-step0.sh runs it: the
    // package has no tsx since the knip audit removed it.
    const producer = join(repoRoot, "packages", "producer-static", "dist", "cli.js");
    if (!existsSync(producer)) throw new Error(`${producer} is missing: run pnpm build first`);
    await run("node", [producer, join(repoRoot, "fixtures", "static-site"), "--out", nboDir]);

    const cliDeployDir = await prepareCliDeployDir();
    const tag = "nbo-cli-deploy-image-test:latest";
    let containerID: string | undefined;

    try {
      await buildImage(nboDir, cliDeployDir, tag);

      containerID = execFileSync("docker", ["run", "-d", "-p", "18099:8080", tag]).toString().trim();

      let lastErr: unknown;
      for (let i = 0; i < 20; i++) {
        try {
          const res = await fetch("http://127.0.0.1:18099/");
          expect(res.status).toBe(200);
          const body = await res.text();
          expect(body).toContain("static-site home");
          return;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      throw lastErr;
    } finally {
      if (containerID) execFileSync("docker", ["rm", "-f", containerID]);
      try {
        execFileSync("docker", ["rmi", "-f", tag]);
      } catch {
        // best-effort cleanup
      }
      await rm(nboDir, { recursive: true, force: true });
      await rm(cliDeployDir, { recursive: true, force: true });
    }
  }, 180000);
});
