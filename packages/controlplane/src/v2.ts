// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Project, Store } from "./store/store.js";
import { hasOwnHost, type Stage } from "./stages/stages.js";
import type { DeploymentTrigger } from "./http/handlers.js";
import type { CloudSetup } from "./clouds/cloud-setup.js";
import { createRunner } from "./builds/runner.js";
import type { SandboxFactory } from "./builds/sandbox.js";
import { createBuildQueue, recoverInterruptedBuilds, type BuildQueue } from "./builds/build-queue.js";
import { createClusterEdgeSync, createEdgeSync, type EdgeSync } from "./edge/edge-sync.js";
import { clusterEdgeActive, createClusterEdgeWriter, latestSuccessfulURL, storeKubeconfig } from "./edge/edge-table.js";
import { createSetup, type Setup } from "./deploys/setup.js";
import { lsRemoteHead, lsRemoteHeads, type GitRemoteOptions } from "./git/gitremote.js";
import { createGitCredentials, type GitAuthFn } from "./git/git-credentials.js";
import { createLegacyGitHub, type LegacyGitHub } from "./git/github-legacy.js";
import { createTransfers, type Transfers } from "./deploys/transfer.js";
import { createSuppliedValues, type SuppliedValues } from "./variables/supplied-values.js";
import { createCloudTeardown, type CloudTeardown } from "./clouds/cloud-teardown.js";
import type { CommandRunner } from "@nbo/deploy";
import { defaultRunner } from "./clouds/cloud-setup.js";
import { createAwsConnect, type AwsConnect } from "./clouds/aws-connect.js";
import { createGoogleConnect, type GoogleConnect } from "./clouds/google-connect.js";
import { createKubeConnect, type KubeConnect } from "./clouds/kube-connect.js";
import type { Mode } from "./mode.js";
import type { ArtifactStore } from "./builds/artifacts.js";
import type { Domain } from "./domains/domains.js";
import { createCloudRunDomains, type CloudRunDomains } from "./domains/cloudrun-domains.js";
import {
  createAcmeClient,
  createCertWriter,
  createChallengeStore,
  createDomainLoop,
  type AcmeClient,
  type CertWriter,
  type ChallengeStore,
  type DomainLoop,
  type DomainLoopDeps,
} from "./domains/certs.js";
import { createResolver, type Resolver } from "./domains/dns-check.js";
import { createEdgeInstaller, defaultBuildEdgeImage, type EdgeInstaller } from "./edge/edge-install.js";
import { createCloudflareRanges, type CloudflareRanges } from "./domains/cloudflare-ranges.js";
import { createEdgeJobs, type EdgeJobs } from "./edge/edge-jobs.js";
import type { ExpiryDeps } from "./stages/stage-expiry.js";
import { createProjectPoller, type ProjectPoller } from "./git/poller.js";
import { createLinkControl, type LinkControl } from "./link/routes.js";

// V2 is everything the v2 routes and the poll loop need, wired once —
// by main.ts for the real process and by tests with fakes only at the
// cloud boundary (deploymentTrigger, cloudSetup).
export interface V2 {
  queue: BuildQueue;
  edgeSync: EdgeSync;
  setup: Setup;
  transfers: Transfers;
  cloudSetup: CloudSetup;
  cloudTeardown: CloudTeardown;
  edgePublicPort: number;
  // opts.env: the project's git credential (gitAuth).
  lsRemote: (repo: string, branch: string, opts?: GitRemoteOptions) => Promise<string>;
  // lsRemoteHeads lists every branch head (the poller).
  lsRemoteHeads: (repo: string, opts?: GitRemoteOptions) => Promise<Map<string, string>>;
  // gitAuth: the git environment of a project's credential (null for a
  // public repository); every clone, checkout and ls-remote goes through it
  // and cleans up after (git-credentials.ts).
  gitAuth: GitAuthFn;
  // poller: checks a project's branch heads; the poll loop and
  // POST /projects/{id}/git/poll share it, so a push builds once.
  poller: ProjectPoller;
  mode: Mode;
  googleConnect: GoogleConnect;
  kubeConnect: KubeConnect;
  awsConnect: AwsConnect;
  run: CommandRunner;
  artifacts?: ArtifactStore;
  // domains checks DNS and issues/renews certificates (main.ts runs it in
  // production); certs writes and deletes the hosts' TLS Secrets in the
  // edge cluster (deleteCert is what removing a domain calls).
  domains: DomainLoop;
  certs: CertWriter;
  // challenges: the pending ACME answers every route table write publishes.
  challenges: ChallengeStore;
  // cloudflareRanges: the one shared instance (the route table and the domain loop).
  cloudflareRanges: CloudflareRanges;
  // edgeInstaller installs the public edge and the relays (production).
  edgeInstaller: EdgeInstaller;
  // edgeJobs runs install, reinstall and relay work in the background.
  edgeJobs: EdgeJobs;
  // cloudRunDomains: Google domain mappings for domains Cloud Run serves.
  cloudRunDomains: CloudRunDomains;
  // supplied: variable values deploy requests brought (names only), in
  // memory per job; shared by the queue, the runner and transfers.
  supplied: SuppliedValues;
  // legacyGitHub: the old per-server GitHub App's token reader (its cached
  // tokens are redacted from link replies).
  legacyGitHub: LegacyGitHub;
  // stageExpiry: what the expiry pass (stage-expiry.ts) runs with; main.ts
  // runs it every 10 minutes, DELETE on an ephemeral stage removes one now.
  stageExpiry: ExpiryDeps;
  // now: the clock ephemeral stages' expiry is read against.
  now: () => Date;
  // publicUrl: NBO_PUBLIC_URL, parsed once by main.ts (public-url.ts).
  publicUrl?: URL;
  // keygen runs ssh-keygen for deploy keys.
  keygen: CommandRunner;
  // revalidateFetch: how revalidate.ts calls a site (global fetch by default).
  revalidateFetch?: typeof fetch;
  // link: the link client as the link routes see it (link/routes.ts).
  link: LinkControl;
}

