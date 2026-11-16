// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dev-mode wiring of both targets with a user variable snapshot; every
// docker/kind/kubectl/gcloud boundary is stubbed, renderers and hashes
// stay real.
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
  deleteEnvSecret: vi.fn().mockResolvedValue(undefined),
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
  ensureSecretVersion: vi.fn().mockResolvedValue(true),
  grantSecretAccessor: vi.fn().mockResolvedValue(undefined),
  destroySupersededVersions: vi.fn().mockResolvedValue(undefined),
  removeSecretEnv: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const k8s = await import("@nbo/adapter-k8s");
const cr = await import("@nbo/adapter-cloudrun");
const { createKubernetesTarget } = await import("../kubernetes-target.js");
const { createCloudRunTarget } = await import("../cloudrun-target.js");

const id = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";

async function fixture(manifest: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "user-env-targets-"));
  await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
  await writeFile(join(dir, "functions", "ssr", "bundle", "index.mjs"), `export default () => "ssr";`);
  await writeFile(
    join(dir, "functions", "ssr", "function.json"),
    JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }),
  );
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0", ...manifest }));
  return dir;
}

const userEnv = (fingerprint: string | null) => ({
  vars: fingerprint ? { USER_A: "user-value" } : {},
  secretNames: [],
  fingerprint,
});

let dirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  dirs = [];
});
afterEach(async () => {
  delete process.env.USER_A;
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const appliedYAML = () => vi.mocked(k8s.apply).mock.calls.map((c) => c[0]);

describe("kubernetes target with user variables", () => {
  it("keeps user values out of image env, satisfies required names from them, and writes the fingerprint", async () => {
    // USER_A is required and only a user variable sets it; NBO's own
    // process.env value must not shadow it into env.json either.
    process.env.USER_A = "nbo-own-value";
    const dir = await fixture({ env: { required: ["USER_A"] } });
    dirs.push(dir);
    const target = createKubernetesTarget("myapp");
    target.extraEnv = { NBO_CRON_SIGNING_SECRET: "cron" };
    target.userEnv = userEnv("fp1");

    await target.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
    await target.deployer.buildAndDeploy(dir, "myapp", id);

    expect(vi.mocked(k8s.buildFunctionImage).mock.calls.at(-1)?.[3]).toEqual({ NBO_CRON_SIGNING_SECRET: "cron" });
    expect(vi.mocked(k8s.buildImage).mock.calls.at(-1)?.[4]).toEqual({ NBO_CRON_SIGNING_SECRET: "cron" });
    const yaml = appliedYAML();
    expect(yaml.find((y) => y.includes("name: myapp-fn-ssr"))).toContain('nbo.dev/env-fingerprint: "fp1"');
    expect(yaml.find((y) => y.includes("name: myapp\n"))).toContain('nbo.dev/env-fingerprint: "fp1"');
    expect(yaml.join("\n")).not.toContain("user-value");
  }, 30000);

  it("a null fingerprint renders exactly what a deploy without user variables renders", async () => {
    const dir = await fixture();
    dirs.push(dir);
    const plain = createKubernetesTarget("myapp");
    await plain.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
    await plain.deployer.buildAndDeploy(dir, "myapp", id);
    const before = appliedYAML();
    vi.mocked(k8s.apply).mockClear();

    const withNull = createKubernetesTarget("myapp");
    withNull.userEnv = userEnv(null);
    await withNull.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
    await withNull.deployer.buildAndDeploy(dir, "myapp", id);
    expect(appliedYAML()).toEqual(before);
    expect(before.join("\n")).not.toContain("env-fingerprint");
  }, 30000);

  it("NBO-provided names: extraEnv everywhere, NBO's own environment only in dev", () => {
    process.env.USER_A = "x";
    const dev = createKubernetesTarget("myapp");
    dev.extraEnv = { NBO_CRON_SIGNING_SECRET: "cron" };
    expect(dev.deployer.providedEnvNames!()).toEqual(expect.arrayContaining(["NBO_CRON_SIGNING_SECRET", "USER_A"]));

    const prod = createKubernetesTarget("myapp", {
      kubeconfig: "/kc",
      namespace: "nbo-p-x",
      registryPrefix: "r",
      registryEnv: {},
      pullSecret: { server: "s", username: "u", password: "p" },
      run: async () => "",
    });
    prod.extraEnv = { NBO_CRON_SIGNING_SECRET: "cron" };
    expect(prod.deployer.providedEnvNames!()).toEqual(["NBO_CRON_SIGNING_SECRET"]);
  });

  it("passes the stored fingerprint through liveContentID", async () => {
    vi.mocked(k8s.liveContentID).mockResolvedValueOnce({ id, ok: true, fingerprint: "fp1" });
    await expect(createKubernetesTarget("myapp").deployer.liveContentID("myapp")).resolves.toEqual({
      id,
      ok: true,
      fingerprint: "fp1",
    });
  });
});

describe("cloud run target with user variables", () => {
  it("labels app and functions with the fingerprint and keeps user values out of image env", async () => {
    const dir = await fixture({ env: { required: ["USER_A"] } });
    dirs.push(dir);
    const target = createCloudRunTarget("proj", "us-central1", "repo");
    target.extraEnv = { NBO_CRON_SIGNING_SECRET: "cron" };
    target.userEnv = userEnv("fp1");
    await target.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
    await target.deployer.buildAndDeploy(dir, "myapp", id);

    expect(vi.mocked(k8s.buildFunctionImage).mock.calls.at(-1)?.[3]).toEqual({ NBO_CRON_SIGNING_SECRET: "cron" });
    expect(vi.mocked(k8s.buildImage).mock.calls.at(-1)?.[4]).toEqual({ NBO_CRON_SIGNING_SECRET: "cron" });
    const specs = vi.mocked(cr.deploy).mock.calls.map((c) => c[0]);
    expect(specs.map((s) => [s.serviceName, s.envFingerprint])).toEqual([
      ["myapp-fn-ssr", "fp1"],
      ["myapp", "fp1"],
    ]);
  }, 30000);

  it("a null fingerprint adds no label", async () => {
    const dir = await fixture();
    dirs.push(dir);
    const target = createCloudRunTarget("proj", "us-central1", "repo");
    target.userEnv = userEnv(null);
    await target.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
    await target.deployer.buildAndDeploy(dir, "myapp", id);
    for (const [spec] of vi.mocked(cr.deploy).mock.calls) expect("envFingerprint" in spec).toBe(false);
  }, 30000);

  it("dev: secrets go to Secret Manager and the default compute account may read each one", async () => {
    const dir = await fixture();
    dirs.push(dir);
    const target = createCloudRunTarget("proj", "us-central1", "repo");
    target.userEnv = {
      vars: { PLAIN: "p", TOKEN: "dev-secret-value" },
      secretNames: ["TOKEN"],
      fingerprint: "e".repeat(32),
      secretHashes: { TOKEN: "h".repeat(32) },
    };
    await target.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
    await target.deployer.buildAndDeploy(dir, "myapp", id);
    const sid = cr.secretId("myapp", "TOKEN");
    expect(vi.mocked(cr.ensureSecretVersion).mock.calls).toEqual([["proj", sid, "dev-secret-value", "h".repeat(32)]]);
    expect(vi.mocked(cr.grantSecretAccessor).mock.calls).toEqual([
      ["proj", sid, "123-compute@developer.gserviceaccount.com"],
    ]);
    for (const [spec] of vi.mocked(cr.deploy).mock.calls) {
      expect(spec.secretEnv).toEqual({ TOKEN: sid });
      expect(spec.plainEnv).toEqual({ PLAIN: "p" });
    }
  }, 30000);

  it("dev: a disabled Secret Manager API asks to enable it", async () => {
    const dir = await fixture();
    dirs.push(dir);
    vi.mocked(cr.ensureSecretVersion).mockRejectedValueOnce(
      new Error("PERMISSION_DENIED: Secret Manager API has not been used in project 1. SERVICE_DISABLED"),
    );
    const target = createCloudRunTarget("proj", "us-central1", "repo");
    target.userEnv = { vars: { TOKEN: "dev-secret-value" }, secretNames: ["TOKEN"], fingerprint: "e".repeat(32) };
    await expect(target.deployer.buildAndDeploy(dir, "myapp", id)).rejects.toThrow(
      /^enable the Secret Manager API in your Google Cloud project$/,
    );
  }, 30000);

  it("dev: a denied Secret Manager permission names the role the gcloud account needs", async () => {
    const dir = await fixture();
    dirs.push(dir);
    vi.mocked(cr.ensureSecretVersion).mockRejectedValueOnce(
      new Error("ERROR: (gcloud.secrets.create) PERMISSION_DENIED: Permission 'secretmanager.secrets.create' denied"),
    );
    const target = createCloudRunTarget("proj", "us-central1", "repo");
    target.userEnv = { vars: { TOKEN: "dev-secret-value" }, secretNames: ["TOKEN"], fingerprint: "e".repeat(32) };
    await expect(target.deployer.buildAndDeploy(dir, "myapp", id)).rejects.toThrow(
      /^your gcloud account needs roles\/secretmanager\.admin$/,
    );
  }, 30000);

  it("dev: superseded versions are destroyed after the deploy", async () => {
    const dir = await fixture();
    dirs.push(dir);
    const target = createCloudRunTarget("proj", "us-central1", "repo");
    target.userEnv = { vars: { TOKEN: "dev-secret-value" }, secretNames: ["TOKEN"], fingerprint: "e".repeat(32) };
    await target.deployer.buildAndDeploy(dir, "myapp", id);
    expect(vi.mocked(cr.destroySupersededVersions).mock.calls).toEqual([["proj", cr.secretId("myapp", "TOKEN")]]);
  }, 30000);

  it("no variables: no Secret Manager calls and no variable fields on any deploy", async () => {
    const dir = await fixture();
    dirs.push(dir);
    const target = createCloudRunTarget("proj", "us-central1", "repo");
    target.userEnv = userEnv(null);
    await target.deployer.deployFunctions!(dir, "myapp", ["ssr"]);
    await target.deployer.buildAndDeploy(dir, "myapp", id);
    expect(vi.mocked(cr.ensureSecretVersion)).not.toHaveBeenCalled();
    expect(vi.mocked(cr.grantSecretAccessor)).not.toHaveBeenCalled();
    for (const [spec] of vi.mocked(cr.deploy).mock.calls) {
      for (const k of ["plainEnv", "secretEnv"]) expect(k in spec).toBe(false);
      // A function whose live state is unknown is cleared (it may have had
      // variables); the app's live state was not read here, so it is not.
      expect("clearEnv" in spec).toBe(spec.serviceName === "myapp-fn-ssr");
    }
    expect(vi.mocked(cr.destroySupersededVersions)).not.toHaveBeenCalled();
  }, 30000);
});
