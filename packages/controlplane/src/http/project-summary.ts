// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// A project as the dashboard summary shows it: environments, builds, stages and transfers in one view.
import {
  ErrNotFound,
  type Deployment,
  type Environment,
  type Project,
  type Store,
  type Transfer,
} from "../store/store.js";
import {
  ephemeralInfo,
  withoutDetails,
  type Build,
  type BuildListItem,
  type GitConfig,
  type EphemeralBuildInfo,
} from "../git/git.js";
import { domainUrlFor, type V2 } from "../v2.js";
import { liveBuild, liveDeployment } from "../builds/artifacts.js";
import { environmentClusterId } from "../clouds/connections.js";
import { cannotTakeTrafficReason } from "../edge/edge-table.js";
import type { Mode } from "../mode.js";
import { stageViews, type StageView } from "../stages/stage-routes.js";

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
  const clusterId =
    env.target === "kubernetes" && mode === "production" ? (environmentClusterId(env.config) ?? null) : null;
  let displayName = env.target === "cloudrun" ? "Cloud Run" : env.target === "lambda" ? "AWS Lambda" : "Kubernetes";
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

export function summarize(store: Store, projectId: string, v2: Pick<V2, "edgePublicPort" | "mode">): ProjectSummary {
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
    topLive ??
    [...builds]
      .reverse()
      .find(
        (b) =>
          b.kind === "build" &&
          b.status === "succeeded" &&
          b.deploymentIds.length > 0 &&
          b.stageId === productionStageId,
      );
  const topDeployment = top && topLive ? liveDeployment(store, top) : null;
  return {
    project,
    git,
    domainUrl: domainUrlFor(project, { store, mode, edgePublicPort: v2.edgePublicPort }),
    environments,
    latestBuild: withoutLog(store, latest),
    productionBuild: withoutLog(store, production),
    productionDeployment: topDeployment
      ? { id: topDeployment.id, createdAt: topDeployment.createdAt, environmentId: top!.id }
      : null,
    activeTransfer: store.getActiveTransfer(projectId) ?? null,
    latestTransfer: store.getLatestTransfer(projectId) ?? null,
    stages: stageViews(store, v2, projectId, { builds, git, production: environments }),
  };
}

// busiest: the cloud with the most traffic (ties: environment order).
export function busiest(envs: readonly Environment[]): Environment | undefined {
  return envs.reduce<Environment | undefined>(
    (best, e) => (!best || e.trafficWeight > best.trafficWeight ? e : best),
    undefined,
  );
}

// environmentSummaries: cloud rows as the summary shows them.
export function environmentSummaries(
  store: Store,
  mode: Mode,
  envs: readonly Environment[],
  builds: Build[],
): EnvironmentSummary[] {
  return envs.map((e) => {
    const deps = store.listDeployments(e.id);
    const live = liveBuild(store, e, builds);
    const reason = cannotTakeTrafficReason(store, mode, e);
    return {
      ...environmentView(store, mode, e),
      latestDeployment: deps[deps.length - 1] ?? null,
      canTakeTraffic: canTakeTraffic(deps) && reason === null,
      cannotTakeTrafficReason: reason,
      liveBuild: live
        ? {
            id: live.id,
            revision: live.revision,
            message: live.commit?.message ?? "",
            artifact: live.artifact === true,
          }
        : null,
    };
  });
}
