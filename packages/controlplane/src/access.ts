// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

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
  "GET /projects/{projectID}/builds": "token",
  "POST /projects/{projectID}/builds": "token",
  "GET /builds/{buildID}": "token",
  "GET /builds/{buildID}/files": "token",
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
};
