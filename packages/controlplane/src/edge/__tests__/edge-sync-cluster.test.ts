// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CommandRunner } from "@nbo/deploy";
import { createStore, type Store } from "../../store/store.js";
import { createClusterEdgeWriter, renderDesiredTable } from "../edge-table.js";
import { createClusterEdgeSync } from "../edge-sync.js";
import type { RouteTable } from "../edge-manifests.js";
import { wireV2 } from "../../v2.js";
import { parseRouteTable } from "../../../../edge/src/route-table.js";
import { fakeCloudSetup, fakeDeploymentTrigger, fakeGoogleConnect, fakeKubeConnect } from "../../testing.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-edgesync-cluster-"));
  const s = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    s.close();
    await rm(dir, { recursive: true, force: true });
  });
  return s;
}

interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

// fakeCluster keeps one ConfigMap (nbo-edge-routes) and answers get /
// replace / create like kubectl, with an optional queue of injected
// replace failures.
function fakeCluster(
  opts: { replaceErrors?: string[]; present?: boolean; beforeReplace?: (n: number) => Promise<void> | void } = {},
) {
  const calls: Call[] = [];
  let rv = 1;
  let data: string | null = opts.present === false ? null : JSON.stringify({ version: 1, targets: {}, challenges: {} });
  const replaceErrors = [...(opts.replaceErrors ?? [])];
  let replaces = 0;
  const run: CommandRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, input: o?.input });
    const line = args.join(" ");
    if (line.includes("get configmap nbo-edge-routes -o json")) {
      if (data === null)
        throw new Error(
          `kubectl ${line} failed with exit code 1:\nError from server (NotFound): configmaps "nbo-edge-routes" not found`,
        );
      const cm = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "nbo-edge-routes", namespace: "nbo-edge", resourceVersion: String(rv) },
        data: { "routes.json": data },
      };
      // Each read sees a newer version (another writer got in between).
      rv++;
      return JSON.stringify(cm);
    }
    if (line.includes("replace -f -")) {
      await opts.beforeReplace?.(++replaces);
      const err = replaceErrors.shift();
      if (err) throw new Error(`kubectl ${line} failed with exit code 1:\n${err}`);
      data = (JSON.parse(o!.input!) as { data: Record<string, string> }).data["routes.json"]!;
      return "configmap/nbo-edge-routes replaced\n";
    }
    if (line.includes("create -f -")) {
      data = /"?routes\.json"?: (.*)$/m.exec(o!.input!)![1]!;
      // The YAML emitter quotes the key and the JSON string.
      data = JSON.parse(data) as string;
      return "configmap/nbo-edge-routes created\n";
    }
    throw new Error(`unexpected kubectl ${line}`);
  };
  return { run, calls, table: (): RouteTable | null => (data === null ? null : (JSON.parse(data) as RouteTable)) };
}

const table = (host: string): RouteTable => ({
  version: 1,
  targets: {
    [host]: { backends: [{ id: "env_1", url: "https://x.a.run.app", weight: 100, insecureSkipVerify: false }] },
  },
  challenges: {},
});

async function edgeStore(): Promise<Store> {
  const store = await openTestStore();
  const id = store.saveKubernetesConnection(
    {
      name: "edge",
      server: "https://edge.example:6443",
      registry: { kind: "custom", server: "ghcr.io", username: "me" },
    },
    { kubeconfig: "edge-kubeconfig" },
  ).id;
  store.updateServerSettings({ edgeClusterId: id });
  return store;
}

