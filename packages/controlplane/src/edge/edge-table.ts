// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The public edge's route table in the edge cluster (spec A2–A4): rendered
// from the database for every project at once, written to ConfigMap
// nbo-edge-routes with the edge cluster's scoped token, and the Speed
// Insights drain through the API server's pod proxy.
import { kubectlArgs, redact, withKubeconfig, type CommandRunner } from "@nbo/deploy";
import type { Environment, Store } from "../store/store.js";
import type { Domain } from "../domains/domains.js";
import type { Mode } from "../mode.js";
import { defaultClusterId, environmentClusterId } from "../clouds/connections.js";
import { edgeNamespace, managedByLabels } from "../clouds/kube-bootstrap.js";
import {
  certSecretName,
  edgeName,
  renderRouteTableConfigMap,
  routesConfigMap,
  routesKey,
  type RouteTable,
  type RouteTableBackend,
} from "./edge-manifests.js";
import { kubeconfigSecrets } from "../deploys/deploy.js";
import { hasOwnHost } from "../stages/stages.js";

// latestSuccessfulURL mirrors scheduler.ts's rule: the last succeeded
// deployment (listDeployments orders by created_at) is the live one.
export function latestSuccessfulURL(store: Store, environmentId: string): string | null {
  const deps = store.listDeployments(environmentId);
  for (let i = deps.length - 1; i >= 0; i--) {
    const d = deps[i]!;
    if (d.status === "succeeded" && d.url !== "") return d.url;
  }
  return null;
}

// clusterEdgeActive: the public edge in a cluster is what routes traffic
// (production mode with an edge cluster chosen); otherwise the dev edge.
export function clusterEdgeActive(store: Store, mode: Mode | undefined): boolean {
  return mode === "production" && store.getServerSettings().edgeClusterId !== "";
}

export const noPublicEntry =
  "This cluster has no public entry yet. Enable it on the server with: nbo-server cluster relay <cluster id> --confirm-billing";

// cannotTakeTrafficReason says why an environment can't be routed to even
// with a deployment: with the public edge installed, a Kubernetes
// environment on another cluster is reached only through that cluster's
// relay (spec A4), so it waits for the relay to have an address. The route
// table below leaves such a backend out by the same rule. null otherwise
// (always in dev mode).
export function cannotTakeTrafficReason(
  store: Store,
  mode: Mode | undefined,
  env: Pick<Environment, "target" | "config">,
): string | null {
  if (env.target !== "kubernetes" || !clusterEdgeActive(store, mode)) return null;
  return clusterTrafficReason(store, mode, environmentClusterId(env.config) ?? defaultClusterId);
}

// clusterTrafficReason: the same rule for a cluster an environment may
// not exist on yet (a transfer's target).
export function clusterTrafficReason(store: Store, mode: Mode | undefined, clusterId: string): string | null {
  if (!clusterEdgeActive(store, mode) || clusterId === store.getServerSettings().edgeClusterId) return null;
  const relay = store.getRelay(clusterId);
  return relay && relay.address !== "" ? null : noPublicEntry;
}

// storeKubeconfig: the scoped (nbo-controller) kubeconfig of a connected cluster.
export function storeKubeconfig(store: Store): (clusterId: string) => Promise<string> {
  return async (clusterId) => store.getKubernetesSecrets(clusterId).kubeconfig;
}

const relayUrl = (address: string): string => `https://${address.includes(":") ? `[${address}]` : address}`;

type Target = RouteTable["targets"][string];

// The edge rejects a whole table over one bad entry (and keeps its last
// good one, freezing every project's routing), so each entry is checked
// here with the edge's own rules (packages/edge/src/route-table.ts and
// registry.ts validate); a bad one is dropped and logged once.
const reportedProblems = new Set<string>();
function reportProblem(msg: string): void {
  if (reportedProblems.has(msg)) return;
  if (reportedProblems.size > 1000) reportedProblems.clear();
  reportedProblems.add(msg);
  console.error(`control-plane: edge route table: ${msg}`);
}

