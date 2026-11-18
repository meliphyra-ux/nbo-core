// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { kubectlArgs, redact, withKubeconfig, type CommandRunner } from "@nbo/deploy";
import { detectAndSave } from "./hetzner.js";
import {
  clusterNameRule,
  reservedClusterName,
  reservedClusterNameRule,
  validClusterName,
  type KubernetesConnection,
  type RegistryConfig,
} from "./connections.js";
import {
  bearerKubeconfig,
  renderAccess,
  renderGuard,
  scopedKubeconfig,
  SETUP_VERSION,
  systemNamespace,
} from "./kube-bootstrap.js";
import type { Store } from "../store/store.js";
import { connectTimeoutMs, partialConnectNote } from "./cloud-setup.js";
import { PULLER_NOTE } from "./google-wif.js";

export interface KubeDetection {
  contexts: { name: string; server: string }[];
  reason: string | null;
}

export type KubeSource =
  | { kind: "machine"; context: string }
  | { kind: "kubeconfig"; kubeconfig: string; context?: string }
  | { kind: "token"; server: string; caData: string; token: string };

export interface KubeConnectRequest {
  // id: replace this existing connection (new credentials or registry)
  // instead of adding a new one.
  id?: string;
  source: KubeSource;
  name: string;
  registry: RegistryConfig;
  registryPassword?: string;
}

export interface KubeConnect {
  detect(): Promise<KubeDetection>;
  connect(req: KubeConnectRequest): Promise<KubernetesConnection>;
  // test re-checks one connected cluster with its own stored kubeconfig.
  test(id: string): Promise<KubernetesConnection>;
  // updateSetup re-applies the guard and NBO's RBAC with admin credentials
  // (never stored), keeping the stored token, then re-checks.
  updateSetup(id: string, source: KubeSource): Promise<KubernetesConnection>;
  plan(): string[];
}

const MIN_MINOR = 30;
const TOKEN_SECRET = "nbo-controller-token";
const OVERBROAD = "NBO's token can read other namespaces — re-run setup";
const GUARD_MISSING = "NBO's namespace guard is missing — re-run setup";
export const SETUP_OUT_OF_DATE = "Cluster setup is out of date — update it (needs admin credentials)";
export const setupVersionPath = "jsonpath={.metadata.annotations.nbo\\.dev/setup-version}";
const transientCheck = /Unauthorized|connection refused|i\/o timeout|timed out|cannot create/i;

// Raised by step(); marks errors that are already redacted and name their step.
class StepError extends Error {}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Runners return stdout and stderr merged; pull the JSON object out from
// between any warning lines.
function extractJson(output: string): unknown {
  const a = output.indexOf("{");
  const b = output.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(output.slice(a, b + 1));
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pollEveryMs = 1000;
const pollForMs = 20_000;
const testDelays = [1000, 2000, 4000, 8000]; // 15s total

// Credential values in a kubeconfig (YAML or JSON form), for redaction.
function credentialsIn(text: string): string[] {
  const out: string[] = [];
  const re =
    /\b(token|client-key-data|client-certificate-data|client-secret|password|certificate-authority-data)\b["']?\s*:\s*["']?([^\s"',}]+)/g;
  for (const m of text.matchAll(re)) if (m[2] && m[2].length >= 4) out.push(m[2]);
  return out;
}

interface KubeconfigJson {
  clusters?: { name?: string; cluster?: { server?: string; "certificate-authority-data"?: string } }[] | null;
  contexts?: { name?: string; context?: { cluster?: string } }[] | null;
}

// `kubectl version -o json` server minors look like "30" or, on GKE/EKS, "30+".
function parseVersion(output: string): { major: number; minor: number } | null {
  const v = (extractJson(output) as { serverVersion?: { major?: unknown; minor?: unknown } } | null)?.serverVersion;
  const major = /^(\d+)/.exec(String(v?.major ?? ""));
  const minor = /^(\d+)/.exec(String(v?.minor ?? ""));
  if (!major || !minor) return null;
  return { major: Number(major[1]), minor: Number(minor[1]) };
}

