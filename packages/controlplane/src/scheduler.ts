// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Agent } from "undici";
import { signCron, nextRun, type CronRow } from "./cron.js";
import type { Store, Environment } from "./store.js";

// cronInsecureDispatcher: real bug found running Slice 4's crons
// verify script against the local kind cluster — every real deploy
// there is served over HTTPS with cert-manager's own selfsigned
// issuer (*.127.0.0.1.sslip.io, the local-dev convention this whole
// repo already uses — DNS/external-dns, and so real certs, are
// deferred per CLAUDE.md), and a plain fetch() rejects a self-signed
// cert outright — confirmed directly. That rejection was silently
// swallowed by invoke()'s own catch (at-least-once delivery, no
// retry), so a cron never fired against any real cluster deploy at
// all. Scoped to *.sslip.io hostnames specifically, mirroring every
// other place in this repo that already makes this exact call (the
// verify scripts' own `curl -k` gated on the same suffix, @nbo/edge's
// own per-backend insecureSkipVerify) — a real production domain
// (once DNS/external-dns lands) keeps strict verification.
const cronInsecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });

async function defaultCronFetch(url: string, init?: RequestInit): Promise<Response> {
  const { hostname } = new URL(url);
  if (hostname.endsWith(".sslip.io")) {
    return fetch(url, { ...init, dispatcher: cronInsecureDispatcher } as RequestInit);
  }
  return fetch(url, init);
}

// schedulerConfig.cronTickIntervalMs is a mutable settings value, not
// a plain constant — matching @nbo/funcproxy's own cloudRunConfig
// pattern for a Go `var` a test needs to shrink instead of waiting
// out the real interval.
export const schedulerConfig = { cronTickIntervalMs: 30_000 };

// Scheduler fires signed requests for every due cron across every
// registered environment. One process, one in-memory "running" claim
// per cron (store.claimCron) — correct for one real control-plane
// instance; a distributed lock for multiple instances is out of
// scope — port of Scheduler (scheduler.go lines 23-26).
export interface Scheduler {
  store: Store;
  httpClient?: typeof fetch;
}

interface CronTarget {
  function: string;
  path: string;
  method: string;
}

interface CronConfigShape {
  id: string;
  target: CronTarget;
  overlap: string;
  timeoutSec: number;
}

// cronsEnabled reports whether env should run crons at all — "crons
// run in production only unless the environment opts in"
// (docs/nbo-spec.md). Production is name === "production"; any other
// environment opts in via {"cronsEnabled": true} in its own config —
// port of cronsEnabled (scheduler.go lines 45-54).
function cronsEnabled(env: Environment): boolean {
  if (env.name === "production") return true;
  try {
    const cfg = JSON.parse(env.config) as { cronsEnabled?: boolean };
    return cfg.cronsEnabled === true;
  } catch {
    return false;
  }
}

// latestSuccessfulDeploymentURL returns the most recently completed
// deployment's own URL for environmentId — listDeployments orders by
// created_at, so the last succeeded one is the live one. A free
// function taking Store, not a Store method — Go's own version is an
// unexported (package-private) Store method purely for its own
// convenience; it was never part of Store's public API — port of
// latestSuccessfulDeploymentURL (scheduler.go lines 59-70).
function latestSuccessfulDeploymentURL(store: Store, environmentId: string): { url: string; ok: boolean } {
  const deps = store.listDeployments(environmentId);
  for (let i = deps.length - 1; i >= 0; i--) {
    const dep = deps[i]!;
    if (dep.status === "succeeded" && dep.url !== "") {
      return { url: dep.url, ok: true };
    }
  }
  return { url: "", ok: false };
}

function mustScheduleFromConfig(raw: string): string {
  try {
    const cfg = JSON.parse(raw) as { schedule?: string };
    return cfg.schedule ?? "";
  } catch {
    return "";
  }
}

