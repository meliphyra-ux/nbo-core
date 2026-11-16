// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, X509Certificate } from "node:crypto";
import type { CommandRunner } from "@nbo/deploy";
import { createStore, type Store } from "../../store/store.js";
import { createEdgeInstaller } from "../edge-install.js";
import { detectAndSave, hetznerAnnotations } from "../../clouds/hetzner.js";
import { EDGE_VERSION } from "../edge-manifests.js";
import { fakeKubeConnect } from "../../testing.js";
import { deployAppName, projectNamespace } from "../../deploys/deploy.js";
import { ErrConflict, ErrInvalid } from "../../store/errors.js";
import type { KubeSource } from "../../clouds/kube-connect.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-edge-install-"));
  const s = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    s.close();
    await rm(dir, { recursive: true, force: true });
  });
  return s;
}

const admin: KubeSource = { kind: "kubeconfig", kubeconfig: "ADMIN-KUBECONFIG" };

interface Call {
  cmd: string;
  args: string[];
  input?: string;
  env?: Record<string, string>;
  // The kubeconfig file's content at call time.
  kubeconfig?: string;
}

// fakeCluster answers the kubectl/docker calls the installer makes; the
// LoadBalancer gets its address on the lbAfter-th poll.
function fakeCluster(
  events: string[],
  opts: {
    lbAfter?: number;
    edgeAddress?: string;
    relayAddress?: string;
    routes?: "present" | "absent";
    rolloutFail?: "nbo-edge" | "nbo-relay";
    setupVersion?: string;
    policyFail?: string;
  } = {},
) {
  const calls: Call[] = [];
  const polls: Record<string, number> = {};
  const run: CommandRunner = async (cmd, args, o) => {
    const kubeconfigAt = args.indexOf("--kubeconfig");
    calls.push({
      cmd,
      args,
      input: o?.input,
      env: o?.env,
      kubeconfig: kubeconfigAt === -1 ? undefined : readFileSync(args[kubeconfigAt + 1]!, "utf8"),
    });
    const line = args.join(" ");
    if (cmd === "docker") {
      events.push(`docker ${args[0]}`);
      return "";
    }
    if (line.includes("get service ")) {
      const name = line.includes("nbo-relay") ? "nbo-relay" : "nbo-edge";
      events.push(`poll ${name}`);
      polls[name] = (polls[name] ?? 0) + 1;
      const ready = polls[name]! >= (opts.lbAfter ?? 2);
      const address = name === "nbo-edge" ? (opts.edgeAddress ?? "34.1.2.3") : (opts.relayAddress ?? "35.9.9.9");
      return JSON.stringify({ status: { loadBalancer: ready ? { ingress: [{ ip: address }] } : {} } });
    }
    if (line.endsWith("apply -f -")) {
      const input = o?.input ?? "";
      if (input.includes("name: nbo-default-deny-ingress")) {
        const ns = args[args.indexOf("-n") + 1]!;
        events.push(`apply policies ${ns}`);
        if (opts.policyFail === ns)
          throw new Error(`apply failed for ${ns}: ${readFileSync(args[kubeconfigAt + 1]!, "utf8")}`);
        return "";
      }
      const kind = /kind: Deployment\n[\s\S]*?name: (nbo-edge|nbo-relay)/.exec(input)?.[1];
      if (kind) events.push(`apply ${kind}`);
      else if (input.includes("nbo-edge-admin")) events.push("apply admin-secret");
      else if (input.includes("nbo-relay-tls")) events.push("apply relay-secrets");
      else if (input.includes("dockerconfigjson")) events.push("apply pull-secret");
      else events.push("apply other");
      return "";
    }
    if (line.includes("get configmap nbo-edge-routes")) {
      events.push("get routes");
      if ((opts.routes ?? "absent") === "absent")
        throw new Error(
          `kubectl ${line} failed with exit code 1:\nError from server (NotFound): configmaps "nbo-edge-routes" not found`,
        );
      return JSON.stringify({ metadata: { resourceVersion: "3" }, data: { "routes.json": "{}" } });
    }
    if (line.endsWith("create -f -")) {
      events.push("create routes");
      return "";
    }
    if (line.includes("rollout restart deployment/nbo-relay")) {
      events.push("restart relay");
      return "";
    }
    const rollout = /rollout status deployment\/(nbo-edge|nbo-relay)/.exec(line);
    if (rollout) {
      events.push(`ready ${rollout[1]}`);
      if (opts.rolloutFail === rollout[1])
        throw new Error(`kubectl ${line} failed with exit code 1:
error: deployment "${rollout[1]}" exceeded its progress deadline`);
      return `deployment "${rollout[1]}" successfully rolled out
`;
    }
    if (line.includes("get validatingadmissionpolicy nbo-namespace-guard")) {
      events.push("check setup");
      return opts.setupVersion ?? "2";
    }
    if (line.includes("get deployment nbo-edge"))
      return JSON.stringify({ spec: { replicas: 2 }, status: { readyReplicas: 1 } });
    throw new Error(`unexpected ${cmd} ${line}`);
  };
  return { run, calls };
}

