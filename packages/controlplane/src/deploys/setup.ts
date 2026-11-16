// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  ErrDuplicateName,
  ErrInvalidEnvironmentConfig,
  ErrNotFound,
  type Environment,
  type Project,
  type SetupStatus,
  type Store,
} from "../store/store.js";
import type { Build } from "../git/git.js";
import type { CloudSetup } from "../clouds/cloud-setup.js";
import type { BuildTrigger } from "../git/webhooks.js";
import { isSafeOutputDir, normalizeDir } from "../git/webhooks.js";
import type { Mode } from "../mode.js";
import { lsRemoteHead, type GitRemoteOptions } from "../git/gitremote.js";
import {
  githubImportRefused,
  parseCredential,
  repoCredentialProblem,
  withGitAuth,
  type GitAuthFn,
  type GitCredentialInput,
  type GitCredentialRequest,
} from "../git/git-credentials.js";
import { defaultClusterId, environmentClusterId, type KubernetesConnection } from "../clouds/connections.js";
import { defaultHostFor, placeholderSuffix } from "../domains/hosts.js";
import { stageRowName } from "../stages/stages.js";

// clusterId (production): which connected cluster; may be left out when
// exactly one is connected. Dev mode has one local cluster and ignores it.
export type CloudChoice =
  | { target: "kubernetes"; clusterId?: string }
  | { target: "cloudrun"; mode: "auto"; region?: string }
  | { target: "cloudrun"; mode: "manual"; project: string; region: string; arRepo: string };

export interface SetupRequest {
  name: string;
  // repo: https://..., or with a deploy key ssh://git@host/path or git@host:path.
  repo: string;
  productionBranch: string;
  framework: "nextjs" | "static";
  spa: boolean;
  buildCommand: string;
  outputDir?: string;
  ignoredBuildStepCommand?: string;
  rootDirectory?: string;
  clouds: CloudChoice[];
  // skipFirstBuild: setup does everything except enqueue the first build, so
  // variables can exist before it. The Terraform provider sends it; the
  // dashboard never does. POST /projects/{id}/builds then makes the first deploy.
  skipFirstBuild?: boolean;
  // credential: how NBO reaches the repository (git-credentials.ts); a
  // public repository when left out.
  credential?: GitCredentialRequest;
}

const projectNamePattern = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const fallbackRegion = "us-central1";

// Environment names: Cloud Run is "cloudrun"; Kubernetes is "k8s" in dev
// and on the upgraded kc_default cluster (existing cloud objects keep
// their names), "k8s-<cluster name>" on any other cluster.
export function envNameFor(target: CloudChoice["target"], cluster?: KubernetesConnection): string {
  if (target === "cloudrun") return "cloudrun";
  return !cluster || cluster.id === defaultClusterId ? "k8s" : `k8s-${cluster.name}`;
}

const clusterIdPattern = /^kc_[a-z0-9]{1,32}$/;