describe("createClusterEdgeWriter", () => {
  it("retries a conflicting replace with a fresh get and the newer resourceVersion", async () => {
    const store = await edgeStore();
    const f = fakeCluster({
      replaceErrors: [
        'Operation cannot be fulfilled on configmaps "nbo-edge-routes": the object has been modified; please apply your changes to the latest version and try again',
      ],
    });
    const kubeconfigs: string[] = [];
    const writer = createClusterEdgeWriter({
      store,
      run: f.run,
      kubeconfigFor: async (id) => (kubeconfigs.push(id), "edge-kubeconfig"),
    });

    await writer.write(() => table("a.example.net"));

    const gets = f.calls.filter((c) => c.args.join(" ").includes("get configmap"));
    const replaces = f.calls.filter((c) => c.args.join(" ").includes("replace -f -"));
    expect(gets).toHaveLength(2);
    expect(replaces).toHaveLength(2);
    expect(replaces[0]!.args).toEqual(expect.arrayContaining(["--kubeconfig", "-n", "nbo-edge"]));
    const last = JSON.parse(replaces[1]!.input!) as {
      metadata: { resourceVersion: string; namespace: string; name: string };
    };
    expect(last.metadata).toMatchObject({ name: "nbo-edge-routes", namespace: "nbo-edge", resourceVersion: "2" });
    expect(f.table()).toEqual(table("a.example.net"));
    expect(kubeconfigs[0]).toBe(store.getServerSettings().edgeClusterId);
  });

  it("creates the ConfigMap when it is absent, and read() returns null then the table", async () => {
    const store = await edgeStore();
    const f = fakeCluster({ present: false });
    const writer = createClusterEdgeWriter({ store, run: f.run, kubeconfigFor: async () => "kc" });
    expect(await writer.read()).toBeNull();
    await writer.write(() => table("b.example.net"));
    expect(f.calls.some((c) => c.args.join(" ").includes("create -f -"))).toBe(true);
    expect(await writer.read()).toEqual(table("b.example.net"));
  });

  it("gives up after 5 conflicts", async () => {
    const store = await edgeStore();
    const f = fakeCluster({
      replaceErrors: Array(6).fill("Error from server (Conflict): the object has been modified"),
    });
    const writer = createClusterEdgeWriter({ store, run: f.run, kubeconfigFor: async () => "kc" });
    await expect(writer.write(() => table("c.example.net"))).rejects.toThrow(/conflict|modified/i);
    expect(f.calls.filter((c) => c.args.join(" ").includes("replace -f -"))).toHaveLength(5);
  });
});

function deployOk(store: Store, envId: string, url: string): void {
  const d = store.createDeployment(envId);
  store.completeDeployment(d.id, "sha256:x", url);
}

describe("createClusterEdgeSync", () => {
  it("push writes the whole rendered table; inSync compares it; remove drops a project's hosts", async () => {
    const store = await edgeStore();
    const edgeId = store.getServerSettings().edgeClusterId;
    const mk = (name: string) => {
      const p = store.createProject(name);
      store.updateProject(p.id, { edgeHost: `${name}.example.net` });
      const env = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: edgeId }));
      deployOk(store, env.id, `http://p-${name}.nbo-p-abc.svc.cluster.local:8080`);
      return { p, env };
    };
    const a = mk("alpha");
    const b = mk("beta");
    store.setTrafficWeights(b.p.id, { [b.env.id]: 100 });
    const f = fakeCluster();
    const writer = createClusterEdgeWriter({ store, run: f.run, kubeconfigFor: async () => "kc" });
    const sync = createClusterEdgeSync(store, writer, { challenges: () => ({ tok: "tok.key" }) });

    expect(await sync.inSync(a.p.id)).toBe(false);
    await sync.onDeployed(a.p.id, a.env.id);
    expect(store.getEnvironment(a.env.id).trafficWeight).toBe(100);
    expect(f.table()).toEqual(renderDesiredTable(store, { challenges: { tok: "tok.key" } }));
    expect(Object.keys(f.table()!.targets).sort()).toEqual(["alpha.example.net", "beta.example.net"]);
    expect(await sync.inSync(a.p.id)).toBe(true);

    store.setTrafficWeights(a.p.id, { [a.env.id]: 50 });
    expect(await sync.inSync(a.p.id)).toBe(false);
    await sync.reconcile();
    expect(await sync.inSync(a.p.id)).toBe(true);

    await sync.remove("beta.example.net");
    expect(Object.keys(f.table()!.targets)).toEqual(["alpha.example.net"]);
    expect(sync.desiredTarget(a.p.id)?.backends).toHaveLength(1);
  });
});

