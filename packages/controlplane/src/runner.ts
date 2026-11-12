// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdtemp, rm, access, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { produce } from "@nbo/producer-static";
import { validate } from "@nbo/validate";
import { contentId } from "@nbo/digest";
import { holdCliDeployDir, createProgress, formatSeconds, redact } from "@nbo/deploy";
import type { Environment, Store } from "./store.js";
import { redactionsFor, type ResolvedEnv } from "./env-vars.js";
import { waitingForValues, type SuppliedValues } from "./supplied-values.js";
import type { DeploymentTrigger } from "./handlers.js";
import { run } from "./run.js";
import type { Build } from "./git.js";
import { variableStage, type Stage } from "./stages.js";
import { gitEnv } from "./gitremote.js";
import type { GitAuth, GitAuthFn } from "./git-credentials.js";
import { buildInput, commitLogFormat, createTimeline, parseCommit, parseSubStep, summarizeOutput, type TimelineEntry } from "./build-details.js";
import { defaultKeepBuilds, liveBuild, retainedBuildIds, type ArtifactStore } from "./artifacts.js";

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
}

const noAutoDeploy = "Built — no cloud set to deploy new commits automatically";
const promoteDamaged = "This build's stored output is damaged: rebuild it";
const promoteCleanedUp = "This build's stored output was cleaned up: rebuild it to deploy it";

type Outcome = { deploymentId?: string; failure?: string; succeeded?: boolean };
type Snapshot = { env: ResolvedEnv; fingerprint: string | null };

export interface Runner {
  runBuild(buildId: string): Promise<void>;
}

function defaultNextAdapterPath(): string {
  return createRequire(import.meta.url).resolve("@nbo/next-adapter/src/adapter.js");
}

