// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { fireOne, aggregate, adminClientTimeoutMs, type Phase, type PhaseResult, type LoadResponse } from "./generator.js";

// Config names a full load-test run: which proxy/admin endpoints to
// drive, which backend URLs to attribute responses to, and the phase
// sequence plus rate/concurrency to apply — port of Config (run.go
// lines 13-26).
export interface Config {
  proxyURL: string;
  host: string;
  adminURL: string;
  k8sBackendURL: string;
  cloudRunBackendURL: string;
  // cloudRunInsecureSkipVerify: the second backend has a self-signed
  // certificate too (a second app on the local kind cluster standing in
  // for Cloud Run, NBO_LOADTEST_SECOND=kubernetes in the verify script).
  cloudRunInsecureSkipVerify?: boolean;
  phases: Phase[];
  phaseDurationMs: number;
  requestsPerSec: number;
  concurrency: number;
}

// Result is the full run's per-phase outcome — port of Result (run.go
// lines 28-31).
export interface Result {
  phases: PhaseResult[];
}

function validateConfig(cfg: Config): void {
  if (cfg.phases.length === 0) {
    throw new Error("loadtest: Config.phases must be non-empty");
  }
  if (cfg.requestsPerSec <= 0) {
    throw new Error(`loadtest: Config.requestsPerSec must be positive, got ${cfg.requestsPerSec}`);
  }
  if (cfg.concurrency <= 0) {
    throw new Error(`loadtest: Config.concurrency must be positive, got ${cfg.concurrency}`);
  }
  if (cfg.phaseDurationMs <= 0) {
    throw new Error(`loadtest: Config.phaseDurationMs must be positive, got ${cfg.phaseDurationMs}`);
  }
}

