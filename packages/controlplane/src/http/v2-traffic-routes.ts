// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// v2 routes for traffic: the split, adding a cloud, and transfers between clouds.
import { parseCloudChoice } from "../deploys/setup.js";
import { parseSuppliedValues } from "../variables/supplied-values.js";
import { ErrDuplicateName, ErrInvalidEnvironmentConfig, ErrNotFound, type Store } from "../store/store.js";
import type { Router } from "./router.js";
import { isRecord, writeJSON, writeError, errorMessage } from "./handlers.js";
import { domainUrlFor, stageUrlFor, type V2 } from "../v2.js";
import { cannotTakeTrafficReason } from "../edge/edge-table.js";
import { desiredTargetForStage } from "../edge/edge-sync.js";
import type { Stage } from "../stages/stages.js";
import { canTakeTraffic, environmentView } from "./project-summary.js";
import { fail, readJSON } from "./v2-route-util.js";

// trafficState is what the Traffic tab renders: the desired split (the
// control-plane's truth) plus whether the edge actually has it.
// A custom stage has its own host, clouds and split.
async function trafficState(store: Store, v2: V2, projectId: string, stage?: Stage) {
  const project = store.getProject(projectId);
  if (stage && stage.kind === "custom") {
    const desired = desiredTargetForStage(store, stage);
    return {
      host: stage.host,
      domainUrl: stageUrlFor(stage, { store, mode: v2.mode, edgePublicPort: v2.edgePublicPort }),
      backends: desired?.backends ?? [],
      environments: store
        .listEnvironments(projectId, { stageId: stage.id })
        .map((e) => ({ id: e.id, cannotTakeTrafficReason: cannotTakeTrafficReason(store, v2.mode, e) })),
      // Only this environment's route, so another one's change can't flag it.
      edgeInSync: desired ? await v2.edgeSync.inSync(projectId, stage.host) : false,
    };
  }
  const desired = v2.edgeSync.desiredTarget(projectId);
  return {
    host: project.edgeHost,
    domainUrl: domainUrlFor(project, { store, mode: v2.mode, edgePublicPort: v2.edgePublicPort }),
    backends: desired?.backends ?? [],
    environments: store
      .listEnvironments(projectId)
      .map((e) => ({ id: e.id, cannotTakeTrafficReason: cannotTakeTrafficReason(store, v2.mode, e) })),
    // Production's route only; a custom environment has its own flag.
    edgeInSync: desired ? await v2.edgeSync.inSync(projectId, desired.host) : false,
  };
}

// trafficStage: the stage a traffic request names (Production by default),
// or why it can't have a split.
function trafficStage(store: Store, projectId: string, name: unknown): Stage | string {
  if (name !== undefined && (typeof name !== "string" || name === "")) return "stage must be an environment name";
  const stage = store.getStageByName(projectId, (name as string | undefined) ?? "production");
  if (stage.kind !== "production" && stage.kind !== "custom")
    return `the ${stage.name} environment holds variables only and has no traffic`;
  return stage;
}

