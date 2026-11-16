// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Store } from "../store/store.js";

// Who may use each route (the token-only gate). Keys are
// "<METHOD> <pattern>" exactly as passed to router.handle; createMux looks
// up the pattern the router matched, so no spelling of a path can pick
// another row than the handler that runs. A route missing here is refused,
// and access-table.test.ts fails until every registered route has a row.
//
// public: anyone, from any Host, no token (only GET /healthz).
// webhook: the handler checks a signature; no token is read. Loopback or
//   the public address (NBO_PUBLIC_URL).
// token: a valid API token from anywhere, or no token from loopback.
// local: no token may use it (403); loopback only. Every /system/* row and
//   the two legacy routes that take raw paths or unchecked cloud settings.
export type Access = "public" | "webhook" | "token" | "local";

export const routeAccess: Record<string, Access> = {
  // Liveness (handlers.ts): no token, from any Host.
  "GET /healthz": "public",

  // Projects
  "GET /projects": "token",
  "GET /projects/summary": "token",
  "GET /projects/{projectID}": "token",
  "GET /projects/{projectID}/summary": "token",
  "POST /projects": "token",
  "POST /projects/setup": "token",
  "POST /projects/{projectID}/setup/retry": "token",
  "PATCH /projects/{projectID}/settings": "token",
  "DELETE /projects/{projectID}": "token",

  // Environments and deployments. The two legacy routes are local.
  "GET /projects/{projectID}/environments": "local",
  "POST /projects/{projectID}/environments": "local",
  "POST /projects/{projectID}/environments/add": "token",
  "GET /environments/{environmentID}": "token",
  "PATCH /environments/{environmentID}": "token",
  "POST /environments/{environmentID}/archive": "token",
  "GET /environments/{environmentID}/deployments": "local",
  "POST /environments/{environmentID}/deployments": "local",

  // Git, builds and webhooks
  "GET /projects/{projectID}/git": "token",
  "PUT /projects/{projectID}/git": "token",
  "POST /projects/{projectID}/git/deploy-key": "token",
  "POST /projects/{projectID}/git/poll": "token",
  "GET /projects/{projectID}/builds": "token",
  "POST /projects/{projectID}/builds": "token",
  "GET /builds/{buildID}": "token",
  "GET /builds/{buildID}/files": "token",
  "GET /builds/{buildID}/log": "token",
  "GET /builds/{buildID}/functions": "token",
  "POST /builds/{buildID}/deploy": "token",
  "POST /projects/{projectID}/webhooks/github": "webhook",

  // Traffic and transfers
  "GET /projects/{projectID}/traffic": "token",
  "PUT /projects/{projectID}/traffic": "token",
  "POST /projects/{projectID}/transfer": "token",
  "POST /projects/{projectID}/transfer/cancel": "token",

  // Stages (custom and ephemeral environments)
  "GET /projects/{projectID}/stages": "token",
  "POST /projects/{projectID}/stages": "token",
  "PATCH /projects/{projectID}/stages/{stageID}": "token",
  "DELETE /projects/{projectID}/stages/{stageID}": "token",
  // ISR: revalidating pages, and the environment's revalidation secret
  // (revalidate-routes.ts).
  "POST /projects/{projectID}/stages/{stageID}/revalidate": "token",
  "POST /projects/{projectID}/stages/{stageID}/revalidate-secret": "token",
  "POST /projects/{projectID}/stages/{stageID}/revalidate-secret/rotate": "token",

  // Domains
  "GET /projects/{projectID}/domains": "token",
  "POST /projects/{projectID}/domains": "token",
  "PATCH /projects/{projectID}/domains/{domainID}": "token",
  "DELETE /projects/{projectID}/domains/{domainID}": "token",
  "POST /projects/{projectID}/domains/{domainID}/check": "token",
  "POST /projects/{projectID}/domains/{domainID}/move-to-edge": "token",
  "PUT /projects/{projectID}/domains/{domainID}/certificate": "token",
  "DELETE /projects/{projectID}/domains/{domainID}/certificate": "token",

  // Variables and workspace settings
  "GET /projects/{projectID}/env": "token",
  "GET /projects/{projectID}/env/fingerprint": "token",
  "PUT /projects/{projectID}/env/{name}": "token",
  "DELETE /projects/{projectID}/env/{name}": "token",
  "GET /workspace/env": "token",
  "PUT /workspace/env/{name}": "token",
  "DELETE /workspace/env/{name}": "token",
  "GET /workspace/settings": "token",
  "PATCH /system/workspace-settings": "local",

  // System: status, connections, clusters, the edge and domains
  "GET /system/preflight": "local",
  "GET /system/connections": "local",
  "GET /system/regions": "local",
  "GET /system/regions/domain-mapping": "local",
  "GET /system/edge": "local",
  "GET /system/terraform-provider": "local",
  "GET /system/terraform-provider/{platform}": "local",
  "GET /system/connections/detect": "local",
  "GET /system/connections/plan": "local",
  "POST /system/connections/google": "local",
  "POST /system/connections/kubernetes": "local",
  "PUT /system/connections/kubernetes/{id}": "local",
  "DELETE /system/connections/kubernetes/{id}": "local",
  "POST /system/connections/kubernetes/{id}/test": "local",
  "POST /system/connections/{kind}/test": "local",
  "DELETE /system/connections/{kind}": "local",
  "GET /system/clusters/{id}/relay": "local",
  "POST /system/clusters/{id}/relay": "local",
  "POST /system/clusters/{id}/update-setup": "local",
  "POST /system/edge/install": "local",
  "POST /system/edge/reinstall": "local",
  "PATCH /system/domains": "local",

  // API tokens: made and revoked from loopback only.
  "GET /system/api-tokens": "local",
  "POST /system/api-tokens": "local",
  "DELETE /system/api-tokens/{id}": "local",

  // The link to a hosted dashboard: its status, journal and member keys
  // take a token; linking, unlinking and a keys reset are this computer's.
  "GET /link/status": "token",
  "GET /link/journal": "token",
  "GET /link/member-keys": "token",
  "POST /link/member-keys": "token",
  "DELETE /link/member-keys/{keyId}": "token",
  "POST /system/link/enroll": "local",
  "POST /system/link/unlink": "local",
  "POST /system/link/keys-reset": "local",
};

