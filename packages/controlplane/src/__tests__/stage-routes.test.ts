// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { startHarness, deployedProject, bothClouds, staticSetup, type Harness } from "./v2-harness.js";
import type { CommandRunner } from "@nbo/deploy";
import { stageRowName } from "../stages.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function dev(): Promise<Harness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}

const appPrefix = (id: string) => `p${id.split("_")[1]!.slice(0, 8)}`;
const stagingHost = "staging--storefront.127.0.0.1.sslip.io";

async function addStaging(h: Harness, id: string, body: Record<string, unknown> = {}) {
  return h.call("POST", `/projects/${id}/stages`, { name: "staging", branch: "staging", clouds: [{ target: "kubernetes" }], ...body });
}

// deployStaging builds the head for the staging environment and waits for it.
async function deployStaging(h: Harness, id: string, stageId: string): Promise<void> {
  h.v2.queue.enqueue(id, h.head, { stageId });
  await h.v2.queue.idle(id);
}

describe("POST /projects/{id}/stages", () => {
  it("creates the environment, its host and one cloud row per choice, and builds nothing", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const before = h.store.listBuilds(id).length;
    const res = await addStaging(h, id, { clouds: bothClouds, autoDeploy: false });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ name: "staging", kind: "custom", branch: "staging", autoDeploy: false, host: stagingHost, url: `http://${stagingHost}:9443`, liveBuild: null });
    expect(res.json.environments.map((e: { name: string }) => e.name)).toEqual(["s-staging-k8s", "s-staging-cr"]);
    const stage = h.store.getStageByName(id, "staging");
    expect(stage.host).toBe(stagingHost);
    expect(h.store.listEnvironments(id, { stageId: stage.id }).map((e) => e.name)).toEqual(["s-staging-k8s", "s-staging-cr"]);
    // Production's rows are untouched; crons stay off on the stage's rows.
    expect(h.store.listEnvironments(id).map((e) => e.name)).toEqual(["k8s"]);
    for (const e of h.store.listEnvironments(id, { stageId: stage.id })) expect(JSON.parse(e.config).cronsEnabled).toBe(false);
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toHaveLength(before);
    // Dev mode records no default domain row.
    expect(h.store.listDomains(id)).toEqual([]);
  });

  it("refuses a bad name (400), a duplicate (409) and a built-in name (400)", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    expect((await addStaging(h, id, { name: "Staging" })).status).toBe(400);
    expect((await addStaging(h, id, { name: "preview" })).status).toBe(400);
    expect((await addStaging(h, id, { name: "pv-x" })).status).toBe(400);
    expect((await addStaging(h, id)).status).toBe(201);
    const dup = await addStaging(h, id, { branch: "other" });
    expect(dup.status).toBe(409);
    // A failed create leaves nothing behind.
    expect(h.store.listStages(id).filter((s) => s.kind === "custom")).toHaveLength(1);
  });

  it("refuses the production branch or another environment's branch (409)", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const prod = await addStaging(h, id, { branch: "main" });
    expect(prod.status).toBe(409);
    expect(prod.json.error).toContain("production");
    expect((await addStaging(h, id)).status).toBe(201);
    const other = await addStaging(h, id, { name: "qat" });
    expect(other.status).toBe(409);
    expect(other.json.error).toContain("staging");
    expect(h.store.listStages(id).map((s) => s.name)).toEqual(["production", "preview", "development", "staging"]);
  });

  it("refuses bad bodies (400): no clouds, a cloud twice, a missing branch", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    expect((await addStaging(h, id, { clouds: [] })).status).toBe(400);
    expect((await addStaging(h, id, { clouds: [{ target: "kubernetes" }, { target: "kubernetes" }] })).status).toBe(400);
    expect((await addStaging(h, id, { branch: "" })).status).toBe(400);
    expect((await addStaging(h, id, { autoDeploy: "yes" })).status).toBe(400);
    expect(h.store.listStages(id)).toHaveLength(3);
  });

  it("a cloud that fails to provision leaves no environment behind", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    h.cloud.ensureError = new Error("gcloud exploded");
    const res = await addStaging(h, id, { clouds: [{ target: "kubernetes" }, { target: "cloudrun", mode: "auto" }] });
    expect(res.status).toBe(502);
    expect(h.store.listStages(id)).toHaveLength(3);
    expect(h.store.listEnvironments(id, { allStages: true }).map((e) => e.name)).toEqual(["k8s"]);
  });

  it("in production with an edge, records the stage's default domain row", async () => {
    const run: CommandRunner = async () => "";
    const h = await startHarness({ mode: "production", v2: { run } });
    harnesses.push(h);
    const cluster = h.store.saveKubernetesConnection({ name: "edge", server: "https://edge.example:6443", registry: { kind: "custom", server: "ghcr.io", username: "me" } }, { kubeconfig: "k" });
    h.store.updateServerSettings({ edgeClusterId: cluster.id, edgeAddress: "34.1.2.3" });
    const p = h.store.createProject("shop");
    h.store.setGitConfig(p.id, { repo: "https://github.com/acme/shop.git", productionBranch: "main", framework: "static", buildCommand: "true", outputDir: "dist", spa: false } as never);
    const res = await h.call("POST", `/projects/${p.id}/stages`, { name: "staging", branch: "staging", clouds: [{ target: "kubernetes" }] });
    expect(res.status).toBe(201);
    const stage = h.store.getStageByName(p.id, "staging");
    expect(stage.host).toBe("staging--shop.34-1-2-3.sslip.io");
    expect(h.store.listDomains(p.id).map((d) => [d.host, d.kind, d.stageId])).toEqual([["staging--shop.34-1-2-3.sslip.io", "default", stage.id]]);
    expect(h.store.listEnvironments(p.id, { stageId: stage.id }).map((e) => [e.name, JSON.parse(e.config).clusterId])).toEqual([[stageRowName(stage, { target: "kubernetes", clusterId: cluster.id }), cluster.id]]);
  });
});

