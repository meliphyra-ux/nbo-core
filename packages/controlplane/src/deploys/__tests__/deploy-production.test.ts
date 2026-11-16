// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Everything in @nbo/deploy stays real (credential sessions, kubectl
// argument building) except the target itself and deploy(): those
// would build Docker images. Both record into the same log as the fake
// runner so ordering is observable.
const log: string[] = [];
const targetCalls: unknown[][] = [];
let deployImpl: () => Promise<unknown> = async () => ({
  contentID: "sha256:" + "c".repeat(64),
  alreadyLive: false,
  url: "http://in-cluster",
  plan: "",
});
vi.mock("@nbo/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nbo/deploy")>()),
  createKubernetesTarget: vi.fn((...args: unknown[]) => {
    targetCalls.push(args);
    return {
      deployer: { liveContentID: async () => ({ id: "", ok: false }), buildAndDeploy: async () => {} },
      extraEnv: {},
    };
  }),
  deploy: vi.fn(async () => {
    log.push("deploy");
    return deployImpl();
  }),
}));

const { createStore } = await import("../../store/store.js");
const { triggerDeploy, projectNamespace } = await import("../deploy.js");
const { createCloudTeardown } = await import("../../clouds/cloud-teardown.js");
const { renderProjectNamespace } = await import("../../clouds/kube-bootstrap.js");
import type { Store } from "../../store/store.js";
import type { CommandRunner } from "@nbo/deploy";

type Call = { cmd: string; args: string[]; input?: string; env?: Record<string, string> };

function recorder(fail?: (cmd: string, args: string[]) => Error | undefined): CommandRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (cmd: string, args: string[], opts?: { input?: string; env?: Record<string, string> }) => {
    calls.push({ cmd, args, input: opts?.input, env: opts?.env });
    log.push(`${cmd} ${args.join(" ")}`);
    const err = fail?.(cmd, args);
    if (err) throw err;
    return "";
  }) as CommandRunner & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const kubeconfig =
  "apiVersion: v1\nkind: Config\nusers:\n- name: nbo-controller\n  user:\n    token: SUPERSECRETTOKEN\n";
const pullerKey = '{"type":"service_account","private_key":"PULLERPRIVATE"}';
const deployerKey = '{"type":"service_account","private_key":"DEPLOYERPRIVATE"}';

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-prod-"));
  const s = createStore(join(dir, "test.db"));
  s.setSecretKey(randomBytes(32));
  stores.push(s);
  return s;
}
const stores: Store[] = [];
async function nboDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-prod-nbo-"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  log.length = 0;
  targetCalls.length = 0;
  deployImpl = async () => ({
    contentID: "sha256:" + "c".repeat(64),
    alreadyLive: false,
    url: "http://in-cluster",
    plan: "",
  });
});

function saveCustom(s: Store, name = "prod", kc = kubeconfig): string {
  return s.saveKubernetesConnection(
    { name, server: "https://k8s.example:6443", registry: { kind: "custom", server: "ghcr.io", username: "bot" } },
    { kubeconfig: kc, registryPassword: "REGPASSWORD" },
  ).id;
}

describe("projectNamespace", () => {
  it("is nbo-p- plus the first 8 chars after the last underscore", () => {
    expect(projectNamespace("proj_4715bebb4b1c07e7")).toBe("nbo-p-4715bebb");
  });
});

