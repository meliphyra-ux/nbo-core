// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { ErrConflict } from "../store/errors.js";
import { ErrNotFound, type SetupStatus, type Store } from "../store/store.js";
import type { BuildTrigger } from "./webhooks.js";
import type { EdgeSync } from "../edge/edge-sync.js";
import { lsRemoteHeads as realLsRemoteHeads, type GitRemoteOptions } from "./gitremote.js";
import { withGitAuth, type GitAuthFn } from "./git-credentials.js";
import { lostAccessMessage } from "./github-legacy.js";
import type { Setup } from "../deploys/setup.js";

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
  // poller: the shared per-project poller (V2.poller); pollOnce makes its own without one.
  poller?: ProjectPoller;
  // setup: finishes projects waiting for a deploy key (V2.setup).
  setup?: Pick<Setup, "checkKey">;
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

function branchHead(
  heads: Map<string, string>,
  projectName: string,
  key: string,
  label: string,
  branch: string,
): string | undefined {
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

export interface QueuedBuild {
  buildId: string;
  stageId: string;
  stageName: string;
  revision: string;
}

export interface PollResult {
  queued: QueuedBuild[];
  setupStatus: SetupStatus;
  note?: string;
}

// HeadsUnreadable: the repository's branch heads could not be read; the
// message is git's first line.
export class HeadsUnreadable extends Error {}

export interface ProjectPoller {
  // pollProject checks one project's branch heads now and queues a build for
  // every head it hasn't seen. opts.nudge: a person or a link asked for it
  // (the loop doesn't set it).
  pollProject(projectId: string, opts?: { nudge?: boolean }): Promise<PollResult>;
}

// createProjectPoller makes the one poller the loop and the route share.
// Per project at most one run is in flight; a caller arriving during a run
// waits for it and then joins one more run (shared by every caller that
// arrived meanwhile), because the running one may have read heads before the
// push it was asked about.
export function createProjectPoller(deps: PollDeps): ProjectPoller {
  const setup = deps.setup;
  const lsRemoteHeads =
    deps.lsRemoteHeads ?? ((repo: string, opts?: GitRemoteOptions) => realLsRemoteHeads(repo, opts));
  const noop = () => {};

  async function run(projectId: string, opts?: { nudge?: boolean }): Promise<PollResult> {
    const project = deps.store.getProject(projectId);
    if (project.setupStatus === "provisioning") throw new ErrConflict("setup is still provisioning");
    if (project.setupStatus === "needs-setup") return { queued: [], setupStatus: "needs-setup" };
    if (project.setupStatus === "waiting-for-key") {
      // Only a person or a link nudging forces a read; the loop is throttled.
      const out = setup
        ? await setup.checkKey(projectId, { force: opts?.nudge === true })
        : { setupStatus: project.setupStatus, queued: null };
      return {
        queued: out.queued
          ? [
              {
                buildId: out.queued.id,
                stageId: out.queued.stageId,
                stageName: "production",
                revision: out.queued.revision,
              },
            ]
          : [],
        setupStatus: out.setupStatus,
      };
    }
    if (!project.pollingEnabled)
      return { queued: [], setupStatus: project.setupStatus, note: "deploying automatically is off for this project" };
    const git = deps.store.getGitConfig(project.id);
    const queued: QueuedBuild[] = [];
    let heads: Map<string, string>;
    // The time kept with a head the poll moves (advanceHead's opts.at).
    const readAt = (deps.now ?? Date.now)();
    try {
      heads = await withGitAuth(deps.gitAuth, project.id, git, (env) =>
        lsRemoteHeads(git.repo, env ? { env } : undefined),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HeadsUnreadable(message.split("\n")[0]?.trim() ?? message);
    }
    const head = branchHead(heads, project.name, `${project.id}/production`, "production", git.productionBranch);
    // advanceHead is a compare-and-set from the head read before ls-remote,
    // so a push event (or another poll) that got there first builds it once.
    if (
      head !== undefined &&
      head !== project.lastSeenSha &&
      deps.store.advanceHead(project.id, head, undefined, project.lastSeenSha, { at: readAt })
    ) {
      const build = deps.queue.enqueue(project.id, head);
      queued.push({ buildId: build.id, stageId: build.stageId, stageName: "production", revision: head });
    }
    const stages = deps.store.listStages(project.id, { includeEphemeral: true });
    const customBranches = new Set(stages.filter((s) => s.kind === "custom").map((s) => s.branch));
    for (const stage of stages) {
      // A stage on the production branch (nothing should allow it, but an
      // older row might) never builds as well: Production does. A custom
      // environment's branch builds only it, as a push does (stageForBranch).
      const builds =
        stage.kind === "custom" ||
        (stage.kind === "ephemeral" && stage.removal === "" && !customBranches.has(stage.branch));
      if (!builds || stage.branch === "" || !stage.autoDeploy || stage.branch === git.productionBranch) continue;
      const stageHead = branchHead(heads, project.name, `${project.id}/${stage.id}`, stage.name, stage.branch);
      if (stageHead === undefined || stageHead === stage.lastSeenSha) continue;
      if (!deps.store.advanceHead(project.id, stageHead, stage.id, stage.lastSeenSha, { at: readAt })) continue;
      const build = deps.queue.enqueue(project.id, stageHead, { stageId: stage.id });
      queued.push({ buildId: build.id, stageId: stage.id, stageName: stage.name, revision: stageHead });
    }
    return { queued, setupStatus: project.setupStatus };
  }

  interface Slot {
    running: Promise<PollResult>;
    next?: Promise<PollResult>;
  }
  const slots = new Map<string, Slot>();

  function start(projectId: string, opts?: { nudge?: boolean }): Promise<PollResult> {
    const running = run(projectId, opts);
    const slot: Slot = { running };
    slots.set(projectId, slot);
    const done = () => {
      if (slots.get(projectId) === slot && !slot.next) slots.delete(projectId);
    };
    running.then(done, done);
    return running;
  }

  return {
    pollProject(projectId, opts) {
      const slot = slots.get(projectId);
      if (!slot) return start(projectId, opts);
      if (!slot.next) slot.next = slot.running.then(noop, noop).then(() => start(projectId, opts));
      return slot.next;
    },
  };
}

// pollOnce builds every commit it hasn't seen before on each ready,
// polling-enabled project's production branch and on the branch of each
// custom or ephemeral environment that deploys automatically (an ephemeral
// one only until its removal starts) — never retrying a failed
// head (lastSeenSha already holds it) — and reads the repository of each
// project waiting for its deploy key (polling on or off, so its wait can
// end) — then re-pushes any split the edge
// has lost.
export async function pollOnce(deps: PollDeps): Promise<void> {
  const poller = deps.poller ?? createProjectPoller(deps);
  for (const project of deps.store.listProjects()) {
    // A project waiting for its deploy key is read (and times out) whether or not it deploys automatically.
    if (project.setupStatus !== "waiting-for-key" && (!project.pollingEnabled || project.setupStatus !== "ready"))
      continue;
    try {
      await poller.pollProject(project.id);
    } catch (err) {
      // A project created through the pre-v2 API has no repo to poll.
      if (err instanceof ErrNotFound) continue;
      const message = err instanceof Error ? err.message : String(err);
      const git = deps.store.getGitConfig(project.id);
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
