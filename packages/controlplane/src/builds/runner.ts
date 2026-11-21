// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { formatSeconds } from "@nbo/deploy";
import type { Store } from "../store/store.js";
import { redactionsFor } from "../variables/env-vars.js";
import { waitingForValues } from "../variables/supplied-values.js";
import type { DeploymentTrigger } from "../http/handlers.js";
import { run } from "./run.js";
import { variableStage } from "../stages/stages.js";
import { gitEnv } from "../git/gitremote.js";
import { buildInput, commitLogFormat, parseCommit, summarizeOutput } from "./build-details.js";
import { defaultKeepBuilds, retainedBuildIds } from "./artifacts.js";
import { createJob, type RunnerOptions } from "./runner-job.js";
import { createDeployTo, deployEverywhere } from "./runner-deploy.js";
import { createPromoter } from "./runner-promote.js";
import { noSandbox } from "./sandbox.js";
import { errMessage, firstLine, sepFor, stageOf } from "./runner-helpers.js";

const noAutoDeploy = "Built — no cloud set to deploy new commits automatically";

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
      const ctx = createJob(store, options, buildId);
      const { supplied, namesOnly, state, scrub, log, step, timeline, phases, timedPhase, releaseGitAuth } = ctx;
      let retentionProject: string | undefined;
      const deployTo = createDeployTo(ctx, trigger);
      const sandbox = (options?.sandbox ?? noSandbox)(buildId, log);
      const runPromote = createPromoter(ctx, deployTo);
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
        state.secretValues = redactionsFor(resolvedEnv, namesOnly());
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
          state.gitAuth = options?.gitAuth ? await options.gitAuth(projectId, config) : null;
          if (state.gitAuth) {
            state.secretValues = [...state.secretValues, ...state.gitAuth.secrets];
            gitStepEnv = { ...gitEnv, ...state.gitAuth.env };
          }
          await step("git", ["clone", "--", config.repo, dest], { env: gitStepEnv });
          // No "--": revision is validated upstream as a 40-hex sha, and
          // `git checkout -- <ref>` would treat it as a file path.
          await step("git", ["-C", dest, "checkout", "-q", revision], { env: gitStepEnv });
          // The clone is full (all branches and tags, no refs/pull/*), so
          // this asks honestly whether the commit is on a branch of the
          // repository. A tag-only or pull-request-only commit is refused.
          const onBranches = await step("git", ["-C", dest, "branch", "-r", "--contains", revision], {
            env: gitStepEnv,
          });
          if (onBranches.trim() === "") throw new Error(`commit ${revision} is not on a branch of ${config.repo}`);
        });
        try {
          // Not logged raw (the separator line is noise): a clean line instead.
          const commit = parseCommit(
            await run("git", ["-C", dest, "log", "-1", commitLogFormat], {
              env: gitStepEnv,
              redactSecrets: state.secretValues,
            }),
          );
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
          store.completeBuild(
            buildId,
            "failed",
            undefined,
            `Root Directory "${config.rootDirectory}" escapes the cloned repository`,
          );
          return;
        }
        // Resolved by the kernel: a Root Directory linked outside the repository reads as missing whether or
        // not its target exists on this host (no existence oracle for host paths).
        const realClone = await realpath(cloneDir);
        const realApp = await realpath(appDir).catch(() => "");
        if (realApp !== realClone && !realApp.startsWith(realClone + sepFor(realClone))) {
          store.completeBuild(
            buildId,
            "failed",
            undefined,
            `Root Directory "${config.rootDirectory}" does not exist in the repository`,
          );
          return;
        }
        if (config.rootDirectory) log(`Root Directory: ${config.rootDirectory}\n`);
        const sandboxAdapterPath = await sandbox.prepare(cloneDir);

        // A manual rebuild (Redeploy) always builds in full.
        if (config.ignoredBuildStepCommand && !build.manual) {
          // Ignored Build Step: exit 0 skips, any non-zero code proceeds.
          let skip = true;
          const gate = timeline.begin("ignored build step");
          try {
            await step(config.ignoredBuildStepCommand, [], {
              cwd: appDir,
              shell: true,
              env: stageEnv,
              buildStep: true,
              via: sandbox.run,
            });
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

        const nextAdapterPath = sandboxAdapterPath ?? options?.nextAdapterPath ?? defaultNextAdapterPath();
        try {
          await timedPhase("build command", "build command done", () =>
            step(config.buildCommand, [], {
              cwd: appDir,
              shell: true,
              env: { ...resolvedEnv.vars, ...stageEnv, NEXT_ADAPTER_PATH: nextAdapterPath },
              buildStep: true,
              via: sandbox.run,
            }),
          );
        } catch (err) {
          store.completeBuild(buildId, "failed", undefined, scrub(firstLine(errMessage(err))));
          return;
        }

        // .nbo/ from the build's output; in a container it is made there and only it comes back here.
        const nboDir = join(appDir, ".nbo");
        const failure = await sandbox.produce(
          {
            framework: config.framework,
            appDir,
            root: cloneDir,
            outputDir: config.outputDir,
            spa: config.spa,
            rootDirectory: config.rootDirectory,
            env: { ...resolvedEnv.vars, ...stageEnv },
          },
          {
            log,
            timed: (fn) => timedPhase("produce .nbo", "produce .nbo done", fn),
            step: (cmd, args, env) => step(cmd, args, { cwd: appDir, env, buildStep: true, via: sandbox.run }),
          },
        );
        if (failure) {
          store.completeBuild(buildId, "failed", undefined, scrub(failure));
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
            stage.kind === "production"
              ? `project "${projectId}" has no environments to deploy to`
              : `the ${stage.name} environment has no clouds to deploy to`,
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

        await deployEverywhere(ctx, deployTo, { projectId, allEnvs, envs, nboDir, resolvedEnv, fingerprint });
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
        await sandbox.dispose();
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
