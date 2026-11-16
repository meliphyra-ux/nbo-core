// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { pathToFileURL } from "node:url";
import { run, evaluate, type Config } from "./run.js";

// parseLoadtestOptions reads the optional rate/duration/concurrency
// overrides, matching Go's own defaults (50 req/s, 10s, 20) exactly —
// port of main's own rps/phaseDuration/concurrency parsing (main.go
// lines 28-56).
//
// Ruling (Task 7): NBO_LOADTEST_PHASE_DURATION takes a plain
// millisecond integer here, not a Go duration string ("10s") — Go's
// time.ParseDuration has no TS stdlib equivalent, and the plan's own
// brief didn't pin the override's exact string format, only the
// variable name and default value (both preserved). Cost if wrong: an
// operator migrating a Go-style "10s" override would need to rewrite
// it as "10000"; the default itself is unaffected.
export function parseLoadtestOptions(env: Record<string, string | undefined>): {
  requestsPerSec: number;
  phaseDurationMs: number;
  concurrency: number;
} {
  const requestsPerSec = parseIntEnv(env, "NBO_LOADTEST_RPS", 50);
  const phaseDurationMs = parseIntEnv(env, "NBO_LOADTEST_PHASE_DURATION", 10_000);
  const concurrency = parseIntEnv(env, "NBO_LOADTEST_CONCURRENCY", 20);
  return { requestsPerSec, phaseDurationMs, concurrency };
}

function parseIntEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`loadtest: invalid ${name}: ${raw}`);
  }
  return n;
}

const requiredEnvVars = [
  "NBO_LOADTEST_PROXY_URL",
  "NBO_LOADTEST_HOST",
  "NBO_LOADTEST_ADMIN_URL",
  "NBO_LOADTEST_K8S_URL",
  "NBO_LOADTEST_CLOUDRUN_URL",
] as const;

// main — port of cmd/loadtest/main.go lines 13-92: the four hardcoded
// phases are the exact sequence scripts/verify-slice3-edge.sh already
// proved for real, not configurable in this tool's own v0.
async function main(): Promise<void> {
  const env = process.env;
  const missing = requiredEnvVars.filter((name) => !env[name]);
  if (missing.length > 0) {
    for (const name of missing) console.error(`loadtest: ${name} must be set`);
    process.exitCode = 1;
    return;
  }

  let options: { requestsPerSec: number; phaseDurationMs: number; concurrency: number };
  try {
    options = parseLoadtestOptions(env);
  } catch (err) {
    console.error(`loadtest: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const cfg: Config = {
    proxyURL: env.NBO_LOADTEST_PROXY_URL!,
    host: env.NBO_LOADTEST_HOST!,
    adminURL: env.NBO_LOADTEST_ADMIN_URL!,
    k8sBackendURL: env.NBO_LOADTEST_K8S_URL!,
    cloudRunBackendURL: env.NBO_LOADTEST_CLOUDRUN_URL!,
    cloudRunInsecureSkipVerify: env.NBO_LOADTEST_CLOUDRUN_INSECURE === "1",
    phases: [
      { k8sWeight: 99, cloudRunWeight: 1 },
      { k8sWeight: 90, cloudRunWeight: 10 },
      { k8sWeight: 50, cloudRunWeight: 50 },
      { k8sWeight: 0, cloudRunWeight: 100 },
    ],
    phaseDurationMs: options.phaseDurationMs,
    requestsPerSec: options.requestsPerSec,
    concurrency: options.concurrency,
  };

  let result;
  try {
    result = await run(new AbortController().signal, cfg);
  } catch (err) {
    console.error(`loadtest: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  for (const p of result.phases) {
    console.log(
      `phase ${JSON.stringify(p.weights)}: total=${p.total} failures=${p.failures} k8s_hits=${p.k8sHits} cloudrun_hits=${p.cloudRunHits}`,
    );
  }

  const problems = evaluate(result);
  if (problems.length > 0) {
    console.error("loadtest: FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log("loadtest: PASSED — zero failed requests, every phase's split honored");
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main();
}