describe("wireV2 edge sync choice", () => {
  it("uses the dev HTTP sync until the edge cluster is set in production, then the cluster table, without rewiring", async () => {
    const store = await openTestStore();
    const f = fakeCluster();
    const v2 = wireV2(store, {
      mode: "production",
      deploymentTrigger: fakeDeploymentTrigger(store),
      cloudSetup: fakeCloudSetup(),
      edgeAdminUrl: "http://127.0.0.1:1",
      edgePublicPort: 9443,
      googleConnect: fakeGoogleConnect(store),
      kubeConnect: fakeKubeConnect(store),
      run: f.run,
    });
    const p = store.createProject("gamma");
    store.updateProject(p.id, { edgeHost: "gamma.example.net" });
    const cr = store.createEnvironment(
      p.id,
      "cloudrun",
      "cloudrun",
      JSON.stringify({ project: "g", region: "r", arRepo: "a" }),
    );
    deployOk(store, cr.id, "https://gamma.a.run.app");
    store.setTrafficWeights(p.id, { [cr.id]: 100 });

    // No edge cluster yet: the dev sync talks to the (unreachable) admin URL.
    await expect(v2.edgeSync.push(p.id)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);

    const id = store.saveKubernetesConnection(
      { name: "edge", server: "https://e:6443", registry: { kind: "custom", server: "ghcr.io", username: "me" } },
      { kubeconfig: "edge-kc" },
    ).id;
    store.updateServerSettings({ edgeClusterId: id });
    await v2.edgeSync.push(p.id);
    expect(f.table()!.targets["gamma.example.net"]!.backends[0]!.url).toBe("https://gamma.a.run.app");
  });

  it("dev mode keeps the HTTP sync even with an edge cluster set", async () => {
    const store = await openTestStore();
    store.updateServerSettings({ edgeClusterId: "kc_x" });
    const f = fakeCluster();
    const v2 = wireV2(store, {
      mode: "dev",
      deploymentTrigger: fakeDeploymentTrigger(store),
      cloudSetup: fakeCloudSetup(),
      edgeAdminUrl: "http://127.0.0.1:1",
      edgePublicPort: 9443,
      run: f.run,
    });
    const p = store.createProject("delta");
    store.updateProject(p.id, { edgeHost: "delta.example.net" });
    const env = store.createEnvironment(p.id, "k8s", "kubernetes");
    deployOk(store, env.id, "https://pdelta-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [env.id]: 100 });
    await expect(v2.edgeSync.push(p.id)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

describe("cluster edge writes under concurrency", () => {
  async function oneProject() {
    const store = await edgeStore();
    const edgeId = store.getServerSettings().edgeClusterId;
    const p = store.createProject("omega");
    store.updateProject(p.id, { edgeHost: "omega.example.net" });
    const a = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: edgeId }));
    const b = store.createEnvironment(
      p.id,
      "cloudrun",
      "cloudrun",
      JSON.stringify({ project: "g", region: "r", arRepo: "a" }),
    );
    deployOk(store, a.id, "http://p-omega.nbo-p-abc.svc.cluster.local:8080");
    deployOk(store, b.id, "https://omega.a.run.app");
    store.setTrafficWeights(p.id, { [a.id]: 100, [b.id]: 0 });
    return { store, p, a, b };
  }

  it("two overlapping pushes leave the ConfigMap at the latest store state", async () => {
    const { store, p, a, b } = await oneProject();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The first replace stalls until the second push has been started.
    const f = fakeCluster({ beforeReplace: (n) => (n === 1 ? gate : undefined) });
    const writer = createClusterEdgeWriter({ store, run: f.run, kubeconfigFor: async () => "kc" });
    const sync = createClusterEdgeSync(store, writer, { challenges: () => ({}) });

    const first = sync.push(p.id);
    await new Promise((r) => setTimeout(r, 20));
    store.setTrafficWeights(p.id, { [a.id]: 10, [b.id]: 90 });
    const second = sync.push(p.id);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);

    expect(f.table()).toEqual(renderDesiredTable(store, { challenges: {} }));
    expect(f.table()!.targets["omega.example.net"]!.backends.map((x) => x.weight)).toEqual([10, 90]);
  });

  it("a conflict retry re-renders, so the second replace carries the newer state", async () => {
    const { store, p, a, b } = await oneProject();
    const f = fakeCluster({
      replaceErrors: ["the object has been modified"],
      beforeReplace: (n) => {
        if (n === 1) store.setTrafficWeights(p.id, { [a.id]: 50, [b.id]: 50 });
      },
    });
    const writer = createClusterEdgeWriter({ store, run: f.run, kubeconfigFor: async () => "kc" });
    await writer.write(() => renderDesiredTable(store, { challenges: {} }));
    const replaces = f.calls.filter((c) => c.args.join(" ").includes("replace -f -"));
    const weights = (i: number) =>
      (
        JSON.parse(
          (JSON.parse(replaces[i]!.input!) as { data: Record<string, string> }).data["routes.json"]!,
        ) as RouteTable
      ).targets["omega.example.net"]!.backends.map((x) => x.weight);
    expect(weights(0)).toEqual([100, 0]);
    expect(weights(1)).toEqual([50, 50]);
  });
});

describe("cluster edge writes with an invalid entry", () => {
  it("still writes the table without it, and the edge's parser accepts the written body", async () => {
    const store = await edgeStore();
    const edgeId = store.getServerSettings().edgeClusterId;
    for (const [name, host] of [
      ["one", "dup.example.net"],
      ["two", "DUP.example.net."],
      ["ok", "ok.example.net"],
    ] as const) {
      const p = store.createProject(name);
      store.updateProject(p.id, { edgeHost: host });
      const env = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: edgeId }));
      deployOk(store, env.id, `http://p-${name}.nbo-p-abc.svc.cluster.local:8080`);
      store.setTrafficWeights(p.id, { [env.id]: 100 });
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeCluster();
    const writer = createClusterEdgeWriter({ store, run: f.run, kubeconfigFor: async () => "kc" });
    const sync = createClusterEdgeSync(store, writer, { challenges: () => ({ "no good": "x", fine: "fine.k" }) });
    await sync.push("");
    const body = (
      JSON.parse(f.calls.filter((c) => c.args.join(" ").includes("replace -f -")).at(-1)!.input!) as {
        data: Record<string, string>;
      }
    ).data["routes.json"]!;
    const parsed = parseRouteTable(body);
    expect(Object.keys(parsed.targets).sort()).toEqual(["dup.example.net", "ok.example.net"]);
    expect({ ...parsed.challenges }).toEqual({ fine: "fine.k" });
    vi.restoreAllMocks();
  });
});

