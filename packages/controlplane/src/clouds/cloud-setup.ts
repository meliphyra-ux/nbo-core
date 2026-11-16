// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { CommandRunner } from "@nbo/deploy";
import { run } from "../builds/run.js";
import type { Mode } from "../mode.js";
import type { Store } from "../store/store.js";

// CommandRunner is the boundary to the operator's own CLIs (gcloud,
// docker, kubectl): resolves stdout+stderr, rejects on a non-zero exit
// (an ENOENT-coded error when the binary is missing).
export type { CommandRunner };

// Connecting a cloud runs slow first-time work (enabling APIs, creating
// service accounts, installing cluster objects); each of its commands
// gets far longer than the preflight default below.
export const connectTimeoutMs = 5 * 60_000;

// Appended to a connect step's failure: connect is not transactional, but
// every step tolerates what an earlier attempt already created.
export const partialConnectNote =
  "Steps before this one may have created resources; running Connect again is safe and reuses them.";

// 60s by default (preflight probes must answer fast); a caller may ask
// for longer per command, as connect does.
export const defaultRunner: CommandRunner = (cmd, args, opts) =>
  run(cmd, args, { timeoutMs: opts?.timeoutMs ?? 60_000, env: opts?.env, input: opts?.input });

export interface Preflight {
  gcloud: {
    installed: boolean;
    account: string | null;
    project: string | null;
    region: string | null;
    ready: boolean;
    reason: string | null;
  };
  docker: { installed: boolean; running: boolean; ready: boolean; reason: string | null };
  kubernetes: {
    reachable: boolean;
    context: string;
    ready: boolean;
    reason: string | null;
    // Production only: a one-line readout ("2 clusters ready", "1 of 2
    // failing", "not connected") and each connected cluster's state.
    summary?: string;
    clusters?: { id: string; name: string; ready: boolean; reason: string | null }[];
  };
}

export interface CloudRunConfig {
  project: string;
  region: string;
  arRepo: string;
}

export interface CloudSetup {
  preflight(): Promise<Preflight>;
  ensureCloudRun(gcpProject: string, region: string): Promise<CloudRunConfig>;
}

export const kindContext = "kind-nbo-local";
const arRepoName = "nbo";

function isMissingBinary(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

// cliMessage drops run()'s "<cmd> failed with exit code N:" first line
// so the operator sees the CLI's own words.
export function cliMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lines = msg.split(/\r?\n/);
  if (
    lines.length > 1 &&
    / (failed with exit code \d+|was killed by signal \w+|timed out after \d+ms):$/.test(lines[0]!)
  ) {
    return lines.slice(1).join("\n").trim();
  }
  return msg.trim();
}

// gcloud prints "(unset)" or nothing for an unset property.
function configValue(out: string): string | null {
  const v = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
  return v === "" || v === "(unset)" ? null : v;
}