// edgeHostKey normalises a host exactly as the edge does.
export function edgeHostKey(host: string): string {
  let h: string;
  try {
    h = new URL("http://" + host).hostname;
  } catch {
    h = host.toLowerCase();
  }
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

function validUrl(raw: string, protocols: string[]): boolean {
  try {
    const u = new URL(raw);
    return protocols.includes(u.protocol) && u.host !== "";
  } catch {
    return false;
  }
}

const sampleRates = new Set([100, 50, 25, 10]);
const challengeToken = /^[A-Za-z0-9_-]{1,128}$/;

// backendProblem: why the edge would reject this backend, or null.
function backendProblem(b: RouteTableBackend, seenIds: Set<string>): string | null {
  if (!Number.isInteger(b.weight) || b.weight < 0) return `weight ${b.weight} is not a non-negative integer`;
  if (!validUrl(b.url, ["http:", "https:"])) return `url ${JSON.stringify(b.url)} is not a valid http(s) url`;
  if (b.id !== undefined && (b.id === "" || seenIds.has(b.id)))
    return `id ${JSON.stringify(b.id)} is empty or repeated`;
  if (b.via && (!validUrl(b.via.url, ["https:"]) || b.via.caPem === "" || b.via.token === ""))
    return `relay ${JSON.stringify(b.via.url)} is not a usable https relay`;
  return null;
}

// renderDesiredTable is the whole route table the edge should have: one
// target per host of every project with a live backend (its edge host plus
// every Production domain row, any status), and the same for each custom
// stage (its host and its own domain rows, routed to its own cloud rows,
// never with Speed Insights). excludeHost drops the project whose edge
// host it is (and that host), or the stage whose host it is, for one being
// deleted. Entries the edge would reject are left out (and logged), so the
// rest still route.
export function renderDesiredTable(
  store: Store,
  opts: { challenges: Record<string, string>; excludeHost?: string; cloudflareRanges?: string[] },
): RouteTable {
  const edgeClusterId = store.getServerSettings().edgeClusterId;
  const exclude = opts.excludeHost ? edgeHostKey(opts.excludeHost) : "";
  const targets: RouteTable["targets"] = {};
  const owner = new Map<string, string>();
  let anyCloudflare = false;
  // site adds the targets of one stage's site: its host and domain rows,
  // routed to envs. label names it in log lines.
  const site = (
    label: string,
    edgeHost: string,
    envs: Environment[],
    domains: Domain[],
    insights: Target["insights"] | undefined,
  ): void => {
    const backends: RouteTableBackend[] = [];
    const seenIds = new Set<string>();
    // unreachable: environments with traffic left out for want of a relay.
    const unreachable: string[] = [];
    for (const env of envs) {
      const url = latestSuccessfulURL(store, env.id);
      if (url === null) continue;
      const backend: RouteTableBackend = { id: env.id, url, weight: env.trafficWeight, insecureSkipVerify: false };
      if (env.target === "kubernetes") {
        const clusterId = environmentClusterId(env.config) ?? defaultClusterId;
        if (clusterId !== edgeClusterId) {
          // Another cluster's apps are ClusterIP only: reachable through its
          // relay, or not at all until the relay has an address.
          const relay = store.getRelay(clusterId);
          if (!relay || relay.address === "") {
            if (env.trafficWeight > 0) unreachable.push(env.name);
            continue;
          }
          backend.via = { url: relayUrl(relay.address), caPem: relay.caPem, token: relay.token };
        }
      }
      const problem = backendProblem(backend, seenIds);
      if (problem) {
        reportProblem(`project ${label}: environment ${env.name} left out: ${problem}`);
        continue;
      }
      seenIds.add(env.id);
      backends.push(backend);
    }
    // Traffic that points only at clouds the edge can't reach would leave
    // the site with no route at all: serve from the reachable ones instead,
    // in equal shares.
    if (unreachable.length > 0 && backends.length > 0 && !backends.some((b) => b.weight > 0)) {
      const share = Math.floor(100 / backends.length);
      backends.forEach((b, i) => (b.weight = share + (i < 100 - share * backends.length ? 1 : 0)));
      reportProblem(
        `project ${label}: traffic points only at clouds the edge can't reach (${unreachable.join(", ")}); serving from ${backends.map((b) => store.getEnvironment(b.id!).name).join(", ")} instead`,
      );
    }
    // Nothing to route yet (the edge needs a positive weight to pick one).
    if (!backends.some((b) => b.weight > 0)) return;
    const base: Target = { backends };
    if (insights) base.insights = insights;
    const hosts = new Map<string, { active: boolean; cloudflare: boolean }>([
      [edgeHostKey(edgeHost), { active: false, cloudflare: false }],
    ]);
    for (const d of domains) {
      // Google serves these hosts; the edge never sees them.
      if (d.serving === "cloudrun") continue;
      const h = edgeHostKey(d.host);
      const prev = hosts.get(h);
      hosts.set(h, {
        active: (prev?.active ?? false) || d.status === "active",
        cloudflare: (prev?.cloudflare ?? false) || d.behindCloudflare,
      });
    }
    for (const [host, { active, cloudflare }] of hosts) {
      if (host === "" || host === exclude) continue;
      const taken = owner.get(host);
      if (taken !== undefined) {
        reportProblem(`host ${host} of project ${label} left out: project ${taken} already uses it`);
        continue;
      }
      owner.set(host, label);
      const copy = backends.map((b) => ({ ...b }));
      const target: Target = active
        ? { ...base, backends: copy, tls: certSecretName(host), redirectHttps: true }
        : { ...base, backends: copy };
      if (cloudflare) {
        target.cloudflare = true;
        anyCloudflare = true;
      }
      targets[host] = target;
    }
  };
  for (const project of store.listProjects()) {
    if (!project.edgeHost) continue;
    if (exclude !== "" && edgeHostKey(project.edgeHost) === exclude) continue;
    const stages = store.listStages(project.id, { includeEphemeral: true });
    const productionId = stages.find((s) => s.kind === "production")?.id ?? "";
    const domains = store.listDomains(project.id);
    let insights: Target["insights"] | undefined;
    if (project.speedInsights) {
      if (sampleRates.has(project.speedInsightsSampleRate)) {
        insights = {
          enabled: true,
          inject: project.speedInsightsInject,
          sampleRate: project.speedInsightsSampleRate as 100 | 50 | 25 | 10,
        };
      } else {
        reportProblem(
          `project ${project.name}: Speed Insights left off: sample rate ${project.speedInsightsSampleRate} is not 100, 50, 25 or 10`,
        );
      }
    }
    site(
      project.name,
      project.edgeHost,
      store.listEnvironments(project.id),
      domains.filter((d) => d.stageId === productionId),
      insights,
    );
    for (const stage of stages) {
      if (!hasOwnHost(stage)) continue;
      if (exclude !== "" && edgeHostKey(stage.host) === exclude) continue;
      site(
        `${project.name} (${stage.name})`,
        stage.host,
        store.listEnvironments(project.id, { stageId: stage.id }),
        domains.filter((d) => d.stageId === stage.id),
        undefined,
      );
    }
  }
  const challenges: Record<string, string> = {};
  for (const [token, value] of Object.entries(opts.challenges)) {
    if (!challengeToken.test(token) || typeof value !== "string") {
      reportProblem(`ACME challenge token ${JSON.stringify(token)} left out: it must be 1-128 letters, digits, _ or -`);
      continue;
    }
    challenges[token] = value;
  }
  const table: RouteTable = { version: 1, targets, challenges };
  if (anyCloudflare && opts.cloudflareRanges) table.cloudflareRanges = [...opts.cloudflareRanges];
  return table;
}

export interface ClusterEdgeDeps {
  store: Store;
  run: CommandRunner;
  kubeconfigFor: (clusterId: string) => Promise<string>;
}

export interface ClusterEdgeWriter {
  // write renders the table afresh on every attempt (a retry after a
  // conflict carries the newest state, never a stale body).
  write(render: () => RouteTable): Promise<void>;
  read(): Promise<RouteTable | null>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isNotFound = (err: unknown): boolean => /NotFound|not found/.test(errText(err));
const isConflict = (err: unknown): boolean =>
  /the object has been modified|Conflict|AlreadyExists|already exists/.test(errText(err));

export const MAX_WRITE_ATTEMPTS = 5;

// withEdgeCluster runs fn with the edge cluster's kubeconfig in nbo-edge,
// redacting the kubeconfig (and its token) from anything thrown.
export async function withEdgeCluster<T>(
  deps: ClusterEdgeDeps,
  fn: (kubectl: (args: string[], input?: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const clusterId = deps.store.getServerSettings().edgeClusterId;
  if (!clusterId) throw new Error("no edge cluster is set");
  const kubeconfig = await deps.kubeconfigFor(clusterId);
  const secrets = kubeconfigSecrets(kubeconfig);
  try {
    return await withKubeconfig(kubeconfig, edgeNamespace, (ctx) =>
      fn((args, input) => deps.run("kubectl", kubectlArgs(ctx, args), input === undefined ? undefined : { input })),
    );
  } catch (err) {
    throw new Error(redact(errText(err), secrets), { cause: err });
  }
}

// kubectl output can carry warnings on stderr lines before the JSON.
function parseJson(out: string): unknown {
  const i = out.indexOf("{");
  return JSON.parse(i > 0 ? out.slice(i) : out);
}

// createClusterEdgeWriter reads and writes the route table ConfigMap.
// write replaces it at the resourceVersion it just read (creating it when
// absent) and retries a conflicting write with a fresh read, so a
// concurrent writer never has its table silently overwritten by a stale one.
export function createClusterEdgeWriter(deps: ClusterEdgeDeps): ClusterEdgeWriter {
  return {
    async write(render) {
      await withEdgeCluster(deps, async (kubectl) => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
          let current: { metadata?: { resourceVersion?: string } } | null;
          try {
            current = parseJson(await kubectl(["get", "configmap", routesConfigMap, "-o", "json"])) as {
              metadata?: { resourceVersion?: string };
            };
          } catch (err) {
            if (!isNotFound(err)) throw err;
            current = null;
          }
          const table = render();
          try {
            if (current === null) {
              await kubectl(["create", "-f", "-"], renderRouteTableConfigMap(table));
            } else {
              const body = {
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata: {
                  name: routesConfigMap,
                  namespace: edgeNamespace,
                  labels: { ...managedByLabels },
                  resourceVersion: current.metadata?.resourceVersion ?? "",
                },
                data: { [routesKey]: JSON.stringify(table) },
              };
              await kubectl(["replace", "-f", "-"], JSON.stringify(body));
            }
            return;
          } catch (err) {
            if (!isConflict(err)) throw err;
            lastErr = err;
          }
        }
        throw new Error(
          `the edge route table kept changing while NBO wrote it (conflict ${MAX_WRITE_ATTEMPTS} times): ${errText(lastErr)}`,
        );
      });
    },

    async read() {
      return withEdgeCluster(deps, async (kubectl) => {
        let cm: { data?: Record<string, string> };
        try {
          cm = parseJson(await kubectl(["get", "configmap", routesConfigMap, "-o", "json"])) as {
            data?: Record<string, string>;
          };
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
        const raw = cm.data?.[routesKey];
        return raw === undefined ? null : (JSON.parse(raw) as RouteTable);
      });
    },
  };
}

// createClusterDrainSource fetches the Speed Insights batches of every edge
// pod through the API server's pod proxy (the admin port is not exposed),
// concatenating them. A failing pod is logged once (until it recovers) and
// skipped; the drain token never reaches a log line.
export function createClusterDrainSource(deps: ClusterEdgeDeps): () => Promise<unknown[] | null> {
  const failing = new Set<string>();
  let warned = false;
  const warnOnce = (msg: string) => {
    if (warned) return;
    warned = true;
    console.error(`control-plane: Speed Insights drain: ${msg}`);
  };
  return async () => {
    if (deps.store.getServerSettings().edgeClusterId === "") return null;
    const token = deps.store.getServerSecret("edge_drain_token");
    if (!token) {
      warnOnce("no drain token is stored for the edge — reinstall the edge");
      return null;
    }
    const hide = (s: string): string => redact(s, [token, encodeURIComponent(token)]);
    try {
      const out = await withEdgeCluster(deps, async (kubectl) => {
        const list = parseJson(await kubectl(["get", "pods", "-l", `app=${edgeName}`, "-o", "json"])) as {
          items?: { metadata?: { name?: string }; status?: { phase?: string } }[];
        };
        const names = (list.items ?? [])
          .filter((p) => p.status?.phase === undefined || p.status.phase === "Running")
          .map((p) => p.metadata?.name ?? "")
          .filter((n) => n !== "");
        const batches: unknown[] = [];
        for (const pod of names) {
          const path = `/api/v1/namespaces/${edgeNamespace}/pods/${pod}:9444/proxy/insights/drain?token=${encodeURIComponent(token)}`;
          try {
            const body = parseJson(await kubectl(["get", "--raw", path])) as { batches?: unknown };
            if (!Array.isArray(body.batches)) throw new Error("the response has no batches array");
            batches.push(...body.batches);
            failing.delete(pod);
          } catch (err) {
            if (!failing.has(pod)) {
              failing.add(pod);
              console.error(
                `control-plane: Speed Insights drain: edge pod ${pod} failed, skipped: ${hide(errText(err))}`,
              );
            }
          }
        }
        return batches;
      });
      warned = false;
      return out;
    } catch (err) {
      warnOnce(`listing the edge pods failed (${hide(errText(err))})`);
      return null;
    }
  };
}
