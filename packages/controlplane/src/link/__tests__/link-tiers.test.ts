// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../store/store.js";
import {
  environmentPatchTier,
  routeAccess,
  routeLinkTier,
  settingsTier,
  stageCreateTier,
  stageDeleteTier,
  stagePatchTier,
  suppliedValuesTier,
  type TierFn,
} from "../../http/access.js";
import { linkTierOf } from "@nbo/link-protocol";
import { bodyKeys, linkForbiddenField, requiredRole, resolveTier, sealedFields } from "../tiers.js";

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nbo-link-tiers-"));
  store = createStore(join(dir, "test.db"));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const input = (body: unknown, params: Record<string, string> = {}) => ({ body, params, store });

describe("settingsTier", () => {
  it("is 1 when every key is an operating setting", () => {
    expect(settingsTier(input({ pollingEnabled: false }))).toBe(1);
    expect(settingsTier(input({ speedInsights: true, speedInsightsInject: false, speedInsightsSampleRate: 50 }))).toBe(
      1,
    );
    expect(settingsTier(input({}))).toBe(1);
  });
  it("is 2 for a build setting", () => {
    expect(settingsTier(input({ buildCommand: "x" }))).toBe(2);
  });
  it("is 2 for an unknown key next to a known one", () => {
    expect(settingsTier(input({ pollingEnabled: true, extra: 1 }))).toBe(2);
  });
  it("is 2 for a body that is not an object", () => {
    for (const body of [[], null, undefined, "x", 1, true])
      expect(settingsTier(input(body)), JSON.stringify(body)).toBe(2);
  });
});

describe("suppliedValuesTier (builds, deploy, transfer)", () => {
  const routes = [
    "POST /projects/{projectID}/builds",
    "POST /builds/{buildID}/deploy",
    "POST /projects/{projectID}/transfer",
  ];
  it("is the tier function of the three routes that take supplied values", () => {
    for (const r of routes) expect(routeLinkTier[r], r).toBe(suppliedValuesTier);
  });
  it("is 1 for a body without values", () => {
    expect(suppliedValuesTier(input({}))).toBe(1);
    expect(suppliedValuesTier(input({ revision: "a".repeat(40), stage: "production" }))).toBe(1);
    expect(suppliedValuesTier(input({ target: "kubernetes", clusterId: "kc_a" }))).toBe(1);
    for (const r of routes) expect(resolveTier(r, input({ stage: "production" })), r).toBe(1);
  });
  it("is 2 whenever the body has a values key, even empty or null", () => {
    for (const values of [{ API_URL: { $sealed: "x" } }, {}, null, undefined, []]) {
      expect(suppliedValuesTier(input({ stage: "production", values })), JSON.stringify(values)).toBe(2);
      for (const r of routes) expect(resolveTier(r, input({ values })), r).toBe(2);
    }
  });
  it("is 2 for a body that is not an object", () => {
    for (const body of [[], null, undefined, "x", 1, true])
      expect(suppliedValuesTier(input(body)), JSON.stringify(body)).toBe(2);
  });
});

describe("stagePatchTier", () => {
  it("is 1 for expiresAt and autoDeploy", () => {
    expect(stagePatchTier(input({ expiresAt: "2026-12-01T00:00:00Z" }))).toBe(1);
    expect(stagePatchTier(input({ autoDeploy: false, expiresAt: "2026-12-01T00:00:00Z" }))).toBe(1);
  });
  it("is 2 for a branch, an unknown key or a body that is not an object", () => {
    expect(stagePatchTier(input({ branch: "dev" }))).toBe(2);
    expect(stagePatchTier(input({ autoDeploy: true, buildCommand: "x" }))).toBe(2);
    expect(stagePatchTier(input([]))).toBe(2);
    expect(stagePatchTier(input(null))).toBe(2);
  });
});

