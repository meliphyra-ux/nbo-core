// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Test support shared by this package's tests and the dashboard's:
// fakes only at the true external boundary (the cloud deploy itself
// and the operator's gcloud/docker/kubectl), plus a real local git
// repo reachable through a public-looking https URL.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Store, Deployment } from "./store/store.js";
import type { DeploymentTrigger } from "./http/handlers.js";
import type { ResolvedEnv } from "./variables/env-vars.js";
import type { CloudSetup, Preflight } from "./clouds/cloud-setup.js";
import type { CloudTeardown, TeardownTarget } from "./clouds/cloud-teardown.js";
import type { GoogleConnect } from "./clouds/google-connect.js";
import type { KubeConnect, KubeConnectRequest } from "./clouds/kube-connect.js";

export const readyPreflight: Preflight = {
  gcloud: {
    installed: true,
    account: "me@example.com",
    project: "my-proj",
    region: "europe-north1",
    ready: true,
    reason: null,
  },
  docker: { installed: true, running: true, ready: true, reason: null },
  kubernetes: { reachable: true, context: "kind-nbo-local", ready: true, reason: null },
};

export interface FakeCloudSetup extends CloudSetup {
  ensured: [string, string][];
  preflightValue: Preflight;
  ensureError: Error | null;
}

export function fakeCloudSetup(preflight: Preflight = readyPreflight): FakeCloudSetup {
  const fake: FakeCloudSetup = {
    ensured: [],
    preflightValue: preflight,
    ensureError: null,
    async preflight() {
      return fake.preflightValue;
    },
    async ensureCloudRun(project, region) {
      fake.ensured.push([project, region]);
      if (fake.ensureError) throw fake.ensureError;
      return { project, region, arRepo: `${region}-docker.pkg.dev/${project}/nbo` };
    },
  };
  return fake;
}

export interface FakeDeploymentTrigger extends DeploymentTrigger {
  // failTargets: deploys to these targets resolve with status "failed".
  failTargets: Set<string>;
  deployed: string[];
  // dirs[i] is the .nbo/ directory deployed[i] was given.
  dirs: string[];
  // options[i] is the options deployed[i] was given.
  options: { buildId?: string; carryFrom?: string; env?: ResolvedEnv; redact?: string[] }[];
  // delayMs holds each deploy open, so tests can observe a running build.
  delayMs: number;
}

// fakeDeploymentTrigger records real deployment rows, the way the real
// triggerDeploy does, with a plausible per-cloud URL.
export function fakeDeploymentTrigger(store: Store): FakeDeploymentTrigger {
  const fake: FakeDeploymentTrigger = {
    failTargets: new Set(),
    deployed: [],
    dirs: [],
    options: [],
    delayMs: 0,
    async triggerDeploy(
      environmentId: string,
      nboDir: string,
      opts?: { buildId?: string; carryFrom?: string; env?: ResolvedEnv; redact?: string[] },
    ): Promise<Deployment> {
      if (fake.delayMs > 0) await new Promise((r) => setTimeout(r, fake.delayMs));
      const env = store.getEnvironment(environmentId);
      const dep = store.createDeployment(environmentId, { buildId: opts?.buildId });
      fake.deployed.push(environmentId);
      fake.dirs.push(nboDir);
      fake.options.push({ ...opts });
      if (fake.failTargets.has(env.target)) {
        store.failDeployment(dep.id, `${env.target} deploy failed: docker push denied`);
      } else {
        const app = `p${env.projectId.slice(-8)}-${env.name}`;
        const url =
          env.target === "cloudrun" ? `https://${app}-abc123-uc.a.run.app` : `https://${app}.127.0.0.1.sslip.io`;
        store.completeDeployment(dep.id, "sha256:fake", url);
      }
      return store.getDeployment(dep.id);
    },
  };
  return fake;
}

