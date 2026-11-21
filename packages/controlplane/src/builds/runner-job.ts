// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// What one build job shares across its steps: the log, redaction, timeline and cleanup of its git credential.
import { createProgress, formatSeconds, redact } from "@nbo/deploy";
import type { Store } from "../store/store.js";
import type { ArtifactStore } from "./artifacts.js";
import type { SuppliedValues } from "../variables/supplied-values.js";
import type { GitAuth, GitAuthFn } from "../git/git-credentials.js";
import { createTimeline } from "./build-details.js";
import { run } from "./run.js";
import type { SandboxFactory } from "./sandbox.js";

export interface RunnerOptions {
  // nextAdapterPath is exported to the build command as
  // NEXT_ADAPTER_PATH, so an ordinary public Next.js repo builds into
  // .nbo/ without its author wiring @nbo/next-adapter into next.config.
  nextAdapterPath?: string;
  // onDeployed runs after each successful per-environment deployment
  // (main.ts wires edge sync into it). Its errors are logged into the
  // build log, never fail the build — the deploy itself succeeded.
  onDeployed?: (projectId: string, environmentId: string) => Promise<void>;
  // now is the clock for the step timings in the build log (injectable
  // so tests are deterministic); defaults to Date.now.
  now?: () => number;
  // holdSharedWork keeps work shared by every environment of one build
  // (the prepared CLI bundle) alive until all of them finish; defaults
  // to @nbo/deploy's holdCliDeployDir. Injectable for tests.
  holdSharedWork?: (nboDir: string) => { release(): Promise<void> };
  // artifacts keeps each build's .nbo/ (and applies retention after each
  // build); without it nothing is kept.
  artifacts?: ArtifactStore;
  // keepBuilds is how many successful builds per project keep their
  // output besides the live ones; defaults to 20.
  keepBuilds?: number;
  // supplied holds the variable values deploy requests brought (names
  // only); the runner takes a job's values as it starts.
  supplied?: SuppliedValues;
  // onBuildEvent runs after a job starts and once when it ends, however it
  // ends (promotes too); nothing in core listens today (a seam). Its
  // errors are logged into the build log and never fail the build.
  onBuildEvent?: (buildId: string, phase: "started" | "finished") => Promise<void>;
  // gitAuth gives the git steps (clone, checkout, log) the project's
  // credential (git-credentials.ts); never the build command.
  gitAuth?: GitAuthFn;
  // sandbox is where the ignored build step and the build command run (sandbox.ts); this host by default.
  sandbox?: SandboxFactory;
}

/** The mutable per-build state: the git credential until it is used once, and the values to redact from logs. */
export interface JobState {
  gitAuth: GitAuth | null;
  secretValues: string[];
}

// createJob: the state and helpers of one runBuild call; each call gets its own.
export function createJob(store: Store, options: RunnerOptions | undefined, buildId: string) {
  // The git credential's environment (a deploy key's file) and the secret values to redact from the log.
  const state: JobState = { gitAuth: null, secretValues: [] };
  const releaseGitAuth = async (): Promise<void> => {
    const auth = state.gitAuth;
    state.gitAuth = null;
    try {
      await auth?.cleanup();
    } catch {
      // Best-effort cleanup (a temporary file).
    }
  };
  const supplied = options?.supplied?.take(buildId);
  const namesOnly = (): boolean => store.getServerSettings().envValues === "none";
  // Secret variable values (resolved at build start) never reach the
  // build log or the recorded error; plain values are not redacted,
  // except with names only, where plain values of 6+ characters are too
  // (redactionsFor).
  // (Short secrets also redact matching substrings elsewhere: accepted, the safe direction.)
  const scrub = (text: string) => (state.secretValues.length ? redact(text, state.secretValues) : text);
  const log = (text: string) => {
    try {
      store.appendBuildLog(buildId, scrub(text));
    } catch {
      // store unavailable — nothing to record
    }
  };
  const step = (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; shell?: boolean; env?: Record<string, string>; buildStep?: boolean; via?: typeof run },
  ) => {
    log(`$ ${[cmd, ...args].join(" ")}\n`);
    // via: the build sandbox's run, for the repository's own commands.
    const { via = run, ...rest } = opts ?? {};
    return via(cmd, args, { ...rest, onOutput: log, redactSecrets: state.secretValues });
  };
  // Step timings: "[mm:ss]" is the time since the build started.
  const now = options?.now ?? Date.now;
  const startedAt = now();
  const stamp = () => {
    const total = Math.floor(Math.max(0, now() - startedAt) / 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `[${pad(Math.floor(total / 60))}:${pad(total % 60)}]`;
  };
  // @nbo/deploy's progress helper does the timing and wording; only
  // the "[mm:ss]" stamp is added here.
  const phases = createProgress({ onProgress: (m) => log(`${stamp()} ${m}\n`), now });
  // The build page's timeline: the same measurements the log lines
  // above are worded from (each phase is timed once).
  const timeline = createTimeline(now);
  const timedPhase = async <T>(name: string, done: string, fn: () => Promise<T>): Promise<T> => {
    const entry = timeline.begin(name);
    try {
      const result = await fn();
      timeline.end(entry, "succeeded");
      phases.report(`${done} in ${formatSeconds(entry.durationMs)}`);
      return result;
    } catch (err) {
      timeline.end(entry, "failed");
      phases.report(`${name} failed after ${formatSeconds(entry.durationMs)}`);
      throw err;
    }
  };
  return {
    store,
    options,
    buildId,
    supplied,
    namesOnly,
    state,
    scrub,
    log,
    step,
    now,
    stamp,
    phases,
    timeline,
    timedPhase,
    releaseGitAuth,
  };
}

export type Job = ReturnType<typeof createJob>;
