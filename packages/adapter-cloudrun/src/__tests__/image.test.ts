// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushImage } from "../image.js";

const repo = process.env.NBO_TEST_AR_REPO; // e.g. europe-north1-docker.pkg.dev/my-gcp-project/nbo

let dockerAvailable = true;
try {
  execFileSync("docker", ["--version"]);
} catch {
  dockerAvailable = false;
}

describe.skipIf(!repo || !dockerAvailable)("pushImage", () => {
  it("pushes to Artifact Registry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapter-cloudrun-push-"));
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\nCOPY Dockerfile /x\n");
    const localTag = "nbo-cloudrun-push-test:latest";
    execFileSync("docker", ["build", "-t", localTag, dir]);
    try {
      const remoteTag = `${repo}/push-test:${Date.now()}`;
      await expect(pushImage(localTag, remoteTag)).resolves.toBeUndefined();
    } finally {
      execFileSync("docker", ["rmi", "-f", localTag]);
    }
  });
});
