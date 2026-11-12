// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createStore, type Store } from "../store.js";
import { renderDesiredTable } from "../edge-table.js";
import { certSecretName } from "../edge-manifests.js";
// Test only (Ruling P2): the edge's real parser must accept what the
// control-plane renders. Production code never imports the edge package.
import { parseRouteTable } from "../../../edge/src/route-table.js";

const openStores: Store[] = [];
afterEach(() => {
  for (const s of openStores.splice(0)) s.close();
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-edgetable-"));
  const s = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  openStores.push(s);
  s.updateServerSettings({ edgeClusterId: "kc_edge" });
  return s;
}

function deployOk(store: Store, envId: string, url: string): void {
  const d = store.createDeployment(envId);
  store.completeDeployment(d.id, "sha256:x", url);
}

const relayRecord = (clusterId: string, address: string) => ({
  clusterId,
  address,
  caPem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
  status: "ready",
  token: "relaytoken_" + clusterId,
  caKeyPem: "CAKEY",
  certPem: "CERT",
  keyPem: "KEY",
});

describe("renderDesiredTable and Cloud Run domains", () => {
  it("leaves out the host of a domain Cloud Run serves", async () => {
    const store = await openTestStore();
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: "shop.example.net" });
    const cr = store.createEnvironment(p.id, "cloudrun", "cloudrun", JSON.stringify({ project: "g", region: "r", arRepo: "a" }));
    deployOk(store, cr.id, "https://pabc-cloudrun-xyz.a.run.app");
    store.setTrafficWeights(p.id, { [cr.id]: 100 });
    store.addDomain(p.id, "www.example.com", "custom", "cloudrun");
    store.addDomain(p.id, "edge.example.com", "custom");

    const table = renderDesiredTable(store, { challenges: {} });

    expect(Object.keys(table.targets).sort()).toEqual(["edge.example.com", "shop.example.net"]);
  });
});

