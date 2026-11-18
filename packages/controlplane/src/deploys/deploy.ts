// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  deploy,
  createKubernetesTarget,
  createCloudRunTarget,
  withKubeconfig,
  withGoogleCredentials,
  withDockerLogin,
  kubectlArgs,
  redact,
  hasPrerenderRoutes,
  type CommandRunner,
  type DeployResult,
  type IsrOptions,
  type ProgressOptions,
  type UserEnv,
} from "@nbo/deploy";
import { ErrInvalidEnvironmentConfig, type Store, type Environment, type Deployment } from "../store/store.js";
import { projectNamespacePrefix, renderProjectNamespace } from "../clouds/kube-bootstrap.js";
import { run } from "../builds/run.js";
import type { Mode } from "../mode.js";
import type { ResolvedEnv } from "../variables/env-vars.js";
import { environmentClusterId } from "../clouds/connections.js";
import { PULLER_NOTE, googleCredential } from "../clouds/google-wif.js";
import { variableStage } from "../stages/stages.js";
import { withRevalidateToken } from "../variables/revalidate-tokens.js";

interface CloudRunConfig {
  project?: string;
  region?: string;
  arRepo?: string;
}

// Orchestrator triggers a real deploy through @nbo/deploy's own
// deploy(), the exact same orchestration code the nbo CLI uses —
// port of Orchestrator (deploy.go lines 21-25).
export interface Orchestrator {
  store: Store;
  // mode defaults to dev: the local kind cluster, exactly as before.
  // production deploys through the stored connections instead.
  mode?: Mode;
  // run is the boundary for every kubectl/gcloud/docker call a
  // production deploy makes against a connected cloud (faked in tests).
  run?: CommandRunner;
}

// Pushes and rollouts are slow; a bounded, generous timeout still keeps
// a hung registry or cluster from wedging the build queue.
const connectedRunner: CommandRunner = (cmd, args, opts) =>
  run(cmd, args, { timeoutMs: 10 * 60_000, env: opts?.env, input: opts?.input });

// projectNamespace is the namespace a project's Kubernetes environments
// deploy into on a connected cluster: nbo-p- plus the first 8 chars of
// the project id after its last "_" (the same suffix deployAppName uses).
export function projectNamespace(projectId: string): string {
  return projectNamespacePrefix + projectSuffix(projectId);
}

function projectSuffix(projectId: string): string {
  let suffix = projectId;
  const idx = suffix.lastIndexOf("_");
  if (idx !== -1) suffix = suffix.slice(idx + 1);
  return suffix.slice(0, 8);
}

// Registry is one push session's view of a cluster's registry: where images
// go, the env (temporary docker/gcloud credentials) to push with, and the
// credentials the cluster pulls with.
export interface Registry {
  prefix: string;
  env: Record<string, string>;
  pull: { server: string; username: string; password: string };
}

interface ConnectedKubernetes {
  kubeconfig: string;
  // Everything that must never reach a deployment's recorded error.
  secrets: string[];
  // Opens a push session for the registry the connection names, for the
  // duration of fn (credentials live in a temp dir removed afterwards).
  withRegistry<T>(run: CommandRunner, fn: (r: Registry) => Promise<T>): Promise<T>;
}

// connectedKubernetes reads the connection of the environment's own
// cluster (config.clusterId; and, for Artifact Registry, the Google
// connection) and refuses — before any deployment row exists — when
// production mode has nothing to deploy through. It never falls back to
// another cluster.
function connectedKubernetes(store: Store, env: Environment): ConnectedKubernetes {
  const clusterId = environmentClusterId(env.config);
  if (!clusterId)
    throw new ErrInvalidEnvironmentConfig(
      `${env.name} has no Kubernetes cluster recorded — add the cloud again and choose a cluster`,
    );
  if (!store.getKubernetesConnection(clusterId))
    throw new ErrInvalidEnvironmentConfig(
      `the Kubernetes cluster ${env.name} runs on is no longer connected: connect it again with nbo-server connect kubernetes`,
    );
  return clusterConnection(store, clusterId);
}

