// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serveFetch } from "@nbo/nodehost";
import { createAdminMux, createRegistry, type Registry } from "@nbo/edge";
import { createStore, type Store } from "../store.js";
import { createMux } from "../handlers.js";
import { wireV2, type V2 } from "../v2.js";
import { fakeCloudSetup, fakeDeploymentTrigger, makeLocalRepo, rewriteGitUrl, readyPreflight, type FakeCloudSetup, type FakeDeploymentTrigger } from "../testing.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const repoUrl = "https://github.com/acme/storefront.git";
const head40 = /^[0-9a-f]{40}$/;

interface Harness {
  store: Store;
  registry: Registry;
  v2: V2;
  deploys: FakeDeploymentTrigger;
  cloud: FakeCloudSetup;
  head: string;
  commit(message: string): Promise<string>;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-v2routes-"));
  const store = createStore(join(dir, "test.db"));
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const registry = createRegistry();
  const server = await new Promise<Server>((resolve) => {
    const s = serveFetch(createAdminMux(registry), { host: "127.0.0.1", port: 0 }, () => resolve(s));
  });
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const repo = await makeLocalRepo();
  cleanups.push(() => rm(repo.repoPath, { recursive: true, force: true }));
  cleanups.push(rewriteGitUrl(repoUrl, repo.repoPath));