describe("GET /projects/{id}/stages and summary.stages", () => {
  it("lists every environment; Production's branch comes from the git config", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    await addStaging(h, id);
    const res = await h.call("GET", `/projects/${id}/stages`);
    expect(res.status).toBe(200);
    expect(res.json.map((s: { name: string; kind: string; branch: string }) => [s.name, s.kind, s.branch])).toEqual([
      ["production", "production", "main"],
      ["preview", "preview", ""],
      ["development", "development", ""],
      ["staging", "custom", "staging"],
    ]);
    const production = res.json[0];
    expect(production.host).toBe("storefront.127.0.0.1.sslip.io");
    expect(production.environments.map((e: { name: string }) => e.name)).toEqual(["k8s"]);
    expect(production.liveBuild).not.toBeNull();
    const summary = await h.call("GET", `/projects/${id}/summary`);
    expect(summary.json.stages.map((s: { name: string }) => s.name)).toEqual(["production", "preview", "development", "staging"]);
    // environments keeps meaning Production.
    expect(summary.json.environments.map((e: { name: string }) => e.name)).toEqual(["k8s"]);
  });

  it("a staging deploy shows as the stage's live build and never as Production's build", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const prodBuild = (await h.call("GET", `/projects/${id}/summary`)).json.productionBuild.id;
    await addStaging(h, id);
    const stage = h.store.getStageByName(id, "staging");
    await deployStaging(h, id, stage.id);
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    const staging = summary.stages.find((s: { name: string }) => s.name === "staging");
    expect(staging.liveBuild).not.toBeNull();
    expect(staging.liveBuild.id).not.toBe(prodBuild);
    expect(summary.productionBuild.id).toBe(prodBuild);
  });

  it("productionBuild's fallback skips staging builds", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    await addStaging(h, id);
    const stage = h.store.getStageByName(id, "staging");
    await deployStaging(h, id, stage.id);
    // Production serves nothing (no traffic), so the fallback picks.
    for (const e of h.store.listEnvironments(id)) h.store.setTrafficWeights(id, { [e.id]: 0 });
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(summary.productionBuild.stageId).toBe(h.store.productionStage(id).id);
  });
});