// makeLocalRepo creates a real git repo with a static-site-friendly
// first commit and returns its path and head sha.
export async function makeLocalRepo(): Promise<{
  repoPath: string;
  head: string;
  commit(message: string): Promise<string>;
}> {
  const repoPath = await mkdtemp(join(tmpdir(), "nbo-testing-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(repoPath, "README.md"), "# test\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  let n = 0;
  return {
    repoPath,
    head: git("rev-parse", "HEAD"),
    async commit(message: string) {
      await writeFile(join(repoPath, `change-${++n}.txt`), message);
      git("add", ".");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    },
  };
}

const rewrites = new Map<string, string>();

// rewriteGitUrl makes every git process this one spawns (they inherit
// process.env) fetch publicUrl from localPath instead, through git's
// own url.<base>.insteadOf — so the real ls-remote and clone paths run
// end to end against an https URL the API accepts.
export function rewriteGitUrl(publicUrl: string, localPath: string): () => void {
  rewrites.set(publicUrl, localPath);
  applyRewrites();
  return () => {
    rewrites.delete(publicUrl);
    applyRewrites();
  };
}

function applyRewrites(): void {
  for (const key of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete process.env[key];
  }
  let i = 0;
  for (const [publicUrl, localPath] of rewrites) {
    process.env[`GIT_CONFIG_KEY_${i}`] = `url.${localPath.replace(/\\/g, "/")}.insteadOf`;
    process.env[`GIT_CONFIG_VALUE_${i}`] = publicUrl;
    i++;
  }
  if (i > 0) process.env.GIT_CONFIG_COUNT = String(i);
}

export interface FakeCloudTeardown extends CloudTeardown {
  removed: TeardownTarget[];
  failWith: Error | null;
}

// fakeCloudTeardown records what would be deleted instead of running
// kubectl/gcloud.
export function fakeCloudTeardown(): FakeCloudTeardown {
  const fake: FakeCloudTeardown = {
    removed: [],
    failWith: null,
    async remove(t) {
      if (fake.failWith) throw fake.failWith;
      fake.removed.push(t);
    },
  };
  return fake;
}

export interface FakeGoogleConnect extends GoogleConnect {
  calls: string[];
  // failWith makes connect* reject, the way an unsaved connection does.
  failWith: Error | null;
}

// fakeGoogleConnect saves a connection straight into the store, like the
// real connector does once its checks pass.
export function fakeGoogleConnect(store: Store): FakeGoogleConnect {
  const save = (project: string, region: string) =>
    store.saveGoogleConnection(
      {
        project,
        region,
        arRepo: `${region}-docker.pkg.dev/${project}/nbo`,
        deployer: `nbo-deployer@${project}.iam.gserviceaccount.com`,
        puller: `nbo-puller@${project}.iam.gserviceaccount.com`,
      },
      { deployerKey: "{}", pullerKey: "{}" },
    );
  const fake: FakeGoogleConnect = {
    calls: [],
    failWith: null,
    async detect() {
      return { found: true, account: "me@example.com", project: "my-proj", reason: null };
    },
    async connectFromMachine(req) {
      fake.calls.push(`machine ${req.project} ${req.region}`);
      if (fake.failWith) throw fake.failWith;
      return save(req.project, req.region);
    },
    async connectWithKey(req) {
      fake.calls.push(`key ${req.region}`);
      if (fake.failWith) throw fake.failWith;
      return save("key-proj", req.region);
    },
    async test() {
      fake.calls.push("test");
      store.recordConnectionCheck("google", null);
      return store.getGoogleConnection()!;
    },
    plan: (req) => [`plan google ${req.source} ${req.project} ${req.region}`],
  };
  return fake;
}

export interface FakeKubeConnect extends KubeConnect {
  requests: KubeConnectRequest[];
  failWith: Error | null;
}

export function fakeKubeConnect(store: Store): FakeKubeConnect {
  const fake: FakeKubeConnect = {
    requests: [],
    failWith: null,
    async detect() {
      return { contexts: [{ name: "kind-nbo-local", server: "https://127.0.0.1:6443" }], reason: null };
    },
    async connect(req) {
      fake.requests.push(req);
      if (fake.failWith) throw fake.failWith;
      const c = { name: req.name, server: "https://k8s.example:6443", registry: req.registry };
      return store.saveKubernetesConnection(req.id === undefined ? c : { ...c, id: req.id }, {
        kubeconfig: "KUBECONFIG-SECRET",
      });
    },
    async test(id) {
      if (!store.getKubernetesConnection(id)) throw new Error("that Kubernetes cluster is not connected");
      store.recordConnectionCheck("kubernetes", null, id);
      return store.getKubernetesConnection(id)!;
    },
    async updateSetup(id) {
      if (!store.getKubernetesConnection(id)) throw new Error("that Kubernetes cluster is not connected");
      if (fake.failWith) throw fake.failWith;
      store.recordConnectionCheck("kubernetes", null, id);
      return store.getKubernetesConnection(id)!;
    },
    plan: () => ["plan kubernetes"],
  };
  return fake;
}
