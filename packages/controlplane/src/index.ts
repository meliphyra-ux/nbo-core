// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export type { Project, Environment, Deployment, Store } from "./store/store.js";
export { createStore, ErrNotFound, ErrDuplicateName, ErrInvalidEnvironmentConfig } from "./store/store.js";
export type { CronRow } from "./deploys/cron.js";
export { signCron, nextRun } from "./deploys/cron.js";
export type { DeploymentTrigger } from "./http/handlers.js";
export { createMux } from "./http/handlers.js";
export type { Orchestrator } from "./deploys/deploy.js";
export { triggerDeploy, deployAppName, recordDeployFailure } from "./deploys/deploy.js";
export type { Scheduler } from "./deploys/scheduler.js";
export { tick, run, schedulerConfig } from "./deploys/scheduler.js";
export { resolveControlPlaneAddr, resolveEdgeConfig } from "./main.js";
export type { Transfer, TransferStatus, SetupStatus } from "./store/store.js";
export type { Build, BuildKind, BuildStatus, GitConfig } from "./git/git.js";
export { createArtifactStore, liveBuild, type ArtifactStore } from "./builds/artifacts.js";
export { wireV2, recoverInterruptedWork, domainUrlFor, stageUrlFor, type V2, type V2Options } from "./v2.js";
export type { ProjectSummary, EnvironmentSummary, BuildSummary } from "./http/v2-routes.js";
export type { CloudChoice, SetupRequest } from "./deploys/setup.js";
export { createCloudSetup, type CloudSetup, type Preflight, type CommandRunner } from "./clouds/cloud-setup.js";
export {
  fakeCloudSetup,
  fakeCloudTeardown,
  type FakeCloudTeardown,
  fakeDeploymentTrigger,
  makeLocalRepo,
  rewriteGitUrl,
  readyPreflight,
  fakeGoogleConnect,
  fakeKubeConnect,
  type FakeGoogleConnect,
  type FakeKubeConnect,
  type FakeCloudSetup,
  type FakeDeploymentTrigger,
} from "./testing.js";
export { pollOnce, pollerConfig } from "./git/poller.js";
export { transferConfig } from "./deploys/transfer.js";
export { createCloudTeardown, type CloudTeardown, type TeardownTarget } from "./clouds/cloud-teardown.js";
export type { InsightsSink, VitalsRow } from "./insights/drain.js";