// `-o jsonpath={.data.token}` prints the base64 token, possibly among
// warning lines; the token is by far the longest base64 word.
function decodeToken(output: string): string | null {
  const words = output.split(/\s+/).filter((w) => w.length >= 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(w));
  if (words.length === 0) return null;
  const b64 = words.reduce((a, b) => (b.length > a.length ? b : a));
  const token = Buffer.from(b64, "base64").toString("utf8").trim();
  return token && !/\s/.test(token) ? token : null;
}

function rebuildRegistry(
  registry: RegistryConfig,
  password: string | undefined,
  store: Store,
): { registry: RegistryConfig; registryPassword?: string } {
  if (registry?.kind === "artifact-registry") {
    if (!store.getGoogleConnection()) throw new Error("connect Google Cloud first or name a registry");
    // A keyless connection whose project refused the puller key.
    if (!store.getGoogleSecrets().pullerKey) throw new Error(PULLER_NOTE);
    return { registry: { kind: "artifact-registry" } };
  }
  if (registry?.kind === "custom") {
    const server = typeof registry.server === "string" ? registry.server.trim() : "";
    const username = typeof registry.username === "string" ? registry.username.trim() : "";
    if (!server) throw new Error("a custom registry needs a server");
    if (!username) throw new Error("a custom registry needs a username");
    if (typeof password !== "string" || !password) throw new Error("a custom registry needs a password");
    return { registry: { kind: "custom", server, username }, registryPassword: password };
  }
  throw new Error("choose a registry: Artifact Registry or a custom registry");
}

type Kubectl = (args: string[], input?: string) => Promise<string>;