function addCluster(store: Store, name: string): string {
  return store.saveKubernetesConnection(
    {
      name,
      server: `https://${name}.example:6443`,
      registry: { kind: "custom", server: "registry.example/nbo", username: "me" },
    },
    { kubeconfig: `${name}-KUBECONFIG`, registryPassword: "REGISTRY-PW" },
  ).id;
}

// liveEnv adds a project's Kubernetes environment on the cluster with a
// finished deployment, as Phase 1 left it.
function liveEnv(store: Store, projectName: string, clusterId: string) {
  const project = store.createProject(projectName);
  const env = store.createEnvironment(project.id, "k8s", "kubernetes", JSON.stringify({ clusterId }));
  const d = store.createDeployment(env.id);
  store.completeDeployment(d.id, "sha256:x", `http://${projectName}.svc`);
  return { env, ns: projectNamespace(project.id), app: deployAppName(env) };
}

function setup(
  store: Store,
  opts: Parameters<typeof fakeCluster>[1] & {
    pushFails?: boolean;
    loadBalancerAnnotations?: Record<string, string>;
  } = {},
  onReconcile?: () => void,
) {
  const events: string[] = [];
  const cluster = fakeCluster(events, opts);
  const kube = fakeKubeConnect(store);
  const updateSetup = kube.updateSetup.bind(kube);
  const setupCalls: { id: string; source: KubeSource }[] = [];
  kube.updateSetup = async (id, source) => {
    events.push("updateSetup");
    setupCalls.push({ id, source });
    return updateSetup(id, source);
  };
  let reconciles = 0;
  const sleeps: number[] = [];
  const installer = createEdgeInstaller({
    store,
    kubeConnect: kube,
    run: cluster.run,
    loadBalancerAnnotations: opts.loadBalancerAnnotations,
    buildEdgeImage: async () => {
      events.push("build");
      return "nbo-edge:0123456789ab";
    },
    reconcile: async () => {
      events.push("reconcile");
      reconciles++;
      onReconcile?.();
    },
    pushTable: async () => {
      events.push("push table");
      onReconcile?.();
      if (opts.pushFails) throw new Error("configmaps nbo-edge-routes: connection refused");
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      if (ms !== 10_000) events.push(`wait ${ms}`);
    },
  });
  return { installer, events, calls: cluster.calls, setupCalls, sleeps, reconciles: () => reconciles };
}

const LOC = "load-balancer.hetzner.cloud/location";
const hetznerNodes = (labels: Record<string, string>, providerID = "hcloud://12345"): string =>
  JSON.stringify({ items: [{ metadata: { labels }, spec: { providerID } }] });
const plainNodes = JSON.stringify({
  items: [
    {
      metadata: { labels: { "topology.kubernetes.io/region": "us-east-1" } },
      spec: { providerID: "aws:///us-east-1a/i-1" },
    },
  ],
});

describe("hetznerAnnotations", () => {
  it("adds the location from the region label", () => {
    expect(hetznerAnnotations(hetznerNodes({ "topology.kubernetes.io/region": "fsn1" }), {})).toEqual({
      annotations: { [LOC]: "fsn1" },
    });
  });
  it("uses the csi location label when the region label is missing", () => {
    expect(hetznerAnnotations(hetznerNodes({ "csi.hetzner.cloud/location": "hel1" }), {}).annotations).toEqual({
      [LOC]: "hel1",
    });
  });
  it("keeps the operator's location", () => {
    const r = hetznerAnnotations(hetznerNodes({ "topology.kubernetes.io/region": "fsn1" }), { [LOC]: "nbg1" });
    expect(r).toEqual({ annotations: { [LOC]: "nbg1" } });
  });
  it("stops detecting when the operator set the network zone", () => {
    const existing = { "load-balancer.hetzner.cloud/network-zone": "eu-central" };
    expect(hetznerAnnotations(hetznerNodes({ "topology.kubernetes.io/region": "fsn1" }), existing)).toEqual({
      annotations: existing,
    });
  });
  it("gives nothing for other clouds", () => {
    expect(hetznerAnnotations(plainNodes, { a: "b" })).toEqual({ annotations: { a: "b" } });
  });
  it("gives a note naming NBO_LB_ANNOTATIONS when Hetzner nodes carry no location", () => {
    const r = hetznerAnnotations(hetznerNodes({}), {});
    expect(r.annotations).toEqual({});
    expect(r.note).toContain("NBO_LB_ANNOTATIONS");
  });
  it("copes with unreadable node data", () => {
    expect(hetznerAnnotations("not json", { a: "b" })).toEqual({ annotations: { a: "b" } });
  });
});

