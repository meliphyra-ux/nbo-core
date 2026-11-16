// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Installs the public edge into the edge cluster and relays into the other
// clusters that run projects (spec A1, A4). Every billable LoadBalancer needs
// an on-screen confirmation first; everything after the one-off admin setup
// step runs with the cluster's scoped nbo-controller token.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { kubectlArgs, redact, renderNetworkPolicies, withKubeconfig, type CommandRunner } from "@nbo/deploy";
import type { Store } from "../store/store.js";
import { SETUP_OUT_OF_DATE, setupVersionPath, type KubeConnect, type KubeSource } from "../clouds/kube-connect.js";
import type { Mode } from "../mode.js";
import { ErrConflict, ErrInvalid } from "../store/errors.js";
import { edgeNamespace, managedByLabels, SETUP_VERSION, toYaml } from "../clouds/kube-bootstrap.js";
import {
  EDGE_VERSION,
  edgeName,
  relayName,
  renderEdge,
  renderEdgeAdminSecret,
  renderRelay,
  renderRelaySecrets,
  renderRouteTableConfigMap,
  routesConfigMap,
} from "./edge-manifests.js";
import { lbAnnotationsFor, noteKey, operatorSetsLocation } from "../clouds/hetzner.js";
import { liveDeployment } from "../builds/artifacts.js";
import {
  deployAppName,
  kubeconfigSecrets,
  projectNamespace,
  withClusterRegistry,
  type Registry,
} from "../deploys/deploy.js";
import { moveDefaultHosts } from "../domains/hosts.js";
import { caBundle, createRelayCa } from "./relay-ca.js";
import { run as runCommand } from "../builds/run.js";

export interface EdgeStatus {
  installed: boolean;
  clusterId: string;
  address: string;
  ready: number;
  desired: number;
  error?: string;
}

export interface RelayStatus {
  clusterId: string;
  address: string;
  status: string;
}

// onStep hears each step of a long install ("Building the edge image", …).
export interface InstallProgress {
  onStep?: (step: string) => void;
}

export interface EdgeInstaller {
  // validate* make the checks the matching call makes before any long work
  // (confirmation, cluster, edge-move conflict, relay setup version), so a
  // caller can refuse a request before running the work in the background.
  validateInstall(req: { clusterId: string; confirmBilling: boolean }): void;
  validateReinstall(): void;
  validateRelay(req: { clusterId: string; confirmBilling: boolean }): Promise<void>;
  installEdge(
    req: { clusterId: string; admin: KubeSource; confirmBilling: boolean },
    progress?: InstallProgress,
  ): Promise<EdgeStatus>;
  reinstallEdge(progress?: InstallProgress): Promise<EdgeStatus>;
  edgeStatus(): Promise<EdgeStatus>;
  enableRelay(req: { clusterId: string; confirmBilling: boolean }, progress?: InstallProgress): Promise<RelayStatus>;
}

type Step = (step: string) => void;

export interface EdgeInstallerDeps {
  store: Store;
  kubeConnect: KubeConnect;
  run: CommandRunner;
  // buildEdgeImage builds the edge image locally and returns its tag
  // ("nbo-edge:<hash>"); defaultBuildEdgeImage in production.
  buildEdgeImage: () => Promise<string>;
  // reconcile (re)writes the edge's route table (the edge sync's reconcile).
  // It logs a failed write instead of throwing.
  reconcile: () => Promise<void>;
  // pushTable writes the route table now and throws if the write fails.
  pushTable: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  // loadBalancerAnnotations go on the edge's and relays' Services (NBO_LB_ANNOTATIONS).
  loadBalancerAnnotations?: Record<string, string>;
  // mode decides default hosts; the installer is only used in production.
  mode?: Mode;
}

const confirmFirst = "confirm the load balancer first";
const pullSecret = "nbo-pull";
const pollEveryMs = 10_000;
const pollForMs = 10 * 60_000;
// How long a rollout may take before the install counts as failed.
const rolloutTimeout = "600s";
const placeholderRelayName = "nbo-relay.invalid";
// Every edge pod polls the route table every 5 s (kube-source.ts). Two polls
// and a margin: by then each pod has loaded a table written just before.
const edgePickupMs = 11_000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isNotFound = (err: unknown): boolean => /NotFound|not found/.test(errText(err));
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// kubectl output can carry warning lines before the JSON.
function parseJson(out: string): unknown {
  const i = out.indexOf("{");
  return JSON.parse(i > 0 ? out.slice(i) : out);
}

