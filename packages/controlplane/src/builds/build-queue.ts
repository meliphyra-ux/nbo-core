// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { ErrInvalidEnvironmentConfig, type Store } from "../store/store.js";
import { waitingForValues, type SuppliedValues } from "../variables/supplied-values.js";
import type { Build } from "../git/git.js";
import { variableStage } from "../stages/stages.js";
import type { BuildTrigger } from "../git/webhooks.js";

export interface BuildQueue extends BuildTrigger {
  // idle resolves once the project has nothing running or queued —
  // tests and the transfer flow await it instead of sleeping.
  idle(projectId: string): Promise<void>;
  // enqueuePromote queues a job deploying a stored build's .nbo/ to one
  // environment (no rebuild). Promotes run in queue order with builds,
  // and a newer commit never supersedes one. A promote job's id is
  // accepted too (it deploys the build that job promoted).
  // opts.values: the variable values the request brought (names only);
  // checked now and held in memory for the job.
  enqueuePromote(
    projectId: string,
    buildId: string,
    environmentId: string,
    opts?: { values?: Record<string, string> },
  ): Build;
}

const cleanedUp = "This build's output was cleaned up: rebuild it to deploy it";

// How many builds run at once on this server when NBO_BUILD_CONCURRENCY is unset.
const defaultConcurrency = 2;

// parseBuildConcurrency reads NBO_BUILD_CONCURRENCY: unset means the
// default, anything but a positive whole number throws (main.ts refuses to start).
export function parseBuildConcurrency(value: string | undefined): number {
  if (value === undefined || value === "") return defaultConcurrency;
  if (!/^[1-9][0-9]*$/.test(value))
    throw new Error(`NBO_BUILD_CONCURRENCY must be a positive whole number, not "${value}"`);
  return Number(value);
}