describe("triggerDeploy in production (Kubernetes)", () => {
  it("applies the project namespace with the scoped kubeconfig before the app, then deploys through the connection", async () => {
    const s = await openStore();
    const cid = saveCustom(s);
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes", JSON.stringify({ clusterId: cid }));
    const run = recorder();
    const ns = projectNamespace(p.id);

    let kubeconfigPath = "";
    deployImpl = async () => {
      kubeconfigPath = (targetCalls[0]![1] as { kubeconfig: string }).kubeconfig;
      expect(readFileSync(kubeconfigPath, "utf8")).toBe(kubeconfig);
      return { contentID: "sha256:" + "c".repeat(64), alreadyLive: false, url: "http://in-cluster", plan: "" };
    };

    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    expect(dep.status).toBe("succeeded");

    const first = run.calls[0]!;
    expect(first.cmd).toBe("kubectl");
    expect(first.args).toEqual(["--kubeconfig", kubeconfigPath, "-n", ns, "apply", "-f", "-"]);
    expect(first.input).toBe(renderProjectNamespace(ns));

    const login = run.calls[1]!;
    expect(login.args).toEqual(["login", "ghcr.io", "--username", "bot", "--password-stdin"]);
    expect(login.input).toBe("REGPASSWORD");

    expect(log.indexOf("deploy")).toBeGreaterThan(0);
    expect(log.indexOf("deploy")).toBeGreaterThan(log.findIndex((l) => l.includes(" apply -f -")));

    const [appName, opts] = targetCalls[0]! as [string, Record<string, unknown>];
    expect(appName).toMatch(/-production$/);
    expect(opts).toMatchObject({
      namespace: ns,
      registryPrefix: "ghcr.io",
      registryEnv: { DOCKER_CONFIG: login.env!.DOCKER_CONFIG },
      pullSecret: { server: "ghcr.io", username: "bot", password: "REGPASSWORD" },
    });
    expect(opts.run).toBe(run);
    // Credentials are gone once the deploy is over.
    expect(existsSync(dirname(kubeconfigPath))).toBe(false);
    expect(existsSync(login.env!.DOCKER_CONFIG!)).toBe(false);
  });

  it("uses Artifact Registry with the deployer key for pushes and the puller key for pulls", async () => {
    const s = await openStore();
    s.saveGoogleConnection(
      {
        project: "my-proj",
        region: "us-east1",
        arRepo: "us-east1-docker.pkg.dev/my-proj/nbo",
        deployer: "d@x",
        puller: "p@x",
      },
      { deployerKey, pullerKey },
    );
    const cid = s.saveKubernetesConnection(
      { name: "prod", server: "https://k8s.example:6443", registry: { kind: "artifact-registry" } },
      { kubeconfig },
    ).id;
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes", JSON.stringify({ clusterId: cid }));
    const run = recorder();

    await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());

    expect(run.calls[1]!.args.slice(0, 2)).toEqual(["auth", "activate-service-account"]);
    const keyFile = run.calls[1]!.args[3]!;
    expect(run.calls[2]!.args).toEqual(["auth", "configure-docker", "us-east1-docker.pkg.dev", "--quiet"]);
    const [, opts] = targetCalls[0]! as [string, Record<string, unknown>];
    expect(opts).toMatchObject({
      registryPrefix: "us-east1-docker.pkg.dev/my-proj/nbo",
      registryEnv: { DOCKER_CONFIG: run.calls[1]!.env!.DOCKER_CONFIG },
      pullSecret: { server: "us-east1-docker.pkg.dev", username: "_json_key", password: pullerKey },
    });
    expect(existsSync(keyFile)).toBe(false);
  });

  it("refuses without a Kubernetes connection, before creating a deployment", async () => {
    const s = await openStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    await expect(
      triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir()),
    ).rejects.toThrow(/Kubernetes/);
    expect(s.listDeployments(env.id)).toHaveLength(0);
  });

  it("records a failure with every credential redacted", async () => {
    const s = await openStore();
    const cid = saveCustom(s);
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes", JSON.stringify({ clusterId: cid }));
    deployImpl = async () => {
      throw new Error(`push failed: REGPASSWORD ${kubeconfig} ${Buffer.from("REGPASSWORD").toString("base64")}`);
    };
    const dep = await triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir());
    expect(dep.status).toBe("failed");
    expect(dep.error).toContain("push failed");
    expect(dep.error).not.toContain("REGPASSWORD");
    expect(dep.error).not.toContain("SUPERSECRETTOKEN");
    expect(dep.error).not.toContain(Buffer.from("REGPASSWORD").toString("base64"));
  });

  it("records a failed namespace bootstrap as a failed deployment", async () => {
    const s = await openStore();
    const cid = saveCustom(s);
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes", JSON.stringify({ clusterId: cid }));
    const run = recorder((cmd) => (cmd === "kubectl" ? new Error("admission webhook denied") : undefined));
    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    expect(dep.status).toBe("failed");
    expect(dep.error).toContain("admission webhook denied");
    expect(log).not.toContain("deploy");
  });

  it("dev mode builds the kind target exactly as before", async () => {
    const s = await openStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const run = recorder();
    await triggerDeploy({ store: s, run }, env.id, await nboDir());
    // [appName, opts, progress]: no connection options, no progress asked for.
    expect(targetCalls[0]).toEqual([expect.stringMatching(/-production$/), undefined, undefined]);
    expect(run.calls).toHaveLength(0);
  });
});

describe("triggerDeploy per stage", () => {
  async function cronNbo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-stage-nbo-"));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ specVersion: "1.0", crons: [{ id: "nightly", schedule: "0 3 * * *" }] }),
    );
    return dir;
  }

  it("registers crons only for Production clouds", async () => {
    const s = await openStore();
    const p = s.createProject("acme");
    const staging = s.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    const prod = s.createEnvironment(p.id, "k8s", "kubernetes");
    const stg = s.createEnvironment(p.id, "s-staging-k8s", "kubernetes", undefined, staging.id);
    expect((await triggerDeploy({ store: s }, stg.id, await cronNbo())).status).toBe("succeeded");
    expect((await triggerDeploy({ store: s }, prod.id, await cronNbo())).status).toBe("succeeded");
    expect(s.dueCrons(new Date("2099-01-01T00:00:00Z")).map((c) => c.environmentId)).toEqual([prod.id]);
  });

  it("without a snapshot, a staging cloud deploys with staging variables", async () => {
    const s = await openStore();
    const p = s.createProject("acme");
    const staging = s.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    const stg = s.createEnvironment(p.id, "s-staging-k8s", "kubernetes", undefined, staging.id);
    s.setEnv({ projectId: p.id }, "API_URL", "https://prod.example.com", false);
    s.setEnv({ projectId: p.id }, "API_URL", "https://staging.example.com", false, "staging");
    await triggerDeploy({ store: s }, stg.id, await nboDir());
    const target = vi.mocked((await import("@nbo/deploy")).createKubernetesTarget).mock.results.at(-1)!.value as {
      userEnv?: { vars: Record<string, string> };
    };
    expect(target.userEnv?.vars).toEqual({ API_URL: "https://staging.example.com" });
  });
});

