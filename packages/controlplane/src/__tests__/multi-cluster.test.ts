// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../store/store.js";
import { createSetup, parseCloudChoice } from "../deploys/setup.js";
import { createCloudSetup, type CloudSetup } from "../clouds/cloud-setup.js";
import { transferConfig } from "../deploys/transfer.js";
import { environmentView } from "../http/v2-routes.js";
import { startHarness, deployedProject, type Harness } from "./v2-harness.js";

const stores: Store[] = [];
const harnesses: Harness[] = [];
const defaultStepDelayMs = transferConfig.stepDelayMs;
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const h of harnesses.splice(0)) await h.close();
  transferConfig.stepDelayMs = defaultStepDelayMs;
});

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-multi-cluster-"));
  const s = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  stores.push(s);
  return s;
}

const noHostCloud: CloudSetup = {
  async preflight() {
    throw new Error("host CLIs must not be consulted in production");
  },
  async ensureCloudRun() {
    throw new Error("host CLIs must not be consulted in production");
  },
};

function productionSetup(store: Store) {
  const queue = { enqueue: (id: string, rev: string) => store.createQueuedBuild(id, rev) };
  return createSetup({ store, cloudSetup: noHostCloud, queue, lsRemote: async () => "abc", mode: "production" });
}

function cluster(store: Store, name: string): string {
  return store.saveKubernetesConnection(
    { name, server: `https://${name}.example:6443`, registry: { kind: "custom", server: "ghcr.io", username: "me" } },
    { kubeconfig: name },
  ).id;
}

describe("cloud choice", () => {
  it("accepts an optional clusterId on Kubernetes and rejects a malformed one", () => {
    expect(parseCloudChoice({ target: "kubernetes" })).toEqual({ target: "kubernetes" });
    expect(parseCloudChoice({ target: "kubernetes", clusterId: "kc_0123abcd" })).toEqual({
      target: "kubernetes",
      clusterId: "kc_0123abcd",
    });
    expect(parseCloudChoice({ target: "kubernetes", clusterId: "kc_default" })).toEqual({
      target: "kubernetes",
      clusterId: "kc_default",
    });
    expect(() => parseCloudChoice({ target: "kubernetes", clusterId: "--kubeconfig=/etc" })).toThrow(/clusterId/);
  });
});

