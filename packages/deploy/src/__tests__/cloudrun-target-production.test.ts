// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real adapter-cloudrun argument building and identity logic; only the
// local docker builds are stubbed. Every gcloud/docker push goes through
// the fake runner carried by ctx.
vi.mock("@nbo/adapter-k8s", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nbo/adapter-k8s")>()),
  buildImage: vi.fn().mockResolvedValue(undefined),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
  isrcacheImageTag: vi.fn().mockResolvedValue("nbo-isrcache:0123456789ab"),
  buildIsrcacheImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const { serviceIdentityId } = await import("@nbo/adapter-cloudrun");
const { createCloudRunTarget } = await import("../cloudrun-target.js");

type Call = { cmd: string; args: string[]; env?: Record<string, string> };

function recorder() {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts?: { input?: string; env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts?.env });
    if (args.includes("describe") && args[0] === "run") return `Warning: x\n${JSON.stringify({ status: { url: `https://${args[3]}.run.app` }, metadata: {} })}`;
    if (args[0] === "projects" && args[1] === "describe") return JSON.stringify({ projectNumber: "123" });
    return "";
  };
  return { calls, run };
}

const env = { CLOUDSDK_CONFIG: "/tmp/g", DOCKER_CONFIG: "/tmp/d" };
const id = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cloudrun-target-prod-"));
  await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
  await writeFile(join(dir, "functions", "ssr", "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}

describe("createCloudRunTarget with per-service identities", () => {
  it("runs each service as its own account and lets the app's account invoke the functions", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = recorder();
      const target = createCloudRunTarget("acme", "us-central1", "us-central1-docker.pkg.dev/acme/nbo", {
        ctx: { env, run, sleep: async () => {} },
        perServiceIdentity: true,
      });

      await target.deployer.deployFunctions!(dir, "pabc-cloudrun", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc-cloudrun", id);

      const appSa = `${serviceIdentityId("pabc-cloudrun")}@acme.iam.gserviceaccount.com`;
      const fnSa = `${serviceIdentityId("pabc-cloudrun-fn-ssr")}@acme.iam.gserviceaccount.com`;

      const deploys = calls.filter((c) => c.cmd === "gcloud" && c.args[0] === "run" && c.args[1] === "deploy");
      expect(deploys).toHaveLength(2);
      const fnDeploy = deploys.find((c) => c.args[2] === "pabc-cloudrun-fn-ssr")!;
      const appDeploy = deploys.find((c) => c.args[2] === "pabc-cloudrun")!;
      expect(fnDeploy.args.slice(fnDeploy.args.indexOf("--service-account"))).toEqual(["--service-account", fnSa]);
      expect(appDeploy.args.slice(appDeploy.args.indexOf("--service-account"))).toEqual(["--service-account", appSa]);

      const binding = calls.find((c) => c.args.includes("add-iam-policy-binding"))!;
      expect(binding.args).toContain("pabc-cloudrun-fn-ssr");
      expect(binding.args).toContain(`serviceAccount:${appSa}`);

      // Never the default compute account.
      expect(calls.some((c) => c.args[0] === "projects" && c.args[1] === "describe")).toBe(false);
      // Every gcloud/docker call carries the credential environment.
      expect(calls.length).toBeGreaterThan(6);
      for (const c of calls) expect(c.env).toEqual(env);
      expect(calls.filter((c) => c.cmd === "docker" && c.args[0] === "push")).toHaveLength(2);
      expect(target.appURL).toBe("https://pabc-cloudrun.run.app");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("gives the app its identity even without functions", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = recorder();
      const target = createCloudRunTarget("acme", "us-central1", "repo", { ctx: { env, run }, perServiceIdentity: true });
      await target.deployer.buildAndDeploy(dir, "pabc-cloudrun", id);
      const deploy = calls.find((c) => c.args[1] === "deploy")!;
      expect(deploy.args).toContain("--service-account");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("without perServiceIdentity still uses the default compute account and no service-account flag", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = recorder();
      const target = createCloudRunTarget("acme", "r", "repo", { ctx: { env, run }, perServiceIdentity: false });
      await target.deployer.buildAndDeploy(dir, "pabc-cloudrun", id);
      expect(calls.find((c) => c.args[1] === "deploy")!.args).not.toContain("--service-account");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("reports each timed sub-step through onProgress, in order, without secrets", async () => {
    const dir = await fixture();
    try {
      const { run } = recorder();
      const messages: string[] = [];
      let t = 0;
      const target = createCloudRunTarget(
        "acme",
        "us-central1",
        "us-central1-docker.pkg.dev/acme/nbo",
        { ctx: { env, run, sleep: async () => {} }, perServiceIdentity: true },
        { onProgress: (m) => messages.push(m), now: () => (t += 1500) },
      );
      target.extraEnv.NBO_CRON_SIGNING_SECRET = "cron-secret-value";
      await target.deployer.deployFunctions!(dir, "pabc-cloudrun", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc-cloudrun", id);
      expect(messages).toEqual([
        "function ssr: image built in 1.5s",
        "function ssr: image pushed in 1.5s",
        "function ssr: service deployed in 1.5s",
        "function ssr: invoker granted in 1.5s",
        "app: cli bundle prepared in 1.5s",
        "app: image built in 1.5s",
        "app: image pushed in 1.5s",
        "app: service deployed in 1.5s",
      ]);
      expect(messages.join("\n")).not.toContain("cron-secret-value");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  describe("skipping an unchanged function", () => {
    const repo = "us-central1-docker.pkg.dev/acme/nbo";
    const opts = (run: (cmd: string, args: string[], o?: { input?: string; env?: Record<string, string> }) => Promise<string>, perServiceIdentity = true) => ({
      ctx: { env, run, sleep: async () => {} },
      perServiceIdentity,
    });

    // The first deploy tells us the image and the nbo-fn-config label it wrote.
    async function firstDeploy(dir: string, perServiceIdentity = true): Promise<{ image: string; config: string }> {
      const first = recorder();
      await createCloudRunTarget("acme", "us-central1", repo, opts(first.run, perServiceIdentity)).deployer.deployFunctions!(dir, "pabc-cloudrun", ["ssr"]);
      const deploy = first.calls.find((c) => c.args[0] === "run" && c.args[1] === "deploy" && c.args[2] === "pabc-cloudrun-fn-ssr")!;
      const image = deploy.args[deploy.args.indexOf("--image") + 1]!;
      const config = /nbo-fn-config=([0-9a-f]{32})/.exec(deploy.args[deploy.args.indexOf("--labels") + 1]!)![1]!;
      expect(image).toMatch(/^us-central1-docker\.pkg\.dev\/acme\/nbo\/nbo-fn-pabc-cloudrun-ssr:[0-9a-f]{24}$/);
      return { image, config };
    }

    function liveAs(state: { image: string; config: string; ready?: string; latestReady?: string }) {
      const calls: Call[] = [];
      const run = async (cmd: string, args: string[], o?: { input?: string; env?: Record<string, string> }) => {
        calls.push({ cmd, args, env: o?.env });
        if (args[0] === "run" && args[2] === "describe") {
          const live = args[3] === "pabc-cloudrun-fn-ssr";
          return `WARNING: something\n${JSON.stringify({
            metadata: { labels: live ? { "nbo-content-id": "0".repeat(32), "nbo-fn-config": state.config } : {} },
            spec: { template: { spec: { containers: [{ image: live ? state.image : "x" }] } } },
            status: {
              url: `https://${args[3]}-live.run.app`,
              latestReadyRevisionName: state.latestReady ?? "r2",
              latestCreatedRevisionName: "r2",
              conditions: [{ type: "Ready", status: state.ready ?? "True" }],
            },
          })}`;
        }
        return "";
      };
      return { calls, run };
    }

    const deployed = (calls: Call[]) => calls.some((c) => c.args[0] === "run" && c.args[1] === "deploy");

    it("skips build, push and deploy when ready on the same image and config, and still grants invoker", async () => {
      const dir = await fixture();
      try {
        const live = liveAs(await firstDeploy(dir));
        const messages: string[] = [];
        const target = createCloudRunTarget("acme", "us-central1", repo, opts(live.run), { onProgress: (m) => messages.push(m) });
        const urls = await target.deployer.deployFunctions!(dir, "pabc-cloudrun", ["ssr"]);
        expect(urls).toEqual({ ssr: "https://pabc-cloudrun-fn-ssr-live.run.app" });
        expect(live.calls.some((c) => c.cmd === "docker")).toBe(false);
        expect(deployed(live.calls)).toBe(false);
        const binding = live.calls.find((c) => c.args.includes("add-iam-policy-binding"))!;
        expect(binding.args).toContain(`serviceAccount:${serviceIdentityId("pabc-cloudrun")}@acme.iam.gserviceaccount.com`);
        for (const c of live.calls) expect(c.env).toEqual(env);
        expect(messages[0]).toBe("function ssr: unchanged, skipped");
        expect(messages[1]).toMatch(/^function ssr: invoker granted in /);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30000);

    it("redeploys when the service is not Ready, or its latest revision never became ready", async () => {
      const dir = await fixture();
      try {
        const state = await firstDeploy(dir);
        for (const bad of [{ ready: "False" }, { latestReady: "r1" }]) {
          const live = liveAs({ ...state, ...bad });
          await createCloudRunTarget("acme", "us-central1", repo, opts(live.run)).deployer.deployFunctions!(dir, "pabc-cloudrun", ["ssr"]);
          expect(deployed(live.calls), JSON.stringify(bad)).toBe(true);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30000);

    it("redeploys when only the deploy config changed: a switch to per-service identities", async () => {
      const dir = await fixture();
      try {
        // Deployed before as the default compute account; now each
        // service has its own identity, so the function's run-as account
        // and its invoker member both change while the image does not.
        const state = await firstDeploy(dir, false);
        const live = liveAs(state);
        await createCloudRunTarget("acme", "us-central1", repo, opts(live.run, true)).deployer.deployFunctions!(dir, "pabc-cloudrun", ["ssr"]);
        expect(deployed(live.calls)).toBe(true);
        const fnDeploy = live.calls.find((c) => c.args[1] === "deploy")!;
        expect(fnDeploy.args[fnDeploy.args.indexOf("--image") + 1]).toBe(state.image);
        expect(fnDeploy.args).toContain("--service-account");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  it("takes no values from NBO's own environment, only its own extraEnv", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0", env: { optional: ["SECRET_X"] } }));
    process.env.SECRET_X = "leak";
    try {
      const { buildImage, buildFunctionImage } = await import("@nbo/adapter-k8s");
      const { run } = recorder();
      const target = createCloudRunTarget("acme", "r", "repo", { ctx: { env, run, sleep: async () => {} }, perServiceIdentity: true });
      target.extraEnv.NBO_CRON_SIGNING_SECRET = "cron-secret";
      await target.deployer.deployFunctions!(dir, "pabc-cloudrun", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc-cloudrun", id);
      expect(vi.mocked(buildFunctionImage).mock.calls.at(-1)?.[3]).toEqual({ NBO_CRON_SIGNING_SECRET: "cron-secret" });
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[4]).toEqual({ NBO_CRON_SIGNING_SECRET: "cron-secret" });
    } finally {
      delete process.env.SECRET_X;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("createCloudRunTarget ISR cache <app>-isr", () => {
  const repo = "us-central1-docker.pkg.dev/acme/nbo";
  const app = "pabc-cloudrun";
  const cacheImage = `${repo}/nbo-isrcache:0123456789ab`;
  const appSa = `${serviceIdentityId(app)}@acme.iam.gserviceaccount.com`;
  const cacheSa = `${serviceIdentityId(`${app}-isr`)}@acme.iam.gserviceaccount.com`;
  type Run = (cmd: string, args: string[], o?: { input?: string; env?: Record<string, string> }) => Promise<string>;
  const opts = (run: Run, perServiceIdentity = true) => ({ ctx: { env, run, sleep: async () => {} }, perServiceIdentity });
  const isDeployOf = (c: Call, name: string) => c.cmd === "gcloud" && c.args[0] === "run" && c.args[1] === "deploy" && c.args[2] === name;
  const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];

  // A runner whose `<app>-isr` describe answers with the given live state.
  function liveCache(state?: { image: string; config: string; ready?: string; labels?: Record<string, string> }) {
    const base = recorder();
    // Once deployed, the service exists (the deploy reads its URL back).
    let deployed = false;
    const run: Run = async (cmd, args, o) => {
      if (args[0] === "run" && args[1] === "deploy" && args[2] === `${app}-isr`) deployed = true;
      if (args[0] === "run" && args[2] === "describe" && args[3] === `${app}-isr` && (state || !deployed)) {
        base.calls.push({ cmd, args, env: o?.env });
        if (!state) throw new Error(`ERROR: (gcloud.run.services.describe) Cannot find service [${app}-isr]`);
        return JSON.stringify({
          metadata: { labels: { "nbo-content-id": "0123456789ab", "nbo-fn-config": state.config, ...(state.labels ?? { "nbo-role": "isrcache", "nbo-app": app }) } },
          spec: { template: { spec: { containers: [{ image: state.image }] } } },
          status: {
            url: `https://${app}-isr-live.run.app`,
            latestReadyRevisionName: "r1",
            latestCreatedRevisionName: "r1",
            conditions: [{ type: "Ready", status: state.ready ?? "True" }],
          },
        });
      }
      return base.run(cmd, args, o);
    };
    return { calls: base.calls, run };
  }

  it("deploys a private, role-less, 0-to-1 instance service, grants only the app's account, and bakes its URL as __isrcache", async () => {
    const dir = await fixture();
    try {
      const { buildImage } = await import("@nbo/adapter-k8s");
      const { calls, run } = liveCache();
      const target = createCloudRunTarget("acme", "us-central1", repo, opts(run));
      target.userEnv = { vars: { PLAIN: "p", API_KEY: "hunter2-secret" }, secretNames: ["API_KEY"], fingerprint: "f".repeat(32) };
      target.isr = { enabled: true, removeCache: false };

      const url = await target.deployer.deployIsrCache!(dir, app);
      expect(url).toBe(`https://${app}-isr.run.app`);

      const deploy = calls.find((c) => isDeployOf(c, `${app}-isr`))!;
      expect(flag(deploy.args, "--image")).toBe(cacheImage);
      expect(deploy.args).toContain("--no-allow-unauthenticated");
      expect(deploy.args).not.toContain("--allow-unauthenticated");
      expect(flag(deploy.args, "--min-instances")).toBe("0");
      expect(flag(deploy.args, "--max-instances")).toBe("1");
      expect(flag(deploy.args, "--concurrency")).toBe("250");
      expect(flag(deploy.args, "--memory")).toBe("256Mi");
      expect(flag(deploy.args, "--cpu")).toBe("1");
      // gen1: its memory floor allows 256Mi with 1 CPU (gen2 needs 512Mi).
      expect(flag(deploy.args, "--execution-environment")).toBe("gen1");
      expect(flag(deploy.args, "--service-account")).toBe(cacheSa);
      expect(flag(deploy.args, "--labels")).toMatch(new RegExp(`^nbo-content-id=0123456789ab,nbo-fn-config=[0-9a-f]{32},nbo-role=isrcache,nbo-app=${app}$`));
      // Request-based billing only: never always-on CPU or a startup boost.
      for (const f of ["--set-env-vars", "--env-vars-file", "--set-secrets", "--clear-env-vars", "--clear-secrets", "--ingress", "--no-cpu-throttling", "--cpu-throttling", "--cpu-boost"]) {
        expect(deploy.args).not.toContain(f);
      }
      // No Secret Manager call for the cache, and the secret appears nowhere.
      expect(calls.some((c) => c.args[0] === "secrets")).toBe(false);
      expect(JSON.stringify(calls)).not.toContain("hunter2-secret");
      expect(calls.some((c) => c.cmd === "docker" && c.args[0] === "push" && c.args.includes(cacheImage))).toBe(true);

      const bindings = calls.filter((c) => c.args.includes("add-iam-policy-binding"));
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.args[3]).toBe(`${app}-isr`);
      expect(flag(bindings[0]!.args, "--member")).toBe(`serviceAccount:${appSa}`);
      expect(calls.indexOf(bindings[0]!)).toBeGreaterThan(calls.indexOf(deploy));
      for (const c of calls) expect(c.env).toEqual(env);

      await target.deployer.deployFunctions!(dir, app, ["ssr"]);
      await target.deployer.buildAndDeploy(dir, app, id);
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[3]).toEqual({ ssr: `https://${app}-fn-ssr.run.app`, __isrcache: `https://${app}-isr.run.app` });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("skips build, push and deploy when the live cache runs the wanted image and is ready, and still grants invoker", async () => {
    const dir = await fixture();
    try {
      const { buildIsrcacheImage, buildImage } = await import("@nbo/adapter-k8s");
      const first = liveCache();
      const t1 = createCloudRunTarget("acme", "us-central1", repo, opts(first.run));
      t1.isr = { enabled: true, removeCache: false };
      await t1.deployer.deployIsrCache!(dir, app);
      const firstDeploy = first.calls.find((c) => isDeployOf(c, `${app}-isr`))!;
      const config = /nbo-fn-config=([0-9a-f]{32})/.exec(flag(firstDeploy.args, "--labels")!)![1]!;

      vi.mocked(buildIsrcacheImage).mockClear();
      const live = liveCache({ image: cacheImage, config });
      const messages: string[] = [];
      const target = createCloudRunTarget("acme", "us-central1", repo, opts(live.run), { onProgress: (m) => messages.push(m) });
      target.isr = { enabled: true, removeCache: false };
      const url = await target.deployer.deployIsrCache!(dir, app);
      expect(url).toBe(`https://${app}-isr-live.run.app`);
      expect(live.calls.some((c) => c.args[0] === "run" && c.args[1] === "deploy")).toBe(false);
      expect(live.calls.some((c) => c.cmd === "docker")).toBe(false);
      expect(vi.mocked(buildIsrcacheImage)).not.toHaveBeenCalled();
      const binding = live.calls.find((c) => c.args.includes("add-iam-policy-binding"))!;
      expect(binding.args[3]).toBe(`${app}-isr`);
      expect(messages).toContain("isr cache: unchanged, skipped");

      // The live URL is what the app image gets.
      await target.deployer.buildAndDeploy(dir, app, id);
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[3]).toEqual({ __isrcache: `https://${app}-isr-live.run.app` });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("redeploys when the live cache is not ready or runs another image", async () => {
    const dir = await fixture();
    try {
      for (const state of [
        { image: cacheImage, config: "0".repeat(32), ready: "False" },
        { image: `${repo}/nbo-isrcache:ffffffffffff`, config: "0".repeat(32) },
      ]) {
        const live = liveCache(state);
        const target = createCloudRunTarget("acme", "us-central1", repo, opts(live.run));
        target.isr = { enabled: true, removeCache: false };
        await target.deployer.deployIsrCache!(dir, app);
        expect(live.calls.some((c) => isDeployOf(c, `${app}-isr`)), JSON.stringify(state)).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("without per-service identities runs as the default and lets the default compute account invoke it", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = liveCache();
      const target = createCloudRunTarget("acme", "us-central1", repo, opts(run, false));
      target.isr = { enabled: true, removeCache: false };
      await target.deployer.deployIsrCache!(dir, app);
      const deploy = calls.find((c) => isDeployOf(c, `${app}-isr`))!;
      expect(deploy.args).not.toContain("--service-account");
      const binding = calls.find((c) => c.args.includes("add-iam-policy-binding"))!;
      expect(flag(binding.args, "--member")).toBe("serviceAccount:123-compute@developer.gserviceaccount.com");
      expect(calls.some((c) => c.args[0] === "iam")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("removeIsrCache deletes the service and its service account; already gone is fine", async () => {
    const calls: Call[] = [];
    const run: Run = async (cmd, args, o) => {
      calls.push({ cmd, args, env: o?.env });
      if (args[0] === "run" && args[2] === "describe") return JSON.stringify({ metadata: { labels: { "nbo-role": "isrcache", "nbo-app": app } } });
      if (args[0] === "run" && args[2] === "delete") throw new Error(`ERROR: (gcloud.run.services.delete) Cannot find service [${app}-isr]`);
      if (args[0] === "iam") throw new Error("ERROR: NOT_FOUND: Unknown service account");
      return "";
    };
    const target = createCloudRunTarget("acme", "us-central1", repo, opts(run));
    target.isr = { enabled: false, removeCache: true };
    await target.deployer.removeIsrCache!(app);
    expect(calls.map((c) => c.args)).toEqual([
      ["run", "services", "describe", `${app}-isr`, "--project", "acme", "--region", "us-central1", "--format=json"],
      ["run", "services", "delete", `${app}-isr`, "--project", "acme", "--region", "us-central1", "--quiet"],
      ["iam", "service-accounts", "delete", cacheSa, "--project", "acme", "--quiet"],
    ]);
    for (const c of calls) expect(c.env).toEqual(env);
  });

  it("removeIsrCache rejects with secret values redacted and no cause", async () => {
    const run: Run = async () => {
      throw new Error("ERROR: PERMISSION_DENIED token hunter2-secret leaked");
    };
    const target = createCloudRunTarget("acme", "us-central1", repo, opts(run));
    target.userEnv = { vars: { API_KEY: "hunter2-secret" }, secretNames: ["API_KEY"], fingerprint: "fp" };
    target.isr = { enabled: false, removeCache: true };
    const err = await target.deployer.removeIsrCache!(app).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("hunter2-secret");
    expect(err!.message).toContain("[redacted]");
    expect(err!.cause).toBeUndefined();
  });
});

describe("createCloudRunTarget ISR cache name collisions", () => {
  const repo = "us-central1-docker.pkg.dev/acme/nbo";
  const app = "pabc-cloudrun";
  type Run = (cmd: string, args: string[], o?: { input?: string; env?: Record<string, string> }) => Promise<string>;
  const opts = (run: Run) => ({ ctx: { env, run, sleep: async () => {} }, perServiceIdentity: true });
  // A runner whose `<app>-isr` describe answers with these labels (undefined: no such service).
  function withLabels(labels: Record<string, string> | undefined) {
    const calls: Call[] = [];
    let deployed = false;
    const run: Run = async (cmd, args, o) => {
      calls.push({ cmd, args, env: o?.env });
      if (args[0] === "run" && args[1] === "deploy" && args[2] === `${app}-isr`) deployed = true;
      if (args[0] === "run" && args[2] === "describe" && args[3] === `${app}-isr` && !deployed) {
        if (!labels) throw new Error(`ERROR: (gcloud.run.services.describe) Cannot find service [${app}-isr]`);
        return JSON.stringify({
          metadata: { labels },
          spec: { template: { spec: { containers: [{ image: "other-image" }] } } },
          status: { url: "https://other.run.app", latestReadyRevisionName: "r1", latestCreatedRevisionName: "r1", conditions: [{ type: "Ready", status: "True" }] },
        });
      }
      if (args[0] === "projects") return JSON.stringify({ projectNumber: "123" });
      if (args[0] === "run" && args[2] === "describe") return JSON.stringify({ status: { url: `https://${args[3]}.run.app` }, metadata: {} });
      return "";
    };
    return { calls, run };
  }
  const touched = (calls: Call[]) => calls.some((c) => (c.args[1] === "deploy" || c.args[2] === "delete" || c.args.includes("add-iam-policy-binding")) && c.args.includes(`${app}-isr`));
  const others = [{}, { "nbo-role": "function" }, { "nbo-role": "isrcache", "nbo-app": "pother-cloudrun" }, { "nbo-app": app }];

  it("deploy refuses, redacted, when a service of that name is not this app's cache, and touches nothing", async () => {
    const dir = await fixture();
    try {
      for (const labels of others) {
        const { calls, run } = withLabels({ ...labels, note: "hunter2-secret" });
        const target = createCloudRunTarget("acme", "us-central1", repo, opts(run));
        target.userEnv = { vars: { API_KEY: "hunter2-secret" }, secretNames: ["API_KEY"], fingerprint: "fp" };
        target.isr = { enabled: true, removeCache: false };
        const err = await target.deployer.deployIsrCache!(dir, app).then(
          () => null,
          (e: Error) => e,
        );
        expect(err?.message, JSON.stringify(labels)).toMatch(new RegExp(`${app}-isr exists and is not this app's ISR cache`));
        expect(touched(calls)).toBe(false);
        expect(calls.some((c) => c.cmd === "docker")).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("deploy refuses, redacted, when the service can't be read", async () => {
    const dir = await fixture();
    try {
      const run: Run = async () => {
        throw new Error("ERROR: PERMISSION_DENIED hunter2-secret");
      };
      const target = createCloudRunTarget("acme", "us-central1", repo, opts(run));
      target.userEnv = { vars: { API_KEY: "hunter2-secret" }, secretNames: ["API_KEY"], fingerprint: "fp" };
      target.isr = { enabled: true, removeCache: false };
      const err = await target.deployer.deployIsrCache!(dir, app).then(
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

  it("deploy proceeds over this app's own cache and when there is none", async () => {
    const dir = await fixture();
    try {
      for (const labels of [{ "nbo-role": "isrcache", "nbo-app": app }, undefined]) {
        const { calls, run } = withLabels(labels);
        const target = createCloudRunTarget("acme", "us-central1", repo, opts(run));
        target.isr = { enabled: true, removeCache: false };
        await target.deployer.deployIsrCache!(dir, app);
        expect(calls.some((c) => c.args[1] === "deploy" && c.args[2] === `${app}-isr`), JSON.stringify(labels)).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("removeIsrCache leaves a service of that name alone unless it is this app's cache", async () => {
    for (const labels of [...others, undefined]) {
      const { calls, run } = withLabels(labels);
      const target = createCloudRunTarget("acme", "us-central1", repo, opts(run));
      target.isr = { enabled: false, removeCache: true };
      await target.deployer.removeIsrCache!(app);
      expect(calls.some((c) => c.args[2] === "delete" || c.args[0] === "iam"), JSON.stringify(labels)).toBe(false);
    }
  });
});
