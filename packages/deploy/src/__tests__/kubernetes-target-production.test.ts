// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real adapter-k8s rendering and kubectl/docker argument building; only
// the local docker builds and `kind load` are stubbed. Every remote
// command goes through the fake runner passed in the options.
vi.mock("@nbo/adapter-k8s", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nbo/adapter-k8s")>()),
  buildImage: vi.fn().mockResolvedValue(undefined),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
  loadImageIntoKind: vi.fn().mockResolvedValue(undefined),
  isrcacheImageTag: vi.fn().mockResolvedValue("nbo-isrcache:0123456789ab"),
  buildIsrcacheImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const { loadImageIntoKind } = await import("@nbo/adapter-k8s");
const { createKubernetesTarget } = await import("../kubernetes-target.js");

type Call = { cmd: string; args: string[]; input?: string; env?: Record<string, string> };

function recorder(answer: (cmd: string, args: string[]) => string = () => "") {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts?: { input?: string; env?: Record<string, string> }) => {
    calls.push({ cmd, args, input: opts?.input, env: opts?.env });
    return answer(cmd, args);
  };
  return { calls, run };
}

const prefix = "us-east1-docker.pkg.dev/my-proj/nbo";
const id = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";
const pullerKey = '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n"}';

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k8s-target-prod-"));
  await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
  await writeFile(join(dir, "functions", "ssr", "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}

describe("createKubernetesTarget with a connection", () => {
  it("pushes to the registry, never uses kind, and scopes every kubectl call to the project namespace", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = recorder((cmd, args) => (cmd === "kubectl" && args.includes("get") ? `Warning: skew\n${id}` : ""));
      const target = createKubernetesTarget("pabc-production", {
        kubeconfig: "/tmp/kc/kubeconfig",
        namespace: "nbo-p-abc",
        registryPrefix: prefix,
        registryEnv: { DOCKER_CONFIG: "/tmp/dockercfg" },
        pullSecret: { server: "us-east1-docker.pkg.dev", username: "_json_key", password: pullerKey },
        run,
      });

      const urls = await target.deployer.deployFunctions!(dir, "pabc-production", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc-production", id);
      const live = await target.deployer.liveContentID("pabc-production");

      expect(urls).toEqual({ ssr: "http://pabc-production-fn-ssr.nbo-p-abc.svc.cluster.local:8080" });
      expect(target.deployer.urlFor!("pabc-production")).toBe("http://pabc-production.nbo-p-abc.svc.cluster.local:8080");
      expect(live).toEqual({ id, ok: true });

      expect(vi.mocked(loadImageIntoKind)).not.toHaveBeenCalled();
      expect(calls.some((c) => c.cmd === "kind")).toBe(false);

      const pushes = calls.filter((c) => c.cmd === "docker" && c.args[0] === "push").map((c) => c.args[1]!);
      expect(pushes).toHaveLength(2);
      expect(pushes[0]!.startsWith(`${prefix}/nbo-fn-pabc-production-ssr:`)).toBe(true);
      expect(pushes[1]!.startsWith(`${prefix}/nbo-app-pabc-production:`)).toBe(true);
      expect(pushes[1]!.slice(`${prefix}/nbo-app-pabc-production:`.length)).toMatch(/^4b66654e468e-b[0-9a-f]{8}$/);
      for (const c of calls.filter((c) => c.cmd === "docker")) expect(c.env?.DOCKER_CONFIG).toBe("/tmp/dockercfg");

      const kubectl = calls.filter((c) => c.cmd === "kubectl");
      expect(kubectl.length).toBeGreaterThan(0);
      for (const c of kubectl) expect(c.args.slice(0, 4)).toEqual(["--kubeconfig", "/tmp/kc/kubeconfig", "-n", "nbo-p-abc"]);

      const applied = kubectl.filter((c) => c.args.includes("apply")).map((c) => c.input ?? "");
      const all = applied.join("\n---\n");
      expect(all).toContain("kind: NetworkPolicy");
      expect(all).toContain("type: kubernetes.io/dockerconfigjson");
      expect(all).toContain("name: nbo-pull");
      expect(all).toContain("imagePullSecrets");
      expect(all).not.toContain("kind: Ingress");
      // The puller key only travels base64-encoded inside the Secret on stdin.
      for (const c of calls) expect(c.args.join(" ")).not.toContain("private_key");
      expect(all).not.toContain("private_key");

      // Pull secret and policies go in before any workload.
      const firstWorkload = applied.findIndex((y) => y.includes("kind: Deployment"));
      expect(applied.findIndex((y) => y.includes("kubernetes.io/dockerconfigjson"))).toBeLessThan(firstWorkload);
      expect(applied.findIndex((y) => y.includes("kind: NetworkPolicy"))).toBeLessThan(firstWorkload);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("bakes the in-cluster function URLs into the app image", async () => {
    const dir = await fixture();
    try {
      const { buildImage } = await import("@nbo/adapter-k8s");
      const { run } = recorder();
      const target = createKubernetesTarget("pabc-production", {
        kubeconfig: "/kc",
        namespace: "nbo-p-abc",
        registryPrefix: prefix,
        registryEnv: {},
        pullSecret: { server: "s", username: "u", password: "p" },
        run,
      });
      await target.deployer.deployFunctions!(dir, "pabc-production", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc-production", id);
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[3]).toEqual({ ssr: "http://pabc-production-fn-ssr.nbo-p-abc.svc.cluster.local:8080" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("keeps a long function's object names within 63 characters, and bakes that name's URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k8s-target-prod-"));
    const fn = "app-dashboard-settings-page-route";
    const app = "p0123abcd-k8s-a-very-long-cluster-name-x";
    try {
      await mkdir(join(dir, "functions", fn, "bundle"), { recursive: true });
      await writeFile(join(dir, "functions", fn, "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
      const { buildImage, functionObjectName } = await import("@nbo/adapter-k8s");
      const short = functionObjectName(app, fn);
      expect(short.length).toBeLessThanOrEqual(63);
      expect(short).not.toBe(`${app}-fn-${fn}`);
      const { calls, run } = recorder();
      const target = createKubernetesTarget(app, {
        kubeconfig: "/kc",
        namespace: "nbo-p-0123abcd",
        registryPrefix: prefix,
        registryEnv: {},
        pullSecret: { server: "s", username: "u", password: "p" },
        run,
      });
      await target.deployer.deployFunctions!(dir, app, [fn]);
      await target.deployer.buildAndDeploy(dir, app, id);
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[3]).toEqual({ [fn]: `http://${short}.nbo-p-0123abcd.svc.cluster.local:8080` });
      const kubectl = calls.filter((c) => c.cmd === "kubectl").map((c) => c.args.join(" "));
      expect(kubectl.some((a) => a.includes(`deployment/${short}`))).toBe(true);
      expect(kubectl.join(" ")).not.toContain(`${app}-fn-${fn}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("reports each timed sub-step through onProgress, in order (registry push)", async () => {
    const dir = await fixture();
    try {
      const { run } = recorder();
      const messages: string[] = [];
      let t = 0;
      const target = createKubernetesTarget(
        "pabc-production",
        {
          kubeconfig: "/kc",
          namespace: "nbo-p-abc",
          registryPrefix: prefix,
          registryEnv: {},
          pullSecret: { server: "s", username: "u", password: "hunter2-pull-password" },
          run,
        },
        { onProgress: (m) => messages.push(m), now: () => (t += 1500) },
      );
      await target.deployer.deployFunctions!(dir, "pabc-production", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc-production", id);
      expect(messages).toEqual([
        "namespace prepared in 1.5s",
        "function ssr: image built in 1.5s",
        "function ssr: image pushed in 1.5s",
        "function ssr: manifests applied in 1.5s",
        "function ssr: rollout finished in 1.5s",
        "app: cli bundle prepared in 1.5s",
        "app: image built in 1.5s",
        "app: image pushed in 1.5s",
        "app: manifests applied in 1.5s",
        "app: rollout finished in 1.5s",
      ]);
      expect(messages.join("\n")).not.toContain("hunter2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("skips an unchanged function: no build, push or apply when the live Deployment already runs its content-tagged image", async () => {
    const dir = await fixture();
    const opts = (run: (cmd: string, args: string[], o?: { input?: string; env?: Record<string, string> }) => Promise<string>) => ({
      kubeconfig: "/kc",
      namespace: "nbo-p-abc",
      registryPrefix: prefix,
      registryEnv: {},
      pullSecret: { server: "s", username: "u", password: "p" },
      run,
    });
    try {
      const first = recorder();
      await createKubernetesTarget("pabc-production", opts(first.run)).deployer.deployFunctions!(dir, "pabc-production", ["ssr"]);
      const pushed = first.calls.find((c) => c.cmd === "docker" && c.args[0] === "push")!.args[1]!;
      expect(pushed).toMatch(new RegExp(`^${prefix}/nbo-fn-pabc-production-ssr:[0-9a-f]{24}$`));
      const fnYaml = first.calls.map((c) => c.input ?? "").find((y) => y.includes("name: pabc-production-fn-ssr"))!;
      const config = /nbo\.dev\/fn-config: "([0-9a-f]+)"/.exec(fnYaml)![1]!;

      const liveAs = (state: string) =>
        recorder((cmd, args) => (cmd === "kubectl" && args.includes("pabc-production-fn-ssr") && args.some((a) => a.includes("fn-config")) ? `Warning: skew\n${state}\n` : ""));

      const second = liveAs([pushed, config, "2", "2", "1", "1", "1"].join("\t"));
      const messages: string[] = [];
      const urls = await createKubernetesTarget("pabc-production", opts(second.run), { onProgress: (m) => messages.push(m) }).deployer.deployFunctions!(dir, "pabc-production", [
        "ssr",
      ]);
      expect(urls).toEqual({ ssr: "http://pabc-production-fn-ssr.nbo-p-abc.svc.cluster.local:8080" });
      expect(second.calls.some((c) => c.cmd === "docker")).toBe(false);
      const applied = second.calls.filter((c) => c.args.includes("apply")).map((c) => c.input ?? "");
      expect(applied.some((y) => y.includes("pabc-production-fn-ssr"))).toBe(false);
      expect(second.calls.some((c) => c.args.includes("rollout"))).toBe(false);
      expect(messages).toContain("function ssr: unchanged, skipped");

      // A rollout that timed out (new ReplicaSet not available) is redeployed.
      const stuck = liveAs([pushed, config, "2", "2", "1", "1", "0"].join("\t"));
      await createKubernetesTarget("pabc-production", opts(stuck.run)).deployer.deployFunctions!(dir, "pabc-production", ["ssr"]);
      expect(stuck.calls.some((c) => c.args.includes("rollout"))).toBe(true);

      // Same image, but the live annotation names another deploy config
      // (e.g. rendered before a manifest change): redeployed.
      const other = liveAs([pushed, "0123456789abcdef01234567", "2", "2", "1", "1", "1"].join("\t"));
      await createKubernetesTarget("pabc-production", opts(other.run)).deployer.deployFunctions!(dir, "pabc-production", ["ssr"]);
      expect(other.calls.some((c) => c.args.includes("rollout"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("takes no values from NBO's own environment, only its own extraEnv", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0", env: { optional: ["SECRET_X"] } }));
    process.env.SECRET_X = "leak";
    try {
      const { buildImage, buildFunctionImage } = await import("@nbo/adapter-k8s");
      const { run } = recorder();
      const target = createKubernetesTarget("pabc-production", {
        kubeconfig: "/kc",
        namespace: "nbo-p-abc",
        registryPrefix: prefix,
        registryEnv: {},
        pullSecret: { server: "s", username: "u", password: "p" },
        run,
      });
      target.extraEnv.NBO_CRON_SIGNING_SECRET = "cron-secret";
      await target.deployer.deployFunctions!(dir, "pabc-production", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc-production", id);
      expect(vi.mocked(buildFunctionImage).mock.calls.at(-1)?.[3]).toEqual({ NBO_CRON_SIGNING_SECRET: "cron-secret" });
      expect(vi.mocked(buildImage).mock.calls.at(-1)?.[4]).toEqual({ NBO_CRON_SIGNING_SECRET: "cron-secret" });
    } finally {
      delete process.env.SECRET_X;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("environment variables Secret (connected)", () => {
  const opts = (run: ReturnType<typeof recorder>["run"]) => ({
    kubeconfig: "/tmp/kc/kubeconfig",
    namespace: "nbo-p-abc",
    registryPrefix: prefix,
    registryEnv: {},
    pullSecret: { server: "s", username: "u", password: "p" },
    run,
  });
  const secretCalls = (calls: Call[]) => calls.filter((c) => c.input?.includes("kind: Secret") && c.input.includes("name: pabc-env"));

  it("applies the Secret via stdin before the Deployments, with envFrom on app and function", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = recorder();
      const target = createKubernetesTarget("pabc", opts(run));
      target.userEnv = { vars: { API_KEY: 's3cret=,\n"x"', PLAIN: "p" }, secretNames: ["API_KEY"], fingerprint: "fp1" };
      await target.deployer.deployFunctions!(dir, "pabc", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc", id);

      const secrets = secretCalls(calls);
      expect(secrets.length).toBeGreaterThan(0);
      const s = secrets[0]!;
      expect(s.args).toEqual(["--kubeconfig", "/tmp/kc/kubeconfig", "-n", "nbo-p-abc", "apply", "-f", "-"]);
      expect(s.input).toContain("namespace: nbo-p-abc");
      expect(s.input).toContain(Buffer.from('s3cret=,\n"x"').toString("base64"));
      expect(calls.flatMap((c) => c.args).join(" ")).not.toContain("s3cret");
      const firstDeployment = calls.findIndex((c) => c.input?.includes("kind: Deployment"));
      expect(calls.indexOf(s)).toBeLessThan(firstDeployment);
      const deployments = calls.filter((c) => c.input?.includes("kind: Deployment")).map((c) => c.input!);
      expect(deployments).toHaveLength(2);
      for (const d of deployments) expect(d).toContain("secretRef:\n            name: pabc-env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("an empty set deletes the Secret (ignore-not-found, scoped) and adds no envFrom", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = recorder();
      const target = createKubernetesTarget("pabc", opts(run));
      target.userEnv = { vars: {}, secretNames: [], fingerprint: null };
      await target.deployer.buildAndDeploy(dir, "pabc", id);
      const del = calls.find((c) => c.args.includes("delete"));
      expect(del?.args).toEqual(["--kubeconfig", "/tmp/kc/kubeconfig", "-n", "nbo-p-abc", "delete", "secret", "pabc-env", "--ignore-not-found"]);
      expect(secretCalls(calls)).toHaveLength(0);
      expect(calls.some((c) => c.input?.includes("envFrom"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("no userEnv at all makes no Secret calls", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = recorder();
      await createKubernetesTarget("pabc", opts(run)).deployer.buildAndDeploy(dir, "pabc", id);
      expect(calls.some((c) => c.args.includes("delete") || c.input?.includes("-env"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("redacts secret values from a failing Secret apply", async () => {
    const dir = await fixture();
    try {
      const run = async (_cmd: string, args: string[], o?: { input?: string }): Promise<string> => {
        if (args.includes("apply") && o?.input?.includes("name: pabc-env")) {
          throw new Error("kubectl failed: invalid value s3cretVALUE and " + Buffer.from("s3cretVALUE").toString("base64"));
        }
        return "";
      };
      const target = createKubernetesTarget("pabc", opts(run));
      target.userEnv = { vars: { API_KEY: "s3cretVALUE" }, secretNames: ["API_KEY"], fingerprint: "fp1" };
      const err = await target.deployer.buildAndDeploy(dir, "pabc", id).catch((e: Error) => e);
      expect((err as Error).message).toContain("[redacted]");
      expect((err as Error).message).not.toContain("s3cretVALUE");
      expect((err as Error).message).not.toContain(Buffer.from("s3cretVALUE").toString("base64"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
describe("ISR cache (connected)", () => {
  const opts = (run: ReturnType<typeof recorder>["run"]) => ({
    kubeconfig: "/kc",
    namespace: "nbo-p-abc",
    registryPrefix: prefix,
    registryEnv: { DOCKER_CONFIG: "/tmp/dockercfg" },
    pullSecret: { server: "s", username: "u", password: "p" },
    run,
  });

  it("pushes the cache image, applies policies then the cache, and bakes its namespaced URL", async () => {
    const dir = await fixture();
    try {
      const k8s = await import("@nbo/adapter-k8s");
      vi.mocked(k8s.isrcacheImageTag).mockResolvedValue("nbo-isrcache:0123456789ab");
      const { calls, run } = recorder();
      const target = createKubernetesTarget("pabc-production", opts(run));
      target.isr = { enabled: true, removeCache: false };
      const url = await target.deployer.deployIsrCache!(dir, "pabc-production");
      await target.deployer.deployFunctions!(dir, "pabc-production", ["ssr"]);
      await target.deployer.buildAndDeploy(dir, "pabc-production", id);

      expect(url).toBe("http://pabc-production-isr.nbo-p-abc.svc.cluster.local:8080");
      const pushes = calls.filter((c) => c.cmd === "docker" && c.args[0] === "push").map((c) => c.args[1]!);
      expect(pushes.filter((t) => t.includes("nbo-isrcache"))).toEqual([`${prefix}/nbo-isrcache:0123456789ab`]);
      const applied = calls.filter((c) => c.cmd === "kubectl" && c.args.includes("apply")).map((c) => c.input ?? "");
      const policies = applied.findIndex((y) => y.includes("name: pabc-production-to-isrcache"));
      const cache = applied.findIndex((y) => y.includes("nbo.dev/role: isrcache") && y.includes("kind: Deployment"));
      const fn = applied.findIndex((y) => y.includes("kind: Deployment") && y.includes("nbo.dev/role: function"));
      expect(policies).toBeGreaterThanOrEqual(0);
      expect(policies).toBeLessThan(cache);
      expect(cache).toBeLessThan(fn);
      expect(applied[cache]).toContain(`image: ${prefix}/nbo-isrcache:0123456789ab`);
      expect(applied[cache]).toContain("namespace: nbo-p-abc");
      expect(applied[cache]).toContain("- name: nbo-pull");
      const rollouts = calls.filter((c) => c.args.includes("rollout")).map((c) => c.args.at(-2));
      expect(rollouts[0]).toBe("deployment/pabc-production-isr");
      expect(vi.mocked(k8s.buildImage).mock.calls.at(-1)?.[3]).toEqual({
        ssr: "http://pabc-production-fn-ssr.nbo-p-abc.svc.cluster.local:8080",
        __isrcache: "http://pabc-production-isr.nbo-p-abc.svc.cluster.local:8080",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("a long app name uses the shortened cache name for its objects and URL", async () => {
    const dir = await fixture();
    try {
      const k8s = await import("@nbo/adapter-k8s");
      vi.mocked(k8s.isrcacheImageTag).mockResolvedValue("nbo-isrcache:0123456789ab");
      const app = "p0123abcd-" + "x".repeat(50);
      const name = k8s.isrcacheObjectName(app);
      expect(name).not.toBe(`${app}-isr`);
      const { calls, run } = recorder();
      const target = createKubernetesTarget(app, opts(run));
      target.isr = { enabled: true, removeCache: false };
      expect(await target.deployer.deployIsrCache!(dir, app)).toBe(`http://${name}.nbo-p-abc.svc.cluster.local:8080`);
      expect(calls.filter((c) => c.args.includes("rollout")).map((c) => c.args.at(-2))).toEqual([`deployment/${name}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("removeIsrCache deletes <app>-isr in the project namespace", async () => {
    const { calls, run } = recorder();
    const target = createKubernetesTarget("pabc-production", opts(run));
    target.isr = { enabled: true, removeCache: true };
    await target.deployer.removeIsrCache!("pabc-production");
    expect(calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual([
      "kubectl --kubeconfig /kc -n nbo-p-abc delete deployment,service -l nbo.dev/role=isrcache,nbo.dev/app=pabc-production --field-selector metadata.name=pabc-production-isr --ignore-not-found",
    ]);
  });

  it("reads the live cache name's labels and refuses another app's object before building or applying", async () => {
    const dir = await fixture();
    try {
      const app = "pabc-s-a-k8s-fn-x-k8s";
      const { calls, run } = recorder((cmd, args) => (cmd === "kubectl" && args.includes("get") && args.includes("deployment,service") ? `Deployment\t${app}-isr\t\t\n` : ""));
      const target = createKubernetesTarget(app, opts(run));
      target.isr = { enabled: true, removeCache: false };
      await expect(target.deployer.deployIsrCache!(dir, app)).rejects.toThrow(/not this app's ISR cache/);
      expect(calls.some((c) => c.args.includes("apply") || c.cmd === "docker")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("deploys over this app's own live cache", async () => {
    const dir = await fixture();
    try {
      const { calls, run } = recorder((cmd, args) =>
        cmd === "kubectl" && args.includes("get") && args.includes("deployment,service") ? "Deployment\tpabc-production-isr\tisrcache\tpabc-production\n" : "",
      );
      const target = createKubernetesTarget("pabc-production", opts(run));
      target.isr = { enabled: true, removeCache: false };
      await target.deployer.deployIsrCache!(dir, "pabc-production");
      expect(calls.some((c) => c.args.includes("apply") && (c.input ?? "").includes("nbo.dev/role: isrcache"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
