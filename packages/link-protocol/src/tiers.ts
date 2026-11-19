// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { isSealedBox } from "./seal.js";
import type { Method } from "./messages.js";

// The link tier table as data, so a platform can classify an instruction
// without importing the control-plane. A core test holds it equal to the
// control-plane's own table.

export type TierRule =
  | 0
  | 1
  | 2
  | null
  | { onlyKeys: readonly string[] }
  | { withoutKey: string }
  | { keyEquals: { key: string; value: string } }
  | "core";
// onlyKeys: 1 when the body is a plain object with only these keys, else 2.
// withoutKey: 1 when the body is a plain object without this own key, else 2.
// keyEquals: 1 when the body is a plain object whose own key is exactly this
// string, else 2.
// "core": only core can decide, from its stored state.
export type LinkTierAnswer = 0 | 1 | 2 | "core" | null;

export interface InstructionDraft {
  method: Method;
  routePattern: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export const LINK_ROUTE_TIERS: Readonly<Record<string, TierRule>> = deepFreeze({
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
  "PATCH /projects/{projectID}/settings": {
    onlyKeys: ["pollingEnabled", "speedInsights", "speedInsightsInject", "speedInsightsSampleRate"],
  },
  "DELETE /projects/{projectID}": 2,

  // Environments and deployments. The legacy routes take raw paths or
  // unchecked cloud settings and stay refused.
  "GET /projects/{projectID}/environments": null,
  "POST /projects/{projectID}/environments": null,
  "POST /projects/{projectID}/environments/add": 2,
  "GET /environments/{environmentID}": 0,
  "PATCH /environments/{environmentID}": { onlyKeys: ["autoDeploy"] },
  "POST /environments/{environmentID}/archive": 1,
  "GET /environments/{environmentID}/deployments": null,
  "POST /environments/{environmentID}/deployments": null,

  // Git, builds and webhooks. The push webhook is not forwarded over the link.
  "GET /projects/{projectID}/git": 0,
  "GET /projects/{projectID}/protection": 0,
  "PUT /projects/{projectID}/protection": 2,
  "PUT /projects/{projectID}/git": 2,
  "POST /projects/{projectID}/git/deploy-key": 2,
  "POST /projects/{projectID}/git/poll": 1,
  "GET /projects/{projectID}/builds": 0,
  "POST /projects/{projectID}/builds": { withoutKey: "values" },
  "GET /builds/{buildID}": 0,
  "GET /builds/{buildID}/files": 0,
  "GET /builds/{buildID}/log": 0,
  "GET /builds/{buildID}/functions": 0,
  "POST /builds/{buildID}/deploy": { withoutKey: "values" },
  "POST /projects/{projectID}/webhooks/github": null,

  // Traffic and transfers
  "GET /projects/{projectID}/traffic": 0,
  "PUT /projects/{projectID}/traffic": 1,
  "POST /projects/{projectID}/transfer": { withoutKey: "values" },
  "POST /projects/{projectID}/transfer/cancel": 1,

  // Stages. Creating an ephemeral stage is operating; a custom environment
  // builds a branch with its own variables on a public host.
  "GET /projects/{projectID}/stages": 0,
  "POST /projects/{projectID}/stages": { keyEquals: { key: "kind", value: "ephemeral" } },
  "PATCH /projects/{projectID}/stages/{stageID}": { onlyKeys: ["expiresAt", "autoDeploy"] },
  "DELETE /projects/{projectID}/stages/{stageID}": "core",
  // ISR: revalidating is operating; the secret is Tier 2 (and never sent
  // back over the link).
  "POST /projects/{projectID}/stages/{stageID}/revalidate": 1,
  "POST /projects/{projectID}/stages/{stageID}/revalidate-secret": 2,
  "POST /projects/{projectID}/stages/{stageID}/revalidate-secret/rotate": 2,

  // Domains. Adding one attaches a host to the site and gets it a
  // certificate; installing a certificate brings key material: both Tier 2.
  "GET /projects/{projectID}/domains": 0,
  "POST /projects/{projectID}/domains": 2,
  "PATCH /projects/{projectID}/domains/{domainID}": 1,
  "DELETE /projects/{projectID}/domains/{domainID}": 1,
  "POST /projects/{projectID}/domains/{domainID}/check": 1,
  "POST /projects/{projectID}/domains/{domainID}/move-to-edge": 1,
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
  "GET /system/connections/google/identity": 0,
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
} as Record<string, TierRule>);

// The body fields that must arrive sealed to core's key, as dotted paths.
// json: the opened value is JSON, not a string.
export const LINK_SEALED_FIELDS: Readonly<Record<string, readonly { path: string; json?: true }[]>> = deepFreeze({
  "PUT /projects/{projectID}/env/{name}": [{ path: "value" }],
  "PUT /workspace/env/{name}": [{ path: "value" }],
  "POST /projects/setup": [{ path: "credential.token" }],
  "PUT /projects/{projectID}/git": [{ path: "credential.token" }],
  "PUT /projects/{projectID}/protection": [{ path: "password" }],
  "PUT /projects/{projectID}/domains/{domainID}/certificate": [{ path: "keyPem" }],
  "POST /system/connections/google": [{ path: "keyJson" }],
  "POST /system/connections/kubernetes": [
    { path: "source.kubeconfig" },
    { path: "source.token" },
    { path: "registryPassword" },
  ],
  "PUT /system/connections/kubernetes/{id}": [
    { path: "source.kubeconfig" },
    { path: "source.token" },
    { path: "registryPassword" },
  ],
  "POST /system/edge/install": [{ path: "admin.kubeconfig" }, { path: "admin.token" }],
  "POST /system/clusters/{id}/update-setup": [{ path: "admin.kubeconfig" }, { path: "admin.token" }],
  "POST /projects/{projectID}/builds": [{ path: "values", json: true }],
  "POST /builds/{buildID}/deploy": [{ path: "values", json: true }],
  "POST /projects/{projectID}/transfer": [{ path: "values", json: true }],
} as Record<string, { path: string; json?: true }[]>);

// "core" means possibly Tier 2: only core can decide, so treat it as needing a
// signature. Worst case is a refused instruction, never a bypass.
export function linkTierOf(routeKey: string, body: unknown): LinkTierAnswer {
  if (!own(LINK_ROUTE_TIERS, routeKey)) return null;
  const rule = LINK_ROUTE_TIERS[routeKey];
  if (rule === undefined || rule === null) return null;
  if (rule === 0 || rule === 1 || rule === 2 || rule === "core") return rule;
  if (typeof rule !== "object") return null;
  if ("onlyKeys" in rule) {
    return isPlainObject(body) && Object.keys(body).every((k) => rule.onlyKeys.includes(k)) ? 1 : 2;
  }
  if ("withoutKey" in rule) return isPlainObject(body) && !own(body, rule.withoutKey) ? 1 : 2;
  if ("keyEquals" in rule) {
    const { key, value } = rule.keyEquals;
    return isPlainObject(body) && own(body, key) && body[key] === value ? 1 : 2;
  }
  return null;
}

// The member role whose key may sign a Tier 2 instruction for routeKey.
export function tier2SignerRole(routeKey: string): "admin" | "owner" {
  const space = routeKey.indexOf(" ");
  const path = space < 0 ? routeKey : routeKey.slice(space + 1);
  return path === "/link/member-keys" || path.startsWith("/link/member-keys/") ? "owner" : "admin";
}

// The first declared sealed path whose value is present, not null and not a
// sealed box, or null.
export function sealedFieldInClear(routeKey: string, body: unknown): string | null {
  if (!own(LINK_SEALED_FIELDS, routeKey)) return null;
  for (const f of LINK_SEALED_FIELDS[routeKey]!) {
    let cur: unknown = body;
    for (const part of f.path.split(".")) {
      if (!isPlainObject(cur) || !own(cur, part)) {
        cur = undefined;
        break;
      }
      cur = cur[part];
    }
    if (cur === undefined || cur === null) continue;
    if (!isSealedBox(cur)) return f.path;
  }
  return null;
}