// What a linked platform may make core do, one tier per route (the link
// column). Keys are exactly those of routeAccess; access-table.test.ts
// holds them equal, so a new route is refused over the link until it is
// given a row here.
//
// 0: read. 1: operate (the platform's signature is enough).
// 2: change what runs or what core can reach (also needs a member's
//   signature). null: refused over the link, always.
// A function decides from the body or stored state; anything it does not
// recognise gives 2 (fail closed).
export type TierFn = (input: { body: unknown; params: Record<string, string>; store: Store }) => 0 | 1 | 2;
export type LinkTier = 0 | 1 | 2 | null | TierFn;

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// onlyKeysTier: 1 when the body is a plain object whose every key is in
// allowed, else 2.
const onlyKeysTier =
  (allowed: readonly string[]): TierFn =>
  ({ body }) =>
    isPlainObject(body) && Object.keys(body).every((k) => allowed.includes(k)) ? 1 : 2;

// Project settings: polling and Speed Insights are operating; anything else
// (build command, install command, root, output directory, framework, or a
// key added later) changes what runs.
export const settingsTier: TierFn = onlyKeysTier([
  "pollingEnabled",
  "speedInsights",
  "speedInsightsInject",
  "speedInsightsSampleRate",
]);

// A stage's expiry and auto-deploy are operating; its branch or build
// settings change what runs.
export const stagePatchTier: TierFn = onlyKeysTier(["expiresAt", "autoDeploy"]);

// A cloud's auto-deploy flag is operating; any key that could change which
// cloud, cluster, project, region or service it targets is not.
export const environmentPatchTier: TierFn = onlyKeysTier(["autoDeploy"]);

// Builds, deploys and transfers are operating, unless the body carries
// supplied variable values: those become the app's variables, which changes
// what runs, so a `values` key (even empty or null) needs an Admin's
// signature. A body that is not a plain object fails closed.
export const suppliedValuesTier: TierFn = ({ body }) =>
  isPlainObject(body) && !Object.prototype.hasOwnProperty.call(body, "values") ? 1 : 2;

// Creating an ephemeral stage is operating; a custom environment (kind
// "custom" or no kind) builds a branch with its own variables on a public
// host, which changes what runs.
export const stageCreateTier: TierFn = ({ body }) =>
  isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, "kind") && body.kind === "ephemeral" ? 1 : 2;

// Removing an ephemeral stage of this project is operating; removing a
// custom environment (or a stage core can't read) changes what runs.
export const stageDeleteTier: TierFn = ({ params, store }) => {
  try {
    if (typeof params.projectID !== "string" || typeof params.stageID !== "string") return 2;
    const stage = store.getStage(params.stageID);
    return stage.projectId === params.projectID && stage.kind === "ephemeral" ? 1 : 2;
  } catch {
    return 2;
  }
};