// clusterConnection: a connected cluster's scoped kubeconfig and the push
// session for the registry its connection names.
function clusterConnection(store: Store, clusterId: string): ConnectedKubernetes {
  const conn = store.getKubernetesConnection(clusterId);
  if (!conn) throw new ErrInvalidEnvironmentConfig("that Kubernetes cluster is not connected");
  const ks = store.getKubernetesSecrets(conn.id);
  const kubeSecrets = kubeconfigSecrets(ks.kubeconfig);
  if (conn.registry.kind === "artifact-registry") {
    const google = store.getGoogleConnection();
    if (!google)
      throw new ErrInvalidEnvironmentConfig(
        "the Kubernetes connection pushes to Artifact Registry — connect Google Cloud first",
      );
    const gs = store.getGoogleSecrets();
    // A keyless connection whose project refused the puller key.
    if (!gs.pullerKey) throw new ErrInvalidEnvironmentConfig(PULLER_NOTE);
    const server = google.arRepo.split("/")[0]!;
    const region = server.replace(/-docker\.pkg\.dev$/, "");
    return {
      kubeconfig: ks.kubeconfig,
      secrets: [...kubeSecrets, ...googleSecrets(gs)],
      withRegistry: (run, fn) =>
        withGoogleCredentials(googleCredential(store), region, run, (ctx) =>
          fn({
            prefix: google.arRepo,
            env: ctx.env ?? {},
            pull: { server, username: "_json_key", password: gs.pullerKey },
          }),
        ),
    };
  }
  const password = ks.registryPassword;
  if (!password)
    throw new ErrInvalidEnvironmentConfig("the custom registry has no stored password — reconnect the cluster");
  const { server, username } = conn.registry;
  // A registry may be named with a path ("ghcr.io/acme"): images go
  // under the path, credentials belong to the host.
  const host = server.split("/")[0]!;
  return {
    kubeconfig: ks.kubeconfig,
    secrets: [...kubeSecrets, password],
    withRegistry: (run, fn) =>
      withDockerLogin(host, username, password, run, (ctx) =>
        fn({ prefix: server, env: ctx.env ?? {}, pull: { server: host, username, password } }),
      ),
  };
}

// withClusterRegistry opens a push session for a connected cluster's
// registry — the same path app deploys push through — for the duration of
// fn. Errors thrown out of it never carry the cluster's or registry's
// credentials.
export async function withClusterRegistry<T>(
  store: Store,
  clusterId: string,
  run: CommandRunner,
  fn: (r: Registry) => Promise<T>,
): Promise<T> {
  const conn = clusterConnection(store, clusterId);
  try {
    return await conn.withRegistry(run, fn);
  } catch (err) {
    throw new Error(redact(errorText(err), conn.secrets), { cause: err });
  }
}

