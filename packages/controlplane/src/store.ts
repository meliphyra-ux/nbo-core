// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { ErrNotFound, ErrDuplicateName, ErrInvalidEnvironmentConfig, ErrInvalidGitConfig, ErrInvalidEnvVar } from "./errors.js";
import { cronsSchema, attachCronMethods, type CronRow } from "./cron.js";
import { gitSchema, attachGitMethods, type GitConfig, type Build, type BuildDetailsPatch } from "./git.js";
import { removeArtifactsSync } from "./artifacts.js";
import {
  connectionsSchema,
  attachConnectionMethods,
  type GoogleConnection,
  type KubernetesConnection,
  type KubernetesConnectionInput,
  type GoogleSecrets,
  type KubernetesSecrets,
} from "./connections.js";
import { envVarsSchema, attachEnvMethods, type EnvVarView, type ProjectEnvVarView, type ResolvedEnv } from "./env-vars.js";
import { migrate, legacyTablesInUse } from "./migrate.js";
import { serverSettingsSchema, attachServerSettingsMethods, type EdgeJob, type PendingCert, type ServerSettings, type ServerSecretName } from "./server-settings.js";
import { domainsSchema, attachDomainMethods, type Domain, type DomainPatch } from "./domains.js";
import { relaysSchema, attachRelayMethods, type Relay, type RelayInput } from "./relays.js";
import { revalidateTokensSchema, attachRevalidateTokenMethods, type RevalidateToken } from "./revalidate-tokens.js";
import { apiTokensSchema, attachApiTokenMethods, type ApiToken } from "./api-tokens.js";
import { stagesSchema, attachStageMethods, insertBuiltInStages, type Stage, type StagePatch } from "./stages.js";
import { attachGitHeadMethods, type GitHeadsStore } from "./git-heads.js";
import { gitCredentialsSchema, attachGitCredentialMethods, type GitCredentialsStore } from "./git-credentials.js";
import { ephemeralCertsSchema, attachEphemeralCertMethods, type EphemeralCertsStore } from "./ephemeral-certs.js";

export { ErrNotFound, ErrDuplicateName, ErrInvalidEnvironmentConfig, ErrInvalidGitConfig, ErrInvalidEnvVar };

export type SetupStatus = "provisioning" | "ready" | "needs-setup";

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  edgeHost: string;
  pollingEnabled: boolean;
  lastSeenSha: string;
  setupStatus: SetupStatus;
  setupError: string;
  // Speed Insights (off by default): whether the edge collects Web
  // Vitals, inserts the script itself, and what share of visits report.
  speedInsights: boolean;
  speedInsightsInject: boolean;
  speedInsightsSampleRate: number;
  // When the GitHub webhook last delivered anything ("" = never).
  lastWebhookAt: string;
}

export type ProjectPatch = Partial<
  Pick<Project, "edgeHost" | "pollingEnabled" | "lastSeenSha" | "setupStatus" | "setupError" | "speedInsights" | "speedInsightsInject" | "speedInsightsSampleRate" | "lastWebhookAt">
>;

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  target: string;
  config: string;
  createdAt: string;
  trafficWeight: number;
  archived: boolean;
  // autoDeploy: new-commit builds deploy here (default on); off keeps
  // the build last deployed here until one is chosen by hand.
  autoDeploy: boolean;
  // stageId: the stage (stages.ts) this cloud row belongs to.
  stageId: string;
}

export interface Deployment {
  id: string;
  environmentId: string;
  contentId: string;
  status: string;
  url: string;
  error: string;
  createdAt: string;
  // buildId is the build whose stored .nbo/ was deployed ("" for
  // deployments made before NBO recorded it).
  buildId: string;
}

export type TransferStatus = "provisioning" | "building" | "shifting" | "done" | "failed" | "cancelled";

export interface Transfer {
  id: string;
  projectId: string;
  fromEnvId: string;
  toEnvId: string;
  status: TransferStatus;
  weight: number;
  error: string;
  createdAt: string;
}