describe("the saved Hetzner location in the install jobs", () => {
  const svcInput = (t: ReturnType<typeof setup>) => t.calls.find((c) => c.input?.includes("kind: Service"))!.input!;
  const noNodeReads = (t: ReturnType<typeof setup>) =>
    expect(t.calls.some((c) => c.args.join(" ").includes("get nodes"))).toBe(false);

  it("edge install uses the cluster's saved location, logs it and never reads nodes", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    store.setClusterLbAnnotations(id, { [LOC]: "fsn1" });
    const t = setup(store);
    const steps: string[] = [];
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true }, { onStep: (s) => steps.push(s) });
    expect(steps).toContain("Hetzner Cloud: load balancer location fsn1");
    expect(svcInput(t)).toMatch(/load-balancer\.hetzner\.cloud\/location"?: "?fsn1/);
    noNodeReads(t);
  });
  it("reinstall and relay use the saved value of their own cluster", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.setClusterLbAnnotations(id, { [LOC]: "fsn1" });
    store.setClusterLbAnnotations(other, { [LOC]: "hel1" });
    const t = setup(store, { lbAfter: 1 });
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });
    t.calls.length = 0;
    await t.installer.reinstallEdge();
    expect(svcInput(t)).toMatch(/location"?: "?fsn1/);
    t.calls.length = 0;
    await t.installer.enableRelay({ clusterId: other, confirmBilling: true });
    expect(svcInput(t)).toMatch(/location"?: "?hel1/);
    noNodeReads(t);
  });
  it("a cluster with no saved value gets no annotation and a log line naming the remedies", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const t = setup(store);
    const steps: string[] = [];
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true }, { onStep: (s) => steps.push(s) });
    expect(svcInput(t)).not.toContain("hetzner");
    expect(
      steps.some(
        (s) =>
          s.includes("nbo-server cluster update-setup") && !s.includes("Settings") && s.includes("NBO_LB_ANNOTATIONS"),
      ),
    ).toBe(true);
    noNodeReads(t);
  });
  it("detection that finds Hetzner nodes without a location leaves its note in the install job log", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    await detectAndSave(store, id, async () => hetznerNodes({}));
    const t = setup(store);
    const steps: string[] = [];
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true }, { onStep: (s) => steps.push(s) });
    expect(steps.some((s) => s.includes("name no load balancer location") && s.includes("NBO_LB_ANNOTATIONS"))).toBe(
      true,
    );
    expect(svcInput(t)).not.toContain("nbo.dev/note");
  });
  it("the operator's location wins over the saved one", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    store.setClusterLbAnnotations(id, { [LOC]: "fsn1" });
    const t = setup(store, { loadBalancerAnnotations: { [LOC]: "nbg1" } });
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });
    expect(svcInput(t)).toMatch(/location"?: "?nbg1/);
    expect(svcInput(t)).not.toContain("fsn1");
  });
  it("an operator network-zone stops the saved location", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    store.setClusterLbAnnotations(id, { [LOC]: "fsn1" });
    const t = setup(store, { loadBalancerAnnotations: { "load-balancer.hetzner.cloud/network-zone": "eu-central" } });
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });
    expect(svcInput(t)).toContain("eu-central");
    expect(svcInput(t)).not.toContain("fsn1");
  });
});