describe("Kubernetes environments in production", () => {
  it("defaults to the only cluster and records its id", async () => {
    const s = await openStore();
    const id = cluster(s, "hetzner-eu");
    const p = s.createProject("shop");
    const env = await productionSetup(s).addCloud(p.id, { target: "kubernetes" });
    expect(env.name).toBe("k8s-hetzner-eu");
    expect(JSON.parse(env.config)).toEqual({ cronsEnabled: true, clusterId: id });
  });

  it("requires a choice when several clusters are connected, and refuses an unknown one", async () => {
    const s = await openStore();
    cluster(s, "hetzner-eu");
    cluster(s, "gke-us");
    const setup = productionSetup(s);
    const p = s.createProject("shop");
    await expect(setup.addCloud(p.id, { target: "kubernetes" })).rejects.toThrow(
      "choose a Kubernetes cluster: hetzner-eu, gke-us",
    );
    await expect(setup.addCloud(p.id, { target: "kubernetes", clusterId: "kc_unknown" })).rejects.toThrow(
      /not connected/,
    );
    expect(s.listEnvironments(p.id)).toEqual([]);
  });

  it("keeps the name k8s on the upgraded default cluster, k8s-<name> elsewhere; one environment per cluster", async () => {
    const s = await openStore();
    const gke = cluster(s, "gke-us");
    // An upgraded install's cluster (what the migration creates).
    const defaultId = s.saveKubernetesConnection(
      { id: undefined, name: "default", server: "https://d", registry: { kind: "artifact-registry" } },
      { kubeconfig: "d" },
    ).id;
    expect(defaultId).not.toBe("kc_default"); // a fresh "default" is not the upgraded one
    const setup = productionSetup(s);
    const p = s.createProject("shop");
    const a = await setup.addCloud(p.id, { target: "kubernetes", clusterId: gke });
    const b = await setup.addCloud(p.id, { target: "kubernetes", clusterId: defaultId });
    expect([a.name, b.name]).toEqual(["k8s-gke-us", "k8s-default"]);
    expect(JSON.parse(b.config)).toEqual({ cronsEnabled: false, clusterId: defaultId });
    await expect(setup.addCloud(p.id, { target: "kubernetes", clusterId: gke })).rejects.toThrow(
      /already runs on gke-us/,
    );
  });

  it("names the environment k8s on kc_default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-multi-cluster-"));
    const { DatabaseSync } = await import("node:sqlite");
    const { legacyConnectionsSchema } = await import("../clouds/connections.js");
    const { seal } = await import("../store/secrets.js");
    const key = randomBytes(32);
    const path = join(dir, "t.db");
    const db = new DatabaseSync(path);
    db.exec(legacyConnectionsSchema);
    db.prepare(
      "INSERT INTO connections (kind, config, secret, status, created_at) VALUES ('kubernetes', ?, ?, 'connected', '2026-10-01T00:00:00Z')",
    ).run(
      JSON.stringify({ name: "prod", server: "https://k", registry: { kind: "artifact-registry" } }),
      seal(key, JSON.stringify({ kubeconfig: "k" })),
    );
    db.close();
    const s = createStore(path, { secretKey: key });
    stores.push(s);
    cluster(s, "gke-us");
    const p = s.createProject("shop");
    const env = await productionSetup(s).addCloud(p.id, { target: "kubernetes", clusterId: "kc_default" });
    expect(env.name).toBe("k8s");
  });

  it("setup with two clusters and Cloud Run creates one environment each", async () => {
    const s = await openStore();
    const a = cluster(s, "hetzner-eu");
    const b = cluster(s, "gke-us");
    s.saveGoogleConnection(
      {
        project: "acme",
        region: "us-east1",
        arRepo: "us-east1-docker.pkg.dev/acme/nbo",
        deployer: "d@x",
        puller: "p@x",
      },
      { deployerKey: "{}", pullerKey: "{}" },
    );
    const setup = productionSetup(s);
    const p = setup.start({
      name: "shop",
      repo: "https://github.com/acme/shop.git",
      productionBranch: "main",
      framework: "static",
      spa: false,
      buildCommand: "true",
      clouds: [
        { target: "kubernetes", clusterId: a },
        { target: "kubernetes", clusterId: b },
        { target: "cloudrun", mode: "auto" },
      ],
    });
    await setup.settled(p.id);
    expect(s.getProject(p.id).setupError).toBe("");
    expect(s.listEnvironments(p.id).map((e) => e.name)).toEqual(["k8s-hetzner-eu", "k8s-gke-us", "cloudrun"]);
  });

  it("a cloud may appear only once per cluster in a setup request", async () => {
    const s = await openStore();
    const a = cluster(s, "a");
    const setup = productionSetup(s);
    const base = {
      name: "shop",
      repo: "https://github.com/acme/shop.git",
      productionBranch: "main",
      framework: "static" as const,
      spa: false,
      buildCommand: "true",
    };
    expect(() =>
      setup.start({
        ...base,
        clouds: [
          { target: "kubernetes", clusterId: a },
          { target: "kubernetes", clusterId: a },
        ],
      }),
    ).toThrow(/once/);
  });
});

describe("display names", () => {
  it("uses the cluster name in production, Kubernetes in dev, Cloud Run for Cloud Run", async () => {
    const s = await openStore();
    const id = cluster(s, "hetzner-eu");
    const p = s.createProject("shop");
    const k = s.createEnvironment(p.id, "k8s-hetzner-eu", "kubernetes", JSON.stringify({ clusterId: id }));
    const c = s.createEnvironment(p.id, "cloudrun", "cloudrun", JSON.stringify({ project: "p" }));
    const dev = s.createEnvironment(p.id, "k8s", "kubernetes", "{}");
    expect(environmentView(s, "production", k)).toMatchObject({
      clusterId: id,
      displayName: "hetzner-eu",
      config: { clusterId: id },
    });
    expect(environmentView(s, "production", c)).toMatchObject({ clusterId: null, displayName: "Cloud Run" });
    expect(environmentView(s, "dev", dev)).toMatchObject({ clusterId: null, displayName: "Kubernetes" });
  });
});