// GitHeadsStore: the last seen branch heads (git-heads.ts). GitCredentialsStore:
// each project's way into its repository (git-credentials.ts).
export interface Store extends GitHeadsStore, GitCredentialsStore, EphemeralCertsStore {
  close(): void;
  // The tables of features that moved to the hosted dashboard that still
  // hold rows in this database (migrate.ts); kept, never used.
  legacyTablesInUse(): string[];
  createProject(name: string): Project;
  listProjects(): Project[];
  getProject(id: string): Project;
  updateProject(id: string, patch: ProjectPatch): Project;
  // deleteProject removes the project and every row under it, atomically.
  deleteProject(id: string): void;
  // createEnvironment adds a cloud row to stageId's stage (Production when
  // omitted).
  createEnvironment(projectId: string, name: string, target: string, config?: string, stageId?: string): Environment;
  // listEnvironments: Production's rows unless stageId names another stage
  // or allStages asks for every row.
  listEnvironments(projectId: string, options?: { includeArchived?: boolean; stageId?: string; allStages?: boolean }): Environment[];
  getEnvironment(id: string): Environment;
  updateEnvironmentConfig(id: string, config: string): void;
  // setTrafficWeights sets the split of stageId's clouds (Production's when
  // omitted); a weight for another stage's row is ErrNotFound.
  setTrafficWeights(projectId: string, weights: Record<string, number>, stageId?: string): void;
  archiveEnvironment(id: string): void;
  // reviveEnvironment brings an archived environment back (adding the
  // same cloud again): un-archived, weight 0, new config, deploying new
  // commits again; id and name stay, so cloud object names stay the same.
  // Its deployments from before are no longer listed (nothing it ran
  // then counts as live).
  reviveEnvironment(id: string, config: string): Environment;
  setEnvironmentAutoDeploy(id: string, on: boolean): void;
  createDeployment(environmentId: string, opts?: { buildId?: string }): Deployment;
  completeDeployment(id: string, contentId: string, url: string): void;
  failDeployment(id: string, errMsg: string): void;
  listDeployments(environmentId: string): Deployment[];
  getDeployment(id: string): Deployment;
  createTransfer(projectId: string, fromEnvId: string, toEnvId: string): Transfer;
  updateTransfer(id: string, patch: Partial<Pick<Transfer, "status" | "weight" | "error" | "toEnvId">>): Transfer;
  getTransfer(id: string): Transfer;
  getActiveTransfer(projectId: string): Transfer | undefined;
  getLatestTransfer(projectId: string): Transfer | undefined;

  // Cron extensions — implemented by cron.ts's attachCronMethods (see
  // createStore below), kept here so callers see one Store type.
  setCronSigningSecret(environmentId: string, secret: string): void;
  getCronSigningSecret(environmentId: string): string;
  ensureCronSigningSecret(environmentId: string): string;
  registerCronsFromManifest(environmentId: string, nboDir: string): void;
  dueCrons(now: Date): CronRow[];
  claimCron(environmentId: string, cronId: string): boolean;
  releaseNextRunOnly(environmentId: string, cronId: string, next: Date): void;
  releaseCron(environmentId: string, cronId: string, ranAt: Date, next: Date): void;

  // Git/build extensions — implemented by git.ts's attachGitMethods.
  setGitConfig(projectId: string, config: GitConfig): void;
  getGitConfig(projectId: string): GitConfig;
  ensureWebhookSecret(projectId: string): string;
  createBuild(projectId: string, revision: string): Build;
  // createQueuedBuild: stageId defaults to the project's Production stage.
  createQueuedBuild(projectId: string, revision: string, opts?: { manual?: boolean; stageId?: string }): Build;
  startBuild(id: string): void;
  appendBuildLog(id: string, text: string): void;
  completeBuild(id: string, status: "skipped" | "succeeded" | "failed", deploymentIds?: string[], errMsg?: string): void;
  // setBuildDetails records details captured during a build (build page).
  setBuildDetails(id: string, patch: BuildDetailsPatch): void;
  // findQueuedBuild: the stage's newest queued commit build (not a promote job).
  findQueuedBuild(projectId: string, stageId: string): Build | undefined;
  // nextQueuedJob: the next queued job of either kind (queue order):
  // Production's first, then other stages', each oldest first.
  nextQueuedJob(projectId: string): Build | undefined;
  // createQueuedPromote records a queued job deploying sourceBuildId's
  // stored output to environmentId.
  createQueuedPromote(projectId: string, sourceBuildId: string, environmentId: string): Build;
  findRunningBuild(projectId: string): Build | undefined;
  listBuilds(projectId: string): Build[];
  getBuild(id: string): Build;

