// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export type { DeployResult, Deployer } from "./deploy.js";
export { deploy } from "./deploy.js";
export { writeCarry, CARRY_MAX_BYTES, type CarrySummary } from "./carry.js";
export { appImageTag, imageTagSuffix } from "./tag.js";
export { createProgress, formatSeconds, type Progress, type ProgressOptions } from "./progress.js";
export { mergeEnvVars, deployTimeEnvVars, checkRequired, imageEnvVars, type UserEnv } from "./env.js";
export {
  createKubernetesTarget,
  holdCliDeployDir,
  type KubernetesTarget,
  type KubernetesTargetOptions,
} from "./kubernetes-target.js";
export { renderNetworkPolicies, kubeName, isrcacheObjectName, isrcacheDeleteArgs } from "@nbo/adapter-k8s";
export { childEnv } from "@nbo/adapter-cloudrun";
export { createCloudRunTarget, type CloudRunTargetOptions } from "./cloudrun-target.js";
export { createLambdaTarget, type LambdaTargetOptions } from "./lambda-target.js";
export {
  serviceIdentityId,
  deleteServiceIdentity,
  deleteAppSecrets,
  renderEnvVarsFile,
  parseServiceLabels,
  isIsrcacheServiceOf,
} from "@nbo/adapter-cloudrun";
export type { ToolContext, CommandRunner, GoogleCredential } from "./credentials.js";
export { withGoogleCredentials, withKubeconfig, withDockerLogin, kubectlArgs, redact } from "./credentials.js";
export { ISR_CACHE_KEY, hasPrerenderRoutes, type IsrOptions } from "./isr.js";
