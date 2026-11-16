// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dev-mode (no connection) wiring of both targets, with every docker/
// kind/kubectl/gcloud boundary stubbed. functionImageHash, the config
// hashes and the manifest renderers stay real.
vi.mock("@nbo/adapter-k8s", async (importOriginal) => ({
  // Every CLI-spawning export throws unless stubbed below.
  ...(await import("./cli-guard.js")).guardCLI(
    await importOriginal<typeof import("@nbo/adapter-k8s")>(),
    "adapter-k8s",
    (await import("./cli-guard.js")).K8S_CLI_EXPORTS,
  ),
  buildImage: vi.fn().mockResolvedValue(undefined),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
  loadImageIntoKind: vi.fn().mockResolvedValue(undefined),
  apply: vi.fn().mockResolvedValue(undefined),
  waitForRollout: vi.fn().mockResolvedValue(undefined),
  liveFunctionState: vi.fn().mockResolvedValue(undefined),
  liveContentID: vi.fn().mockResolvedValue({ id: "", ok: false }),
}));
vi.mock("@nbo/adapter-cloudrun", async (importOriginal) => ({
  ...(await import("./cli-guard.js")).guardCLI(
    await importOriginal<typeof import("@nbo/adapter-cloudrun")>(),
    "adapter-cloudrun",
    (await import("./cli-guard.js")).CLOUDRUN_CLI_EXPORTS,
  ),
  deploy: vi.fn().mockImplementation(async (spec: { serviceName: string }) => `https://${spec.serviceName}.run.app`),
  pushImage: vi.fn().mockResolvedValue(undefined),
  defaultComputeServiceAccount: vi.fn().mockResolvedValue("123-compute@developer.gserviceaccount.com"),
  grantInvoker: vi.fn().mockResolvedValue(undefined),
  liveServiceState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const k8s = await import("@nbo/adapter-k8s");
const cr = await import("@nbo/adapter-cloudrun");
const { run } = await import("../run.js");
const { createKubernetesTarget } = await import("../kubernetes-target.js");
const { createCloudRunTarget } = await import("../cloudrun-target.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";

async function fixture(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "target-speedups-"));
  for (const n of names) {
    await mkdir(join(dir, "functions", n, "bundle"), { recursive: true });
    await writeFile(join(dir, "functions", n, "bundle", "index.mjs"), `export default () => "${n}";`);
    await writeFile(
      join(dir, "functions", n, "function.json"),
      JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }),
    );
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}

const names = ["f0", "f1", "f2", "f3", "f4", "f5"];

function trackBuilds(failFor?: string) {
  const state = { inFlight: 0, max: 0, started: [] as string[], settled: [] as string[] };
  vi.mocked(k8s.buildFunctionImage).mockImplementation(async (_bundle, fnJSON) => {
    const name = fnJSON.split(/[\\/]/).at(-2)!;
    state.started.push(name);
    state.inFlight++;
    state.max = Math.max(state.max, state.inFlight);
    try {
      await sleep(name === failFor ? 5 : 25);
      if (name === failFor) throw new Error(`docker build failed for ${name}`);
    } finally {
      state.inFlight--;
      state.settled.push(name);
    }
  });
  return state;
}

type Target = {
  deployer: { deployFunctions?: (d: string, a: string, n: string[]) => Promise<Record<string, string>> };
};
const targets: [string, () => Target, (n: string) => string][] = [
  ["kubernetes", () => createKubernetesTarget("myapp"), (n) => `http://myapp-fn-${n}:8080`],
  ["cloudrun", () => createCloudRunTarget("proj", "us-central1", "repo"), (n) => `https://myapp-fn-${n}.run.app`],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(k8s.buildFunctionImage).mockResolvedValue(undefined);
  vi.mocked(k8s.liveFunctionState).mockResolvedValue(undefined);
  vi.mocked(cr.liveServiceState).mockResolvedValue(undefined);
});

