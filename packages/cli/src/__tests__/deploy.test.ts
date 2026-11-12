// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseDeployArgs, runDeploy } from "../deploy.js";

describe("parseDeployArgs", () => {
  it("defaults target to kubernetes with no --target given", () => {
    expect(parseDeployArgs(["dir", "--app", "myapp"])).toEqual({ dir: "dir", appName: "myapp", target: "kubernetes" });
  });

  it("parses --app and --target regardless of order", () => {
    expect(parseDeployArgs(["dir", "--target", "cloudrun", "--app", "myapp"])).toEqual({ dir: "dir", appName: "myapp", target: "cloudrun" });
  });
});

describe("runDeploy", () => {
  const envVars = ["NBO_GCP_PROJECT", "NBO_GCP_REGION", "NBO_AR_REPO"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of envVars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of envVars) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
  });

  it("missing --app returns 1 with the usage message", async () => {
    expect(await runDeploy(["dir"])).toBe(1);
  });

  it("target cloudrun with NBO_GCP_PROJECT unset returns 1 naming it", async () => {
    process.env.NBO_GCP_REGION = "us-central1";
    process.env.NBO_AR_REPO = "repo";

    expect(await runDeploy(["dir", "--app", "myapp", "--target", "cloudrun"])).toBe(1);
  });

  it("target cloudrun with NBO_GCP_REGION unset returns 1 naming it", async () => {
    process.env.NBO_GCP_PROJECT = "proj";
    process.env.NBO_AR_REPO = "repo";

    expect(await runDeploy(["dir", "--app", "myapp", "--target", "cloudrun"])).toBe(1);
  });

  it("target cloudrun with NBO_AR_REPO unset returns 1 naming it", async () => {
    process.env.NBO_GCP_PROJECT = "proj";
    process.env.NBO_GCP_REGION = "us-central1";

    expect(await runDeploy(["dir", "--app", "myapp", "--target", "cloudrun"])).toBe(1);
  });
});