describe("production preflight with several clusters", () => {
  const dockerOnly = async () => "27.1.0";
  it("summarises ready, partly failing and missing clusters", async () => {
    const s = await openStore();
    const pf = () => createCloudSetup(dockerOnly, { mode: "production", store: s }).preflight();
    expect((await pf()).kubernetes).toEqual({
      reachable: false,
      context: "",
      ready: false,
      reason: "Kubernetes is not connected",
      summary: "not connected",
      clusters: [],
    });
    const a = cluster(s, "hetzner-eu");
    const b = cluster(s, "gke-us");
    expect((await pf()).kubernetes).toMatchObject({
      ready: true,
      reason: null,
      summary: "2 clusters ready",
      context: "hetzner-eu, gke-us",
    });
    s.recordConnectionCheck("kubernetes", "Unauthorized", b);
    const partly = (await pf()).kubernetes;
    expect(partly).toMatchObject({ ready: true, reason: null, summary: "1 of 2 failing" });
    expect(partly.clusters).toEqual([
      { id: a, name: "hetzner-eu", ready: true, reason: null },
      { id: b, name: "gke-us", ready: false, reason: "Unauthorized" },
    ]);
    s.recordConnectionCheck("kubernetes", "timed out", a);
    expect((await pf()).kubernetes).toMatchObject({
      ready: false,
      reason: "hetzner-eu: timed out; gke-us: Unauthorized",
      summary: "2 of 2 failing",
    });
  });
});

describe("transfer between two clusters (production)", () => {
  it("moves a project from one cluster to another with the stepped shift", async () => {
    transferConfig.stepDelayMs = 5;
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "hetzner-eu");
    const b = cluster(h.store, "gke-us");
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: a }] });
    expect((await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: a })).status).toBe(409);
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: b });
    expect(res.status).toBe(202);
    await h.v2.transfers.settled(id);
    expect(h.store.getTransfer(res.json.id)).toMatchObject({ status: "done", weight: 100 });
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(
      summary.environments.map((e: { name: string; displayName: string; clusterId: string; trafficWeight: number }) => [
        e.name,
        e.displayName,
        e.clusterId,
        e.trafficWeight,
      ]),
    ).toEqual([
      ["k8s-hetzner-eu", "hetzner-eu", a, 0],
      ["k8s-gke-us", "gke-us", b, 100],
    ]);
  });

  it("add-cloud returns the environment shape with clusterId and displayName", async () => {
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "hetzner-eu");
    const b = cluster(h.store, "gke-us");
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: a }] });
    const res = await h.call("POST", `/projects/${id}/environments/add`, { target: "kubernetes", clusterId: b });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      name: "k8s-gke-us",
      clusterId: b,
      displayName: "gke-us",
      config: { clusterId: b },
    });
    expect(
      (await h.call("POST", `/projects/${id}/environments/add`, { target: "kubernetes", clusterId: b })).status,
    ).toBe(409);
  });
});