// cacheMs: a preflight result is reused this long (the CLIs are slow and
// every page that shows readiness asks for it). 0 disables the cache.
export function createCloudSetup(
  runCmd: CommandRunner = defaultRunner,
  options: { cacheMs?: number; kubeTimeoutMs?: number; mode?: Mode; store?: Store } = {},
): CloudSetup {
  if (options.mode === "production" && !options.store)
    throw new Error("production preflight needs the connections store");
  const cacheMs = options.cacheMs ?? 0;
  // kubectl retries discovery for ~10s against a stopped cluster; a local
  // kind cluster that is up answers well within this.
  const kubeTimeoutMs = options.kubeTimeoutMs ?? 4000;
  let cached: { at: number; value: Promise<Preflight> } | null = null;
  async function gcloudPreflight(): Promise<Preflight["gcloud"]> {
    // Each `gcloud config get-value` costs ~2s on Windows; ask all four at once.
    const get = (key: string) => runCmd("gcloud", ["config", "get-value", key]).then(configValue);
    const [accountR, projectR, runRegionR, computeRegionR] = await Promise.allSettled([
      get("account"),
      get("project"),
      get("run/region"),
      get("compute/region"),
    ]);
    if (accountR.status === "rejected") {
      if (isMissingBinary(accountR.reason))
        return {
          installed: false,
          account: null,
          project: null,
          region: null,
          ready: false,
          reason: "gcloud CLI not found",
        };
      return {
        installed: true,
        account: null,
        project: null,
        region: null,
        ready: false,
        reason: `gcloud failed: ${cliMessage(accountR.reason)}`,
      };
    }
    const account = accountR.value;
    const failed = [projectR, runRegionR, computeRegionR].find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    const project = projectR.status === "fulfilled" ? projectR.value : null;
    const region =
      (runRegionR.status === "fulfilled" ? runRegionR.value : null) ??
      (computeRegionR.status === "fulfilled" ? computeRegionR.value : null);
    if (failed)
      return {
        installed: true,
        account,
        project,
        region,
        ready: false,
        reason: `gcloud failed: ${cliMessage(failed.reason)}`,
      };
    if (!account)
      return {
        installed: true,
        account,
        project,
        region,
        ready: false,
        reason: "gcloud is not logged in — run gcloud auth login",
      };
    if (!project)
      return {
        installed: true,
        account,
        project,
        region,
        ready: false,
        reason: "no default gcloud project — run gcloud config set project <id>",
      };
    return { installed: true, account, project, region, ready: true, reason: null };
  }

  async function dockerPreflight(): Promise<Preflight["docker"]> {
    try {
      await runCmd("docker", ["info", "--format", "{{.ServerVersion}}"]);
      return { installed: true, running: true, ready: true, reason: null };
    } catch (err) {
      if (isMissingBinary(err))
        return { installed: false, running: false, ready: false, reason: "Docker is not installed" };
      return { installed: true, running: false, ready: false, reason: "Docker is not running" };
    }
  }

  async function kubernetesPreflight(): Promise<Preflight["kubernetes"]> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runCmd("kubectl", ["--context", kindContext, "get", "nodes", "-o", "name"]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("kubectl did not answer")), kubeTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      return { reachable: true, context: kindContext, ready: true, reason: null };
    } catch (err) {
      const reason = isMissingBinary(err)
        ? "kubectl is not installed"
        : "local kind cluster nbo-local is not reachable — run scripts/bootstrap-local-k8s.sh";
      return { reachable: false, context: kindContext, ready: false, reason };
    }
  }

  // Production readiness comes from the stored connections, never from the
  // host's own gcloud/kubectl.
  function connectionPreflight(store: Store): Pick<Preflight, "gcloud" | "kubernetes"> {
    const g = store.getGoogleConnection();
    return {
      gcloud: {
        installed: g !== null,
        account: g ? g.deployer : null,
        project: g ? g.project : null,
        region: g ? g.region : null,
        ready: g?.status === "connected",
        reason: g
          ? g.status === "connected"
            ? null
            : g.lastError || "the Google Cloud connection is failing"
          : "Google Cloud is not connected",
      },
      kubernetes: kubernetesReadout(store),
    };
  }

  // Ready when at least one cluster is connected; the summary says how many
  // fail. Each cluster's own state is listed for per-cluster choices.
  function kubernetesReadout(store: Store): Preflight["kubernetes"] {
    const all = store.listKubernetesConnections();
    if (all.length === 0)
      return {
        reachable: false,
        context: "",
        ready: false,
        reason: "Kubernetes is not connected",
        summary: "not connected",
        clusters: [],
      };
    const clusters = all.map((c) => ({
      id: c.id,
      name: c.name,
      ready: c.status === "connected",
      reason: c.status === "connected" ? null : c.lastError || "the Kubernetes connection is failing",
    }));
    const failing = clusters.filter((c) => !c.ready);
    const ready = failing.length < clusters.length;
    let summary: string;
    if (failing.length === 0) summary = clusters.length === 1 ? "1 cluster ready" : `${clusters.length} clusters ready`;
    else summary = clusters.length === 1 ? "failing" : `${failing.length} of ${clusters.length} failing`;
    const reason = ready
      ? null
      : clusters.length === 1
        ? failing[0]!.reason
        : failing.map((c) => `${c.name}: ${c.reason}`).join("; ");
    return { reachable: ready, context: clusters.map((c) => c.name).join(", "), ready, reason, summary, clusters };
  }

  return {
    preflight() {
      if (options.mode === "production" && options.store) {
        const store = options.store;
        return dockerPreflight().then((docker) => ({ ...connectionPreflight(store), docker }));
      }
      if (cached && Date.now() - cached.at < cacheMs) return cached.value;
      const value = Promise.all([gcloudPreflight(), dockerPreflight(), kubernetesPreflight()]).then(
        ([gcloud, docker, kubernetes]) => ({ gcloud, docker, kubernetes }),
      );
      cached = { at: Date.now(), value };
      return value;
    },

    async ensureCloudRun(gcpProject, region) {
      const stepFailed = (what: string, err: unknown) => new Error(`${what} failed: ${cliMessage(err)}`);
      try {
        await runCmd("gcloud", [
          "services",
          "enable",
          "run.googleapis.com",
          "artifactregistry.googleapis.com",
          "secretmanager.googleapis.com",
          "--project",
          gcpProject,
        ]);
      } catch (err) {
        throw stepFailed("enabling the Cloud Run, Artifact Registry and Secret Manager APIs", err);
      }
      try {
        await runCmd("gcloud", [
          "artifacts",
          "repositories",
          "create",
          arRepoName,
          "--repository-format=docker",
          "--location",
          region,
          "--project",
          gcpProject,
          "--quiet",
        ]);
      } catch (err) {
        const msg = cliMessage(err);
        if (!/ALREADY_EXISTS|already exists/i.test(msg))
          throw stepFailed(`creating the Artifact Registry repository "${arRepoName}"`, err);
      }
      const registryHost = `${region}-docker.pkg.dev`;
      try {
        await runCmd("gcloud", ["auth", "configure-docker", registryHost, "--quiet"]);
      } catch (err) {
        throw stepFailed(`configuring docker for ${registryHost}`, err);
      }
      return { project: gcpProject, region, arRepo: `${registryHost}/${gcpProject}/${arRepoName}` };
    },
  };
}