  // Platform connections — implemented by connections.ts's attachConnectionMethods.
  setSecretKey(key: Buffer): void;
  hasSealedSecrets(): boolean;
  verifySecretKey(): void;
  getGoogleConnection(): GoogleConnection | null;
  getGoogleSecrets(): GoogleSecrets;
  saveGoogleConnection(c: Omit<GoogleConnection, "kind" | "createdAt" | "status" | "lastChecked" | "lastError">, s: GoogleSecrets): GoogleConnection;
  // Kubernetes: any number of named clusters, keyed by id (kc_...).
  listKubernetesConnections(): KubernetesConnection[];
  getKubernetesConnection(id: string): KubernetesConnection | null;
  getKubernetesSecrets(id: string): KubernetesSecrets;
  // Without id: a new connection (name must be unused). With id: replaces
  // that connection's settings and secrets (ErrNotFound if absent).
  saveKubernetesConnection(c: KubernetesConnectionInput, s: KubernetesSecrets): KubernetesConnection;
  // The load balancer annotations detected from a cluster's nodes with admin
  // credentials ({} = nothing to add, null = never detected). Not secret.
  getClusterLbAnnotations(id: string): Record<string, string> | null;
  setClusterLbAnnotations(id: string, annotations: Record<string, string>): void;
  deleteKubernetesConnection(id: string): void;
  // id names the cluster for a Kubernetes check (required there).
  recordConnectionCheck(kind: "google" | "kubernetes", error: string | null, id?: string): void;
  deleteConnection(kind: "google"): void;
  environmentsUsing(kind: "google"): { projectName: string; environmentId: string }[];
  // Non-archived Kubernetes environments whose config.clusterId is id.
  environmentsUsingCluster(id: string): { projectName: string; environmentId: string }[];

  // Platform settings and domains — platform.ts / domains.ts.
  getServerSettings(): ServerSettings;
  updateServerSettings(patch: Partial<ServerSettings>): ServerSettings;
  getServerSecret(name: ServerSecretName): string | undefined;
  // The latest edge job per key ("edge", "relay:<clusterId>").
  getEdgeJob(key: string): EdgeJob | undefined;
  setEdgeJob(key: string, job: EdgeJob): void;
  setServerSecret(name: ServerSecretName, value: string): void;
  // A sealed issued-but-unwritten certificate per domain (removed with the domain).
  getPendingCert(domainId: string): PendingCert | undefined;
  setPendingCert(domainId: string, cert: PendingCert | null): void;
  // A sealed operator-pasted origin certificate per domain (removed with the domain).
  getPastedCert(domainId: string): PendingCert | undefined;
  setPastedCert(domainId: string, cert: PendingCert | null): void;
  addDomain(projectId: string, host: string, kind: Domain["kind"], serving?: Domain["serving"], stageId?: string): Domain;
  listDomains(projectId?: string): Domain[];
  getDomain(id: string): Domain;
  updateDomain(id: string, patch: DomainPatch): Domain;
  deleteDomain(id: string): void;
  // Relays (relays.ts): one per non-edge cluster that runs projects.
  getRelay(clusterId: string): Relay | null;
  saveRelay(record: RelayInput): void;
  // Revalidation secrets (revalidate-tokens.ts): one sealed secret per stage.
  getRevalidateToken(stageId: string): RevalidateToken | undefined;
  ensureRevalidateToken(stageId: string): RevalidateToken;
  rotateRevalidateToken(stageId: string): RevalidateToken;
  // API tokens (api-tokens.ts): only a sha256 of each token is stored.
  createApiToken(name: string): { token: ApiToken; secret: string };
  listApiTokens(): ApiToken[];
  deleteApiToken(id: string): void;
  findApiToken(secret: string): ApiToken | null;
  touchApiToken(id: string): void;

