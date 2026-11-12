// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  ErrDuplicateName,
  ErrInvalidEnvironmentConfig,
  ErrNotFound,
  type Deployment,
  type Environment,
  type Project,
  type ProjectPatch,
  type Store,
  type Transfer,
} from "./store.js";
import { ephemeralInfo, withoutDetails, type Build, type BuildListItem, type GitConfig, type EphemeralBuildInfo } from "./git.js";
import type { Router } from "./router.js";
import { isRecord, writeJSON, writeError, statusForStoreError, errorMessage } from "./handlers.js";
import { parseCloudChoice, parseSetupRequest } from "./setup.js";
import { credentialInput, withGitAuth } from "./git-credentials.js";
import { domainUrlFor, stageUrlFor, type V2 } from "./v2.js";
import { deployAppName } from "./deploy.js";
import { registerConnectionRoutes } from "./connection-routes.js";
import { registerBuildRoutes } from "./build-routes.js";
import { liveBuild, liveDeployment } from "./artifacts.js";
import { environmentClusterId } from "./connections.js";
import { cannotTakeTrafficReason, noPublicEntry } from "./edge-table.js";

export { cannotTakeTrafficReason, noPublicEntry };
import { registerDomainRoutes } from "./domain-routes.js";
import type { Mode } from "./mode.js";
import { certSecretName } from "./edge-manifests.js";
import { registerStageRoutes, stageViews, type StageView } from "./stage-routes.js";
import { registerRevalidateRoutes } from "./revalidate-routes.js";
import { desiredTargetForStage } from "./edge-sync.js";
import { hasOwnHost, variableStage, type Stage } from "./stages.js";
import { parseSuppliedValues } from "./supplied-values.js";

export type BuildSummary = BuildListItem & EphemeralBuildInfo;

// EnvironmentView is an environment as the API returns it: config parsed,
// plus the cluster it runs on (Kubernetes in production; null otherwise)
// and the name the UI shows (the cluster's name, "Kubernetes" in dev, or
// "Cloud Run").
export interface EnvironmentView extends Omit<Environment, "config"> {
  config: unknown;
  clusterId: string | null;
  displayName: string;
}

export function environmentView(store: Store, mode: Mode, env: Environment): EnvironmentView {
  const clusterId = env.target === "kubernetes" && mode === "production" ? (environmentClusterId(env.config) ?? null) : null;
  let displayName = env.target === "cloudrun" ? "Cloud Run" : "Kubernetes";
  if (clusterId) displayName = store.getKubernetesConnection(clusterId)?.name ?? "Kubernetes";
  return { ...env, config: JSON.parse(env.config) as unknown, clusterId, displayName };
}

// canTakeTraffic is the one rule for whether an environment may get a
// positive weight: it has EVER had a succeeded deployment with a URL. A
// pending or failed redeploy after that doesn't take it away — the
// earlier deployment still serves.
export function canTakeTraffic(deployments: readonly Deployment[]): boolean {
  return deployments.some((d) => d.status === "succeeded" && d.url !== "");
}

export interface EnvironmentSummary extends EnvironmentView {
  latestDeployment: Deployment | null;
  // canTakeTraffic: see canTakeTraffic above (the PUT traffic route uses
  // the same rule), and no cannotTakeTrafficReason.
  canTakeTraffic: boolean;
  cannotTakeTrafficReason: string | null;
  // liveBuild is the build this environment serves (see artifacts.ts
  // liveBuild), or null when nothing has deployed there.
  // artifact: whether its stored output is kept (it can be redeployed).
  liveBuild: { id: string; revision: string; message: string; artifact: boolean } | null;
}

export interface ProjectSummary {
  project: Project;
  git: GitConfig | null;
  domainUrl: string;
  environments: EnvironmentSummary[];
  latestBuild: BuildSummary | null;
  productionBuild: BuildSummary | null;
  // productionDeployment is the deployment that made productionBuild live
  // on the cloud with the most traffic (null before any cloud serves one).
  productionDeployment: { id: string; createdAt: string; environmentId: string } | null;
  activeTransfer: Transfer | null;
  // latestTransfer is the most recent one in any state, so a failed or
  // cancelled transfer stays visible after it ends.
  latestTransfer: Transfer | null;
  // stages: every environment (Production, Preview, Development, custom
  // ones). environments, productionBuild and domainUrl keep meaning Production.
  stages: StageView[];
}

function withoutLog(store: Store, b: Build | undefined): BuildSummary | null {
  if (!b) return null;
  return ephemeralInfo(store)(withoutDetails(b));
}

