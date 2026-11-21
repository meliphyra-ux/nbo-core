// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { kindContext, type CommandRunner } from "./cloud-setup.js";
import { run } from "../builds/run.js";
import {
  withKubeconfig,
  withGoogleCredentials,
  deleteServiceIdentity,
  deleteAppSecrets,
  redact,
  kubeName,
  isrcacheObjectName,
  isrcacheDeleteArgs,
  parseServiceLabels,
  isIsrcacheServiceOf,
} from "@nbo/deploy";
import { kubeconfigSecrets, projectNamespace, googleSecrets } from "../deploys/deploy.js";
import { listMappingsArgs, mappingCommand, mappingMissing } from "../domains/cloudrun-domains.js";
import type { Mode } from "../mode.js";
import type { Store } from "../store/store.js";
import { googleCredential } from "./google-wif.js";
import { awsContext, awsJson, deleteFunction, lambdaName, type ToolContext } from "@nbo/adapter-lambda";
import { awsCredentials } from "./aws-connect.js";

export const defaultRunner: CommandRunner = (cmd, args, opts) => run(cmd, args, { timeoutMs: 120_000, env: opts?.env });

export interface TeardownTarget {
  target: string;
  // appName is deploy.ts's deployAppName for the environment: the name
  // of the app's Deployment/Service/Ingress or Cloud Run service; its
  // functions run as "<appName>-fn-<function>" (on Kubernetes shortened
  // with a hash past 63 characters, still starting "<appName>-fn-").
  appName: string;
  // projectId names the project namespace production mode deletes.
  projectId?: string;
  config: Record<string, unknown>;
  // scope: "project" (the default) removes what the project runs there; in
  // production Kubernetes that is the whole nbo-p-* namespace, and on Cloud
  // Run it includes the project's domain mappings. "app" removes only this
  // one app (a custom environment's cloud row), leaving the namespace, its
  // shared objects and Production's domain mappings alone.
  scope?: "project" | "app";
  // keep: the app names of the project's other cloud rows. A listed object
  // that is one of them, or starts with "<kept app>-", is never deleted, even
  // when its name starts like one of this app's functions.
  keep?: string[];
}

// keptBy: is name one of the kept apps or one of their objects?
function keptBy(keep: readonly string[], name: string): boolean {
  return keep.some((k) => name === k || name.startsWith(`${k}-`));
}

export interface CloudTeardown {
  remove(t: TeardownTarget): Promise<void>;
}

type Step = (cloud: string, what: string, cmd: string, args: string[], env?: Record<string, string>) => Promise<string>;

// removeKubernetesApp deletes, in a project namespace, exactly what
// @nbo/adapter-k8s renders for one app: renderManifests' Deployment and
// Service (no Ingress in production), renderEnvSecret's <app>-env,
// renderNetworkPolicies' <app>-from-edge, <app>-to-functions and
// <app>-to-isrcache, renderIsrcacheManifests' <app>-isr, and each
// function's Deployment and Service from renderFunctionManifests. Never the
// namespace, the shared nbo-default-deny-ingress policy or the pull secret,
// which Production and other environments' apps use too. A function is
// recognised by its name ("<app>-fn-...") and its pods' nbo.dev/app label,
// so another app whose name merely starts the same is kept.
async function removeKubernetesApp(
  step: Step,
  base: string[],
  appName: string,
  keep: readonly string[],
): Promise<void> {
  await step("Kubernetes", `deleting ${appName}`, "kubectl", [
    ...base,
    "delete",
    "deployment,service",
    appName,
    "--ignore-not-found",
  ]);
  await removeIsrcache(step, base, appName);
  await step("Kubernetes", `deleting the variables of ${appName}`, "kubectl", [
    ...base,
    "delete",
    "secret",
    kubeName(`${appName}-env`),
    "--ignore-not-found",
  ]);
  await step("Kubernetes", `deleting the network policies of ${appName}`, "kubectl", [
    ...base,
    "delete",
    "networkpolicy",
    kubeName(`${appName}-from-edge`),
    kubeName(`${appName}-to-functions`),
    kubeName(`${appName}-to-isrcache`),
    "--ignore-not-found",
  ]);
  const listed = await step("Kubernetes", "listing function deployments", "kubectl", [
    ...base,
    "get",
    "deployments",
    "-o",
    "json",
  ]);
  let items: {
    metadata?: { name?: string };
    spec?: { template?: { metadata?: { labels?: Record<string, string> } } };
  }[] = [];
  try {
    items = (JSON.parse(listed || "{}") as { items?: typeof items }).items ?? [];
  } catch {
    throw new Error("Kubernetes: listing function deployments returned something that isn't JSON");
  }
  const fnPrefix = `${appName}-fn-`;
  for (const item of items) {
    const name = item.metadata?.name ?? "";
    if (!name.startsWith(fnPrefix)) continue;
    if (item.spec?.template?.metadata?.labels?.["nbo.dev/app"] !== appName || keptBy(keep, name)) continue;
    await step("Kubernetes", `deleting ${name}`, "kubectl", [
      ...base,
      "delete",
      "deployment,service",
      name,
      "--ignore-not-found",
    ]);
  }
}

