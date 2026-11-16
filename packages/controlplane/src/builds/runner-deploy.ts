// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Deploying one build's output to a cloud, and to every cloud of its stage at once.
import { holdCliDeployDir, formatSeconds } from "@nbo/deploy";
import type { Environment } from "../store/store.js";
import type { ResolvedEnv } from "../variables/env-vars.js";
import type { DeploymentTrigger } from "../http/handlers.js";
import { parseSubStep, type TimelineEntry } from "./build-details.js";
import { liveBuild } from "./artifacts.js";
import type { Job } from "./runner-job.js";
import { errMessage, firstLine } from "./runner-helpers.js";

export type Outcome = { deploymentId?: string; failure?: string; succeeded?: boolean };
export type Snapshot = { env: ResolvedEnv; fingerprint: string | null };

// Built per job so each deploy reports into that job's own log, timeline and edge sync.
export function createDeployTo(ctx: Job, trigger: DeploymentTrigger) {
  const { store, options, log, timeline, phases, stamp, now, state } = ctx;
  // deployTo deploys nboDir (the output of build deployedBuildId) to
  // one environment, timing it on the timeline and in the log, and
  // runs onSuccess (edge sync) once the deploy succeeded.
  const deployTo = async (
    env: Environment,
    nboDir: string,
    snapshot: Snapshot,
    deployedBuildId: string,
    onSuccess: () => Promise<void>,
  ): Promise<Outcome> => {
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
        log(
          carryFrom
            ? `Keeping the files of build ${previous.revision.slice(0, 7)} during the rollout\n`
            : "No previous build output to keep\n",
        );
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
        redact: state.secretValues,
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
  return deployTo;
}

export type DeployTo = ReturnType<typeof createDeployTo>;

// deployEverywhere deploys nboDir to every cloud of the stage that takes new commits, then completes the build.
export async function deployEverywhere(
  ctx: Job,
  deployTo: DeployTo,
  b: {
    projectId: string;
    allEnvs: Environment[];
    envs: Environment[];
    nboDir: string;
    resolvedEnv: ResolvedEnv;
    fingerprint: string | null;
  },
): Promise<void> {
  const { store, options, buildId, log, scrub } = ctx;
  const { projectId, allEnvs, envs, nboDir, resolvedEnv, fingerprint } = b;
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
    deployTo(env, nboDir, { env: resolvedEnv, fingerprint }, buildId, () =>
      firstDeploy ? Promise.resolve() : updateEdge(env.name, env.id),
    );
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
    const outcome: Outcome =
      r.status === "fulfilled" ? r.value : { failure: `${envs[i]!.name}: ${errMessage(r.reason)}` };
    if (outcome.deploymentId) deploymentIds.push(outcome.deploymentId);
    if (outcome.failure) failures.push(outcome.failure);
  });
  if (failures.length === 0) {
    store.completeBuild(buildId, "succeeded", deploymentIds);
  } else {
    store.completeBuild(buildId, "failed", deploymentIds, scrub(failures.join("; ")));
  }
}