  // Stages (stages.ts): Production, Preview, Development, custom ones and
  // ephemeral ones (only with includeEphemeral).
  listStages(projectId: string, opts?: { includeEphemeral?: boolean }): Stage[];
  getStage(id: string): Stage;
  getStageByName(projectId: string, name: string): Stage;
  productionStage(projectId: string): Stage;
  createStage(projectId: string, input: { name: string; branch: string; autoDeploy?: boolean; host: string }): Stage;
  // createEphemeralStage makes an ephemeral stage (pv-<8 hex>); the caller checks host and branch.
  createEphemeralStage(projectId: string, input: { branch: string; host: string; expiresAt: string; label: string }): Stage;
  updateStage(id: string, patch: StagePatch): Stage;
  // deleteStage removes a custom stage and its cloud rows (not built-ins).
  deleteStage(id: string): void;
  // discardEphemeralStage undoes a createEphemeralStage that never built.
  discardEphemeralStage(id: string): void;

  // Environment variables — implemented by env-vars.ts attachEnvMethods.
  listWorkspaceEnv(): EnvVarView[];
  listProjectEnv(projectId: string): ProjectEnvVarView[];
  // value null declares the name without a value.
  setEnv(scope: { projectId: string | null }, name: string, value: string | null, secret: boolean, stage?: string): EnvVarView;
  deleteEnv(scope: { projectId: string | null }, name: string, stage?: string): void;
  // supplied: the values a deploy request brought (names only). Throws
  // ErrInvalidEnvVar naming missing or undeclared variables, or when values
  // come while NBO stores them.
  resolveEnv(projectId: string, stage?: string, supplied?: Record<string, string>): ResolvedEnv;
  // declaredEnvNames: every variable name that applies to a stage, valued or not.
  declaredEnvNames(projectId: string, stage?: string): string[];
  // clearStoredValues turns "Don't store variable values" on: blanks every
  // value and saves the setting, in one transaction.
  clearStoredValues(): void;
  envFingerprintFor(env: ResolvedEnv): string | null;
  envSecretHashes(env: ResolvedEnv): Record<string, string>;
}

export const baseSchema = `
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS environments (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	target TEXT NOT NULL,
	config TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS deployments (
	id TEXT PRIMARY KEY,
	environment_id TEXT NOT NULL REFERENCES environments(id),
	content_id TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL,
	url TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
`;

// newID returns a short, opaque, collision-resistant id for a new row.
function newID(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowUTC(): string {
  return new Date().toISOString();
}

// validEnvironmentName matches a conservative DNS-1123-label-shaped
// name, capped well under Kubernetes' 63-char label limit (and Cloud
// Run's matching service-name limit) to leave room for a
// "<projectSuffix>-" prefix and a "-fn-<function>" suffix once this
// name is combined into an actual deploy target name
// (@nbo/controlplane's own deployAppName). On Kubernetes a combined
// name still over 63 is shortened with a hash (@nbo/adapter-k8s
// kubeName); "<app>-fn-" itself always fits within the 54 characters
// kubeName keeps, so a function's name still starts with it.
const validEnvironmentName = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;

const validTargets: Record<string, boolean> = { kubernetes: true, cloudrun: true };

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

const projectColumns = "id, name, created_at, edge_host, polling_enabled, last_seen_sha, setup_status, setup_error, speed_insights, speed_insights_inject, speed_insights_sample, last_webhook_at";
type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  edge_host: string;
  polling_enabled: number;
  last_seen_sha: string;
  setup_status: string;
  setup_error: string;
  speed_insights: number;
  speed_insights_inject: number;
  speed_insights_sample: number;
  last_webhook_at: string;
};
function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    edgeHost: r.edge_host,
    pollingEnabled: r.polling_enabled === 1,
    lastSeenSha: r.last_seen_sha,
    setupStatus: r.setup_status as SetupStatus,
    setupError: r.setup_error,
    speedInsights: r.speed_insights === 1,
    speedInsightsInject: r.speed_insights_inject === 1,
    speedInsightsSampleRate: r.speed_insights_sample,
    lastWebhookAt: r.last_webhook_at,
  };
}

