// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWith, retryPropagation, type ToolContext } from "./run.js";

export interface DeploySpec {
  serviceName: string;
  imageTag: string; // full Artifact Registry path, already pushed
  project: string;
  region: string;
  contentID: string;
  allowUnauthenticated: boolean;
  // memoryMB and maxDurationSec mirror a function's declared
  // function.json resources.memoryMb/maxDurationSec
  // (spec/function.schema.json). The planner already checks these
  // against capabilities.limits before a deploy is attempted —
  // undefined leaves gcloud's own platform defaults (512Mi, 300s) in
  // place, matching the static app's deploy, which has no resources
  // of its own to request.
  memoryMB?: number;
  maxDurationSec?: number;
  // serviceAccount is the email the service runs as; undefined leaves
  // Cloud Run's default (the project's compute service account).
  serviceAccount?: string;
  // fnConfig, when set, is written as the nbo-fn-config label
  // (functionDeployConfigHash of this spec) so a later deploy can tell
  // the live service was deployed with exactly this configuration.
  fnConfig?: string;
  // envFingerprint, when set, is the project's variable-set fingerprint
  // (32 hex characters, a valid label value), written as the nbo-env
  // label next to the content id. Part of the deploy args, so part of
  // functionDeployConfigHash (absent: hash unchanged).
  envFingerprint?: string;
  // plainEnv is the user's plain variables, delivered through a private
  // --env-vars-file (never as arguments). secretEnv maps each secret
  // variable to its Secret Manager secret id, mounted as NAME=<id>:latest.
  // When either has entries, the deploy replaces the full set of both
  // kinds (a kind with no entries is cleared). clearEnv clears both when
  // there are no variables but the live service had some. With none of
  // the three the args are exactly the pre-variables args.
  plainEnv?: Record<string, string>;
  secretEnv?: Record<string, string>;
  clearEnv?: boolean;
  // Scaling and CPU (the ISR cache service: 0 to 1 instance, 250
  // concurrent requests, 1 CPU). Absent: no flag, so the args (and the
  // config hashes) of every other service are unchanged.
  minInstances?: number;
  maxInstances?: number;
  concurrency?: number;
  cpu?: string;
  // executionEnvironment pins Cloud Run's execution environment (the ISR
  // cache: gen1, whose memory floor allows 256Mi with 1 CPU; gen2 needs
  // 512Mi). labels are extra labels after NBO's own (the cache's
  // nbo-role/nbo-app). Absent: no flag, no extra label.
  executionEnvironment?: "gen1" | "gen2";
  labels?: Record<string, string>;
}

// The labels that mark a service as one app's ISR cache: teardown, deploy
// and removal act on `<app>-isr` only when it carries both.
export function isrcacheServiceLabels(appName: string): Record<string, string> {
  return { "nbo-role": "isrcache", "nbo-app": appName };
}

export function isIsrcacheServiceOf(labels: Record<string, string> | undefined, appName: string): boolean {
  return labels?.["nbo-role"] === "isrcache" && labels["nbo-app"] === appName;
}

// parseServiceLabels reads the labels out of `gcloud run services
// describe --format=json` output (runners merge stderr warnings in: only
// the JSON object is parsed).
export function parseServiceLabels(out: string): Record<string, string> {
  const a = out.indexOf("{");
  const b = out.lastIndexOf("}");
  const result = JSON.parse(a >= 0 && b > a ? out.slice(a, b + 1) : out) as {
    metadata?: { labels?: Record<string, string> };
  };
  return result.metadata?.labels ?? {};
}

// serviceLabels returns the named service's labels, or undefined when it
// doesn't exist. Any other failure is thrown (callers must not act on a
// service they couldn't read).
export async function serviceLabels(
  serviceName: string,
  project: string,
  region: string,
  ctx?: ToolContext,
): Promise<Record<string, string> | undefined> {
  let out: string;
  try {
    out = await runWith(ctx, "gcloud", [
      "run",
      "services",
      "describe",
      serviceName,
      "--project",
      project,
      "--region",
      region,
      "--format=json",
    ]);
  } catch (err) {
    if (isServiceNotFound(err instanceof Error ? err.message : String(err))) return undefined;
    throw err;
  }
  return parseServiceLabels(out);
}

// envFilePlaceholder stands in for the temp file's path when args are
// built only to be hashed (the path is random per deploy).
const envFilePlaceholder = "<env-vars-file>";

