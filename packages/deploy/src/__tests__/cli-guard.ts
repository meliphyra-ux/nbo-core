// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Test helper: the adapters' exports that spawn a real CLI (docker,
// kind, kubectl, gcloud). Tests that mock @nbo/adapter-k8s or
// @nbo/adapter-cloudrun spread guardCLI(original, ...) under their own
// stubs, so any CLI export a test forgot to stub throws instead of
// reaching a real cloud. cli-guard.test.ts fails when an adapter gains
// an export that is in neither list, so a new CLI export can't slip by.

export const K8S_CLI_EXPORTS = [
  "deleteEnvSecret",
  "apply",
  "waitForRollout",
  "liveContentID",
  "liveFunctionState",
  "buildImage",
  "buildFunctionImage",
  "loadImageIntoKind",
  "pushImage",
  "buildIsrcacheImage",
  "deleteIsrcache",
  "isrcacheNameTaken",
] as const;

// Pure exports: render text, hash files, build argument lists.
export const K8S_PURE_EXPORTS = [
  "capabilities",
  "renderManifests",
  "renderFunctionManifests",
  "renderNetworkPolicies",
  "renderPullSecret",
  "renderEnvSecret",
  "functionConfigHash",
  "kubectlArgs",
  "functionImageHash",
  "kubeName",
  "functionObjectName",
  "isrcacheObjectName",
  "renderIsrcacheManifests",
  "isrcacheImageTag",
  "appBakedHash",
  "renderIsrcacheDockerfile",
  "isrcacheDeleteArgs",
] as const;

export const CLOUDRUN_CLI_EXPORTS = [
  "deploy",
  "liveContentID",
  "liveServiceState",
  "removeSecretEnv",
  "deleteService",
  "serviceLabels",
  "ensureSecretVersion",
  "grantSecretAccessor",
  "destroySupersededVersions",
  "deleteAppSecrets",
  "defaultComputeServiceAccount",
  "grantInvoker",
  "ensureServiceIdentity",
  "deleteServiceIdentity",
  "pushImage",
] as const;

export const CLOUDRUN_PURE_EXPORTS = [
  "capabilities",
  "childEnv",
  "buildDeployArgs",
  "contentIDLabel",
  "isServiceNotFound",
  "functionDeployConfigHash",
  "renderEnvVarsFile",
  "secretId",
  "secretManagerAccessError",
  "serviceIdentityId",
  "serviceIdentityEmail",
  "isrcacheServiceLabels",
  "isIsrcacheServiceOf",
  "parseServiceLabels",
] as const;

export class UnstubbedCLIError extends Error {}

// guardCLI returns the module with every named CLI export replaced by a
// function that throws; the caller's own stubs, spread after it, win.
export function guardCLI<M extends Record<string, unknown>>(
  original: M,
  adapter: string,
  cliExports: readonly string[],
): M {
  const guarded: Record<string, unknown> = { ...original };
  for (const name of cliExports) {
    guarded[name] = () => {
      throw new UnstubbedCLIError(`${adapter}.${name} is not stubbed in this test and would spawn a real CLI`);
    };
  }
  return guarded as M;
}