// renderPullSecret: the same kubernetes.io/dockerconfigjson Secret
// (nbo-pull) app deploys put in their namespace, here in nbo-edge.
function renderPullSecret(pull: Registry["pull"]): string {
  const auth = Buffer.from(`${pull.username}:${pull.password}`).toString("base64");
  const config = JSON.stringify({
    auths: { [pull.server]: { username: pull.username, password: pull.password, auth } },
  });
  return toYaml([
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: pullSecret, namespace: edgeNamespace, labels: { ...managedByLabels } },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": Buffer.from(config).toString("base64") },
    },
  ]);
}

type Kubectl = (args: string[], input?: string) => Promise<string>;

export function createEdgeInstaller(deps: EdgeInstallerDeps): EdgeInstaller {
  const { store, run } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const mode: Mode = deps.mode ?? "production";

  const requireCluster = (clusterId: string): void => {
    if (typeof clusterId !== "string" || !store.getKubernetesConnection(clusterId))
      throw new ErrInvalid("that Kubernetes cluster is not connected");
  };

  // withCluster runs fn with the cluster's scoped kubeconfig, in nbo-edge
  // unless told otherwise; anything thrown loses the kubeconfig, its token
  // and extra secrets.
  async function withCluster<T>(
    clusterId: string,
    extra: string[],
    fn: (kubectl: Kubectl) => Promise<T>,
    namespace: string = edgeNamespace,
  ): Promise<T> {
    const kubeconfig = store.getKubernetesSecrets(clusterId).kubeconfig;
    const secrets = [...kubeconfigSecrets(kubeconfig), ...extra];
    try {
      return await withKubeconfig(kubeconfig, namespace, (ctx) =>
        fn((args, input) => run("kubectl", kubectlArgs(ctx, args), input === undefined ? undefined : { input })),
      );
    } catch (err) {
      throw new Error(redact(errText(err), secrets), { cause: err });
    }
  }

  // refreshNetworkPolicies re-applies the policies of every live project on
  // the cluster: one deployed before the edge moved to nbo-edge admits only
  // nbo-system, so the edge or relay would get a 502 until its next deploy.
  // One project's failure doesn't stop the others or the install. Returns a
  // note naming the failures, for the job's last step.
  async function refreshNetworkPolicies(clusterId: string, step: Step): Promise<string | undefined> {
    const failed: string[] = [];
    const envs = store.environmentsUsingCluster(clusterId);
    if (envs.length > 0) step("Letting the edge reach existing projects");
    for (const { projectName, environmentId } of envs) {
      try {
        const env = store.getEnvironment(environmentId);
        if (!liveDeployment(store, env)) continue;
        const ns = projectNamespace(env.projectId);
        await withCluster(
          clusterId,
          [],
          (kubectl) => kubectl(["apply", "-f", "-"], renderNetworkPolicies(ns, deployAppName(env))),
          ns,
        );
      } catch (err) {
        console.error(`control-plane: updating the network policies of project ${projectName} failed: ${errText(err)}`);
        failed.push(projectName);
      }
    }
    return failed.length > 0
      ? `Finished, but the edge may not reach ${failed.join(", ")} until redeployed: updating the network policies failed`
      : undefined;
  }

  // lbAnnotations: the cluster's saved annotations (detected while NBO held
  // admin credentials) under the operator's NBO_LB_ANNOTATIONS.
  function lbAnnotations(clusterId: string, step: Step): Record<string, string> {
    const configured = deps.loadBalancerAnnotations ?? {};
    if (operatorSetsLocation(configured)) return configured;
    const raw = store.getClusterLbAnnotations(clusterId);
    if (raw === null) {
      step(
        `No load balancer location is saved for this cluster. Run nbo-server cluster update-setup ${clusterId} with admin credentials once, or set NBO_LB_ANNOTATIONS, if the load balancer needs a location`,
      );
      return configured;
    }
    const { [noteKey]: note, ...saved } = raw;
    if (note) step(note);
    const merged = lbAnnotationsFor(saved, configured);
    const location = merged["load-balancer.hetzner.cloud/location"];
    if (location !== undefined) step(`Hetzner Cloud: load balancer location ${location}`);
    return merged;
  }

  // pushImage builds the edge image, pushes it to the cluster's own registry
  // (the app deploy path) and refreshes nbo-pull in nbo-edge, then runs fn
  // with the pushed image reference.
  async function pushImage<T>(
    clusterId: string,
    fn: (image: string, kubectl: Kubectl) => Promise<T>,
    extra: string[],
    step: Step,
  ): Promise<T> {
    step("Building the edge image");
    const local = await deps.buildEdgeImage();
    return withClusterRegistry(store, clusterId, run, async (registry) => {
      step("Pushing the image to the cluster's registry");
      const image = `${registry.prefix}/${local}`;
      await run("docker", ["tag", local, image], { env: registry.env });
      await run("docker", ["push", image], { env: registry.env });
      return withCluster(clusterId, [registry.pull.password, ...extra], async (kubectl) => {
        await kubectl(["apply", "-f", "-"], renderPullSecret(registry.pull));
        return fn(image, kubectl);
      });
    });
  }

  // waitForAddress polls the LoadBalancer Service until the provider
  // assigns it an address (IP, else hostname).
  async function waitForAddress(kubectl: Kubectl, service: string): Promise<string> {
    const deadline = pollForMs / pollEveryMs;
    for (let i = 0; ; i++) {
      const svc = parseJson(await kubectl(["get", "service", service, "-o", "json"])) as {
        status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } };
      };
      const ingress = svc.status?.loadBalancer?.ingress?.[0];
      const address = ingress?.ip || ingress?.hostname || "";
      if (address) return address;
      if (i >= deadline - 1) {
        throw new Error(
          `the ${service} load balancer got no address within ${pollForMs / 60_000} minutes — check the cloud's load balancer quota and events (kubectl -n ${edgeNamespace} describe service ${service}), then try again`,
        );
      }
      await sleep(pollEveryMs);
    }
  }

  // waitReady waits for a Deployment's rollout: a LoadBalancer gets its
  // address whatever its pods do, so only ready pods mean a working edge/relay.
  async function waitReady(kubectl: Kubectl, name: string, what: string): Promise<void> {
    try {
      await kubectl(["rollout", "status", `deployment/${name}`, `--timeout=${rolloutTimeout}`]);
    } catch (err) {
      throw new Error(`the ${what} pods did not become ready: ${errText(err)}`, { cause: err });
    }
  }

  // setupVersion reads the guard's setup version with the scoped token, as
  // kube-connect's test does: a missing annotation or a forbidden read
  // (setups before version 2 cannot read the guard) is version 1.
  async function setupVersion(clusterId: string): Promise<number> {
    const out = await withCluster(clusterId, [], async (kubectl) => {
      try {
        return await kubectl(["get", "validatingadmissionpolicy", "nbo-namespace-guard", "-o", setupVersionPath]);
      } catch (err) {
        if (/forbidden|NotFound/i.test(errText(err))) return "";
        throw err;
      }
    });
    const words = out.split(/\s+/).filter((w) => /^\d+$/.test(w));
    return words.length ? Number(words[words.length - 1]) : 1;
  }

  const drainToken = (): string => {
    const existing = store.getServerSecret("edge_drain_token");
    if (existing) return existing;
    const token = randomBytes(32).toString("hex");
    store.setServerSecret("edge_drain_token", token);
    return token;
  };

  // applyEdge pushes the image and applies the edge's objects; an empty
  // route table only when there is none (an existing one is the live state).
  async function applyEdge(clusterId: string, step: Step): Promise<string> {
    const token = drainToken();
    const serviceAnnotations = lbAnnotations(clusterId, step);
    return pushImage(
      clusterId,
      async (image, kubectl) => {
        step("Applying the edge");
        await kubectl(["apply", "-f", "-"], renderEdgeAdminSecret(token));
        await kubectl(["apply", "-f", "-"], renderEdge({ image, pullSecret, serviceAnnotations }));
        try {
          await kubectl(["get", "configmap", routesConfigMap, "-o", "json"]);
        } catch (err) {
          if (!isNotFound(err)) throw err;
          await kubectl(["create", "-f", "-"], renderRouteTableConfigMap({ version: 1, targets: {}, challenges: {} }));
        }
        step("Waiting for the load balancer's address");
        const address = await waitForAddress(kubectl, edgeName);
        step("Waiting for the edge pods");
        await waitReady(kubectl, edgeName, "edge");
        return address;
      },
      [token],
      step,
    );
  }

  async function finishEdge(clusterId: string, address: string, step: Step): Promise<EdgeStatus> {
    const note = await refreshNetworkPolicies(clusterId, step);
    step("Updating the route table");
    const previous = store.getServerSettings();
    store.updateServerSettings({ edgeClusterId: clusterId, edgeAddress: address, edgeVersion: EDGE_VERSION });
    // The old default host points at the old address: it is dropped.
    moveDefaultHosts(store, previous, mode, { previousDefault: true });
    await deps.reconcile();
    if (note) step(note);
    return self.edgeStatus();
  }

  const noStep: Step = () => {};

  const self: EdgeInstaller = {
    validateInstall(req) {
      if (req?.confirmBilling !== true) throw new ErrInvalid(confirmFirst);
      requireCluster(req.clusterId);
      const settings = store.getServerSettings();
      if (
        settings.edgeClusterId !== "" &&
        settings.edgeClusterId !== req.clusterId &&
        store.listDomains().some((d) => d.kind === "custom" && d.serving === "edge")
      ) {
        throw new ErrConflict(
          "the edge can't move to another cluster while project domains point at it — remove the custom domains first",
        );
      }
    },

    validateReinstall() {
      const { edgeClusterId } = store.getServerSettings();
      if (!edgeClusterId) throw new ErrInvalid("install the edge first");
      requireCluster(edgeClusterId);
    },

    async validateRelay(req) {
      if (req?.confirmBilling !== true) throw new ErrInvalid(confirmFirst);
      requireCluster(req.clusterId);
      if (req.clusterId === store.getServerSettings().edgeClusterId)
        throw new ErrInvalid("the edge cluster needs no relay — the edge reaches its apps directly");
      // Before building anything: an out-of-date guard refuses nbo-edge.
      if ((await setupVersion(req.clusterId)) < SETUP_VERSION) throw new ErrInvalid(SETUP_OUT_OF_DATE);
    },

    async installEdge(req, progress) {
      const step = progress?.onStep ?? noStep;
      self.validateInstall(req);
      step("Updating the cluster setup");
      await deps.kubeConnect.updateSetup(req.clusterId, req.admin);
      const address = await applyEdge(req.clusterId, step);
      return finishEdge(req.clusterId, address, step);
    },

    async reinstallEdge(progress) {
      const step = progress?.onStep ?? noStep;
      self.validateReinstall();
      const { edgeClusterId } = store.getServerSettings();
      const address = await applyEdge(edgeClusterId, step);
      return finishEdge(edgeClusterId, address, step);
    },

    async edgeStatus() {
      const { edgeClusterId, edgeAddress } = store.getServerSettings();
      if (!edgeClusterId) return { installed: false, clusterId: "", address: "", ready: 0, desired: 0 };
      const base = { installed: true, clusterId: edgeClusterId, address: edgeAddress };
      try {
        const d = await withCluster(
          edgeClusterId,
          [],
          async (kubectl) =>
            parseJson(await kubectl(["get", "deployment", edgeName, "-o", "json"])) as {
              spec?: { replicas?: number };
              status?: { readyReplicas?: number };
            },
        );
        return { ...base, ready: d.status?.readyReplicas ?? 0, desired: d.spec?.replicas ?? 0 };
      } catch (err) {
        return { ...base, ready: 0, desired: 0, error: errText(err) };
      }
    },

    async enableRelay(req, progress) {
      const step = progress?.onStep ?? noStep;
      await self.validateRelay(req);
      const existing = store.getRelay(req.clusterId);
      const token = existing?.token || randomBytes(32).toString("hex");
      const serviceAnnotations = lbAnnotations(req.clusterId, step);
      const { address, ca } = await pushImage(
        req.clusterId,
        async (image, kubectl) => {
          // A first relay needs some certificate to start with; a re-enabled
          // one keeps serving its current one until the restart.
          if (!existing) {
            const placeholder = await createRelayCa([placeholderRelayName]);
            await kubectl(["apply", "-f", "-"], renderRelaySecrets(token, placeholder.certPem, placeholder.keyPem));
          }
          step("Applying the relay");
          await kubectl(["apply", "-f", "-"], renderRelay({ image, pullSecret, serviceAnnotations }));
          step("Waiting for the load balancer's address");
          const address = await waitForAddress(kubectl, relayName);
          const ca = await createRelayCa([address]);
          if (existing) {
            // Rotation: the edge trusts the old and the new CA until every
            // relay pod serves the new certificate.
            const bundle = caBundle(existing.caPem, ca.caPem);
            store.saveRelay({
              clusterId: req.clusterId,
              address,
              caPem: bundle,
              token,
              caKeyPem: ca.caKeyPem,
              certPem: ca.certPem,
              keyPem: ca.keyPem,
              status: "rotating",
            });
            // Without an edge there is no table, and nobody to break.
            if (store.getServerSettings().edgeClusterId !== "") {
              step("Making the edge trust the new certificate");
              try {
                await deps.pushTable();
              } catch (err) {
                store.saveRelay(existing);
                throw new Error(
                  `the edge's route table could not be updated, so the relay keeps its current certificate: ${errText(err)}`,
                  { cause: err },
                );
              }
              await sleep(edgePickupMs);
            }
          }
          await kubectl(["apply", "-f", "-"], renderRelaySecrets(token, ca.certPem, ca.keyPem));
          await kubectl(["rollout", "restart", `deployment/${relayName}`]);
          step("Waiting for the relay pods");
          await waitReady(kubectl, relayName, "relay");
          return { address, ca };
        },
        [token, ...(existing ? [existing.keyPem, existing.caKeyPem] : [])],
        step,
      );
      const note = await refreshNetworkPolicies(req.clusterId, step);
      step("Updating the route table");
      store.saveRelay({
        clusterId: req.clusterId,
        address,
        caPem: ca.caPem,
        token,
        caKeyPem: ca.caKeyPem,
        certPem: ca.certPem,
        keyPem: ca.keyPem,
        status: "ready",
      });
      await deps.reconcile();
      if (note) step(note);
      return { clusterId: req.clusterId, address, status: "ready" };
    },
  };
  return self;
}