export function registerTrafficRoutes(router: Router, store: Store, v2: V2): void {
  router.handle("GET", "/projects/{projectID}/traffic", async (request, params) => {
    try {
      const stage = trafficStage(store, params.projectID!, new URL(request.url).searchParams.get("stage") ?? undefined);
      if (typeof stage === "string") return writeError(400, stage);
      return writeJSON(await trafficState(store, v2, params.projectID!, stage), 200);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("PUT", "/projects/{projectID}/traffic", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const body = await readJSON(request);
      if (!isRecord(body) || !isRecord(body.weights))
        return writeError(400, "weights must map environment ids to integer percentages");
      // stage: whose split this is (Production by default); weights may name only its clouds.
      const stage = trafficStage(store, projectId, body.stage);
      if (typeof stage === "string") return writeError(400, stage);
      const custom = stage.kind === "custom" ? stage : undefined;
      // Transfers move Production only.
      if (!custom && store.getActiveTransfer(projectId))
        return writeError(409, "a transfer is moving traffic right now — stop it before setting a split by hand");
      const envs = new Map(
        store.listEnvironments(projectId, custom ? { stageId: custom.id } : undefined).map((e) => [e.id, e]),
      );
      const weights: Record<string, number> = {};
      for (const [envId, w] of Object.entries(body.weights)) {
        const env = envs.get(envId);
        if (!env) return writeError(400, `environment "${envId}" is not a live environment of this project`);
        if (typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 100)
          return writeError(400, "each weight must be an integer from 0 to 100");
        if (w > 0 && !canTakeTraffic(store.listDeployments(envId))) {
          return writeError(400, `${env.name} has no successful deployment yet, so it can't take traffic`);
        }
        // Raising a weight the edge can't route is refused; keeping (or
        // lowering) the current one is not, so the split can still change.
        const reason = w > env.trafficWeight ? cannotTakeTrafficReason(store, v2.mode, env) : null;
        if (reason) return writeError(400, `${env.name} can't take traffic: ${reason}`);
        weights[envId] = w;
      }
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      if (total <= 0) return writeError(400, "at least one environment needs a positive weight");
      store.setTrafficWeights(projectId, weights, custom?.id);
      try {
        // A custom stage's split must reach the edge too, not only be logged.
        await v2.edgeSync.push(projectId, custom ? { stageHost: custom.host } : undefined);
      } catch (err) {
        return writeError(502, `saved, but the edge did not accept the split: ${errorMessage(err)}`);
      }
      return writeJSON(await trafficState(store, v2, projectId, stage), 200);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/environments/add", async (request, params) => {
    try {
      const body = await readJSON(request);
      const cloud = parseCloudChoice(body);
      // stage: which environment gets the cloud (Production by default).
      const stageName = isRecord(body) && body.stage !== undefined ? body.stage : "production";
      if (typeof stageName !== "string" || stageName === "")
        throw new ErrInvalidEnvironmentConfig("stage must be an environment name");
      const stage = store.getStageByName(params.projectID!, stageName);
      // An ephemeral stage runs on the one cloud it was made with.
      if (stage.kind === "ephemeral")
        throw new ErrInvalidEnvironmentConfig(
          `${stage.name} is an ephemeral environment, which runs on one cloud only`,
        );
      const env = await v2.setup.addCloud(
        params.projectID!,
        cloud,
        stage.kind === "production" ? undefined : { stageId: stage.id },
      );
      if (stage.kind !== "production") {
        // As a transfer does: a cluster with no public entry would be accepted and never routed.
        const reason = cannotTakeTrafficReason(store, v2.mode, env);
        if (reason) {
          store.archiveEnvironment(env.id);
          return writeError(409, `${reason} The ${stage.name} environment can't use it until then.`);
        }
      }
      return writeJSON(environmentView(store, v2.mode, env), 201);
    } catch (err) {
      if (err instanceof ErrDuplicateName) return writeError(409, err.message);
      if (err instanceof ErrInvalidEnvironmentConfig || err instanceof ErrNotFound) return fail(err);
      return writeError(502, errorMessage(err));
    }
  });

  router.handle("POST", "/projects/{projectID}/transfer", async (request, params) => {
    try {
      const body = await readJSON(request);
      const stage = isRecord(body) && body.stage !== undefined ? body.stage : undefined;
      if (stage !== undefined && typeof stage !== "string") return writeError(400, "stage must be an environment name");
      const values = parseSuppliedValues(isRecord(body) ? body.values : undefined);
      return writeJSON(
        v2.transfers.start(params.projectID!, parseCloudChoice(body), {
          ...(stage === undefined ? {} : { stage }),
          ...(values === undefined ? {} : { values }),
        }),
        202,
      );
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/transfer/cancel", async (_request, params) => {
    try {
      return writeJSON(v2.transfers.cancel(params.projectID!), 200);
    } catch (err) {
      return fail(err);
    }
  });
}