// kubeconfigSecrets: the kubeconfig itself and any bearer token in it.
export function kubeconfigSecrets(kubeconfig: string): string[] {
  return [kubeconfig, ...[...kubeconfig.matchAll(/^\s*token:\s*["']?([^\s"']+)/gm)].map((m) => m[1]!)];
}

function privateKeyOf(keyJson: string): string {
  try {
    const key = (JSON.parse(keyJson) as { private_key?: unknown }).private_key;
    return typeof key === "string" ? key : "";
  } catch {
    return "";
  }
}

// googleSecrets: both service-account keys, their private keys, and the
// JSON-escaped forms (escaped newlines) that survive in logs.
export function googleSecrets(keys: { deployerKey: string; pullerKey?: string }): string[] {
  const out: string[] = [];
  for (const key of [keys.deployerKey, keys.pullerKey ?? ""]) {
    if (!key) continue;
    const pk = privateKeyOf(key);
    out.push(key, pk, JSON.stringify(key).slice(1, -1), pk ? JSON.stringify(pk).slice(1, -1) : "");
  }
  return out.filter((x) => x !== "");
}

// prerenderRoutes: does this .nbo/ list prerender routes? An unreadable or
// malformed prerender.json counts as none here; deploy()'s own validate()
// rejects it and the failure is recorded on the deployment row.
async function prerenderRoutes(nboDir: string): Promise<boolean> {
  try {
    return await hasPrerenderRoutes(nboDir);
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// deployAppName derives the actual Kubernetes/Cloud Run resource name
// from both the project and the environment, not the environment
// name alone — createEnvironment only enforces name uniqueness
// scoped to one project, so two projects can each have a
// "production" environment; without this, both would deploy to (and
// overwrite) the same Deployment/Service/Ingress or Cloud Run
// service. Kept short (a "p" plus an 8-char project suffix, a dash,
// the environment name) to leave room for @nbo/adapter-k8s's own
// "-fn-<function>" suffix under Kubernetes' 63-char label limit. The
// leading "p" is load-bearing, not decorative: a Kubernetes Service
// name is a DNS-1035 label, which — unlike a Deployment name
// (DNS-1123) — must start with a letter, and the project id's hex
// suffix can (often does) start with a digit; confirmed as a real
// deploy failure against a live cluster before this was added — port
// of deployAppName (deploy.go lines 114-123).
export function deployAppName(env: Environment): string {
  return `p${projectSuffix(env.projectId)}-${env.name}`;
}

// otherAppNames: the app names of the project's other cloud rows, every
// stage and archived ones included (their objects may still exist). A
// Kubernetes target refuses an ISR cache (`<app>-isr`) named like one.
export function otherAppNames(store: Store, env: Environment): string[] {
  return store
    .listEnvironments(env.projectId, { allStages: true, includeArchived: true })
    .filter((e) => e.id !== env.id)
    .map(deployAppName);
}

// recordDeployFailure records a failed deploy and returns the
// updated row — or throws if even recording the failure fails,
// rather than silently returning a stale "pending" row as if nothing
// happened — port of recordDeployFailure (deploy.go lines 92-97).
export function recordDeployFailure(store: Store, deploymentId: string, deployErr: unknown): Deployment {
  const deployErrMessage = deployErr instanceof Error ? deployErr.message : String(deployErr);
  try {
    store.failDeployment(deploymentId, deployErrMessage);
  } catch (failErr) {
    const failErrMessage = failErr instanceof Error ? failErr.message : String(failErr);
    throw new Error(`deploy failed (${deployErrMessage}) and recording the failure also failed: ${failErrMessage}`, {
      cause: failErr,
    });
  }
  return store.getDeployment(deploymentId);
}

// TriggerDeployOptions: progress receives timed sub-step messages; env and
// fingerprint are the build's one variable snapshot (same for every
// environment of a build).
export interface TriggerDeployOptions {
  progress?: (message: string) => void;
  env?: ResolvedEnv;
  fingerprint?: string | null;
  // buildId is the build whose .nbo/ this deploys (recorded on the row).
  buildId?: string;
  // carryFrom is the .nbo/ of the build this cloud runs now: its hashed
  // files are baked into the new app image so open pages keep working
  // during the rollout.
  carryFrom?: string;
  // redact: more values that never reach the recorded error or progress
  // (the runner's list: with names only, plain values of 6+ characters too).
  redact?: string[];
}

// triggerDeploy looks up environmentId, builds the right
// @nbo/deploy Deployer for its target, deploys nboDir, and records
// the outcome. It awaits the whole deploy before returning — a
// deliberate staging choice; a later async/queue-backed trigger
// changes what's inside this function, not its signature or its
// caller — port of Orchestrator.TriggerDeploy (deploy.go lines
// 32-87), async since @nbo/deploy's own deploy() is.
export async function triggerDeploy(
  o: Orchestrator,
  environmentId: string,
  nboDir: string,
  opts?: TriggerDeployOptions,
): Promise<Deployment> {
  const onProgress = opts?.progress;
  const env = o.store.getEnvironment(environmentId); // throws ErrNotFound if missing
  // A caller without a snapshot (the legacy deployment route) gets the
  // current variables of the cloud's own stage, exactly as the build runner
  // resolves them — deploying must never strip variables from the running app.
  const stage = env.stageId ? o.store.getStage(env.stageId) : o.store.productionStage(env.projectId);
  const snapshot = opts?.env ?? o.store.resolveEnv(env.projectId, variableStage(stage));
  // A build with prerender routes gets the stage's revalidation secret as
  // one more secret variable, before the fingerprint, the secret hashes and
  // the redaction list are computed from the snapshot. Any other build's
  // snapshot and fingerprint stay exactly the caller's, so upgrading NBO
  // doesn't make them look changed (and redeploy).
  const isr = await prerenderRoutes(nboDir);
  const resolvedEnv = isr ? withRevalidateToken(o.store, stage, snapshot) : snapshot;
  const fingerprint = isr || !opts?.env ? o.store.envFingerprintFor(resolvedEnv) : (opts.fingerprint ?? null);
  // The cache goes when the cloud's current build (carryFrom, set only when
  // it differs from this one) had prerender routes and this one has none.
  const isrOptions: IsrOptions = {
    enabled: isr,
    removeCache: !isr && !!opts?.carryFrom && (await prerenderRoutes(opts.carryFrom)),
  };
  const userEnv: UserEnv = { vars: resolvedEnv.vars, secretNames: resolvedEnv.secretNames, fingerprint };
  // Keyed hashes of the secret values: the targets compare them with a
  // label instead of ever reading a stored secret back.
  if (resolvedEnv.secretNames.length > 0) userEnv.secretHashes = o.store.envSecretHashes(resolvedEnv);
  // Backstop: the snapshot's secret values never reach a recorded error.
  const envSecretValues = [
    ...resolvedEnv.secretNames.map((n) => resolvedEnv.vars[n] ?? ""),
    ...(opts?.redact ?? []),
  ].filter((v) => v !== "");

  const appName = deployAppName(env);

  // Generated (or read back, if this environment already has one)
  // before the deployer builds its own image, so the secret can be
  // baked into /env.json via extraEnv — a container's own ENTRYPOINT
  // (and so its baked env) is fixed at image-build time, before
  // deploy() below ever runs.
  const cronSecret = o.store.ensureCronSigningSecret(environmentId);
  const extraEnv = { NBO_CRON_SIGNING_SECRET: cronSecret };

  let runDeploy: () => Promise<DeployResult>;
  let secrets: string[] = [];
  // Progress messages carry only step names and durations, but they
  // pass through the same redaction as a recorded deploy error.
  const progress: ProgressOptions | undefined = onProgress
    ? {
        onProgress: (m) => {
          const redactions = [...secrets, ...envSecretValues];
          onProgress(redactions.length ? redact(m, redactions) : m);
        },
      }
    : undefined;
  let appURLOf: (() => string) | undefined;
  switch (env.target) {
    case "kubernetes": {
      if (o.mode === "production") {
        const conn = connectedKubernetes(o.store, env);
        const cmd = o.run ?? connectedRunner;
        const ns = projectNamespace(env.projectId);
        secrets = conn.secrets;
        runDeploy = () =>
          withKubeconfig(conn.kubeconfig, ns, async (kube) => {
            // Idempotent: the namespace, its Pod Security labels and the
            // deployer RoleBinding exactly as the admission guard allows.
            await cmd("kubectl", kubectlArgs(kube, ["apply", "-f", "-"]), { input: renderProjectNamespace(ns) });
            return conn.withRegistry(cmd, async (registry) => {
              const target = createKubernetesTarget(
                appName,
                {
                  kubeconfig: kube.kubeconfig!,
                  namespace: ns,
                  registryPrefix: registry.prefix,
                  registryEnv: registry.env,
                  pullSecret: registry.pull,
                  run: cmd,
                },
                progress,
              );
              target.extraEnv = extraEnv;
              target.userEnv = userEnv;
              target.carryFrom = opts?.carryFrom;
              target.isr = isrOptions;
              target.otherAppNames = otherAppNames(o.store, env);
              return deploy(target.deployer, nboDir, appName, progress);
            });
          });
        break;
      }
      const target = createKubernetesTarget(appName, undefined, progress);
      target.extraEnv = extraEnv;
      target.userEnv = userEnv;
      target.carryFrom = opts?.carryFrom;
      target.isr = isrOptions;
      target.otherAppNames = otherAppNames(o.store, env);
      runDeploy = () => deploy(target.deployer, nboDir, appName, progress);
      break;
    }
    case "cloudrun": {
      let cfg: CloudRunConfig;
      try {
        cfg = JSON.parse(env.config) as CloudRunConfig;
      } catch {
        cfg = {};
      }
      if (!cfg.project || !cfg.region || !cfg.arRepo) {
        throw new ErrInvalidEnvironmentConfig("cloudrun environment needs project, region and arRepo");
      }
      if (o.mode === "production") {
        const google = o.store.getGoogleConnection();
        if (!google)
          throw new ErrInvalidEnvironmentConfig("Google Cloud is not connected — connect it on the setup page first");
        if (cfg.project !== google.project) {
          throw new ErrInvalidEnvironmentConfig(
            `this environment points at Google project ${cfg.project} but NBO is connected to ${google.project}`,
          );
        }
        const gs = o.store.getGoogleSecrets();
        const cmd = o.run ?? connectedRunner;
        const { project, region, arRepo } = cfg;
        secrets = googleSecrets(gs);
        let current: { appURL: string } | undefined;
        appURLOf = () => current?.appURL ?? "";
        runDeploy = () =>
          withGoogleCredentials(googleCredential(o.store), region, cmd, async (ctx) => {
            // The connection created the nbo repository only in its own
            // region; a project deployed elsewhere creates it on first use.
            if (region !== google.region) {
              const repoName = arRepo.split("/").pop()!;
              const where = ["--location", region, "--project", project];
              let missing = false;
              try {
                await cmd("gcloud", ["artifacts", "repositories", "describe", repoName, ...where], { env: ctx.env });
              } catch (err) {
                // Creating needs IAM that GCP checks before existence, so
                // only a repository that is really absent is created.
                if (!/NOT_FOUND|not found/i.test(errorText(err))) throw err;
                missing = true;
              }
              if (missing) {
                try {
                  await cmd(
                    "gcloud",
                    ["artifacts", "repositories", "create", repoName, "--repository-format", "docker", ...where],
                    { env: ctx.env },
                  );
                } catch (err) {
                  if (!/already exists|ALREADY_EXISTS/.test(errorText(err))) throw err;
                }
              }
            }
            // NBO's own deployer was granted its roles at connect time; a
            // pasted key's account was not, so errors name the missing role.
            const pasted = google.deployer !== `nbo-deployer@${google.project}.iam.gserviceaccount.com`;
            const target = createCloudRunTarget(
              project,
              region,
              arRepo,
              {
                ctx: { env: ctx.env, run: cmd },
                perServiceIdentity: true,
                ...(pasted ? { pastedKeyDeployer: google.deployer } : {}),
              },
              progress,
            );
            target.extraEnv = extraEnv;
            target.userEnv = userEnv;
            target.carryFrom = opts?.carryFrom;
            target.isr = isrOptions;
            current = target;
            return deploy(target.deployer, nboDir, appName, progress);
          });
        break;
      }
      const target = createCloudRunTarget(cfg.project, cfg.region, cfg.arRepo, undefined, progress);
      target.extraEnv = extraEnv;
      target.userEnv = userEnv;
      target.carryFrom = opts?.carryFrom;
      target.isr = isrOptions;
      runDeploy = () => deploy(target.deployer, nboDir, appName, progress);
      appURLOf = () => target.appURL;
      break;
    }
    default:
      throw new Error(`controlplane: unknown target "${env.target}"`);
  }

  const dep = o.store.createDeployment(environmentId, { buildId: opts?.buildId });

  let result;
  try {
    result = await runDeploy();
  } catch (err) {
    const redactions = [...secrets, ...envSecretValues];
    return recordDeployFailure(
      o.store,
      dep.id,
      redactions.length ? new Error(redact(errorText(err), redactions)) : err,
    );
  }
  let url = result.url;
  if (appURLOf && appURLOf() !== "") {
    url = appURLOf();
  }
  o.store.completeDeployment(dep.id, result.contentID, url);
  // Crons run on Production's clouds only: a staging app doesn't run the
  // jobs a second time.
  if (stage.kind !== "production") return o.store.getDeployment(dep.id);
  try {
    o.store.registerCronsFromManifest(environmentId, nboDir);
  } catch (err) {
    throw new Error(
      `deploy succeeded but registering crons failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return o.store.getDeployment(dep.id);
}