const environmentColumns = "id, project_id, name, target, config, created_at, traffic_weight, archived, auto_deploy, stage_id";
type EnvironmentRow = {
  stage_id: string;
  id: string;
  project_id: string;
  name: string;
  target: string;
  config: string;
  created_at: string;
  traffic_weight: number;
  archived: number;
  auto_deploy: number;
};
function rowToEnvironment(r: EnvironmentRow): Environment {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    target: r.target,
    config: r.config,
    createdAt: r.created_at,
    trafficWeight: r.traffic_weight,
    archived: r.archived === 1,
    autoDeploy: r.auto_deploy === 1,
    stageId: r.stage_id,
  };
}

const deploymentColumns = "id, environment_id, content_id, status, url, error, created_at, build_id";
type DeploymentRow = { id: string; environment_id: string; content_id: string; status: string; url: string; error: string; created_at: string; build_id: string };
function rowToDeployment(r: DeploymentRow): Deployment {
  return { id: r.id, environmentId: r.environment_id, contentId: r.content_id, status: r.status, url: r.url, error: r.error, createdAt: r.created_at, buildId: r.build_id };
}

const transferColumns = "id, project_id, from_env_id, to_env_id, status, weight, error, created_at";
type TransferRow = { id: string; project_id: string; from_env_id: string; to_env_id: string; status: string; weight: number; error: string; created_at: string };
function rowToTransfer(r: TransferRow): Transfer {
  return {
    id: r.id,
    projectId: r.project_id,
    fromEnvId: r.from_env_id,
    toEnvId: r.to_env_id,
    status: r.status as TransferStatus,
    weight: r.weight,
    error: r.error,
    createdAt: r.created_at,
  };
}

