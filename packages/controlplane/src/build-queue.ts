// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { ErrInvalidEnvironmentConfig, type Store } from "./store.js";
import { waitingForValues, type SuppliedValues } from "./supplied-values.js";
import type { Build } from "./git.js";
import { variableStage } from "./stages.js";
import type { BuildTrigger } from "./webhooks.js";

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
  enqueuePromote(projectId: string, buildId: string, environmentId: string, opts?: { values?: Record<string, string> }): Build;
}

const cleanedUp = "This build's output was cleaned up: rebuild it to deploy it";

// createBuildQueue serializes builds per project: at most one running,
// and one queued commit build per stage. A newer request of the same
// stage replaces the queued one (newest wins; the replaced build is
// recorded "skipped" so the history never silently loses it). Different
// projects build concurrently. Promote jobs share the queue: jobs start
// one at a time, Production's first, then other stages', each oldest first.
//
// The queue's state of truth is in-process (`active`), not the DB:
// after a restart nothing is running, and any build the previous
// process left "running"/"queued" is not resumed here (main.ts marks
// those failed at startup).
//
// Supplied values (names only) wait in `supplied` under the job's id until
// the runner takes them; a superseded job's are dropped at once, and the
// queue drops whatever is left when a job ends.
export function createBuildQueue(store: Store, runner: { runBuild(buildId: string): Promise<void> }, supplied: SuppliedValues): BuildQueue {
  const active = new Map<string, Promise<void>>();
  const namesOnly = (): boolean => store.getServerSettings().envValues === "none";
  // The stage whose variables a job uses (an ephemeral stage uses Preview's).
  const stageName = (projectId: string, stageId: string): string => variableStage(stageId ? store.getStage(stageId) : store.productionStage(projectId));

  function drain(projectId: string): void {
    if (active.has(projectId)) return;
    const next = store.nextQueuedJob(projectId);
    if (!next) return;
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
    active.set(projectId, done);
    void done.finally(() => {
      active.delete(projectId);
      try {
        drain(projectId);
      } catch {
        // store closed (process shutting down) — nothing to drain
      }
    });
  }

  return {
    enqueue(projectId: string, revision: string, opts?: { manual?: boolean; stageId?: string; values?: Record<string, string> }): Build {
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
      drain(projectId);
      return store.getBuild(build.id);
    },

    enqueuePromote(projectId: string, buildId: string, environmentId: string, opts?: { values?: Record<string, string> }): Build {
      let source = store.getBuild(buildId);
      if (source.kind === "promote") source = store.getBuild(source.sourceBuildId);
      if (source.projectId !== projectId) throw new ErrInvalidEnvironmentConfig("this build belongs to another project");
      const env = store.getEnvironment(environmentId);
      if (env.projectId !== projectId) throw new ErrInvalidEnvironmentConfig("that environment belongs to another project");
      if (env.archived) throw new ErrInvalidEnvironmentConfig(`${env.name} is archived`);
      // Any build whose output is stored qualifies (also one whose own
      // deploy failed somewhere: its .nbo/ was complete).
      if (!source.artifact) throw new ErrInvalidEnvironmentConfig(cleanedUp);
      // The target cloud's stage decides which values are needed (names
      // only: all its declared names; stored: none may be sent).
      if (namesOnly() || opts?.values !== undefined) store.resolveEnv(projectId, stageName(projectId, env.stageId), opts?.values);
      const job = store.createQueuedPromote(projectId, source.id, env.id);
      if (namesOnly() && opts?.values !== undefined) supplied.put(job.id, opts.values);
      drain(projectId);
      return store.getBuild(job.id);
    },

    async idle(projectId: string): Promise<void> {
      for (;;) {
        const current = active.get(projectId);
        if (!current) return;
        await current.catch(() => {});
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
        store.completeBuild(b.id, "failed", b.deploymentIds, "interrupted: the control-plane restarted during this build");
        interrupted.push(b.id);
      }
    }
  }
  return interrupted;
}