describe.each(targets)("%s deployFunctions", (_name, make, urlOf) => {
  it("deploys functions concurrently, at most 4 at once, keyed by name", async () => {
    const dir = await fixture(names);
    try {
      const state = trackBuilds();
      const urls = await make().deployer.deployFunctions!(dir, "myapp", names);
      expect(state.max).toBe(4);
      expect(state.started.sort()).toEqual(names);
      expect(urls).toEqual(Object.fromEntries(names.map((n) => [n, urlOf(n)])));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("fails with the first failure only after the in-flight functions settle", async () => {
    const dir = await fixture(names);
    try {
      const state = trackBuilds("f1");
      await expect(make().deployer.deployFunctions!(dir, "myapp", names)).rejects.toThrow("docker build failed for f1");
      expect(state.inFlight).toBe(0);
      expect(state.settled.sort()).toEqual(state.started.sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("kubernetes: unchanged functions are skipped only when healthy and identically configured", () => {
  // First deploy: what the image tag and the fn-config annotation are.
  async function firstDeploy(dir: string): Promise<{ tag: string; config: string }> {
    await createKubernetesTarget("myapp").deployer.deployFunctions(dir, "myapp", ["ssr"]);
    const tag = vi.mocked(k8s.buildFunctionImage).mock.calls[0]![2];
    const yaml = vi.mocked(k8s.apply).mock.calls[0]![0];
    const config = /nbo\.dev\/fn-config: "([0-9a-f]+)"/.exec(yaml)?.[1] ?? "";
    expect(tag).toMatch(/^nbo-fn-myapp-ssr:[0-9a-f]{24}$/);
    expect(config).toMatch(/^[0-9a-f]{24}$/);
    expect(vi.mocked(k8s.liveFunctionState)).toHaveBeenCalledWith("myapp-fn-ssr", undefined);
    vi.clearAllMocks();
    return { tag, config };
  }

  it("skips build/load/apply/rollout when the live Deployment is healthy, on that image and that config", async () => {
    const dir = await fixture(["ssr"]);
    try {
      const { tag, config } = await firstDeploy(dir);
      vi.mocked(k8s.liveFunctionState).mockResolvedValue({ image: tag, config, healthy: true });
      const messages: string[] = [];
      const urls = await createKubernetesTarget("myapp", undefined, {
        onProgress: (m) => messages.push(m),
      }).deployer.deployFunctions(dir, "myapp", ["ssr"]);
      expect(urls).toEqual({ ssr: "http://myapp-fn-ssr:8080" });
      expect(k8s.buildFunctionImage).not.toHaveBeenCalled();
      expect(k8s.loadImageIntoKind).not.toHaveBeenCalled();
      expect(k8s.apply).not.toHaveBeenCalled();
      expect(k8s.waitForRollout).not.toHaveBeenCalled();
      expect(messages).toEqual(["function ssr: unchanged, skipped"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("redeploys when the rollout is not healthy (e.g. timed out, old ReplicaSet still serving)", async () => {
    const dir = await fixture(["ssr"]);
    try {
      const { tag, config } = await firstDeploy(dir);
      vi.mocked(k8s.liveFunctionState).mockResolvedValue({ image: tag, config, healthy: false });
      await createKubernetesTarget("myapp").deployer.deployFunctions(dir, "myapp", ["ssr"]);
      expect(k8s.buildFunctionImage).toHaveBeenCalledTimes(1);
      expect(k8s.apply).toHaveBeenCalledTimes(1);
      expect(k8s.waitForRollout).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("redeploys when the image matches but the deploy config differs (or the annotation is missing)", async () => {
    const dir = await fixture(["ssr"]);
    try {
      const { tag } = await firstDeploy(dir);
      for (const config of ["0123456789abcdef01234567", ""]) {
        vi.clearAllMocks();
        vi.mocked(k8s.liveFunctionState).mockResolvedValue({ image: tag, config, healthy: true });
        await createKubernetesTarget("myapp").deployer.deployFunctions(dir, "myapp", ["ssr"]);
        expect(k8s.apply).toHaveBeenCalledTimes(1);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("a changed bundle gets a new tag and is redeployed", async () => {
    const dir = await fixture(["ssr"]);
    try {
      const { tag, config } = await firstDeploy(dir);
      vi.mocked(k8s.liveFunctionState).mockResolvedValue({ image: tag, config, healthy: true });
      await writeFile(join(dir, "functions", "ssr", "bundle", "index.mjs"), "export default () => 'changed';");
      await createKubernetesTarget("myapp").deployer.deployFunctions(dir, "myapp", ["ssr"]);
      expect(k8s.buildFunctionImage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(k8s.buildFunctionImage).mock.calls[0]![2]).not.toBe(tag);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("a changed env value gets a new tag, and the value never reaches progress", async () => {
    const dir = await fixture(["ssr"]);
    try {
      const messages: string[] = [];
      const a = createKubernetesTarget("myapp", undefined, { onProgress: (m) => messages.push(m) });
      a.extraEnv = { NBO_CRON_SIGNING_SECRET: "first-secret" };
      await a.deployer.deployFunctions(dir, "myapp", ["ssr"]);
      const b = createKubernetesTarget("myapp", undefined, { onProgress: (m) => messages.push(m) });
      b.extraEnv = { NBO_CRON_SIGNING_SECRET: "second-secret" };
      await b.deployer.deployFunctions(dir, "myapp", ["ssr"]);
      const [t1, t2] = vi.mocked(k8s.buildFunctionImage).mock.calls.map((c) => c[2]);
      expect(t1).not.toBe(t2);
      expect(messages.join("\n")).not.toMatch(/secret/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("cloudrun: unchanged functions are skipped only when ready and identically configured", () => {
  async function firstDeploy(dir: string): Promise<{ image: string; config: string }> {
    await createCloudRunTarget("proj", "us-central1", "repo").deployer.deployFunctions!(dir, "myapp", ["ssr"]);
    const spec = vi.mocked(cr.deploy).mock.calls[0]![0];
    expect(spec.imageTag).toMatch(/^repo\/nbo-fn-myapp-ssr:[0-9a-f]{24}$/);
    expect(spec.fnConfig).toMatch(/^[0-9a-f]{32}$/);
    expect(vi.mocked(cr.liveServiceState)).toHaveBeenCalledWith("myapp-fn-ssr", "proj", "us-central1");
    vi.clearAllMocks();
    return { image: spec.imageTag, config: spec.fnConfig! };
  }

  it("skips build/push/deploy when the live service is ready, on that image and that config, but still grants invoker", async () => {
    const dir = await fixture(["ssr"]);
    try {
      const { image, config } = await firstDeploy(dir);
      vi.mocked(cr.liveServiceState).mockResolvedValue({
        image,
        config,
        ready: true,
        url: "https://myapp-fn-ssr-live.run.app",
      });
      const messages: string[] = [];
      let t = 0;
      const target = createCloudRunTarget("proj", "us-central1", "repo", undefined, {
        onProgress: (m) => messages.push(m),
        now: () => (t += 1000),
      });
      const urls = await target.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
      expect(urls).toEqual({ ssr: "https://myapp-fn-ssr-live.run.app" });
      expect(k8s.buildFunctionImage).not.toHaveBeenCalled();
      expect(cr.pushImage).not.toHaveBeenCalled();
      expect(cr.deploy).not.toHaveBeenCalled();
      expect(cr.grantInvoker).toHaveBeenCalledWith(
        "myapp-fn-ssr",
        "proj",
        "us-central1",
        "123-compute@developer.gserviceaccount.com",
      );
      expect(messages).toEqual(["function ssr: unchanged, skipped", "function ssr: invoker granted in 1.0s"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("redeploys when the latest revision never became ready", async () => {
    const dir = await fixture(["ssr"]);
    try {
      const { image, config } = await firstDeploy(dir);
      vi.mocked(cr.liveServiceState).mockResolvedValue({ image, config, ready: false, url: "https://x.run.app" });
      await createCloudRunTarget("proj", "us-central1", "repo").deployer.deployFunctions!(dir, "myapp", ["ssr"]);
      expect(cr.deploy).toHaveBeenCalledTimes(1);
      expect(cr.grantInvoker).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("redeploys when the image matches but the deploy config differs", async () => {
    const dir = await fixture(["ssr"]);
    try {
      const { image } = await firstDeploy(dir);
      vi.mocked(cr.liveServiceState).mockResolvedValue({
        image,
        config: "0".repeat(32),
        ready: true,
        url: "https://x.run.app",
      });
      await createCloudRunTarget("proj", "us-central1", "repo").deployer.deployFunctions!(dir, "myapp", ["ssr"]);
      expect(cr.deploy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("redeploys when the live service runs a different image", async () => {
    const dir = await fixture(["ssr"]);
    try {
      vi.mocked(cr.liveServiceState).mockResolvedValue({
        image: "repo/nbo-fn-myapp-ssr:20261101000000",
        config: "",
        ready: true,
        url: "https://old.run.app",
      });
      const urls = await createCloudRunTarget("proj", "us-central1", "repo").deployer.deployFunctions!(dir, "myapp", [
        "ssr",
      ]);
      expect(cr.deploy).toHaveBeenCalledTimes(1);
      expect(cr.grantInvoker).toHaveBeenCalledTimes(1);
      expect(urls).toEqual({ ssr: "https://myapp-fn-ssr.run.app" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("the CLI bundle is shared, not raced", () => {
  const buildCalls = () => vi.mocked(run).mock.calls.filter((c) => c[0] === "pnpm" && c[1].includes("build")).length;

  it("two environments deploying the same build concurrently prepare it once", async () => {
    const dir = await fixture([]);
    try {
      const a = createKubernetesTarget("p1-k8s");
      const b = createCloudRunTarget("proj", "us-central1", "repo");
      await Promise.all([
        a.deployer.buildAndDeploy(dir, "p1-k8s", id),
        b.deployer.buildAndDeploy(dir, "p1-cloudrun", id),
      ]);
      expect(buildCalls()).toBe(1);
      const ctxDirs = new Set([
        vi.mocked(k8s.buildImage).mock.calls[0]![1],
        vi.mocked(k8s.buildImage).mock.calls[1]![1],
      ]);
      expect(ctxDirs.size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