// Frozen: nothing at run time may widen what the link can reach.
export const routeLinkTier: Readonly<Record<string, LinkTier>> = Object.freeze({
  // Liveness
  "GET /healthz": 0,

  // Projects
  "GET /projects": 0,
  "GET /projects/summary": 0,
  "GET /projects/{projectID}": 0,
  "GET /projects/{projectID}/summary": 0,
  "POST /projects": 2,
  "POST /projects/setup": 2,
  "POST /projects/{projectID}/setup/retry": 2,
  "PATCH /projects/{projectID}/settings": settingsTier,
  "DELETE /projects/{projectID}": 2,

  // Environments and deployments. The legacy routes take raw paths or
  // unchecked cloud settings and stay refused.
  "GET /projects/{projectID}/environments": null,
  "POST /projects/{projectID}/environments": null,
  "POST /projects/{projectID}/environments/add": 2,
  "GET /environments/{environmentID}": 0,
  "PATCH /environments/{environmentID}": environmentPatchTier,
  "POST /environments/{environmentID}/archive": 1,
  "GET /environments/{environmentID}/deployments": null,
  "POST /environments/{environmentID}/deployments": null,

  // Git, builds and webhooks. The push webhook is not forwarded over the link.
  "GET /projects/{projectID}/git": 0,
  "PUT /projects/{projectID}/git": 2,
  "POST /projects/{projectID}/git/deploy-key": 2,
  "POST /projects/{projectID}/git/poll": 1,
  "GET /projects/{projectID}/builds": 0,
  "POST /projects/{projectID}/builds": suppliedValuesTier,
  "GET /builds/{buildID}": 0,
  "GET /builds/{buildID}/files": 0,
  "GET /builds/{buildID}/log": 0,
  "GET /builds/{buildID}/functions": 0,
  "POST /builds/{buildID}/deploy": suppliedValuesTier,
  "POST /projects/{projectID}/webhooks/github": null,

  // Traffic and transfers
  "GET /projects/{projectID}/traffic": 0,
  "PUT /projects/{projectID}/traffic": 1,
  "POST /projects/{projectID}/transfer": suppliedValuesTier,
  "POST /projects/{projectID}/transfer/cancel": 1,

  // Stages
  "GET /projects/{projectID}/stages": 0,
  "POST /projects/{projectID}/stages": stageCreateTier,
  "PATCH /projects/{projectID}/stages/{stageID}": stagePatchTier,
  "DELETE /projects/{projectID}/stages/{stageID}": stageDeleteTier,
  // ISR: revalidating is operating; the secret is Tier 2 (and never sent
  // back over the link).
  "POST /projects/{projectID}/stages/{stageID}/revalidate": 1,
  "POST /projects/{projectID}/stages/{stageID}/revalidate-secret": 2,
  "POST /projects/{projectID}/stages/{stageID}/revalidate-secret/rotate": 2,

  // Domains
  "GET /projects/{projectID}/domains": 0,
  // Adding a domain attaches a host to the site and gets it a certificate.
  "POST /projects/{projectID}/domains": 2,
  "PATCH /projects/{projectID}/domains/{domainID}": 1,
  "DELETE /projects/{projectID}/domains/{domainID}": 1,
  "POST /projects/{projectID}/domains/{domainID}/check": 1,
  "POST /projects/{projectID}/domains/{domainID}/move-to-edge": 1,
  // Installing a certificate brings key material.
  "PUT /projects/{projectID}/domains/{domainID}/certificate": 2,
  "DELETE /projects/{projectID}/domains/{domainID}/certificate": 1,

  // Variables and workspace settings: names are read, values never.
  "GET /projects/{projectID}/env": 0,
  "GET /projects/{projectID}/env/fingerprint": 0,
  "PUT /projects/{projectID}/env/{name}": 2,
  "DELETE /projects/{projectID}/env/{name}": 2,
  "GET /workspace/env": 0,
  "PUT /workspace/env/{name}": 2,
  "DELETE /workspace/env/{name}": 2,
  "GET /workspace/settings": 0,
  "PATCH /system/workspace-settings": 2,

  // System: only the narrow allowlist; the Terraform provider download is refused.
  "GET /system/preflight": 0,
  "GET /system/connections": 0,
  "GET /system/regions": 0,
  "GET /system/regions/domain-mapping": 0,
  "GET /system/edge": 0,
  "GET /system/terraform-provider": null,
  "GET /system/terraform-provider/{platform}": null,
  "GET /system/connections/detect": 0,
  "GET /system/connections/plan": 0,
  "POST /system/connections/google": 2,
  "POST /system/connections/kubernetes": 2,
  "PUT /system/connections/kubernetes/{id}": 2,
  "DELETE /system/connections/kubernetes/{id}": 2,
  "POST /system/connections/kubernetes/{id}/test": 1,
  "POST /system/connections/{kind}/test": 1,
  "DELETE /system/connections/{kind}": 2,
  "GET /system/clusters/{id}/relay": 0,
  "POST /system/clusters/{id}/relay": 2,
  "POST /system/clusters/{id}/update-setup": 2,
  "POST /system/edge/install": 2,
  "POST /system/edge/reinstall": 2,
  "PATCH /system/domains": 2,

  // API tokens are core's own access: never over the link.
  "GET /system/api-tokens": null,
  "POST /system/api-tokens": null,
  "DELETE /system/api-tokens/{id}": null,

  // The link: reads, and member keys (Tier 2, Owner keys only, see
  // requiredRole). Linking, unlinking and a keys reset are never over the
  // link: the team's way out and its recovery can't depend on the platform.
  "GET /link/status": 0,
  "GET /link/journal": 0,
  "GET /link/member-keys": 0,
  "POST /link/member-keys": 2,
  "DELETE /link/member-keys/{keyId}": 2,
  "POST /system/link/enroll": null,
  "POST /system/link/unlink": null,
  "POST /system/link/keys-reset": null,
});
