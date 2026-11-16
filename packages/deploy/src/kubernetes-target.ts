// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilities,
  buildImage,
  buildFunctionImage,
  loadImageIntoKind,
  pushImage,
  renderManifests,
  renderFunctionManifests,
  renderNetworkPolicies,
  renderPullSecret,
  renderEnvSecret,
  deleteEnvSecret,
  apply,
  waitForRollout,
  liveContentID,
  liveFunctionState,
  functionImageHash,
  functionConfigHash,
  functionObjectName,
  kubeName,
  isrcacheObjectName,
  isrcacheImageTag,
  appBakedHash,
  buildIsrcacheImage,
  renderIsrcacheManifests,
  deleteIsrcache,
  isrcacheNameTaken,
  type FunctionDeploySpec,
  type ToolContext,
} from "@nbo/adapter-k8s";
import { redact, type CommandRunner } from "./credentials.js";
import { createCliDeployDirCache } from "./cli-deploy-dir.js";
import { mapLimit } from "./concurrency.js";
import { imageEnvVars, providedEnvNames, type UserEnv } from "./env.js";
import { appImageTag } from "./tag.js";
import { withCarry } from "./carry.js";
import { ISR_CACHE_KEY, type IsrOptions } from "./isr.js";
import { run } from "./run.js";
import type { Deployer } from "./deploy.js";
import { createProgress, type Progress, type ProgressOptions } from "./progress.js";

// prepareCliDeployDir replaces crossCompileLinuxBinary now that
// cmd/nbo is Node source, not a cross-compiled Go binary (step 8's
// own Dockerfile swap, @nbo/adapter-k8s's own templates.ts/image.ts) —
// materializes a complete, self-contained @nbo/cli artifact (dist/ +
// node_modules, including sharp/re2's own native bindings) via a real
// `pnpm deploy`, confirmed directly to produce a directory @nbo/adapter-k8s's
// own buildImage can dereference-copy into a Docker build context and
// have the result actually run. A fresh staging dir per call, not a
// fixed shared path — a long-running service can run concurrent
// deploys, which would otherwise race on the same output directory
// (the same reason crossCompileLinuxBinary used a fresh temp dir too).
// Run from the repo root, matching every other run() call site in
// this package — no cwd override needed as long as the whole process
// already runs from there.
//
// Ruling (final review, finding C1): builds "@nbo/cli..." (the
// package and every workspace dependency it has, topologically
// ordered — confirmed directly) before deploying it. Go's own
// crossCompileLinuxBinary always compiled fresh from current source
// on every call; this function must have that same property, not
// trust that whoever last ran `pnpm build` left a correct dist/
// lying around anywhere in the dependency graph — confirmed directly
// that without this, a stale or entirely missing dist/ (in @nbo/cli
// itself, or any package it depends on — @nbo/deploy and
// @nbo/adapter-k8s both reproduced this for real during this
// review's own fix pass) is silently `pnpm deploy`d as-is.
//
// Ruling (final review, finding C2): --config.node-linker=hoisted,
// not pnpm's own default isolated linker. Confirmed directly (a real
// Docker build + `nbo serve` run against each): isolated linking
// resolves a transitive dependency (ajv, needed by @nbo/validate,
// never a direct dependency of @nbo/cli itself) only through a
// virtual-store symlink chain that depends on @nbo/validate going on
// living inside that same virtual store — relocating the deploy
// output at all (a plain recursive copy, or Docker's own COPY into
// the build context) breaks that chain, because the package ends up
// isolated from its own sibling dependencies once moved. Hoisted
// linking instead puts every dependency, direct or transitive, as a
// real top-level node_modules entry (confirmed: ajv lands as a real,
// non-symlinked directory there) — the traditional flat layout, and
// the only one of the two confirmed to survive relocation into a
// Docker build context. This requires non-legacy deploy, which in
// turn requires injectWorkspacePackages: true in pnpm-workspace.yaml
// (confirmed: --legacy overrides that setting outright; dropping
// --legacy without it fails with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE).
// --os/--cpu/--libc force sharp's own platform-specific optional
// dependency to resolve to the target (linux/x64/glibc) rather than
// this machine's own (win32) — confirmed directly, this is the one
// pnpm-native mechanism for that; it does not extend to re2's own
// custom install script, which @nbo/adapter-k8s's own appDockerfile
// re-runs inside the target container instead (templates.ts).
export async function prepareCliDeployDir(): Promise<string> {
  await run("pnpm", ["--filter", "@nbo/cli...", "build"]);
  const tmpDir = await mkdtemp(join(tmpdir(), "nbo-cli-deploy-"));
  await run("pnpm", [
    "--filter",
    "@nbo/cli",
    "deploy",
    "--prod",
    "--os=linux",
    "--cpu=x64",
    "--libc=glibc",
    "--config.node-linker=hoisted",
    tmpDir,
  ]);
  return tmpDir;
}

