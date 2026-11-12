// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@nbo/adapter-k8s", () => ({
  capabilities: { name: "kubernetes" },
  buildImage: vi.fn().mockResolvedValue(undefined),
  appBakedHash: vi.fn().mockResolvedValue("0123abcd"),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
  loadImageIntoKind: vi.fn().mockResolvedValue(undefined),
  renderManifests: vi.fn().mockReturnValue("yaml"),
  renderFunctionManifests: vi.fn().mockReturnValue("yaml"),
  apply: vi.fn().mockResolvedValue(undefined),
  waitForRollout: vi.fn().mockResolvedValue(undefined),
  liveContentID: vi.fn().mockResolvedValue({ id: "", ok: false }),
  liveFunctionState: vi.fn().mockResolvedValue(undefined),
  functionConfigHash: () => "0123456789abcdef01234567",
  functionObjectName: (app: string, fn: string) => `${app}-fn-${fn}`,
  kubeName: (name: string) => name,
  functionImageHash: vi.fn().mockResolvedValue("0123456789abcdef01234567"),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const { loadImageIntoKind } = await import("@nbo/adapter-k8s");
const { createKubernetesTarget } = await import("../kubernetes-target.js");

const ID = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";

async function nboWithFunction(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k8s-kind-cluster-"));
  await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
  await writeFile(join(dir, "functions", "ssr", "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}

// The kind cluster `kind load` targets (dev mode only): NBO_KIND_CLUSTER,
// default nbo-local, so a CI cluster with another name gets the images.
describe("kind cluster name", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(loadImageIntoKind).mockClear();
  });

  it("defaults to nbo-local for the app and its functions", async () => {
    vi.stubEnv("NBO_KIND_CLUSTER", "");
    const dir = await nboWithFunction();
    try {
      const target = createKubernetesTarget("myapp");
      await target.deployer.deployFunctions(dir, "myapp", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "myapp", ID);
      const names = vi.mocked(loadImageIntoKind).mock.calls.map((c) => c[1]);
      expect(names).toEqual(["nbo-local", "nbo-local"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("uses NBO_KIND_CLUSTER when set", async () => {
    vi.stubEnv("NBO_KIND_CLUSTER", "nbo-ci");
    const dir = await nboWithFunction();
    try {
      const target = createKubernetesTarget("myapp");
      await target.deployer.deployFunctions(dir, "myapp", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "myapp", ID);
      const names = vi.mocked(loadImageIntoKind).mock.calls.map((c) => c[1]);
      expect(names).toEqual(["nbo-ci", "nbo-ci"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