// removeIsrcache deletes the app's ISR cache Deployment and Service: only
// objects with its exact name AND its labels (nbo.dev/role=isrcache,
// nbo.dev/app=<app>), so another app's object sharing the name (a
// function "<other>-fn-x-isr", the app of a cluster named `isr` or
// `*-isr` connected before such names were refused) is never deleted.
async function removeIsrcache(step: Step, base: string[], appName: string): Promise<void> {
  await step("Kubernetes", `deleting ${isrcacheObjectName(appName)}`, "kubectl", [
    ...base,
    ...isrcacheDeleteArgs(appName),
  ]);
}

// removeLambdaApp deletes one app's Lambdas (lambdaName: "nbo-<app>" and "nbo-<app>-fn-*", not a
// kept app's), each with its URL and role, then the app's and its functions'
// image tags in the one ECR repository ("<lambda name>_<hash>"). Names come
// from listings, so a function the latest build dropped goes too.
async function removeLambdaApp(ctx: ToolContext, appName: string, keep: readonly string[]): Promise<void> {
  const base = lambdaName(appName);
  const kept = keep.map((k) => lambdaName(k));
  const own = (name: string) => name === base || (name.startsWith(`${base}-fn-`) && !keptBy(kept, name));
  const { Functions = [] } = await awsJson<{ Functions?: { FunctionName: string }[] }>(ctx, [
    "lambda",
    "list-functions",
  ]);
  for (const { FunctionName } of Functions) if (own(FunctionName)) await deleteFunction(FunctionName, ctx);
  const { imageIds = [] } = await awsJson<{ imageIds?: { imageTag?: string }[] }>(ctx, [
    "ecr",
    "list-images",
    "--repository-name",
    "nbo",
    "--filter",
    "tagStatus=TAGGED",
  ]);
  const tags = imageIds
    .map((i) => i.imageTag ?? "")
    .filter((t) => t.includes("_") && own(t.slice(0, t.lastIndexOf("_"))));
  // batch-delete-image takes at most 100 ids per call.
  for (let i = 0; i < tags.length; i += 100) {
    await awsJson(ctx, [
      "ecr",
      "batch-delete-image",
      "--repository-name",
      "nbo",
      "--image-ids",
      ...tags.slice(i, i + 100).map((t) => `imageTag=${t}`),
    ]);
  }
}

function cliMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lines = msg.split(/\r?\n/);
  if (lines.length > 1 && / (failed with exit code \d+|timed out after \d+ms):$/.test(lines[0]!))
    return lines.slice(1).join("\n").trim();
  return msg.trim();
}

