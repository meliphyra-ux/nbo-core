// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Store, Environment } from "./store.js";
import type { Mode } from "./mode.js";
import type { Stage } from "./stages.js";
import { ErrConflict } from "./errors.js";
import { cannotTakeTrafficReason, clusterEdgeActive, latestSuccessfulURL } from "./edge-table.js";
import { stageUrlFor, type DomainUrlContext } from "./v2.js";
import { environmentView } from "./v2-routes.js";

// Revalidating a stage's (environment's) ISR pages from NBO: the control-
// plane calls the site's own POST /_nbo/revalidate with the stage's secret
// (revalidate-tokens.ts). Through the edge when there is one (it fans the
// call out to every cloud, edge proxy.ts), else each Cloud Run URL directly.
// The manual's Page cache chapter (docs/manual/cache.md) describes it. The
// secret never leaves in an answer or an
// error: only statuses and short texts do.

export interface RevalidateBody {
  tags?: string[];
  paths?: string[];
}

export interface RevalidateResult {
  ok: boolean;
  results: { environmentId: string; cloud: string; status: number; error?: string }[];
}

export interface RevalidateDeps {
  store: Store;
  mode: Mode;
  urlContext: DomainUrlContext;
  fetch?: typeof fetch;
}

const MAX_ENTRIES = 256;
const MAX_TAG = 256;
// The edge gives each backend 10 s; this leaves it room to answer.
const EDGE_TIMEOUT_MS = 15_000;
const DIRECT_TIMEOUT_MS = 10_000;

function stringList(raw: unknown, field: string): string[] | string {
  if (!Array.isArray(raw)) return `${field} must be a list of strings`;
  if (raw.length > MAX_ENTRIES) return `${field} may have at most ${MAX_ENTRIES} entries`;
  if (!raw.every((v) => typeof v === "string")) return `${field} must be a list of strings`;
  return raw as string[];
}

// parseRevalidateBody: the body, or why it is refused. At least one of
// tags and paths non-empty, at most 256 entries each, tags 1 to 256
// characters, paths starting with "/", no other field. Empty lists are
// dropped.
export function parseRevalidateBody(raw: unknown): RevalidateBody | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "the request body must be a JSON object";
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((k) => k !== "tags" && k !== "paths")) return "the body may contain only tags, paths";
  const out: RevalidateBody = {};
  if (body.tags !== undefined) {
    const tags = stringList(body.tags, "tags");
    if (typeof tags === "string") return tags;
    if (tags.some((t) => t.length < 1 || t.length > MAX_TAG)) return `each tag must be 1 to ${MAX_TAG} characters`;
    if (tags.length > 0) out.tags = tags;
  }
  if (body.paths !== undefined) {
    const paths = stringList(body.paths, "paths");
    if (typeof paths === "string") return paths;
    if (paths.some((p) => !p.startsWith("/"))) return 'each path must start with "/"';
    if (paths.length > 0) out.paths = paths;
  }
  if (!out.tags && !out.paths) return "give at least one tag or path";
  return out;
}

const redact = (text: string, token: string): string => (token ? text.split(token).join("[redacted]") : text);

function fetchError(err: unknown, token: string): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timed out";
  const message = err instanceof Error ? err.message : String(err);
  return redact(`unreachable: ${message}`, token).slice(0, 300);
}

const answered = (status: number): string | undefined => (status >= 200 && status < 300 ? undefined : `answered ${status}`);

function result(environmentId: string, cloud: string, status: number, error?: string): RevalidateResult["results"][number] {
  return error === undefined ? { environmentId, cloud, status } : { environmentId, cloud, status, error };
}

// edgeAddress: the stage's address through the edge (stageUrlFor), never a
// domain a Cloud Run mapping serves (that bypasses the edge and would reach
// one cloud): then the stage's default host, https once its domain row is
// active.
function edgeAddress(store: Store, stage: Stage, ctx: DomainUrlContext): string {
  const url = stageUrlFor(stage, ctx);
  if (!url) return "";
  const domains = store.listDomains(stage.projectId);
  const host = new URL(url).hostname;
  if (!domains.some((d) => d.host === host && d.serving === "cloudrun")) return url;
  const own = stage.kind === "production" ? store.getProject(stage.projectId).edgeHost : stage.host;
  if (!own) return "";
  const row = domains.find((d) => d.host === own);
  return `${row?.status === "active" ? "https" : "http"}://${own}`;
}