describe("cloud teardown in production (Kubernetes)", () => {
  it("deletes the project namespace with the scoped kubeconfig", async () => {
    const s = await openStore();
    const cid = saveCustom(s);
    const run = recorder();
    let seenConfig = "";
    const spy: CommandRunner = async (cmd, args, opts) => {
      const i = args.indexOf("--kubeconfig");
      if (i >= 0) seenConfig = readFileSync(args[i + 1]!, "utf8");
      return run(cmd, args, opts);
    };
    await createCloudTeardown(spy, { mode: "production", store: s }).remove({
      target: "kubernetes",
      appName: "p4715bebb-production",
      projectId: "proj_4715bebb4b1c07e7",
      config: { clusterId: cid },
    });
    expect(run.calls).toHaveLength(1);
    const [c] = run.calls;
    expect(c!.cmd).toBe("kubectl");
    expect(c!.args.slice(2)).toEqual(["delete", "namespace", "nbo-p-4715bebb", "--ignore-not-found", "--wait=false"]);
    expect(c!.args[0]).toBe("--kubeconfig");
    expect(seenConfig).toBe(kubeconfig);
    expect(existsSync(c!.args[1]!)).toBe(false);
  });

  it("redacts the kubeconfig from a failed delete", async () => {
    const s = await openStore();
    const cid = saveCustom(s);
    const run = recorder(() => new Error(`forbidden ${kubeconfig}`));
    const err = await createCloudTeardown(run, { mode: "production", store: s })
      .remove({ target: "kubernetes", appName: "pabc-production", projectId: "proj_abc", config: { clusterId: cid } })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("forbidden");
    expect((err as Error).message).not.toContain("SUPERSECRETTOKEN");
  });
});

describe("several clusters", () => {
  const otherKubeconfig =
    "apiVersion: v1\nkind: Config\nusers:\n- name: nbo-controller\n  user:\n    token: OTHERCLUSTERTOKEN\n";

  it("deploys with the kubeconfig of the environment's own cluster", async () => {
    const s = await openStore();
    saveCustom(s, "hetzner-eu");
    const gke = saveCustom(s, "gke-us", otherKubeconfig);
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "k8s-gke-us", "kubernetes", JSON.stringify({ clusterId: gke }));
    let seen = "";
    deployImpl = async () => {
      seen = readFileSync((targetCalls[0]![1] as { kubeconfig: string }).kubeconfig, "utf8");
      return { contentID: "sha256:" + "c".repeat(64), alreadyLive: false, url: "http://in-cluster", plan: "" };
    };
    const dep = await triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir());
    expect(dep.status).toBe("succeeded");
    expect(seen).toBe(otherKubeconfig);
  });

  it("refuses an environment with no cluster or a disconnected one, before creating a deployment", async () => {
    const s = await openStore();
    saveCustom(s);
    const p = s.createProject("acme");
    const none = s.createEnvironment(p.id, "k8s", "kubernetes");
    await expect(
      triggerDeploy({ store: s, mode: "production", run: recorder() }, none.id, await nboDir()),
    ).rejects.toThrow(/no Kubernetes cluster recorded/);
    const gone = s.createEnvironment(p.id, "k8s-gone", "kubernetes", JSON.stringify({ clusterId: "kc_gone" }));
    await expect(
      triggerDeploy({ store: s, mode: "production", run: recorder() }, gone.id, await nboDir()),
    ).rejects.toThrow(
      "the Kubernetes cluster k8s-gone runs on is no longer connected: connect it again with nbo-server connect kubernetes",
    );
    expect(s.listDeployments(none.id)).toHaveLength(0);
    expect(s.listDeployments(gone.id)).toHaveLength(0);
  });

  it("teardown deletes the namespace on the environment's own cluster only", async () => {
    const s = await openStore();
    saveCustom(s, "hetzner-eu");
    const gke = saveCustom(s, "gke-us", otherKubeconfig);
    let seen = "";
    const spy: CommandRunner = async (_cmd, args) => {
      const i = args.indexOf("--kubeconfig");
      if (i >= 0) seen = readFileSync(args[i + 1]!, "utf8");
      return "";
    };
    await createCloudTeardown(spy, { mode: "production", store: s }).remove({
      target: "kubernetes",
      appName: "pabc-k8s-gke-us",
      projectId: "proj_abc",
      config: { clusterId: gke },
    });
    expect(seen).toBe(otherKubeconfig);
    await expect(
      createCloudTeardown(spy, { mode: "production", store: s }).remove({
        target: "kubernetes",
        appName: "pabc-k8s",
        projectId: "proj_abc",
        config: {},
      }),
    ).rejects.toThrow(/no cluster recorded/);
  });
});