describe("installEdge", () => {
  it("refuses without the load balancer confirmation, before any command", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const t = setup(store);
    const err = await t.installer.installEdge({ clusterId: id, admin, confirmBilling: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrInvalid);
    expect((err as Error).message).toBe("confirm the load balancer first");
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it("sets up, pushes, applies, waits for the address, saves it and reconciles — in that order", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const t = setup(store);
    const status = await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });

    expect(t.events).toEqual([
      "updateSetup",
      "build",
      "docker login",
      "docker tag",
      "docker push",
      "apply pull-secret",
      "apply admin-secret",
      "apply nbo-edge",
      "get routes",
      "create routes",
      "poll nbo-edge",
      "poll nbo-edge",
      "ready nbo-edge",
      "reconcile",
    ]);
    expect(t.setupCalls).toEqual([{ id, source: admin }]);
    expect(t.sleeps).toEqual([10_000]);

    // The image goes to the cluster's own registry and the pods pull it from there.
    const push = t.calls.find((c) => c.cmd === "docker" && c.args[0] === "push")!;
    expect(push.args).toEqual(["push", "registry.example/nbo/nbo-edge:0123456789ab"]);
    expect(push.env?.DOCKER_CONFIG).toBeTruthy();
    const edgeApply = t.calls.find((c) => c.input?.includes("kind: Deployment"))!;
    expect(edgeApply.input).toContain("registry.example/nbo/nbo-edge:0123456789ab");
    expect(edgeApply.input).toContain("nbo-pull");
    // Every kubectl call uses the scoped kubeconfig in nbo-edge, never the admin one.
    for (const c of t.calls.filter((c) => c.cmd === "kubectl")) {
      expect(c.args).toContain("--kubeconfig");
      expect(c.args.slice(c.args.indexOf("-n"), c.args.indexOf("-n") + 2)).toEqual(["-n", "nbo-edge"]);
    }
    const poll = t.calls.find((c) => c.args.includes("service"))!;
    expect(poll.args.slice(-5)).toEqual(["get", "service", "nbo-edge", "-o", "json"]);

    const token = store.getServerSecret("edge_drain_token")!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.calls.find((c) => c.input?.includes("nbo-edge-admin"))!.input).toContain(
      Buffer.from(token).toString("base64"),
    );

    expect(store.getServerSettings()).toMatchObject({ edgeClusterId: id, edgeAddress: "34.1.2.3" });
    expect(status).toEqual({ installed: true, clusterId: id, address: "34.1.2.3", ready: 1, desired: 2 });
    expect(t.reconciles()).toBe(1);
  });

  it("puts the configured load balancer annotations on the edge and relay Services", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const other = addCluster(store, "other");
    const t = setup(store, { loadBalancerAnnotations: { "load-balancer.hetzner.cloud/location": "nbg1" } });
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });
    await t.installer.enableRelay({ clusterId: other, confirmBilling: true });
    const applied = t.calls.filter((c) => c.input?.includes("kind: Service"));
    expect(applied).toHaveLength(2);
    for (const c of applied) expect(c.input).toMatch(/load-balancer\.hetzner\.cloud\/location"?: "?nbg1/);
  });

  it("keeps an existing route table and the drain token on a second install", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    store.setServerSecret("edge_drain_token", "a".repeat(64));
    const t = setup(store, { routes: "present", lbAfter: 1 });
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });
    expect(t.events).not.toContain("create routes");
    expect(store.getServerSecret("edge_drain_token")).toBe("a".repeat(64));
  });

  it("moves placeholder sslip projects to the new default host with a default domain row", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const shop = store.createProject("shop");
    store.updateProject(shop.id, { edgeHost: "shop.127.0.0.1.sslip.io" });
    store.addDomain(shop.id, "shop.127.0.0.1.sslip.io", "default");
    const blog = store.createProject("blog");
    store.updateProject(blog.id, { edgeHost: "blog.custom.example" });
    const t = setup(store, { lbAfter: 1 });
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });

    expect(store.getProject(shop.id).edgeHost).toBe("shop.34-1-2-3.sslip.io");
    expect(store.listDomains(shop.id).map((d) => [d.host, d.kind])).toEqual([["shop.34-1-2-3.sslip.io", "default"]]);
    expect(store.getProject(blog.id).edgeHost).toBe("blog.custom.example");
    expect(store.listDomains(blog.id)).toEqual([]);
  });

  it("leaves placeholder projects alone when the edge only has a hostname and no base domain", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const shop = store.createProject("shop");
    store.updateProject(shop.id, { edgeHost: "shop.127.0.0.1.sslip.io" });
    // A hostname address from the provider.
    const events: string[] = [];
    const cluster = fakeCluster(events, { lbAfter: 1 });
    const hostnameRun: CommandRunner = async (cmd, args, o) => {
      if (args.join(" ").includes("get service nbo-edge"))
        return JSON.stringify({ status: { loadBalancer: { ingress: [{ hostname: "abc.elb.amazonaws.com" }] } } });
      return cluster.run(cmd, args, o);
    };
    const installer = createEdgeInstaller({
      store,
      kubeConnect: fakeKubeConnect(store),
      run: hostnameRun,
      buildEdgeImage: async () => "nbo-edge:x",
      reconcile: async () => {},
      pushTable: async () => {},
      sleep: async () => {},
    });
    const status = await installer.installEdge({ clusterId: id, admin, confirmBilling: true });
    expect(status.address).toBe("abc.elb.amazonaws.com");
    expect(store.getProject(shop.id).edgeHost).toBe("shop.127.0.0.1.sslip.io");
  });

  it("saves nothing when the edge pods never become ready", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const shop = store.createProject("shop");
    store.updateProject(shop.id, { edgeHost: "shop.127.0.0.1.sslip.io" });
    const t = setup(store, { lbAfter: 1, rolloutFail: "nbo-edge" });
    await expect(t.installer.installEdge({ clusterId: id, admin, confirmBilling: true })).rejects.toThrow(
      /the edge pods did not become ready: [\s\S]*progress deadline/,
    );
    expect(store.getServerSettings()).toMatchObject({ edgeClusterId: "", edgeAddress: "" });
    expect(store.getProject(shop.id).edgeHost).toBe("shop.127.0.0.1.sslip.io");
    expect(t.reconciles()).toBe(0);
    const rollout = t.calls.find((c) => c.args.includes("rollout"))!;
    expect(rollout.args.slice(-4)).toEqual(["rollout", "status", "deployment/nbo-edge", "--timeout=600s"]);
  });

  it("keeps a project on its old host when the new default collides with an existing domain", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    store.updateServerSettings({ baseDomain: "example.com" });
    const owner = store.createProject("owner");
    store.addDomain(owner.id, "shop.example.com", "custom");
    const shop = store.createProject("shop");
    store.updateProject(shop.id, { edgeHost: "shop.127.0.0.1.sslip.io" });
    store.addDomain(shop.id, "shop.127.0.0.1.sslip.io", "default");
    const blog = store.createProject("blog");
    store.updateProject(blog.id, { edgeHost: "blog.127.0.0.1.sslip.io" });
    const t = setup(store, { lbAfter: 1 });
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });

    expect(store.getProject(shop.id).edgeHost).toBe("shop.127.0.0.1.sslip.io");
    expect(store.listDomains(shop.id).map((d) => d.host)).toEqual(["shop.127.0.0.1.sslip.io"]);
    expect(store.listDomains(owner.id).map((d) => d.host)).toEqual(["shop.example.com"]);
    expect(store.getProject(blog.id).edgeHost).toBe("blog.example.com");
    expect(store.listDomains(blog.id).map((d) => [d.host, d.kind])).toEqual([["blog.example.com", "default"]]);
  });

  it("moves projects on the previous edge's default host when the edge moves", async () => {
    const store = await openStore();
    const first = addCluster(store, "edge");
    const second = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: first, edgeAddress: "34.9.9.9" });
    const shop = store.createProject("shop");
    store.updateProject(shop.id, { edgeHost: "shop.34-9-9-9.sslip.io" });
    store.addDomain(shop.id, "shop.34-9-9-9.sslip.io", "default");
    const t = setup(store, { lbAfter: 1 });
    await t.installer.installEdge({ clusterId: second, admin, confirmBilling: true });
    expect(store.getProject(shop.id).edgeHost).toBe("shop.34-1-2-3.sslip.io");
    expect(store.listDomains(shop.id).map((d) => d.host)).toEqual(["shop.34-1-2-3.sslip.io"]);
  });

  it("refuses another cluster while a custom domain is on the edge", async () => {
    const store = await openStore();
    const first = addCluster(store, "edge");
    const second = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: first, edgeAddress: "34.1.2.3" });
    const p = store.createProject("shop");
    store.addDomain(p.id, "www.shop.example", "custom");
    const t = setup(store);
    const err = await t.installer
      .installEdge({ clusterId: second, admin, confirmBilling: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrConflict);
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
    // The same cluster is still fine.
    await t.installer.installEdge({ clusterId: first, admin, confirmBilling: true });
    expect(store.getServerSettings().edgeClusterId).toBe(first);
  });

  it("lets the edge move while the only custom domains are served by Cloud Run", async () => {
    const store = await openStore();
    const first = addCluster(store, "edge");
    const second = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: first, edgeAddress: "34.1.2.3" });
    const p = store.createProject("shop");
    store.addDomain(p.id, "www.shop.example", "custom", "cloudrun");
    expect(() =>
      setup(store).installer.validateInstall({ clusterId: second, admin, confirmBilling: true }),
    ).not.toThrow();
  });

  it("gives up after 10 minutes without an address and saves nothing", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const t = setup(store, { lbAfter: 1_000 });
    await expect(t.installer.installEdge({ clusterId: id, admin, confirmBilling: true })).rejects.toThrow(/address/);
    expect(t.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10 * 60_000);
    expect(t.sleeps.length).toBeGreaterThanOrEqual(59);
    expect(store.getServerSettings().edgeClusterId).toBe("");
    expect(t.reconciles()).toBe(0);
  });

  it("keeps the kubeconfig and registry password out of errors", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const failing: CommandRunner = async (cmd, args) => {
      if (cmd === "kubectl" && args.join(" ").endsWith("apply -f -"))
        throw new Error("apply failed: edge-KUBECONFIG REGISTRY-PW");
      return "";
    };
    const installer = createEdgeInstaller({
      store,
      kubeConnect: fakeKubeConnect(store),
      run: failing,
      buildEdgeImage: async () => "nbo-edge:x",
      reconcile: async () => {},
      pushTable: async () => {},
      sleep: async () => {},
    });
    const err = (await installer
      .installEdge({ clusterId: id, admin, confirmBilling: true })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("apply failed");
    expect(err.message).not.toContain("edge-KUBECONFIG");
    expect(err.message).not.toContain("REGISTRY-PW");
  });
});