export function createKubeConnect(deps: {
  store: Store;
  run: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
}): KubeConnect {
  const { store, run } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  // Runs one named step; failures become errors that name the step, with
  // credentials redacted.
  async function step<T>(name: string, secrets: string[], fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError(`Kubernetes failed while ${name}: ${redact(errText(err), secrets)}`);
    }
  }

  // Runs fn with kubectl bound to the admin credentials. They live only in
  // memory (or a private temp file removed afterwards) and are never saved.
  async function withAdmin<T>(source: KubeSource, secrets: string[], fn: (kc: Kubectl) => Promise<T>): Promise<T> {
    const exec =
      (pre: string[]): Kubectl =>
      (args, input) =>
        run(
          "kubectl",
          [...pre, ...args],
          input === undefined ? { timeoutMs: connectTimeoutMs } : { input, timeoutMs: connectTimeoutMs },
        );
    if (source.kind === "machine") {
      if (!source.context) throw new Error("choose a kubeconfig context");
      return fn(exec(["--context", source.context]));
    }
    const kubeconfig =
      source.kind === "kubeconfig"
        ? source.kubeconfig
        : bearerKubeconfig(source.server, source.caData, source.token, "nbo-admin");
    if (!kubeconfig.trim()) throw new Error("paste a kubeconfig");
    secrets.push(kubeconfig);
    try {
      return await withKubeconfig(kubeconfig, undefined, (ctx) =>
        fn(exec(kubectlArgs(ctx, source.kind === "kubeconfig" && source.context ? ["--context", source.context] : []))),
      );
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError(`Kubernetes failed while preparing the admin credentials: ${redact(errText(err), secrets)}`);
    }
  }

  async function clusterOf(
    kc: Kubectl,
    source: KubeSource,
    secrets: string[],
  ): Promise<{ server: string; caData: string }> {
    if (source.kind === "token") return { server: source.server, caData: source.caData };
    return step("reading the cluster address", secrets, async () => {
      const out = await kc(["config", "view", "--raw", "--minify", "--flatten", "-o", "json"]);
      secrets.push(...credentialsIn(out).filter((c) => c.length >= 8));
      const cluster = (extractJson(out) as KubeconfigJson | null)?.clusters?.[0]?.cluster;
      if (!cluster?.server) throw new Error("the kubeconfig context has no cluster server");
      if (!/^https:\/\//.test(cluster.server))
        throw new StepError("NBO only connects to clusters served over https://");
      return { server: cluster.server, caData: cluster["certificate-authority-data"] ?? "" };
    });
  }

  async function pollToken(kc: Kubectl, secrets: string[]): Promise<string> {
    return step(`waiting for the nbo-controller token (secret ${TOKEN_SECRET})`, secrets, async () => {
      let last: unknown;
      for (let waited = 0; ; waited += pollEveryMs) {
        try {
          const token = decodeToken(
            await kc(["get", "secret", TOKEN_SECRET, "-n", systemNamespace, "-o", "jsonpath={.data.token}"]),
          );
          if (token) return token;
          last = null;
        } catch (err) {
          last = err;
        }
        if (waited + pollEveryMs > pollForMs) break;
        await sleep(pollEveryMs);
      }
      throw new Error(`the token was not issued within ${pollForMs / 1000}s${last ? `: ${errText(last)}` : ""}`);
    });
  }

  // kubectl auth can-i prints a line that is exactly "yes" or "no" (optionally
  // "no - <reason>") and exits 1 on "no". Only such a line counts as an
  // answer, so an error like "no configuration has been provided" is not a "no".
  const answerLine = /^(yes|no)( - .*)?$/;
  async function canI(kc: Kubectl, args: string[]): Promise<boolean> {
    let text: string;
    try {
      text = await kc(["auth", "can-i", ...args]);
    } catch (err) {
      text = errText(err);
      const lines = text.split(/\r?\n/).slice(1);
      if (lines.some((l) => answerLine.test(l.trim()) && l.trim().startsWith("no"))) return false;
      throw err;
    }
    const answers = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => answerLine.test(l));
    const answer = answers[answers.length - 1];
    if (!answer) throw new Error(`unexpected kubectl auth can-i output: ${text}`);
    return answer.startsWith("yes");
  }

  // RBAC lets the token create RoleBindings in any namespace and bind
  // nbo-project-deployer, so a server-side dry run of one in `default` reaches
  // admission. Only nbo-namespace-guard's denial proves the guard is in place.
  async function guardProbe(kc: Kubectl, secrets: string[]): Promise<void> {
    const args = [
      "create",
      "rolebinding",
      "nbo-probe",
      "-n",
      "default",
      "--clusterrole=nbo-project-deployer",
      "--serviceaccount=nbo-system:nbo-controller",
      "--dry-run=server",
    ];
    try {
      await kc(args);
    } catch (err) {
      const text = errText(err);
      if (/ValidatingAdmissionPolicy '?nbo-namespace-guard'?.*denied/.test(text)) return;
      if (transientCheck.test(text))
        throw new StepError(`Kubernetes failed while probing the namespace guard: ${redact(text, secrets)}`);
      throw new StepError(`NBO's namespace guard did not answer the probe — re-run setup: ${redact(text, secrets)}`);
    }
    throw new StepError(GUARD_MISSING);
  }

  // The setup version the cluster's guard records. A missing annotation or a
  // forbidden read (setups before version 2 cannot read the guard) is 1.
  async function setupVersion(kc: Kubectl, secrets: string[]): Promise<number> {
    let out: string;
    try {
      out = await kc(["get", "validatingadmissionpolicy", "nbo-namespace-guard", "-o", setupVersionPath]);
    } catch (err) {
      const text = errText(err);
      if (/forbidden|NotFound/i.test(text)) return 1;
      throw new StepError(`Kubernetes failed while reading the cluster setup version: ${redact(text, secrets)}`);
    }
    const words = out.split(/\s+/).filter((w) => /^\d+$/.test(w));
    return words.length ? Number(words[words.length - 1]) : 1;
  }

  // Applies the guard and then the access it guards: two applies, because
  // kubectl carries on past a rejected document, so a refused guard must stop
  // us before any access is granted.
  async function applySetup(kc: Kubectl, secrets: string[]): Promise<void> {
    await step("installing the nbo-namespace-guard admission policy", secrets, () =>
      kc(["apply", "-f", "-"], renderGuard()),
    );
    await step("applying the NBO bootstrap (namespace, service account and RBAC)", secrets, () =>
      kc(["apply", "-f", "-"], renderAccess()),
    );
  }

  function sourceSecrets(source: KubeSource): string[] {
    if (source?.kind === "kubeconfig") return [source.kubeconfig, ...credentialsIn(source.kubeconfig)];
    if (source?.kind === "token") return [source.token, source.caData];
    if (source?.kind !== "machine") throw new Error("choose how to reach the cluster");
    return [];
  }

  // Installs NBO's access with the admin credentials and returns the scoped
  // kubeconfig. A step failure says that earlier steps may have left
  // resources behind and that re-running is safe (every apply is idempotent).
  async function bootstrap(source: KubeSource, secrets: string[]): Promise<{ server: string; kubeconfig: string }> {
    try {
      return await withAdmin(source, secrets, async (kc) => {
        await step("checking the Kubernetes version", secrets, async () => {
          const out = await kc(["version", "-o", "json"]);
          const v = parseVersion(out);
          if (!v) throw new Error("kubectl did not report the server version");
          if (v.major < 1 || (v.major === 1 && v.minor < MIN_MINOR)) {
            throw new StepError(
              `NBO needs Kubernetes 1.${MIN_MINOR} or newer (this cluster runs ${v.major}.${v.minor})`,
            );
          }
        });
        const cluster = await clusterOf(kc, source, secrets);
        await applySetup(kc, secrets);
        const token = await pollToken(kc, secrets);
        secrets.push(token);
        const scoped = await step("building the scoped kubeconfig", secrets, async () =>
          scopedKubeconfig(cluster.server, cluster.caData, token),
        );
        return { server: cluster.server, kubeconfig: scoped };
      });
    } catch (err) {
      if (err instanceof StepError) throw new StepError(`${err.message} ${partialConnectNote}`);
      throw err;
    }
  }

  // After saving, a fresh token may briefly be refused, and a just-installed
  // admission policy takes a moment to start enforcing (so the guard probe
  // can briefly look unguarded); retry the check on those, then return the
  // saved connection (connected or failing).
  async function settle(id: string): Promise<KubernetesConnection> {
    for (let i = 0; ; i++) {
      try {
        return await self.test(id);
      } catch (err) {
        const text = errText(err);
        const transient = transientCheck.test(text) || text === GUARD_MISSING;
        if (i >= testDelays.length || !transient) return store.getKubernetesConnection(id)!;
        await sleep(testDelays[i]!);
      }
    }
  }

  const self: KubeConnect = {
    async detect() {
      try {
        const cfg = extractJson(await run("kubectl", ["config", "view", "-o", "json"])) as KubeconfigJson | null;
        const servers = new Map((cfg?.clusters ?? []).map((c) => [c.name ?? "", c.cluster?.server ?? ""]));
        const contexts = (cfg?.contexts ?? [])
          .filter((c) => c.name)
          .map((c) => ({ name: c.name!, server: servers.get(c.context?.cluster ?? "") ?? "" }));
        if (contexts.length === 0) return { contexts: [], reason: "the machine's kubeconfig has no contexts" };
        return { contexts, reason: null };
      } catch (err) {
        const text = errText(err);
        const missing = (err as { code?: unknown })?.code === "ENOENT" || /ENOENT/.test(text);
        return {
          contexts: [],
          reason: missing ? "kubectl is not installed in the NBO container" : `could not read the kubeconfig: ${text}`,
        };
      }
    },

    async connect(req) {
      const name = typeof req.name === "string" ? req.name.trim() : "";
      if (!name) throw new Error("name the cluster");
      if (!validClusterName.test(name)) throw new Error(clusterNameRule);
      if (req.id === undefined && reservedClusterName(name)) throw new Error(reservedClusterNameRule);
      if (req.id !== undefined) {
        const current = store.getKubernetesConnection(req.id);
        if (!current) throw new Error("that Kubernetes cluster is not connected");
        if (current.name !== name) throw new Error("a cluster's name cannot change after it is connected");
      }
      // Checked before touching the cluster; the store enforces it again.
      if (store.listKubernetesConnections().some((c) => c.name === name && c.id !== req.id))
        throw new Error(`a cluster named "${name}" is already connected — choose another name`);
      const { registry, registryPassword } = rebuildRegistry(req.registry, req.registryPassword, store);
      const source = req.source;
      const secrets = sourceSecrets(source);

      const { server, kubeconfig } = await bootstrap(source, secrets);
      const saved = store.saveKubernetesConnection(
        req.id === undefined ? { name, server, registry } : { id: req.id, name, server, registry },
        registryPassword === undefined ? { kubeconfig } : { kubeconfig, registryPassword },
      );
      // The admin credentials are at hand only now: read the nodes for the
      // Hetzner load balancer location (a failure is logged, never fatal).
      await detectAndSave(store, saved.id, () =>
        withAdmin(source, secrets, (kc) => kc(["get", "nodes", "-o", "json"])),
      );
      return settle(saved.id);
    },

    async test(id) {
      const conn = store.getKubernetesConnection(id);
      if (!conn) throw new Error("that Kubernetes cluster is not connected");
      const { kubeconfig } = store.getKubernetesSecrets(id);
      const secrets = [kubeconfig, ...credentialsIn(kubeconfig)];
      try {
        await withKubeconfig(kubeconfig, undefined, async (ctx) => {
          const kc: Kubectl = (args) => run("kubectl", kubectlArgs(ctx, args));
          const must = async (args: string[], what: string): Promise<void> => {
            const ok = await step(`checking it can ${what}`, secrets, () => canI(kc, args));
            if (!ok) throw new StepError(`NBO's token cannot ${what} — re-run setup`);
          };
          await must(["create", "deployments", "-n", systemNamespace], `create deployments in ${systemNamespace}`);
          await must(["create", "namespaces"], "create namespaces");
          const leaks = await step("checking it cannot read other namespaces", secrets, () =>
            canI(kc, ["get", "secrets", "-n", "default"]),
          );
          if (leaks) throw new StepError(OVERBROAD);
          await guardProbe(kc, secrets);
          if ((await setupVersion(kc, secrets)) < SETUP_VERSION) throw new StepError(SETUP_OUT_OF_DATE);
        });
      } catch (err) {
        const message =
          err instanceof StepError
            ? err.message
            : `Kubernetes failed while using the stored kubeconfig: ${redact(errText(err), secrets)}`;
        store.recordConnectionCheck("kubernetes", message, id);
        // eslint-disable-next-line preserve-caught-error -- the original error may carry the token
        throw new Error(message);
      }
      store.recordConnectionCheck("kubernetes", null, id);
      return store.getKubernetesConnection(id)!;
    },

    async updateSetup(id, source) {
      const conn = store.getKubernetesConnection(id);
      if (!conn) throw new Error("that Kubernetes cluster is not connected");
      const secrets = sourceSecrets(source);
      // Only the guard and RBAC are re-applied; the stored token (and the
      // saved connection) stay as they are, and the admin credentials are
      // used in memory only.
      await withAdmin(source, secrets, async (kc) => {
        const cluster = await clusterOf(kc, source, secrets);
        if (cluster.server !== conn.server)
          throw new StepError(
            `these admin credentials are for another cluster (${cluster.server}), not ${conn.server}`,
          );
        await applySetup(kc, secrets);
      });
      await detectAndSave(store, id, () => withAdmin(source, secrets, (kc) => kc(["get", "nodes", "-o", "json"])));
      return settle(id);
    },

    plan() {
      return [
        `Check that the cluster runs Kubernetes 1.${MIN_MINOR} or newer.`,
        `Create the ${systemNamespace} namespace with a service account, nbo-controller, and a token for it.`,
        `Let nbo-controller create namespaces and deploy apps only in ${systemNamespace} and nbo-p-* namespaces (deployments, services, secrets, config maps, service accounts, network policies; pods and logs read-only).`,
        "Install an admission policy, nbo-namespace-guard, that denies nbo-controller any change outside those namespaces, any Service other than ClusterIP (except the public edge's and relay's own load balancers, nbo-edge and nbo-relay in the nbo-edge namespace), and any role binding other than its own.",
        `Create a namespace for the public edge, nbo-edge, with a service account that may only read config maps and secrets there (never in ${systemNamespace}), and let nbo-controller deploy there and reach its pods through the API server's proxy (for the edge's Speed Insights).`,
        "Enforce Pod Security baseline on every NBO namespace, so apps cannot run privileged or reach the host.",
        "Store only nbo-controller's token, encrypted in NBO. The admin credentials you use here are used once and not stored.",
      ];
    },
  };
  return self;
}