// createRunner executes one already-created (queued) build: clone,
// optional ignored-build-step gate, build, locate (or produce) .nbo/,
// then deploy to every non-archived environment of the project with
// auto-deploy on, recording every outcome and every command's output on
// the Build row. A promote job (kind "promote") skips all of that and
// deploys a stored build's .nbo/ to its one environment (runPromote).
//
// runBuild never rejects — the build queue calls it fire-and-forget,
// and an unhandled rejection would crash the control-plane process.
export function createRunner(store: Store, trigger: DeploymentTrigger, options?: RunnerOptions): Runner {
  return {
    async runBuild(buildId: string): Promise<void> {
      let cloneDir: string | undefined;
      // The git credential's environment (a deploy key's file); released
      // once the git steps are done, and in finally whatever happens.
      let gitAuth: GitAuth | null = null;
      const releaseGitAuth = async (): Promise<void> => {
        const auth = gitAuth;
        gitAuth = null;
        try {
          await auth?.cleanup();
        } catch {
          // Best-effort cleanup (a temporary file).
        }
      };
      let retentionProject: string | undefined;
      // The values this job's request brought (names only), out of the
      // shared map at once: from here they live only in this call.
      const supplied = options?.supplied?.take(buildId);
      const namesOnly = (): boolean => store.getServerSettings().envValues === "none";
      // Secret variable values (resolved at build start) never reach the
      // build log or the recorded error; plain values are not redacted,
      // except with names only, where plain values of 6+ characters are too
      // (redactionsFor).
      let secretValues: string[] = [];
      // (Short secrets also redact matching substrings elsewhere: accepted, the safe direction.)
      const scrub = (text: string) => (secretValues.length ? redact(text, secretValues) : text);
      const log = (text: string) => {
        try {
          store.appendBuildLog(buildId, scrub(text));
        } catch {
          // store unavailable — nothing to record
        }
      };
      const step = (cmd: string, args: string[], opts?: { cwd?: string; shell?: boolean; env?: Record<string, string> }) => {
        log(`$ ${[cmd, ...args].join(" ")}\n`);
        return run(cmd, args, { ...opts, onOutput: log, redactSecrets: secretValues });
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
      // deployTo deploys nboDir (the output of build deployedBuildId) to
      // one environment, timing it on the timeline and in the log, and
      // runs onSuccess (edge sync) once the deploy succeeded.
      const deployTo = async (env: Environment, nboDir: string, snapshot: Snapshot, deployedBuildId: string, onSuccess: () => Promise<void>): Promise<Outcome> => {
        log(`Deploying to ${env.name} (${env.target})…\n`);
        const entry = timeline.begin(`deploy ${env.name}`);
        const reportDeploy = (ok: boolean) => {
          timeline.end(entry, ok ? "succeeded" : "failed");
          phases.report(`deploy ${env.name} ${ok ? "done in" : "failed after"} ${formatSeconds(entry.durationMs)}`);
        };
        // Sub-step lines from inside the deploy, tagged with the
        // environment; kept to one line so the log stays scannable.
        // Timed sub-steps also become the entry's nested timeline.
        const onProgress = (message: string) => {
          const line = message.replace(/\s*\r?\n\s*/g, " ");
          log(`${stamp()} ${env.name}: ${line}\n`);
          const child: TimelineEntry | null = parseSubStep(line, now());
          if (child) (entry.children ??= []).push(child);
        };
        // The cloud's current build keeps its hashed files through the
        // rollout: held against retention until the deploy settles.
        let releasePrevious: (() => void) | undefined;
        let carryFrom: string | undefined;
        try {
          const previous = liveBuild(store, env);
          if (previous && previous.id !== deployedBuildId) {
            releasePrevious = options?.artifacts?.hold(previous.id);
            carryFrom = options?.artifacts?.path(previous.id) ?? undefined;
            log(carryFrom ? `Keeping the files of build ${previous.revision.slice(0, 7)} during the rollout\n` : "No previous build output to keep\n");
          }
        } catch (err) {
          log(`No previous build output to keep (${firstLine(errMessage(err))})\n`);
        }
        try {
          const dep = await trigger.triggerDeploy(env.id, nboDir, {
            progress: onProgress,
            env: snapshot.env,
            fingerprint: snapshot.fingerprint,
            buildId: deployedBuildId,
            redact: secretValues,
            ...(carryFrom ? { carryFrom } : {}),
          });
          reportDeploy(dep.status === "succeeded");
          // triggerDeploy resolves (not rejects) with status "failed"
          // on a deploy failure — check it, don't assume success.
          if (dep.status === "succeeded") {
            log(`${env.name}: ready ${dep.url}\n`);
            await onSuccess();
            return { deploymentId: dep.id, succeeded: true };
          }
          const msg = dep.error || `deploy did not succeed (status: ${dep.status})`;
          log(`${env.name}: failed: ${msg}\n`);
          return { deploymentId: dep.id, failure: `${env.name}: ${msg}` };
        } catch (err) {
          reportDeploy(false);
          log(`${env.name}: failed: ${errMessage(err)}\n`);
          return { failure: `${env.name}: ${errMessage(err)}` };
        } finally {
          releasePrevious?.();
        }
      };

      // runPromote deploys a stored build's .nbo/ (job.sourceBuildId) to
      // one environment: no clone, no build. The stored copy is held
      // against retention for the whole job, checked with @nbo/validate
      // and against the build's recorded content id, then deployed with
      // the current variables of the target cloud's stage (a staging build
      // promoted to a Production cloud runs with Production's values).
      const runPromote = async (job: Build): Promise<void> => {
        const source = store.getBuild(job.sourceBuildId);
        const env = store.getEnvironment(job.targetEnvironmentId);
        const resolvedEnv = store.resolveEnv(job.projectId, variableStage(stageOf(store, env.projectId, env.stageId)), supplied);
        const fingerprint = store.envFingerprintFor(resolvedEnv);
        secretValues = redactionsFor(resolvedEnv, namesOnly());
        try {
          store.setBuildDetails(job.id, { input: buildInput(store.getGitConfig(job.projectId), true, resolvedEnv, fingerprint) });
        } catch (err) {
          log(`Recording the build input failed: ${firstLine(errMessage(err))}
`);
        }
        log(`Deploying the stored output of build ${source.id} (${source.revision.slice(0, 7)}) to ${env.name} — no rebuild
`);
        if (env.archived || env.projectId !== job.projectId) {
          store.completeBuild(job.id, "failed", undefined, `${env.name} is not an active environment of this project`);
          return;
        }
        const release = options?.artifacts?.hold(source.id) ?? (() => {});
        try {
          const dir = options?.artifacts?.path(source.id) ?? null;
          if (!dir) {
            store.completeBuild(job.id, "failed", undefined, promoteCleanedUp);
            return;
          }
          try {
            await timedPhase("validate", "validate done", async () => {
              const errs = validate(dir);
              for (const e of errs.slice(0, 20))
                log(`  ${e.message}
`);
              if (errs.length > 0) throw new Error(`the stored .nbo/ has ${errs.length} validation error(s)`);
              const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
              const actual = contentId(manifest);
              if (actual !== source.contentId) throw new Error(`content id ${actual} differs from the recorded ${source.contentId || "(none)"}`);
            });
          } catch (err) {
            log(`${errMessage(err)}
`);
            store.completeBuild(job.id, "failed", undefined, promoteDamaged);
            return;
          }
          const onSuccess = async () => {
            try {
              await options?.onDeployed?.(job.projectId, env.id);
            } catch (err) {
              log(`${env.name}: deployed, but updating the edge failed: ${errMessage(err)}
`);
            }
          };
          const sharedWork = (options?.holdSharedWork ?? holdCliDeployDir)(dir);
          let outcome: Outcome;
          try {
            outcome = await deployTo(env, dir, { env: resolvedEnv, fingerprint }, source.id, onSuccess);
          } finally {
            await sharedWork.release();
          }
          const ids = outcome.deploymentId ? [outcome.deploymentId] : [];
          if (outcome.failure) store.completeBuild(job.id, "failed", ids, scrub(outcome.failure));
          else store.completeBuild(job.id, "succeeded", ids);
        } finally {
          release();
        }
      };
      let started = false;
      const buildEvent = async (phase: "started" | "finished") => {
        if (!options?.onBuildEvent) return;
        try {
          await options.onBuildEvent(buildId, phase);
        } catch (err) {
          log(`Reporting the build ${phase === "started" ? "start" : "end"} failed: ${firstLine(errMessage(err))}
`);
        }
      };
      try {
        store.startBuild(buildId);
        started = true;
        await buildEvent("started");
        const build = store.getBuild(buildId);
        const projectId = build.projectId;
        retentionProject = projectId;
        if (build.kind === "promote") {
          await runPromote(build);
          return;
        }
        const revision = build.revision;
        const config = store.getGitConfig(projectId);
        // The stage this build is for: its variables, its branch, its clouds.
        const stage = stageOf(store, projectId, build.stageId);
        const branch = stage.kind === "production" ? config.productionBranch : stage.branch;
        // What the build command and the Ignored Build Step learn about it.
        // An ephemeral environment is "preview".
        const vars = variableStage(stage);
        const stageEnv = { NBO_ENV: vars, NBO_GIT_COMMIT_REF: branch, NBO_GIT_COMMIT_SHA: revision };
        // Names only, and nobody sent values (an old queued row, a path that
        // skipped the queue's check): there is nothing to build with.
        if (supplied === undefined && namesOnly() && store.declaredEnvNames(projectId, vars).length > 0) {
          store.setBuildDetails(buildId, { note: waitingForValues });
          store.completeBuild(buildId, "skipped");
          return;
        }
        // One snapshot per build: the build command and every
        // environment's deploy see the same values.
        const resolvedEnv = store.resolveEnv(projectId, vars, supplied);
        const fingerprint = store.envFingerprintFor(resolvedEnv);
        secretValues = redactionsFor(resolvedEnv, namesOnly());
        try {
          store.setBuildDetails(buildId, { input: buildInput(config, build.manual, resolvedEnv, fingerprint) });
        } catch (err) {
          log(`Recording the build input failed: ${firstLine(errMessage(err))}\n`);
        }
        cloneDir = await mkdtemp(join(tmpdir(), "nbo-build-"));

        const dest = cloneDir;
        // The git steps' environment: the project's credential travels only
        // here, and joins the redaction list first (after the variables'
        // list was set above), so the log and the build error scrub it.
        let gitStepEnv: Record<string, string> = gitEnv;
        await timedPhase("clone and checkout", "clone and checkout done", async () => {
          gitAuth = options?.gitAuth ? await options.gitAuth(projectId, config) : null;
          if (gitAuth) {
            secretValues = [...secretValues, ...gitAuth.secrets];
            gitStepEnv = { ...gitEnv, ...gitAuth.env };
          }
          await step("git", ["clone", "--", config.repo, dest], { env: gitStepEnv });
          // No "--": revision is validated upstream as a 40-hex sha, and
          // `git checkout -- <ref>` would treat it as a file path.
          await step("git", ["-C", dest, "checkout", "-q", revision], { env: gitStepEnv });
        });
        try {
          // Not logged raw (the separator line is noise): a clean line instead.
          const commit = parseCommit(await run("git", ["-C", dest, "log", "-1", commitLogFormat], { env: gitStepEnv, redactSecrets: secretValues }));
          if (commit) {
            store.setBuildDetails(buildId, { commit });
            log(`Commit ${commit.sha.slice(0, 7)} ${commit.message}\n`);
          }
        } catch (err) {
          log(`Reading the commit details failed: ${firstLine(errMessage(err))}\n`);
        }
        // The git steps are done: a deploy key's file goes now.
        await releaseGitAuth();

        // appDir: the Root Directory inside the clone; everything below
        // (build command, outputDir, .nbo/) is relative to it.
        const appDir = resolve(cloneDir, config.rootDirectory ?? ".");
        if (appDir !== cloneDir && !appDir.startsWith(cloneDir + sepFor(cloneDir))) {
          store.completeBuild(buildId, "failed", undefined, `Root Directory "${config.rootDirectory}" escapes the cloned repository`);
          return;
        }
        if (!(await exists(appDir))) {
          store.completeBuild(buildId, "failed", undefined, `Root Directory "${config.rootDirectory}" does not exist in the repository`);
          return;
        }
        if (config.rootDirectory) log(`Root Directory: ${config.rootDirectory}\n`);

        // A manual rebuild (Redeploy) always builds in full.
        if (config.ignoredBuildStepCommand && !build.manual) {
          // Ignored Build Step: exit 0 skips, any non-zero code proceeds.
          let skip = true;
          const gate = timeline.begin("ignored build step");
          try {
            await step(config.ignoredBuildStepCommand, [], { cwd: appDir, shell: true, env: stageEnv });
          } catch {
            skip = false;
          }
          // A non-zero exit is the normal "proceed" answer, not a failure.
          timeline.end(gate, "succeeded");
          phases.report(`ignored build step done in ${formatSeconds(gate.durationMs)}`);
          if (skip) {
            log("Ignored build step exited 0 — skipping this build.\n");
            store.completeBuild(buildId, "skipped");
            return;
          }
        }

        const nextAdapterPath = options?.nextAdapterPath ?? defaultNextAdapterPath();
        try {
          await timedPhase("build command", "build command done", () =>
            step(config.buildCommand, [], { cwd: appDir, shell: true, env: { ...resolvedEnv.vars, ...stageEnv, NEXT_ADAPTER_PATH: nextAdapterPath } }),
          );
        } catch (err) {
          store.completeBuild(buildId, "failed", undefined, scrub(firstLine(errMessage(err))));
          return;
        }

        const nboDir = join(appDir, ".nbo");
        if (config.framework === "static") {
          const rawDir = resolve(appDir, config.outputDir ?? "dist");
          // Defense in depth — the git-config PUT already rejects an
          // outputDir escaping the clone; this check means .git/ can
          // never be published even if that validation is loosened.
          if (rawDir !== cloneDir && !rawDir.startsWith(cloneDir + sepFor(cloneDir))) {
            store.completeBuild(buildId, "failed", undefined, `outputDir "${config.outputDir}" escapes the cloned repository`);
            return;
          }
          if (!(await exists(rawDir))) {
            store.completeBuild(buildId, "failed", undefined, `expected the build command to create "${config.outputDir ?? "dist"}", but it does not exist`);
            return;
          }
          log(`Producing .nbo/ from ${config.outputDir ?? "dist"}${config.spa ? " (SPA fallback)" : ""}\n`);
          await timedPhase("produce .nbo", "produce .nbo done", () => produce(rawDir, nboDir, { spa: config.spa }));
        } else if (!(await exists(nboDir))) {
          // The adapter writes .nbo/ next to the Next.js app; if the build
          // command cd'd into a subfolder, point at the setting that fixes it.
          const found = await findNestedNbo(appDir);
          const hint = found
            ? ` — found ${found}/.nbo — set Root Directory to "${[config.rootDirectory, found].filter(Boolean).join("/")}" (and drop the cd from the build command)`
            : " (NBO sets NEXT_ADAPTER_PATH during the build; check that this is a Next.js 16+ app and its build ran next build)";
          store.completeBuild(
            buildId,
            "failed",
            undefined,
            `expected the build command to produce ".nbo/" in ${config.rootDirectory || "the repository root"}, but it does not exist${hint}`,
          );
          return;
        }

        // Build page output: a summary from the local files, and a kept
        // copy of .nbo/. Neither may fail the build.
        try {
          const summary = await summarizeOutput(nboDir);
          store.setBuildDetails(buildId, { outputSummary: summary, contentId: summary.contentId });
        } catch (err) {
          log(`Reading the build output failed: ${firstLine(errMessage(err))}\n`);
        }
        if (options?.artifacts) {
          try {
            await options.artifacts.save(buildId, nboDir);
            store.setBuildDetails(buildId, { artifact: true });
          } catch (err) {
            log(`Keeping the build output failed: ${firstLine(errMessage(err))}\n`);
          }
        }

        // Only the build's own stage's clouds; firstDeploy below is per stage too.
        const allEnvs = store.listEnvironments(projectId, { stageId: stage.id });
        if (allEnvs.length === 0) {
          store.completeBuild(
            buildId,
            "failed",
            undefined,
            stage.kind === "production" ? `project "${projectId}" has no environments to deploy to` : `the ${stage.name} environment has no clouds to deploy to`,
          );
          return;
        }
        // A commit build deploys only where new commits deploy
        // automatically; the other clouds keep the build they run.
        const envs = allEnvs.filter((e) => e.autoDeploy);
        for (const e of allEnvs)
          if (!e.autoDeploy)
            log(`${e.name}: not deploying — this cloud does not take new commits automatically
`);
        if (envs.length === 0) {
          log(`${noAutoDeploy}
`);
          store.setBuildDetails(buildId, { note: noAutoDeploy });
          store.completeBuild(buildId, "succeeded", []);
          return;
        }

        // Every environment deploys concurrently. Each one's log lines
        // carry its name, so interleaved lines stay attributable; the
        // results are collected per environment and aggregated in
        // environment order, exactly as the old sequential loop did.
        // Edge updates (onDeployed) run one at a time, in completion
        // order, so two pushes of the same project's split never race.
        let edgeQueue: Promise<void> = Promise.resolve();
        const updateEdge = (envName: string, envId: string): Promise<void> => {
          const next = edgeQueue.then(async () => {
            try {
              await options?.onDeployed?.(projectId, envId);
            } catch (err) {
              log(`${envName}: deployed, but updating the edge failed: ${errMessage(err)}\n`);
            }
          });
          edgeQueue = next;
          return next;
        };
        // First deploy of the stage (none of its clouds has traffic yet):
        // onDeployed gives 100% to the first environment it is called
        // for, which must not depend on which deploy finishes first. So
        // edge updates wait until every environment has settled and then
        // run in environment order — the first SUCCEEDED environment in
        // order gets the traffic, exactly as the sequential loop did.
        // Later deploys update the edge as each environment finishes.
        const firstDeploy = allEnvs.every((e) => e.trafficWeight === 0);
        const deployOne = (env: Environment): Promise<Outcome> =>
          deployTo(env, nboDir, { env: resolvedEnv, fingerprint }, buildId, () => (firstDeploy ? Promise.resolve() : updateEdge(env.name, env.id)));
        // One CLI bundle per build, shared by every environment's app
        // image and removed once they have all finished.
        const sharedWork = (options?.holdSharedWork ?? holdCliDeployDir)(nboDir);
        let settled: PromiseSettledResult<Outcome>[];
        try {
          settled = await Promise.allSettled(envs.map((env) => deployOne(env)));
        } finally {
          await sharedWork.release();
        }
        if (firstDeploy) {
          for (const [i, r] of settled.entries()) {
            if (r.status === "fulfilled" && r.value.succeeded) await updateEdge(envs[i]!.name, envs[i]!.id);
          }
        }
        const deploymentIds: string[] = [];
        const failures: string[] = [];
        settled.forEach((r, i) => {
          // deployOne never rejects; this is only belt and braces.
          const outcome: Outcome = r.status === "fulfilled" ? r.value : { failure: `${envs[i]!.name}: ${errMessage(r.reason)}` };
          if (outcome.deploymentId) deploymentIds.push(outcome.deploymentId);
          if (outcome.failure) failures.push(outcome.failure);
        });
        if (failures.length === 0) {
          store.completeBuild(buildId, "succeeded", deploymentIds);
        } else {
          store.completeBuild(buildId, "failed", deploymentIds, scrub(failures.join("; ")));
        }
      } catch (err) {
        log(`${errMessage(err)}\n`);
        try {
          store.completeBuild(buildId, "failed", undefined, scrub(firstLine(errMessage(err))));
        } catch {
          // store unavailable — nothing left to record; still never throw
        }
      } finally {
        try {
          store.setBuildDetails(buildId, { timeline: timeline.entries });
        } catch {
          // store unavailable
        }
        // Retention, after every build: the newest successful builds and
        // every live one keep their output.
        if (options?.artifacts && retentionProject) {
          try {
            const keep = retainedBuildIds(store, retentionProject, options.keepBuilds ?? defaultKeepBuilds);
            for (const id of await options.artifacts.prune(retentionProject, (id) => keep.has(id))) {
              store.setBuildDetails(id, { artifact: false });
            }
          } catch (err) {
            log(`Cleaning up old build output failed: ${firstLine(errMessage(err))}\n`);
          }
        }
        if (started) await buildEvent("finished");
        // However the job ended, its values are gone from the shared map.
        options?.supplied?.drop(buildId);
        await releaseGitAuth();
        if (cloneDir) {
          try {
            await rm(cloneDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup.
          }
        }
      }
    },
  };
}

// stageOf is the stage a build or cloud row belongs to; Production when
// the id is "" (rows made outside the store's own methods).
function stageOf(store: Store, projectId: string, stageId: string): Stage {
  return stageId ? store.getStage(stageId) : store.productionStage(projectId);
}

// findNestedNbo looks up to two folders down for a .nbo/ the build
// produced somewhere other than the Root Directory; returns its folder,
// relative and with forward slashes, or null.
async function findNestedNbo(dir: string, depth = 2, prefix = ""): Promise<string | null> {
  if (depth === 0) return null;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git" || e.name === ".nbo") continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (await exists(join(dir, e.name, ".nbo"))) return rel;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git" || e.name === ".nbo" || e.name.startsWith(".")) continue;
    const found = await findNestedNbo(join(dir, e.name), depth - 1, prefix ? `${prefix}/${e.name}` : e.name);
    if (found) return found;
  }
  return null;
}

function sepFor(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// firstLine keeps a build's error summary short; the full command
// output is already in the build log.
function firstLine(msg: string): string {
  const line = msg.split(/\r?\n/)[0] ?? msg;
  return line.replace(/:$/, "");
}