describe("renderDesiredTable", () => {
  it("routes a project on the edge cluster plus Cloud Run with plain urls", async () => {
    const store = await openTestStore();
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: "shop.example.net" });
    const k8s = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: "kc_edge" }));
    const cr = store.createEnvironment(p.id, "cloudrun", "cloudrun", JSON.stringify({ project: "g", region: "r", arRepo: "a" }));
    deployOk(store, k8s.id, "http://pabc-k8s.nbo-p-abc.svc.cluster.local:8080");
    deployOk(store, cr.id, "https://pabc-cloudrun-xyz.a.run.app");
    store.setTrafficWeights(p.id, { [k8s.id]: 70, [cr.id]: 30 });

    const table = renderDesiredTable(store, { challenges: {} });

    expect(table).toEqual({
      version: 1,
      targets: {
        "shop.example.net": {
          backends: [
            { id: k8s.id, url: "http://pabc-k8s.nbo-p-abc.svc.cluster.local:8080", weight: 70, insecureSkipVerify: false },
            { id: cr.id, url: "https://pabc-cloudrun-xyz.a.run.app", weight: 30, insecureSkipVerify: false },
          ],
        },
      },
      challenges: {},
    });
  });

  it("reaches another cluster through its relay, and omits a backend whose cluster has no relay", async () => {
    const store = await openTestStore();
    store.saveRelay(relayRecord("kc_far", "203.0.113.7"));
    store.saveRelay(relayRecord("kc_v6", "2001:db8::1"));
    store.saveRelay(relayRecord("kc_noaddr", ""));
    const p = store.createProject("multi");
    store.updateProject(p.id, { edgeHost: "multi.example.net" });
    const far = store.createEnvironment(p.id, "k8s-far", "kubernetes", JSON.stringify({ clusterId: "kc_far" }));
    const v6 = store.createEnvironment(p.id, "k8s-v6", "kubernetes", JSON.stringify({ clusterId: "kc_v6" }));
    const none = store.createEnvironment(p.id, "k8s-none", "kubernetes", JSON.stringify({ clusterId: "kc_none" }));
    const noaddr = store.createEnvironment(p.id, "k8s-noaddr", "kubernetes", JSON.stringify({ clusterId: "kc_noaddr" }));
    for (const e of [far, v6, none, noaddr]) deployOk(store, e.id, `http://${e.name}.nbo-p-abc.svc.cluster.local:8080`);
    store.setTrafficWeights(p.id, { [far.id]: 25, [v6.id]: 25, [none.id]: 25, [noaddr.id]: 25 });

    const backends = renderDesiredTable(store, { challenges: {} }).targets["multi.example.net"]!.backends;

    expect(backends).toEqual([
      {
        id: far.id,
        url: "http://k8s-far.nbo-p-abc.svc.cluster.local:8080",
        weight: 25,
        insecureSkipVerify: false,
        via: { url: "https://203.0.113.7", caPem: relayRecord("kc_far", "").caPem, token: "relaytoken_kc_far" },
      },
      {
        id: v6.id,
        url: "http://k8s-v6.nbo-p-abc.svc.cluster.local:8080",
        weight: 25,
        insecureSkipVerify: false,
        via: { url: "https://[2001:db8::1]", caPem: relayRecord("kc_v6", "").caPem, token: "relaytoken_kc_v6" },
      },
    ]);
  });

  it("a Kubernetes environment with no clusterId is on kc_default", async () => {
    const store = await openTestStore();
    store.updateServerSettings({ edgeClusterId: "kc_default" });
    const p = store.createProject("legacy");
    store.updateProject(p.id, { edgeHost: "legacy.example.net" });
    const k8s = store.createEnvironment(p.id, "k8s", "kubernetes");
    deployOk(store, k8s.id, "http://plegacy-k8s.nbo-p-abc.svc.cluster.local:8080");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    expect(renderDesiredTable(store, { challenges: {} }).targets["legacy.example.net"]!.backends).toEqual([
      { id: k8s.id, url: "http://plegacy-k8s.nbo-p-abc.svc.cluster.local:8080", weight: 100, insecureSkipVerify: false },
    ]);
  });

  it("routes every domain of a project; active ones get tls and redirectHttps, pending ones neither", async () => {
    const store = await openTestStore();
    const p = store.createProject("blog");
    store.updateProject(p.id, { edgeHost: "blog.example.net" });
    const k8s = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: "kc_edge" }));
    deployOk(store, k8s.id, "http://pblog-k8s.nbo-p-abc.svc.cluster.local:8080");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    const def = store.addDomain(p.id, "blog.example.net", "default");
    store.updateDomain(def.id, { status: "active" });
    const live = store.addDomain(p.id, "www.blog.com", "custom");
    store.updateDomain(live.id, { status: "active" });
    store.addDomain(p.id, "new.blog.com", "custom");

    const t = renderDesiredTable(store, { challenges: {} }).targets;

    expect(Object.keys(t).sort()).toEqual(["blog.example.net", "new.blog.com", "www.blog.com"]);
    expect(t["blog.example.net"]).toMatchObject({ tls: certSecretName("blog.example.net"), redirectHttps: true });
    expect(t["www.blog.com"]).toMatchObject({ tls: certSecretName("www.blog.com"), redirectHttps: true });
    expect(t["new.blog.com"]!.tls).toBeUndefined();
    expect(t["new.blog.com"]!.redirectHttps).toBeUndefined();
    expect(t["new.blog.com"]!.backends).toHaveLength(1);
  });

  it("skips projects with no live backend and a removed host", async () => {
    const store = await openTestStore();
    const empty = store.createProject("empty");
    store.updateProject(empty.id, { edgeHost: "empty.example.net" });
    store.createEnvironment(empty.id, "k8s", "kubernetes", JSON.stringify({ clusterId: "kc_edge" }));
    const gone = store.createProject("gone");
    store.updateProject(gone.id, { edgeHost: "gone.example.net" });
    const env = store.createEnvironment(gone.id, "k8s", "kubernetes", JSON.stringify({ clusterId: "kc_edge" }));
    deployOk(store, env.id, "http://pgone-k8s.nbo-p-abc.svc.cluster.local:8080");
    store.setTrafficWeights(gone.id, { [env.id]: 100 });
    store.addDomain(gone.id, "gone.com", "custom");

    expect(Object.keys(renderDesiredTable(store, { challenges: {} }).targets).sort()).toEqual(["gone.com", "gone.example.net"]);
    expect(renderDesiredTable(store, { challenges: {}, excludeHost: "gone.example.net" }).targets).toEqual({});
  });

  it("renders a table with every field that the edge's own parser accepts unchanged (Ruling P2)", async () => {
    const store = await openTestStore();
    store.saveRelay(relayRecord("kc_far", "203.0.113.7"));
    const p = store.createProject("full");
    store.updateProject(p.id, { edgeHost: "full.example.net", speedInsights: true, speedInsightsInject: false, speedInsightsSampleRate: 25 });
    const near = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: "kc_edge" }));
    const far = store.createEnvironment(p.id, "k8s-far", "kubernetes", JSON.stringify({ clusterId: "kc_far" }));
    deployOk(store, near.id, "http://pfull-k8s.nbo-p-abc.svc.cluster.local:8080");
    deployOk(store, far.id, "http://pfull-k8s-far.nbo-p-abc.svc.cluster.local:8080");
    store.setTrafficWeights(p.id, { [near.id]: 60, [far.id]: 40 });
    const d = store.addDomain(p.id, "full.example.net", "default");
    store.updateDomain(d.id, { status: "active" });

    const table = renderDesiredTable(store, { challenges: { "tok_abc-123": "tok_abc-123.thumb" } });
    const target = table.targets["full.example.net"]!;
    expect(target.insights).toEqual({ enabled: true, inject: false, sampleRate: 25 });
    expect(target.tls).toBe(certSecretName("full.example.net"));
    expect(target.redirectHttps).toBe(true);
    expect(target.backends[1]!.via).toBeDefined();
    expect(table.challenges).toEqual({ "tok_abc-123": "tok_abc-123.thumb" });

    const parsed = parseRouteTable(JSON.stringify(table));
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(table);
  });
});

