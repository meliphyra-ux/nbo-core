// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildImage, buildFunctionImage, functionImageHash, isrcacheImageTag, appBakedHash, buildIsrcacheImage } from "@nbo/adapter-k8s";
import {
  capabilities,
  deploy as cloudRunDeploy,
  liveContentID,
  liveServiceState,
  functionDeployConfigHash,
  serviceIdentityEmail,
  type DeploySpec as CloudRunDeploySpec,
  pushImage,
  defaultComputeServiceAccount,
  grantInvoker,
  contentIDLabel,
  ensureServiceIdentity,
  secretId,
  ensureSecretVersion,
  grantSecretAccessor,
  secretManagerAccessError,
  destroySupersededVersions,
  removeSecretEnv,
  deleteService,
  deleteServiceIdentity,
  serviceLabels,
  isIsrcacheServiceOf,
  isrcacheServiceLabels,
  type ToolContext,
} from "@nbo/adapter-cloudrun";
import type { Function as NboFunction } from "@nbo/spec";
import { imageEnvVars, providedEnvNames, type UserEnv } from "./env.js";
import { cliDeployDirs, functionConcurrency } from "./kubernetes-target.js";
import { mapLimit } from "./concurrency.js";
import { appImageTag } from "./tag.js";
import { withCarry } from "./carry.js";
import { ISR_CACHE_KEY, type IsrOptions } from "./isr.js";
import type { Deployer } from "./deploy.js";
import { createProgress, type ProgressOptions } from "./progress.js";
import { redact } from "./credentials.js";

// secretManagerMessage is what a Secret Manager call refused for a
// disabled API or a missing permission turns into. A connection made
// before Secret Manager was part of it is replaced (that enables the API
// and, on the machine path, grants the role); a pasted-key deployer was
// given no roles by NBO, so the role is named; dev uses the operator's
// own gcloud account and project.
function secretManagerMessage(kind: "disabled" | "denied", opts: CloudRunTargetOptions | undefined): string {
  const reconnect = "reconnect Google Cloud (nbo-server connect google)";
  if (kind === "disabled") return opts ? `${reconnect} to enable the Secret Manager API` : "enable the Secret Manager API in your Google Cloud project";
  if (!opts) return "your gcloud account needs roles/secretmanager.admin";
  return opts.pastedKeyDeployer ? `grant roles/secretmanager.admin to ${opts.pastedKeyDeployer}` : `${reconnect} to grant Secret Manager access`;
}

// createCloudRunTarget wraps a Deployer wired against a real Cloud
// Run project, matching the nbo CLI's own --target cloudrun wiring
// exactly. extraEnv/appURL are plain mutable properties (not Go's own
// WithExtraEnv/AppURL methods) — see kubernetes-target.ts's own
// identical note — port of NewCloudRunTarget/cloudRunDeployer/
// CloudRunTarget (cloudrun.go lines 15-161).
//
// With opts every gcloud/docker call goes through opts.ctx (a private
// credential environment plus an optional runner), never the host's own
// gcloud. perServiceIdentity runs the app and each function as their own
// service account (no roles) instead of the project's default compute
// account; each function then grants run.invoker to the app's account.
export interface CloudRunTargetOptions {
  ctx: ToolContext;
  perServiceIdentity: boolean;
  // pastedKeyDeployer is the deployer's email when Google was connected
  // with a pasted key (NBO granted it no roles), for the error that names
  // the missing Secret Manager role.
  pastedKeyDeployer?: string;
}

export type { UserEnv } from "./env.js";

// isr (read at call time, like extraEnv) turns on the ISR cache steps:
// deployIsrCache runs the private `<app>-isr` service from the CLI
// bundle's nbo-isrcache image and the app image gets its URL as
// functions.json's __isrcache; removeIsrCache deletes it.
export interface CloudRunTarget {
  deployer: Deployer;
  extraEnv: Record<string, string>;
  appURL: string;
  userEnv?: UserEnv;
  carryFrom?: string;
  isr?: IsrOptions;
}