describe("environmentPatchTier", () => {
  it("is 1 for autoDeploy only", () => {
    expect(environmentPatchTier(input({ autoDeploy: true }))).toBe(1);
  });
  it("is 2 for anything that could change what an environment targets", () => {
    expect(environmentPatchTier(input({ autoDeploy: true, config: {} }))).toBe(2);
    expect(environmentPatchTier(input({ clusterId: "kc_x" }))).toBe(2);
    expect(environmentPatchTier(input({ region: "x" }))).toBe(2);
    expect(environmentPatchTier(input([]))).toBe(2);
    expect(environmentPatchTier(input("autoDeploy"))).toBe(2);
  });
});

describe("stageCreateTier", () => {
  const r = "POST /projects/{projectID}/stages";
  it("is the tier function of POST .../stages", () => {
    expect(routeLinkTier[r]).toBe(stageCreateTier);
  });
  it("is 1 for an ephemeral stage", () => {
    expect(stageCreateTier(input({ kind: "ephemeral", branch: "feature/x", ttlHours: 24 }))).toBe(1);
    expect(resolveTier(r, input({ kind: "ephemeral" }))).toBe(1);
  });
  it("is 2 for a custom environment, a missing kind or anything else", () => {
    for (const body of [
      { kind: "custom", name: "staging", branch: "staging" },
      { name: "staging", branch: "staging" },
      { kind: "EPHEMERAL" },
      { kind: ["ephemeral"] },
      JSON.parse('{"__proto__":{"kind":"ephemeral"}}') as unknown,
      [],
      null,
      undefined,
      "ephemeral",
    ]) {
      expect(stageCreateTier(input(body)), JSON.stringify(body)).toBe(2);
      expect(resolveTier(r, input(body)), JSON.stringify(body)).toBe(2);
    }
  });
});

describe("domains over the link", () => {
  it("adding a domain and installing a certificate are Tier 2", () => {
    expect(resolveTier("POST /projects/{projectID}/domains", input({ host: "shop.example.com" }))).toBe(2);
    expect(resolveTier("PUT /projects/{projectID}/domains/{domainID}/certificate", input({}))).toBe(2);
    expect(requiredRole("POST /projects/{projectID}/domains")).toBe("admin");
    expect(requiredRole("PUT /projects/{projectID}/domains/{domainID}/certificate")).toBe("admin");
  });
  it("other domain changes stay Tier 1", () => {
    for (const r of [
      "PATCH /projects/{projectID}/domains/{domainID}",
      "DELETE /projects/{projectID}/domains/{domainID}",
      "POST /projects/{projectID}/domains/{domainID}/check",
      "DELETE /projects/{projectID}/domains/{domainID}/certificate",
    ])
      expect(resolveTier(r, input({})), r).toBe(1);
  });
});

describe("stageDeleteTier", () => {
  it("is 1 for an ephemeral stage of the named project", () => {
    const p = store.createProject("shop");
    const s = store.createEphemeralStage(p.id, {
      branch: "feature/x",
      host: "feature-x--shop.127.0.0.1.sslip.io",
      expiresAt: "",
      label: "",
    });
    expect(stageDeleteTier(input(undefined, { projectID: p.id, stageID: s.id }))).toBe(1);
  });
  it("is 2 for a custom stage", () => {
    const p = store.createProject("shop");
    const s = store.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.127.0.0.1.sslip.io" });
    expect(stageDeleteTier(input(undefined, { projectID: p.id, stageID: s.id }))).toBe(2);
  });
  it("is 2 for an unknown stage id or a missing one", () => {
    const p = store.createProject("shop");
    expect(stageDeleteTier(input(undefined, { projectID: p.id, stageID: "stg_nope" }))).toBe(2);
    expect(stageDeleteTier(input(undefined, { projectID: p.id }))).toBe(2);
  });
  it("is 2 for an ephemeral stage of another project", () => {
    const p = store.createProject("shop");
    const other = store.createProject("other");
    const s = store.createEphemeralStage(p.id, {
      branch: "feature/x",
      host: "feature-x--shop.127.0.0.1.sslip.io",
      expiresAt: "",
      label: "",
    });
    expect(stageDeleteTier(input(undefined, { projectID: other.id, stageID: s.id }))).toBe(2);
  });
});