describe("relay records", () => {
  it("round-trip, upsert by cluster, and count as sealed data", async () => {
    const store = await openTestStore();
    expect(store.getRelay("kc_far")).toBeNull();
    store.saveRelay(relayRecord("kc_far", ""));
    store.saveRelay(relayRecord("kc_far", "203.0.113.9"));
    expect(store.getRelay("kc_far")).toMatchObject({ ...relayRecord("kc_far", "203.0.113.9"), clusterId: "kc_far" });
    expect(store.hasSealedSecrets()).toBe(true);
    expect(() => store.verifySecretKey()).not.toThrow();
  });
});

describe("renderDesiredTable validation", () => {
  it("drops entries the edge would reject (colliding hosts, bad challenge tokens) and logs each problem once", async () => {
    const store = await openTestStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const mk = (name: string, host: string) => {
      const p = store.createProject(name);
      store.updateProject(p.id, { edgeHost: host });
      const env = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: "kc_edge" }));
      deployOk(store, env.id, `http://p-${name}.nbo-p-abc.svc.cluster.local:8080`);
      store.setTrafficWeights(p.id, { [env.id]: 100 });
      return env;
    };
    const first = mk("one", "same.example.net");
    mk("two", "Same.Example.Net.");
    mk("three", "three.example.net");
    const bad = mk("four", "four.example.net");
    deployOk(store, bad.id, "not a url");

    const render = () => renderDesiredTable(store, { challenges: { "good_tok-1": "good_tok-1.k", "bad token!": "x", ["a".repeat(129)]: "y" } });
    const table = render();
    render();

    expect(Object.keys(table.targets).sort()).toEqual(["same.example.net", "three.example.net"]);
    expect(table.targets["same.example.net"]!.backends[0]!.id).toBe(first.id);
    expect(table.challenges).toEqual({ "good_tok-1": "good_tok-1.k" });
    const parsed = parseRouteTable(JSON.stringify(table));
    expect(Object.keys(parsed.targets).sort()).toEqual(["same.example.net", "three.example.net"]);
    const messages = errors.mock.calls.map((c) => String(c[0]));
    // host collision, the bad backend url (its target then has nothing to route), two bad tokens — each once.
    expect(messages.filter((m) => m.includes("same.example.net"))).toHaveLength(1);
    expect(messages.filter((m) => m.includes("not a url"))).toHaveLength(1);
    expect(messages.filter((m) => m.includes("bad token!"))).toHaveLength(1);
    errors.mockRestore();
  });
});

