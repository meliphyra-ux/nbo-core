// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { cp, rename, rm } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Deployment, Environment, Store } from "../store/store.js";
import type { Build } from "../git/git.js";

// The artifact store keeps a copy of each build's .nbo/ at
// <dir>/<buildId>/ (.nbo/ holds no secret values by design). A copy is
// written to <buildId>.tmp and renamed into place, so a crash never
// leaves a half copy that looks complete.
export interface ArtifactStore {
  save(buildId: string, nboDir: string): Promise<void>;
  // path is the stored copy's directory, or null when there is none.
  path(buildId: string): string | null;
  remove(buildId: string): Promise<void>;
  // prune removes the stored copies of the project's builds that keep()
  // rejects and returns their build ids.
  // prune never removes a held build.
  prune(projectId: string, keep: (buildId: string) => boolean): Promise<string[]>;
  // hold keeps buildId's copy out of prune until the returned release
  // function runs (a promote holds the build it deploys). Holds count:
  // two holds need two releases; releasing twice is harmless.
  hold(buildId: string): () => void;
}

// How many successful builds per project keep their output (on top of
// every build that is live on an environment).
export const defaultKeepBuilds = 20;

// resolveArtifactsDir: NBO_ARTIFACTS_DIR, else artifacts/ next to the database.
export function resolveArtifactsDir(env: Record<string, string | undefined>, dbPath: string): string {
  return env.NBO_ARTIFACTS_DIR || join(dirname(dbPath), "artifacts");
}

const plainId = /^[A-Za-z0-9_-]+$/;

function checkId(buildId: string): void {
  if (!plainId.test(buildId)) throw new Error(`invalid build id "${buildId}"`);
}

// createArtifactStore: buildIdsOf lists a project's build ids (prune
// only touches those).
export function createArtifactStore(relOrAbsDir: string, buildIdsOf: (projectId: string) => string[]): ArtifactStore {
  const dir = resolve(relOrAbsDir); // absolute once, whatever the cwd does later
  const final = (id: string) => join(dir, id);
  const holds = new Map<string, number>();
  return {
    async save(buildId, nboDir) {
      checkId(buildId);
      const tmp = `${final(buildId)}.tmp`;
      await rm(tmp, { recursive: true, force: true });
      await cp(nboDir, tmp, { recursive: true });
      await rm(final(buildId), { recursive: true, force: true });
      await rename(tmp, final(buildId));
    },
    path(buildId) {
      if (!plainId.test(buildId)) return null;
      return existsSync(final(buildId)) ? final(buildId) : null;
    },
    async remove(buildId) {
      checkId(buildId);
      await rm(final(buildId), { recursive: true, force: true });
      await rm(`${final(buildId)}.tmp`, { recursive: true, force: true });
    },
    async prune(projectId, keep) {
      const removed: string[] = [];
      for (const id of buildIdsOf(projectId)) {
        if (keep(id) || holds.has(id) || !plainId.test(id)) continue;
        const present = existsSync(final(id)) || existsSync(`${final(id)}.tmp`);
        if (!present) continue;
        await this.remove(id);
        removed.push(id);
      }
      return removed;
    },
    hold(buildId) {
      holds.set(buildId, (holds.get(buildId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (holds.get(buildId) ?? 1) - 1;
        if (n <= 0) holds.delete(buildId);
        else holds.set(buildId, n);
      };
    },
  };
}

// removeArtifactsSync deletes the stored copies of the given builds
// (project delete, which is synchronous).
export function removeArtifactsSync(dir: string, buildIds: string[]): void {
  for (const id of buildIds) {
    if (!plainId.test(id)) continue;
    rmSync(join(dir, id), { recursive: true, force: true });
    rmSync(join(dir, `${id}.tmp`), { recursive: true, force: true });
  }
}

// liveDeployment is an environment's latest succeeded deployment (what
// it serves), or null.
export function liveDeployment(store: Store, env: Environment): Deployment | null {
  const succeeded = store.listDeployments(env.id).filter((d) => d.status === "succeeded");
  return succeeded[succeeded.length - 1] ?? null;
}

// liveBuild is the build an environment runs: the one behind its latest
// succeeded deployment, found by the deployment's build id, else (older
// rows) the build that lists that deployment, else the newest build
// with the same content id (preferring one whose output is kept). null
// when nothing has deployed there or no build matches.
export function liveBuild(
  store: Store,
  env: Environment,
  builds: Build[] = store.listBuilds(env.projectId),
): Build | null {
  const dep = liveDeployment(store, env);
  if (!dep) return null;
  if (dep.buildId) return builds.find((b) => b.id === dep.buildId) ?? null;
  const listed = builds.find((b) => b.deploymentIds.includes(dep.id));
  if (listed) return listed;
  if (!dep.contentId) return null;
  // Only commit builds: a promote job carries its source's content id.
  const same = builds.filter((b) => b.kind === "build" && b.contentId === dep.contentId).reverse();
  return same.find((b) => b.artifact) ?? same[0] ?? null;
}

// retainedBuildIds is the retention rule: the newest `newest` succeeded
// builds that have stored output, plus every build live on one of the
// project's (non-archived) environments of every stage (see liveBuild), plus the
// source of every promote still queued or running (the in-memory hold
// only starts once a promote runs; a queued one must not lose its
// build to the build ahead of it).
export function retainedBuildIds(store: Store, projectId: string, newest = defaultKeepBuilds): Set<string> {
  const builds = store.listBuilds(projectId); // oldest first
  const keep = new Set<string>();
  // Ephemeral stages' builds don't count toward the newest kept ones
  // (a burst of branch pushes must not push Production's out); a running
  // ephemeral stage keeps its live build through the loop below.
  const ephemeralStages = new Set(
    store
      .listStages(projectId, { includeEphemeral: true })
      .filter((s) => s.kind === "ephemeral")
      .map((s) => s.id),
  );
  const withOutput = builds.filter((b) => b.status === "succeeded" && b.artifact && !ephemeralStages.has(b.stageId));
  for (const b of withOutput.slice(Math.max(0, withOutput.length - newest))) keep.add(b.id);
  for (const env of store.listEnvironments(projectId, { allStages: true })) {
    const live = liveBuild(store, env, builds);
    if (live) keep.add(live.id);
  }
  for (const b of builds) {
    if (b.kind === "promote" && (b.status === "queued" || b.status === "running") && b.sourceBuildId)
      keep.add(b.sourceBuildId);
  }
  return keep;
}
