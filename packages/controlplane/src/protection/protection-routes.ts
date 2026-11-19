// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Store } from "../store/store.js";
import type { Router } from "../http/router.js";
import type { V2 } from "../v2.js";
import { errorMessage, isRecord, writeJSON, writeError } from "../http/handlers.js";
import { fail, readJSON } from "../http/v2-route-util.js";
import { liveBuild } from "../builds/artifacts.js";
import { affectedStages, hashPassword, PROTECTION_MODES, type ProtectionMode } from "./protection.js";

// GET (Tier 0) answers the mode and whether a password is set, never the hash. PUT (Tier 2, the password
// sealed in the browser and opened by the link dispatcher) sets them.

const view = (store: Store, projectId: string) => {
  const p = store.getProtection(projectId);
  return { mode: p.mode, passwordSet: p.hash !== "" };
};

interface Redeploys {
  redeploying: { environmentId: string; buildId: string }[];
  notRedeployed: { environmentId: string; reason: string }[];
}

// redeploy queues a promote (no rebuild) of the live build on every cloud of the given stages, so the
// change reaches visitors within about a minute. A cloud with a build already queued or running for it is
// left to that build: its deploy reads the new setting, and a promote queued after it would put the older
// build back. It never fails the save: a cloud it cannot redeploy is listed with the reason, and takes the
// setting with its next deploy.
function redeploy(store: Store, v2: V2, projectId: string, stageIds: string[], productionId: string): Redeploys {
  const out: Redeploys = { redeploying: [], notRedeployed: [] };
  const pending = store.listBuilds(projectId).filter((b) => b.status === "queued" || b.status === "running");
  for (const stageId of stageIds) {
    const envs = store.listEnvironments(projectId, stageId === productionId ? undefined : { stageId });
    for (const env of envs) {
      const coming = pending.find((b) =>
        b.kind === "promote" ? b.targetEnvironmentId === env.id : (b.stageId || productionId) === stageId,
      );
      if (coming) {
        out.redeploying.push({ environmentId: env.id, buildId: coming.id });
        continue;
      }
      const live = liveBuild(store, env);
      if (!live) {
        out.notRedeployed.push({ environmentId: env.id, reason: "nothing is deployed there yet" });
        continue;
      }
      try {
        const job = v2.queue.enqueuePromote(projectId, live.id, env.id);
        out.redeploying.push({ environmentId: env.id, buildId: job.id });
      } catch (err) {
        out.notRedeployed.push({ environmentId: env.id, reason: errorMessage(err) });
      }
    }
  }
  return out;
}

export function registerProtectionRoutes(router: Router, store: Store, v2: V2): void {
  router.handle("GET", "/projects/{projectID}/protection", async (_request, params) => {
    try {
      store.getProject(params.projectID!);
      return writeJSON(view(store, params.projectID!), 200);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("PUT", "/projects/{projectID}/protection", async (request, params) => {
    try {
      const projectId = params.projectID!;
      store.getProject(projectId);
      const body = await readJSON(request);
      if (!isRecord(body) || !PROTECTION_MODES.includes(body.mode as ProtectionMode))
        return writeError(400, 'mode must be "off", "previews" or "all"');
      const mode = body.mode as ProtectionMode;
      if (
        body.password !== undefined &&
        (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 256)
      )
        return writeError(400, "the password must be 8 to 256 characters");
      const before = store.getProtection(projectId);
      const hash = typeof body.password === "string" ? await hashPassword(body.password) : before.hash;
      if (mode !== "off" && hash === "") return writeError(400, "a password is needed to turn protection on");
      store.setProtection(projectId, mode, hash);
      const stages = affectedStages(before, { mode, hash }, store.listStages(projectId, { includeEphemeral: true }));
      const redeploys = redeploy(
        store,
        v2,
        projectId,
        stages.map((s) => s.id),
        store.productionStage(projectId).id,
      );
      return writeJSON({ ...view(store, projectId), ...redeploys }, 200);
    } catch (err) {
      return fail(err);
    }
  });
}