describe("resolveTier", () => {
  it("is null for a route with no row or a refused row", () => {
    expect(resolveTier("GET /nope", input(undefined))).toBeNull();
    expect(resolveTier("POST /projects/{projectID}/webhooks/github", input(undefined))).toBeNull();
    expect(resolveTier("GET /system/api-tokens", input(undefined))).toBeNull();
  });
  it("gives fixed tiers as they are", () => {
    expect(resolveTier("GET /projects", input(undefined))).toBe(0);
    expect(resolveTier("POST /projects/{projectID}/builds", input({}))).toBe(1);
    expect(resolveTier("POST /projects", input({}))).toBe(2);
  });
  it("runs tier functions", () => {
    expect(resolveTier("PATCH /projects/{projectID}/settings", input({ pollingEnabled: true }))).toBe(1);
    expect(resolveTier("PATCH /projects/{projectID}/settings", input({ framework: "static" }))).toBe(2);
    expect(resolveTier("PATCH /environments/{environmentID}", input({ autoDeploy: false }))).toBe(1);
  });
  it("gives 2 when a tier function throws or answers something else", () => {
    const throwing: TierFn = () => {
      throw new Error("boom");
    };
    const key = "PATCH /projects/{projectID}/settings";
    expect(resolveTier(key, input({}), { [key]: throwing })).toBe(2);
    expect(resolveTier(key, input({}), { [key]: (() => 7) as unknown as TierFn })).toBe(2);
    expect(resolveTier(key, input({}), { [key]: "1" as unknown as TierFn })).toBeNull();
  });
  it("routeLinkTier is frozen", () => {
    expect(Object.isFrozen(routeLinkTier)).toBe(true);
    expect(() => {
      (routeLinkTier as Record<string, unknown>)["GET /system/api-tokens"] = 0;
    }).toThrow();
    expect(resolveTier("GET /system/api-tokens", input(undefined))).toBeNull();
  });
  it("gives 2 for a JSON body with its own __proto__ or constructor key", () => {
    for (const json of [
      '{"__proto__":{"pollingEnabled":true}}',
      '{"constructor":1}',
      '{"pollingEnabled":true,"__proto__":null}',
    ]) {
      const body: unknown = JSON.parse(json);
      expect(resolveTier("PATCH /projects/{projectID}/settings", input(body)), json).toBe(2);
      expect(resolveTier("PATCH /environments/{environmentID}", input(body)), json).toBe(2);
      expect(resolveTier("PATCH /projects/{projectID}/stages/{stageID}", input(body)), json).toBe(2);
    }
  });
  it("does not read inherited keys", () => {
    expect(resolveTier("constructor", input(undefined))).toBeNull();
    expect(resolveTier("__proto__", input(undefined))).toBeNull();
  });
});

describe("requiredRole", () => {
  it("is owner for the member-key routes", () => {
    expect(requiredRole("POST /link/member-keys")).toBe("owner");
    expect(requiredRole("DELETE /link/member-keys/{keyId}")).toBe("owner");
    expect(requiredRole("GET /link/member-keys")).toBe("owner");
  });
  it("is admin for everything else", () => {
    expect(requiredRole("POST /projects")).toBe("admin");
    expect(requiredRole("POST /system/edge/install")).toBe("admin");
  });
});

