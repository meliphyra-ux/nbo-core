// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Environment, Store } from "../store/store.js";
import type { Build } from "../git/git.js";
import type { Histogram } from "./histogram.js";
import { liveBuild } from "../builds/artifacts.js";

// The metrics the edge reports.
export const METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;

// VitalsRow is one hour of one metric's samples for one (environment,
// build, route, device) of a project. hour is an ISO timestamp floored to
// the hour.
export interface VitalsRow {
  projectId: string;
  environmentId: string;
  buildId: string;
  route: string;
  metric: string;
  device: string;
  hour: string;
  histogram: Histogram;
  count: number;
}

// InsightsSink is where the drain hands its hourly rows. Core keeps no
// Speed Insights storage: whoever runs NBO supplies a sink (rows from one
// write are already merged by key; a sink adds them to what it holds). A
// sink that throws loses that batch.
export interface InsightsSink {
  write(rows: VitalsRow[]): Promise<void>;
}

// DrainBatch is one entry of the edge's GET /insights/drain response
// (the edge ↔ control-plane contract).
export interface DrainBatch {
  host: string;
  environmentId: string;
  contentId: string;
  route: string;
  metric: "LCP" | "INP" | "CLS" | "FCP" | "TTFB";
  device: "mobile" | "desktop";
  minute: string;
  buckets: Histogram;
  count: number;
}

export interface InsightsDrainOptions {
  sink: InsightsSink;
  // adminUrl: the dev edge's admin API (GET /insights/drain), used when no
  // source is given.
  adminUrl?: string;
  fetch?: typeof fetch;
  // source fetches the edge's batches (null: nothing this time, already
  // logged); e.g. the cluster edge's pods through the API server proxy.
  source?: () => Promise<unknown[] | null>;
  intervalMs?: number;
}

export interface InsightsDrain {
  // once drains the edge a single time and hands the rows to the sink.
  once(): Promise<void>;
  // run drains every intervalMs (default 60 s) until signal aborts.
  run(signal: AbortSignal): Promise<void>;
}

const metricSet = new Set<string>(METRICS);

function validBatch(b: unknown): b is DrainBatch {
  if (typeof b !== "object" || b === null) return false;
  const r = b as Record<string, unknown>;
  if (
    typeof r.host !== "string" ||
    typeof r.environmentId !== "string" ||
    typeof r.contentId !== "string" ||
    typeof r.route !== "string"
  )
    return false;
  if (typeof r.metric !== "string" || !metricSet.has(r.metric)) return false;
  if (r.device !== "mobile" && r.device !== "desktop") return false;
  if (typeof r.minute !== "string" || Number.isNaN(Date.parse(r.minute))) return false;
  if (typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 0) return false;
  if (typeof r.buckets !== "object" || r.buckets === null || Array.isArray(r.buckets)) return false;
  for (const [k, n] of Object.entries(r.buckets as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || typeof n !== "number" || !Number.isInteger(n) || n < 0) return false;
  }
  return true;
}