// yamlUnsafe matches what may not appear raw in a YAML 1.1 double-quoted
// scalar: non-printables (DEL, C1 controls, BOM) and the extra YAML 1.1
// line breaks (NEL, LS, PS). JSON.stringify already escapes C0 controls,
// quotes and backslashes.
const yamlUnsafe = /[\u007f-\u009f\u2028\u2029\ufeff]/g;

function yamlQuote(s: string): string {
  return JSON.stringify(s).replace(yamlUnsafe, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// renderEnvVarsFile renders gcloud's --env-vars-file YAML: one
// `"KEY": "VALUE"` line per variable, both sides quoted so YAML 1.1 never
// reads YES/NO/ON/OFF/NULL/~/numbers as anything but strings, and every
// value round-trips byte-exactly.
export function renderEnvVarsFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${yamlQuote(k)}: ${yamlQuote(v)}\n`)
    .join("");
}

// contentIDLabel truncates a content id to fit a GCP label value:
// labels must be <=63 characters, lowercase letters/digits/hyphens/
// underscores only. A sha256 digest is 64 lowercase hex characters
// (one over the limit on its own) plus a "sha256:" prefix GCP would
// reject outright, so this strips the prefix and keeps the first 32
// hex characters — far more collision-resistant than the
// 12-character truncation cmd/nbo/deploy.go already uses for image
// tags, and this is that same kind of no-op-detection shortcut, not a
// security boundary — port of ContentIDLabel (deploy.go lines 36-42).
export function contentIDLabel(contentID: string): string {
  const hex = contentID.startsWith("sha256:") ? contentID.slice("sha256:".length) : contentID;
  return hex.length > 32 ? hex.slice(0, 32) : hex;
}

// buildDeployArgs is a pure helper split out so the resulting
// `gcloud run deploy` arguments are unit-testable without actually
// running gcloud — port of buildDeployArgs (deploy.go lines 69-90).
export function buildDeployArgs(spec: DeploySpec, envVarsFile?: string): string[] {
  const args = [
    "run",
    "deploy",
    spec.serviceName,
    "--image",
    spec.imageTag,
    "--project",
    spec.project,
    "--region",
    spec.region,
    "--labels",
    `nbo-content-id=${contentIDLabel(spec.contentID)}${spec.fnConfig ? `,nbo-fn-config=${spec.fnConfig}` : ""}${spec.envFingerprint ? `,nbo-env=${spec.envFingerprint}` : ""}${Object.entries(
      spec.labels ?? {},
    )
      .map(([k, v]) => `,${k}=${v}`)
      .join("")}`,
    "--quiet",
  ];
  args.push(spec.allowUnauthenticated ? "--allow-unauthenticated" : "--no-allow-unauthenticated");
  if (spec.memoryMB !== undefined) {
    args.push("--memory", `${spec.memoryMB}Mi`);
  }
  if (spec.maxDurationSec !== undefined) {
    args.push("--timeout", `${spec.maxDurationSec}`);
  }
  if (spec.serviceAccount !== undefined) {
    args.push("--service-account", spec.serviceAccount);
  }
  if (spec.minInstances !== undefined) args.push("--min-instances", `${spec.minInstances}`);
  if (spec.maxInstances !== undefined) args.push("--max-instances", `${spec.maxInstances}`);
  if (spec.concurrency !== undefined) args.push("--concurrency", `${spec.concurrency}`);
  if (spec.cpu !== undefined) args.push("--cpu", spec.cpu);
  if (spec.executionEnvironment !== undefined) args.push("--execution-environment", spec.executionEnvironment);
  const plain = Object.keys(spec.plainEnv ?? {});
  const secret = Object.keys(spec.secretEnv ?? {}).sort();
  if (plain.length > 0 || secret.length > 0 || spec.clearEnv) {
    if (plain.length > 0) args.push("--env-vars-file", envVarsFile ?? envFilePlaceholder);
    else args.push("--clear-env-vars");
    if (secret.length > 0) args.push("--set-secrets", secret.map((n) => `${n}=${spec.secretEnv![n]}:latest`).join(","));
    else args.push("--clear-secrets");
  }
  return args;
}

// isServiceNotFound recognizes gcloud's real error text for a service
// that doesn't exist yet — confirmed 2026-10-24 against a real
// project: "ERROR: (gcloud.run.services.describe) Cannot find
// service [<name>]" — port of isServiceNotFound (deploy.go lines
// 116-118).
export function isServiceNotFound(output: string): boolean {
  return output.includes("Cannot find service");
}

interface DescribeResult {
  status: { url: string };
  metadata: { labels?: Record<string, string> };
}

// extractContentIDLabel is split out of liveContentID so the
// no-labels-at-all case (a real possibility right after a service is
// first created, before any label has ever been written) is
// unit-testable without a real gcloud call — reading result.metadata
// .labels[...] directly would throw a TypeError when labels is
// missing instead of correctly returning ok=false.
// The nbo-env label, when present, is returned as fingerprint.
export function extractContentIDLabel(result: DescribeResult): { id: string; ok: boolean; fingerprint?: string } {
  const id = result.metadata.labels?.["nbo-content-id"];
  const fingerprint = result.metadata.labels?.["nbo-env"];
  return fingerprint ? { id: id ?? "", ok: id !== undefined, fingerprint } : { id: id ?? "", ok: id !== undefined };
}

async function describeService(
  serviceName: string,
  project: string,
  region: string,
  ctx?: ToolContext,
): Promise<DescribeResult> {
  const out = await runWith(ctx, "gcloud", [
    "run",
    "services",
    "describe",
    serviceName,
    "--project",
    project,
    "--region",
    region,
    "--format=json",
  ]);
  // Real runners merge stderr into the output: keep only the JSON object.
  const a = out.indexOf("{");
  const b = out.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? out.slice(a, b + 1) : out) as DescribeResult;
}

// deploy runs `gcloud run deploy`, which is synchronous — it already
// waits for the new revision to serve traffic before returning,
// unlike Kubernetes' separate apply-then-rollout-status steps — then
// reads the service's URL back via describeService — port of Deploy
// (deploy.go lines 96-111). No existing Go unit test; ships
// build-verified only.
export async function deploy(spec: DeploySpec, ctx?: ToolContext): Promise<string> {
  const plain = spec.plainEnv && Object.keys(spec.plainEnv).length > 0 ? spec.plainEnv : undefined;
  // Plain values go through a file in a private temp directory, removed
  // even when the deploy fails.
  const dir = plain ? await mkdtemp(join(tmpdir(), "nbo-env-")) : undefined;
  try {
    let file: string | undefined;
    if (dir && plain) {
      await chmod(dir, 0o700);
      file = join(dir, "env.yaml");
      await writeFile(file, renderEnvVarsFile(plain), { encoding: "utf8", mode: 0o600 });
    }
    const args = buildDeployArgs(spec, file);
    // A freshly created per-service identity, or a just-granted secret
    // accessor role, may not be visible to Cloud Run yet; only those
    // cases retry.
    const secrets = Object.keys(spec.secretEnv ?? {}).length > 0;
    if (spec.serviceAccount !== undefined || secrets)
      await retryPropagation(ctx, () => runWith(ctx, "gcloud", args), secrets ? secretNotYetGranted : undefined);
    else await runWith(ctx, "gcloud", args);
  } finally {
    // Best effort: a failed removal never replaces the deploy's error or result.
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `nbo: could not remove the env file directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  const result = await describeService(spec.serviceName, spec.project, spec.region, ctx);
  return result.status.url;
}

// functionDeployConfigHash fingerprints everything a function deploy
// configures besides the image's content: the `gcloud run deploy`
// arguments (image reference, memory, timeout, ingress auth, run-as
// service account, ...) and the invoker member granted on it. 32
// lowercase hex characters, a valid GCP label value. Any fnConfig
// already on spec is ignored, so the hash can label the very deploy it
// describes.
//
// clearEnv is left out (a one-off cleanup, not configuration) and the
// env file's path is a fixed placeholder; plain values are hashed in
// their place. Without variables the hash is the pre-variables hash.
export function functionDeployConfigHash(spec: DeploySpec, invokerMember: string): string {
  const args = buildDeployArgs({ ...spec, fnConfig: undefined, clearEnv: undefined });
  const plainEnv = spec.plainEnv && Object.keys(spec.plainEnv).length > 0 ? spec.plainEnv : undefined;
  return createHash("sha256")
    .update(JSON.stringify(plainEnv ? { args, invokerMember, plainEnv } : { args, invokerMember }))
    .digest("hex")
    .slice(0, 32);
}

// secretNotYetGranted is Cloud Run's refusal while a just-granted
// secretAccessor role is still propagating.
const secretNotYetGranted = /Permission denied on secret/i;

export interface LiveServiceState {
  image: string;
  url: string;
  // The nbo-fn-config label ("" when absent).
  config: string;
  // The nbo-env label: the variable-set fingerprint ("" when absent).
  fingerprint: string;
  // Names of the container env vars mounted from Secret Manager.
  secretEnvNames: string[];
  // Ready condition True AND the latest created revision is the latest
  // ready one: false when a new revision failed to become ready (the
  // spec then names an image that is not serving).
  ready: boolean;
}

interface FullDescribeResult {
  metadata?: { labels?: Record<string, string> };
  spec?: {
    template?: {
      spec?: { containers?: { image?: string; env?: { name?: string; valueFrom?: { secretKeyRef?: unknown } }[] }[] };
    };
  };
  status?: {
    url?: string;
    latestReadyRevisionName?: string;
    latestCreatedRevisionName?: string;
    conditions?: { type?: string; status?: string }[];
  };
}

// liveServiceState reads a service's image, URL, nbo-fn-config label
// and readiness in one `gcloud run services describe --format=json`, or
// undefined when it can't be read — a missing service, any gcloud
// failure, or output without an image and URL. Callers use it only to
// skip work, so "unknown" just means "deploy as usual". Runners merge
// stderr into the output: only the JSON object is parsed.
export async function liveServiceState(
  serviceName: string,
  project: string,
  region: string,
  ctx?: ToolContext,
): Promise<LiveServiceState | undefined> {
  let result: FullDescribeResult;
  try {
    const out = await runWith(ctx, "gcloud", [
      "run",
      "services",
      "describe",
      serviceName,
      "--project",
      project,
      "--region",
      region,
      "--format=json",
    ]);
    const a = out.indexOf("{");
    const b = out.lastIndexOf("}");
    if (a < 0 || b <= a) return undefined;
    result = JSON.parse(out.slice(a, b + 1)) as FullDescribeResult;
  } catch {
    return undefined;
  }
  const container = result.spec?.template?.spec?.containers?.[0];
  const image = container?.image ?? "";
  const secretEnvNames = (container?.env ?? []).filter((e) => e.valueFrom?.secretKeyRef && e.name).map((e) => e.name!);
  const url = result.status?.url ?? "";
  if (!image || !url) return undefined;
  const status = result.status!;
  const readyCondition = status.conditions?.find((c) => c.type === "Ready")?.status === "True";
  const ready =
    readyCondition &&
    !!status.latestCreatedRevisionName &&
    status.latestReadyRevisionName === status.latestCreatedRevisionName;
  return {
    image,
    url,
    config: result.metadata?.labels?.["nbo-fn-config"] ?? "",
    fingerprint: result.metadata?.labels?.["nbo-env"] ?? "",
    secretEnvNames,
    ready,
  };
}

// liveContentID reads the nbo-content-id label off the named service.
// ok is false if the service does not exist yet (a brand new app or
// function being deployed for the first time), which the caller must
// treat as "not live", not as an error — mirroring adapter-k8s's own
// liveContentID contract — port of LiveContentID (deploy.go lines
// 124-134). No existing Go unit test; ships build-verified only.
export async function liveContentID(
  serviceName: string,
  project: string,
  region: string,
  ctx?: ToolContext,
): Promise<{ id: string; ok: boolean; fingerprint?: string }> {
  try {
    const result = await describeService(serviceName, project, region, ctx);
    return extractContentIDLabel(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isServiceNotFound(message)) {
      return { id: "", ok: false };
    }
    throw err;
  }
}

// deleteService deletes the named service; one that is already gone
// counts as deleted.
export async function deleteService(
  serviceName: string,
  project: string,
  region: string,
  ctx?: ToolContext,
): Promise<void> {
  try {
    await runWith(ctx, "gcloud", [
      "run",
      "services",
      "delete",
      serviceName,
      "--project",
      project,
      "--region",
      region,
      "--quiet",
    ]);
  } catch (err) {
    if (!isServiceNotFound(err instanceof Error ? err.message : String(err))) throw err;
  }
}

// removeSecretEnv drops env vars mounted from Secret Manager from the
// live service, in one update — needed before a name that was a secret
// is deployed as a plain value (gcloud refuses the same name as both).
export async function removeSecretEnv(
  serviceName: string,
  project: string,
  region: string,
  names: string[],
  ctx?: ToolContext,
): Promise<void> {
  await runWith(ctx, "gcloud", [
    "run",
    "services",
    "update",
    serviceName,
    "--region",
    region,
    "--project",
    project,
    "--remove-secrets",
    names.join(","),
    "--quiet",
  ]);
}