function summarize(store: Store, projectId: string, v2: Pick<V2, "edgePublicPort" | "mode">): ProjectSummary {
  const { mode } = v2;
  const project = store.getProject(projectId);
  let git: GitConfig | null = null;
  try {
    git = store.getGitConfig(projectId);
  } catch (err) {
    if (!(err instanceof ErrNotFound)) throw err;
  }
  const builds = store.listBuilds(projectId);
  const envs = store.listEnvironments(projectId);
  const environments = environmentSummaries(store, mode, envs, builds);
  // latestBuild: the newest build of any environment.
  const latest = builds[builds.length - 1];
  // The production build is the one the cloud with the most traffic
  // serves (ties: environment order); before any cloud serves one, the
  // newest Production commit build that deployed somewhere.
  const productionStageId = store.productionStage(projectId).id;
  const top = busiest(envs);
  const topLive = top ? liveBuild(store, top, builds) : null;
  const production =
    topLive ?? [...builds].reverse().find((b) => b.kind === "build" && b.status === "succeeded" && b.deploymentIds.length > 0 && b.stageId === productionStageId);
  const topDeployment = top && topLive ? liveDeployment(store, top) : null;
  return {
    project,
    git,
    domainUrl: domainUrlFor(project, { store, mode, edgePublicPort: v2.edgePublicPort }),
    environments,
    latestBuild: withoutLog(store, latest),
    productionBuild: withoutLog(store, production),
    productionDeployment: topDeployment ? { id: topDeployment.id, createdAt: topDeployment.createdAt, environmentId: top!.id } : null,
    activeTransfer: store.getActiveTransfer(projectId) ?? null,
    latestTransfer: store.getLatestTransfer(projectId) ?? null,
    stages: stageViews(store, v2, projectId, { builds, git, production: environments }),
  };
}

// busiest: the cloud with the most traffic (ties: environment order).
export function busiest(envs: readonly Environment[]): Environment | undefined {
  return envs.reduce<Environment | undefined>((best, e) => (!best || e.trafficWeight > best.trafficWeight ? e : best), undefined);
}

// environmentSummaries: cloud rows as the summary shows them.
export function environmentSummaries(store: Store, mode: Mode, envs: readonly Environment[], builds: Build[]): EnvironmentSummary[] {
  return envs.map((e) => {
    const deps = store.listDeployments(e.id);
    const live = liveBuild(store, e, builds);
    const reason = cannotTakeTrafficReason(store, mode, e);
    return {
      ...environmentView(store, mode, e),
      latestDeployment: deps[deps.length - 1] ?? null,
      canTakeTraffic: canTakeTraffic(deps) && reason === null,
      cannotTakeTrafficReason: reason,
      liveBuild: live ? { id: live.id, revision: live.revision, message: live.commit?.message ?? "", artifact: live.artifact === true } : null,
    };
  });
}

async function readJSON(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function fail(err: unknown): Response {
  return writeError(statusForStoreError(err), errorMessage(err));
}

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
      environments: store.listEnvironments(projectId, { stageId: stage.id }).map((e) => ({ id: e.id, cannotTakeTrafficReason: cannotTakeTrafficReason(store, v2.mode, e) })),
      // Only this environment's route, so another one's change can't flag it.
      edgeInSync: desired ? await v2.edgeSync.inSync(projectId, stage.host) : false,
    };
  }
  const desired = v2.edgeSync.desiredTarget(projectId);
  return {
    host: project.edgeHost,
    domainUrl: domainUrlFor(project, { store, mode: v2.mode, edgePublicPort: v2.edgePublicPort }),
    backends: desired?.backends ?? [],
    environments: store.listEnvironments(projectId).map((e) => ({ id: e.id, cannotTakeTrafficReason: cannotTakeTrafficReason(store, v2.mode, e) })),
    // Production's route only; a custom environment has its own flag.
    edgeInSync: desired ? await v2.edgeSync.inSync(projectId, desired.host) : false,
  };
}

// trafficStage: the stage a traffic request names (Production by default),
// or why it can't have a split.
function trafficStage(store: Store, projectId: string, name: unknown): Stage | string {
  if (name !== undefined && (typeof name !== "string" || name === "")) return "stage must be an environment name";
  const stage = store.getStageByName(projectId, (name as string | undefined) ?? "production");
  if (stage.kind !== "production" && stage.kind !== "custom") return `the ${stage.name} environment holds variables only and has no traffic`;
  return stage;
}

const sampleRates = [100, 50, 25, 10];