export interface V2Options {
  // githubApiUrl: where the old per-server GitHub App's linked projects get
  // their tokens (github-legacy.ts; api.github.com, tests give the fake's).
  githubApiUrl?: string;
  // knownHostsFile: the host keys deploy-key git steps check (main.ts: next
  // to the database).
  knownHostsFile?: string;
  // keygen: how ssh-keygen runs (the real runner by default).
  keygen?: CommandRunner;
  // publicUrl: NBO's own https address (NBO_PUBLIC_URL), if it has one.
  publicUrl?: URL;
  // supplied: the one in-memory values map (main.ts makes it; a fresh one by default).
  supplied?: SuppliedValues;
  // buildConcurrency: how many builds run at once (NBO_BUILD_CONCURRENCY; 2 by default).
  buildConcurrency?: number;
  mode?: Mode;
  googleConnect?: GoogleConnect;
  kubeConnect?: KubeConnect;
  // run is the boundary to gcloud/kubectl for the connection modules.
  run?: CommandRunner;
  deploymentTrigger: DeploymentTrigger;
  cloudSetup: CloudSetup;
  cloudTeardown?: CloudTeardown;
  edgeAdminUrl: string;
  edgePublicPort: number;
  nextAdapterPath?: string;
  // buildSandbox: where repositories' commands run (NBO_BUILD_ISOLATION; this host by default).
  buildSandbox?: SandboxFactory;
  lsRemote?: (repo: string, branch: string, opts?: GitRemoteOptions) => Promise<string>;
  lsRemoteHeads?: (repo: string, opts?: GitRemoteOptions) => Promise<Map<string, string>>;
  // artifacts keeps each build's .nbo/ for the build page.
  artifacts?: ArtifactStore;
  // Cluster edge: the pending ACME challenge answers to publish in the
  // route table (the domain loop's by default, so no whole-table write
  // ever drops a pending challenge), and how a cluster's scoped
  // kubeconfig is read (the stored connection by default).
  edgeChallenges?: () => Record<string, string>;
  kubeconfigFor?: (clusterId: string) => Promise<string>;
  // Domains: DNS resolver, ACME client and the edge challenge probe
  // (real ones by default; tests pass fakes).
  resolver?: Resolver;
  acme?: AcmeClient;
  cloudflareFetch?: typeof fetch;
  // Cloudflare checks and the wait the domain loop makes for the edge
  // replicas (real ones by default; tests pass fakes).
  cloudflareReach?: DomainLoopDeps["reach"];
  cloudflareFlexible?: DomainLoopDeps["flexible"];
  sleep?: (ms: number) => Promise<void>;
  probe?: (host: string, token: string, keyAuth: string) => Promise<boolean>;
  // Edge install: how the edge image is built (defaultBuildEdgeImage) or
  // the whole installer (tests pass fakes).
  buildEdgeImage?: () => Promise<string>;
  // loadBalancerAnnotations: NBO_LB_ANNOTATIONS, parsed.
  loadBalancerAnnotations?: Record<string, string>;
  edgeInstaller?: EdgeInstaller;
  cloudRunDomains?: CloudRunDomains;
  // now: the clock for ephemeral stages' expiry (tests pass a fake).
  now?: () => Date;
  // revalidateFetch: how the revalidate route calls a site (tests pass a fake).
  revalidateFetch?: typeof fetch;
  // link: the link control main.ts attaches its client to (a detached one,
  // which reports "off", by default).
  link?: LinkControl;
}