describe("PATCH /projects/{id}/stages/{stageId}", () => {
  it("changes the branch and auto-deploy; keeping its own branch is fine", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    const same = await h.call("PATCH", `/projects/${id}/stages/${stage.id}`, { branch: "staging" });
    expect(same.status).toBe(200);
    const res = await h.call("PATCH", `/projects/${id}/stages/${stage.id}`, { branch: "release", autoDeploy: false });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ branch: "release", autoDeploy: false });
    expect(h.store.getStage(stage.id)).toMatchObject({ branch: "release", autoDeploy: false });
  });

  it("refuses another environment's branch (409), bad fields (400) and a built-in (400)", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    await h.call("POST", `/projects/${id}/stages`, { name: "qat", branch: "qa", clouds: [{ target: "kubernetes" }] });
    expect((await h.call("PATCH", `/projects/${id}/stages/${stage.id}`, { branch: "qa" })).status).toBe(409);
    expect((await h.call("PATCH", `/projects/${id}/stages/${stage.id}`, { branch: "main" })).status).toBe(409);
    expect((await h.call("PATCH", `/projects/${id}/stages/${stage.id}`, { branch: "" })).status).toBe(400);
    expect((await h.call("PATCH", `/projects/${id}/stages/${stage.id}`, { name: "x" })).status).toBe(400);
    const production = h.store.productionStage(id);
    expect((await h.call("PATCH", `/projects/${id}/stages/${production.id}`, { autoDeploy: false })).status).toBe(400);
    expect((await h.call("PATCH", `/projects/${id}/stages/stg_nope`, { autoDeploy: false })).status).toBe(404);
  });
});