export function createCloudRunTarget(project: string, region: string, repo: string, opts?: CloudRunTargetOptions, progress?: ProgressOptions): CloudRunTarget {
  // Spread into adapter calls so the dev path passes exactly the
  // arguments it always did.
  const cx: [ToolContext] | [] = opts ? [opts.ctx] : [];
  const perService = opts?.perServiceIdentity === true;
  const progressRoot = createProgress(progress);
  let deployedFunctionURLs: Record<string, string> = {};
  const target = {} as CloudRunTarget;
  target.extraEnv = {};
  target.appURL = "";

  // User variables (target.userEnv) reach every service at runtime: plain
  // ones through a private --env-vars-file, secret ones from Secret
  // Manager (one secret per app and name, shared by the app and its
  // functions), mounted with --set-secrets. Each deploy replaces the
  // full set. Secret Manager is touched only when there are secrets.
  const secretValues = (): string[] => {
    const u = target.userEnv;
    return u ? u.secretNames.map((n) => u.vars[n]).filter((v): v is string => !!v) : [];
  };
  // Errors from these commands can echo values: always redacted. The
  // original error is dropped on purpose for the same reason.
  const guarded = async <T>(fn: () => Promise<T>, secretManager = false): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const secrets = secretValues();
      // Nothing to hide: the error passes through untouched (as before).
      if (!secretManager && secrets.length === 0) throw err;
      const kind = secretManager ? secretManagerAccessError(text) : undefined;
      const message = kind ? secretManagerMessage(kind, opts) : redact(text, secrets);
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message);
    }
  };
  // The live app's nbo-env label, read by liveContentID before any
  // deploy: when it had variables and now has none, its env is cleared.
  let liveAppFingerprint: string | undefined;
  type EnvFields = Pick<CloudRunDeploySpec, "plainEnv" | "secretEnv" | "clearEnv">;
  // envFields is what a service's deploy carries for the user's
  // variables: nothing at all without any (exactly as before), unless
  // the live service had some or its state is unknown (clearEnv).
  const envFields = (secretIds: Record<string, string>, liveFingerprint: string | undefined, liveUnknown = false): EnvFields => {
    const u = target.userEnv;
    if (!u) return {};
    const secret = new Set(u.secretNames);
    const plainEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(u.vars)) if (!secret.has(k)) plainEnv[k] = v;
    const fields: EnvFields = {};
    if (Object.keys(plainEnv).length > 0) fields.plainEnv = plainEnv;
    if (Object.keys(secretIds).length > 0) fields.secretEnv = secretIds;
    if (!fields.plainEnv && !fields.secretEnv && (liveFingerprint || liveUnknown)) fields.clearEnv = true;
    return fields;
  };
  // syncSecrets stores each secret's value once per target (a new
  // version only when it changed) and returns NAME -> secret id.
  let secretsSynced: Promise<Record<string, string>> | undefined;
  const syncSecrets = (app: string): Promise<Record<string, string>> =>
    (secretsSynced ??= (async () => {
      const u = target.userEnv;
      const ids: Record<string, string> = {};
      for (const name of [...(u?.secretNames ?? [])].sort()) {
        const id = secretId(app, name);
        await guarded(() => ensureSecretVersion(project, id, u!.vars[name] ?? "", u!.secretHashes?.[name], ...cx), true);
        ids[name] = id;
      }
      return ids;
    })());
  // grantSecrets lets one runtime account read each secret — serially,
  // since concurrent IAM policy edits on one secret conflict — once per
  // target and account.
  const granted = new Set<string>();
  const grantSecrets = async (ids: Record<string, string>, account: string): Promise<void> => {
    for (const id of Object.values(ids)) {
      const key = `${id} ${account}`;
      if (granted.has(key)) continue;
      await guarded(() => grantSecretAccessor(project, id, account, ...cx), true);
      granted.add(key);
    }
  };
  // dropSecretMounts removes live secret mounts of names now delivered
  // as plain values (gcloud refuses one name as both), before the deploy.
  const dropSecretMounts = async (service: string, liveSecretNames: string[] | undefined, plainEnv: Record<string, string> | undefined): Promise<void> => {
    const names = (liveSecretNames ?? []).filter((n) => plainEnv && n in plainEnv);
    if (names.length > 0) await guarded(() => removeSecretEnv(service, project, region, names, ...cx));
  };
  // cleanupSecretVersions destroys superseded versions of every secret
  // this deploy mounted, once the deploy succeeded. Best effort: the
  // deploy already succeeded, and the next one retries.
  const cleanupSecretVersions = async (ids: Record<string, string>): Promise<void> => {
    for (const id of Object.values(ids)) {
      try {
        await destroySupersededVersions(project, id, ...cx);
      } catch {
        // left for the next deploy
      }
    }
  };
  let computeAccount: Promise<string> | undefined;
  const defaultAccount = (): Promise<string> => (computeAccount ??= defaultComputeServiceAccount(project, ...cx));

  // deployIsrCache: the private `<app>-isr` service, returning the URL
  // buildAndDeployApp bakes in as __isrcache. It is never public (the app
  // calls it with an identity token, as it calls functions), scales from
  // 0 to 1 instance (one cache per app), runs as its own role-less
  // account in production and gets none of the user's variables. Its
  // image tag hashes NBO's code, not the build: build, push and deploy
  // are skipped when the live service runs that image with that config
  // and is ready, so the cache (and its contents) survives app deploys.
  // The invoker grant always runs (idempotent).
  let isrCacheURL: string | undefined;
  // readIsrLabels: the live `<app>-isr` service's labels (undefined: no
  // such service). A failed read rejects, redacted, with no cause.
  const readIsrLabels = async (serviceName: string): Promise<Record<string, string> | undefined> => {
    try {
      return await serviceLabels(serviceName, project, region, ...cx);
    } catch (err) {
      // eslint-disable-next-line preserve-caught-error -- the original error may carry secret values
      throw new Error(redact(`ISR cache: reading ${serviceName} failed: ${err instanceof Error ? err.message : String(err)}`, secretValues()));
    }
  };
  const deployIsrCache = async (nboDir: string, app: string): Promise<string> => {
    const p = progressRoot.scope("isr cache");
    const serviceName = `${app}-isr`;
    // Never deploy over another service sharing the name: only one
    // labelled as this app's cache (nbo-role=isrcache, nbo-app=<app>).
    const existing = await readIsrLabels(serviceName);
    if (existing && !isIsrcacheServiceOf(existing, app)) {
      throw new Error(`ISR cache: ${serviceName} exists and is not this app's ISR cache; NBO won't replace it. Rename the service that uses this name to use ISR here`);
    }
    const cli = await p.timed("cli bundle prepared", "cli bundle preparation", () => cliDeployDirs.acquire(nboDir));
    try {
      const localTag = await isrcacheImageTag(cli.dir);
      const suffix = localTag.slice(localTag.indexOf(":") + 1);
      const remoteTag = `${repo}/nbo-isrcache:${suffix}`;
      const invoker = perService ? await ensureServiceIdentity(project, app, ...cx) : await defaultAccount();
      const spec: CloudRunDeploySpec = {
        serviceName,
        imageTag: remoteTag,
        project,
        region,
        // The 12-hex image tag: a label only (the cache is not a build).
        contentID: suffix,
        allowUnauthenticated: false,
        minInstances: 0,
        maxInstances: 1,
        concurrency: 250,
        memoryMB: 256,
        cpu: "1",
        // gen1: its memory floor allows 256Mi with 1 CPU (gen2 needs 512Mi).
        executionEnvironment: "gen1",
        labels: isrcacheServiceLabels(app),
        ...(perService ? { serviceAccount: serviceIdentityEmail(project, serviceName) } : {}),
      };
      const fnConfig = functionDeployConfigHash(spec, invoker);
      const live = await liveServiceState(serviceName, project, region, ...cx);
      let url: string;
      if (live && live.ready && live.image === remoteTag && live.config === fnConfig) {
        p.report("unchanged, skipped");
        url = live.url;
      } else {
        await p.timed("image built", "image build", () => buildIsrcacheImage(cli.dir, localTag));
        await p.timed("image pushed", "image push", () => pushImage(localTag, remoteTag, ...cx));
        url = await p.timed("service deployed", "service deploy", async () => {
          const deploySpec: CloudRunDeploySpec = {
            ...spec,
            fnConfig,
            ...(perService ? { serviceAccount: await ensureServiceIdentity(project, serviceName, ...cx) } : {}),
          };
          return guarded(() => cloudRunDeploy(deploySpec, ...cx));
        });
      }
      await p.timed("invoker granted", "invoker grant", () => grantInvoker(serviceName, project, region, invoker, ...cx));
      isrCacheURL = url;
      return url;
    } finally {
      await cli.release();
    }
  };

  // removeIsrCache: the new app no longer uses a cache. The service goes,
  // then (production) its own account; either already gone is fine. Only
  // a service labelled as this app's cache is removed. Its error never
  // carries a secret value (deploy() reports its first line as progress).
  const removeIsrCache = async (app: string): Promise<void> => {
    const serviceName = `${app}-isr`;
    if (!isIsrcacheServiceOf(await readIsrLabels(serviceName), app)) return;
    try {
      await deleteService(serviceName, project, region, ...cx);
      if (perService) await deleteServiceIdentity(project, serviceName, ...cx);
    } catch (err) {
      // eslint-disable-next-line preserve-caught-error -- the original error may carry secret values
      throw new Error(redact(err instanceof Error ? err.message : String(err), secretValues()));
    }
  };

  const deployFunctions = async (nboDir: string, app: string, functionNames: string[]): Promise<Record<string, string>> => {
    // Functions aren't content-id-tracked like the app; each one is
    // skipped instead when its live service already runs its
    // content-hash-tagged image (deployOne below). This call is skipped
    // entirely for a static-only build so a deploy with no functions
    // never makes this real GCP API round trip at all.
    if (functionNames.length === 0) return {};
    const appIdentity = perService ? await ensureServiceIdentity(project, app, ...cx) : undefined;
    const serviceAccount = perService ? undefined : await defaultAccount();
    // Secrets are stored, and every runtime account (the app's and each
    // function's) may read them, before any service mounts them.
    const secretIds = await syncSecrets(app);
    if (Object.keys(secretIds).length > 0) {
      const accounts = perService ? [appIdentity!, ...(await mapLimit(functionNames, 1, (n) => ensureServiceIdentity(project, `${app}-fn-${n}`, ...cx)))] : [serviceAccount!];
      for (const account of accounts) await grantSecrets(secretIds, account);
    }
    // Found running Slice 4's crons verify script for real: a
    // deployed function's own container never received any
    // deploy-time env var at all, only the main app did — the same
    // gap kubernetes-target.ts's own deployFunctions had.
    const envVars = await imageEnvVars(nboDir, !!opts, target.extraEnv, target.userEnv);
    // The user's variable-set fingerprint labels each service (nbo-env)
    // and so is part of fnConfig; absent leaves both unchanged.
    const fp = target.userEnv?.fingerprint ? { envFingerprint: target.userEnv.fingerprint } : {};

    // The app's identity: what each function grants run.invoker to.
    const invoker = (perService ? appIdentity : serviceAccount)!;

    // Each function is built, pushed, deployed and granted on its own,
    // up to functionConcurrency at once. Images are tagged with the
    // function's content hash and the service is labelled with a hash of
    // its deploy configuration (nbo-fn-config: deploy flags, run-as
    // account, invoker member). Build, push and deploy are skipped only
    // when the live service runs that image with that config AND its
    // latest revision is Ready; the invoker grant always runs
    // (idempotent), so a grant that failed last time is repaired.
    const deployOne = async (name: string): Promise<string> => {
      const p = progressRoot.scope(`function ${name}`);
      const bundleDir = join(nboDir, "functions", name, "bundle");
      const functionJSONPath = join(nboDir, "functions", name, "function.json");
      const serviceName = `${app}-fn-${name}`;
      const suffix = await functionImageHash(bundleDir, functionJSONPath, envVars);
      const localTag = `nbo-fn-${app}-${name}:${suffix}`;
      const remoteTag = `${repo}/nbo-fn-${app}-${name}:${suffix}`;

      let memoryMB: number | undefined;
      let maxDurationSec: number | undefined;
      try {
        const fnRaw = await readFile(functionJSONPath, "utf8");
        const fn = JSON.parse(fnRaw) as NboFunction;
        // The planner already checked these against
        // capabilities.limits before this deploy was attempted —
        // request them for real instead of silently falling back to
        // gcloud's platform defaults (512Mi, 300s).
        memoryMB = fn.resources?.memoryMb;
        maxDurationSec = fn.resources?.maxDurationSec;
      } catch {
        // function.json unreadable — leave memoryMB/maxDurationSec
        // undefined, matching Go's own if-err-skip-silently shape.
      }

      const spec: CloudRunDeploySpec = {
        serviceName,
        imageTag: remoteTag,
        project,
        region,
        // Functions aren't content-id-tracked like the app (see
        // fnConfig instead) — this placeholder just satisfies
        // DeploySpec's shape.
        contentID: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        allowUnauthenticated: false,
        memoryMB,
        maxDurationSec,
        // Computed, so the config hash needs no API call; the deploy
        // below still ensures the account exists.
        ...(perService ? { serviceAccount: serviceIdentityEmail(project, serviceName) } : {}),
        ...fp,
      };
      const live = await liveServiceState(serviceName, project, region, ...cx);
      Object.assign(spec, envFields(secretIds, live?.fingerprint || undefined, live === undefined));
      const fnConfig = functionDeployConfigHash(spec, invoker);

      let url: string;
      if (live && live.ready && live.image === remoteTag && live.config === fnConfig) {
        p.report("unchanged, skipped");
        url = live.url;
      } else {
        await p.timed("image built", "image build", () => buildFunctionImage(bundleDir, functionJSONPath, localTag, envVars));
        await p.timed("image pushed", "image push", () => pushImage(localTag, remoteTag, ...cx));
        url = await p.timed("service deployed", "service deploy", async () => {
          const deploySpec: CloudRunDeploySpec = {
            ...spec,
            fnConfig,
            ...(perService ? { serviceAccount: await ensureServiceIdentity(project, serviceName, ...cx) } : {}),
          };
          await dropSecretMounts(serviceName, live?.secretEnvNames, deploySpec.plainEnv);
          return guarded(() => cloudRunDeploy(deploySpec, ...cx));
        });
      }
      await p.timed("invoker granted", "invoker grant", () => grantInvoker(serviceName, project, region, invoker, ...cx));
      return url;
    };
    const deployed = await mapLimit(functionNames, functionConcurrency, deployOne);
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
      const functionURLs = isrCacheURL ? { ...deployedFunctionURLs, [ISR_CACHE_KEY]: isrCacheURL } : deployedFunctionURLs;
      // Read at call time, like extraEnv: the previous build's hashed files ride in the image.
      const suffix = await withCarry(target.carryFrom, nboDir, (m) => p.report(m), async (carryDir, carryHash) => {
        const suffix = appImageTag(id, carryHash, await appBakedHash(cliDeployDir, functionURLs, envVars));
        await p.timed("image built", "image build", () => buildImage(nboDir, cliDeployDir, `nbo-app-${app}:${suffix}`, functionURLs, envVars, carryDir));
        return suffix;
      });
      const localTag = `nbo-app-${app}:${suffix}`;
      const remoteTag = `${repo}/nbo-app-${app}:${suffix}`;
      await p.timed("image pushed", "image push", () => pushImage(localTag, remoteTag, ...cx));

      const url = await p.timed("service deployed", "service deploy", async () => {
        const identity = perService ? await ensureServiceIdentity(project, app, ...cx) : undefined;
        const secretIds = await syncSecrets(app);
        if (Object.keys(secretIds).length > 0) await grantSecrets(secretIds, identity ?? (await defaultAccount()));
        const spec: CloudRunDeploySpec = {
          serviceName: app,
          imageTag: remoteTag,
          project,
          region,
          contentID: id,
          allowUnauthenticated: true,
          ...(target.userEnv?.fingerprint ? { envFingerprint: target.userEnv.fingerprint } : {}),
          ...(identity ? { serviceAccount: identity } : {}),
          ...envFields(secretIds, liveAppFingerprint),
        };
        if (spec.plainEnv) await dropSecretMounts(app, (await liveServiceState(app, project, region, ...cx))?.secretEnvNames, spec.plainEnv);
        const deployed = await guarded(() => cloudRunDeploy(spec, ...cx));
        await cleanupSecretVersions(secretIds);
        return deployed;
      });
      target.appURL = url;
    } finally {
      await cli.release();
    }
  };

  target.deployer = {
    capabilities,
    liveContentID: async (app: string) => {
      const live = await liveContentID(app, project, region, ...cx);
      liveAppFingerprint = live.fingerprint;
      return live;
    },
    // liveContentID reads back whatever's in the GCP label, which
    // @nbo/adapter-cloudrun's own contentIDLabel already truncated to
    // fit GCP's 63-char label limit when the label was first written
    // — a plain equality check against the full id can never match,
    // so compare both sides in that same truncated form instead.
    idsMatch: (liveID: string, wantID: string) => liveID === contentIDLabel(wantID),
    urlFor: () => "", // deploy()'s own return value carries the real URL (read via target.appURL)
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