describe("Cloudflare in the route table", () => {
  async function twoHosts() {
    const store = await edgeStore();
    const edgeId = store.getServerSettings().edgeClusterId;
    const p = store.createProject("cf");
    store.updateProject(p.id, { edgeHost: "cf.example.net" });
    const env = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: edgeId }));
    deployOk(store, env.id, "http://p-cf.nbo-p-abc.svc.cluster.local:8080");
    store.setTrafficWeights(p.id, { [env.id]: 100 });
    return { store, p };
  }

  it("is byte-for-byte unchanged with no Cloudflare domain", async () => {
    const { store, p } = await twoHosts();
    store.addDomain(p.id, "www.cf.test", "custom");
    const t = renderDesiredTable(store, { challenges: {}, cloudflareRanges: ["173.245.48.0/20"] });
    expect(JSON.stringify(t)).not.toContain("cloudflare");
    expect(Object.keys(t).sort()).toEqual(["challenges", "targets", "version"]);
  });

  it("marks a Cloudflare domain pending and active, not its sibling hosts, and adds the ranges", async () => {
    const { store, p } = await twoHosts();
    const pending = store.addDomain(p.id, "pending.cf.test", "custom");
    const active = store.addDomain(p.id, "active.cf.test", "custom");
    store.addDomain(p.id, "plain.cf.test", "custom");
    store.updateDomain(pending.id, { behindCloudflare: true });
    store.updateDomain(active.id, { behindCloudflare: true, status: "active" });
    const ranges = ["173.245.48.0/20", "2400:cb00::/32"];
    const t = renderDesiredTable(store, { challenges: {}, cloudflareRanges: ranges });
    expect(t.targets["pending.cf.test"]!.cloudflare).toBe(true);
    expect(t.targets["pending.cf.test"]!.tls).toBeUndefined();
    expect(t.targets["active.cf.test"]!.cloudflare).toBe(true);
    expect(t.targets["active.cf.test"]!.tls).toBeDefined();
    expect("cloudflare" in t.targets["plain.cf.test"]!).toBe(false);
    expect("cloudflare" in t.targets["cf.example.net"]!).toBe(false);
    expect(t.cloudflareRanges).toEqual(ranges);
    expect(() => parseRouteTable(JSON.stringify(t))).not.toThrow();
  });

  it("the cluster sync takes the ranges from its option", async () => {
    const { store, p } = await twoHosts();
    const d = store.addDomain(p.id, "x.cf.test", "custom");
    store.updateDomain(d.id, { behindCloudflare: true });
    const f = fakeCluster();
    const writer = createClusterEdgeWriter({ store, run: f.run, kubeconfigFor: async () => "kc" });
    const sync = createClusterEdgeSync(store, writer, {
      challenges: () => ({}),
      cloudflareRanges: () => ["173.245.48.0/20"],
    });
    await sync.push(p.id);
    expect(f.table()!.cloudflareRanges).toEqual(["173.245.48.0/20"]);
  });

  it("wireV2 exposes one CloudflareRanges instance", async () => {
    const store = await openTestStore();
    const v2 = wireV2(store, {
      deploymentTrigger: fakeDeploymentTrigger(),
      cloudSetup: fakeCloudSetup(),
      edgeAdminUrl: "http://127.0.0.1:1",
      edgePublicPort: 8080,
    });
    expect(typeof v2.cloudflareRanges.current).toBe("function");
  });
});

