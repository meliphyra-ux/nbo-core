// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, ErrDuplicateName, ErrNotFound, type Store } from "../store.js";
import { stageRowName, validateStageName, type Stage } from "../stages.js";
import { desiredTargetFor } from "../edge-sync.js";
import { transferConfig } from "../transfer.js";
import { startHarness, deployedProject, type Harness } from "./v2-harness.js";

const openStores: Store[] = [];
afterEach(() => {
  for (const s of openStores.splice(0)) s.close();
});

const storePaths = new WeakMap<Store, string>();
const dbPathOf = (s: Store): string => storePaths.get(s)!;

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-stages-"));
  const s = createStore(join(dir, "test.db"));
  storePaths.set(s, join(dir, "test.db"));
  openStores.push(s);
  return s;
}

describe("stages in the store", () => {
  it("createProject makes the three built-in stages", async () => {
    const s = await openTestStore();
    const p = s.createProject("shop");
    const stages = s.listStages(p.id);
    expect(stages.map((st) => [st.name, st.kind])).toEqual([
      ["production", "production"],
      ["preview", "preview"],
      ["development", "development"],
    ]);
    for (const st of stages) {
      expect(st.id).toMatch(/^stg_[0-9a-f]{16}$/);
      expect(st).toMatchObject({ projectId: p.id, branch: "", host: "", lastSeenSha: "" });
    }
    expect(s.productionStage(p.id).name).toBe("production");
    expect(s.getStageByName(p.id, "preview").kind).toBe("preview");
    expect(s.getStage(stages[2]!.id).name).toBe("development");
  });

  it("validates custom stage names", () => {
    for (const ok of ["staging", "a", "qa-2", "a".repeat(16)]) expect(validateStageName(ok)).toBeNull();
    for (const bad of ["Staging", "-a", "a-", "a".repeat(17), "production", "preview", "development", "pv-x", "2a", "", "fn", "a-fn", "fn-a", "a-fn-x", "a-cr-fn-x"]) {
      expect(validateStageName(bad), bad).toEqual(expect.any(String));
    }
  });

  it("refuses names of exactly two characters (qa--<project> is a reserved DNS label); a stage made before the rule keeps working", async () => {
    for (const bad of ["qa", "v2", "ui", "xn"]) expect(validateStageName(bad)).toContain("two characters");
    const s = await openTestStore();
    const p = s.createProject("shop");
    expect(() => s.createStage(p.id, { name: "qa", branch: "qa", host: "" })).toThrow(/two characters/);
    // Grandfathered: a row written before the rule is read, updated and listed as usual.
    const db = new DatabaseSync(dbPathOf(s));
    db.prepare("INSERT INTO stages (id, project_id, name, kind, branch, auto_deploy, host, created_at) VALUES ('stg_old', ?, 'qa', 'custom', 'qa', 1, 'qa--shop.127.0.0.1.sslip.io', '2026-01-01T00:00:00Z')").run(p.id);
    db.close();
    expect(s.updateStage("stg_old", { branch: "qa2" }).name).toBe("qa");
    expect(s.listStages(p.id).map((x) => x.name)).toContain("qa");
  });

  it("creates, updates and refuses a duplicate or invalid custom stage", async () => {
    const s = await openTestStore();
    const p = s.createProject("shop");
    const st = s.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.127.0.0.1.sslip.io" });
    expect(st).toMatchObject({ name: "staging", kind: "custom", branch: "staging", autoDeploy: true, host: "staging--shop.127.0.0.1.sslip.io", lastSeenSha: "" });
    expect(s.getStageByName(p.id, "staging")).toEqual(st);
    expect(() => s.createStage(p.id, { name: "staging", branch: "other", host: "x" })).toThrow(ErrDuplicateName);
    expect(() => s.createStage(p.id, { name: "Bad", branch: "b", host: "x" })).toThrow(/name/);
    expect(() => s.createStage("proj_nope", { name: "qat", branch: "qa", host: "x" })).toThrow(ErrNotFound);
    const updated = s.updateStage(st.id, { branch: "release", autoDeploy: false, lastSeenSha: "b".repeat(40) });
    expect(updated).toMatchObject({ branch: "release", autoDeploy: false, lastSeenSha: "b".repeat(40), host: st.host });
    expect(s.getStage(st.id)).toEqual(updated);
    expect(s.listStages(p.id).map((x) => x.name)).toEqual(["production", "preview", "development", "staging"]);
  });

  it("deleteStage removes a custom stage and its cloud rows; built-ins can't be deleted", async () => {
    const s = await openTestStore();
    const p = s.createProject("shop");
    const st = s.createStage(p.id, { name: "staging", branch: "staging", host: "h" });
    const row = s.createEnvironment(p.id, "s-staging-cr", "cloudrun", undefined, st.id);
    s.completeDeployment(s.createDeployment(row.id).id, "sha256:x", "https://x");
    s.deleteStage(st.id);
    expect(() => s.getStage(st.id)).toThrow(ErrNotFound);
    expect(() => s.getEnvironment(row.id)).toThrow(ErrNotFound);
    expect(() => s.deleteStage(s.productionStage(p.id).id)).toThrow();
    expect(s.listStages(p.id)).toHaveLength(3);
  });

  it("deleting a project deletes its stages", async () => {
    const s = await openTestStore();
    const p = s.createProject("shop");
    const prod = s.productionStage(p.id);
    s.deleteProject(p.id);
    expect(() => s.getStage(prod.id)).toThrow(ErrNotFound);
    expect(s.listStages(p.id)).toEqual([]);
  });

  it("stageRowName names a stage's cloud rows", () => {
    const stage = { name: "staging" } as Stage;
    expect(stageRowName(stage, { target: "cloudrun" })).toBe("s-staging-cr");
    expect(stageRowName(stage, { target: "kubernetes" })).toBe("s-staging-k8s");
    expect(stageRowName(stage, { target: "kubernetes", clusterId: "kc_default" })).toBe("s-staging-k8s");
    const hex = createHash("sha256").update("kc_0123456789abcdef").digest("hex").slice(0, 6);
    expect(stageRowName(stage, { target: "kubernetes", clusterId: "kc_0123456789abcdef" })).toBe(`s-staging-k-${hex}`);
    const long = { name: "a".repeat(16) } as Stage;
    for (const cloud of [{ target: "cloudrun" }, { target: "kubernetes" }, { target: "kubernetes", clusterId: "kc_0123456789abcdef" }]) {
      const name = stageRowName(long, cloud);
      expect(name.length).toBeLessThan(40);
      expect(name).toMatch(/^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/);
    }
  });

  it("createEnvironment without a stage puts the row on Production", async () => {
    const s = await openTestStore();
    const p = s.createProject("shop");
    const env = s.createEnvironment(p.id, "k8s", "kubernetes");
    expect(env.stageId).toBe(s.productionStage(p.id).id);
    expect(s.getEnvironment(env.id).stageId).toBe(s.productionStage(p.id).id);
  });

  it("createEnvironment refuses another project's stage", async () => {
    const s = await openTestStore();
    const p = s.createProject("shop");
    const q = s.createProject("blog");
    const st = s.createStage(q.id, { name: "staging", branch: "staging", host: "h" });
    expect(() => s.createEnvironment(p.id, "s-staging-cr", "cloudrun", undefined, st.id)).toThrow();
  });

  it("listEnvironments shows Production's rows by default, one stage's with stageId, every row with allStages", async () => {
    const s = await openTestStore();
    const p = s.createProject("shop");
    const prod = s.createEnvironment(p.id, "k8s", "kubernetes");
    const st = s.createStage(p.id, { name: "staging", branch: "staging", host: "h" });
    const staging = s.createEnvironment(p.id, "s-staging-cr", "cloudrun", undefined, st.id);
    expect(staging.stageId).toBe(st.id);
    expect(s.listEnvironments(p.id).map((e) => e.id)).toEqual([prod.id]);
    expect(s.listEnvironments(p.id, { stageId: st.id }).map((e) => e.id)).toEqual([staging.id]);
    expect(s.listEnvironments(p.id, { allStages: true }).map((e) => e.id)).toEqual([prod.id, staging.id]);
    s.archiveEnvironment(staging.id);
    expect(s.listEnvironments(p.id, { stageId: st.id })).toEqual([]);
    expect(s.listEnvironments(p.id, { stageId: st.id, includeArchived: true }).map((e) => e.id)).toEqual([staging.id]);
    expect(s.listEnvironments(p.id, { allStages: true, includeArchived: true })).toHaveLength(2);
    expect(s.listEnvironments(p.id, { includeArchived: true }).map((e) => e.id)).toEqual([prod.id]);
  });
});

