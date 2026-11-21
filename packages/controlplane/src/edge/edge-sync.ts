// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Store } from "../store/store.js";
import { hasOwnHost, type Stage } from "../stages/stages.js";
import type { RouteTable } from "./edge-manifests.js";
import { latestSuccessfulURL, renderDesiredTable, type ClusterEdgeWriter } from "./edge-table.js";

export interface DesiredBackend {
  environmentId: string;
  target: string;
  url: string;
  weight: number;
  insecureSkipVerify: boolean;
}

// Speed Insights settings the edge applies to a host. Sent only when
// enabled: an absent field means disabled (and an edge without Speed
// Insights support rejects unknown fields).
export interface DesiredInsights {
  enabled: true;
  inject: boolean;
  sampleRate: number;
}

export interface DesiredTarget {
  host: string;
  backends: DesiredBackend[];
  insights?: DesiredInsights;
}

export interface EdgeSync {
  // desiredTarget: Production's host and split (what the Traffic tab shows).
  desiredTarget(projectId: string): DesiredTarget | null;
  // desiredTargets: Production's, then each custom stage's with a live backend.
  desiredTargets(projectId: string): DesiredTarget[];
  // push sends the project's routes. A custom stage's failure is only
  // logged, unless opts.stageHost names that stage's host.
  push(projectId: string, opts?: { stageHost?: string }): Promise<void>;
  onDeployed(projectId: string, environmentId: string): Promise<void>;
  // host: check only that host's route (one environment); without it, every environment's.
  // The cluster edge writes one route table, so it always compares the whole table.
  inSync(projectId: string, host?: string): Promise<boolean>;
  reconcile(): Promise<void>;
  // remove drops a host's route from the edge (project or stage deleted).
  remove(host: string): Promise<void>;
}

// The local kind cluster serves *.sslip.io with a cert-manager
// self-signed cert; every other backend (Cloud Run's *.run.app) keeps
// normal TLS verification.
function needsInsecure(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".sslip.io");
  } catch {
    return false;
  }
}

// insightsMatch: a disabled project matches an edge with no insights (or
// disabled ones); an enabled one needs the same three settings.
function insightsMatch(
  want: DesiredInsights | undefined,
  live: { enabled?: boolean; inject?: boolean; sampleRate?: number } | undefined,
): boolean {
  if (!want) return !live || live.enabled !== true;
  return live?.enabled === true && live.inject === want.inject && live.sampleRate === want.sampleRate;
}

// desiredTargetFor is the control-plane's view of a project's split: its
// edge host and every environment with a live deployment (what the
// Traffic tab shows), whichever edge carries it.
export function desiredTargetFor(store: Store, projectId: string): DesiredTarget | null {
  const project = store.getProject(projectId);
  if (!project.edgeHost) return null;
  const backends: DesiredBackend[] = [];
  for (const env of store.listEnvironments(projectId)) {
    const url = latestSuccessfulURL(store, env.id);
    if (url === null) continue;
    backends.push({
      environmentId: env.id,
      target: env.target,
      url,
      weight: env.trafficWeight,
      insecureSkipVerify: needsInsecure(url),
    });
  }
  if (backends.length === 0) return null;
  const target: DesiredTarget = { host: project.edgeHost, backends };
  if (project.speedInsights)
    target.insights = {
      enabled: true,
      inject: project.speedInsightsInject,
      sampleRate: project.speedInsightsSampleRate,
    };
  return target;
}

// desiredTargetForStage is one stage's host and split: Production's is
// desiredTargetFor; a custom stage's has its own host and cloud rows, and
// never Speed Insights (Production only).
export function desiredTargetForStage(store: Store, stage: Stage): DesiredTarget | null {
  if (stage.kind === "production") return desiredTargetFor(store, stage.projectId);
  if (!hasOwnHost(stage)) return null;
  const backends: DesiredBackend[] = [];
  for (const env of store.listEnvironments(stage.projectId, { stageId: stage.id })) {
    const url = latestSuccessfulURL(store, env.id);
    if (url === null) continue;
    backends.push({
      environmentId: env.id,
      target: env.target,
      url,
      weight: env.trafficWeight,
      insecureSkipVerify: needsInsecure(url),
    });
  }
  return backends.length === 0 ? null : { host: stage.host, backends };
}

