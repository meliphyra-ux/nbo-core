// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { runWith, retryWhile, type ToolContext } from "./run.js";

// secretId is the Secret Manager secret holding one secret variable of
// an app's service group (the app and its functions share it):
// nbo-<app>-<first 16 hex of sha256(name)>. Deterministic, carries no
// value, and well under the 255-character limit.
export function secretId(app: string, name: string): string {
  return `nbo-${app}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

const alreadyExists = /already exists|ALREADY_EXISTS/;
const notFound = /NOT_FOUND|not found/i;
const hashLine = /^[0-9a-f]{32}$/;

// lastHashLine finds the label value in output that may carry merged
// stderr lines.
function lastHashLine(out: string): string | undefined {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => hashLine.test(l))
    .pop();
}

// ensureSecretVersion makes sure the secret exists and its latest
// version holds value, and reports whether it added a version. The value
// only ever travels over stdin and is never read back: valueHash (an
// HMAC of the value the caller computes; never the value) is kept as the
// secret's nbo-value-hash label, and a version is added only when the
// label differs. Without valueHash a version is always added.
export async function ensureSecretVersion(
  project: string,
  id: string,
  value: string,
  valueHash: string | undefined,
  ctx?: ToolContext,
): Promise<boolean> {
  try {
    await runWith(ctx, "gcloud", ["secrets", "create", id, "--replication-policy=automatic", "--project", project]);
  } catch (err) {
    if (!alreadyExists.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  if (valueHash !== undefined) {
    let live: string | undefined;
    try {
      live = lastHashLine(
        await runWith(ctx, "gcloud", [
          "secrets",
          "describe",
          id,
          "--format=value(labels.nbo-value-hash)",
          "--project",
          project,
        ]),
      );
    } catch {
      live = undefined; // unreadable: add a version
    }
    if (live === valueHash) return false;
  }
  // Version first, then the label: a failure in between leaves a label
  // that does not match, so the next deploy adds the version again.
  await runWith(ctx, "gcloud", ["secrets", "versions", "add", id, "--data-file=-", "--project", project], value);
  if (valueHash !== undefined)
    await runWith(ctx, "gcloud", [
      "secrets",
      "update",
      id,
      `--update-labels=nbo-value-hash=${valueHash}`,
      "--project",
      project,
    ]);
  return true;
}

// accountNotYetVisible is IAM refusing a binding for an account created
// seconds ago — the only failure a grant retries (a generic permission
// denial that says "(or it may not exist)" is not one).
const accountNotYetVisible = /service account[^\n]*does not exist|does not exist[^\n]*service account/i;

// grantSecretAccessor lets one runtime account read one secret — per
// secret, never project-wide.
export async function grantSecretAccessor(
  project: string,
  id: string,
  accountEmail: string,
  ctx?: ToolContext,
): Promise<void> {
  await retryWhile(
    ctx,
    () =>
      runWith(ctx, "gcloud", [
        "secrets",
        "add-iam-policy-binding",
        id,
        "--member",
        `serviceAccount:${accountEmail}`,
        "--role",
        "roles/secretmanager.secretAccessor",
        "--project",
        project,
        "--quiet",
      ]),
    accountNotYetVisible,
  );
}

// secretManagerAccessError classifies a refused Secret Manager call:
// "disabled" when the API is off in the project (checked first: that
// error also says PERMISSION_DENIED), "denied" when the caller lacks the
// permission, undefined otherwise.
export function secretManagerAccessError(text: string): "disabled" | "denied" | undefined {
  if (/SERVICE_DISABLED|secretmanager\.googleapis\.com\] not enabled|API has not been used in project/.test(text))
    return "disabled";
  if (/PERMISSION_DENIED|does not have permission/.test(text)) return "denied";
  return undefined;
}

// versionNumbers reads `versions list --format=value(name)` output (full
// resource names or bare numbers, possibly with merged stderr lines).
function versionNumbers(out: string): number[] {
  const nums: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(?:projects\/[^/]+\/secrets\/[^/]+\/versions\/)?(\d+)$/.exec(line.trim());
    if (m) nums.push(Number(m[1]));
  }
  return nums;
}

// destroySupersededVersions destroys every enabled version of the secret
// except the newest one (the one ":latest" mounts), so replaced values
// neither linger nor keep being billed.
export async function destroySupersededVersions(project: string, id: string, ctx?: ToolContext): Promise<void> {
  const out = await runWith(ctx, "gcloud", [
    "secrets",
    "versions",
    "list",
    id,
    "--filter=state:ENABLED",
    "--format=value(name)",
    "--project",
    project,
  ]);
  const nums = versionNumbers(out).sort((a, b) => b - a);
  for (const v of nums.slice(1)) {
    await runWith(ctx, "gcloud", [
      "secrets",
      "versions",
      "destroy",
      String(v),
      "--secret",
      id,
      "--project",
      project,
      "--quiet",
    ]);
  }
}

// deleteAppSecrets deletes every secret secretId made for app. A project
// whose Secret Manager is off or out of reach never held any, so those
// refusals (and secrets already gone) are fine.
export async function deleteAppSecrets(project: string, app: string, ctx?: ToolContext): Promise<void> {
  let out: string;
  try {
    out = await runWith(ctx, "gcloud", [
      "secrets",
      "list",
      `--filter=name~nbo-${app}-`,
      "--format=value(name)",
      "--project",
      project,
    ]);
  } catch (err) {
    if (secretManagerAccessError(err instanceof Error ? err.message : String(err))) return;
    throw err;
  }
  const own = new RegExp(`^nbo-${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{16}$`);
  for (const line of out.split(/\r?\n/)) {
    const id = line.trim().split("/").pop() ?? "";
    if (!own.test(id)) continue;
    try {
      await runWith(ctx, "gcloud", ["secrets", "delete", id, "--project", project, "--quiet"]);
    } catch (err) {
      if (!notFound.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
}
