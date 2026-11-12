// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
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
  isrcacheObjectName: (app: string) => `${app}-isr`,
  isrcacheImageTag: vi.fn().mockResolvedValue("nbo-isrcache:0123456789ab"),
  buildIsrcacheImage: vi.fn().mockResolvedValue(undefined),
  renderIsrcacheManifests: vi.fn().mockReturnValue("isr-yaml"),
  deleteIsrcache: vi.fn().mockResolvedValue(undefined),
  isrcacheNameTaken: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const { buildImage, buildFunctionImage } = await import("@nbo/adapter-k8s");
const { createKubernetesTarget } = await import("../kubernetes-target.js");

// crossCompileLinuxBinary's own real-toolchain test lives in
// cross-compile.test.ts, deliberately unmocked — see that file's own
// comment for why it can't share this one.
describe("createKubernetesTarget", () => {
  it("stores extraEnv when set", () => {
    const target = createKubernetesTarget("myapp");
    target.extraEnv = { NBO_CRON_SIGNING_SECRET: "s3cr3t" };
    expect(target.extraEnv.NBO_CRON_SIGNING_SECRET).toBe("s3cr3t");
  });

  // F1 from the final review: the test above only proves the
  // property itself is settable/readable — it would pass even if
  // buildAndDeploy's own closure captured extraEnv's *value* at
  // construction time instead of reading the live object. This test
  // exercises the real closure path extraEnv exists for.
  it("reaches buildImage's own envVars once extraEnv is set after construction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k8s-target-extraenv-"));
    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));

      const target = createKubernetesTarget("myapp");
      target.extraEnv = { NBO_CRON_SIGNING_SECRET: "s3cr3t" };

      await target.deployer.buildAndDeploy(dir, "myapp", "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1");

      const envVarsArg = vi.mocked(buildImage).mock.calls.at(-1)?.[4];
      expect(envVarsArg).toMatchObject({ NBO_CRON_SIGNING_SECRET: "s3cr3t" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  // Real bug found running Slice 4's crons verify script for real:
  // deployFunctions never passed extraEnv (or any deploy-time env
  // var) through to buildFunctionImage at all — only buildAndDeploy's
  // own call for the main app image got it. A deployed function's
  // container never received a cron signing secret, or any
  // binding/secret, as a result.
  it("reaches buildFunctionImage's own envVars once extraEnv is set after construction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k8s-target-fn-extraenv-"));
    try {
      await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
      await writeFile(join(dir, "functions", "ssr", "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));

      const target = createKubernetesTarget("myapp");
      target.extraEnv = { NBO_CRON_SIGNING_SECRET: "s3cr3t" };

      await target.deployer.deployFunctions(dir, "myapp", ["ssr"]);

      const envVarsArg = vi.mocked(buildFunctionImage).mock.calls.at(-1)?.[3];
      expect(envVarsArg).toMatchObject({ NBO_CRON_SIGNING_SECRET: "s3cr3t" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("createKubernetesTarget ISR cache", () => {
  const id = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";
  async function fixture(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "k8s-target-isr-"));
    await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
    await writeFile(join(dir, "functions", "ssr", "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
    return dir;
  }

  it("defines the cache steps only while isr says so, read at call time", () => {
    const target = createKubernetesTarget("myapp");
    expect(target.deployer.deployIsrCache).toBeUndefined();
    expect(target.deployer.removeIsrCache).toBeUndefined();
    target.isr = { enabled: true, removeCache: false };
    expect(target.deployer.deployIsrCache).toBeTypeOf("function");
    expect(target.deployer.removeIsrCache).toBeUndefined();
    target.isr = { enabled: false, removeCache: true };
    expect(target.deployer.deployIsrCache).toBeUndefined();
    expect(target.deployer.removeIsrCache).toBeTypeOf("function");
  });

  it("builds and ships the cache once, applies it before any function and waits for it, then bakes its URL as __isrcache", async () => {
    const k8s = await import("@nbo/adapter-k8s");
    vi.mocked(k8s.buildIsrcacheImage).mockClear();
    vi.mocked(k8s.loadImageIntoKind).mockClear();
    vi.mocked(k8s.apply).mockClear();
    vi.mocked(k8s.waitForRollout).mockClear();
    const dir = await fixture();
    try {
      const target = createKubernetesTarget("myapp");
      target.isr = { enabled: true, removeCache: false };
      const url = await target.deployer.deployIsrCache!(dir, "myapp");
      expect(url).toBe("http://myapp-isr:8080");
      await target.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "myapp", id);

      expect(vi.mocked(k8s.buildIsrcacheImage)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(k8s.buildIsrcacheImage).mock.calls[0]![1]).toBe("nbo-isrcache:0123456789ab");
      expect(vi.mocked(k8s.loadImageIntoKind).mock.calls.filter((c) => c[0] === "nbo-isrcache:0123456789ab")).toHaveLength(1);
      expect(vi.mocked(k8s.renderIsrcacheManifests)).toHaveBeenLastCalledWith({ appName: "myapp", imageTag: "nbo-isrcache:0123456789ab" });

      const applied = vi.mocked(k8s.apply).mock.calls.map((c) => c[0]);
      expect(applied.indexOf("isr-yaml")).toBe(0);
      const order = vi.mocked(k8s.apply).mock.invocationCallOrder;
      const cacheRollout = vi.mocked(k8s.waitForRollout).mock.calls.findIndex((c) => c[0] === "myapp-isr");
      expect(cacheRollout).toBe(0);
      // The cache's rollout is awaited before the first function manifest is applied.
      expect(vi.mocked(k8s.waitForRollout).mock.invocationCallOrder[0]!).toBeLessThan(order[1]!);

      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[3]).toEqual({ ssr: "http://myapp-fn-ssr:8080", __isrcache: "http://myapp-isr:8080" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("bakes no __isrcache when no cache was deployed", async () => {
    const dir = await fixture();
    try {
      const target = createKubernetesTarget("myapp");
      target.isr = { enabled: true, removeCache: false };
      await target.deployer.buildAndDeploy(dir, "myapp", id);
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[3]).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("drops NBO's own NBO_ISRCACHE_URL from the app image when it runs its own cache", async () => {
    const dir = await fixture();
    const before = process.env.NBO_ISRCACHE_URL;
    process.env.NBO_ISRCACHE_URL = "http://operator-cache:8080";
    try {
      const target = createKubernetesTarget("myapp");
      await target.deployer.buildAndDeploy(dir, "myapp", id);
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[4]).toMatchObject({ NBO_ISRCACHE_URL: "http://operator-cache:8080" });
      target.isr = { enabled: true, removeCache: false };
      await target.deployer.buildAndDeploy(dir, "myapp", id);
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[4]).not.toHaveProperty("NBO_ISRCACHE_URL");
    } finally {
      if (before === undefined) delete process.env.NBO_ISRCACHE_URL;
      else process.env.NBO_ISRCACHE_URL = before;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("refuses to apply over a live object with the cache's name that isn't this app's cache (another stage's function)", async () => {
    const k8s = await import("@nbo/adapter-k8s");
    vi.mocked(k8s.buildIsrcacheImage).mockClear();
    vi.mocked(k8s.apply).mockClear();
    // Stage a's function x-k8s-isr is Deployment pabc-s-a-k8s-fn-x-k8s-isr; stage a-k8s-fn-x's app is pabc-s-a-k8s-fn-x-k8s.
    vi.mocked(k8s.isrcacheNameTaken).mockResolvedValueOnce("Deployment pabc-s-a-k8s-fn-x-k8s-isr");
    const dir = await fixture();
    try {
      const target = createKubernetesTarget("pabc-s-a-k8s-fn-x-k8s");
      target.isr = { enabled: true, removeCache: false };
      await expect(target.deployer.deployIsrCache!(dir, "pabc-s-a-k8s-fn-x-k8s")).rejects.toThrow(/Deployment pabc-s-a-k8s-fn-x-k8s-isr.*not this app's ISR cache/);
      expect(vi.mocked(k8s.buildIsrcacheImage)).not.toHaveBeenCalled();
      expect(vi.mocked(k8s.apply)).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("a failing ownership read rejects with secret values redacted", async () => {
    const k8s = await import("@nbo/adapter-k8s");
    vi.mocked(k8s.isrcacheNameTaken).mockRejectedValueOnce(new Error("kubectl get failed: hunter2-secret"));
    const dir = await fixture();
    try {
      const target = createKubernetesTarget("myapp");
      target.userEnv = { vars: { API_KEY: "hunter2-secret" }, secretNames: ["API_KEY"], fingerprint: "fp" };
      target.isr = { enabled: true, removeCache: false };
      const err = await target.deployer.deployIsrCache!(dir, "myapp").then(
        () => null,
        (e: Error) => e,
      );
      expect(err!.message).toContain("[redacted]");
      expect(err!.message).not.toContain("hunter2-secret");
      expect(err!.cause).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("refuses to deploy a cache whose name is another environment's app", async () => {
    const k8s = await import("@nbo/adapter-k8s");
    vi.mocked(k8s.buildIsrcacheImage).mockClear();
    vi.mocked(k8s.apply).mockClear();
    const dir = await fixture();
    try {
      const target = createKubernetesTarget("pabc-k8s");
      target.isr = { enabled: true, removeCache: false };
      target.otherAppNames = ["pabc-k8s-isr"];
      await expect(target.deployer.deployIsrCache!(dir, "pabc-k8s")).rejects.toThrow(/pabc-k8s-isr.*another environment/);
      expect(vi.mocked(k8s.buildIsrcacheImage)).not.toHaveBeenCalled();
      expect(vi.mocked(k8s.apply)).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("removeIsrCache deletes the cache objects", async () => {
    const k8s = await import("@nbo/adapter-k8s");
    const target = createKubernetesTarget("myapp");
    target.isr = { enabled: true, removeCache: true };
    await target.deployer.removeIsrCache!("myapp");
    expect(vi.mocked(k8s.deleteIsrcache)).toHaveBeenLastCalledWith("myapp", undefined);
  });

  it("removeIsrCache rejects with secret values redacted and no cause", async () => {
    const k8s = await import("@nbo/adapter-k8s");
    vi.mocked(k8s.deleteIsrcache).mockRejectedValueOnce(new Error("kubectl failed: token hunter2-secret leaked"));
    const target = createKubernetesTarget("myapp");
    target.userEnv = { vars: { API_KEY: "hunter2-secret" }, secretNames: ["API_KEY"], fingerprint: "fp" };
    target.isr = { enabled: false, removeCache: true };
    const err = await target.deployer.removeIsrCache!("myapp").then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("hunter2-secret");
    expect(err!.message).toContain("[redacted]");
    expect(err!.cause).toBeUndefined();
  });
});
