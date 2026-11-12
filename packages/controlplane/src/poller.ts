// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { ErrNotFound, type Store } from "./store.js";
import type { BuildTrigger } from "./webhooks.js";
import type { EdgeSync } from "./edge-sync.js";
import { lsRemoteHeads as realLsRemoteHeads, type GitRemoteOptions } from "./gitremote.js";
import { withGitAuth, type GitAuthFn } from "./git-credentials.js";
import { lostAccessMessage } from "./github-legacy.js";

// pollerConfig is mutable so tests (and an operator) can change it.
// Public github.com/gitlab.com webhooks can't reach a loopback-only
// control-plane, so each project's production branch is polled.
export const pollerConfig = { intervalMs: 45_000 };

export interface PollDeps {
  store: Store;
  queue: BuildTrigger;
  edgeSync: EdgeSync;
  // lsRemoteHeads lists every branch head of a repo (one call per project per tick).
  lsRemoteHeads?: (repo: string, opts?: GitRemoteOptions) => Promise<Map<string, string>>;
  // gitAuth: each project's ls-remote carries its git credential.
  gitAuth?: GitAuthFn;
  // now: the clock for throttling repeated log lines (Date.now by default).
  now?: () => number;
}

// missingBranches remembers which branches were already reported as gone, so
// a branch that stays missing is logged once, not on every tick.
const missingBranches = new Set<string>();

// lostAccessLogged: when each linked project's "the app can't reach the repository"
// was last logged. GitHub access stays lost until someone acts, so the line
// is repeated at most once an hour per project, not on every tick.
const lostAccessLogged = new Map<string, number>();
const lostAccessLogEveryMs = 60 * 60_000;

// forgetPolledStage drops what the poller remembers about a deleted stage.
export function forgetPolledStage(projectId: string, stageId: string): void {
  missingBranches.delete(`${projectId}/${stageId}`);
}

function branchHead(heads: Map<string, string>, projectName: string, key: string, label: string, branch: string): string | undefined {
  const head = heads.get(branch);
  if (head === undefined) {
    if (!missingBranches.has(key)) {
      missingBranches.add(key);
      console.error(`control-plane: polling ${projectName}: branch "${branch}" (${label}) not found`);
    }
  } else {
    missingBranches.delete(key);
  }
  return head;
}

// pollOnce builds every commit it hasn't seen before on each ready,
// polling-enabled project's production branch and on the branch of each
// custom or ephemeral environment that deploys automatically (an ephemeral
// one only until its removal starts) — never retrying a failed
// head (lastSeenSha already holds it) — then re-pushes any split the edge
// has lost.
export async function pollOnce(deps: PollDeps): Promise<void> {
  const lsRemoteHeads = deps.lsRemoteHeads ?? ((repo: string, opts?: GitRemoteOptions) => realLsRemoteHeads(repo, opts));
  for (const project of deps.store.listProjects()) {
    if (!project.pollingEnabled || project.setupStatus !== "ready") continue;
    let git;
    try {
      git = deps.store.getGitConfig(project.id);
    } catch (err) {
      // A project created through the pre-v2 API has no repo to poll.
      if (!(err instanceof ErrNotFound)) console.error(`control-plane: polling ${project.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      // The time kept with a head the poll moves (advanceHead's opts.at).
      const readAt = (deps.now ?? Date.now)();
      const heads = await withGitAuth(deps.gitAuth, project.id, git, (env) => lsRemoteHeads(git.repo, env ? { env } : undefined));
      const head = branchHead(heads, project.name, `${project.id}/production`, "production", git.productionBranch);
      // advanceHead is a compare-and-set from the head read before ls-remote,
      // so a push event (or another poll) that got there first builds it once.
      if (head !== undefined && head !== project.lastSeenSha && deps.store.advanceHead(project.id, head, undefined, project.lastSeenSha, { at: readAt })) {
        deps.queue.enqueue(project.id, head);
      }
      const stages = deps.store.listStages(project.id, { includeEphemeral: true });
      const customBranches = new Set(stages.filter((s) => s.kind === "custom").map((s) => s.branch));
      for (const stage of stages) {
        // A stage on the production branch (nothing should allow it, but an
        // older row might) never builds as well: Production does. A custom
        // environment's branch builds only it, as a push does (stageForBranch).
        const builds = stage.kind === "custom" || (stage.kind === "ephemeral" && stage.removal === "" && !customBranches.has(stage.branch));
        if (!builds || stage.branch === "" || !stage.autoDeploy || stage.branch === git.productionBranch) continue;
        const stageHead = branchHead(heads, project.name, `${project.id}/${stage.id}`, stage.name, stage.branch);
        if (stageHead === undefined || stageHead === stage.lastSeenSha) continue;
        if (!deps.store.advanceHead(project.id, stageHead, stage.id, stage.lastSeenSha, { at: readAt })) continue;
        deps.queue.enqueue(project.id, stageHead, { stageId: stage.id });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (git.github && message === lostAccessMessage(git.github.fullName)) {
        const now = (deps.now ?? Date.now)();
        const last = lostAccessLogged.get(project.id);
        if (last !== undefined && now - last < lostAccessLogEveryMs) continue;
        lostAccessLogged.set(project.id, now);
      } else {
        lostAccessLogged.delete(project.id);
      }
      console.error(`control-plane: polling ${project.name} failed: ${message}`);
      continue;
    }
    lostAccessLogged.delete(project.id);
  }
  await deps.edgeSync.reconcile();
}

export async function runPoller(deps: PollDeps, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await pollOnce(deps);
    } catch (err) {
      console.error(`control-plane: poll tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise<void>((resolve) => {
      // Aborted during the tick: no wait, the loop ends.
      if (signal.aborted) return resolve();
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, pollerConfig.intervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