describe("DELETE /projects/{id}/stages/{stageId}", () => {
  it("refuses while a job of that environment is queued or running (409)", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    h.deploys.delayMs = 400;
    h.v2.queue.enqueue(id, h.head, { stageId: stage.id });
    const res = await h.call("DELETE", `/projects/${id}/stages/${stage.id}`);
    expect(res.status).toBe(409);
    await h.v2.queue.idle(id);
    expect((await h.call("DELETE", `/projects/${id}/stages/${stage.id}`)).status).toBe(204);
  });

  it("removes its host from the edge, its rows, variables and domains, and keeps its builds", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    await deployStaging(h, id, stage.id);
    expect(h.registry.get(stagingHost)).toBeDefined();
    expect((await h.call("PUT", `/projects/${id}/env/API_URL?stage=staging`, { value: "https://staging.api", secret: false })).status).toBe(200);
    expect((await h.call("PUT", `/projects/${id}/env/API_URL`, { value: "https://api", secret: false })).status).toBe(200);
    h.store.addDomain(id, "staging.example.com", "custom", "edge", stage.id);
    h.store.addDomain(id, "www.example.com", "custom");
    const stageBuilds = h.store.listBuilds(id).filter((b) => b.stageId === stage.id).map((b) => b.id);
    expect(stageBuilds.length).toBeGreaterThan(0);

    const res = await h.call("DELETE", `/projects/${id}/stages/${stage.id}`);
    expect(res.status).toBe(204);
    expect(h.registry.get(stagingHost)).toBeUndefined();
    expect(h.registry.get("storefront.127.0.0.1.sslip.io")).toBeDefined();
    expect(h.store.listStages(id).map((s) => s.name)).toEqual(["production", "preview", "development"]);
    expect(h.store.listEnvironments(id, { allStages: true, includeArchived: true }).map((e) => e.name)).toEqual(["k8s"]);
    expect(h.store.listProjectEnv(id).map((v) => [v.name, v.stage])).toEqual([["API_URL", "production"]]);
    expect(h.store.listDomains(id).map((d) => d.host)).toEqual(["www.example.com"]);
    expect(h.store.listBuilds(id).filter((b) => stageBuilds.includes(b.id))).toHaveLength(stageBuilds.length);
    expect(h.teardown.removed).toEqual([]);
  });

  it("clears promote targets that pointed at its clouds", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    const env = h.store.listEnvironments(id, { stageId: stage.id })[0]!;
    const build = h.store.listBuilds(id)[0]!;
    h.v2.queue.enqueuePromote(id, build.id, env.id);
    await h.v2.queue.idle(id);
    expect((await h.call("DELETE", `/projects/${id}/stages/${stage.id}`)).status).toBe(204);
    expect(h.store.listBuilds(id).filter((b) => b.kind === "promote").map((b) => b.targetEnvironmentId)).toEqual([""]);
  });

  it("with resources=true tears down each of its clouds as one app", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id, { clouds: bothClouds })).json;
    const res = await h.call("DELETE", `/projects/${id}/stages/${stage.id}?resources=true`);
    expect(res.status).toBe(204);
    expect(h.teardown.removed.map((r) => [r.target, r.appName, r.scope])).toEqual([
      ["kubernetes", `${appPrefix(id)}-s-staging-k8s`, "app"],
      ["cloudrun", `${appPrefix(id)}-s-staging-cr`, "app"],
    ]);
  });

  it("tells teardown every other app of the project, so a near-name is never touched", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const a = (await h.call("POST", `/projects/${id}/stages`, { name: "a", branch: "a", clouds: [bothClouds[1]] })).json;
    // A near-collision name that is still allowed.
    expect((await h.call("POST", `/projects/${id}/stages`, { name: "a-cr-x", branch: "a-cr-x", clouds: [bothClouds[1]] })).status).toBe(201);
    expect((await h.call("POST", `/projects/${id}/stages`, { name: "a-cr-fn-x", branch: "x", clouds: [bothClouds[1]] })).status).toBe(400);
    expect((await h.call("DELETE", `/projects/${id}/stages/${a.id}?resources=true`)).status).toBe(204);
    expect(h.teardown.removed).toHaveLength(1);
    expect(h.teardown.removed[0]!.appName).toBe(`${appPrefix(id)}-s-a-cr`);
    expect([...h.teardown.removed[0]!.keep!].sort()).toEqual([`${appPrefix(id)}-k8s`, `${appPrefix(id)}-s-a-cr-x-cr`].sort());
  });

  it("turns auto-deploy off for the teardown, and back on if it fails", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    let seen: boolean | null = null;
    const remove = h.teardown.remove;
    h.teardown.remove = async (t) => {
      seen = h.store.getStage(stage.id).autoDeploy;
      return remove(t);
    };
    h.teardown.failWith = new Error("boom");
    expect((await h.call("DELETE", `/projects/${id}/stages/${stage.id}?resources=true`)).status).toBe(502);
    expect(seen).toBe(false);
    expect(h.store.getStage(stage.id).autoDeploy).toBe(true);
  });

  it("refuses (409) when a build of the environment started during the teardown", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    h.deploys.delayMs = 400;
    h.teardown.remove = async () => {
      h.v2.queue.enqueue(id, h.head, { stageId: stage.id });
    };
    const res = await h.call("DELETE", `/projects/${id}/stages/${stage.id}?resources=true`);
    expect(res.status).toBe(409);
    expect(h.store.getStage(stage.id).name).toBe("staging");
    await h.v2.queue.idle(id);
  });

  it("deletes its records before removing its host from the edge", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    let stillThere: boolean | null = null;
    const remove = h.v2.edgeSync.remove;
    h.v2.edgeSync.remove = async (host) => {
      stillThere = h.store.listStages(id).some((s) => s.id === stage.id);
      return remove(host);
    };
    expect((await h.call("DELETE", `/projects/${id}/stages/${stage.id}`)).status).toBe(204);
    expect(stillThere).toBe(false);
  });

  it("a teardown failure keeps the environment and reports the cloud's error", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    h.teardown.failWith = new Error("Kubernetes: deleting x failed: Unable to connect to the server");
    const res = await h.call("DELETE", `/projects/${id}/stages/${stage.id}?resources=true`);
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("Unable to connect");
    expect(h.store.getStage(stage.id).name).toBe("staging");
  });

  it("refuses a built-in environment (400)", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    expect((await h.call("DELETE", `/projects/${id}/stages/${h.store.productionStage(id).id}`)).status).toBe(400);
  });
});