describe("sealedFields and bodyKeys", () => {
  it("name only routes in the access table", () => {
    for (const route of [...Object.keys(sealedFields), ...Object.keys(bodyKeys)])
      expect(routeAccess, route).toHaveProperty([route]);
  });
  it("seal variable values, git tokens, certificate keys and admin credentials", () => {
    expect(sealedFields["PUT /projects/{projectID}/env/{name}"]).toEqual([{ path: "value" }]);
    expect(sealedFields["PUT /workspace/env/{name}"]).toEqual([{ path: "value" }]);
    expect(sealedFields["POST /projects/setup"]).toEqual([{ path: "credential.token" }]);
    expect(sealedFields["PUT /projects/{projectID}/git"]).toEqual([{ path: "credential.token" }]);
    expect(sealedFields["PUT /projects/{projectID}/domains/{domainID}/certificate"]).toEqual([{ path: "keyPem" }]);
    expect(sealedFields["POST /system/connections/google"]).toEqual([{ path: "keyJson" }]);
    for (const r of ["POST /system/connections/kubernetes", "PUT /system/connections/kubernetes/{id}"]) {
      expect(sealedFields[r], r).toEqual([
        { path: "source.kubeconfig" },
        { path: "source.token" },
        { path: "registryPassword" },
      ]);
    }
    for (const r of ["POST /system/edge/install", "POST /system/clusters/{id}/update-setup"]) {
      expect(sealedFields[r], r).toEqual([{ path: "admin.kubeconfig" }, { path: "admin.token" }]);
    }
    for (const r of [
      "POST /projects/{projectID}/builds",
      "POST /builds/{buildID}/deploy",
      "POST /projects/{projectID}/transfer",
    ]) {
      expect(sealedFields[r], r).toEqual([{ path: "values", json: true }]);
    }
  });
  it("list the build route's keys", () => {
    expect(bodyKeys["POST /projects/{projectID}/builds"]).toEqual(["revision", "stage", "values"]);
  });
});

describe("linkForbiddenField", () => {
  it("names a build body key outside the list", () => {
    expect(linkForbiddenField("POST /projects/{projectID}/builds", { repo: "https://example.com/other.git" })).toBe(
      "repo",
    );
    expect(
      linkForbiddenField("POST /projects/{projectID}/builds", { revision: "a".repeat(40), stage: "production" }),
    ).toBeNull();
  });
  it("refuses a manual Cloud Run choice in a transfer", () => {
    expect(
      linkForbiddenField("POST /projects/{projectID}/transfer", {
        target: "cloudrun",
        mode: "manual",
        project: "p-123456",
        region: "us-east1",
        arRepo: "x",
      }),
    ).toBe("project");
    expect(linkForbiddenField("POST /projects/{projectID}/transfer", { target: "cloudrun", arRepo: "x" })).toBe(
      "arRepo",
    );
    expect(linkForbiddenField("POST /projects/{projectID}/transfer", { target: "cloudrun", mode: "manual" })).toBe(
      "mode",
    );
    expect(
      linkForbiddenField("POST /projects/{projectID}/transfer", {
        target: "cloudrun",
        mode: "auto",
        region: "us-east1",
      }),
    ).toBeNull();
    expect(
      linkForbiddenField("POST /projects/{projectID}/transfer", { target: "kubernetes", clusterId: "kc_a" }),
    ).toBeNull();
  });
  it("refuses a manual Cloud Run choice in a new environment's clouds", () => {
    const manual = { target: "cloudrun", mode: "manual", project: "p-123456", region: "us-east1", arRepo: "x" };
    expect(
      linkForbiddenField("POST /projects/{projectID}/stages", {
        name: "staging",
        branch: "s",
        clouds: [{ target: "kubernetes" }, manual],
      }),
    ).toBe("clouds.1.project");
    expect(
      linkForbiddenField("POST /projects/{projectID}/stages", {
        name: "staging",
        branch: "s",
        clouds: [{ target: "cloudrun", mode: "auto" }],
      }),
    ).toBeNull();
  });
});

describe("git/poll", () => {
  it("git/poll is Tier 1 in all three tables and takes no body key over the link", () => {
    const route = "POST /projects/{projectID}/git/poll";
    expect(resolveTier(route, input(undefined))).toBe(1);
    expect(linkTierOf(route, undefined)).toBe(1);
    expect(linkForbiddenField(route, { revision: "x" })).toBe("revision");
  });
});