describe("review follow-ups", () => {
  const cronsOf = (s: Store, envId: string) =>
    (JSON.parse(s.getEnvironment(envId).config) as { cronsEnabled?: boolean }).cronsEnabled;

  it("a transfer moves traffic off every other environment in proportion, and leaves crons only on the target", async () => {
    transferConfig.stepDelayMs = 5;
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "a");
    const b = cluster(h.store, "b");
    const c = cluster(h.store, "c");
    const id = await deployedProject(h, {
      clouds: [
        { target: "kubernetes", clusterId: a },
        { target: "kubernetes", clusterId: b },
      ],
    });
    const [ea, eb] = h.store.listEnvironments(id);
    expect((await h.call("PUT", `/projects/${id}/traffic`, { weights: { [ea!.id]: 60, [eb!.id]: 40 } })).status).toBe(
      200,
    );
    const before = h.edgePuts.length;
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: c });
    expect(res.status).toBe(202);
    await h.v2.transfers.settled(id);
    expect(h.store.getTransfer(res.json.id)).toMatchObject({ status: "done", weight: 100, error: "" });
    const ec = h.store.listEnvironments(id).find((e) => e.name === "k8s-c")!;
    expect([ea, eb, ec].map((e) => h.store.getEnvironment(e!.id).trafficWeight)).toEqual([0, 0, 100]);
    const puts = h.edgePuts.slice(before).map((p) => p.weights);
    expect(puts).toEqual([
      [60, 40, 0],
      [59, 40, 1],
      [54, 36, 10],
      [30, 20, 50],
      [0, 0, 100],
    ]);
    expect([cronsOf(h.store, ea!.id), cronsOf(h.store, eb!.id), cronsOf(h.store, ec.id)]).toEqual([false, false, true]);
  });

  it("setup refuses a missing or unknown cluster before creating the project", async () => {
    const s = await openStore();
    cluster(s, "a");
    cluster(s, "b");
    const setup = productionSetup(s);
    const base = {
      name: "shop",
      repo: "https://github.com/acme/shop.git",
      productionBranch: "main",
      framework: "static" as const,
      spa: false,
      buildCommand: "true",
    };
    expect(() => setup.start({ ...base, clouds: [{ target: "kubernetes" }] })).toThrow(/choose a Kubernetes cluster/);
    expect(() => setup.start({ ...base, clouds: [{ target: "kubernetes", clusterId: "kc_unknown" }] })).toThrow(
      /not connected/,
    );
    expect(s.listProjects()).toEqual([]);
  });

  it("retry refuses an unknown cluster without starting", async () => {
    const s = await openStore();
    const a = cluster(s, "a");
    const setup = productionSetup(s);
    const p = setup.start({
      name: "shop",
      repo: "https://github.com/acme/shop.git",
      productionBranch: "main",
      framework: "static",
      spa: false,
      buildCommand: "true",
      clouds: [{ target: "kubernetes", clusterId: a }],
    });
    await setup.settled(p.id);
    expect(() => setup.retry(p.id, [{ target: "kubernetes", clusterId: "kc_unknown" }])).toThrow(/not connected/);
  });

  it("treats {kubernetes} and {kubernetes, clusterId} for the only cluster as the same cloud", async () => {
    const s = await openStore();
    const a = cluster(s, "a");
    const setup = productionSetup(s);
    expect(() =>
      setup.start({
        name: "shop",
        repo: "https://github.com/acme/shop.git",
        productionBranch: "main",
        framework: "static",
        spa: false,
        buildCommand: "true",
        clouds: [{ target: "kubernetes" }, { target: "kubernetes", clusterId: a }],
      }),
    ).toThrow(/only once/);
    expect(s.listProjects()).toEqual([]);
  });

  it("the legacy environments route in production needs a connected cluster and uses the same naming and uniqueness", async () => {
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "hetzner-eu");
    const p = h.store.createProject("legacy");
    const post = (body: unknown) => h.call("POST", `/projects/${p.id}/environments`, body);
    expect((await post({ name: "k8s-hetzner-eu", target: "kubernetes" })).status).toBe(400);
    expect(
      (await post({ name: "k8s-hetzner-eu", target: "kubernetes", config: { clusterId: "kc_unknown" } })).status,
    ).toBe(400);
    expect((await post({ name: "prod", target: "kubernetes", config: { clusterId: a } })).status).toBe(400);
    const ok = await post({ name: "k8s-hetzner-eu", target: "kubernetes", config: { clusterId: a } });
    expect(ok.status).toBe(201);
    expect(ok.json.config).toMatchObject({ clusterId: a });
    expect((await post({ name: "k8s-hetzner-eu", target: "kubernetes", config: { clusterId: a } })).status).toBe(409);
  });

  it("the legacy environments route counts Production's clouds only (a staging row on the cluster doesn't block it)", async () => {
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "hetzner-eu");
    const p = h.store.createProject("legacy");
    const staging = h.store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    h.store.createEnvironment(p.id, "s-staging-k8s", "kubernetes", JSON.stringify({ clusterId: a }), staging.id);
    const res = await h.call("POST", `/projects/${p.id}/environments`, {
      name: "k8s-hetzner-eu",
      target: "kubernetes",
      config: { clusterId: a },
    });
    expect(res.status).toBe(201);
  });

  it("traffic can be split across two clusters", async () => {
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "a");
    const b = cluster(h.store, "b");
    const id = await deployedProject(h, {
      clouds: [
        { target: "kubernetes", clusterId: a },
        { target: "kubernetes", clusterId: b },
      ],
    });
    const [ea, eb] = h.store.listEnvironments(id);
    const res = await h.call("PUT", `/projects/${id}/traffic`, { weights: { [ea!.id]: 30, [eb!.id]: 70 } });
    expect(res.status).toBe(200);
    expect(
      res.json.backends.map((x: { environmentId: string; weight: number }) => [x.environmentId, x.weight]),
    ).toEqual([
      [ea!.id, 30],
      [eb!.id, 70],
    ]);
    expect(h.edgePuts[h.edgePuts.length - 1]!.weights).toEqual([30, 70]);
  });
});