  const deploys = fakeDeploymentTrigger(store);
  const cloud = fakeCloudSetup();
  const v2 = wireV2(store, {
    deploymentTrigger: deploys,
    cloudSetup: cloud,
    edgeAdminUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    edgePublicPort: 9443,
  });
  const mux = createMux(store, deploys, v2.queue, v2);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await mux(
      new Request(`http://cp${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }),
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, json, text };
  };
  return { store, registry, v2, deploys, cloud, head: repo.head, commit: repo.commit, call };
}

const staticSetup = (overrides: Record<string, unknown> = {}) => ({
  name: "storefront",
  repo: repoUrl,
  productionBranch: "main",
  framework: "static",
  spa: false,
  buildCommand: "mkdir dist && echo hi > dist/index.html",
  outputDir: "dist",
  clouds: [{ target: "kubernetes" }],
  ...overrides,
});

const bothClouds = [{ target: "kubernetes" }, { target: "cloudrun", mode: "manual", project: "my-proj-1", region: "us-east1", arRepo: "us-east1-docker.pkg.dev/my-proj-1/nbo" }];

async function deployedProject(h: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await h.call("POST", "/projects/setup", staticSetup(overrides));
  expect(res.status).toBe(201);
  const id = res.json.project.id as string;
  await h.v2.setup.settled(id);
  await h.v2.queue.idle(id);
  return id;
}

describe("v2 routes", () => {
  it("GET /system/preflight returns the machine's preflight", async () => {
    const h = await harness();
    const res = await h.call("GET", "/system/preflight");
    expect(res.status).toBe(200);
    expect(res.json).toEqual(readyPreflight);
  });

  it("POST /projects/setup answers 201 with a provisioning summary", async () => {
    const h = await harness();
    const res = await h.call("POST", "/projects/setup", staticSetup());
    expect(res.status).toBe(201);
    expect(res.json.project).toMatchObject({ name: "storefront", setupStatus: "provisioning", edgeHost: "storefront.127.0.0.1.sslip.io" });
    expect(res.json.domainUrl).toBe("http://storefront.127.0.0.1.sslip.io:9443");
    expect(res.json.git).toMatchObject({ repo: repoUrl, framework: "static" });
    await h.v2.setup.settled(res.json.project.id);
    await h.v2.queue.idle(res.json.project.id);
  });

  it("POST /projects/setup rejects a non-https repo and a duplicate name", async () => {
    const h = await harness();
    const bad = await h.call("POST", "/projects/setup", staticSetup({ repo: "http://github.com/acme/x.git" }));
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("https://");
    await deployedProject(h);
    const dup = await h.call("POST", "/projects/setup", staticSetup());
    expect(dup.status).toBe(409);
    const notJson = await h.call("POST", "/projects/setup", undefined);
    expect(notJson.status).toBe(400);
  });

  it("a setup deploys the head and the summary shows the build, environments and domain", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("GET", `/projects/${id}/summary`);
    expect(res.status).toBe(200);
    const s = res.json;
    expect(s.project).toMatchObject({ setupStatus: "ready", lastSeenSha: h.head });
    expect(s.latestBuild).toMatchObject({ status: "succeeded", revision: h.head });
    expect(s.latestBuild.log).toBeUndefined();
    for (const k of ["input", "timeline", "outputSummary", "commit"]) {
      expect(s.latestBuild).not.toHaveProperty(k);
      expect(s.productionBuild).not.toHaveProperty(k);
    }
    expect(s.productionBuild.id).toBe(s.latestBuild.id);
    expect(s.environments).toHaveLength(1);
    expect(s.environments[0]).toMatchObject({ name: "k8s", target: "kubernetes", trafficWeight: 100, config: { cronsEnabled: true }, clusterId: null, displayName: "Kubernetes" });
    expect(s.environments[0].latestDeployment).toMatchObject({ status: "succeeded" });
    expect(s.activeTransfer).toBeNull();
    expect(h.registry.get("storefront.127.0.0.1.sslip.io")?.backends).toEqual([{ id: s.environments[0].id, url: s.environments[0].latestDeployment.url, weight: 100, insecureSkipVerify: true }]);
  });

  it("GET /projects/summary lists every project with its latest build", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("GET", "/projects/summary");
    expect(res.status).toBe(200);
    expect(res.json.map((s: any) => [s.project.id, s.latestBuild.status])).toEqual([[id, "succeeded"]]);
  });

  it("GET /projects/{id}/summary 404s for an unknown project", async () => {
    const h = await harness();
    expect((await h.call("GET", "/projects/proj_nope/summary")).status).toBe(404);
  });

  it("POST /projects/{id}/setup/retry answers 202 and finishes setup", async () => {
    const h = await harness();
    h.cloud.ensureError = new Error("billing disabled");
    const res = await h.call("POST", "/projects/setup", staticSetup({ clouds: [{ target: "cloudrun", mode: "auto" }] }));
    const id = res.json.project.id;
    await h.v2.setup.settled(id);
    expect((await h.call("GET", `/projects/${id}/summary`)).json.project).toMatchObject({ setupStatus: "needs-setup", setupError: "billing disabled" });
    h.cloud.ensureError = null;
    const retry = await h.call("POST", `/projects/${id}/setup/retry`, {});
    expect(retry.status).toBe(202);
    await h.v2.setup.settled(id);
    await h.v2.queue.idle(id);
    expect((await h.call("GET", `/projects/${id}/summary`)).json.latestBuild.status).toBe("succeeded");
  });

  it("POST /projects/{id}/builds with no revision builds the branch head", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const next = await h.commit("second");
    const res = await h.call("POST", `/projects/${id}/builds`, {});
    expect(res.status).toBe(202);
    expect(res.json.revision).toBe(next);
    await h.v2.queue.idle(id);
    const s = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(s.latestBuild).toMatchObject({ revision: next, status: "succeeded" });
    expect(s.project.lastSeenSha).toBe(next);
  });

  it("POST /projects/{id}/builds rebuilds an exact revision and rejects a malformed one", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("POST", `/projects/${id}/builds`, { revision: h.head });
    expect(res.status).toBe(202);
    expect(res.json.revision).toMatch(head40);
    await h.v2.queue.idle(id);
    expect((await h.call("POST", `/projects/${id}/builds`, { revision: "--upload-pack=x" })).status).toBe(400);
  });

  it("POST /projects/{id}/builds refuses a removed ephemeral stage with 409", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const pv = h.store.createEphemeralStage(id, { branch: "feature/x", host: "feature-x--shop.127.0.0.1.sslip.io", expiresAt: "", label: "" });
    const name = h.store.getStage(pv.id).name;
    h.store.updateStage(pv.id, { removal: "removed" });
    expect((await h.call("POST", `/projects/${id}/builds`, { stage: name })).status).toBe(409);
    h.store.updateStage(pv.id, { removal: "removing" });
    expect((await h.call("POST", `/projects/${id}/builds`, { stage: name })).status).toBe(409);
  });

  it("POST /projects refuses a name with two hyphens in a row", async () => {
    const h = await harness();
    expect((await h.call("POST", "/projects", { name: "x--shop" })).status).toBe(400);
  });

  it("GET /projects/{id}/builds omits logs while GET /builds/{id} includes them", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const list = await h.call("GET", `/projects/${id}/builds`);
    expect(list.json[0].log).toBeUndefined();
    const one = await h.call("GET", `/builds/${list.json[0].id}`);
    expect(one.json.log).toContain("$ git clone");
  });

  it("PATCH /projects/{id}/settings toggles polling and validates its body", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("PATCH", `/projects/${id}/settings`, { pollingEnabled: false });
    expect(res.status).toBe(200);
    expect(res.json.project.pollingEnabled).toBe(false);
    expect((await h.call("PATCH", `/projects/${id}/settings`, { pollingEnabled: "no" })).status).toBe(400);
  });

  it("PUT /projects/{id}/git rejects a non-https repo", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("PUT", `/projects/${id}/git`, { repo: "file:///etc", productionBranch: "main", framework: "static", buildCommand: "x" });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("https://");
  });

  it("traffic GET reports edgeInSync false when the edge has no target", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const live = await h.call("GET", `/projects/${id}/traffic`);
    expect(live.json).toMatchObject({ host: "storefront.127.0.0.1.sslip.io", domainUrl: "http://storefront.127.0.0.1.sslip.io:9443", edgeInSync: true });
    expect(live.json.backends).toHaveLength(1);
    // Someone (or an edge restart + a different writer) changed the edge.
    h.registry.set("storefront.127.0.0.1.sslip.io", [{ url: "https://elsewhere.example", weight: 100, insecureSkipVerify: false }]);
    expect((await h.call("GET", `/projects/${id}/traffic`)).json.edgeInSync).toBe(false);
  });

  it("PUT traffic saves a split on a two-cloud project and pushes it to the edge", async () => {
    const h = await harness();
    const id = await deployedProject(h, { clouds: bothClouds });
    const envs = (await h.call("GET", `/projects/${id}/summary`)).json.environments;
    const [k8s, cr] = envs;
    const res = await h.call("PUT", `/projects/${id}/traffic`, { weights: { [k8s.id]: 90, [cr.id]: 10 } });
    expect(res.status).toBe(200);
    expect(res.json.edgeInSync).toBe(true);
    expect(h.registry.get("storefront.127.0.0.1.sslip.io")?.backends.map((b) => b.weight)).toEqual([90, 10]);
  });

  it("PUT traffic rejects an all-zero split, unknown environments and non-integers", async () => {
    const h = await harness();
    const id = await deployedProject(h, { clouds: bothClouds });
    const [k8s, cr] = (await h.call("GET", `/projects/${id}/summary`)).json.environments;
    expect((await h.call("PUT", `/projects/${id}/traffic`, { weights: { [k8s.id]: 0, [cr.id]: 0 } })).status).toBe(400);
    expect((await h.call("PUT", `/projects/${id}/traffic`, { weights: { env_nope: 100 } })).status).toBe(400);
    expect((await h.call("PUT", `/projects/${id}/traffic`, { weights: { [k8s.id]: 50.5, [cr.id]: 49.5 } })).status).toBe(400);
    expect((await h.call("PUT", `/projects/${id}/traffic`, { weights: { [k8s.id]: -1, [cr.id]: 101 } })).status).toBe(400);
  });

  it("PUT traffic refuses weight on an environment that has never deployed", async () => {
    const h = await harness();
    h.deploys.failTargets.add("cloudrun");
    const id = await deployedProject(h, { clouds: bothClouds });
    const [k8s, cr] = (await h.call("GET", `/projects/${id}/summary`)).json.environments;
    const res = await h.call("PUT", `/projects/${id}/traffic`, { weights: { [k8s.id]: 50, [cr.id]: 50 } });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("cloudrun");
  });

  it("summary canTakeTraffic follows the traffic rule: ever succeeded with a URL, whatever the latest deployment is", async () => {
    const h = await harness();
    h.deploys.failTargets.add("cloudrun");
    const id = await deployedProject(h, { clouds: bothClouds });
    const [first, cr] = (await h.call("GET", `/projects/${id}/summary`)).json.environments;
    let k8s = first;
    expect(k8s.canTakeTraffic).toBe(true);
    expect(cr.canTakeTraffic).toBe(false);
    // A redeploy that is still pending keeps the environment eligible.
    const pending = h.store.createDeployment(k8s.id);
    [k8s] = (await h.call("GET", `/projects/${id}/summary`)).json.environments;
    expect(k8s.latestDeployment).toMatchObject({ status: "pending" });
    expect(k8s.canTakeTraffic).toBe(true);
    // So does a redeploy that failed.
    h.store.failDeployment(pending.id, "boom");
    [k8s] = (await h.call("GET", `/projects/${id}/summary`)).json.environments;
    expect(k8s.latestDeployment).toMatchObject({ status: "failed" });
    expect(k8s.canTakeTraffic).toBe(true);
    // The route agrees.
    expect((await h.call("PUT", `/projects/${id}/traffic`, { weights: { [k8s.id]: 100, [cr.id]: 0 } })).status).toBe(200);
  });

  it("POST /projects/{id}/environments/add adds the other cloud and 409s a duplicate", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("POST", `/projects/${id}/environments/add`, { target: "cloudrun", mode: "auto" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ name: "cloudrun", target: "cloudrun", config: { project: "my-proj", region: "europe-north1" } });
    expect((await h.call("POST", `/projects/${id}/environments/add`, { target: "kubernetes" })).status).toBe(409);
    expect((await h.call("POST", `/projects/${id}/environments/add`, { target: "azure" })).status).toBe(400);
  });

  it("adding Cloud Run back after archiving it revives the archived environment, without its old deployments", async () => {
    const h = await harness();
    const id = await deployedProject(h, { clouds: bothClouds });
    const [k8s, cr] = (await h.call("GET", `/projects/${id}/summary`)).json.environments;
    expect(cr.canTakeTraffic).toBe(true);
    h.store.setTrafficWeights(id, { [k8s.id]: 100, [cr.id]: 0 });
    expect((await h.call("POST", `/environments/${cr.id}/archive`)).status).toBe(204);
    const res = await h.call("POST", `/projects/${id}/environments/add`, { target: "cloudrun", mode: "auto" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ id: cr.id, name: "cloudrun", archived: false, trafficWeight: 0 });
    const back = (await h.call("GET", `/projects/${id}/summary`)).json.environments.find((e: any) => e.id === cr.id);
    // What it ran before it was archived is not live any more.
    expect(back).toMatchObject({ latestDeployment: null, liveBuild: null, canTakeTraffic: false });
    expect((await h.call("PUT", `/projects/${id}/traffic`, { weights: { [k8s.id]: 50, [cr.id]: 50 } })).status).toBe(400);
  });

  it("archive refuses an environment that still has traffic or is the only one, and archives a drained one", async () => {
    const h = await harness();
    const id = await deployedProject(h, { clouds: bothClouds });
    const [k8s, cr] = (await h.call("GET", `/projects/${id}/summary`)).json.environments;
    const busy = await h.call("POST", `/environments/${k8s.id}/archive`);
    expect(busy.status).toBe(400);
    expect(busy.json.error).toBe("move all traffic off this environment first");
    expect((await h.call("POST", `/environments/${cr.id}/archive`)).status).toBe(204);
    const s = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(s.environments.map((e: any) => e.name)).toEqual(["k8s"]);
    h.store.setTrafficWeights(id, { [k8s.id]: 0 });
    const only = await h.call("POST", `/environments/${k8s.id}/archive`);
    expect(only.status).toBe(400);
    expect(only.json.error).toContain("only environment");
  });
});