// createCloudTeardown deletes what NBO deployed for one environment.
// Container images stay in the registry (cheap, and a redeploy reuses
// them); only the running workloads are removed.
//
// In production mode a Kubernetes environment lives in its project's
// nbo-p-* namespace on its own cluster (config.clusterId), so teardown
// deletes that namespace with that cluster's stored scoped kubeconfig. --wait=false: nbo-controller
// has no watch on namespaces, and the cluster finishes the deletion itself.
export function createCloudTeardown(
  runCmd: CommandRunner = defaultRunner,
  options: { mode?: Mode; store?: Store } = {},
): CloudTeardown {
  async function step(
    cloud: string,
    what: string,
    cmd: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<string> {
    try {
      return await (env ? runCmd(cmd, args, { env }) : runCmd(cmd, args));
    } catch (err) {
      throw new Error(`${cloud}: ${what} failed: ${cliMessage(err)}`, { cause: err });
    }
  }

  return {
    async remove({ target, appName, projectId, config, scope = "project", keep = [] }) {
      // Never this app itself, whatever the caller passed.
      keep = keep.filter((k) => k !== appName);
      // The app's Secret Manager secrets (its secret variables).
      const deleteSecrets = async (
        project: string,
        ctx: { env?: Record<string, string>; run: CommandRunner },
      ): Promise<void> => {
        try {
          await deleteAppSecrets(project, appName, ctx);
        } catch (err) {
          throw new Error(`Cloud Run: deleting the secrets of ${appName} failed: ${cliMessage(err)}`, { cause: err });
        }
      };
      const fnPrefix = `${appName}-fn-`;
      // A Cloud Run service this teardown removes: the app, its functions
      // (not a kept app's) and its ISR cache `<app>-isr`: that exact name
      // AND its labels (nbo-role=isrcache, nbo-app=<app>), read first, so
      // another service sharing the name is never deleted.
      const isrService = `${appName}-isr`;
      const ownService = async (name: string, where: string[], env?: Record<string, string>): Promise<boolean> => {
        if (name === appName || (name.startsWith(fnPrefix) && !keptBy(keep, name))) return true;
        if (name !== isrService) return false;
        const out = await step(
          "Cloud Run",
          `reading ${name}`,
          "gcloud",
          ["run", "services", "describe", name, ...where, "--format=json"],
          env,
        );
        return isIsrcacheServiceOf(parseServiceLabels(out), appName);
      };
      if (target === "kubernetes" && options.mode === "production") {
        if (!projectId) throw new Error("Kubernetes: no project recorded for this environment");
        const clusterId = typeof config.clusterId === "string" ? config.clusterId : "";
        if (!clusterId) throw new Error("Kubernetes: this environment has no cluster recorded");
        const conn = options.store?.getKubernetesConnection(clusterId);
        if (!options.store || !conn)
          throw new Error("Kubernetes: the cluster this environment runs on is no longer connected");
        const { kubeconfig } = options.store.getKubernetesSecrets(conn.id);
        const ns = projectNamespace(projectId);
        await withKubeconfig(kubeconfig, undefined, async (kube) => {
          try {
            if (scope === "app") {
              await removeKubernetesApp(step, ["--kubeconfig", kube.kubeconfig!, "-n", ns], appName, keep);
              return;
            }
            await step("Kubernetes", `deleting namespace ${ns}`, "kubectl", [
              "--kubeconfig",
              kube.kubeconfig!,
              "delete",
              "namespace",
              ns,
              "--ignore-not-found",
              "--wait=false",
            ]);
          } catch (err) {
            // eslint-disable-next-line preserve-caught-error -- the original error may carry the kubeconfig
            throw new Error(redact(err instanceof Error ? err.message : String(err), kubeconfigSecrets(kubeconfig)));
          }
        });
        return;
      }
      if (target === "kubernetes") {
        const ctx = ["--context", kindContext];
        await step("Kubernetes", `deleting ${appName}`, "kubectl", [
          ...ctx,
          "delete",
          "deployment,service,ingress",
          appName,
          "--ignore-not-found",
        ]);
        await removeIsrcache(step, ctx, appName);
        const listed = await step("Kubernetes", "listing function deployments", "kubectl", [
          ...ctx,
          "get",
          "deployments",
          "-o",
          "name",
        ]);
        for (const line of listed.split(/\r?\n/)) {
          const name = line.trim().replace(/^deployment(\.apps)?\//, "");
          if (name.startsWith(fnPrefix) && !keptBy(keep, name)) {
            await step("Kubernetes", `deleting ${name}`, "kubectl", [
              ...ctx,
              "delete",
              "deployment,service",
              name,
              "--ignore-not-found",
            ]);
          }
        }
        return;
      }
      if (target === "cloudrun" && options.mode === "production") {
        const project = String(config.project ?? "");
        const region = String(config.region ?? "");
        if (!project || !region) throw new Error("Cloud Run: this environment has no project/region recorded");
        if (!options.store?.getGoogleConnection()) throw new Error("Cloud Run: Google Cloud is not connected");
        const keys = options.store.getGoogleSecrets();
        const secrets = googleSecrets(keys);
        const where = ["--project", project, "--region", region];
        try {
          await withGoogleCredentials(googleCredential(options.store), region, runCmd, async ({ env }) => {
            // Domain mappings go before the services they point at. A mapping
            // Google no longer has counts as removed; any other failure stops
            // the teardown and leaves the row visible. One app (a custom
            // environment) has none: mappings are Production's only.
            for (const row of projectId && scope === "project" ? options.store!.listDomains(projectId) : []) {
              if (row.serving !== "cloudrun" && !row.mappingKept) continue;
              try {
                await runCmd("gcloud", [...mappingCommand, "delete", "--domain", row.host, ...where, "--quiet"], {
                  env,
                });
              } catch (err) {
                const gone = await mappingMissing(cliMessage(err), row.host, () =>
                  runCmd("gcloud", listMappingsArgs(where), { env }),
                );
                if (!gone)
                  throw new Error(`Cloud Run: removing the domain mapping of ${row.host} failed: ${cliMessage(err)}`, {
                    cause: err,
                  });
              }
              if (row.serving === "cloudrun") options.store!.deleteDomain(row.id);
              else
                options.store!.updateDomain(row.id, { mappingKept: false, mappingRemoveAfter: "", mappingRecords: [] });
            }
            const listed = await step(
              "Cloud Run",
              "listing services",
              "gcloud",
              ["run", "services", "list", ...where, "--format=value(metadata.name)"],
              env,
            );
            for (const line of listed.split(/\r?\n/)) {
              const name = line.trim();
              if (!(await ownService(name, where, env))) continue;
              await step(
                "Cloud Run",
                `deleting ${name}`,
                "gcloud",
                ["run", "services", "delete", name, ...where, "--quiet"],
                env,
              );
              try {
                await deleteServiceIdentity(project, name, { env, run: runCmd });
              } catch (err) {
                throw new Error(`Cloud Run: deleting the service account of ${name} failed: ${cliMessage(err)}`, {
                  cause: err,
                });
              }
            }
            await deleteSecrets(project, { env, run: runCmd });
          });
        } catch (err) {
          // eslint-disable-next-line preserve-caught-error -- the original error may carry key material
          throw new Error(redact(err instanceof Error ? err.message : String(err), secrets));
        }
        return;
      }
      if (target === "cloudrun") {
        const project = String(config.project ?? "");
        const region = String(config.region ?? "");
        if (!project || !region) throw new Error("Cloud Run: this environment has no project/region recorded");
        const where = ["--project", project, "--region", region];
        const listed = await step("Cloud Run", "listing services", "gcloud", [
          "run",
          "services",
          "list",
          ...where,
          "--format=value(metadata.name)",
        ]);
        for (const line of listed.split(/\r?\n/)) {
          const name = line.trim();
          if (await ownService(name, where)) {
            await step("Cloud Run", `deleting ${name}`, "gcloud", [
              "run",
              "services",
              "delete",
              name,
              ...where,
              "--quiet",
            ]);
          }
        }
        await deleteSecrets(project, { run: runCmd });
        return;
      }
      if (target === "lambda") {
        if (!options.store?.getAwsConnection()) throw new Error("Lambda: AWS is not connected");
        const keys = options.store.getAwsSecrets();
        try {
          await removeLambdaApp(awsContext(awsCredentials(options.store), runCmd), appName, keep);
        } catch (err) {
          // eslint-disable-next-line preserve-caught-error -- the original error may carry the key pair
          throw new Error(redact(`Lambda: ${cliMessage(err)}`, [keys.accessKeyId, keys.secretAccessKey]));
        }
        return;
      }
      throw new Error(`unknown target "${target}"`);
    },
  };
}