// pickEdgeSync re-evaluates on every call which edge carries traffic: the
// public edge in the edge cluster (production with an edge cluster set) or
// the dev edge's admin API, so installing the edge needs no restart.
function pickEdgeSync(store: Store, mode: Mode | undefined, dev: EdgeSync, cluster: EdgeSync): EdgeSync {
  const current = (): EdgeSync => (clusterEdgeActive(store, mode) ? cluster : dev);
  return {
    desiredTarget: (projectId) => current().desiredTarget(projectId),
    desiredTargets: (projectId) => current().desiredTargets(projectId),
    push: (projectId, opts) => current().push(projectId, opts),
    onDeployed: (projectId, environmentId) => current().onDeployed(projectId, environmentId),
    inSync: (projectId, host) => current().inSync(projectId, host),
    reconcile: () => current().reconcile(),
    remove: (host) => current().remove(host),
  };
}

export function wireV2(store: Store, options: V2Options): V2 {
  const cmd = options.run ?? defaultRunner;
  const lsRemote =
    options.lsRemote ?? ((repo: string, branch: string, opts?: GitRemoteOptions) => lsRemoteHead(repo, branch, opts));
  const kubeconfigFor = options.kubeconfigFor ?? storeKubeconfig(store);
  const clusterWriter = createClusterEdgeWriter({ store, run: cmd, kubeconfigFor });
  const challenges = createChallengeStore();
  const cloudflareRanges = createCloudflareRanges({ store, fetch: options.cloudflareFetch });
  const edgeSync = pickEdgeSync(
    store,
    options.mode,
    createEdgeSync(store, { adminUrl: options.edgeAdminUrl }),
    createClusterEdgeSync(store, clusterWriter, {
      challenges: options.edgeChallenges ?? (() => challenges.snapshot()),
      cloudflareRanges: () => cloudflareRanges.current(),
    }),
  );
  const supplied = options.supplied ?? createSuppliedValues();
  const legacyGitHub = createLegacyGitHub(store, { api: options.githubApiUrl ?? "https://api.github.com" });
  const gitAuth = createGitCredentials(store, {
    legacy: legacyGitHub,
    knownHostsFile: options.knownHostsFile,
  });
  const runner = createRunner(store, options.deploymentTrigger, {
    supplied,
    gitAuth,
    nextAdapterPath: options.nextAdapterPath,
    sandbox: options.buildSandbox,
    onDeployed: (projectId, environmentId) => edgeSync.onDeployed(projectId, environmentId),
    artifacts: options.artifacts,
  });
  const queue = createBuildQueue(store, runner, supplied, { concurrency: options.buildConcurrency });
  const setup = createSetup({
    store,
    cloudSetup: options.cloudSetup,
    queue,
    lsRemote,
    gitAuth,
    mode: options.mode,
    now: () => now().getTime(),
  });
  const transfers = createTransfers({ store, setup, queue, edgeSync, mode: options.mode, supplied });
  const certs = createCertWriter({ store, run: cmd, kubeconfigFor });
  const cloudRunDomains = options.cloudRunDomains ?? createCloudRunDomains({ store, run: cmd });
  const domains = createDomainLoop({
    store,
    cloudRun: cloudRunDomains,
    resolver: options.resolver ?? createResolver(),
    acme: options.acme ?? createAcmeClient(store),
    edgeSync,
    challenges,
    ranges: cloudflareRanges,
    writeCert: certs.writeCert,
    deleteCert: certs.deleteCert,
    probe: options.probe,
    reach: options.cloudflareReach,
    flexible: options.cloudflareFlexible,
    sleep: options.sleep,
  });
  const kubeConnect = options.kubeConnect ?? createKubeConnect({ store, run: cmd });
  const edgeInstaller =
    options.edgeInstaller ??
    createEdgeInstaller({
      store,
      kubeConnect,
      run: cmd,
      buildEdgeImage: options.buildEdgeImage ?? defaultBuildEdgeImage(),
      loadBalancerAnnotations: options.loadBalancerAnnotations,
      reconcile: () => edgeSync.reconcile(),
      // The whole table is written, whichever project is named.
      pushTable: () => edgeSync.push(""),
      mode: options.mode,
    });
  const cloudTeardown = options.cloudTeardown ?? createCloudTeardown(undefined, { mode: options.mode ?? "dev", store });
  const now = options.now ?? (() => new Date());
  const pollHeads = options.lsRemoteHeads ?? ((repo: string, opts?: GitRemoteOptions) => lsRemoteHeads(repo, opts));
  const stageExpiry: ExpiryDeps = { store, edgeSync, cloudTeardown, certs, mode: options.mode ?? "dev", supplied, now };
  return {
    queue,
    edgeSync,
    setup,
    transfers,
    cloudSetup: options.cloudSetup,
    cloudTeardown,
    edgePublicPort: options.edgePublicPort,
    lsRemote,
    lsRemoteHeads: pollHeads,
    gitAuth,
    poller: createProjectPoller({ store, queue, edgeSync, lsRemoteHeads: pollHeads, gitAuth, setup }),
    mode: options.mode ?? "dev",
    googleConnect: options.googleConnect ?? createGoogleConnect({ store, run: cmd }),
    kubeConnect,
    awsConnect: createAwsConnect({ store, run: cmd }),
    run: cmd,
    artifacts: options.artifacts,
    domains,
    certs,
    challenges,
    cloudflareRanges,
    edgeInstaller,
    edgeJobs: createEdgeJobs(store),
    cloudRunDomains,
    supplied,
    legacyGitHub,
    stageExpiry,
    now,
    publicUrl: options.publicUrl,
    keygen: options.keygen ?? defaultRunner,
    revalidateFetch: options.revalidateFetch,
    link: options.link ?? createLinkControl(),
  };
}

