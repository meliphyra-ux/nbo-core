// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { runWith, retryPropagation, type ToolContext } from "./run.js";

// defaultComputeServiceAccount returns the project's default compute
// service account email
// (<PROJECT_NUMBER>-compute@developer.gserviceaccount.com) — this
// plan deploys both the app and the function under it (no custom
// per-service service account; that's a future tightening), so
// granting it roles/run.invoker on the function service is what lets
// the app's own identity token actually authenticate — port of
// DefaultComputeServiceAccount (iam.go lines 15-27). No existing Go
// unit test; ships build-verified only.
export async function defaultComputeServiceAccount(project: string, ctx?: ToolContext): Promise<string> {
  const out = await runWith(ctx, "gcloud", ["projects", "describe", project, "--format=json"]);
  const result = JSON.parse(out) as { projectNumber: string };
  return `${result.projectNumber}-compute@developer.gserviceaccount.com`;
}

// grantInvoker lets memberServiceAccountEmail invoke the named
// (private) service — the app's own runtime identity calling its
// function — port of GrantInvoker (iam.go lines 31-40). No existing
// Go unit test; ships build-verified only.
export async function grantInvoker(serviceName: string, project: string, region: string, memberServiceAccountEmail: string, ctx?: ToolContext): Promise<void> {
  // The member may be a service account created seconds ago.
  await retryPropagation(ctx, () =>
    runWith(ctx, "gcloud", [
      "run",
      "services",
      "add-iam-policy-binding",
      serviceName,
      "--project",
      project,
      "--region",
      region,
      "--member",
      `serviceAccount:${memberServiceAccountEmail}`,
      "--role",
      "roles/run.invoker",
      "--quiet",
    ]),
  );
}

// serviceIdentityId is the service-account id (6-30 chars,
// [a-z][a-z0-9-]*) a Cloud Run service runs as: derived from the
// service name, so it is stable across deploys and never collides with
// another service's.
export function serviceIdentityId(serviceName: string): string {
  return "nbo-" + createHash("sha256").update(serviceName).digest("hex").slice(0, 21);
}

// serviceIdentityEmail is the email of the account ensureServiceIdentity
// creates for serviceName (computed; no API call).
export function serviceIdentityEmail(project: string, serviceName: string): string {
  return `${serviceIdentityId(serviceName)}@${project}.iam.gserviceaccount.com`;
}

const alreadyExists = /already exists|ALREADY_EXISTS/;

// ensureServiceIdentity creates the service's own service account when
// it is missing — with no roles at all — and returns its email. The
// email is computed, not parsed, because real runners merge gcloud's
// warnings into the output.
export async function ensureServiceIdentity(project: string, serviceName: string, ctx?: ToolContext): Promise<string> {
  const id = serviceIdentityId(serviceName);
  const email = serviceIdentityEmail(project, serviceName);
  try {
    await runWith(ctx, "gcloud", ["iam", "service-accounts", "describe", email, "--project", project]);
    return email;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!/NOT_FOUND|not found|does not exist|Unknown service account/i.test(text)) throw err;
  }
  try {
    await runWith(ctx, "gcloud", ["iam", "service-accounts", "create", id, "--project", project, "--display-name", `NBO ${serviceName}`]);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!alreadyExists.test(text)) throw err;
  }
  return email;
}

// deleteServiceIdentity removes the service's service account; one
// that is already gone is fine.
export async function deleteServiceIdentity(project: string, serviceName: string, ctx?: ToolContext): Promise<void> {
  const email = `${serviceIdentityId(serviceName)}@${project}.iam.gserviceaccount.com`;
  try {
    await runWith(ctx, "gcloud", ["iam", "service-accounts", "delete", email, "--project", project, "--quiet"]);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!/NOT_FOUND|not found|does not exist|Unknown service account/i.test(text)) throw err;
  }
}
