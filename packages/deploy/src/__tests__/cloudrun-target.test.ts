// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@nbo/adapter-k8s", () => ({
  buildImage: vi.fn().mockResolvedValue(undefined),
  appBakedHash: vi.fn().mockResolvedValue("0123abcd"),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
  functionImageHash: vi.fn().mockResolvedValue("0123456789abcdef01234567"),
  isrcacheImageTag: vi.fn().mockResolvedValue("nbo-isrcache:0123456789ab"),
  buildIsrcacheImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@nbo/adapter-cloudrun", () => ({
  capabilities: { name: "cloudrun" },
  deploy: vi.fn().mockResolvedValue("https://myapp-abc123-uc.a.run.app"),
  liveContentID: vi.fn().mockResolvedValue({ id: "", ok: false }),
  liveServiceState: vi.fn().mockResolvedValue(undefined),
  functionDeployConfigHash: () => "0123456789abcdef0123456789abcdef",
  serviceIdentityEmail: (project: string, service: string) => `${service}@${project}.iam.gserviceaccount.com`,
  pushImage: vi.fn().mockResolvedValue(undefined),
  defaultComputeServiceAccount: vi.fn().mockResolvedValue("123-compute@developer.gserviceaccount.com"),
  grantInvoker: vi.fn().mockResolvedValue(undefined),
  contentIDLabel: (id: string) => id.replace(/^sha256:/, "").slice(0, 32),
  ensureServiceIdentity: vi.fn().mockResolvedValue("sa@p.iam.gserviceaccount.com"),
  deleteService: vi.fn().mockResolvedValue(undefined),
  serviceLabels: vi.fn().mockResolvedValue({ "nbo-role": "isrcache", "nbo-app": "myapp" }),
  isIsrcacheServiceOf: (labels: Record<string, string> | undefined, app: string) => labels?.["nbo-role"] === "isrcache" && labels["nbo-app"] === app,
  isrcacheServiceLabels: (app: string) => ({ "nbo-role": "isrcache", "nbo-app": app }),
  deleteServiceIdentity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const { buildImage, buildFunctionImage } = await import("@nbo/adapter-k8s");
const { defaultComputeServiceAccount } = await import("@nbo/adapter-cloudrun");
const { createCloudRunTarget } = await import("../cloudrun-target.js");

describe("createCloudRunTarget", () => {
  it("wires capabilities and idsMatch against the truncated label form", () => {
    const target = createCloudRunTarget("p", "r", "repo");

    expect(target.deployer.capabilities?.name).toBe("cloudrun");

    const fullID = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";
    expect(target.deployer.idsMatch?.("4b66654e468e0ed5a8fb3146fff2ca53", fullID)).toBe(true);

    expect(target.appURL).toBe("");
  });

  it("stores extraEnv when set", () => {
    const target = createCloudRunTarget("proj", "region", "repo");
    target.extraEnv = { NBO_CRON_SIGNING_SECRET: "s3cr3t" };
    expect(target.extraEnv.NBO_CRON_SIGNING_SECRET).toBe("s3cr3t");
  });

  // F1 from the final review: the two tests above only prove the
  // properties themselves are settable/readable, not that the
  // closures inside `deployer` actually read the live object. These
  // exercise the real paths extraEnv/appURL exist for.
  it("reaches buildImage's own envVars once extraEnv is set after construction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloudrun-target-extraenv-"));
    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));

      const target = createCloudRunTarget("proj", "region", "repo");
      target.extraEnv = { NBO_CRON_SIGNING_SECRET: "s3cr3t" };

      await target.deployer.buildAndDeploy(dir, "myapp", "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1");

      const envVarsArg = vi.mocked(buildImage).mock.calls.at(-1)?.[4];
      expect(envVarsArg).toMatchObject({ NBO_CRON_SIGNING_SECRET: "s3cr3t" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("sets appURL to the real deploy() result after buildAndDeploy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloudrun-target-appurl-"));
    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));

      const target = createCloudRunTarget("proj", "region", "repo");
      expect(target.appURL).toBe("");

      await target.deployer.buildAndDeploy(dir, "myapp", "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1");

      expect(target.appURL).toBe("https://myapp-abc123-uc.a.run.app");
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
    const dir = await mkdtemp(join(tmpdir(), "cloudrun-target-fn-extraenv-"));
    try {
      await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
      await writeFile(join(dir, "functions", "ssr", "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));

      const target = createCloudRunTarget("proj", "region", "repo");
      target.extraEnv = { NBO_CRON_SIGNING_SECRET: "s3cr3t" };

      await target.deployer.deployFunctions!(dir, "myapp", ["ssr"]);

      const envVarsArg = vi.mocked(buildFunctionImage).mock.calls.at(-1)?.[3];
      expect(envVarsArg).toMatchObject({ NBO_CRON_SIGNING_SECRET: "s3cr3t" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("never calls defaultComputeServiceAccount for a static-only build", async () => {
    // No vitest config clears mock call history between tests in this
    // file, and an earlier test now legitimately calls
    // defaultComputeServiceAccount for a real (non-empty) function
    // list — mockClear() here keeps this test's own assertion scoped
    // to its own call, not the whole file's running total.
    vi.mocked(defaultComputeServiceAccount).mockClear();
    const target = createCloudRunTarget("proj", "region", "repo");
    const urls = await target.deployer.deployFunctions!("unused-dir", "myapp", []);

    expect(urls).toEqual({});
    expect(defaultComputeServiceAccount).not.toHaveBeenCalled();
  });
});

describe("createCloudRunTarget ISR cache (dev)", () => {
  it("defines the cache steps only while isr says so, read at call time", () => {
    const target = createCloudRunTarget("p", "r", "repo");
    expect(target.deployer.deployIsrCache).toBeUndefined();
    expect(target.deployer.removeIsrCache).toBeUndefined();
    target.isr = { enabled: true, removeCache: false };
    expect(target.deployer.deployIsrCache).toBeTypeOf("function");
    expect(target.deployer.removeIsrCache).toBeUndefined();
    target.isr = { enabled: false, removeCache: true };
    expect(target.deployer.deployIsrCache).toBeUndefined();
    expect(target.deployer.removeIsrCache).toBeTypeOf("function");
  });

  it("drops NBO's own NBO_ISRCACHE_URL from the app image when it runs its own cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloudrun-target-isr-env-"));
    const before = process.env.NBO_ISRCACHE_URL;
    process.env.NBO_ISRCACHE_URL = "http://operator-cache:8080";
    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
      const target = createCloudRunTarget("proj", "region", "repo");
      await target.deployer.buildAndDeploy(dir, "myapp", "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1");
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[4]).toMatchObject({ NBO_ISRCACHE_URL: "http://operator-cache:8080" });
      target.isr = { enabled: true, removeCache: false };
      await target.deployer.buildAndDeploy(dir, "myapp", "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1");
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[4]).not.toHaveProperty("NBO_ISRCACHE_URL");
    } finally {
      if (before === undefined) delete process.env.NBO_ISRCACHE_URL;
      else process.env.NBO_ISRCACHE_URL = before;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("dev removeIsrCache deletes the service but no service account", async () => {
    const cr = await import("@nbo/adapter-cloudrun");
    const target = createCloudRunTarget("proj", "region", "repo");
    target.isr = { enabled: false, removeCache: true };
    await target.deployer.removeIsrCache!("myapp");
    expect(vi.mocked(cr.deleteService)).toHaveBeenLastCalledWith("myapp-isr", "proj", "region");
    expect(vi.mocked(cr.deleteServiceIdentity)).not.toHaveBeenCalled();
  });
});