describe("network policies of projects already on the cluster", () => {
  it("re-applies them with the cluster's kubeconfig once the edge is ready, before traffic is routed", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const other = addCluster(store, "other");
    const shop = liveEnv(store, "shop", id);
    liveEnv(store, "elsewhere", other);
    const fresh = store.createProject("fresh");
    store.createEnvironment(fresh.id, "k8s", "kubernetes", JSON.stringify({ clusterId: id }));
    const t = setup(store, { lbAfter: 1 });
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });

    expect(t.events.slice(-3)).toEqual(["ready nbo-edge", `apply policies ${shop.ns}`, "reconcile"]);
    expect(t.events.filter((e) => e.startsWith("apply policies"))).toHaveLength(1);
    const applied = t.calls.find((c) => c.input?.includes("nbo-default-deny-ingress"))!;
    expect(applied.kubeconfig).toBe("edge-KUBECONFIG");
    expect(applied.args.slice(applied.args.indexOf("-n"), applied.args.indexOf("-n") + 2)).toEqual(["-n", shop.ns]);
    expect(applied.input).toContain(`name: ${shop.app}-from-edge`);
    expect(applied.input).toContain("kubernetes.io/metadata.name: nbo-edge");
  });

  it("re-applies them on a reinstall too", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    store.updateServerSettings({ edgeClusterId: id, edgeAddress: "34.1.2.3" });
    const shop = liveEnv(store, "shop", id);
    const t = setup(store, { lbAfter: 1, routes: "present" });
    await t.installer.reinstallEdge();
    expect(t.events).toContain(`apply policies ${shop.ns}`);
  });

  it("re-applies them on the relay's cluster once the relay is ready, before it is saved as ready", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    liveEnv(store, "onedge", edge);
    const shop = liveEnv(store, "shop", other);
    const t = setup(store, { lbAfter: 1 });
    await t.installer.enableRelay({ clusterId: other, confirmBilling: true });
    expect(t.events.slice(-3)).toEqual(["ready nbo-relay", `apply policies ${shop.ns}`, "reconcile"]);
    expect(t.calls.find((c) => c.input?.includes("nbo-default-deny-ingress"))!.kubeconfig).toBe("other-KUBECONFIG");
  });

  it("carries on past a project that fails, naming it in the last step without the kubeconfig", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const bad = liveEnv(store, "bad", id);
    const good = liveEnv(store, "good", id);
    const t = setup(store, { lbAfter: 1, policyFail: bad.ns });
    const steps: string[] = [];
    const status = await t.installer.installEdge(
      { clusterId: id, admin, confirmBilling: true },
      { onStep: (s) => steps.push(s) },
    );
    expect(status.installed).toBe(true);
    expect(t.events).toContain(`apply policies ${good.ns}`);
    expect(t.reconciles()).toBe(1);
    expect(steps.at(-1)).toContain("bad");
    expect(steps.at(-1)).not.toContain("good");
    expect(steps.join(" ")).not.toContain("edge-KUBECONFIG");
  });

  it("does the same for a relay", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    const bad = liveEnv(store, "bad", other);
    const t = setup(store, { lbAfter: 1, policyFail: bad.ns });
    const steps: string[] = [];
    const status = await t.installer.enableRelay(
      { clusterId: other, confirmBilling: true },
      { onStep: (s) => steps.push(s) },
    );
    expect(status.status).toBe("ready");
    expect(steps.at(-1)).toContain("bad");
  });
});