describe("traffic, clouds and transfers per environment", () => {
  it("PUT /traffic with stage staging accepts only staging rows; GET shows that stage", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    await deployStaging(h, id, stage.id);
    const prodEnv = h.store.listEnvironments(id)[0]!;
    const stagingEnv = h.store.listEnvironments(id, { stageId: stage.id })[0]!;
    const wrong = await h.call("PUT", `/projects/${id}/traffic`, { stage: "staging", weights: { [prodEnv.id]: 100 } });
    expect(wrong.status).toBe(400);
    const crossed = await h.call("PUT", `/projects/${id}/traffic`, { weights: { [stagingEnv.id]: 100 } });
    expect(crossed.status).toBe(400);
    const ok = await h.call("PUT", `/projects/${id}/traffic`, { stage: "staging", weights: { [stagingEnv.id]: 100 } });
    expect(ok.status).toBe(200);
    expect(ok.json.host).toBe(stagingHost);
    expect(ok.json.environments.map((e: { id: string }) => e.id)).toEqual([stagingEnv.id]);
    const got = await h.call("GET", `/projects/${id}/traffic?stage=staging`);
    expect(got.json.backends.map((b: { environmentId: string }) => b.environmentId)).toEqual([stagingEnv.id]);
    const prod = await h.call("GET", `/projects/${id}/traffic`);
    expect(prod.json.host).toBe("storefront.127.0.0.1.sslip.io");
    expect((await h.call("GET", `/projects/${id}/traffic?stage=preview`)).status).toBe(400);
  });

  it("edgeInSync is exact per environment: a changed staging route doesn't flag Production", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    await deployStaging(h, id, stage.id);
    expect((await h.call("GET", `/projects/${id}/traffic`)).json.edgeInSync).toBe(true);
    expect((await h.call("GET", `/projects/${id}/traffic?stage=staging`)).json.edgeInSync).toBe(true);
    h.registry.set(stagingHost, [{ url: "https://elsewhere.example", weight: 100, insecureSkipVerify: false }]);
    expect((await h.call("GET", `/projects/${id}/traffic`)).json.edgeInSync).toBe(true);
    expect((await h.call("GET", `/projects/${id}/traffic?stage=staging`)).json.edgeInSync).toBe(false);
  });

  it("PUT /traffic with stage staging is 502 when the edge rejects the staging host", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id)).json;
    await deployStaging(h, id, stage.id);
    const stagingEnv = h.store.listEnvironments(id, { stageId: stage.id })[0]!;
    const push = h.v2.edgeSync.push;
    const calls: unknown[] = [];
    h.v2.edgeSync.push = async (projectId, opts) => {
      calls.push(opts);
      if (opts?.stageHost === stagingHost) throw new Error("edge rejected the split for the staging host");
      return push(projectId, opts);
    };
    const res = await h.call("PUT", `/projects/${id}/traffic`, { stage: "staging", weights: { [stagingEnv.id]: 100 } });
    expect(res.status).toBe(502);
    expect(calls).toEqual([{ stageHost: stagingHost }]);
  });

  it("POST /environments/add with stage adds a cloud to that environment", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    await addStaging(h, id);
    const res = await h.call("POST", `/projects/${id}/environments/add`, { ...bothClouds[1], stage: "staging" });
    expect(res.status).toBe(201);
    expect(res.json.name).toBe("s-staging-cr");
    const again = await h.call("POST", `/projects/${id}/environments/add`, { ...bothClouds[1], stage: "staging" });
    expect(again.status).toBe(409);
    expect(h.store.listEnvironments(id).map((e) => e.name)).toEqual(["k8s"]);
    expect((await h.call("POST", `/projects/${id}/environments/add`, { ...bothClouds[1], stage: "preview" })).status).toBe(400);
  });

  it("POST /transfer stays Production only (409 for another environment)", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    await addStaging(h, id);
    const res = await h.call("POST", `/projects/${id}/transfer`, { ...bothClouds[1], stage: "staging" });
    expect(res.status).toBe(409);
    expect(h.store.getActiveTransfer(id)).toBeUndefined();
  });

  it("archiving a staging cloud counts its own environment's clouds", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const stage = (await addStaging(h, id, { clouds: bothClouds })).json;
    const [k8s, cr] = h.store.listEnvironments(id, { stageId: stage.id });
    expect((await h.call("POST", `/environments/${cr!.id}/archive`)).status).toBe(204);
    const last = await h.call("POST", `/environments/${k8s!.id}/archive`);
    expect(last.status).toBe(400);
  });
});