// setWeights PUTs phase's weights to the edge layer's admin API — the
// Kubernetes backend's own insecureSkipVerify is hardcoded true,
// matching the local kind cluster's self-signed cert-manager cert — a
// plain fetch PUT is fine here (this call targets our own admin API,
// not spoofing anything; only fireOne's own load-firing path needs
// node:http directly) — port of setWeights (run.go lines 137-157).
async function setWeights(cfg: Config, phase: Phase): Promise<void> {
  const body = JSON.stringify({
    backends: [
      { url: cfg.k8sBackendURL, weight: phase.k8sWeight, insecureSkipVerify: true },
      { url: cfg.cloudRunBackendURL, weight: phase.cloudRunWeight, ...(cfg.cloudRunInsecureSkipVerify ? { insecureSkipVerify: true } : {}) },
    ],
  });
  // Final-review finding I2(c): matches Go's own adminClientTimeout
  // (run.go line 35) — a hung admin API must fail the run, not block
  // it forever.
  const response = await fetch(`${cfg.adminURL}/targets/${cfg.host}`, { method: "PUT", body, signal: AbortSignal.timeout(adminClientTimeoutMs) });
  if (response.status !== 204) {
    throw new Error(`admin API returned ${response.status}, want 204`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// runContinuousLoad fires load for the sum of every phase's duration in
// one continuous stream — never drained between phases — tagging each
// response by whichever phase index currentPhase.value holds at the
// moment the request is actually sent. A plain mutable field, not an
// atomic — Node's single-threaded event loop makes a synchronous
// read/write already safe as long as nothing awaits between them,
// matching this rewrite's own Concurrency Constraint — port of
// runContinuousLoad (run.go lines 97-135).
//
// Ruling (final review, findings I2(a)+(b)): a tick that arrives while
// already at the concurrency cap is dropped, not queued — the same
// fix and the same reasoning as generator.ts's own generateLoad (Go's
// ticker blocks on a buffered-channel send when the semaphore is
// full, so a slow receiver never sees ticks that arrived while
// blocked). This also settles I2(a) as a direct consequence, not a
// second, independent fix: the original attribution bug (reading
// currentPhase.value at tick time instead of send time) only mattered
// because a tick could be *queued* at one phase and not actually sent
// until a later phase had already started; once a saturated tick is
// simply dropped instead of queued, there is no more gap between
// "ticked" and "sent" for currentPhase.value to diverge across.
function runContinuousLoad(signal: AbortSignal, cfg: Config, currentPhase: { value: number }): Promise<LoadResponse[][]> {
  return new Promise((resolveAll) => {
    const totalDurationMs = cfg.phaseDurationMs * cfg.phases.length;
    const deadline = Date.now() + totalDurationMs;
    const perPhase: LoadResponse[][] = cfg.phases.map(() => []);
    const inFlight = new Set<Promise<void>>();
    let active = 0;

    const interval = setInterval(() => {
      if (Date.now() >= deadline || signal.aborted) {
        clearInterval(interval);
        Promise.all(inFlight).then(() => resolveAll(perPhase));
        return;
      }
      if (active >= cfg.concurrency) return;
      active++;
      const phaseIndex = currentPhase.value;
      const task = fireOne(signal, cfg.proxyURL, cfg.host).then((result) => {
        perPhase[phaseIndex]!.push(result);
        active--;
      });
      inFlight.add(task);
      task.then(() => inFlight.delete(task));
    }, 1000 / cfg.requestsPerSec);
  });
}

// run walks cfg.phases in order, setting each phase's weights through
// the edge layer's admin API, while load runs continuously across the
// whole sequence — a weight change can land while requests from the
// previous phase are still in flight, the exact scenario this whole
// tool exists to prove is safe. A weight-setting failure aborts the
// run immediately — no later phase's weights get set, and no load is
// fired against stale weights for a phase that was never reached —
// port of Run (run.go lines 46-79).
export async function run(signal: AbortSignal, cfg: Config): Promise<Result> {
  validateConfig(cfg);

  await setWeights(cfg, cfg.phases[0]!);

  const currentPhase = { value: 0 };
  const loadPromise = runContinuousLoad(signal, cfg, currentPhase);

  for (let i = 1; i < cfg.phases.length; i++) {
    await sleep(cfg.phaseDurationMs);
    currentPhase.value = i;
    try {
      await setWeights(cfg, cfg.phases[i]!);
    } catch (err) {
      await loadPromise; // let load already in flight finish before returning
      throw new Error(`loadtest: setting weights for phase ${JSON.stringify(cfg.phases[i])}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  const perPhase = await loadPromise;
  return { phases: cfg.phases.map((phase, i) => aggregate(phase, perPhase[i]!, cfg.k8sBackendURL, cfg.cloudRunBackendURL)) };
}

// evaluate checks a Result against the run's pass/fail gate, returning
// one human-readable problem per violation (empty means pass) — port
// of Evaluate (run.go lines 159-185), including its exact >=90%
// weight -> >=80% of total and weight 0 -> exactly 0 hits thresholds.
export function evaluate(result: Result): string[] {
  const problems: string[] = [];
  for (const p of result.phases) {
    if (p.total === 0) {
      problems.push(`phase ${JSON.stringify(p.weights)}: zero requests recorded`);
      continue;
    }
    if (p.failures > 0) {
      problems.push(`phase ${JSON.stringify(p.weights)}: ${p.failures} failed requests`);
    }
    if (p.weights.k8sWeight === 0 && p.k8sHits !== 0) {
      problems.push(`phase ${JSON.stringify(p.weights)}: kubernetes at weight 0 got ${p.k8sHits} hits`);
    }
    if (p.weights.cloudRunWeight === 0 && p.cloudRunHits !== 0) {
      problems.push(`phase ${JSON.stringify(p.weights)}: cloud run at weight 0 got ${p.cloudRunHits} hits`);
    }
    if (p.weights.k8sWeight >= 90 && p.k8sHits * 100 < p.total * 80) {
      problems.push(`phase ${JSON.stringify(p.weights)}: expected >=80% of ${p.total} requests to kubernetes, got ${p.k8sHits}`);
    }
    if (p.weights.cloudRunWeight >= 90 && p.cloudRunHits * 100 < p.total * 80) {
      problems.push(`phase ${JSON.stringify(p.weights)}: expected >=80% of ${p.total} requests to cloud run, got ${p.cloudRunHits}`);
    }
  }
  return problems;
}
