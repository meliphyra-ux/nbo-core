// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  ErrDuplicateName,
  ErrInvalidEnvironmentConfig,
  ErrNotFound,
  type Store,
  type Transfer,
} from "../store/store.js";
import type { BuildQueue } from "../builds/build-queue.js";
import type { EdgeSync } from "../edge/edge-sync.js";
import { parseCloudChoice, type CloudChoice, type Setup } from "./setup.js";
import { liveBuild } from "../builds/artifacts.js";
import { ErrConflict } from "../store/errors.js";
import { cannotTakeTrafficReason, clusterTrafficReason } from "../edge/edge-table.js";
import type { Mode } from "../mode.js";
import type { SuppliedValues } from "../variables/supplied-values.js";

// transferConfig is mutable so tests can shrink the wait between
// shift steps; 20s gives the operator time to watch each step and
// stop it before the next.
export const transferConfig = { stepDelayMs: 20_000 };

// The Slice 3 switch sequence: share of traffic on the new side.
const shiftSteps = [1, 10, 50, 100];

export interface Transfers {
  // opts.stage: the environment to move (Production only; another one is refused, 409).
  // opts.values: Production's variable values when NBO keeps names only;
  // held in memory until the promote job is queued.
  start(projectId: string, cloud: CloudChoice, opts?: { stage?: string; values?: Record<string, string> }): Transfer;
  cancel(projectId: string): Transfer;
  settled(projectId: string): Promise<void>;
}