describe("host collisions and relays", () => {
  it("refuses an environment name containing -- (400)", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const res = await addStaging(h, id, { name: "a--b" });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("--");
    expect(h.store.listStages(id).map((s) => s.name)).toEqual(["production", "preview", "development"]);
  });

  it("refuses a new project name containing --, and an existing one keeps working", async () => {
    const h = await dev();
    const id = await deployedProject(h);
    const bad = await h.call("POST", "/projects/setup", { ...staticSetup({ name: "staging--shop" }) });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("--");
    // A grandfathered project (made before the rule) still takes an environment; the other direction collides.
    const old = h.store.createProject("old--shop");
    const res = await h.call("POST", `/projects/${old.id}/stages`, { name: "qat", branch: "qa", clouds: [{ target: "kubernetes" }] });
    expect(res.status).toBe(201);
    expect(res.json.host).toBe("qat--old--shop.127.0.0.1.sslip.io");
    expect(id).toBeTruthy();
  });

  it("refuses a cloud on a cluster with no public entry (409) and leaves nothing behind", async () => {
    const h = await startHarness({ mode: "production", v2: { run: async () => "" } });
    harnesses.push(h);
    const edge = h.store.saveKubernetesConnection({ name: "edge", server: "https://edge.example:6443", registry: { kind: "custom", server: "ghcr.io", username: "me" } }, { kubeconfig: "k" });
    const other = h.store.saveKubernetesConnection({ name: "other", server: "https://other.example:6443", registry: { kind: "custom", server: "ghcr.io", username: "me" } }, { kubeconfig: "k" });
    h.store.updateServerSettings({ edgeClusterId: edge.id, edgeAddress: "34.1.2.3" });
    const p = h.store.createProject("shop");
    h.store.setGitConfig(p.id, { repo: "https://github.com/acme/shop.git", productionBranch: "main", framework: "static", buildCommand: "true", outputDir: "dist", spa: false } as never);
    const res = await h.call("POST", `/projects/${p.id}/stages`, { name: "staging", branch: "staging", clouds: [{ target: "kubernetes", clusterId: other.id }] });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("no public entry");
    expect(h.store.listStages(p.id).map((s) => s.name)).toEqual(["production", "preview", "development"]);
    const ok = await h.call("POST", `/projects/${p.id}/stages`, { name: "staging", branch: "staging", clouds: [{ target: "kubernetes", clusterId: edge.id }] });
    expect(ok.status).toBe(201);
    const add = await h.call("POST", `/projects/${p.id}/environments/add`, { target: "kubernetes", clusterId: other.id, stage: "staging" });
    expect(add.status).toBe(409);
    expect(add.json.error).toContain("no public entry");
    expect(h.store.listEnvironments(p.id, { stageId: h.store.getStageByName(p.id, "staging").id }).map((e) => JSON.parse(e.config).clusterId)).toEqual([edge.id]);
  });
});