// The repository root (packages/controlplane/{src,dist}/edge/ → ../../../..).
const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

// hashDir: sha256 over the sorted relative file list and each file's bytes.
async function hashDir(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  await walk(dir);
  const h = createHash("sha256");
  for (const f of files.map((f) => relative(dir, f).split(sep).join("/")).sort()) {
    h.update(f + "\0");
    h.update(await readFile(join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

// The Rust edge's inputs: what its Dockerfile copies, so a change to any of
// them (and nothing in target/ or tests/) changes the image tag.
const rustInputs = ["Dockerfile", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src", "assets"];

// hashRustCrate: sha256 over the crate's build inputs (relative paths and bytes).
async function hashRustCrate(crate: string): Promise<string> {
  const h = createHash("sha256");
  const add = async (rel: string): Promise<void> => {
    const abs = join(crate, rel);
    const st = await stat(abs);
    if (st.isDirectory()) {
      for (const e of (await readdir(abs)).sort()) await add(`${rel}/${e}`);
      return;
    }
    h.update(rel + "\0");
    h.update(await readFile(abs));
    h.update("\0");
  };
  for (const rel of rustInputs) await add(rel);
  return h.digest("hex").slice(0, 12);
}

// defaultBuildEdgeImage builds the edge image from this checkout. By default
// that is the Node edge (until the Rust gate passes); NBO_EDGE_IMPL=rust (or
// opts.impl) opts in to the Rust edge: packages/edge-rs is the Docker build
// context and Docker compiles it (the control-plane image carries no Rust
// toolchain), tagged by the hash of the crate's inputs. The Node edge is a self-contained `pnpm deploy` of @nbo/edge
// (Linux dependencies, hoisted, as the other deployed images are built) as the
// build context, tagged by the hash of that folder. tempRoot defaults to the
// system temp dir (TEMP/TMP).
export function defaultBuildEdgeImage(
  opts: { run?: CommandRunner; tempRoot?: string; root?: string; impl?: string } = {},
): () => Promise<string> {
  const root = opts.root ?? repoRoot;
  const cmd: CommandRunner =
    opts.run ??
    ((c, args, o) => runCommand(c, args, { timeoutMs: 15 * 60_000, env: o?.env, input: o?.input, cwd: root }));
  return async () => {
    const impl = opts.impl ?? process.env.NBO_EDGE_IMPL ?? "";
    if (impl !== "" && impl !== "ts" && impl !== "rust")
      throw new Error(`NBO_EDGE_IMPL must be "ts" (the default) or "rust", not ${JSON.stringify(impl)}`);
    if (impl === "rust") {
      const crate = join(root, "packages", "edge-rs");
      const tag = `nbo-edge:${await hashRustCrate(crate)}`;
      await cmd("docker", ["build", "-t", tag, "-f", join(crate, "Dockerfile"), crate]);
      return tag;
    }
    const dir = await mkdtemp(join(opts.tempRoot ?? tmpdir(), "nbo-edge-image-"));
    try {
      const ctx = join(dir, "ctx");
      await cmd("pnpm", ["--dir", root, "--filter", "@nbo/edge...", "build"]);
      await cmd("pnpm", [
        "--dir",
        root,
        "--filter",
        "@nbo/edge",
        "deploy",
        "--prod",
        "--os=linux",
        "--cpu=x64",
        "--libc=glibc",
        "--config.node-linker=hoisted",
        ctx,
      ]);
      const tag = `nbo-edge:${await hashDir(ctx)}`;
      await cmd("docker", ["build", "-t", tag, "-f", join(root, "packages", "edge", "Dockerfile"), ctx]);
      return tag;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
