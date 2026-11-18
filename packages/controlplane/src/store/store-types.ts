// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The store's row types and the Store interface every feature's methods hang off.
import type { CronRow } from "../deploys/cron.js";
import type { GitConfig, Build, BuildDetailsPatch } from "../git/git.js";
import type {
  GoogleConnection,
  GoogleConnectionInput,
  KubernetesConnection,
  KubernetesConnectionInput,
  GoogleSecrets,
  KubernetesSecrets,
} from "../clouds/connections.js";
import type { EnvVarView, ProjectEnvVarView, ResolvedEnv } from "../variables/env-vars.js";
import type { EdgeJob, PendingCert, ServerSettings, ServerSecretName } from "./server-settings.js";
import type { Domain, DomainPatch } from "../domains/domains.js";
import type { Relay, RelayInput } from "../edge/relays.js";
import type { RevalidateToken } from "../variables/revalidate-tokens.js";
import type { ApiToken } from "../http/api-tokens.js";
import type { Stage, StagePatch } from "../stages/stages.js";
import type { GitHeadsStore } from "../git/git-heads.js";
import type { GitCredentialsStore } from "../git/git-credentials.js";
import type { LinkStore } from "../link/link-store.js";
import type { EphemeralCertsStore } from "../domains/ephemeral-certs.js";

export type SetupStatus = "provisioning" | "ready" | "needs-setup" | "waiting-for-key";

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
  // skipFirstBuild: setup finishes without building the first head (kept
  // until setup completes, so a restart or retry still skips it).
  skipFirstBuild: boolean;
  // keyWaitSince: when setup began waiting for a deploy key (ISO, "" = not waiting).
  keyWaitSince: string;
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    | "edgeHost"
    | "pollingEnabled"
    | "lastSeenSha"
    | "setupStatus"
    | "setupError"
    | "speedInsights"
    | "speedInsightsInject"
    | "speedInsightsSampleRate"
    | "lastWebhookAt"
    | "skipFirstBuild"
    | "keyWaitSince"
  >
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
export interface Store extends GitHeadsStore, GitCredentialsStore, EphemeralCertsStore, LinkStore {
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
  listEnvironments(
    projectId: string,
    options?: { includeArchived?: boolean; stageId?: string; allStages?: boolean },
  ): Environment[];
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
  // getWebhookSecret: the project's webhook secret, without making one.
  getWebhookSecret(projectId: string): string | undefined;
  createBuild(projectId: string, revision: string): Build;
  // createQueuedBuild: stageId defaults to the project's Production stage.
  createQueuedBuild(projectId: string, revision: string, opts?: { manual?: boolean; stageId?: string }): Build;
  startBuild(id: string): void;
  appendBuildLog(id: string, text: string): void;
  completeBuild(
    id: string,
    status: "skipped" | "succeeded" | "failed",
    deploymentIds?: string[],
    errMsg?: string,
  ): void;
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
  saveGoogleConnection(c: GoogleConnectionInput, s: GoogleSecrets): GoogleConnection;
  recordGoogleSelfCheck(warnings: string[], otherCores: string[]): void;
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
  getGoogleIdentityId(): string | undefined;
  setGoogleIdentityId(id: string): void;
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
  addDomain(
    projectId: string,
    host: string,
    kind: Domain["kind"],
    serving?: Domain["serving"],
    stageId?: string,
  ): Domain;
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
  createEphemeralStage(
    projectId: string,
    input: { branch: string; host: string; expiresAt: string; label: string },
  ): Stage;
  updateStage(id: string, patch: StagePatch): Stage;
  // deleteStage removes a custom stage and its cloud rows (not built-ins).
  deleteStage(id: string): void;
  // discardEphemeralStage undoes a createEphemeralStage that never built.
  discardEphemeralStage(id: string): void;

  // Environment variables — implemented by env-vars.ts attachEnvMethods.
  listWorkspaceEnv(): EnvVarView[];
  listProjectEnv(projectId: string): ProjectEnvVarView[];
  // value null declares the name without a value.
  setEnv(
    scope: { projectId: string | null },
    name: string,
    value: string | null,
    secret: boolean,
    stage?: string,
  ): EnvVarView;
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
  // envValuesForRedaction: every stored secret value and every stored plain
  // value of 6+ characters, any project or workspace, any stage. Server-side only.
  envValuesForRedaction(): string[];
}