function invalid(message: string): never {
  throw new ErrInvalidEnvironmentConfig(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

// GCP formats, allow-listed: these strings become gcloud/docker
// arguments, so nothing flag-shaped and no registry host other than the
// region's own Artifact Registry may get through.
const gcpRegion = /^[a-z]+-[a-z]+\d+$/;
const gcpProject = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const arRepoName = /^[a-z0-9][a-z0-9._-]*$/;

// parseCloudChoice validates one untrusted cloud choice.
export function parseCloudChoice(raw: unknown): CloudChoice {
  if (!isRecord(raw)) invalid("each cloud must be an object with a target");
  if (raw.target === "kubernetes") {
    if (raw.clusterId === undefined) return { target: "kubernetes" };
    if (typeof raw.clusterId !== "string" || !clusterIdPattern.test(raw.clusterId))
      invalid("clusterId must be a connected cluster's id (kc_…)");
    return { target: "kubernetes", clusterId: raw.clusterId };
  }
  if (raw.target !== "cloudrun")
    invalid(`unknown cloud target ${JSON.stringify(raw.target)} (known: kubernetes, cloudrun)`);
  if (raw.mode === "auto") {
    if (raw.region !== undefined && (typeof raw.region !== "string" || !gcpRegion.test(raw.region)))
      invalid("region must look like us-central1");
    return raw.region === undefined
      ? { target: "cloudrun", mode: "auto" }
      : { target: "cloudrun", mode: "auto", region: raw.region as string };
  }
  if (raw.mode === "manual") {
    for (const key of ["project", "region", "arRepo"] as const) {
      if (!nonEmpty(raw[key])) invalid(`manual Cloud Run setup needs ${key}`);
    }
    const project = raw.project as string;
    const region = raw.region as string;
    if (!gcpProject.test(project))
      invalid("project must be a GCP project id: 6–30 lowercase letters, digits or hyphens, starting with a letter");
    if (!gcpRegion.test(region)) invalid("region must look like us-central1");
    const prefix = `${region}-docker.pkg.dev/${project}/`;
    const arRepo = raw.arRepo as string;
    if (!arRepo.startsWith(prefix) || !arRepoName.test(arRepo.slice(prefix.length)))
      invalid(`arRepo must be ${prefix}<repository>`);
    return {
      target: "cloudrun",
      mode: "manual",
      project: raw.project as string,
      region: raw.region as string,
      arRepo: raw.arRepo as string,
    };
  }
  invalid('cloudrun mode must be "auto" or "manual"');
}

// parseSetupRequest validates an untrusted setup body, throwing
// ErrInvalidEnvironmentConfig (→ 400) with the exact rule broken.
export function parseSetupRequest(raw: unknown): SetupRequest {
  if (!isRecord(raw)) invalid("request body must be a JSON object");
  if (typeof raw.name !== "string" || !projectNamePattern.test(raw.name)) {
    invalid(
      "name must be lowercase letters, numbers and hyphens, up to 40 characters, starting and ending with a letter or number",
    );
  }
  // An environment's host is <environment>--<project>, so a project name with "--" could collide with it.
  // (Projects made before this rule keep their names.)
  if (raw.name.includes("--")) invalid('name can\'t contain "--" (two hyphens in a row)');
  if (raw.github !== undefined) invalid(githubImportRefused);
  let credential: GitCredentialRequest | undefined;
  try {
    credential = parseCredential(raw.credential);
  } catch (err) {
    invalid(err instanceof Error ? err.message : String(err));
  }
  if (typeof raw.repo !== "string") invalid("repo is required");
  const problem = repoCredentialProblem(raw.repo, credential?.kind ?? "public");
  if (problem) invalid(problem);
  if (!nonEmpty(raw.productionBranch)) invalid("productionBranch is required");
  if (raw.framework !== "nextjs" && raw.framework !== "static") invalid('framework must be "nextjs" or "static"');
  if (!nonEmpty(raw.buildCommand)) invalid("buildCommand is required");
  if (raw.outputDir !== undefined && (typeof raw.outputDir !== "string" || !isSafeOutputDir(raw.outputDir))) {
    invalid('outputDir must be a plain path relative to the repository root, with no ".." segment');
  }
  if (raw.ignoredBuildStepCommand !== undefined && typeof raw.ignoredBuildStepCommand !== "string")
    invalid("ignoredBuildStepCommand must be a string");
  if (
    raw.rootDirectory !== undefined &&
    (typeof raw.rootDirectory !== "string" ||
      (raw.rootDirectory !== "" && !isSafeOutputDir(normalizeDir(raw.rootDirectory))))
  ) {
    invalid('rootDirectory must be a folder inside the repository, like apps/web, with no ".." segment');
  }
  if (raw.skipFirstBuild !== undefined && typeof raw.skipFirstBuild !== "boolean")
    invalid("skipFirstBuild must be true or false");
  const clouds = parseClouds(raw.clouds);
  return {
    name: raw.name,
    repo: raw.repo,
    productionBranch: raw.productionBranch,
    framework: raw.framework,
    spa: raw.spa === true,
    buildCommand: raw.buildCommand,
    outputDir: raw.outputDir as string | undefined,
    ignoredBuildStepCommand: raw.ignoredBuildStepCommand ? (raw.ignoredBuildStepCommand as string) : undefined,
    rootDirectory:
      typeof raw.rootDirectory === "string" && raw.rootDirectory !== "" ? normalizeDir(raw.rootDirectory) : undefined,
    clouds,
    ...(raw.skipFirstBuild === true ? { skipFirstBuild: true } : {}),
    ...(credential ? { credential } : {}),
  };
}

// cloudKey: one environment per (target, cluster) — Cloud Run once,
// each Kubernetes cluster once.
function cloudKey(c: CloudChoice): string {
  return c.target === "kubernetes" ? `kubernetes:${c.clusterId ?? ""}` : "cloudrun";
}

const maxClouds = 10;

export function parseClouds(raw: unknown): CloudChoice[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > maxClouds)
    invalid(`clouds must list one to ${maxClouds} clouds`);
  const clouds = raw.map(parseCloudChoice);
  if (new Set(clouds.map(cloudKey)).size !== clouds.length)
    invalid("each cloud (and each Kubernetes cluster) may appear only once");
  return clouds;
}

// setupConfig is mutable so tests can shorten the waits. A deploy-key project
// whose first read is refused waits for the key: every poll for keyWaitFastMs,
// then at most every keyWaitEveryMs, giving up after keyWaitMaxMs.
export const setupConfig = { keyWaitFastMs: 3_600_000, keyWaitEveryMs: 600_000, keyWaitMaxMs: 7 * 24 * 3_600_000 };

// firstLine: git's first line is the reason; the rest is advice.
function firstLine(message: string): string {
  return message.split(String.fromCharCode(10))[0]?.trim() || message;
}

export interface SetupDeps {
  store: Store;
  cloudSetup: CloudSetup;
  queue: BuildTrigger;
  lsRemote?: (repo: string, branch: string, opts?: GitRemoteOptions) => Promise<string>;
  // gitAuth: the project's ls-remote carries its git credential.
  gitAuth?: GitAuthFn;
  // production builds a Cloud Run environment from the Google connection
  // instead of the operator's own gcloud (default dev).
  mode?: Mode;
  // now: the clock the key wait is read against (Date.now by default).
  now?: () => number;
}

export interface Setup {
  // start: credential is what to store for req.credential (the route makes
  // a deploy key's pair first); it is stored before the background work
  // reads the repository.
  start(req: SetupRequest, credential?: GitCredentialInput): Project;
  retry(projectId: string, clouds?: CloudChoice[]): Project;
  // addCloud adds a cloud row to Production, or with stageId to that
  // custom stage (named by stageRowName, crons off: they run on Production).
  addCloud(projectId: string, cloud: CloudChoice, opts?: { stageId?: string }): Promise<Environment>;
  // existingEnvironmentFor: the stage's (Production's by default) live
  // environment for this choice (same target, and in production the same
  // resolved cluster), if any. Throws (400) when the choice names no usable cluster.
  existingEnvironmentFor(projectId: string, cloud: CloudChoice, opts?: { stageId?: string }): Environment | undefined;
  // checkKey retries the first read of a waiting-for-key project (provisions
  // nothing): ready and the first build queued when the key works. Throttled
  // unless force. Any other project just reports its status.
  checkKey(projectId: string, opts?: { force?: boolean }): Promise<{ setupStatus: SetupStatus; queued: Build | null }>;
  // settled resolves when the project's background setup (if any) ends.
  settled(projectId: string): Promise<void>;
}

// createSetup turns one Deploy click into: project + git config now,
// then (in the background) each chosen cloud provisioned, the branch
// head resolved, and the first build queued. A failure leaves the
// project in "needs-setup" with the real error and keeps everything
// created so far, so Retry picks up where it stopped.
export function createSetup(deps: SetupDeps): Setup {
  const { store, cloudSetup, queue } = deps;
  const lsRemote =
    deps.lsRemote ?? ((repo: string, branch: string, opts?: GitRemoteOptions) => lsRemoteHead(repo, branch, opts));
  const pending = new Map<string, CloudChoice[]>();
  const now = deps.now ?? Date.now;
  // When each waiting project was last tried (memory only: a restart tries once more).
  const lastKeyTry = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  // resolveCluster picks the production cluster a Kubernetes choice
  // means (dev mode: none — the local kind cluster).
  function resolveCluster(cloud: CloudChoice): KubernetesConnection | undefined {
    if (cloud.target !== "kubernetes" || deps.mode !== "production") return undefined;
    const clusters = store.listKubernetesConnections();
    if (clusters.length === 0)
      invalid("Kubernetes is not connected: connect a cluster first with nbo-server connect kubernetes");
    if (cloud.clusterId === undefined) {
      if (clusters.length > 1) invalid(`choose a Kubernetes cluster: ${clusters.map((c) => c.name).join(", ")}`);
      return clusters[0]!;
    }
    const found = clusters.find((c) => c.id === cloud.clusterId);
    if (!found) invalid(`Kubernetes cluster ${cloud.clusterId} is not connected`);
    return found;
  }

  // resolveClouds checks every choice before anything is created: each
  // Kubernetes choice names a connected cluster (filled in when only one
  // is connected), and no resolved cloud appears twice.
  function resolveClouds(clouds: CloudChoice[]): CloudChoice[] {
    const resolved = clouds.map((c): CloudChoice => {
      const cluster = resolveCluster(c);
      return cluster ? { target: "kubernetes", clusterId: cluster.id } : c;
    });
    if (new Set(resolved.map(cloudKey)).size !== resolved.length)
      invalid("each cloud (and each Kubernetes cluster) may appear only once");
    return resolved;
  }

  function existingFor(
    projectId: string,
    cloud: CloudChoice,
    cluster: KubernetesConnection | undefined,
    stageId?: string,
  ): Environment | undefined {
    return store
      .listEnvironments(projectId, stageId ? { stageId } : undefined)
      .find(
        (e) =>
          e.target === cloud.target &&
          (cloud.target !== "kubernetes" || environmentClusterId(e.config) === cluster?.id),
      );
  }

  async function provisionEnvironment(projectId: string, cloud: CloudChoice, stageId?: string): Promise<Environment> {
    const stage = stageId ? store.getStage(stageId) : undefined;
    if (stage && stage.projectId !== projectId)
      throw new ErrNotFound(`environment "${stage.id}" in project "${projectId}"`);
    if (stage && stage.kind !== "custom" && stage.kind !== "production" && stage.kind !== "ephemeral") {
      invalid(`the ${stage.name} environment holds variables only and has no clouds`);
    }
    // An ephemeral stage is provisioned exactly like a custom stage: its own
    // s-pv-<id>-<slot> row, crons off. Never Production's rows or names.
    const custom = stage?.kind === "custom" || stage?.kind === "ephemeral" ? stage : undefined;
    const existing = store.listEnvironments(projectId, custom ? { stageId: custom.id } : undefined);
    const cluster = resolveCluster(cloud);
    if (existingFor(projectId, cloud, cluster, custom?.id)) {
      const where = custom ? `the ${custom.name} environment` : "this project";
      throw new ErrDuplicateName(
        cluster
          ? `${where} already runs on ${cluster.name}`
          : `${custom ? where : "project"} already has a ${cloud.target} environment`,
      );
    }
    const name = custom
      ? stageRowName(custom, cluster ? { target: cloud.target, clusterId: cluster.id } : { target: cloud.target })
      : envNameFor(cloud.target, cluster);
    // Coming back to a cloud this project used before revives that
    // archived environment (same id and name, so the cloud objects keep
    // their names); createEnvironment also revives by name, e.g. a
    // cluster reconnected under the same name with a new id.
    const archived = store
      .listEnvironments(projectId, { includeArchived: true, ...(custom ? { stageId: custom.id } : {}) })
      .find(
        (e) =>
          e.archived &&
          e.target === cloud.target &&
          (cloud.target !== "kubernetes" || environmentClusterId(e.config) === cluster?.id),
      );
    const create = (target: "kubernetes" | "cloudrun", config: string): Environment =>
      archived
        ? store.reviveEnvironment(archived.id, config)
        : store.createEnvironment(projectId, name, target, config, custom?.id);
    // Crons run in exactly one environment: Production's first.
    const cronsEnabled = !custom && existing.length === 0;
    if (cloud.target === "kubernetes") {
      return create("kubernetes", JSON.stringify(cluster ? { cronsEnabled, clusterId: cluster.id } : { cronsEnabled }));
    }
    if (deps.mode === "production" && cloud.mode === "manual") {
      invalid("in production, Cloud Run uses the connected Google Cloud project — choose the automatic option");
    }
    if (cloud.mode === "manual") {
      return create(
        "cloudrun",
        JSON.stringify({ project: cloud.project, region: cloud.region, arRepo: cloud.arRepo, cronsEnabled }),
      );
    }
    if (deps.mode === "production") {
      const google = store.getGoogleConnection();
      if (!google) invalid("Google Cloud is not connected — connect it on the setup page first");
      const region = cloud.region ?? google.region;
      const repo = google.arRepo.split("/").pop()!;
      const cfg = { project: google.project, region, arRepo: `${region}-docker.pkg.dev/${google.project}/${repo}` };
      return create("cloudrun", JSON.stringify({ ...cfg, cronsEnabled }));
    }
    const pf = await cloudSetup.preflight();
    if (!pf.gcloud.ready || !pf.gcloud.project) throw new Error(pf.gcloud.reason ?? "gcloud is not ready");
    if (!pf.docker.ready) throw new Error(pf.docker.reason ?? "Docker is not ready");
    const region = cloud.region ?? pf.gcloud.region ?? fallbackRegion;
    const cfg = await cloudSetup.ensureCloudRun(pf.gcloud.project, region);
    return create("cloudrun", JSON.stringify({ ...cfg, cronsEnabled }));
  }

  // completeSetup records the head as seen (polling must not build it
  // itself), clears the wait and the skip flag, and builds it unless asked not to.
  function completeSetup(projectId: string, head: string): Build | null {
    const skip = store.getProject(projectId).skipFirstBuild;
    store.updateProject(projectId, {
      lastSeenSha: head,
      setupStatus: "ready",
      setupError: "",
      keyWaitSince: "",
      skipFirstBuild: false,
    });
    lastKeyTry.delete(projectId);
    return skip ? null : queue.enqueue(projectId, head);
  }

  async function finish(projectId: string): Promise<void> {
    let headReadFailed = false;
    try {
      for (const cloud of pending.get(projectId) ?? []) {
        if (existingFor(projectId, cloud, resolveCluster(cloud))) continue;
        await provisionEnvironment(projectId, cloud);
      }
      if (store.listEnvironments(projectId).length === 0) throw new Error("choose where this project runs, then retry");
      const git = store.getGitConfig(projectId);
      headReadFailed = true;
      const head = await withGitAuth(deps.gitAuth, projectId, git, (env) =>
        lsRemote(git.repo, git.productionBranch, env ? { env } : undefined),
      );
      headReadFailed = false;
      pending.delete(projectId);
      completeSetup(projectId, head);
    } catch (err) {
      try {
        const message = err instanceof Error ? err.message : String(err);
        // A deploy key that isn't on the repository yet isn't a failure: the
        // poll retries the read. Provisioning failures stay needs-setup.
        if (
          headReadFailed &&
          store.getGitCredential(projectId)?.kind === "deploy-key" &&
          store.getProject(projectId).lastSeenSha === ""
        ) {
          store.updateProject(projectId, {
            setupStatus: "waiting-for-key",
            setupError: firstLine(message),
            keyWaitSince: new Date(now()).toISOString(),
          });
        } else {
          store.updateProject(projectId, { setupStatus: "needs-setup", setupError: message });
        }
      } catch {
        // store closed — nothing to record
      }
    }
  }

  function launch(projectId: string): void {
    const run = finish(projectId);
    inFlight.set(projectId, run);
    void run.finally(() => {
      if (inFlight.get(projectId) === run) inFlight.delete(projectId);
    });
  }

  return {
    start(req, credential) {
      const valid = parseSetupRequest(req);
      // A token is stored as given; a deploy key's pair is made by the caller.
      if (valid.credential?.kind === "token") credential ??= valid.credential;
      if (valid.credential?.kind === "deploy-key" && credential?.kind !== "deploy-key")
        invalid("a deploy key needs its key pair made first");
      const repo = valid.repo;
      const productionBranch = valid.productionBranch;
      const clouds = resolveClouds(valid.clouds);
      // The default host: <name>.127.0.0.1.sslip.io in dev (unchanged);
      // in production the edge's host, which with an edge installed is
      // also the project's "default" domain row (DNS check, certificate).
      const settings = store.getServerSettings();
      const mode = deps.mode ?? "dev";
      const { host, needsBaseDomain } = defaultHostFor(valid.name, settings, mode);
      const recordDomain =
        mode === "production" && settings.edgeClusterId !== "" && !needsBaseDomain && !host.endsWith(placeholderSuffix);
      if (recordDomain && store.listDomains().some((d) => d.host === host))
        throw new ErrDuplicateName(`the domain "${host}" is already in use`);
      const created = store.createProject(valid.name);
      if (recordDomain) {
        try {
          store.addDomain(created.id, host, "default");
        } catch (err) {
          // An address the domain rules reject (an IPv6 edge dashed into a
          // label edge): the project still routes on its host, just
          // without a certificate.
          console.error(
            `control-plane: project ${valid.name}: default domain ${host} not recorded: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const project = store.updateProject(created.id, { edgeHost: host, setupStatus: "provisioning", setupError: "" });
      store.setGitConfig(project.id, {
        repo,
        productionBranch,
        framework: valid.framework,
        buildCommand: valid.buildCommand,
        outputDir: valid.framework === "static" ? (valid.outputDir ?? "dist") : undefined,
        spa: valid.spa,
        ignoredBuildStepCommand: valid.ignoredBuildStepCommand,
        rootDirectory: valid.rootDirectory,
      });
      if (credential && credential.kind !== "public") store.setGitCredential(project.id, credential);
      pending.set(project.id, clouds);
      if (valid.skipFirstBuild) store.updateProject(project.id, { skipFirstBuild: true });
      launch(project.id);
      return project;
    },

    retry(projectId, clouds) {
      if (inFlight.has(projectId)) return store.getProject(projectId);
      if (clouds) pending.set(projectId, resolveClouds(parseClouds(clouds)));
      const project = store.updateProject(projectId, { setupStatus: "provisioning", setupError: "" });
      launch(projectId);
      return project;
    },

    addCloud(projectId, cloud, opts) {
      store.getProject(projectId);
      return provisionEnvironment(projectId, parseCloudChoice(cloud), opts?.stageId);
    },

    existingEnvironmentFor(projectId, cloud, opts) {
      return existingFor(projectId, cloud, resolveCluster(cloud), opts?.stageId);
    },

    async checkKey(projectId, opts) {
      const project = store.getProject(projectId);
      if (project.setupStatus !== "waiting-for-key") return { setupStatus: project.setupStatus, queued: null };
      // A setup retry in flight completes setup itself (and honours skipFirstBuild).
      if (inFlight.has(projectId)) return { setupStatus: project.setupStatus, queued: null };
      const at = now();
      const since = Date.parse(project.keyWaitSince);
      const waited = Number.isNaN(since) ? 0 : at - since;
      if (waited > setupConfig.keyWaitMaxMs) {
        const git = store.getGitConfig(projectId);
        store.updateProject(projectId, {
          setupStatus: "needs-setup",
          setupError: `NBO never got read access to ${git.repo}. Add the deploy key, then retry setup.`,
          keyWaitSince: "",
        });
        lastKeyTry.delete(projectId);
        return { setupStatus: "needs-setup", queued: null };
      }
      const last = lastKeyTry.get(projectId);
      if (
        !opts?.force &&
        waited > setupConfig.keyWaitFastMs &&
        last !== undefined &&
        at - last < setupConfig.keyWaitEveryMs
      ) {
        return { setupStatus: "waiting-for-key", queued: null };
      }
      lastKeyTry.set(projectId, at);
      const git = store.getGitConfig(projectId);
      let head: string;
      try {
        head = await withGitAuth(deps.gitAuth, projectId, git, (env) =>
          lsRemote(git.repo, git.productionBranch, env ? { env } : undefined),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.updateProject(projectId, { setupError: firstLine(message) });
        return { setupStatus: "waiting-for-key", queued: null };
      }
      // A retry (or another read) may have moved the project on during ls-remote:
      // only a project still waiting is completed here, so the first build is queued once.
      const after = store.getProject(projectId).setupStatus;
      if (after !== "waiting-for-key" || inFlight.has(projectId)) return { setupStatus: after, queued: null };
      const queued = completeSetup(projectId, head);
      return { setupStatus: "ready", queued };
    },

    async settled(projectId) {
      await inFlight.get(projectId);
    },
  };
}