// cliDeployDirs shares one prepared CLI bundle between every deploy of
// the same build running in this process (see cli-deploy-dir.ts).
export const cliDeployDirs = createCliDeployDirCache(prepareCliDeployDir, (dir) =>
  rm(dir, { recursive: true, force: true }),
);

// holdCliDeployDir keeps one build's CLI bundle alive across several
// deploys of that build (the control-plane runner's parallel
// environments); release it once they have all finished.
export function holdCliDeployDir(nboDir: string): { release(): Promise<void> } {
  return cliDeployDirs.hold(nboDir);
}

// Function deploys within one target run concurrently, up to this many
// at once (docker builds and pushes are the heavy part).
export const functionConcurrency = 4;

// KubernetesTargetOptions deploys into a connected cluster instead of
// the local kind one: images are pushed to a registry (registryEnv is
// the push credentials' env, e.g. a temporary DOCKER_CONFIG), the
// cluster pulls them with pullSecret, and every kubectl call uses the
// stored namespace-scoped kubeconfig (a file path) and namespace. run
// is the boundary for every docker push / kubectl call (local docker
// builds still use this package's own runner).
export interface KubernetesTargetOptions {
  kubeconfig: string;
  namespace: string;
  registryPrefix: string;
  registryEnv: Record<string, string>;
  pullSecret: { server: string; username: string; password: string };
  run?: CommandRunner;
}

export const pullSecretName = "nbo-pull";

interface Placement {
  // Moves a locally built image to where the cluster can run it,
  // returning the tag the manifests should reference.
  ship: (localTag: string, repoName: string, suffix: string) => Promise<string>;
  // The reference ship returns (and the manifests use) for this image.
  imageRef: (localTag: string, repoName: string, suffix: string) => string;
  // Progress wording for the ship step (kind load vs registry push).
  shipLabel: { done: string; fail: string };
  kube?: ToolContext;
  namespace?: string;
  pullSecret?: string;
  serviceURL: (name: string) => string;
}

function devPlacement(clusterName: string): Placement {
  return {
    shipLabel: { done: "image loaded into kind", fail: "image load into kind" },
    ship: async (localTag) => {
      await loadImageIntoKind(localTag, clusterName);
      return localTag;
    },
    imageRef: (localTag) => localTag,
    serviceURL: (name) => `http://${name}:8080`,
  };
}

function connectedPlacement(opts: KubernetesTargetOptions): Placement {
  const kube: ToolContext = { kubeconfig: opts.kubeconfig, namespace: opts.namespace, run: opts.run };
  const push: ToolContext = { env: opts.registryEnv, run: opts.run };
  const imageRef = (_localTag: string, repoName: string, suffix: string) =>
    `${opts.registryPrefix}/${repoName}:${suffix}`;
  return {
    shipLabel: { done: "image pushed", fail: "image push" },
    ship: async (localTag, repoName, suffix) => {
      const remoteTag = imageRef(localTag, repoName, suffix);
      await pushImage(localTag, remoteTag, push);
      return remoteTag;
    },
    imageRef,
    kube,
    namespace: opts.namespace,
    pullSecret: pullSecretName,
    serviceURL: (name) => `http://${name}.${opts.namespace}.svc.cluster.local:8080`,
  };
}