describe("renderDesiredTable with stages", () => {
  // shop: Production on the edge cluster and Cloud Run, with Speed
  // Insights, an active custom domain and a pending one.
  async function productionOnly() {
    const store = await openTestStore();
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: "shop.example.net", speedInsights: true });
    const k8s = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: "kc_edge" }));
    const cr = store.createEnvironment(p.id, "cloudrun", "cloudrun", JSON.stringify({ project: "g", region: "r", arRepo: "a" }));
    deployOk(store, k8s.id, "http://pabc-k8s.nbo-p-abc.svc.cluster.local:8080");
    deployOk(store, cr.id, "https://pabc-cloudrun-xyz.a.run.app");
    store.setTrafficWeights(p.id, { [k8s.id]: 70, [cr.id]: 30 });
    store.updateDomain(store.addDomain(p.id, "shop.example.net", "default").id, { status: "active" });
    store.updateDomain(store.addDomain(p.id, "www.shop.com", "custom").id, { status: "active" });
    store.addDomain(p.id, "new.shop.com", "custom");
    return { store, p, k8s, cr };
  }

  it("renders a Production-only project exactly as before stages", async () => {
    const { store, k8s, cr } = await productionOnly();
    const backends = [
      { id: k8s.id, url: "http://pabc-k8s.nbo-p-abc.svc.cluster.local:8080", weight: 70, insecureSkipVerify: false },
      { id: cr.id, url: "https://pabc-cloudrun-xyz.a.run.app", weight: 30, insecureSkipVerify: false },
    ];
    const insights = { enabled: true, inject: true, sampleRate: 100 };
    const table = renderDesiredTable(store, { challenges: {} });
    expect(JSON.stringify(table)).toBe(
      JSON.stringify({
        version: 1,
        targets: {
          "shop.example.net": { backends, insights, tls: certSecretName("shop.example.net"), redirectHttps: true },
          "www.shop.com": { backends, insights, tls: certSecretName("www.shop.com"), redirectHttps: true },
          "new.shop.com": { backends, insights },
        },
        challenges: {},
      }),
    );
  });

  it("routes a stage's host and domain rows to the stage's backends, without Speed Insights, leaving Production's targets unchanged", async () => {
    const { store, p } = await productionOnly();
    const before = renderDesiredTable(store, { challenges: {} });
    const stage = store.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.example.net" });
    const env = store.createEnvironment(p.id, "s-staging-cr", "cloudrun", JSON.stringify({ project: "g", region: "r", arRepo: "a" }), stage.id);
    deployOk(store, env.id, "https://pabc-s-staging-cr-xyz.a.run.app");
    store.setTrafficWeights(p.id, { [env.id]: 100 }, stage.id);
    store.addDomain(p.id, "staging--shop.example.net", "default", "edge", stage.id);
    store.updateDomain(store.addDomain(p.id, "staging.shop.com", "custom", "edge", stage.id).id, { status: "active" });

    const table = renderDesiredTable(store, { challenges: {} });

    const stageBackends = [{ id: env.id, url: "https://pabc-s-staging-cr-xyz.a.run.app", weight: 100, insecureSkipVerify: false }];
    expect(table.targets["staging--shop.example.net"]).toEqual({ backends: stageBackends });
    expect(table.targets["staging.shop.com"]).toEqual({ backends: stageBackends, tls: certSecretName("staging.shop.com"), redirectHttps: true });
    for (const host of Object.keys(before.targets)) expect(JSON.stringify(table.targets[host])).toBe(JSON.stringify(before.targets[host]));
    expect(Object.keys(table.targets)).toEqual([...Object.keys(before.targets), "staging--shop.example.net", "staging.shop.com"]);
    expect(() => parseRouteTable(JSON.stringify(table))).not.toThrow();

    // Removing the stage's host drops only the stage's targets.
    const without = renderDesiredTable(store, { challenges: {}, excludeHost: "staging--shop.example.net" });
    expect(Object.keys(without.targets)).toEqual(Object.keys(before.targets));
  });

  it("leaves out a stage with no live backend", async () => {
    const { store, p } = await productionOnly();
    const stage = store.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.example.net" });
    store.createEnvironment(p.id, "s-staging-cr", "cloudrun", "{}", stage.id);
    expect(Object.keys(renderDesiredTable(store, { challenges: {} }).targets)).not.toContain("staging--shop.example.net");
  });
});
