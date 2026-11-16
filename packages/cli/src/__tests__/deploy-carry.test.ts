// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";

const kubeTarget = { deployer: {}, extraEnv: {} } as { deployer: object; extraEnv: object; carryFrom?: string };
vi.mock("@nbo/deploy", () => ({
  deploy: vi.fn().mockResolvedValue({ plan: "", url: "http://x", contentID: "sha256:abc", alreadyLive: false }),
  createKubernetesTarget: vi.fn(() => kubeTarget),
  createCloudRunTarget: vi.fn(),
}));

const { parseDeployArgs, runDeploy } = await import("../deploy.js");

describe("nbo deploy --carry-from", () => {
  it("parses --carry-from and leaves it out when absent", () => {
    expect(parseDeployArgs(["dir", "--app", "a", "--carry-from", "/prev"])).toEqual({
      dir: "dir",
      appName: "a",
      target: "kubernetes",
      carryFrom: "/prev",
    });
    expect(parseDeployArgs(["dir", "--app", "a"])).not.toHaveProperty("carryFrom");
  });

  it("sets carryFrom on the target before deploying", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runDeploy(["dir", "--app", "a", "--carry-from", "/prev"])).toBe(0);
    log.mockRestore();
    expect(kubeTarget.carryFrom).toBe("/prev");
  });
});