// parseSettingsPatch validates the project settings PATCH body: an error
// message, or the patch to apply.
function parseSettingsPatch(body: unknown): ProjectPatch | string {
  const allowed = "pollingEnabled, speedInsights, speedInsightsInject (booleans) and speedInsightsSampleRate (100, 50, 25 or 10)";
  if (!isRecord(body)) return `settings body may contain only ${allowed}`;
  const patch: ProjectPatch = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "pollingEnabled" || k === "speedInsights" || k === "speedInsightsInject") {
      if (typeof v !== "boolean") return `${k} must be a boolean`;
      patch[k] = v;
    } else if (k === "speedInsightsSampleRate") {
      if (typeof v !== "number" || !sampleRates.includes(v)) return "speedInsightsSampleRate must be 100, 50, 25 or 10";
      patch.speedInsightsSampleRate = v;
    } else {
      return `settings body may contain only ${allowed}`;
    }
  }
  return patch;
}

export function registerV2Routes(router: Router, store: Store, v2: V2): void {
  registerConnectionRoutes(router, store, v2);
  registerBuildRoutes(router, store, v2.artifacts);
  registerDomainRoutes(router, store, v2);
  registerStageRoutes(router, store, v2);
  registerRevalidateRoutes(router, store, v2);
  router.handle("GET", "/system/preflight", async () => {
    try {
      return writeJSON(await v2.cloudSetup.preflight(), 200);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("POST", "/projects/setup", async (request) => {
    try {
      const req = parseSetupRequest(await readJSON(request));
      // A deploy key's pair is made before the project exists, so the
      // background setup reads the repository with it.
      const credential = req.credential ? await credentialInput(store, req.credential, undefined, req.name, v2.keygen) : undefined;
      const project = v2.setup.start(req, credential === "keep" ? undefined : credential);
      return writeJSON(summarize(store, project.id, v2), 201);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/setup/retry", async (request, params) => {
    try {
      const body = await readJSON(request);
      const clouds = isRecord(body) && body.clouds !== undefined ? body.clouds : undefined;
      if (clouds !== undefined && !Array.isArray(clouds)) throw new ErrInvalidEnvironmentConfig("clouds must be an array");
      v2.setup.retry(params.projectID!, clouds as never);
      return writeJSON(summarize(store, params.projectID!, v2), 202);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("GET", "/projects/summary", async () => {
    try {
      return writeJSON(
        store.listProjects().map((p) => summarize(store, p.id, v2)),
        200,
      );
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("GET", "/projects/{projectID}/summary", async (_request, params) => {
    try {
      return writeJSON(summarize(store, params.projectID!, v2), 200);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/builds", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const body = await readJSON(request);
      const revision = isRecord(body) ? body.revision : undefined;
      if (revision !== undefined && (typeof revision !== "string" || !/^[0-9a-f]{40}$/.test(revision))) {
        return writeError(400, "revision must be a 40-character git commit sha");
      }
      // stage: which environment to build for (a stage name, default production).
      const stageName = isRecord(body) && body.stage !== undefined ? body.stage : "production";
      if (typeof stageName !== "string" || !stageName) return writeError(400, "stage must be an environment name");
      const stage = store.getStageByName(projectId, stageName);
      if (stage.kind === "preview" || stage.kind === "development") {
        return writeError(400, `the ${stage.name} environment holds variables only and doesn't deploy`);
      }
      if (stage.kind === "ephemeral" && stage.removal !== "") {
        return writeError(409, `the ${stage.name} environment was removed (or is being removed) and can't build`);
      }
      // values: the stage's variable values when NBO keeps names only
      // (checked now, before the head is read; refused when NBO stores them).
      const values = parseSuppliedValues(isRecord(body) ? body.values : undefined);
      if (store.getServerSettings().envValues === "none" || values !== undefined) store.resolveEnv(projectId, variableStage(stage), values);
      const git = store.getGitConfig(projectId);
      const branch = stage.kind === "production" ? git.productionBranch : stage.branch;
      let sha = revision as string | undefined;
      if (sha === undefined) {
        try {
          sha = await withGitAuth(v2.gitAuth, projectId, git, (env) => v2.lsRemote(git.repo, branch, env ? { env } : undefined));
        } catch (err) {
          return writeError(502, `could not read the head of ${branch}: ${errorMessage(err)}`);
        }
        // The poller then doesn't build the same head again; the time kept
        // with it lets a later push whose before isn't this head through.
        if (stage.kind === "production" || stage.kind === "custom" || stage.kind === "ephemeral") store.advanceHead(projectId, sha, stage.id, undefined, { at: Date.now() });
        else store.updateStage(stage.id, { lastSeenSha: sha });
      }
      // Names only: an empty stage still gets {} so the build isn't taken for a push.
      const namesOnly = store.getServerSettings().envValues === "none";
      const build = v2.queue.enqueue(projectId, sha, { manual: true, stageId: stage.id, ...(namesOnly ? { values: values ?? {} } : {}) });
      const { log: _log, ...rest } = build;
      return writeJSON(rest, 202);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("PATCH", "/projects/{projectID}/settings", async (request, params) => {
    try {
      const body = await readJSON(request);
      const patch = parseSettingsPatch(body);
      if (typeof patch === "string") return writeError(400, patch);
      const before = store.getProject(params.projectID!);
      const after = store.updateProject(params.projectID!, patch);
      // Speed Insights settings travel with the host's edge target; a
      // failed push is retried by the poll loop's reconcile.
      if (
        before.speedInsights !== after.speedInsights ||
        before.speedInsightsInject !== after.speedInsightsInject ||
        before.speedInsightsSampleRate !== after.speedInsightsSampleRate
      ) {
        try {
          await v2.edgeSync.push(params.projectID!);
        } catch (err) {
          console.error(`control-plane: pushing Speed Insights settings for ${after.name} to the edge failed: ${errorMessage(err)}`);
        }
      }
      return writeJSON(summarize(store, params.projectID!, v2), 200);
    } catch (err) {
      return fail(err);
    }
  });

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
      if (!isRecord(body) || !isRecord(body.weights)) return writeError(400, "weights must map environment ids to integer percentages");
      // stage: whose split this is (Production by default); weights may name only its clouds.
      const stage = trafficStage(store, projectId, body.stage);
      if (typeof stage === "string") return writeError(400, stage);
      const custom = stage.kind === "custom" ? stage : undefined;
      // Transfers move Production only.
      if (!custom && store.getActiveTransfer(projectId)) return writeError(409, "a transfer is moving traffic right now — stop it before setting a split by hand");
      const envs = new Map(store.listEnvironments(projectId, custom ? { stageId: custom.id } : undefined).map((e) => [e.id, e]));
      const weights: Record<string, number> = {};
      for (const [envId, w] of Object.entries(body.weights)) {
        const env = envs.get(envId);
        if (!env) return writeError(400, `environment "${envId}" is not a live environment of this project`);
        if (typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 100) return writeError(400, "each weight must be an integer from 0 to 100");
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
      if (typeof stageName !== "string" || stageName === "") throw new ErrInvalidEnvironmentConfig("stage must be an environment name");
      const stage = store.getStageByName(params.projectID!, stageName);
      // An ephemeral stage runs on the one cloud it was made with.
      if (stage.kind === "ephemeral") throw new ErrInvalidEnvironmentConfig(`${stage.name} is an ephemeral environment, which runs on one cloud only`);
      const env = await v2.setup.addCloud(params.projectID!, cloud, stage.kind === "production" ? undefined : { stageId: stage.id });
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
      return writeJSON(v2.transfers.start(params.projectID!, parseCloudChoice(body), { ...(stage === undefined ? {} : { stage }), ...(values === undefined ? {} : { values }) }), 202);
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

  // Deleting a project removes its NBO records and its edge route.
  // ?resources=true first deletes what it runs on each cloud; if that
  // fails nothing is deleted, so the operator can retry or choose to
  // keep the cloud side.
  router.handle("DELETE", "/projects/{projectID}", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const project = store.getProject(projectId);
      if (store.findRunningBuild(projectId) || store.nextQueuedJob(projectId)) return writeError(409, "a build is running — wait for it to finish, then delete");
      if (store.getActiveTransfer(projectId)) return writeError(409, "a transfer is in progress — stop it first");
      if (project.setupStatus === "provisioning") return writeError(409, "setup is still running — wait for it to finish");
      const keepsCloud = new URL(request.url).searchParams.get("resources") !== "true";
      if (keepsCloud) {
        const mappedHosts = store.listDomains(projectId).filter((d) => d.serving === "cloudrun" || d.mappingKept).map((d) => d.host);
        if (mappedHosts.length > 0) console.error(`control-plane: project ${project.name} deleted without its cloud resources; Google still maps ${mappedHosts.join(", ")}`);
      }
      if (!keepsCloud) {
        // Every environment's clouds, custom ones included.
        for (const env of store.listEnvironments(projectId, { includeArchived: true, allStages: true })) {
          try {
            await v2.cloudTeardown.remove({ target: env.target, appName: deployAppName(env), projectId: env.projectId, config: JSON.parse(env.config) as Record<string, unknown> });
          } catch (err) {
            return writeError(502, errorMessage(err));
          }
        }
      }
      // Production's host and every custom environment's.
      for (const host of [project.edgeHost, ...store.listStages(projectId, { includeEphemeral: true }).filter(hasOwnHost).map((s) => s.host)]) {
        try {
          await v2.edgeSync.remove(host);
        } catch (err) {
          console.error(`control-plane: removing ${host} from the edge failed: ${errorMessage(err)}`);
        }
      }
      const certHosts = v2.mode === "production" && store.getServerSettings().edgeClusterId !== "" ? store.listDomains(projectId).map((d) => d.host) : [];
      store.deleteProject(projectId);
      if (certHosts.length > 0) {
        // The table first, so the edge is never told to use a Secret that is gone.
        try {
          await v2.edgeSync.push(projectId);
        } catch (err) {
          console.error(`control-plane: project ${project.name} deleted, but updating the edge route table failed: ${errorMessage(err)}`);
        }
        for (const host of certHosts) {
          try {
            await v2.certs.deleteCert(certSecretName(host));
          } catch (err) {
            console.error(`control-plane: project ${project.name} deleted, but deleting the certificate Secret of ${host} failed: ${errorMessage(err)}`);
          }
        }
      }
      return new Response(null, { status: 204 });
    } catch (err) {
      return fail(err);
    }
  });

  // Deploy a chosen build: queue a promote job deploying the build's
  // stored .nbo/ to one environment of its project (no rebuild).
  router.handle("POST", "/builds/{buildID}/deploy", async (request, params) => {
    try {
      const body = await readJSON(request);
      if (!isRecord(body) || typeof body.environmentId !== "string" || !body.environmentId) return writeError(400, "environmentId is required");
      const build = store.getBuild(params.buildID!);
      const sourceId = build.kind === "promote" ? build.sourceBuildId : build.id;
      const dup = store
        .listBuilds(build.projectId)
        .some((b) => b.kind === "promote" && (b.status === "queued" || b.status === "running") && b.sourceBuildId === sourceId && b.targetEnvironmentId === body.environmentId);
      if (dup) return writeError(409, "A deploy of this build to this cloud is already queued");
      const values = parseSuppliedValues(body.values);
      const job = v2.queue.enqueuePromote(build.projectId, build.id, body.environmentId, values === undefined ? undefined : { values });
      return writeJSON(withoutDetails(job), 202);
    } catch (err) {
      return fail(err);
    }
  });

  // Per-cloud settings: autoDeploy decides whether new commits deploy here.
  router.handle("PATCH", "/environments/{environmentID}", async (request, params) => {
    try {
      const body = await readJSON(request);
      if (!isRecord(body) || typeof body.autoDeploy !== "boolean" || Object.keys(body).some((k) => k !== "autoDeploy")) {
        return writeError(400, "body must be { autoDeploy: boolean }");
      }
      if (store.getEnvironment(params.environmentID!).archived) return writeError(400, "this environment is archived");
      store.setEnvironmentAutoDeploy(params.environmentID!, body.autoDeploy);
      const env = store.getEnvironment(params.environmentID!);
      return writeJSON(environmentView(store, v2.mode, env), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Archiving only stops NBO deploying and routing there; the running
  // cloud service is left in place for the operator to delete.
  router.handle("POST", "/environments/{environmentID}/archive", async (_request, params) => {
    try {
      const env = store.getEnvironment(params.environmentID!);
      if (env.archived) return new Response(null, { status: 204 });
      if (env.trafficWeight > 0) return writeError(400, "move all traffic off this environment first");
      // Counted within the row's own environment (Production or a custom one).
      const production = store.productionStage(env.projectId).id === env.stageId;
      if (store.listEnvironments(env.projectId, { stageId: env.stageId }).length <= 1) {
        return writeError(400, production ? "this is the project's only environment" : "this is the only cloud of its environment");
      }
      const active = store.getActiveTransfer(env.projectId);
      if (active && (active.fromEnvId === env.id || active.toEnvId === env.id)) return writeError(409, "a transfer involving this environment is in progress");
      // NBO reaches a domain mapping through this environment (Production's only).
      if (env.target === "cloudrun" && production) {
        const mapped = store.listDomains(env.projectId).filter((d) => d.serving === "cloudrun" || d.mappingKept).map((d) => d.host);
        if (mapped.length > 0) return writeError(409, `Cloud Run still has domain mappings for ${mapped.join(", ")}. Remove these domains, or wait for moved ones to finish, before archiving this environment.`);
      }
      store.archiveEnvironment(env.id);
      return new Response(null, { status: 204 });
    } catch (err) {
      return fail(err);
    }
  });
}