// desiredTargetsFor: every stage's target that has a live backend,
// Production's first.
export function desiredTargetsFor(store: Store, projectId: string): DesiredTarget[] {
  const out: DesiredTarget[] = [];
  const production = desiredTargetFor(store, projectId);
  if (production) out.push(production);
  for (const stage of store.listStages(projectId, { includeEphemeral: true })) {
    if (!hasOwnHost(stage)) continue;
    const t = desiredTargetForStage(store, stage);
    if (t) out.push(t);
  }
  return out;
}

// firstDeployWeights: the first successful deploy of a stage (none of its
// clouds has traffic yet) routes 100% of that stage's host to it. Other
// stages' splits are untouched.
function firstDeployWeights(store: Store, projectId: string, environmentId: string): void {
  const stageId = store.getEnvironment(environmentId).stageId;
  if (store.listEnvironments(projectId, { stageId }).every((e) => e.trafficWeight === 0)) {
    store.setTrafficWeights(projectId, { [environmentId]: 100 }, stageId);
  }
}

// createEdgeSync makes the control-plane the source of truth for each
// project's edge host and traffic split. The edge registry is
// in-memory and empties on restart; reconcile re-pushes what it lost.
export function createEdgeSync(store: Store, options: { adminUrl: string; fetch?: typeof fetch }): EdgeSync {
  const doFetch = options.fetch ?? fetch;
  const adminUrl = options.adminUrl.replace(/\/+$/, "");
  const targetUrl = (host: string) => `${adminUrl}/targets/${encodeURIComponent(host)}`;

  const pushTarget = async (desired: DesiredTarget): Promise<void> => {
    // The edge rejects a split with no positive weight; there is
    // nothing to route yet, so don't send one.
    if (desired.backends.every((b) => b.weight === 0)) return;
    const res = await doFetch(targetUrl(desired.host), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // id: the environment id, the edge's stable key for keeping each
      // visitor on one cloud (a backend URL can change; its environment can't).
      body: JSON.stringify({
        backends: desired.backends.map(({ environmentId, url, weight, insecureSkipVerify }) => ({
          id: environmentId,
          url,
          weight,
          insecureSkipVerify,
        })),
        ...(desired.insights ? { insights: desired.insights } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`edge rejected the split for ${desired.host} (${res.status}): ${(await res.text()).trim()}`);
    }
  };

  const targetInSync = async (desired: DesiredTarget): Promise<boolean> => {
    let res: Response;
    try {
      res = await doFetch(targetUrl(desired.host));
    } catch {
      return false;
    }
    if (!res.ok) return false;
    const live = (await res.json()) as {
      backends?: { id?: string; url: string; weight: number }[];
      insights?: { enabled?: boolean; inject?: boolean; sampleRate?: number };
    };
    if (!insightsMatch(desired.insights, live.insights)) return false;
    const want = desired.backends;
    if (!live.backends || live.backends.length !== want.length) return false;
    return want.every(
      (b, i) =>
        live.backends![i]!.id === b.environmentId &&
        live.backends![i]!.url === b.url &&
        live.backends![i]!.weight === b.weight,
    );
  };

  const pushNow = async (projectId: string, opts?: { stageHost?: string }): Promise<void> => {
    const productionHost = store.getProject(projectId).edgeHost;
    let failure: unknown = null;
    for (const desired of desiredTargetsFor(store, projectId)) {
      try {
        await pushTarget(desired);
      } catch (err) {
        if (desired.host === productionHost || desired.host === opts?.stageHost) failure ??= err;
        else
          console.error(
            `control-plane: pushing ${desired.host} to the edge failed: ${err instanceof Error ? err.message : String(err)}`,
          );
      }
    }
    if (failure !== null) throw failure;
  };
  let pushTail: Promise<unknown> = Promise.resolve();

  const sync: EdgeSync = {
    desiredTarget(projectId) {
      return desiredTargetFor(store, projectId);
    },

    desiredTargets(projectId) {
      return desiredTargetsFor(store, projectId);
    },

    // push sends every stage's target; one failing host doesn't stop the
    // others. Only Production's failure is thrown (callers such as a
    // transfer step act on it); a custom stage's is logged, and the poll
    // loop's reconcile pushes it again.
    async push(projectId, opts) {
      // One push at a time: a later push renders only after earlier ones
      // finished, so a slow push never lands an older split over a newer
      // one (two stages of a project deploy at once).
      // shortcut: in-process lock, so one NBO process per edge.
      const next = pushTail.then(() => pushNow(projectId, opts));
      pushTail = next.catch(() => undefined);
      return next;
    },

    async onDeployed(projectId, environmentId) {
      firstDeployWeights(store, projectId, environmentId);
      await sync.push(projectId);
    },

    async inSync(projectId, host) {
      const targets = sync.desiredTargets(projectId).filter((t) => host === undefined || t.host === host);
      if (targets.length === 0) return false;
      for (const t of targets) if (!(await targetInSync(t))) return false;
      return true;
    },

    // remove waits behind running pushes too: one that already read a deleted stage's host would put it back.
    async remove(host) {
      if (!host) return;
      const next = pushTail.then(async () => {
        const res = await doFetch(targetUrl(host), { method: "DELETE" });
        if (!res.ok && res.status !== 404) throw new Error(`edge refused to remove ${host} (${res.status})`);
      });
      pushTail = next.catch(() => undefined);
      return next;
    },

    async reconcile() {
      for (const project of store.listProjects()) {
        try {
          if (sync.desiredTargets(project.id).length === 0) continue;
          if (!(await sync.inSync(project.id))) await sync.push(project.id);
        } catch (err) {
          console.error(
            `control-plane: edge reconcile for project ${project.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
  return sync;
}

// canonical: JSON with object keys sorted, so two tables compare by content.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

// createClusterEdgeSync drives the public edge in the edge cluster: every
// change renders the whole route table from the database and writes it, so
// a lost write heals on the next reconcile.
export function createClusterEdgeSync(
  store: Store,
  writer: ClusterEdgeWriter,
  options: { challenges: () => Record<string, string>; cloudflareRanges?: () => string[] },
): EdgeSync {
  const render = (excludeHost?: string): RouteTable =>
    renderDesiredTable(store, {
      challenges: options.challenges(),
      excludeHost,
      cloudflareRanges: options.cloudflareRanges?.(),
    });
  // One write at a time: a later caller renders only after earlier writes
  // finished, so a slow write can never land a staler table over a newer one.
  let tail: Promise<unknown> = Promise.resolve();
  const write = (excludeHost?: string): Promise<void> => {
    const next = tail.then(() => writer.write(() => render(excludeHost)));
    tail = next.catch(() => undefined);
    return next;
  };
  const inSyncTable = async (): Promise<boolean> => {
    let live: RouteTable | null;
    try {
      live = await writer.read();
    } catch {
      return false;
    }
    return live !== null && canonical(live) === canonical(render());
  };
  const sync: EdgeSync = {
    desiredTarget(projectId) {
      return desiredTargetFor(store, projectId);
    },
    desiredTargets(projectId) {
      return desiredTargetsFor(store, projectId);
    },
    async push() {
      await write();
    },
    async onDeployed(projectId, environmentId) {
      firstDeployWeights(store, projectId, environmentId);
      await sync.push(projectId);
    },
    async inSync(projectId) {
      if (desiredTargetsFor(store, projectId).length === 0) return false;
      return inSyncTable();
    },
    async remove(host) {
      if (!host) return;
      await write(host);
    },
    async reconcile() {
      try {
        if (!(await inSyncTable())) await write();
      } catch (err) {
        console.error(`control-plane: edge reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
  return sync;
}
