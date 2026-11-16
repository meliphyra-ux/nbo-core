// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import {
  generateEncryptionKeyPair,
  exportPublicKey,
  sealTo,
  LINK_ROUTE_TIERS,
  LINK_SEALED_FIELDS,
  linkTierOf,
  tier2SignerRole,
  sealedFieldInClear,
} from "../index.js";

describe("link tiers", () => {
  it("a static row answers itself", () => {
    expect(linkTierOf("GET /projects", null)).toBe(0);
    expect(linkTierOf("PUT /projects/{projectID}/traffic", {})).toBe(1);
    expect(linkTierOf("PUT /projects/{projectID}/env/{name}", {})).toBe(2);
    expect(linkTierOf("POST /system/api-tokens", {})).toBeNull();
  });
  it("an unknown or inherited route key is null", () => {
    expect(linkTierOf("GET /nope", null)).toBeNull();
    expect(linkTierOf("constructor", null)).toBeNull();
    expect(linkTierOf("__proto__", null)).toBeNull();
  });
  it("onlyKeys: 1 for a plain object with listed keys only, else 2", () => {
    const r = "PATCH /projects/{projectID}/settings";
    expect(linkTierOf(r, { pollingEnabled: true })).toBe(1);
    expect(linkTierOf(r, {})).toBe(1);
    expect(linkTierOf(r, { pollingEnabled: true, buildCommand: "x" })).toBe(2);
    for (const b of [null, [], "x", 3]) expect(linkTierOf(r, b)).toBe(2);
  });
  it("withoutKey: a values key, even null, is 2", () => {
    const r = "POST /projects/{projectID}/builds";
    expect(linkTierOf(r, { revision: "main" })).toBe(1);
    expect(linkTierOf(r, { values: null })).toBe(2);
    expect(linkTierOf(r, null)).toBe(2);
  });
  it("keyEquals: creating a stage is 1 only for an ephemeral one", () => {
    const r = "POST /projects/{projectID}/stages";
    expect(linkTierOf(r, { kind: "ephemeral", branch: "x" })).toBe(1);
    expect(linkTierOf(r, { kind: "custom", name: "staging" })).toBe(2);
    expect(linkTierOf(r, { name: "staging" })).toBe(2);
    expect(linkTierOf(r, { kind: "Ephemeral" })).toBe(2);
    expect(linkTierOf(r, { kind: ["ephemeral"] })).toBe(2);
    for (const b of [null, [], "ephemeral", 3, JSON.parse('{"__proto__":{"kind":"ephemeral"}}')])
      expect(linkTierOf(r, b)).toBe(2);
  });
  it("adding a domain and installing a certificate are Tier 2 for an Admin", () => {
    for (const r of [
      "POST /projects/{projectID}/domains",
      "PUT /projects/{projectID}/domains/{domainID}/certificate",
    ]) {
      expect(linkTierOf(r, {}), r).toBe(2);
      expect(tier2SignerRole(r), r).toBe("admin");
    }
  });
  it("deleting a stage is decided by core", () => {
    expect(linkTierOf("DELETE /projects/{projectID}/stages/{stageID}", null)).toBe("core");
  });
  it("member-key routes need an Owner; every other Tier 2 route an Admin", () => {
    expect(tier2SignerRole("POST /link/member-keys")).toBe("owner");
    expect(tier2SignerRole("DELETE /link/member-keys/{keyId}")).toBe("owner");
    expect(tier2SignerRole("PUT /workspace/env/{name}")).toBe("admin");
  });
  it("sealedFieldInClear names a clear declared field and passes sealed, absent or null ones", async () => {
    const r = await generateEncryptionKeyPair(false);
    const pub = await exportPublicKey(r.publicKey);
    const box = await sealTo(pub, "v", {
      coreId: "c1",
      route: "PUT /workspace/env/{name}",
      path: "/workspace/env/A",
      field: "value",
    });
    expect(sealedFieldInClear("PUT /workspace/env/{name}", { value: "plain" })).toBe("value");
    expect(sealedFieldInClear("PUT /workspace/env/{name}", { value: box })).toBeNull();
    expect(
      sealedFieldInClear("POST /system/connections/kubernetes", { source: { kubeconfig: "apiVersion: v1" } }),
    ).toBe("source.kubeconfig");
    expect(sealedFieldInClear("POST /projects/{projectID}/builds", { values: { A: "1" } })).toBe("values");
    expect(sealedFieldInClear("POST /projects/setup", { credential: { token: null } })).toBeNull();
    expect(sealedFieldInClear("GET /projects", { value: "x" })).toBeNull();
  });
  it("the tables are frozen, nested arrays and objects included", () => {
    expect(Object.isFrozen(LINK_ROUTE_TIERS)).toBe(true);
    expect(Object.isFrozen(LINK_SEALED_FIELDS)).toBe(true);
    const rule = LINK_ROUTE_TIERS["PATCH /projects/{projectID}/settings"] as { onlyKeys: readonly string[] };
    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(rule.onlyKeys)).toBe(true);
    expect(Object.isFrozen(LINK_SEALED_FIELDS["PUT /workspace/env/{name}"])).toBe(true);
  });
});