export interface DomainUrlContext {
  store: Store;
  mode: Mode;
  edgePublicPort: number;
}

// publicCloudUrl is the address of a stage's busiest cloud, for production
// before an edge exists: Cloud Run's public URL, or "" for an app that is
// only reachable inside its cluster.
function publicCloudUrl(store: Store, projectId: string, stageId?: string): string {
  const envs = [...store.listEnvironments(projectId, stageId ? { stageId } : undefined)].sort(
    (a, b) => b.trafficWeight - a.trafficWeight,
  );
  for (const env of envs) {
    const url = latestSuccessfulURL(store, env.id);
    if (url?.startsWith("https://")) return url;
  }
  return "";
}

// siteUrl applies the address rules to one stage's site: its default host,
// its own domain rows (ownDomain) and its own clouds (stageId, Production's
// when undefined).
function siteUrl(
  projectId: string,
  host: string,
  ownDomain: (d: Domain) => boolean,
  ctx: DomainUrlContext,
  stageId?: string,
): string {
  if (!host) return "";
  const edge = clusterEdgeActive(ctx.store, ctx.mode);
  const domains = ctx.mode === "production" || edge ? ctx.store.listDomains(projectId).filter(ownDomain) : [];
  // An active custom domain wins, the edge's or one Google serves through a Cloud Run mapping.
  const custom = domains.find((d) => d.kind === "custom" && d.status === "active");
  if (custom) return `https://${custom.host}`;
  if (ctx.mode === "production" && !edge) return publicCloudUrl(ctx.store, projectId, stageId);
  if (!edge) return `http://${host}:${ctx.edgePublicPort}`;
  const own = domains.find((d) => d.host === host);
  return `${own?.status === "active" ? "https" : "http"}://${host}`;
}

// productionStageId: "" for a project without stages (never after migration).
function productionStageId(store: Store, projectId: string): string {
  return store.listStages(projectId).find((s) => s.kind === "production")?.id ?? "";
}

// domainUrlFor is a project's address (spec A6), always Production's. Dev
// mode: the edge host on the edge's public port. Production before an edge
// is installed: the first active custom domain (a Cloud Run mapping), else
// the cloud's own public address, if it has one. With the edge: https on the
// first active custom domain of Production, else the default host (https once
// its certificate is active, http until then).
export function domainUrlFor(project: Pick<Project, "id" | "edgeHost">, ctx: DomainUrlContext): string {
  if (!project.edgeHost) return "";
  const productionId = productionStageId(ctx.store, project.id);
  return siteUrl(project.id, project.edgeHost, (d) => d.stageId === productionId, ctx);
}

// stageUrlFor is a stage's address by the same rules: Production's is
// domainUrlFor; a custom or ephemeral stage's uses its own host, domains
// and clouds (an ephemeral one none once its removal starts).
// Preview and Development have no address.
export function stageUrlFor(stage: Stage, ctx: DomainUrlContext): string {
  if (stage.kind === "production") return domainUrlFor(ctx.store.getProject(stage.projectId), ctx);
  if (!hasOwnHost(stage)) return "";
  return siteUrl(stage.projectId, stage.host, (d) => d.stageId === stage.id, ctx, stage.id);
}

// recoverInterruptedWork runs once at startup. Builds, setups and
// transfers run in-process; whatever a previous process left mid-way
// will never finish, so it is recorded as interrupted rather than
// shown in progress forever.
export function recoverInterruptedWork(store: Store): string[] {
  const interrupted = recoverInterruptedBuilds(store);
  for (const project of store.listProjects()) {
    if (project.setupStatus === "provisioning") {
      store.updateProject(project.id, {
        setupStatus: "needs-setup",
        setupError: "interrupted: the control-plane restarted during setup — retry it",
      });
    }
    const active = store.getActiveTransfer(project.id);
    if (active)
      store.updateTransfer(active.id, {
        status: "failed",
        error: "interrupted: the control-plane restarted during this transfer",
      });
  }
  return interrupted;
}