describe("edge version", () => {
  it("is recorded by install and by reinstall", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    const t = setup(store);
    expect(store.getServerSettings().edgeVersion).toBe("");
    await t.installer.installEdge({ clusterId: id, admin, confirmBilling: true });
    expect(store.getServerSettings().edgeVersion).toBe(EDGE_VERSION);
    store.updateServerSettings({ edgeVersion: "1" });
    const t2 = setup(store, { lbAfter: 1, routes: "present" });
    await t2.installer.reinstallEdge();
    expect(store.getServerSettings().edgeVersion).toBe(EDGE_VERSION);
  });
});

describe("reinstallEdge and edgeStatus", () => {
  it("reports not installed before any install", async () => {
    const store = await openStore();
    const t = setup(store);
    expect(await t.installer.edgeStatus()).toEqual({
      installed: false,
      clusterId: "",
      address: "",
      ready: 0,
      desired: 0,
    });
    await expect(t.installer.reinstallEdge()).rejects.toBeInstanceOf(ErrInvalid);
  });

  it("re-applies image and manifests with the scoped token only", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    store.updateServerSettings({ edgeClusterId: id, edgeAddress: "34.1.2.3" });
    store.setServerSecret("edge_drain_token", "b".repeat(64));
    const t = setup(store, { lbAfter: 1, routes: "present" });
    const status = await t.installer.reinstallEdge();
    expect(t.events).not.toContain("updateSetup");
    expect(t.events).toEqual([
      "build",
      "docker login",
      "docker tag",
      "docker push",
      "apply pull-secret",
      "apply admin-secret",
      "apply nbo-edge",
      "get routes",
      "poll nbo-edge",
      "ready nbo-edge",
      "reconcile",
    ]);
    expect(status).toEqual({ installed: true, clusterId: id, address: "34.1.2.3", ready: 1, desired: 2 });
    expect(store.getServerSecret("edge_drain_token")).toBe("b".repeat(64));
  });

  it("reports a status error without failing", async () => {
    const store = await openStore();
    const id = addCluster(store, "edge");
    store.updateServerSettings({ edgeClusterId: id, edgeAddress: "34.1.2.3" });
    const installer = createEdgeInstaller({
      store,
      kubeConnect: fakeKubeConnect(store),
      run: async () => {
        throw new Error('Error from server (NotFound): deployments.apps "nbo-edge" not found edge-KUBECONFIG');
      },
      buildEdgeImage: async () => "nbo-edge:x",
      reconcile: async () => {},
      pushTable: async () => {},
      sleep: async () => {},
    });
    const status = await installer.edgeStatus();
    expect(status).toMatchObject({ installed: true, clusterId: id, address: "34.1.2.3", ready: 0, desired: 0 });
    expect(status.error).toContain("NotFound");
    expect(status.error).not.toContain("edge-KUBECONFIG");
  });
});