function floorHour(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// httpDrainSource drains the dev edge's admin API. An edge without the
// route (404) or one that can't be reached is a quiet no-op, logged once
// until it recovers.
export function httpDrainSource(adminUrl: string, fetchImpl?: typeof fetch): () => Promise<unknown[] | null> {
  const doFetch = fetchImpl ?? fetch;
  const drainUrl = `${adminUrl.replace(/\/+$/, "")}/insights/drain`;
  let warned = false;
  const warnOnce = (msg: string) => {
    if (warned) return;
    warned = true;
    console.error(`control-plane: Speed Insights drain: ${msg}`);
  };

  return async function fetchBatches(): Promise<unknown[] | null> {
    let res: Response;
    try {
      res = await doFetch(drainUrl);
    } catch (err) {
      warnOnce(`edge unreachable (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      warnOnce(res.status === 404 ? "the edge has no /insights/drain route yet" : `edge answered ${res.status}`);
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      warnOnce("edge sent a body that is not JSON");
      return null;
    }
    const batches = (body as { batches?: unknown } | null)?.batches;
    if (!Array.isArray(batches)) {
      warnOnce("edge response has no batches array");
      return null;
    }
    warned = false;
    return batches;
  };
}

// createInsightsDrain pulls the edge's aggregated Web Vitals (from
// options.source, or the dev edge's admin URL), merges them into hourly rows
// and writes those to options.sink.
export function createInsightsDrain(store: Store, options: InsightsDrainOptions): InsightsDrain {
  let source = options.source;
  if (!source) {
    if (options.adminUrl === undefined) throw new Error("createInsightsDrain needs an adminUrl or a source");
    source = httpDrainSource(options.adminUrl, options.fetch);
  }
  const fetchBatches = source;

  // ProjectContext is what one drain needs per project, loaded once:
  // its environments, its builds by content id, and each environment's
  // live build (preferred when its content id matches the beacon's, and the
  // fallback when the beacon carries no known content id).
  interface ProjectContext {
    envs: Map<string, Environment>;
    byContentId: Map<string, string>;
    builds: Build[];
    live: Map<string, string>;
  }

  function loadContext(projectId: string): ProjectContext {
    const builds = store.listBuilds(projectId);
    const byContentId = new Map<string, string>();
    // Commit builds win over promote jobs (which carry their source's content id).
    for (const build of builds) {
      if (!build.contentId) continue;
      if (!byContentId.has(build.contentId) || build.kind === "build") byContentId.set(build.contentId, build.id);
    }
    const envs = new Map(store.listEnvironments(projectId, { includeArchived: true }).map((e) => [e.id, e]));
    return { envs, byContentId, builds, live: new Map() };
  }

  function liveBuildId(ctx: ProjectContext, env: Environment): string {
    let id = ctx.live.get(env.id);
    if (id === undefined) {
      id = liveBuild(store, env, ctx.builds)?.id ?? "";
      ctx.live.set(env.id, id);
    }
    return id;
  }

  // The live build wins when its content id is the beacon's (several
  // builds can share one); otherwise the build with that id; otherwise the
  // live build.
  function buildIdFor(ctx: ProjectContext, env: Environment, contentId: string): string {
    const live = liveBuildId(ctx, env);
    if (contentId && live && ctx.builds.find((x) => x.id === live)?.contentId === contentId) return live;
    return (contentId && ctx.byContentId.get(contentId)) || live;
  }

  function toRows(batches: unknown[]): VitalsRow[] {
    // Hosts compare case-insensitively (DNS names).
    const projects = new Map(
      store
        .listProjects()
        .filter((p) => p.edgeHost !== "")
        .map((p) => [p.edgeHost.toLowerCase(), p.id]),
    );
    // A project's own domains (public edge) report under their host too.
    for (const d of store.listDomains())
      if (!projects.has(d.host.toLowerCase())) projects.set(d.host.toLowerCase(), d.projectId);
    const contexts = new Map<string, ProjectContext>();
    const merged = new Map<string, VitalsRow>();
    for (const b of batches) {
      if (!validBatch(b)) continue;
      const projectId = projects.get(b.host.toLowerCase());
      if (!projectId) continue;
      let ctx = contexts.get(projectId);
      if (!ctx) {
        ctx = loadContext(projectId);
        contexts.set(projectId, ctx);
      }
      const env = ctx.envs.get(b.environmentId);
      if (!env) continue;
      const row: VitalsRow = {
        projectId,
        environmentId: b.environmentId,
        buildId: buildIdFor(ctx, env, b.contentId),
        route: b.route,
        metric: b.metric,
        device: b.device,
        hour: floorHour(b.minute),
        histogram: b.buckets,
        count: b.count,
      };
      const key = JSON.stringify([
        row.projectId,
        row.environmentId,
        row.buildId,
        row.route,
        row.metric,
        row.device,
        row.hour,
      ]);
      const prev = merged.get(key);
      if (prev) {
        for (const [k, n] of Object.entries(row.histogram)) prev.histogram[k] = (prev.histogram[k] ?? 0) + n;
        prev.count += row.count;
      } else {
        merged.set(key, { ...row, histogram: { ...row.histogram } });
      }
    }
    return [...merged.values()];
  }

  const drain: InsightsDrain = {
    async once() {
      const batches = await fetchBatches();
      if (!batches) return;
      try {
        const rows = toRows(batches);
        if (rows.length > 0) await options.sink.write(rows);
      } catch (err) {
        console.error(
          `control-plane: Speed Insights drain: the sink failed, this batch is lost: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async run(signal) {
      const interval = options.intervalMs ?? 60_000;
      while (!signal.aborted) {
        try {
          await drain.once();
        } catch (err) {
          console.error(
            `control-plane: Speed Insights drain tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await new Promise<void>((resolve) => {
          // Aborted during the tick: no wait, the loop ends.
          if (signal.aborted) return resolve();
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, interval);
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
  };
  return drain;
}

// startInsightsDrain runs the drain until signal aborts, but only when there
// is a sink: nothing else is allowed to call the edge's GET /insights/drain
// (it empties what it returns). Without a sink the edge's own bound on what
// it holds keeps its memory in check. Returns the running loop (it settles
// once signal aborts and a running tick ends), or undefined with no sink.
export function startInsightsDrain(
  store: Store,
  sink: InsightsSink | undefined,
  options: Omit<InsightsDrainOptions, "sink">,
  signal: AbortSignal,
): Promise<void> | undefined {
  if (!sink) return undefined;
  return createInsightsDrain(store, { ...options, sink }).run(signal);
}