// revalidateStage posts body to the stage's sites with its secret. Throws
// ErrConflict when the stage has no secret yet or nothing to call.
export async function revalidateStage(deps: RevalidateDeps, stage: Stage, body: RevalidateBody): Promise<RevalidateResult> {
  const { store, mode } = deps;
  const doFetch = deps.fetch ?? fetch;
  const secret = store.getRevalidateToken(stage.id);
  if (!secret) throw new ErrConflict("Nothing in this environment uses ISR yet");
  const token = secret.token;
  const envs = store.listEnvironments(stage.projectId, stage.kind === "production" ? undefined : { stageId: stage.id });
  const live = envs.map((e) => ({ env: e, url: latestSuccessfulURL(store, e.id) })).filter((x): x is { env: Environment; url: string } => x.url !== null);
  const cloud = (e: Environment): string => environmentView(store, mode, e).displayName;
  const init = (timeoutMs: number): RequestInit => ({
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    // A redirect is reported, never followed with the secret.
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const results: RevalidateResult["results"] = [];

  if (mode === "dev" || clusterEdgeActive(store, mode)) {
    const address = edgeAddress(store, stage, deps.urlContext);
    if (!address) throw new ErrConflict(`the ${stage.name} environment has no address yet`);
    // Through the public edge the secret crosses the internet: never in
    // clear text. Dev mode's edge is on loopback, plain http by design.
    if (mode === "production" && !address.startsWith("https://")) {
      throw new ErrConflict(`the ${stage.name} environment's certificate isn't active yet, so NBO won't send the secret over plain http. Try again once its address shows https.`);
    }
    // The clouds the edge's route table holds (edge-table.ts leaves out a
    // cluster with no relay): only those are reached and listed.
    const routed = live.filter(({ env }) => cannotTakeTrafficReason(store, mode, env) === null);
    if (routed.length === 0) throw new ErrConflict(`nothing in the ${stage.name} environment is deployed yet`);
    let res: Response;
    try {
      res = await doFetch(`${address}/_nbo/revalidate`, init(EDGE_TIMEOUT_MS));
    } catch (err) {
      const error = fetchError(err, token);
      for (const { env } of routed) results.push(result(env.id, cloud(env), 0, error));
      return { ok: false, results };
    }
    let backends: { id: string; status: number }[] | null = null;
    if (res.status === 502) {
      try {
        const parsed = JSON.parse(await res.text()) as { backends?: unknown };
        if (Array.isArray(parsed.backends) && parsed.backends.every((b) => b && typeof b.id === "string" && Number.isInteger(b.status))) {
          backends = parsed.backends as { id: string; status: number }[];
        }
      } catch {
        // not the edge's fan-out answer
      }
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    if (backends) {
      for (const b of backends) {
        const env = envs.find((e) => e.id === b.id);
        results.push(result(b.id, env ? cloud(env) : b.id, b.status, b.status === 0 ? "unreachable or timed out" : answered(b.status)));
      }
    } else {
      const error = res.status === 502 ? "the edge answered 502" : answered(res.status);
      for (const { env } of routed) results.push(result(env.id, cloud(env), res.status, error));
    }
  } else {
    // No edge: an address has one cloud; each Cloud Run service is called
    // on its own public URL. A cluster's app has no public address without
    // the edge, so it isn't called.
    const direct = live.filter(({ env, url }) => env.target === "cloudrun" && url.startsWith("https://"));
    if (direct.length === 0) throw new ErrConflict(`the ${stage.name} environment has no address: no cloud has a public URL yet`);
    const answers = await Promise.all(
      direct.map(async ({ env, url }) => {
        try {
          const res = await doFetch(`${url.replace(/\/+$/, "")}/_nbo/revalidate`, init(DIRECT_TIMEOUT_MS));
          await res.body?.cancel().catch(() => undefined);
          return result(env.id, cloud(env), res.status, answered(res.status));
        } catch (err) {
          return result(env.id, cloud(env), 0, fetchError(err, token));
        }
      }),
    );
    results.push(...answers);
  }
  return { ok: results.length > 0 && results.every((r) => r.status >= 200 && r.status < 300), results };
}