describe("returning to a cloud after archiving its environment", () => {
  it("transfer k8s-a → k8s-b, archive a, transfer back to a revives a's environment", async () => {
    transferConfig.stepDelayMs = 5;
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "a");
    const b = cluster(h.store, "b");
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: a }] });
    const [ea] = h.store.listEnvironments(id);
    const there = await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: b });
    expect(there.status).toBe(202);
    await h.v2.transfers.settled(id);
    expect((await h.call("POST", `/environments/${ea!.id}/archive`)).status).toBe(204);
    const back = await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: a });
    expect(back.status).toBe(202);
    await h.v2.transfers.settled(id);
    expect(h.store.getTransfer(back.json.id)).toMatchObject({ status: "done", weight: 100, toEnvId: ea!.id });
    const revived = h.store.getEnvironment(ea!.id);
    expect(revived).toMatchObject({ name: "k8s-a", archived: false, trafficWeight: 100 });
    expect(JSON.parse(revived.config)).toMatchObject({ clusterId: a, cronsEnabled: true });
    // Only the deployment made after it came back counts.
    expect(h.store.listDeployments(ea!.id)).toHaveLength(1);
    expect(h.store.listEnvironments(id, { includeArchived: true })).toHaveLength(2);
  });

  it("a cluster reconnected under the same name (new id) revives the environment with the new cluster id", async () => {
    transferConfig.stepDelayMs = 5;
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "a");
    const b = cluster(h.store, "b");
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: a }] });
    const [ea] = h.store.listEnvironments(id);
    await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: b });
    await h.v2.transfers.settled(id);
    expect((await h.call("POST", `/environments/${ea!.id}/archive`)).status).toBe(204);
    h.store.deleteKubernetesConnection(a);
    const a2 = cluster(h.store, "a");
    expect(a2).not.toBe(a);
    const res = await h.call("POST", `/projects/${id}/environments/add`, { target: "kubernetes", clusterId: a2 });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      id: ea!.id,
      name: "k8s-a",
      clusterId: a2,
      displayName: "a",
      trafficWeight: 0,
      archived: false,
    });
  });

  it("the legacy environments route revives an archived environment of the same name and target", async () => {
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "hetzner-eu");
    const p = h.store.createProject("legacy");
    const post = (body: unknown) => h.call("POST", `/projects/${p.id}/environments`, body);
    const first = await post({ name: "k8s-hetzner-eu", target: "kubernetes", config: { clusterId: a } });
    expect(first.status).toBe(201);
    h.store.createEnvironment(p.id, "other", "cloudrun", "{}");
    h.store.archiveEnvironment(first.json.id);
    const again = await post({ name: "k8s-hetzner-eu", target: "kubernetes", config: { clusterId: a } });
    expect(again.status).toBe(201);
    expect(again.json.id).toBe(first.json.id);
  });
});

describe("transfers with three environments", () => {
  async function waitUntil(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // Two clusters at 60/40, then a transfer to a third, shifting slowly.
  async function startThreeWay(stepDelayMs: number) {
    transferConfig.stepDelayMs = stepDelayMs;
    const h = await startHarness({ mode: "production" });
    harnesses.push(h);
    const a = cluster(h.store, "a");
    const b = cluster(h.store, "b");
    const c = cluster(h.store, "c");
    const id = await deployedProject(h, {
      clouds: [
        { target: "kubernetes", clusterId: a },
        { target: "kubernetes", clusterId: b },
      ],
    });
    const [ea, eb] = h.store.listEnvironments(id);
    expect((await h.call("PUT", `/projects/${id}/traffic`, { weights: { [ea!.id]: 60, [eb!.id]: 40 } })).status).toBe(
      200,
    );
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: c });
    expect(res.status).toBe(202);
    const transferId = res.json.id as string;
    await waitUntil(() => h.store.getTransfer(transferId).weight >= 1);
    const weights = () => h.store.listEnvironments(id).map((e) => e.trafficWeight);
    return { h, id, transferId, weights };
  }

  const steps = [
    [59, 40, 1],
    [54, 36, 10],
    [30, 20, 50],
  ];

  it("an edge push failure leaves every environment at the last split the edge accepted", async () => {
    const { h, id, transferId, weights } = await startThreeWay(300);
    await h.stopEdge();
    await h.v2.transfers.settled(id);
    const t = h.store.getTransfer(transferId);
    expect(t.status).toBe("failed");
    const stored = weights();
    expect(stored).toEqual(h.edgePuts.at(-1)!.weights);
    expect(steps).toContainEqual(stored);
    expect(stored[2]).toBe(t.weight);
  }, 20_000);

  it("cancel leaves every environment at the last split applied", async () => {
    const { h, id, transferId, weights } = await startThreeWay(300);
    expect((await h.call("POST", `/projects/${id}/transfer/cancel`)).status).toBe(200);
    await h.v2.transfers.settled(id);
    const t = h.store.getTransfer(transferId);
    expect(t.status).toBe("cancelled");
    const stored = weights();
    expect(steps).toContainEqual(stored);
    expect(stored[2]).toBe(t.weight);
    expect(h.edgePuts.at(-1)!.weights).toEqual(stored);
    // Nothing moves after the cancel.
    await new Promise((r) => setTimeout(r, 400));
    expect(weights()).toEqual(stored);
  }, 20_000);
});