// shareRest splits rest (an integer) among the environments of base in
// proportion to their weights, as integers summing to rest (largest
// remainder; ties go to the earlier environment).
export function shareRest(base: [string, number][], rest: number): Record<string, number> {
  const total = base.reduce((a, [, w]) => a + w, 0);
  const out: Record<string, number> = {};
  if (base.length === 0) return out;
  const exact = base.map(([id, w]) => [id, total > 0 ? (rest * w) / total : rest / base.length] as const);
  let left = rest;
  for (const [id, x] of exact) {
    out[id] = Math.floor(x);
    left -= out[id];
  }
  const byRemainder = exact
    .map(([id, x], i) => ({ id, r: x - Math.floor(x), i }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < left; k++) out[byRemainder[k % byRemainder.length]!.id]! += 1;
  return out;
}

function setCrons(store: Store, envId: string, enabled: boolean): void {
  const env = store.getEnvironment(envId);
  const cfg = JSON.parse(env.config) as Record<string, unknown>;
  store.updateEnvironmentConfig(envId, JSON.stringify({ ...cfg, cronsEnabled: enabled }));
}

// createTransfers moves a project onto another cloud (Cloud Run or any
// connected cluster, including from one cluster to another), taking
// traffic off every other environment:
// provision it, deploy the build live on the source cloud there (a
// promote of its stored .nbo/ — no rebuild, the new side only), then
// shift traffic in steps, each applied to the edge before the next. It
// never removes the old side.
export function createTransfers(deps: {
  store: Store;
  setup: Setup;
  queue: BuildQueue;
  edgeSync: EdgeSync;
  mode?: Mode;
  supplied: SuppliedValues;
}): Transfers {
  const { store, setup, queue, edgeSync, mode } = deps;
  const supplied = deps.supplied;
  const inFlight = new Map<string, Promise<void>>();

  const cancelled = (id: string) => store.getTransfer(id).status === "cancelled";
  // The wait between steps ends early when the transfer is cancelled, so
  // a stopped transfer finishes now rather than after the step delay.
  const wakers = new Map<string, () => void>();
  const pause = (id: string, ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wakers.delete(id);
        resolve();
      }
      wakers.set(id, done);
    });

  async function execute(transfer: Transfer, cloud: CloudChoice): Promise<void> {
    const id = transfer.id;
    // Traffic moves off every other live environment, each keeping its
    // share of the rest as it stood when the transfer started. If none had
    // traffic, the source takes the rest.
    let start: [string, number][] = store.listEnvironments(transfer.projectId).map((e) => [e.id, e.trafficWeight]);
    if (start.every(([, w]) => w === 0)) start = [[transfer.fromEnvId, 100]];
    try {
      const env = await setup.addCloud(transfer.projectId, cloud);
      store.updateTransfer(id, { toEnvId: env.id });
      // The new cloud takes over the source cloud's choice about new
      // commits, so a cloud pinned to a build stays pinned after a move.
      store.setEnvironmentAutoDeploy(env.id, store.getEnvironment(transfer.fromEnvId).autoDeploy);
      if (cancelled(id)) return;
      store.updateTransfer(id, { status: "building" });

      // Let any build already running or queued finish first, so the
      // source cloud's live build is the newest it will run; then deploy
      // that build's stored output to the new side.
      await queue.idle(transfer.projectId);
      const from = store.getEnvironment(transfer.fromEnvId);
      const live = liveBuild(store, from);
      if (!live) throw new Error(`${from.name} has no live build to transfer`);
      if (!live.artifact)
        throw new Error(`the build live on ${from.name} has no stored output — redeploy it, then transfer`);
      // The request's values go to the promote job and leave the transfer.
      const values = supplied.take(id);
      const job = queue.enqueuePromote(
        transfer.projectId,
        live.id,
        env.id,
        values === undefined ? undefined : { values },
      );
      await queue.idle(transfer.projectId);
      const done = store.getBuild(job.id);
      if (done.status !== "succeeded") {
        throw new Error(done.error || `deploying build ${done.revision.slice(0, 7)} to ${env.name} did not succeed`);
      }
      if (cancelled(id)) return;

      store.updateTransfer(id, { status: "shifting" });
      for (const w of shiftSteps) {
        if (cancelled(id)) return;
        // The edge must be able to reach the target before it gets more
        // traffic (its relay can go away mid-transfer); the split stays at
        // the last step the edge took.
        const reason = cannotTakeTrafficReason(store, mode, store.getEnvironment(env.id));
        if (reason) throw new Error(`${env.name} can't take traffic: ${reason}`);
        const live = store.listEnvironments(transfer.projectId);
        const liveIds = new Set(live.map((e) => e.id));
        const before = Object.fromEntries(live.map((e) => [e.id, e.trafficWeight]));
        const others = start.filter(([envId]) => envId !== env.id && liveIds.has(envId));
        store.setTrafficWeights(transfer.projectId, { ...shareRest(others, 100 - w), [env.id]: w });
        try {
          await edgeSync.push(transfer.projectId);
        } catch (err) {
          // The edge didn't take this step: keep the stored split at the
          // last step it did accept, or the next reconcile would move
          // traffic after the transfer reported failure.
          store.setTrafficWeights(transfer.projectId, before);
          throw err;
        }
        store.updateTransfer(id, { weight: w });
        if (w < 100 && !cancelled(id)) await pause(id, transferConfig.stepDelayMs);
      }
      // Crons run in exactly one environment: now the target.
      for (const e of store.listEnvironments(transfer.projectId, { includeArchived: true }))
        setCrons(store, e.id, e.id === env.id);
      store.updateTransfer(id, { status: "done" });
    } catch (err) {
      try {
        if (!cancelled(id))
          store.updateTransfer(id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
      } catch {
        // store closed
      }
    } finally {
      // Cancelled or failed before the promote job: the values go too.
      supplied.drop(id);
    }
  }

  return {
    start(projectId, rawCloud, opts) {
      const cloud = parseCloudChoice(rawCloud);
      store.getProject(projectId);
      if (opts?.stage !== undefined && opts.stage !== "production") {
        const stage = store.getStageByName(projectId, opts.stage);
        throw new ErrConflict(
          `Transfers move Production only. To move the ${stage.name} environment, add the cloud to it and set its split.`,
        );
      }
      if (store.getActiveTransfer(projectId))
        throw new ErrDuplicateName("a transfer is already in progress for this project");
      const envs = store.listEnvironments(projectId);
      // One environment per cloud: Cloud Run once, each cluster once.
      const already = setup.existingEnvironmentFor(projectId, cloud);
      if (already) throw new ErrDuplicateName(`this project already runs there (${already.name})`);
      // A cluster the edge can't reach would end the transfer with the
      // project on no routable cloud (spec A4).
      if (cloud.target === "kubernetes") {
        const clusters = store.listKubernetesConnections();
        const cluster =
          cloud.clusterId !== undefined
            ? clusters.find((c) => c.id === cloud.clusterId)
            : clusters.length === 1
              ? clusters[0]
              : undefined;
        const reason = cluster ? clusterTrafficReason(store, mode, cluster.id) : null;
        if (reason) throw new ErrConflict(`${cluster!.name} can't take traffic: ${reason}`);
      }
      const from = [...envs].sort((a, b) => b.trafficWeight - a.trafficWeight)[0];
      if (!from) throw new ErrInvalidEnvironmentConfig("this project has no environment to transfer from");
      const live = liveBuild(store, from);
      if (!live) throw new ErrInvalidEnvironmentConfig("deploy successfully once before transferring");
      if (!live.artifact)
        throw new ErrInvalidEnvironmentConfig(
          `the build live on ${from.name} has no stored output — redeploy it, then transfer`,
        );
      // Names only: every declared Production name needs a value now, not
      // when the promote job is queued later. Stored: none may come.
      const namesOnly = store.getServerSettings().envValues === "none";
      if (namesOnly || opts?.values !== undefined) store.resolveEnv(projectId, "production", opts?.values);

      const transfer = store.createTransfer(projectId, from.id, "");
      if (namesOnly && opts?.values !== undefined) supplied.put(transfer.id, opts.values);
      const run = execute(transfer, cloud);
      inFlight.set(projectId, run);
      void run.finally(() => {
        if (inFlight.get(projectId) === run) inFlight.delete(projectId);
      });
      return transfer;
    },

    cancel(projectId) {
      const active = store.getActiveTransfer(projectId);
      if (!active) throw new ErrNotFound("no transfer in progress for this project");
      const stopped = store.updateTransfer(active.id, { status: "cancelled" });
      wakers.get(active.id)?.();
      return stopped;
    },

    async settled(projectId) {
      await inFlight.get(projectId);
    },
  };
}