// Review Focus 1: a staging row with a live deployment never reaches
// Production's split, the Traffic tab, the summary or a transfer.
describe("a staging row stays out of Production's views", () => {
  let h: Harness;
  const defaultStepDelayMs = transferConfig.stepDelayMs;
  afterEach(async () => {
    transferConfig.stepDelayMs = defaultStepDelayMs;
    await h.close();
  });

  async function projectWithStagingRow() {
    h = await startHarness();
    const id = await deployedProject(h);
    const st = h.store.createStage(id, { name: "staging", branch: "staging", host: "staging--storefront.127.0.0.1.sslip.io" });
    const row = h.store.createEnvironment(id, "s-staging-cr", "cloudrun", JSON.stringify({ mode: "manual", project: "p", region: "us-east1" }), st.id);
    const dep = h.store.createDeployment(row.id);
    h.store.completeDeployment(dep.id, "sha256:staging", "https://staging-abc123-uc.a.run.app");
    const prodIds = h.store.listEnvironments(id).map((e) => e.id);
    expect(prodIds).not.toContain(row.id);
    expect(prodIds.length).toBeGreaterThan(0);
    return { id, row, prodIds };
  }

  it("desiredTargetFor, the summary and the traffic state list Production's rows only", async () => {
    const { id, row, prodIds } = await projectWithStagingRow();
    const desired = desiredTargetFor(h.store, id)!;
    expect(desired.backends.map((b) => b.environmentId)).toEqual(prodIds);

    const summary = await h.call("GET", `/projects/${id}/summary`);
    expect(summary.status).toBe(200);
    expect((summary.json.environments as { id: string }[]).map((e) => e.id)).toEqual(prodIds);

    const traffic = await h.call("GET", `/projects/${id}/traffic`);
    expect(traffic.status).toBe(200);
    expect((traffic.json.environments as { id: string }[]).map((e) => e.id)).toEqual(prodIds);
    expect((traffic.json.backends as { environmentId: string }[]).map((b) => b.environmentId)).not.toContain(row.id);
  });

  it("a transfer to Cloud Run ignores the staging Cloud Run row and leaves it untouched", async () => {
    transferConfig.stepDelayMs = 10;
    const { id, row, prodIds } = await projectWithStagingRow();
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "cloudrun", mode: "auto" });
    expect(res.status).toBe(202);
    expect(res.json.fromEnvId).toBe(prodIds[0]);
    await h.v2.transfers.settled(id);
    const t = h.store.getLatestTransfer(id)!;
    expect(t.status).toBe("done");
    expect(t.toEnvId).not.toBe(row.id);
    expect(h.store.getEnvironment(row.id)).toMatchObject({ trafficWeight: 0, archived: false });
    expect(h.store.listEnvironments(id).map((e) => e.id)).not.toContain(row.id);
    expect(desiredTargetFor(h.store, id)!.backends.map((b) => b.environmentId)).not.toContain(row.id);
  });
});
