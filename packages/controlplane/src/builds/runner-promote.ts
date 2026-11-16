// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// A promote job: deploy a stored build's output to one cloud, with no clone and no build.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "@nbo/validate";
import { contentId } from "@nbo/digest";
import { holdCliDeployDir } from "@nbo/deploy";
import { redactionsFor } from "../variables/env-vars.js";
import type { Build } from "../git/git.js";
import { variableStage } from "../stages/stages.js";
import { buildInput } from "./build-details.js";
import type { Job } from "./runner-job.js";
import type { DeployTo, Outcome } from "./runner-deploy.js";
import { errMessage, firstLine, stageOf } from "./runner-helpers.js";

const promoteDamaged =
  "This build's stored output is damaged: rebuild it (works only while its commit is still on a branch)";
const promoteCleanedUp =
  "This build's stored output was cleaned up: rebuild it to deploy it (works only while its commit is still on a branch)";

// Promote = deploy a stored build's output without cloning or building again.
export function createPromoter(ctx: Job, deployTo: DeployTo) {
  const { store, options, supplied, namesOnly, state, scrub, log, timedPhase } = ctx;
  // runPromote deploys a stored build's .nbo/ (job.sourceBuildId) to
  // one environment: no clone, no build. The stored copy is held
  // against retention for the whole job, checked with @nbo/validate
  // and against the build's recorded content id, then deployed with
  // the current variables of the target cloud's stage (a staging build
  // promoted to a Production cloud runs with Production's values).
  const runPromote = async (job: Build): Promise<void> => {
    const source = store.getBuild(job.sourceBuildId);
    const env = store.getEnvironment(job.targetEnvironmentId);
    const resolvedEnv = store.resolveEnv(
      job.projectId,
      variableStage(stageOf(store, env.projectId, env.stageId)),
      supplied,
    );
    const fingerprint = store.envFingerprintFor(resolvedEnv);
    state.secretValues = redactionsFor(resolvedEnv, namesOnly());
    try {
      store.setBuildDetails(job.id, {
        input: buildInput(store.getGitConfig(job.projectId), true, resolvedEnv, fingerprint),
      });
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
          if (actual !== source.contentId)
            throw new Error(`content id ${actual} differs from the recorded ${source.contentId || "(none)"}`);
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
  return runPromote;
}