// deployOneFunction builds, ships, applies, and waits for rollout of
// one function's own Deployment/Service, returning its in-cluster
// Service URL — port of deployOneFunction (kubernetes.go lines
// 45-67), extended with envVars (Go's own version never had crons/
// this env-propagation gap to fix — found running Slice 4's crons
// verify script for real: a function's own container never received
// any deploy-time env var, only the main app did).
//
// The image is tagged with the function's content hash
// (functionImageHash), not a timestamp, and the Deployment carries a
// hash of the rendered manifests (nbo.dev/fn-config). Only when the
// live Deployment runs exactly that image, with exactly that config,
// AND its rollout is complete and healthy are build/ship/apply/rollout
// skipped (only the URL is returned) — a timed-out rollout or a
// manifest change is always redeployed.
//
// envFingerprint (the user's variable set) is part of the rendered
// manifests and so of the config hash; absent leaves both unchanged.
async function deployOneFunction(
  nboDir: string,
  app: string,
  name: string,
  place: Placement,
  envVars: Record<string, string>,
  envFingerprint: string | undefined,
  envSecret: string | undefined,
  p: Progress,
): Promise<string> {
  const bundleDir = join(nboDir, "functions", name, "bundle");
  const functionJSONPath = join(nboDir, "functions", name, "function.json");
  const repoName = `nbo-fn-${app}-${name}`;
  const suffix = await functionImageHash(bundleDir, functionJSONPath, envVars);
  const tag = `${repoName}:${suffix}`;
  // Deployment, Service and in-cluster URL share one name, kept within 63 characters.
  const deploymentName = functionObjectName(app, name);
  const fnSpec: FunctionDeploySpec = {
    appName: app,
    functionName: name,
    imageTag: place.imageRef(tag, repoName, suffix),
    namespace: place.namespace,
    pullSecret: place.pullSecret,
    ...(envFingerprint ? { envFingerprint } : {}),
    ...(envSecret ? { envSecret } : {}),
  };
  const configHash = functionConfigHash(fnSpec);
  const live = await liveFunctionState(deploymentName, place.kube);
  if (live && live.healthy && live.image === fnSpec.imageTag && live.config === configHash) {
    p.report("unchanged, skipped");
    return place.serviceURL(deploymentName);
  }
  await p.timed("image built", "image build", () => buildFunctionImage(bundleDir, functionJSONPath, tag, envVars));
  const imageTag = await p.timed(place.shipLabel.done, place.shipLabel.fail, () => place.ship(tag, repoName, suffix));
  const fnManifest = renderFunctionManifests({ ...fnSpec, imageTag, configHash });
  await p.timed("manifests applied", "manifest apply", () => apply(fnManifest, place.kube));
  await p.timed("rollout finished", "rollout", () => waitForRollout(deploymentName, place.kube));
  return place.serviceURL(deploymentName);
}

// createKubernetesTarget wraps a Deployer wired against the local
// kind cluster, matching the nbo CLI's own --target kubernetes wiring
// exactly. The sslip.io host convention is hardcoded; the kind cluster
// that `kind load` targets is NBO_KIND_CLUSTER (default nbo-local), so
// a CI cluster with another name gets the images. extraEnv is a plain
// mutable property (not Go's own WithExtraEnv chainable builder +
// private-field-plus-test-accessor) — see this plan's own
// Architecture — read by buildAndDeployApp's own closure at call
// time, so setting it after construction still takes effect, exactly
// like Go's own WithExtraEnv does — port of NewKubernetesTarget/
// k8sDeployer/KubernetesTarget (kubernetes.go lines 75-161).
//
// With opts it deploys into opts.namespace of a connected cluster
// instead (see KubernetesTargetOptions): no Ingress (the edge reaches
// the app in-cluster), the pull secret and NetworkPolicies are applied
// before any workload.
//
// isr (read at call time, like extraEnv) turns on the ISR cache steps:
// deployIsrCache runs `<app>-isr` from the CLI bundle's nbo-isrcache
// image and the app image gets its URL as functions.json's __isrcache;
// removeIsrCache deletes it. otherAppNames are the app names of the
// project's other cloud rows: a cache whose name is one of them is
// refused (clusters named `isr` or `*-isr`, connected before such names
// were reserved, would otherwise share a name with another app).
export interface KubernetesTarget {
  deployer: Deployer;
  extraEnv: Record<string, string>;
  userEnv?: UserEnv;
  carryFrom?: string;
  isr?: IsrOptions;
  otherAppNames?: string[];
}