describe("cluster edge sync with stages", () => {
  it("the first staging deploy gets 100% of staging, Production keeps its split, and the table carries both", async () => {
    const store = await edgeStore();
    const edgeId = store.getServerSettings().edgeClusterId;
    const p = store.createProject("omega");
    store.updateProject(p.id, { edgeHost: "omega.example.net" });
    const a = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: edgeId }));
    deployOk(store, a.id, "http://p-omega.nbo-p-abc.svc.cluster.local:8080");
    store.setTrafficWeights(p.id, { [a.id]: 100 });
    const stage = store.createStage(p.id, { name: "staging", branch: "staging", host: "staging--omega.example.net" });
    const s = store.createEnvironment(
      p.id,
      "s-staging-k8s",
      "kubernetes",
      JSON.stringify({ clusterId: edgeId }),
      stage.id,
    );
    deployOk(store, s.id, "http://p-omega-s-staging-k8s.nbo-p-abc.svc.cluster.local:8080");
    const f = fakeCluster();
    const writer = createClusterEdgeWriter({ store, run: f.run, kubeconfigFor: async () => "kc" });
    const sync = createClusterEdgeSync(store, writer, { challenges: () => ({}) });

    await sync.onDeployed(p.id, s.id);

    expect(store.getEnvironment(s.id).trafficWeight).toBe(100);
    expect(store.getEnvironment(a.id).trafficWeight).toBe(100);
    expect(f.table()!.targets["omega.example.net"]!.backends.map((x) => x.id)).toEqual([a.id]);
    expect(f.table()!.targets["staging--omega.example.net"]!.backends.map((x) => [x.id, x.weight])).toEqual([
      [s.id, 100],
    ]);
    expect(sync.desiredTargets(p.id).map((t) => t.host)).toEqual(["omega.example.net", "staging--omega.example.net"]);
    expect(await sync.inSync(p.id)).toBe(true);
  });

  it("wireV2's edge sync forwards desiredTargets", async () => {
    const store = await openTestStore();
    const v2 = wireV2(store, {
      mode: "dev",
      deploymentTrigger: fakeDeploymentTrigger(store),
      cloudSetup: fakeCloudSetup(),
      edgeAdminUrl: "http://127.0.0.1:1",
      edgePublicPort: 9443,
    });
    const p = store.createProject("delta");
    store.updateProject(p.id, { edgeHost: "delta.example.net" });
    const stage = store.createStage(p.id, { name: "staging", branch: "staging", host: "staging--delta.example.net" });
    const env = store.createEnvironment(p.id, "s-staging-k8s", "kubernetes", "{}", stage.id);
    deployOk(store, env.id, "https://pdelta-s-staging-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [env.id]: 100 }, stage.id);
    expect(v2.edgeSync.desiredTarget(p.id)).toBeNull();
    expect(v2.edgeSync.desiredTargets(p.id).map((t) => t.host)).toEqual(["staging--delta.example.net"]);
  });
});