// tick runs one scheduling pass: find every due cron, skip anything
// whose own environment hasn't earned crons (gated before claiming,
// so a non-eligible environment's cron still advances past this tick
// rather than being checked again every single tick), claim (for
// overlap: skip — allow fires unconditionally, without claiming at
// all, since the flag exists only to implement skip), fire, and
// release regardless of the HTTP call's own outcome (at-least-once
// delivery — a failed call still advances to its next scheduled
// tick, never retried by this scheduler itself) — port of
// Scheduler.Tick/fireOne (scheduler.go lines 81-125).
export async function tick(s: Scheduler, now: Date): Promise<void> {
  const due = s.store.dueCrons(now);
  for (const row of due) {
    await fireOne(s, row, now);
  }
}

async function fireOne(s: Scheduler, row: CronRow, now: Date): Promise<void> {
  const cfg = JSON.parse(row.config) as CronConfigShape;
  const env = s.store.getEnvironment(row.environmentId);
  const next = nextRun(mustScheduleFromConfig(row.config), now);

  if (!cronsEnabled(env)) {
    s.store.releaseCron(row.environmentId, row.cronId, row.nextRun, next);
    return;
  }

  if (cfg.overlap === "skip") {
    const claimed = s.store.claimCron(row.environmentId, row.cronId);
    if (!claimed) return; // already running this tick — leave next_run alone, try again next tick
  }

  // Fire-and-forget: an unawaited async call is this rewrite's own
  // already-proven `go func(){...}()` equivalent — one slow cron
  // must never block every other due cron in the same tick. The
  // `.catch` is load-bearing, not decorative: invoke's own finally
  // block (releaseCron/releaseNextRunOnly) can throw against a store
  // that closed mid-flight, and an unobserved rejection from a fire-
  // and-forget call crashes the whole process, not just this cron.
  void invoke(s, row.environmentId, cfg, next).catch(() => {});
}

async function invoke(s: Scheduler, environmentId: string, cfg: CronConfigShape, next: Date): Promise<void> {
  const ranAt = new Date();
  try {
    const { url, ok } = latestSuccessfulDeploymentURL(s.store, environmentId);
    if (!ok) return;

    const timeoutMs = cfg.timeoutSec > 0 ? cfg.timeoutSec * 1000 : 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const ts = Math.floor(Date.now() / 1000);
      const secret = s.store.ensureCronSigningSecret(environmentId);
      const client = s.httpClient ?? defaultCronFetch;
      const response = await client(url + cfg.target.path, {
        method: cfg.target.method,
        headers: {
          Authorization: `Bearer ${signCron(secret, cfg.id, ts)}`,
          "X-Nbo-Cron-Timestamp": String(ts),
          "X-Nbo-Cron": cfg.id,
        },
        signal: controller.signal,
      });
      // This scheduler never reads the response body — cancel it
      // explicitly so a backend that streams past its own headers
      // doesn't hold its connection open indefinitely; the abort
      // timeout above only covers waiting for headers to arrive.
      await response.body?.cancel();
    } catch {
      // at-least-once delivery — a failed call still advances to its
      // next scheduled tick, never retried by this scheduler itself.
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (cfg.overlap === "skip") {
      s.store.releaseCron(environmentId, cfg.id, ranAt, next);
    } else {
      s.store.releaseNextRunOnly(environmentId, cfg.id, next);
    }
  }
}

// run ticks every schedulerConfig.cronTickIntervalMs until signal is
// aborted — port of Scheduler.Run (scheduler.go lines 185-196),
// AbortSignal in place of Go's own context.Context, this rewrite's
// own established cancellation idiom.
export async function run(s: Scheduler, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const aborted = await new Promise<boolean>((resolvePromise) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolvePromise(true);
      };
      // The timer path removes its own abort listener — without
      // this, a {once:true} listener added every tick is only ever
      // cleaned up if abort actually fires, leaking one closure per
      // tick for the life of the process.
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(false);
      }, schedulerConfig.cronTickIntervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (aborted) return;
    try {
      await tick(s, new Date());
    } catch {
      // Go's own Run discards Tick's own error and keeps ticking —
      // one bad cron row must never stop every other environment's
      // crons forever.
    }
  }
}