export function createKubernetesTarget(
  appName: string,
  opts?: KubernetesTargetOptions,
  progress?: ProgressOptions,
): KubernetesTarget {
  const clusterName = process.env.NBO_KIND_CLUSTER || "nbo-local";
  const host = `${appName}.127.0.0.1.sslip.io`;
  const place = opts ? connectedPlacement(opts) : devPlacement(clusterName);
  let deployedFunctionURLs: Record<string, string> = {};
  let namespacePrepared = false;
  const progressRoot = createProgress(progress);
  // prepareNamespace applies the pull secret and this app's
  // NetworkPolicies once per target, before the first workload.
  const prepareNamespace = async (app: string): Promise<void> => {
    if (!opts || namespacePrepared) return;
    const s = opts.pullSecret;
    await progressRoot.timed("namespace prepared", "namespace preparation", async () => {
      await apply(renderPullSecret(opts.namespace, pullSecretName, s.server, s.username, s.password), place.kube);
      await apply(renderNetworkPolicies(opts.namespace, app), place.kube);
    });
    namespacePrepared = true;
  };
  // The user's variables reach pods through the Secret <app>-env (envFrom).
  // NBO's own values come from /env.json, which the app loads over
  // process.env at startup, so they win on any clash (the names NBO sets
  // are reserved and cannot be user variables anyway). The Secret holds
  // the complete set: applying it drops removed names; an empty set
  // deletes it. Applied once per target, before any Deployment, over stdin.
  let envSecretSynced = false;
  const envSecretFor = (app: string): string | undefined =>
    Object.keys(target.userEnv?.vars ?? {}).length > 0 ? kubeName(`${app}-env`) : undefined;
  const syncEnvSecret = async (app: string): Promise<void> => {
    const userEnv = target.userEnv;
    if (!userEnv || envSecretSynced) return;
    const name = kubeName(`${app}-env`);
    const secrets = userEnv.secretNames.map((n) => userEnv.vars[n]).filter((v): v is string => !!v);
    try {
      if (envSecretFor(app)) {
        await apply(renderEnvSecret(name, userEnv.vars, opts?.namespace), place.kube);
      } else {
        await deleteEnvSecret(name, place.kube);
      }
    } catch (err) {
      // The original error is dropped on purpose: it can carry secret values.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(redact(err instanceof Error ? err.message : String(err), secrets));
    }
    envSecretSynced = true;
  };
  // target IS the object returned below, not a copy — the closures
  // read target.extraEnv at call time, so a caller mutating the
  // returned object's own extraEnv property (exactly what Go's own
  // WithExtraEnv did via a method) is observed correctly.
  const target = {} as KubernetesTarget;
  target.extraEnv = {};
  // The secret values of the user's variables: never in an error this target throws itself.
  const userSecretValues = (): string[] => {
    const userEnv = target.userEnv;
    return userEnv ? userEnv.secretNames.map((n) => userEnv.vars[n]).filter((v): v is string => !!v) : [];
  };

  // deployIsrCache: build, ship, apply and await `<app>-isr`, returning
  // the in-cluster URL buildAndDeployApp bakes in as __isrcache. The
  // image tag hashes the bundle's code, so an unchanged NBO keeps the
  // running cache (and its contents): applying the same manifest is a no-op.
  let isrCacheURL: string | undefined;
  const deployIsrCache = async (nboDir: string, app: string): Promise<string> => {
    const name = isrcacheObjectName(app);
    if ((target.otherAppNames ?? []).includes(name)) {
      throw new Error(
        `ISR cache: its name ${name} is the app name of another environment of this project (a cluster named "isr" or ending in "-isr"); remove that environment to use ISR here`,
      );
    }
    // Never apply over another app's object that shares the name (a
    // function "<other>-fn-x-isr", an older environment's app): only an
    // object labelled as this app's cache may be replaced.
    let taken: string | undefined;
    try {
      taken = await isrcacheNameTaken(app, place.kube);
    } catch (err) {
      // eslint-disable-next-line preserve-caught-error -- the original error may carry secret values
      throw new Error(
        redact(
          `ISR cache: reading ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
          userSecretValues(),
        ),
      );
    }
    if (taken) {
      throw new Error(
        `ISR cache: ${taken} exists and is not this app's ISR cache; NBO won't replace it. Rename the function or environment that uses this name to use ISR here`,
      );
    }
    const p = progressRoot.scope("isr cache");
    const cli = await p.timed("cli bundle prepared", "cli bundle preparation", () => cliDeployDirs.acquire(nboDir));
    try {
      const tag = await isrcacheImageTag(cli.dir);
      const repoName = "nbo-isrcache";
      const suffix = tag.slice(tag.indexOf(":") + 1);
      await p.timed("image built", "image build", () => buildIsrcacheImage(cli.dir, tag));
      const imageTag = await p.timed(place.shipLabel.done, place.shipLabel.fail, () =>
        place.ship(tag, repoName, suffix),
      );
      await prepareNamespace(app);
      const manifest = renderIsrcacheManifests({
        appName: app,
        imageTag,
        ...(place.namespace ? { namespace: place.namespace, pullSecret: place.pullSecret } : {}),
      });
      await p.timed("manifests applied", "manifest apply", () => apply(manifest, place.kube));
      await p.timed("rollout finished", "rollout", () => waitForRollout(name, place.kube));
    } finally {
      await cli.release();
    }
    isrCacheURL = place.serviceURL(name);
    return isrCacheURL;
  };

  // removeIsrCache: the new app no longer uses a cache. Its error never
  // carries a secret value (deploy() reports its first line as progress).
  const removeIsrCache = async (app: string): Promise<void> => {
    try {
      await deleteIsrcache(app, place.kube);
    } catch (err) {
      // eslint-disable-next-line preserve-caught-error -- the original error may carry secret values
      throw new Error(redact(err instanceof Error ? err.message : String(err), userSecretValues()));
    }
  };

  const deployFunctions = async (
    nboDir: string,
    app: string,
    functionNames: string[],
  ): Promise<Record<string, string>> => {
    const envVars = await imageEnvVars(nboDir, !!opts, target.extraEnv, target.userEnv);
    const fingerprint = target.userEnv?.fingerprint ?? undefined;
    if (functionNames.length > 0) {
      await prepareNamespace(app);
      await syncEnvSecret(app);
    }
    const deployed = await mapLimit(functionNames, functionConcurrency, (name) =>
      deployOneFunction(
        nboDir,
        app,
        name,
        place,
        envVars,
        fingerprint,
        envSecretFor(app),
        progressRoot.scope(`function ${name}`),
      ),
    );
    const urls: Record<string, string> = {};
    functionNames.forEach((name, i) => (urls[name] = deployed[i]!));
    deployedFunctionURLs = urls;
    return urls;
  };

  const buildAndDeployApp = async (nboDir: string, app: string, id: string): Promise<void> => {
    const p = progressRoot.scope("app");
    const cli = await p.timed("cli bundle prepared", "cli bundle preparation", () => cliDeployDirs.acquire(nboDir));
    const cliDeployDir = cli.dir;
    try {
      const envVars = await imageEnvVars(nboDir, !!opts, target.extraEnv, target.userEnv);
      // With its own cache, the app must not find NBO's (dev) NBO_ISRCACHE_URL: it would win over __isrcache.
      if (target.isr?.enabled) delete envVars.NBO_ISRCACHE_URL;
      const functionURLs = isrCacheURL
        ? { ...deployedFunctionURLs, [ISR_CACHE_KEY]: isrCacheURL }
        : deployedFunctionURLs;
      const fp: { envFingerprint?: string; envSecret?: string } = target.userEnv?.fingerprint
        ? { envFingerprint: target.userEnv.fingerprint }
        : {};
      // Read at call time, like extraEnv: the previous build's hashed files ride in the image.
      const { suffix, tag } = await withCarry(
        target.carryFrom,
        nboDir,
        (m) => p.report(m),
        async (carryDir, carryHash) => {
          const suffix = appImageTag(id, carryHash, await appBakedHash(cliDeployDir, functionURLs, envVars));
          const tag = `nbo-app-${app}:${suffix}`;
          await p.timed("image built", "image build", () =>
            buildImage(nboDir, cliDeployDir, tag, functionURLs, envVars, carryDir),
          );
          return { suffix, tag };
        },
      );
      const imageTag = await p.timed(place.shipLabel.done, place.shipLabel.fail, () =>
        place.ship(tag, `nbo-app-${app}`, suffix),
      );
      await prepareNamespace(app);
      await syncEnvSecret(app);
      const envSecret = envSecretFor(app);
      if (envSecret) Object.assign(fp, { envSecret });
      const manifest = opts
        ? renderManifests({
            appName: app,
            imageTag,
            host: "",
            contentID: id,
            namespace: opts.namespace,
            ingress: false,
            pullSecret: pullSecretName,
            ...fp,
          })
        : renderManifests({ appName: app, imageTag, host, contentID: id, ...fp });
      await p.timed("manifests applied", "manifest apply", () => apply(manifest, place.kube));
      await p.timed("rollout finished", "rollout", () => waitForRollout(app, place.kube));
    } finally {
      // The artifact here is a full node_modules, categorically
      // larger than the single Go binary crossCompileLinuxBinary left
      // behind (which Go's own original never cleaned up either) — a
      // deliberate improvement over that accepted, smaller-cost leak.
      // Released, not removed: the last user of this build's shared
      // bundle removes it (cli-deploy-dir.ts).
      await cli.release();
    }
  };

  target.deployer = {
    capabilities,
    liveContentID: (app: string) => liveContentID(app, place.kube),
    urlFor: (app: string) => (opts ? place.serviceURL(app) : `https://${host}`),
    deployFunctions,
    buildAndDeploy: buildAndDeployApp,
    // Read at call time: callers set target.userEnv after construction.
    get userEnv() {
      return target.userEnv;
    },
    // Read at call time: the control-plane sets target.isr after construction.
    get deployIsrCache() {
      return target.isr?.enabled ? deployIsrCache : undefined;
    },
    get removeIsrCache() {
      return target.isr?.removeCache ? removeIsrCache : undefined;
    },
    providedEnvNames: () => providedEnvNames(!!opts, target.extraEnv),
  };

  return target;
}