// createBuildQueue runs at most one job per (project, stage), and at most
// `concurrency` commit builds across the server; promotes take no build slot
// (they run no repository code) but stay serial with their stage's builds.
// Each stage keeps at most one queued commit build: a newer request of the
// same stage replaces the queued one (newest wins; the replaced build is
// recorded "skipped" so the history never silently loses it). When a stage
// or a slot frees, jobs start in the queue's own order across every
// project: Production's first, then other stages', each oldest first.
//
// The queue's state of truth is in-process (`running`), not the DB:
// after a restart nothing is running, and any build the previous
// process left "running"/"queued" is not resumed here (main.ts marks
// those failed at startup).
// shortcut: in-process state, so one NBO process per database; a second process would need a DB lease.
//
// Supplied values (names only) wait in `supplied` under the job's id until
// the runner takes them; a superseded job's are dropped at once, and the
// queue drops whatever is left when a job ends.
export function createBuildQueue(
  store: Store,
  runner: { runBuild(buildId: string): Promise<void> },
  supplied: SuppliedValues,
  opts?: { concurrency?: number },
): BuildQueue {
  const concurrency = opts?.concurrency ?? defaultConcurrency;
  // The running jobs, keyed by project and stage.
  const running = new Map<string, { projectId: string; done: Promise<void> }>();
  let buildsRunning = 0;
  const namesOnly = (): boolean => store.getServerSettings().envValues === "none";
  // The stage whose variables a job uses (an ephemeral stage uses Preview's).
  const stageName = (projectId: string, stageId: string): string =>
    variableStage(stageId ? store.getStage(stageId) : store.productionStage(projectId));

  function drain(): void {
    // A stage is taken by its running job, or by its first queued job
    // (later jobs of that stage never pass it, even while it waits for a slot).
    const taken = new Set(running.keys());
    for (const next of store.queuedJobs()) {
      const key = `${next.projectId}/${next.stageId}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const isBuild = next.kind !== "promote";
      if (isBuild && buildsRunning >= concurrency) continue;
      if (isBuild) buildsRunning++;
      const done = (async () => {
        try {
          await runner.runBuild(next.id);
        } catch (err) {
          try {
            store.completeBuild(next.id, "failed", undefined, err instanceof Error ? err.message : String(err));
          } catch {
            // store unavailable
          }
        } finally {
          supplied.drop(next.id);
        }
      })();
      running.set(key, { projectId: next.projectId, done });
      void done.finally(() => {
        running.delete(key);
        if (isBuild) buildsRunning--;
        try {
          drain();
        } catch {
          // store closed (process shutting down) — nothing to drain
        }
      });
    }
  }

  return {
    enqueue(
      projectId: string,
      revision: string,
      opts?: { manual?: boolean; stageId?: string; values?: Record<string, string> },
    ): Build {
      // Only a newer build of the same stage supersedes a queued one: a
      // staging push never throws away a queued Production build.
      const stageId = opts?.stageId || store.productionStage(projectId).id;
      if (namesOnly()) {
        const stage = stageName(projectId, stageId);
        if (opts?.values === undefined) {
          // Nobody sent values (a push, a poll): if the stage needs some,
          // record the build skipped now, before it could supersede a
          // queued build that holds values.
          if (store.declaredEnvNames(projectId, stage).length > 0) {
            const build = store.createQueuedBuild(projectId, revision, { manual: opts?.manual === true, stageId });
            store.setBuildDetails(build.id, { note: waitingForValues });
            store.completeBuild(build.id, "skipped");
            return store.getBuild(build.id);
          }
        } else {
          // Checked before anything is recorded (throws ErrInvalidEnvVar).
          store.resolveEnv(projectId, stage, opts.values);
        }
      } else if (opts?.values !== undefined) {
        store.resolveEnv(projectId, stageName(projectId, stageId), opts.values);
      }
      const older = store.findQueuedBuild(projectId, stageId);
      if (older) {
        store.completeBuild(older.id, "skipped", undefined, "superseded by a newer build");
        supplied.drop(older.id);
      }
      // A Redeploy someone asked for is not lost to a newer push: the
      // replacing build inherits its full-rebuild flag.
      const manual = opts?.manual === true || older?.manual === true;
      const build = store.createQueuedBuild(projectId, revision, { manual, stageId });
      if (namesOnly() && opts?.values !== undefined) supplied.put(build.id, opts.values);
      drain();
      return store.getBuild(build.id);
    },

    enqueuePromote(
      projectId: string,
      buildId: string,
      environmentId: string,
      opts?: { values?: Record<string, string> },
    ): Build {
      let source = store.getBuild(buildId);
      if (source.kind === "promote") source = store.getBuild(source.sourceBuildId);
      if (source.projectId !== projectId)
        throw new ErrInvalidEnvironmentConfig("this build belongs to another project");
      const env = store.getEnvironment(environmentId);
      if (env.projectId !== projectId)
        throw new ErrInvalidEnvironmentConfig("that environment belongs to another project");
      if (env.archived) throw new ErrInvalidEnvironmentConfig(`${env.name} is archived`);
      // Any build whose output is stored qualifies (also one whose own
      // deploy failed somewhere: its .nbo/ was complete).
      if (!source.artifact) throw new ErrInvalidEnvironmentConfig(cleanedUp);
      // The target cloud's stage decides which values are needed (names
      // only: all its declared names; stored: none may be sent).
      if (namesOnly() || opts?.values !== undefined)
        store.resolveEnv(projectId, stageName(projectId, env.stageId), opts?.values);
      const job = store.createQueuedPromote(projectId, source.id, env.id);
      if (namesOnly() && opts?.values !== undefined) supplied.put(job.id, opts.values);
      drain();
      return store.getBuild(job.id);
    },

    async idle(projectId: string): Promise<void> {
      for (;;) {
        const all = [...running.values()];
        // The project is idle when nothing of it runs and nothing of it is
        // queued (a queued job waits for one of the running ones to finish).
        if (!all.some((r) => r.projectId === projectId) && (all.length === 0 || !store.nextQueuedJob(projectId)))
          return;
        await Promise.race(all.map((r) => r.done.catch(() => {})));
        // let the .finally above run and possibly start the queued build
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

// recoverInterruptedBuilds runs once at startup: a build the previous
// process left "running" or "queued" will never finish (the queue is
// in-process), so it is recorded failed rather than shown building
// forever. It returns the ids it failed.
export function recoverInterruptedBuilds(store: Store): string[] {
  const interrupted: string[] = [];
  for (const project of store.listProjects()) {
    for (const b of store.listBuilds(project.id)) {
      if (b.status === "running" || b.status === "queued") {
        store.completeBuild(
          b.id,
          "failed",
          b.deploymentIds,
          "interrupted: the control-plane restarted during this build",
        );
        interrupted.push(b.id);
      }
    }
  }
  return interrupted;
}