describe("enableRelay", () => {
  it("refuses without confirmation and on the edge cluster", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    const t = setup(store);
    await expect(
      t.installer.enableRelay({ clusterId: addCluster(store, "other"), confirmBilling: false }),
    ).rejects.toThrow("confirm the load balancer first");
    await expect(t.installer.enableRelay({ clusterId: edge, confirmBilling: true })).rejects.toBeInstanceOf(ErrInvalid);
    expect(t.calls).toEqual([]);
  });

  it("applies the relay with a placeholder cert, issues the CA for its address, restarts it and saves it", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    const t = setup(store);
    const status = await t.installer.enableRelay({ clusterId: other, confirmBilling: true });

    expect(t.events).toEqual([
      "check setup",
      "build",
      "docker login",
      "docker tag",
      "docker push",
      "apply pull-secret",
      "apply relay-secrets",
      "apply nbo-relay",
      "poll nbo-relay",
      "poll nbo-relay",
      "apply relay-secrets",
      "restart relay",
      "ready nbo-relay",
      "reconcile",
    ]);
    for (const c of t.calls.filter((c) => c.cmd === "kubectl")) expect(c.args).toContain("--kubeconfig");

    const relay = store.getRelay(other)!;
    expect(relay).toMatchObject({ clusterId: other, address: "35.9.9.9", status: "ready" });
    expect(relay.token).toMatch(/^[0-9a-f]{64}$/);
    const cert = new X509Certificate(relay.certPem);
    expect(cert.checkIP("35.9.9.9")).toBe("35.9.9.9");
    expect(cert.verify(new X509Certificate(relay.caPem).publicKey)).toBe(true);
    // The second secrets apply carries the real certificate.
    const secretApplies = t.calls.filter((c) => c.input?.includes("kubernetes.io/tls"));
    expect(secretApplies[1]!.input).toContain(Buffer.from(relay.certPem).toString("base64"));
    expect(secretApplies[0]!.input).not.toContain(Buffer.from(relay.certPem).toString("base64"));
    expect(status).toEqual({ clusterId: other, address: "35.9.9.9", status: "ready" });
  });

  it("re-enabling keeps the token and rotates the CA without a placeholder", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    const t1 = setup(store, { lbAfter: 1 });
    await t1.installer.enableRelay({ clusterId: other, confirmBilling: true });
    const before = store.getRelay(other)!;
    const t2 = setup(store, { lbAfter: 1 });
    await t2.installer.enableRelay({ clusterId: other, confirmBilling: true });
    const after = store.getRelay(other)!;
    expect(after.token).toBe(before.token);
    expect(after.caPem).not.toBe(before.caPem);
    expect(t2.events.filter((e) => e === "apply relay-secrets")).toHaveLength(1);
  });

  it("re-enabling pins both CAs on the edge until the restarted relay is ready, then only the new one", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    await setup(store, { lbAfter: 1 }).installer.enableRelay({ clusterId: other, confirmBilling: true });
    const before = store.getRelay(other)!;
    const pinned: string[] = [];
    const t = setup(store, { lbAfter: 1 }, () => pinned.push(store.getRelay(other)!.caPem));
    await t.installer.enableRelay({ clusterId: other, confirmBilling: true });
    const after = store.getRelay(other)!;
    expect(t.events).toEqual([
      "check setup",
      "build",
      "docker login",
      "docker tag",
      "docker push",
      "apply pull-secret",
      "apply nbo-relay",
      "poll nbo-relay",
      "push table",
      "wait 11000",
      "apply relay-secrets",
      "restart relay",
      "ready nbo-relay",
      "reconcile",
    ]);
    expect(pinned).toHaveLength(2);
    expect(pinned[0]).toContain(before.caPem.trim());
    expect(pinned[0]).toContain(after.caPem.trim());
    expect(pinned[1]).toBe(after.caPem);
    expect(after.status).toBe("ready");
  });

  it("aborts a rotation when the CA bundle can't be written: relay and its certificate stay as they were", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    await setup(store, { lbAfter: 1 }).installer.enableRelay({ clusterId: other, confirmBilling: true });
    const before = store.getRelay(other)!;
    const t = setup(store, { lbAfter: 1, pushFails: true });
    await expect(t.installer.enableRelay({ clusterId: other, confirmBilling: true })).rejects.toThrow(
      /connection refused/,
    );
    expect(t.events).not.toContain("apply relay-secrets");
    expect(t.events).not.toContain("restart relay");
    expect(t.sleeps.filter((ms) => ms !== 10_000)).toEqual([]);
    expect(store.getRelay(other)).toMatchObject({
      caPem: before.caPem,
      certPem: before.certPem,
      keyPem: before.keyPem,
      caKeyPem: before.caKeyPem,
      status: "ready",
    });
  });

  it("re-enabling with no edge installed has no table to write and rotates at once", async () => {
    const store = await openStore();
    const other = addCluster(store, "other");
    await setup(store, { lbAfter: 1 }).installer.enableRelay({ clusterId: other, confirmBilling: true });
    const t = setup(store, { lbAfter: 1, pushFails: true });
    await t.installer.enableRelay({ clusterId: other, confirmBilling: true });
    expect(t.events).not.toContain("push table");
    expect(t.events).toContain("restart relay");
  });

  it("saves no relay and does not reconcile when the restarted relay never becomes ready", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    const t = setup(store, { lbAfter: 1, rolloutFail: "nbo-relay" });
    await expect(t.installer.enableRelay({ clusterId: other, confirmBilling: true })).rejects.toThrow(
      /relay pods did not become ready: [\s\S]*progress deadline/,
    );
    expect(store.getRelay(other)).toBeNull();
    expect(t.reconciles()).toBe(0);
  });

  it("refuses a cluster whose setup is out of date before building anything", async () => {
    const store = await openStore();
    const edge = addCluster(store, "edge");
    const other = addCluster(store, "other");
    store.updateServerSettings({ edgeClusterId: edge, edgeAddress: "34.1.2.3" });
    const t = setup(store, { setupVersion: "1" });
    const err = (await t.installer
      .enableRelay({ clusterId: other, confirmBilling: true })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ErrInvalid);
    expect(err.message).toBe("Cluster setup is out of date — update it (needs admin credentials)");
    expect(t.events).toEqual(["check setup"]);
    // A forbidden read (setups before version 2) counts as out of date too.
    const forbidden = createEdgeInstaller({
      store,
      kubeConnect: fakeKubeConnect(store),
      run: async (_c, args) => {
        if (args.join(" ").includes("validatingadmissionpolicy"))
          throw new Error(
            'Error from server (Forbidden): validatingadmissionpolicies "nbo-namespace-guard" is forbidden',
          );
        throw new Error("unexpected");
      },
      buildEdgeImage: async () => "nbo-edge:x",
      reconcile: async () => {},
      pushTable: async () => {},
      sleep: async () => {},
    });
    await expect(forbidden.enableRelay({ clusterId: other, confirmBilling: true })).rejects.toThrow(
      "Cluster setup is out of date",
    );
  });
});

describe("ErrConflict", () => {
  it("maps to 409", async () => {
    const { statusForStoreError } = await import("../../http/handlers.js");
    expect(statusForStoreError(new ErrConflict("x"))).toBe(409);
  });
});
