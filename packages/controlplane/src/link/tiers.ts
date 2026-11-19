// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Tier } from "@nbo/link-protocol";
import { routeLinkTier, type LinkTier, type TierFn } from "../http/access.js";

// resolveTier: the tier a linked platform's instruction for routeKey needs,
// or null when the link may not use that route at all. A route with no row,
// an inherited key, a tier function that throws or answers anything but
// 0, 1 or 2 all fail closed (null for no row, 2 for a function). table is
// routeLinkTier; tests pass their own to reach the fail-closed paths.
// A tier function that reads stored state reads it when the instruction is
// verified, not when its handler runs; the handler checks state again.
export function resolveTier(
  routeKey: string,
  input: Parameters<TierFn>[0],
  table: Readonly<Record<string, LinkTier>> = routeLinkTier,
): Tier | null {
  if (!Object.prototype.hasOwnProperty.call(table, routeKey)) return null;
  const tier = table[routeKey];
  if (tier === null || tier === undefined) return null;
  if (tier === 0 || tier === 1 || tier === 2) return tier;
  if (typeof tier !== "function") return null;
  try {
    const out: unknown = tier(input);
    return out === 0 || out === 1 || out === 2 ? out : 2;
  } catch {
    return 2;
  }
}

// requiredRole: the member role whose key may sign a Tier 2 instruction for
// routeKey. Member keys themselves are managed by owners only.
export function requiredRole(routeKey: string): "admin" | "owner" {
  const space = routeKey.indexOf(" ");
  const path = space < 0 ? routeKey : routeKey.slice(space + 1);
  return path === "/link/member-keys" || path.startsWith("/link/member-keys/") ? "owner" : "admin";
}

// sealedFields: the body fields that must arrive encrypted to core's key
// (variable values, git tokens, certificate keys, admin credentials), as
// dotted paths into the body. json: the opened value is JSON, not a string.
export const sealedFields: Readonly<Record<string, readonly { path: string; json?: true }[]>> = Object.freeze({
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
});

// bodyKeys: the only body keys the link may send to a route, where the
// route's own handler would otherwise ignore extra keys.
export const bodyKeys: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "POST /projects/{projectID}/builds": ["revision", "stage", "values"],
  "POST /projects/{projectID}/git/poll": [],
});

// cloudChoiceFields: in a cloud choice, the keys that name a Google Cloud
// project or Artifact Registry repository of the platform's choosing. Over
// the link a Cloud Run choice is "auto" only (core's own connected project);
// a manual choice could point core at someone else's project.
const cloudChoiceFields = ["project", "arRepo"] as const;

function cloudChoiceRefusal(choice: unknown, prefix: string): string | null {
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return null;
  for (const k of cloudChoiceFields) if (Object.prototype.hasOwnProperty.call(choice, k)) return `${prefix}${k}`;
  if ((choice as Record<string, unknown>).mode === "manual") return `${prefix}mode`;
  return null;
}

// linkForbiddenField: a body field the link may not send to routeKey (the
// dotted path named in the refusal), or null. Each route's own handler would
// accept it from a loopback caller or an API token.
export function linkForbiddenField(routeKey: string, body: unknown): string | null {
  const isObject = typeof body === "object" && body !== null && !Array.isArray(body);
  const allowed = Object.prototype.hasOwnProperty.call(bodyKeys, routeKey) ? bodyKeys[routeKey] : undefined;
  if (allowed && isObject) {
    for (const k of Object.keys(body)) if (!allowed.includes(k)) return k;
  }
  if (routeKey === "POST /projects/{projectID}/transfer") return cloudChoiceRefusal(body, "");
  if (routeKey === "POST /projects/{projectID}/stages" && isObject) {
    const clouds = (body as Record<string, unknown>).clouds;
    if (Array.isArray(clouds)) {
      for (let i = 0; i < clouds.length; i++) {
        const refused = cloudChoiceRefusal(clouds[i], `clouds.${i}.`);
        if (refused) return refused;
      }
    }
  }
  return null;
}