// createStore opens (creating if absent) the SQLite database at path
// and runs the schema. Fails immediately with a clear error if path's
// parent directory doesn't exist, rather than letting the driver's
// own cryptic "unable to open database file" surface on the first
// real query.
// options.artifactsDir is the artifact store's directory: deleting a
// project also deletes its builds' stored output there.
export function createStore(path: string, options?: { secretKey?: Buffer; artifactsDir?: string }): Store {
  const dir = dirname(path);
  try {
    statSync(dir);
  } catch {
    throw new Error(`controlplane: database directory "${dir}" does not exist`);
  }

  const db = new DatabaseSync(path);
  try {
    migrate(db, [baseSchema, cronsSchema, gitSchema, connectionsSchema, envVarsSchema, serverSettingsSchema, domainsSchema, relaysSchema, apiTokensSchema, stagesSchema, ephemeralCertsSchema, revalidateTokensSchema, gitCredentialsSchema]);
  } catch (err) {
    // A refused database (ErrStrandedSettings) is not left open.
    db.close();
    throw err;
  }

  const store = {
    close() {
      db.close();
    },

    legacyTablesInUse(): string[] {
      return legacyTablesInUse(db);
    },

    createProject(name: string): Project {
      const p: Project = {
        id: newID("proj"),
        name,
        createdAt: nowUTC(),
        edgeHost: "",
        pollingEnabled: true,
        lastSeenSha: "",
        setupStatus: "ready",
        setupError: "",
        speedInsights: false,
        speedInsightsInject: true,
        speedInsightsSampleRate: 100,
        lastWebhookAt: "",
      };
      // The project and its built-in stages, together.
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(p.id, p.name, p.createdAt);
        insertBuiltInStages(db, p.id, p.createdAt);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        if (isUniqueConstraintViolation(err)) {
          throw new ErrDuplicateName(`project "${name}" already exists`);
        }
        throw err;
      }
      return p;
    },

    listProjects(): Project[] {
      const rows = db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY created_at`).all() as ProjectRow[];
      return rows.map(rowToProject);
    },

    getProject(id: string): Project {
      const row = db.prepare(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
      if (!row) throw new ErrNotFound(`project "${id}"`);
      return rowToProject(row);
    },

    updateProject(id: string, patch: ProjectPatch): Project {
      const current = this.getProject(id);
      const next = { ...current, ...patch };
      db.prepare(
        "UPDATE projects SET edge_host = ?, polling_enabled = ?, last_seen_sha = ?, setup_status = ?, setup_error = ?, speed_insights = ?, speed_insights_inject = ?, speed_insights_sample = ?, last_webhook_at = ? WHERE id = ?",
      ).run(
        next.edgeHost,
        next.pollingEnabled ? 1 : 0,
        next.lastSeenSha,
        next.setupStatus,
        next.setupError,
        next.speedInsights ? 1 : 0,
        next.speedInsightsInject ? 1 : 0,
        next.speedInsightsSampleRate,
        next.lastWebhookAt,
        id,
      );
      return next;
    },

    deleteProject(id: string): void {
      this.getProject(id);
      const envIds = (db.prepare("SELECT id FROM environments WHERE project_id = ?").all(id) as { id: string }[]).map((r) => r.id);
      const buildIds = (db.prepare("SELECT id FROM builds WHERE project_id = ?").all(id) as { id: string }[]).map((r) => r.id);
      const hasTable = (name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
      db.exec("BEGIN");
      try {
        for (const envId of envIds) {
          db.prepare("DELETE FROM deployments WHERE environment_id = ?").run(envId);
          db.prepare("DELETE FROM crons WHERE environment_id = ?").run(envId);
          db.prepare("DELETE FROM environment_cron_secrets WHERE environment_id = ?").run(envId);
        }
        db.prepare("DELETE FROM environments WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM builds WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM transfers WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM project_git_config WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM project_webhook_secrets WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM project_git_credentials WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM env_vars WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM domain_pending_certs WHERE domain_id IN (SELECT id FROM domains WHERE project_id = ?)").run(id);
        db.prepare("DELETE FROM domain_pasted_certs WHERE domain_id IN (SELECT id FROM domains WHERE project_id = ?)").run(id);
        db.prepare("DELETE FROM domains WHERE project_id = ?").run(id);
        // Ephemeral certificate orders stay: they count against Let's Encrypt
        // whatever happens to the project. An earlier NBO's preview and Speed
        // Insights tables (gone from a fresh database) lose the project's rows
        // only where they exist.
        for (const t of ["vitals", "preview_settings", "previews", "preview_branch_heads"]) {
          if (hasTable(t)) db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
        }
        db.prepare("DELETE FROM stage_revalidate_tokens WHERE stage_id IN (SELECT id FROM stages WHERE project_id = ?)").run(id);
        db.prepare("DELETE FROM stages WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      // After the commit: the rows are gone either way; a file that
      // cannot be removed must not undo the delete.
      if (options?.artifactsDir) {
        try {
          removeArtifactsSync(options.artifactsDir, buildIds);
        } catch {
          // best effort
        }
      }
    },

    createEnvironment(projectId: string, name: string, target: string, config?: string, stageId?: string): Environment {
      this.getProject(projectId); // throws ErrNotFound if missing
      // A row made without a stage is Production's, never "" (which every
      // default listEnvironments caller would miss).
      const stage = stageId === undefined ? (this as unknown as Store).productionStage(projectId) : (this as unknown as Store).getStage(stageId);
      if (stage.projectId !== projectId) throw new ErrNotFound(`environment stage "${stageId}" in project "${projectId}"`);
      if (!validEnvironmentName.test(name)) {
        throw new ErrInvalidEnvironmentConfig(`environment name "${name}" must be a short, lowercase, DNS-1123-shaped identifier`);
      }
      if (!validTargets[target]) {
        throw new ErrInvalidEnvironmentConfig(`unknown target "${target}" (known: kubernetes, cloudrun)`);
      }
      const cfg = config && config.length > 0 ? config : "{}";
      // Adding a cloud back after archiving it revives the archived row
      // of that name (names are unique per project, archived ones too).
      const archived = db.prepare(`SELECT ${environmentColumns} FROM environments WHERE project_id = ? AND name = ? AND archived = 1`).get(projectId, name) as
        EnvironmentRow | undefined;
      if (archived) {
        if (archived.target !== target) throw new ErrDuplicateName(`an archived ${archived.target} environment of this project is named "${name}"`);
        if (archived.stage_id !== stage.id) throw new ErrDuplicateName(`an archived environment of another stage of this project is named "${name}"`);
        return this.reviveEnvironment(archived.id, cfg);
      }
      const e: Environment = {
        id: newID("env"),
        projectId,
        name,
        target,
        config: cfg,
        createdAt: nowUTC(),
        trafficWeight: 0,
        archived: false,
        autoDeploy: true,
        stageId: stage.id,
      };
      try {
        db.prepare("INSERT INTO environments (id, project_id, name, target, config, created_at, stage_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          e.id,
          e.projectId,
          e.name,
          e.target,
          e.config,
          e.createdAt,
          e.stageId,
        );
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          throw new ErrDuplicateName(`environment "${name}" in project "${projectId}"`);
        }
        throw err;
      }
      return e;
    },

    listEnvironments(projectId: string, options?: { includeArchived?: boolean; stageId?: string; allStages?: boolean }): Environment[] {
      // Without stageId or allStages: Production's rows only, so a custom
      // stage's row never joins Production's split, transfers or summary.
      const where = ["project_id = ?"];
      const args: string[] = [projectId];
      if (!options?.includeArchived) where.push("archived = 0");
      if (options?.stageId !== undefined) {
        where.push("stage_id = ?");
        args.push(options.stageId);
      } else if (!options?.allStages) {
        where.push("stage_id = (SELECT id FROM stages WHERE project_id = ? AND name = 'production')");
        args.push(projectId);
      }
      const rows = db.prepare(`SELECT ${environmentColumns} FROM environments WHERE ${where.join(" AND ")} ORDER BY created_at`).all(...args) as EnvironmentRow[];
      return rows.map(rowToEnvironment);
    },

    getEnvironment(id: string): Environment {
      const row = db.prepare(`SELECT ${environmentColumns} FROM environments WHERE id = ?`).get(id) as EnvironmentRow | undefined;
      if (!row) throw new ErrNotFound(`environment "${id}"`);
      return rowToEnvironment(row);
    },

    updateEnvironmentConfig(id: string, config: string): void {
      this.getEnvironment(id);
      db.prepare("UPDATE environments SET config = ? WHERE id = ?").run(config, id);
    },

    setTrafficWeights(projectId: string, weights: Record<string, number>, stageId?: string): void {
      const live = new Set(this.listEnvironments(projectId, stageId ? { stageId } : undefined).map((e) => e.id));
      for (const envId of Object.keys(weights)) {
        if (!live.has(envId)) throw new ErrNotFound(`environment "${envId}" in project "${projectId}"`);
      }
      for (const [envId, weight] of Object.entries(weights)) {
        db.prepare("UPDATE environments SET traffic_weight = ? WHERE id = ?").run(weight, envId);
      }
    },

    archiveEnvironment(id: string): void {
      this.getEnvironment(id);
      db.prepare("UPDATE environments SET archived = 1, traffic_weight = 0 WHERE id = ?").run(id);
    },

    reviveEnvironment(id: string, config: string): Environment {
      if (!this.getEnvironment(id).archived) throw new ErrDuplicateName(`environment "${id}" is not archived`);
      const last = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM deployments WHERE environment_id = ?").get(id) as { n: number };
      db.prepare("UPDATE environments SET archived = 0, traffic_weight = 0, auto_deploy = 1, config = ?, deployments_after = ? WHERE id = ?").run(
        config && config.length > 0 ? config : "{}",
        last.n,
        id,
      );
      return this.getEnvironment(id);
    },

    setEnvironmentAutoDeploy(id: string, on: boolean): void {
      this.getEnvironment(id);
      db.prepare("UPDATE environments SET auto_deploy = ? WHERE id = ?").run(on ? 1 : 0, id);
    },

    createDeployment(environmentId: string, opts?: { buildId?: string }): Deployment {
      this.getEnvironment(environmentId); // throws ErrNotFound if missing
      const d: Deployment = { id: newID("dep"), environmentId, contentId: "", status: "pending", url: "", error: "", createdAt: nowUTC(), buildId: opts?.buildId ?? "" };
      db.prepare("INSERT INTO deployments (id, environment_id, status, created_at, build_id) VALUES (?, ?, ?, ?, ?)").run(d.id, d.environmentId, d.status, d.createdAt, d.buildId);
      return d;
    },

    completeDeployment(id: string, contentId: string, url: string): void {
      db.prepare("UPDATE deployments SET status = 'succeeded', content_id = ?, url = ? WHERE id = ?").run(contentId, url, id);
    },

    failDeployment(id: string, errMsg: string): void {
      db.prepare("UPDATE deployments SET status = 'failed', error = ? WHERE id = ?").run(errMsg, id);
    },

    listDeployments(environmentId: string): Deployment[] {
      const rows = db
        .prepare(
          `SELECT ${deploymentColumns} FROM deployments WHERE environment_id = ? AND rowid > COALESCE((SELECT deployments_after FROM environments WHERE id = ?), 0) ORDER BY created_at, rowid`,
        )
        .all(environmentId, environmentId) as DeploymentRow[];
      return rows.map(rowToDeployment);
    },

    getDeployment(id: string): Deployment {
      const row = db.prepare(`SELECT ${deploymentColumns} FROM deployments WHERE id = ?`).get(id) as DeploymentRow | undefined;
      if (!row) throw new ErrNotFound(`deployment "${id}"`);
      return rowToDeployment(row);
    },

    createTransfer(projectId: string, fromEnvId: string, toEnvId: string): Transfer {
      const t: Transfer = { id: newID("xfer"), projectId, fromEnvId, toEnvId, status: "provisioning", weight: 0, error: "", createdAt: nowUTC() };
      db.prepare("INSERT INTO transfers (id, project_id, from_env_id, to_env_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        t.id,
        t.projectId,
        t.fromEnvId,
        t.toEnvId,
        t.status,
        t.createdAt,
      );
      return t;
    },

    updateTransfer(id: string, patch: Partial<Pick<Transfer, "status" | "weight" | "error" | "toEnvId">>): Transfer {
      const next = { ...this.getTransfer(id), ...patch };
      db.prepare("UPDATE transfers SET status = ?, weight = ?, error = ?, to_env_id = ? WHERE id = ?").run(next.status, next.weight, next.error, next.toEnvId, id);
      return next;
    },

    getTransfer(id: string): Transfer {
      const row = db.prepare(`SELECT ${transferColumns} FROM transfers WHERE id = ?`).get(id) as TransferRow | undefined;
      if (!row) throw new ErrNotFound(`transfer "${id}"`);
      return rowToTransfer(row);
    },

    getLatestTransfer(projectId: string): Transfer | undefined {
      const row = db.prepare(`SELECT ${transferColumns} FROM transfers WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId) as
        TransferRow | undefined;
      return row ? rowToTransfer(row) : undefined;
    },

    getActiveTransfer(projectId: string): Transfer | undefined {
      const row = db
        .prepare(`SELECT ${transferColumns} FROM transfers WHERE project_id = ? AND status NOT IN ('done', 'failed', 'cancelled') ORDER BY created_at DESC LIMIT 1`)
        .get(projectId) as TransferRow | undefined;
      return row ? rowToTransfer(row) : undefined;
    },
  };

  // attachCronMethods/attachGitMethods mutate store in place (adding
  // the methods cron.ts/git.ts implement) and return it — kept in their
  // own files to avoid a circular import with this one.
  const attached = attachRevalidateTokenMethods(db, attachGitHeadMethods(db, attachEphemeralCertMethods(db, attachStageMethods(db, attachApiTokenMethods(db, attachRelayMethods(
    db,
    attachDomainMethods(
      db,
      attachServerSettingsMethods(
        db,
        attachEnvMethods(db, attachConnectionMethods(db, attachGitMethods(db, attachCronMethods(db, store as Store)), options?.secretKey), options?.secretKey),
        options?.secretKey,
      ),
    ),
    options?.secretKey,
  ))))), options?.secretKey);
  return attachGitCredentialMethods(db, attached, options?.secretKey);
}
