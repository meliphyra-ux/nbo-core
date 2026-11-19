// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EDGE_VERSION } from "../../edge/edge-manifests.js";
import type { CommandRunner } from "@nbo/deploy";
import type { Store } from "../../store/store.js";
import type { EdgeInstaller, EdgeStatus } from "../../edge/edge-install.js";
import type { Resolver } from "../dns-check.js";
import type { RouteTable } from "../../edge/edge-manifests.js";
import { certSecretName } from "../../edge/edge-manifests.js";
import { ErrInvalid } from "../../store/errors.js";
import { statusForStoreError } from "../../http/handlers.js";
import { createRelayCa } from "../../edge/relay-ca.js";
import { domainUrlFor, stageUrlFor, wireV2 } from "../../v2.js";
import {
  recordFor,
  isApex,
  rootDomainOf,
  deployToCloudRunFirstMessage,
  confirmGapMessage,
  unsupportedRegionMessage,
} from "../domain-routes.js";
import { edgeClusterGoneMessage, noEmailMessage } from "../certs.js";
import type { MappingState, MappingTarget } from "../cloudrun-domains.js";
import { renderDesiredTable } from "../../edge/edge-table.js";
import { transferConfig } from "../../deploys/transfer.js";
import { fakeCloudSetup, fakeDeploymentTrigger, fakeKubeConnect } from "../../testing.js";
import { startHarness, deployedProject, type Harness } from "../../__tests__/v2-harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

// fakeKubectl keeps the edge cluster's route table ConfigMap and records
// every call (the cert Secret deletes among them).
function fakeKubectl() {
  const calls: Call[] = [];
  const failDelete = new Set<string>();
  let rv = 1;
  let data = JSON.stringify({ version: 1, targets: {}, challenges: {} });
  const run: CommandRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, input: o?.input });
    const line = args.join(" ");
    if (line.includes("get configmap nbo-edge-routes -o json")) {
      return JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "nbo-edge-routes", namespace: "nbo-edge", resourceVersion: String(rv++) },
        data: { "routes.json": data },
      });
    }
    if (line.includes("replace -f -")) {
      data = (JSON.parse(o!.input!) as { data: Record<string, string> }).data["routes.json"]!;
      return "";
    }
    if (line.includes("delete secret")) {
      if ([...failDelete].some((name) => line.includes(name))) throw new Error("kubectl failed");
      return "";
    }
    if (line.includes("apply -f -")) return "";
    throw new Error(`unexpected ${cmd} ${line}`);
  };
  return { run, calls, failDelete, table: (): RouteTable => JSON.parse(data) as RouteTable };
}

// The DNS answers nothing, so a checked domain stays dns_pending.
const silentResolver: Resolver = { resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [] };

const relayToken = "RELAY-TOKEN-0123456789abcdef";

function fakeInstaller(store: () => Store) {
  const calls: unknown[][] = [];
  // gate holds a job open until released; fail makes the long work throw.
  const ctl: { gate: Promise<void> | null; fail: Error | null } = { gate: null, fail: null };
  const work = async (onStep?: (s: string) => void) => {
    onStep?.("Building the edge image");
    if (ctl.gate) await ctl.gate;
    if (ctl.fail) throw ctl.fail;
  };
  const status = async (): Promise<EdgeStatus> => {
    const s = store().getServerSettings();
    return {
      installed: s.edgeClusterId !== "",
      clusterId: s.edgeClusterId,
      address: s.edgeAddress,
      ready: 2,
      desired: 2,
    };
  };
  const installer: EdgeInstaller = {
    validateInstall(req) {
      if (req.confirmBilling !== true) throw new ErrInvalid("confirm the load balancer first");
    },
    validateReinstall() {
      if (!store().getServerSettings().edgeClusterId) throw new ErrInvalid("install the edge first");
    },
    async validateRelay(req) {
      if (req.clusterId === store().getServerSettings().edgeClusterId)
        throw new ErrInvalid("the edge cluster needs no relay");
    },
    async installEdge(req, opts) {
      calls.push(["install", req]);
      await work(opts?.onStep);
      store().updateServerSettings({ edgeClusterId: req.clusterId, edgeAddress: "34.1.2.3" });
      return status();
    },
    async reinstallEdge(opts) {
      calls.push(["reinstall"]);
      await work(opts?.onStep);
      return status();
    },
    edgeStatus: status,
    async enableRelay(req, opts) {
      calls.push(["relay", req]);
      await work(opts?.onStep);
      const ca = await createRelayCa(["35.9.9.9"]);
      store().saveRelay({
        clusterId: req.clusterId,
        address: "35.9.9.9",
        caPem: ca.caPem,
        token: relayToken,
        caKeyPem: ca.caKeyPem,
        certPem: ca.certPem,
        keyPem: ca.keyPem,
        status: "ready",
      });
      return { clusterId: req.clusterId, address: "35.9.9.9", status: "ready" };
    },
  };
  return { installer, calls, ctl };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

function connect(store: Store, name: string): string {
  return store.saveKubernetesConnection(
    { name, server: `https://${name}.example:6443`, registry: { kind: "custom", server: "ghcr.io", username: "me" } },
    { kubeconfig: `${name}-kubeconfig` },
  ).id;
}

async function production() {
  const kubectl = fakeKubectl();
  // eslint-disable-next-line prefer-const -- the installer closure reads h before startHarness assigns it
  let h!: Harness;
  const inst = fakeInstaller(() => h.store);
  const kube = { current: null as ReturnType<typeof fakeKubeConnect> | null };
  h = await startHarness({
    mode: "production",
    v2: {
      run: kubectl.run,
      resolver: silentResolver,
      edgeInstaller: inst.installer,
      // The fake is bound to the harness's store once it exists.
      kubeConnect: {
        detect: (...a) => kube.current!.detect(...a),
        connect: (...a) => kube.current!.connect(...a),
        test: (...a) => kube.current!.test(...a),
        updateSetup: (...a) => kube.current!.updateSetup(...a),
        plan: () => kube.current!.plan(),
      },
    },
  });
  const store = h.store;
  kube.current = fakeKubeConnect(store);
  harnesses.push(h);
  const edgeId = connect(h.store, "edge");
  return { h, kubectl, inst, edgeId };
}

// productionWithEdge: an installed edge on cluster "edge" at 34.1.2.3.
async function productionWithEdge() {
  const p = await production();
  p.h.store.updateServerSettings({ edgeClusterId: p.edgeId, edgeAddress: "34.1.2.3" });
  return p;
}

const admin = { kind: "kubeconfig", kubeconfig: "ADMIN-KUBECONFIG-SECRET" };

describe("error mapping", () => {
  it("maps ErrInvalid to 400", () => {
    expect(statusForStoreError(new ErrInvalid("bad"))).toBe(400);
  });
});

describe("wiring", () => {
  it("wireV2 creates the edge installer when none is injected", async () => {
    const h = await startHarness();
    harnesses.push(h);
    const v2 = wireV2(h.store, {
      deploymentTrigger: fakeDeploymentTrigger(h.store),
      cloudSetup: fakeCloudSetup(),
      edgeAdminUrl: "http://127.0.0.1:1",
      edgePublicPort: 9443,
    });
    expect(typeof v2.edgeInstaller.installEdge).toBe("function");
  });
});

describe("dev mode", () => {
  it("keeps the http://<host>:<port> address and refuses domains and the edge", async () => {
    const h = await startHarness();
    harnesses.push(h);
    const id = await deployedProject(h);
    const summary = await h.call("GET", `/projects/${id}/summary`);
    expect(summary.json.domainUrl).toBe("http://storefront.127.0.0.1.sslip.io:9443");
    expect((await h.call("GET", `/projects/${id}/traffic`)).json.domainUrl).toBe(
      "http://storefront.127.0.0.1.sslip.io:9443",
    );
    const add = await h.call("POST", `/projects/${id}/domains`, { host: "shop.acme.com" });
    expect(add.status).toBe(409);
    expect(add.json.error).toBe("Domains need the public edge (production mode)");
    const edge = await h.call("GET", "/system/edge");
    expect(edge.status).toBe(200);
    expect(edge.json).toMatchObject({
      installed: false,
      mode: "dev",
      settings: { baseDomain: "", acmeDirectory: "production" },
    });
    expect(
      (await h.call("POST", "/system/edge/install", { clusterId: "kc_x", admin, confirmBilling: true })).status,
    ).toBe(409);
  });
});

describe("a project's address in production before an edge is installed", () => {
  async function liveAt(url: string) {
    const { h, edgeId } = await production();
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const env = h.store.listEnvironments(id)[0]!;
    const dep = h.store.createDeployment(env.id);
    h.store.completeDeployment(dep.id, "sha256:live", url);
    return (await h.call("GET", `/projects/${id}/summary`)).json.domainUrl as string;
  }

  it("is the cloud's own public address", async () => {
    expect(await liveAt("https://shop-abc123-uc.a.run.app")).toBe("https://shop-abc123-uc.a.run.app");
  });

  it("is empty when the app is only reachable inside its cluster", async () => {
    expect(await liveAt("http://shop.nbo-p-abc.svc.cluster.local:8080")).toBe("");
  });
});

describe("edge routes", () => {
  it("GET /system/edge reports the installer's status, mode and settings", async () => {
    const { h, edgeId } = await productionWithEdge();
    const res = await h.call("GET", "/system/edge");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      installed: true,
      clusterId: edgeId,
      address: "34.1.2.3",
      ready: 2,
      desired: 2,
      mode: "production",
      settings: {
        baseDomain: "",
        acmeEmail: "",
        acmeDirectory: "production",
        edgeClusterId: edgeId,
        edgeAddress: "34.1.2.3",
        edgeVersion: "",
        cloudflareRanges: "",
        envValues: "stored",
      },
    });
  });

  it("install validates synchronously, then runs as a background job", async () => {
    const { h, inst, edgeId } = await production();
    expect((await h.call("POST", "/system/edge/install", { clusterId: edgeId, admin })).status).toBe(400);
    expect(
      (await h.call("POST", "/system/edge/install", { clusterId: edgeId, admin, confirmBilling: true, extra: 1 }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.call("POST", "/system/edge/install", {
          clusterId: edgeId,
          admin: { kind: "nope" },
          confirmBilling: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.call("POST", "/system/edge/install", { clusterId: "kc_missing", admin, confirmBilling: true })).status,
    ).toBe(404);
    expect(inst.calls).toEqual([]);
    const gate = deferred();
    inst.ctl.gate = gate.promise;
    const res = await h.call("POST", "/system/edge/install", { clusterId: edgeId, admin, confirmBilling: true });
    expect(res.status).toBe(202);
    expect(res.json.job).toMatchObject({ kind: "install", status: "running" });
    expect(typeof res.json.job.id).toBe("string");
    const running = (await h.call("GET", "/system/edge")).json;
    expect(running.job).toMatchObject({
      id: res.json.job.id,
      kind: "install",
      status: "running",
      step: "Building the edge image",
    });
    expect(typeof running.job.startedAt).toBe("string");
    // One edge job at a time (install or reinstall).
    const second = await h.call("POST", "/system/edge/install", { clusterId: edgeId, admin, confirmBilling: true });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("An edge install is already running");
    expect((await h.call("POST", "/system/edge/reinstall")).json.error).toBe("An edge install is already running");
    gate.release();
    await h.v2.edgeJobs.settled();
    const done = (await h.call("GET", "/system/edge")).json;
    expect(done).toMatchObject({
      installed: true,
      clusterId: edgeId,
      address: "34.1.2.3",
      job: { kind: "install", status: "succeeded" },
    });
    expect(typeof done.job.finishedAt).toBe("string");
    expect(inst.calls).toEqual([
      [
        "install",
        {
          clusterId: edgeId,
          admin: { kind: "kubeconfig", kubeconfig: "ADMIN-KUBECONFIG-SECRET" },
          confirmBilling: true,
        },
      ],
    ]);
    expect(res.text).not.toContain("ADMIN-KUBECONFIG-SECRET");
  });

  it("a failed install is recorded on the job without the admin credentials", async () => {
    const { h, inst, edgeId } = await production();
    inst.ctl.fail = new Error("kubectl failed: token ADMIN-KUBECONFIG-SECRET rejected");
    expect(
      (await h.call("POST", "/system/edge/install", { clusterId: edgeId, admin, confirmBilling: true })).status,
    ).toBe(202);
    await h.v2.edgeJobs.settled();
    const res = await h.call("GET", "/system/edge");
    expect(res.json.job).toMatchObject({ kind: "install", status: "failed" });
    expect(res.json.job.error).toContain("kubectl failed");
    expect(res.text).not.toContain("ADMIN-KUBECONFIG-SECRET");
  });

  it("a job left running by an earlier process reads as interrupted", async () => {
    const { h } = await productionWithEdge();
    h.store.setEdgeJob("edge", {
      id: "job_old",
      kind: "reinstall",
      status: "running",
      startedAt: "2026-11-04T00:00:00.000Z",
    });
    const res = await h.call("GET", "/system/edge");
    expect(res.json.job).toMatchObject({
      id: "job_old",
      status: "failed",
      error: "interrupted: the control-plane restarted",
    });
    expect(typeof res.json.job.finishedAt).toBe("string");
  });

  it("reinstall runs as a job and refuses before an install", async () => {
    const { h, inst, edgeId } = await production();
    expect((await h.call("POST", "/system/edge/reinstall")).status).toBe(400);
    expect(inst.calls).toEqual([]);
    h.store.updateServerSettings({ edgeClusterId: edgeId, edgeAddress: "34.1.2.3" });
    const res = await h.call("POST", "/system/edge/reinstall");
    expect(res.status).toBe(202);
    expect(res.json.job).toMatchObject({ kind: "reinstall", status: "running" });
    await h.v2.edgeJobs.settled();
    expect((await h.call("GET", "/system/edge")).json.job.status).toBe("succeeded");
    expect(inst.calls).toEqual([["reinstall"]]);
  });

  it("update-setup re-runs the cluster setup with admin credentials", async () => {
    const { h, edgeId } = await production();
    expect((await h.call("POST", "/system/clusters/kc_missing/update-setup", { admin })).status).toBe(404);
    expect((await h.call("POST", `/system/clusters/${edgeId}/update-setup`, {})).status).toBe(400);
    const res = await h.call("POST", `/system/clusters/${edgeId}/update-setup`, { admin });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: edgeId, name: "edge" });
    expect(res.text).not.toContain("ADMIN-KUBECONFIG-SECRET");
    expect(res.text).not.toContain("edge-kubeconfig");
  });
});

describe("relay routes", () => {
  it("enables a relay as a background job and reports it without secrets", async () => {
    const { h, inst, edgeId } = await productionWithEdge();
    const other = connect(h.store, "other");
    expect((await h.call("GET", `/system/clusters/${other}/relay`)).json).toEqual({ status: "none", address: "" });
    expect((await h.call("GET", "/system/clusters/kc_missing/relay")).status).toBe(404);
    expect((await h.call("POST", "/system/clusters/kc_missing/relay", { confirmBilling: true })).status).toBe(404);
    expect((await h.call("POST", `/system/clusters/${other}/relay`, {})).status).toBe(400);
    expect((await h.call("POST", `/system/clusters/${other}/relay`, { confirmBilling: true, x: 1 })).status).toBe(400);
    expect((await h.call("POST", `/system/clusters/${edgeId}/relay`, { confirmBilling: true })).status).toBe(400);
    expect(inst.calls).toEqual([]);
    const gate = deferred();
    inst.ctl.gate = gate.promise;
    const res = await h.call("POST", `/system/clusters/${other}/relay`, { confirmBilling: true });
    expect(res.status).toBe(202);
    expect(res.json.job).toMatchObject({ kind: "relay", status: "running" });
    expect((await h.call("GET", `/system/clusters/${other}/relay`)).json).toMatchObject({
      status: "none",
      job: { kind: "relay", status: "running", step: "Building the edge image" },
    });
    const second = await h.call("POST", `/system/clusters/${other}/relay`, { confirmBilling: true });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("Enabling public entry is already running for this cluster");
    gate.release();
    await h.v2.edgeJobs.settled();
    const fp = new X509Certificate(h.store.getRelay(other)!.caPem).fingerprint256;
    const got = await h.call("GET", `/system/clusters/${other}/relay`);
    expect(got.json).toMatchObject({
      status: "ready",
      address: "35.9.9.9",
      caFingerprint: fp,
      job: { kind: "relay", status: "succeeded" },
    });
    expect(Object.keys(got.json).sort()).toEqual(["address", "caFingerprint", "job", "status"]);
    for (const text of [res.text, got.text]) {
      expect(text).not.toContain(relayToken);
      expect(text).not.toContain("PRIVATE KEY");
    }
  });

  it("a failed relay job keeps the relay token out of its error", async () => {
    const { h, inst } = await productionWithEdge();
    const other = connect(h.store, "other");
    const ca = await createRelayCa(["35.9.9.9"]);
    h.store.saveRelay({
      clusterId: other,
      address: "35.9.9.9",
      caPem: ca.caPem,
      token: relayToken,
      caKeyPem: ca.caKeyPem,
      certPem: ca.certPem,
      keyPem: ca.keyPem,
      status: "ready",
    });
    inst.ctl.fail = new Error(`kubectl apply failed: token ${relayToken}`);
    expect((await h.call("POST", `/system/clusters/${other}/relay`, { confirmBilling: true })).status).toBe(202);
    await h.v2.edgeJobs.settled();
    const got = await h.call("GET", `/system/clusters/${other}/relay`);
    expect(got.json.job).toMatchObject({ status: "failed" });
    expect(got.text).not.toContain(relayToken);
  });
});

describe("project domains", () => {
  it("refuses a domain before the edge is installed", async () => {
    const { h, edgeId } = await production();
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const add = await h.call("POST", `/projects/${id}/domains`, { host: "shop.acme.com" });
    expect(add.status).toBe(409);
    expect(add.json.error).toBe("Install the edge first (nbo-server edge install on the server)");
  });

  it("adds, lists, checks and removes a custom domain", async () => {
    const { h, kubectl, edgeId } = await productionWithEdge();
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const other = await deployedProject(h, { name: "blog", clouds: [{ target: "kubernetes", clusterId: edgeId }] });

    expect((await h.call("POST", `/projects/${id}/domains`, { host: "shop.acme.com", extra: true })).status).toBe(400);
    expect((await h.call("POST", `/projects/${id}/domains`, { host: "*.acme.com" })).status).toBe(400);

    const add = await h.call("POST", `/projects/${id}/domains`, { host: "Shop.Acme.com." });
    expect(add.status).toBe(201);
    expect(add.json).toMatchObject({
      host: "shop.acme.com",
      kind: "custom",
      status: "dns_pending",
      record: { type: "A", name: "shop.acme.com", value: "34.1.2.3", data: "34.1.2.3" },
    });
    // Pushed right away: the host routes over HTTP before its certificate.
    expect(Object.keys(kubectl.table().targets)).toContain("shop.acme.com");

    const again = await h.call("POST", `/projects/${id}/domains`, { host: "shop.acme.com" });
    expect(again.status).toBe(409);
    expect((await h.call("POST", `/projects/${other}/domains`, { host: "SHOP.acme.com" })).status).toBe(409);
    // Another project's default host is taken too.
    expect((await h.call("POST", `/projects/${id}/domains`, { host: "blog.34-1-2-3.sslip.io" })).status).toBe(409);

    const list = await h.call("GET", `/projects/${id}/domains`);
    expect(list.status).toBe(200);
    expect(list.json.edgeAddress).toBe("34.1.2.3");
    expect(list.json.domains.map((d: { host: string; kind: string }) => [d.host, d.kind])).toEqual([
      ["storefront.34-1-2-3.sslip.io", "default"],
      ["shop.acme.com", "custom"],
    ]);
    const defaultId = list.json.domains[0].id as string;
    const customId = add.json.id as string;

    const check = await h.call("POST", `/projects/${id}/domains/${customId}/check`);
    expect(check.status).toBe(200);
    expect(check.json).toMatchObject({ id: customId, status: "dns_pending", record: { type: "A" } });
    expect(check.json.lastError).toMatch(/does not point at the edge/);
    expect((await h.call("POST", `/projects/${other}/domains/${customId}/check`)).status).toBe(404);

    const delDefault = await h.call("DELETE", `/projects/${id}/domains/${defaultId}`);
    expect(delDefault.status).toBe(409);
    expect(delDefault.json.error).toBe("The default address can't be removed");
    expect((await h.call("DELETE", `/projects/${other}/domains/${customId}`)).status).toBe(404);

    const del = await h.call("DELETE", `/projects/${id}/domains/${customId}`);
    expect(del.status).toBe(204);
    expect(h.store.listDomains(id).map((d) => d.host)).toEqual(["storefront.34-1-2-3.sslip.io"]);
    expect(
      kubectl.calls.some((c) => c.args.join(" ").includes(`delete secret ${certSecretName("shop.acme.com")}`)),
    ).toBe(true);
    expect(Object.keys(kubectl.table().targets)).not.toContain("shop.acme.com");
  });

  it("gives a CNAME record for an edge with a hostname and AAAA for IPv6", async () => {
    const { h, edgeId } = await productionWithEdge();
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    await h.call("POST", `/projects/${id}/domains`, { host: "shop.acme.com" });
    h.store.updateServerSettings({ edgeAddress: "lb-1.elb.example.com" });
    const cname = (await h.call("GET", `/projects/${id}/domains`)).json.domains[1];
    expect(cname.record).toEqual({
      type: "CNAME",
      name: "shop.acme.com",
      value: "lb-1.elb.example.com",
      data: "lb-1.elb.example.com",
    });
    h.store.updateServerSettings({ edgeAddress: "2001:db8::1" });
    expect((await h.call("GET", `/projects/${id}/domains`)).json.domains[1].record).toEqual({
      type: "AAAA",
      name: "shop.acme.com",
      value: "2001:db8::1",
      data: "2001:db8::1",
    });
  });

  it("summary domainUrl follows the active domains in production", async () => {
    const { h, edgeId } = await productionWithEdge();
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const url = async () => (await h.call("GET", `/projects/${id}/summary`)).json.domainUrl as string;
    expect(await url()).toBe("http://storefront.34-1-2-3.sslip.io");
    const def = h.store.listDomains(id)[0]!;
    h.store.updateDomain(def.id, { status: "active" });
    expect(await url()).toBe("https://storefront.34-1-2-3.sslip.io");
    const custom = (await h.call("POST", `/projects/${id}/domains`, { host: "shop.acme.com" })).json.id as string;
    expect(await url()).toBe("https://storefront.34-1-2-3.sslip.io");
    h.store.updateDomain(custom, { status: "active" });
    expect(await url()).toBe("https://shop.acme.com");
    expect((await h.call("GET", `/projects/${id}/traffic`)).json.domainUrl).toBe("https://shop.acme.com");
  });
});

describe("PATCH /system/domains", () => {
  it("validates the body", async () => {
    const { h } = await productionWithEdge();
    for (const body of [
      { baseDomain: "*.acme.com" },
      { baseDomain: 3 },
      { acmeEmail: "not-an-email" },
      { acmeDirectory: "test" },
      { moveExisting: "yes" },
      { other: 1 },
      [],
    ]) {
      expect((await h.call("PATCH", "/system/domains", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("saves the Let's Encrypt settings", async () => {
    const { h } = await productionWithEdge();
    const res = await h.call("PATCH", "/system/domains", { acmeEmail: "ops@acme.com", acmeDirectory: "staging" });
    expect(res.status).toBe(200);
    expect(res.json.settings).toMatchObject({ acmeEmail: "ops@acme.com", acmeDirectory: "staging", baseDomain: "" });
    expect(h.store.getServerSettings()).toMatchObject({ acmeEmail: "ops@acme.com", acmeDirectory: "staging" });
  });

  it("moves placeholder projects to the base domain; others only with moveExisting, keeping the old host as custom", async () => {
    const { h, kubectl, edgeId } = await production();
    // Created before the edge: still on the placeholder host.
    const early = await deployedProject(h, { name: "early", clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    h.store.updateServerSettings({ edgeClusterId: edgeId, edgeAddress: "34.1.2.3" });
    const late = await deployedProject(h, { name: "late", clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    expect(h.store.getProject(early).edgeHost).toBe("early.127.0.0.1.sslip.io");
    expect(h.store.getProject(late).edgeHost).toBe("late.34-1-2-3.sslip.io");

    const res = await h.call("PATCH", "/system/domains", { baseDomain: "Acme.com." });
    expect(res.status).toBe(200);
    expect(res.json.settings.baseDomain).toBe("acme.com");
    expect(h.store.getProject(early).edgeHost).toBe("early.acme.com");
    expect(h.store.listDomains(early).map((d) => [d.host, d.kind])).toEqual([["early.acme.com", "default"]]);
    expect(h.store.getProject(late).edgeHost).toBe("late.34-1-2-3.sslip.io");
    expect(Object.keys(kubectl.table().targets)).toContain("early.acme.com");

    const moved = await h.call("PATCH", "/system/domains", { baseDomain: "acme.com", moveExisting: true });
    expect(moved.status).toBe(200);
    expect(h.store.getProject(late).edgeHost).toBe("late.acme.com");
    expect(
      h.store
        .listDomains(late)
        .map((d) => [d.host, d.kind])
        .sort(),
    ).toEqual([
      ["late.34-1-2-3.sslip.io", "custom"],
      ["late.acme.com", "default"],
    ]);
    expect(Object.keys(kubectl.table().targets)).toEqual(
      expect.arrayContaining(["late.acme.com", "late.34-1-2-3.sslip.io"]),
    );
    // The second move left early alone (already on its default).
    expect(h.store.listDomains(early).map((d) => [d.host, d.kind])).toEqual([["early.acme.com", "default"]]);
  });

  it("a colliding project stays on its old host", async () => {
    const { h, edgeId } = await productionWithEdge();
    const a = await deployedProject(h, { name: "shop", clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const b = await deployedProject(h, { name: "blog", clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    await h.call("POST", `/projects/${b}/domains`, { host: "shop.acme.com" });
    const res = await h.call("PATCH", "/system/domains", { baseDomain: "acme.com", moveExisting: true });
    expect(res.status).toBe(200);
    expect(h.store.getProject(a).edgeHost).toBe("shop.34-1-2-3.sslip.io");
    expect(h.store.getProject(b).edgeHost).toBe("blog.acme.com");
    expect(res.json.skipped).toEqual([{ projectId: a, host: "shop.acme.com" }]);
  });
});

describe("traffic on a cluster without a public entry", () => {
  const reason =
    "This cluster has no public entry yet. Enable it on the server with: nbo-server cluster relay <cluster id> --confirm-billing";

  it("reports why an environment on a relay-less cluster can't take traffic", async () => {
    const { h, inst, edgeId } = await productionWithEdge();
    const other = connect(h.store, "other");
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const add = await h.call("POST", `/projects/${id}/environments/add`, { target: "kubernetes", clusterId: other });
    expect(add.status).toBe(201);
    const dep = h.store.createDeployment(add.json.id);
    h.store.completeDeployment(dep.id, "sha256:fake", "http://app.nbo-p-1.svc.cluster.local:8080");

    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    const byCluster = (c: string) => summary.environments.find((e: { clusterId: string }) => e.clusterId === c);
    expect(byCluster(edgeId).cannotTakeTrafficReason).toBeNull();
    expect(byCluster(other).cannotTakeTrafficReason).toBe(reason);
    expect(byCluster(other).canTakeTraffic).toBe(false);
    const traffic = (await h.call("GET", `/projects/${id}/traffic`)).json;
    expect(traffic.environments).toEqual(
      expect.arrayContaining([
        { id: byCluster(edgeId).id, cannotTakeTrafficReason: null },
        { id: byCluster(other).id, cannotTakeTrafficReason: reason },
      ]),
    );
    const put = await h.call("PUT", `/projects/${id}/traffic`, {
      weights: { [byCluster(edgeId).id]: 50, [byCluster(other).id]: 50 },
    });
    expect(put.status).toBe(400);
    expect(put.json.error).toContain(reason);

    await inst.installer.enableRelay({ clusterId: other, confirmBilling: true });
    const after = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(
      after.environments.find((e: { clusterId: string }) => e.clusterId === other).cannotTakeTrafficReason,
    ).toBeNull();
  });

  it("reports no reason in dev mode", async () => {
    const h = await startHarness();
    harnesses.push(h);
    const id = await deployedProject(h);
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(summary.environments[0].cannotTakeTrafficReason).toBeNull();
  });
});

describe("DNS records for apex domains", () => {
  const note = "Use an ALIAS/ANAME record (or your DNS provider's flattened CNAME); a domain's apex can't use CNAME.";
  it("an apex on a hostname-only edge gets an ALIAS with a note; subdomains get a CNAME", () => {
    const lb = "lb-1.elb.example.com";
    expect(recordFor("acme.com", lb)).toEqual({ type: "ALIAS", name: "acme.com", value: lb, data: lb, note });
    expect(recordFor("acme.co.uk", lb)).toEqual({ type: "ALIAS", name: "acme.co.uk", value: lb, data: lb, note });
    expect(recordFor("shop.acme.com", lb)).toEqual({ type: "CNAME", name: "shop.acme.com", value: lb, data: lb });
    expect(recordFor("shop.acme.co.uk", lb)).toEqual({ type: "CNAME", name: "shop.acme.co.uk", value: lb, data: lb });
  });
  it("an apex on an IP edge keeps A/AAAA", () => {
    expect(recordFor("acme.com", "34.1.2.3")).toEqual({
      type: "A",
      name: "acme.com",
      value: "34.1.2.3",
      data: "34.1.2.3",
    });
    expect(recordFor("acme.com", "2001:db8::1")).toEqual({
      type: "AAAA",
      name: "acme.com",
      value: "2001:db8::1",
      data: "2001:db8::1",
    });
  });
});

describe("transfers to a cluster without a public entry", () => {
  const reason =
    "This cluster has no public entry yet. Enable it on the server with: nbo-server cluster relay <cluster id> --confirm-billing";
  const defaultDelay = transferConfig.stepDelayMs;
  afterEach(() => {
    transferConfig.stepDelayMs = defaultDelay;
  });

  it("refuses to start, leaving the weights alone", async () => {
    const { h, edgeId } = await productionWithEdge();
    const other = connect(h.store, "other");
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const before = h.store.listEnvironments(id).map((e) => [e.id, e.trafficWeight]);
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: other });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain(reason);
    expect(h.store.listEnvironments(id).map((e) => [e.id, e.trafficWeight])).toEqual(before);
    expect(h.store.getLatestTransfer(id)).toBeUndefined();
  });

  it("stops a running transfer whose target loses its relay, keeping the last step", async () => {
    transferConfig.stepDelayMs = 300;
    const { h, edgeId } = await productionWithEdge();
    const other = connect(h.store, "other");
    const ca = await createRelayCa(["35.9.9.9"]);
    const relay = {
      clusterId: other,
      address: "35.9.9.9",
      caPem: ca.caPem,
      token: relayToken,
      caKeyPem: ca.caKeyPem,
      certPem: ca.certPem,
      keyPem: ca.keyPem,
      status: "ready",
    };
    h.store.saveRelay(relay);
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes", clusterId: other });
    expect(res.status).toBe(202);
    for (let i = 0; i < 200 && h.store.getTransfer(res.json.id).weight < 1; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(h.store.getTransfer(res.json.id).weight).toBe(1);
    h.store.saveRelay({ ...relay, address: "" });
    await h.v2.transfers.settled(id);
    const t = h.store.getTransfer(res.json.id);
    expect(t.status).toBe("failed");
    expect(t.error).toContain(reason);
    expect(
      h.store
        .listEnvironments(id)
        .map((e) => e.trafficWeight)
        .sort((a, b) => a - b),
    ).toEqual([1, 99]);
  });
});

describe("route table fallback", () => {
  it("serves from the reachable clouds when all traffic points at unreachable ones", async () => {
    const { h, edgeId } = await productionWithEdge();
    const other = connect(h.store, "other");
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const add = await h.call("POST", `/projects/${id}/environments/add`, { target: "kubernetes", clusterId: other });
    const dep = h.store.createDeployment(add.json.id);
    h.store.completeDeployment(dep.id, "sha256:fake", "http://app.nbo-p-1.svc.cluster.local:8080");
    const reachable = h.store.listEnvironments(id).find((e) => e.id !== add.json.id)!;
    h.store.setTrafficWeights(id, { [reachable.id]: 0, [add.json.id]: 100 });
    const table = renderDesiredTable(h.store, { challenges: {} });
    const target = table.targets[h.store.getProject(id).edgeHost]!;
    expect(target.backends.map((b) => [b.id, b.weight])).toEqual([[reachable.id, 100]]);
  });
});

const fx = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`../../__tests__/fixtures/${n}`, import.meta.url)), "utf8");

describe("behind Cloudflare and pasted certificates", () => {
  const host = "shop.example.com";
  // A production harness whose Cloudflare checks and 6 s waits are fakes.
  async function setup(edgeVersion: string = EDGE_VERSION) {
    const kubectl = fakeKubectl();
    // eslint-disable-next-line prefer-const -- the installer closure reads h before startHarness assigns it
    let h!: Harness;
    const inst = fakeInstaller(() => h.store);
    h = await startHarness({
      mode: "production",
      v2: {
        run: kubectl.run,
        resolver: silentResolver,
        edgeInstaller: inst.installer,
        cloudflareReach: async () => ({ ok: true }),
        cloudflareFlexible: async () => "fine",
        sleep: async () => {},
      },
    });
    harnesses.push(h);
    const edgeId = connect(h.store, "edge");
    h.store.updateServerSettings({ edgeClusterId: edgeId, edgeAddress: "34.1.2.3", edgeVersion });
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const add = await h.call("POST", `/projects/${id}/domains`, { host });
    const domainId = add.json.id as string;
    const url = `/projects/${id}/domains/${domainId}`;
    return { h, id, domainId, url, kubectl };
  }
  const keyBody = fx("good.key").split(/\r?\n/)[1]!;

  describe("deleting a project", () => {
    const deletes = (k: ReturnType<typeof fakeKubectl>): string[] =>
      k.calls.map((c) => c.args.join(" ")).filter((l) => l.includes("delete secret"));

    it("removes the certificate Secrets of its domains, after the table stops naming them", async () => {
      const { h, id, url, kubectl } = await setup();
      await h.call("PATCH", url, { behindCloudflare: true });
      await h.call("PUT", `${url}/certificate`, { certPem: fx("good.crt"), keyPem: fx("good.key") });
      const hosts = h.store.listDomains(id).map((d) => d.host);
      expect(hosts).toContain(host);
      kubectl.calls.length = 0;

      expect((await h.call("DELETE", `/projects/${id}`)).status).toBe(204);

      for (const x of hosts) expect(deletes(kubectl).some((l) => l.includes(certSecretName(x)))).toBe(true);
      const lines = kubectl.calls.map((c) => c.args.join(" "));
      const lastReplace = lines.map((l) => l.includes("replace -f -")).lastIndexOf(true);
      const firstDelete = lines.findIndex((l) => l.includes("delete secret"));
      expect(lastReplace).toBeGreaterThan(-1);
      expect(lastReplace).toBeLessThan(firstDelete);
      expect(kubectl.table().targets[host]).toBeUndefined();
    });

    it("still removes the project and the other Secrets when one deletion fails", async () => {
      const { h, id, kubectl } = await setup();
      await h.call("POST", `/projects/${id}/domains`, { host: "blog.example.com" });
      kubectl.failDelete.add(certSecretName(host));
      kubectl.calls.length = 0;

      expect((await h.call("DELETE", `/projects/${id}`)).status).toBe(204);

      expect(h.store.listProjects().some((p) => p.id === id)).toBe(false);
      expect(deletes(kubectl).some((l) => l.includes(certSecretName("blog.example.com")))).toBe(true);
    });

    it("touches no Secret in production before an edge is installed", async () => {
      const { h, kubectl } = await production();
      const p = h.store.createProject("shop");
      h.store.addDomain(p.id, host, "custom");
      expect((await h.call("DELETE", `/projects/${p.id}`)).status).toBe(204);
      expect(deletes(kubectl)).toEqual([]);
    });

    it("touches no Secret in dev mode", async () => {
      const kubectl = fakeKubectl();
      const h = await startHarness({ v2: { run: kubectl.run } });
      harnesses.push(h);
      h.store.updateServerSettings({ edgeClusterId: "kc_x" });
      const p = h.store.createProject("shop");
      h.store.addDomain(p.id, host, "custom");
      expect((await h.call("DELETE", `/projects/${p.id}`)).status).toBe(204);
      expect(deletes(kubectl)).toEqual([]);
    });
  });

  it("turns the switch on and off", async () => {
    const { h, url, domainId } = await setup();
    const on = await h.call("PATCH", url, { behindCloudflare: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ id: domainId, behindCloudflare: true, certSource: "letsencrypt", warning: "" });
    const off = await h.call("PATCH", url, { behindCloudflare: false });
    expect(off.status).toBe(200);
    expect(off.json.behindCloudflare).toBe(false);
  });

  it("rejects a bad body, another project's domain, and an old edge", async () => {
    const { h, id, url } = await setup();
    expect((await h.call("PATCH", url, { behindCloudflare: "yes" })).status).toBe(400);
    expect((await h.call("PATCH", url, {})).status).toBe(400);
    expect((await h.call("PATCH", url, { behindCloudflare: true, extra: 1 })).status).toBe(400);
    const other = await deployedProject(h, {
      name: "blog",
      clouds: [{ target: "kubernetes", clusterId: h.store.getServerSettings().edgeClusterId }],
    });
    expect((await h.call("PATCH", url.replace(id, other), { behindCloudflare: true })).status).toBe(404);
    expect((await h.call("PUT", `${url.replace(id, other)}/certificate`, { certPem: "x", keyPem: "y" })).status).toBe(
      404,
    );
    expect((await h.call("DELETE", `${url.replace(id, other)}/certificate`)).status).toBe(404);
  });

  it("answers 409 on an old edge", async () => {
    const { h, url } = await setup("1");
    const res = await h.call("PATCH", url, { behindCloudflare: true });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Reinstall the edge first");
  });

  it("pastes a certificate, shows no key anywhere, and removes it", async () => {
    const { h, id, url, domainId } = await setup();
    // Turn on first: a certificate needs the switch.
    expect(
      (await h.call("PUT", `${url}/certificate`, { certPem: fx("good.crt"), keyPem: fx("good.key") })).status,
    ).toBe(409);
    await h.call("PATCH", url, { behindCloudflare: true });
    const put = await h.call("PUT", `${url}/certificate`, { certPem: fx("good.crt"), keyPem: fx("good.key") });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ status: "active", certSource: "pasted", behindCloudflare: true });
    expect(put.text).not.toContain(keyBody);
    expect(put.text).not.toContain("PRIVATE KEY");

    const list = await h.call("GET", `/projects/${id}/domains`);
    const row = list.json.domains.find((d: { id: string }) => d.id === domainId);
    expect(row).toMatchObject({ behindCloudflare: true, certSource: "pasted" });
    expect(row).toHaveProperty("warning");
    expect(list.text).not.toContain(keyBody);
    expect(list.text).not.toMatch(/keyPem|PRIVATE KEY/);

    const del = await h.call("DELETE", `${url}/certificate`);
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ status: "dns_pending", certSource: "letsencrypt", behindCloudflare: true });
    // No pasted certificate any more.
    expect((await h.call("DELETE", `${url}/certificate`)).status).toBe(409);
  });

  it("refuses a bad pair with 400 and keeps the key out of the answer and the row", async () => {
    const { h, url, domainId } = await setup();
    await h.call("PATCH", url, { behindCloudflare: true });
    const bad = await h.call("PUT", `${url}/certificate`, { certPem: fx("good.crt"), keyPem: fx("unrelated.key") });
    expect(bad.status).toBe(400);
    const wrongKeyBody = fx("unrelated.key").split(/\r?\n/)[1]!;
    expect(bad.text).not.toContain(wrongKeyBody);
    expect(bad.text).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(h.store.getDomain(domainId))).not.toContain(wrongKeyBody);
    expect((await h.call("PUT", `${url}/certificate`, { certPem: fx("good.crt") })).status).toBe(400);
    expect((await h.call("PUT", `${url}/certificate`, { certPem: 1, keyPem: 2 })).status).toBe(400);
    expect(
      (await h.call("PUT", `${url}/certificate`, { certPem: fx("good.crt"), keyPem: fx("good.key"), x: 1 })).status,
    ).toBe(400);
  });

  it("accepts a 10 KB body", async () => {
    const { h, url } = await setup();
    await h.call("PATCH", url, { behindCloudflare: true });
    const padded = `${fx("good.crt")}
${"# padding ".repeat(1100)}
`;
    expect(padded.length).toBeGreaterThan(10_000);
    const put = await h.call("PUT", `${url}/certificate`, { certPem: padded, keyPem: fx("good.key") });
    expect(put.status, put.text).toBe(200);
  });
});

describe("Cloud Run domains", () => {
  const host = "shop.example.com";
  const records = [{ type: "CNAME", name: "shop", value: "ghs.googlehosted.com.", data: "ghs.googlehosted.com." }];
  const account = "d@g.iam.gserviceaccount.com";

  function fakeCloudRun() {
    const f = {
      createError: null as Error | null,
      removeError: null as Error | null,
      calls: [] as string[],
      api: {
        targetFor: () => ({ project: "g", region: "us-central1", service: "svc" }) as MappingTarget | null,
        async describe(_t: MappingTarget, h: string): Promise<MappingState | null> {
          f.calls.push(`describe ${h}`);
          return { records, ready: false, message: "" };
        },
        async create(_t: MappingTarget, h: string) {
          f.calls.push(`create ${h}`);
          if (f.createError) throw f.createError;
        },
        async remove(_t: MappingTarget, h: string) {
          f.calls.push(`remove ${h}`);
          if (f.removeError) throw f.removeError;
        },
      },
    };
    return f;
  }

  // A production harness; env: "none" | "undeployed" | "deployed".
  async function setup(opts: { env?: "none" | "undeployed" | "deployed"; region?: string; edge?: boolean } = {}) {
    const cr = fakeCloudRun();
    const kubectl = fakeKubectl();
    // eslint-disable-next-line prefer-const -- the installer closure reads h before startHarness assigns it
    let h!: Harness;
    const inst = fakeInstaller(() => h.store);
    h = await startHarness({
      mode: "production",
      v2: {
        run: kubectl.run,
        resolver: silentResolver,
        edgeInstaller: inst.installer,
        cloudRunDomains: cr.api,
        sleep: async () => {},
      },
    });
    harnesses.push(h);
    h.store.saveGoogleConnection(
      {
        project: "g",
        region: "us-central1",
        arRepo: "r-docker.pkg.dev/g/nbo",
        deployer: account,
        puller: "u@g.iam.gserviceaccount.com",
      },
      { deployerKey: "{}", pullerKey: "{}" },
    );
    const p = h.store.createProject("shop");
    const env = opts.env ?? "deployed";
    if (env !== "none") {
      const e = h.store.createEnvironment(
        p.id,
        "cloudrun",
        "cloudrun",
        JSON.stringify({ project: "g", region: opts.region ?? "us-central1", arRepo: "a" }),
      );
      if (env === "deployed")
        h.store.completeDeployment(h.store.createDeployment(e.id).id, "sha256:x", "https://svc-abc-uc.a.run.app");
    }
    if (opts.edge)
      h.store.updateServerSettings({
        edgeClusterId: connect(h.store, "edge"),
        edgeAddress: "34.1.2.3",
        acmeEmail: "ops@example.com",
      });
    return { h, cr, kubectl, id: p.id, url: `/projects/${p.id}/domains` };
  }

  it("answers the five cases in order", async () => {
    const none = await setup({ env: "none" });
    const r1 = await none.h.call("POST", none.url, { host });
    expect([r1.status, r1.json.error]).toEqual([409, "Install the edge first (nbo-server edge install on the server)"]);

    const undeployed = await setup({ env: "undeployed" });
    const r2 = await undeployed.h.call("POST", undeployed.url, { host });
    expect([r2.status, r2.json.error]).toEqual([409, deployToCloudRunFirstMessage]);

    const far = await setup({ region: "europe-west2" });
    const r3 = await far.h.call("POST", far.url, { host });
    expect([r3.status, r3.json.error]).toEqual([409, unsupportedRegionMessage("europe-west2")]);
    expect(r3.json.error).toContain("europe-west2");

    const ok = await setup();
    const r4 = await ok.h.call("POST", ok.url, { host: "Shop.Example.com." });
    expect(r4.status).toBe(201);
    expect(r4.json).toMatchObject({
      host,
      kind: "custom",
      serving: "cloudrun",
      status: "cert_pending",
      mappingRecords: records,
      mappingKept: false,
    });
    // The first attempt ran at once.
    expect(ok.cr.calls).toEqual([`create ${host}`, `describe ${host}`]);
    // Mapped rows never reach the route table.
    expect(Object.keys(ok.kubectl.table().targets)).not.toContain(host);

    const edge = await setup({ env: "none", edge: true });
    const r5 = await edge.h.call("POST", edge.url, { host });
    expect(r5.status).toBe(201);
    expect(r5.json).toMatchObject({ serving: "edge", status: "dns_pending" });
  });

  it("refuses a host over 64 characters on the Cloud Run path", async () => {
    const t = await setup();
    const long = `${"a".repeat(40)}.${"b".repeat(20)}.com`;
    expect(long.length).toBe(65);
    const res = await t.h.call("POST", t.url, { host: long });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("64");
    expect(t.h.store.listDomains(t.id)).toEqual([]);
    expect((await t.h.call("POST", t.url, { host: `${"a".repeat(40)}.${"b".repeat(19)}.com` })).status).toBe(201);
  });

  it("answers 201 with the row even when the first attempt throws", async () => {
    const t = await setup();
    t.h.v2.domains.checkNow = async () => {
      throw new Error("loop exploded");
    };
    const res = await t.h.call("POST", t.url, { host });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ host, serving: "cloudrun", status: "verify_pending" });
  });

  it("answers 201 and shows Google's refusal when the mapping is refused", async () => {
    const t = await setup();
    t.cr.createError = new Error("quota exceeded");
    const res = await t.h.call("POST", t.url, { host });
    expect(res.status).toBe(201);
    expect(res.json.status).toBe("failed");
    expect(res.json.lastError).toContain("quota exceeded");
  });

  it("removes the mapping before deleting a Cloud Run row; a failure answers 502 and keeps the row", async () => {
    const t = await setup();
    const id = (await t.h.call("POST", t.url, { host })).json.id as string;
    t.cr.calls.length = 0;
    t.cr.removeError = new Error("gcloud exploded");
    const bad = await t.h.call("DELETE", `${t.url}/${id}`);
    expect(bad.status).toBe(502);
    expect(t.h.store.listDomains(t.id).map((d) => d.host)).toEqual([host]);
    t.cr.removeError = null;
    expect((await t.h.call("DELETE", `${t.url}/${id}`)).status).toBe(204);
    expect(t.cr.calls).toEqual([`remove ${host}`, `remove ${host}`]);
    expect(t.h.store.listDomains(t.id)).toEqual([]);
  });

  it("removes a kept mapping before deleting an edge row", async () => {
    const t = await setup({ edge: true });
    const row = t.h.store.addDomain(t.id, host, "custom");
    t.h.store.updateDomain(row.id, { mappingKept: true });
    t.cr.removeError = new Error("gcloud exploded");
    expect((await t.h.call("DELETE", `${t.url}/${row.id}`)).status).toBe(502);
    expect(t.h.store.getDomain(row.id).host).toBe(host);
    t.cr.removeError = null;
    expect((await t.h.call("DELETE", `${t.url}/${row.id}`)).status).toBe(204);
    expect(t.cr.calls).toEqual([`remove ${host}`, `remove ${host}`]);
  });

  it("does not call Google when deleting a plain edge row", async () => {
    const t = await setup({ edge: true });
    const row = t.h.store.addDomain(t.id, host, "custom");
    expect((await t.h.call("DELETE", `${t.url}/${row.id}`)).status).toBe(204);
    expect(t.cr.calls).toEqual([]);
  });

  describe("move-to-edge", () => {
    it("needs confirmGap, an installed edge and a Cloud Run row", async () => {
      const t = await setup();
      const row = t.h.store.addDomain(t.id, host, "custom", "cloudrun");
      const move = `${t.url}/${row.id}/move-to-edge`;
      const r400 = await t.h.call("POST", move, {});
      expect([r400.status, r400.json.error]).toEqual([400, confirmGapMessage]);
      expect((await t.h.call("POST", move, { confirmGap: false })).status).toBe(400);
      const r409 = await t.h.call("POST", move, { confirmGap: true });
      expect([r409.status, r409.json.error]).toEqual([
        409,
        "Install the edge first (nbo-server edge install on the server)",
      ]);
      expect(t.h.store.getDomain(row.id).serving).toBe("cloudrun");

      t.h.store.updateServerSettings({ edgeClusterId: connect(t.h.store, "edge"), edgeAddress: "34.1.2.3" });
      const edgeRow = t.h.store.addDomain(t.id, "other.example.com", "custom");
      expect((await t.h.call("POST", `${t.url}/${edgeRow.id}/move-to-edge`, { confirmGap: true })).status).toBe(409);
      expect((await t.h.call("POST", `${t.url}/dom_missing/move-to-edge`, { confirmGap: true })).status).toBe(404);
    });

    it.each([
      ["no Let's Encrypt email", { acmeEmail: "" }, noEmailMessage],
      ["the edge cluster's connection gone", { edgeClusterId: "kc_gone" }, edgeClusterGoneMessage],
    ])("answers 409 before queueing with %s", async (_name, settings, message) => {
      const t = await setup({ edge: true });
      const row = t.h.store.addDomain(t.id, host, "custom", "cloudrun");
      t.h.store.updateServerSettings(settings);
      let queued = false;
      t.h.v2.domains.moveToEdge = async () => {
        queued = true;
        throw new Error("should not be queued");
      };
      const res = await t.h.call("POST", `${t.url}/${row.id}/move-to-edge`, { confirmGap: true });
      expect([res.status, res.json.error]).toEqual([409, message]);
      expect(queued).toBe(false);
      expect(t.h.store.getDomain(row.id).serving).toBe("cloudrun");
    });

    it("hands the row to the edge, keeps the mapping and pushes the table", async () => {
      const t = await setup({ edge: true });
      const row = t.h.store.addDomain(t.id, host, "custom", "cloudrun");
      t.h.store.updateDomain(row.id, { status: "active", warning: "Google said something", mappingRecords: records });
      const res = await t.h.call("POST", `${t.url}/${row.id}/move-to-edge`, { confirmGap: true });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        id: row.id,
        serving: "edge",
        status: "dns_pending",
        mappingKept: true,
        warning: "",
        record: { type: "A", value: "34.1.2.3", data: "34.1.2.3" },
      });
      expect(t.h.store.getDomain(row.id)).toMatchObject({ serving: "edge", status: "dns_pending", mappingKept: true });
      // The route table was pushed.
      expect(t.kubectl.calls.some((c) => c.args.join(" ").includes("replace -f -"))).toBe(true);
      // The mapping stays until the edge row is active.
      expect(t.cr.calls).toEqual([]);
    });
  });

  describe("archiving the Cloud Run environment", () => {
    async function twoClouds() {
      const t = await setup({ edge: true });
      const cloudRun = t.h.store.listEnvironments(t.id).find((e) => e.target === "cloudrun")!;
      const kube = t.h.store.createEnvironment(t.id, "k8s", "kubernetes", "{}");
      const archive = (id: string) => t.h.call("POST", `/environments/${id}/archive`);
      return { ...t, cloudRun, kube, archive };
    }

    it("is refused, naming the hosts, while a domain is mapped or kept", async () => {
      const t = await twoClouds();
      t.h.store.addDomain(t.id, host, "custom", "cloudrun");
      const kept = t.h.store.addDomain(t.id, "kept.example.com", "custom");
      t.h.store.updateDomain(kept.id, { mappingKept: true });
      t.h.store.addDomain(t.id, "plain.example.com", "custom");
      const res = await t.archive(t.cloudRun.id);
      expect(res.status).toBe(409);
      expect(res.json.error).toContain(host);
      expect(res.json.error).toContain("kept.example.com");
      expect(res.json.error).not.toContain("plain.example.com");
      expect(t.h.store.getEnvironment(t.cloudRun.id).archived).toBe(false);
    });

    it("goes ahead with no mapped domains, and other clouds are not held back", async () => {
      const t = await twoClouds();
      const row = t.h.store.addDomain(t.id, host, "custom", "cloudrun");
      expect((await t.archive(t.kube.id)).status).toBe(204);
      // A project can't archive its only environment.
      t.h.store.createEnvironment(t.id, "k8s-b", "kubernetes", "{}");
      t.h.store.deleteDomain(row.id);
      expect((await t.archive(t.cloudRun.id)).status).toBe(204);
    });
  });

  it("refuses the Cloudflare switch and pasted certificates for a Cloud Run row", async () => {
    const t = await setup();
    const row = t.h.store.addDomain(t.id, host, "custom", "cloudrun");
    const url = `${t.url}/${row.id}`;
    expect((await t.h.call("PATCH", url, { behindCloudflare: true })).status).toBe(409);
    expect((await t.h.call("PUT", `${url}/certificate`, { certPem: "x", keyPem: "y" })).status).toBe(409);
    expect((await t.h.call("DELETE", `${url}/certificate`)).status).toBe(409);
    expect(t.h.store.getDomain(row.id).behindCloudflare).toBe(false);
  });

  describe("rootDomain", () => {
    it.each([
      ["shop.example.co.uk", "example.co.uk"],
      ["example.co.uk", "example.co.uk"],
      ["a.b.example.com", "example.com"],
      ["example.com", "example.com"],
    ])("reads %s as %s, by the same rule as isApex", (name, root) => {
      expect(rootDomainOf(name)).toBe(root);
      expect(isApex(root)).toBe(true);
      expect(isApex(name)).toBe(name === root);
    });

    it("is sent for Cloud Run rows only", async () => {
      const t = await setup({ edge: true });
      t.h.store.addDomain(t.id, "shop.example.co.uk", "custom", "cloudrun");
      t.h.store.addDomain(t.id, "www.other.example.com", "custom");
      const { domains } = (await t.h.call("GET", t.url)).json as { domains: { host: string; rootDomain?: string }[] };
      expect(domains.find((d) => d.host === "shop.example.co.uk")!.rootDomain).toBe("example.co.uk");
      expect(domains.find((d) => d.host === "www.other.example.com")).not.toHaveProperty("rootDomain");
    });
  });

  describe("GET cloudRun", () => {
    const get = async (t: Awaited<ReturnType<typeof setup>>) => (await t.h.call("GET", t.url)).json.cloudRun;

    it("explains each case that is not available", async () => {
      expect(await get(await setup({ env: "none" }))).toEqual({
        available: false,
        reason: "Install the edge first (nbo-server edge install on the server)",
        region: "",
        account,
      });
      expect(await get(await setup({ env: "undeployed" }))).toEqual({
        available: false,
        reason: deployToCloudRunFirstMessage,
        region: "us-central1",
        account,
      });
      expect(await get(await setup({ region: "europe-west2" }))).toEqual({
        available: false,
        reason: unsupportedRegionMessage("europe-west2"),
        region: "europe-west2",
        account,
      });
    });

    it("is available for a deployed project in a supported region", async () => {
      expect(await get(await setup())).toEqual({ available: true, reason: "", region: "us-central1", account });
    });

    it("is not available, with no reason, when an edge is installed", async () => {
      expect(await get(await setup({ edge: true }))).toMatchObject({ available: false, reason: "" });
    });

    it("has an empty account without a Google connection, and needs production in dev mode", async () => {
      const t = await setup();
      t.h.store.deleteConnection("google");
      expect((await get(t)).account).toBe("");
      const dev = await startHarness();
      harnesses.push(dev);
      const p = dev.store.createProject("shop");
      const res = await dev.call("GET", `/projects/${p.id}/domains`);
      expect(res.json.cloudRun).toMatchObject({
        available: false,
        reason: "Domains need the public edge (production mode)",
      });
    });
  });
});

describe("domains per stage", () => {
  // stagingOf gives a project a staging stage with one live Cloud Run row.
  function stagingOf(h: Harness, id: string, host = "staging--storefront.34-1-2-3.sslip.io") {
    const stage = h.store.createStage(id, { name: "staging", branch: "staging", host });
    const env = h.store.createEnvironment(
      id,
      "s-staging-cr",
      "cloudrun",
      JSON.stringify({ project: "g", region: "europe-west1", arRepo: "a" }),
      stage.id,
    );
    const dep = h.store.createDeployment(env.id);
    h.store.completeDeployment(dep.id, "sha256:s", "https://pabc-s-staging-cr-xyz.a.run.app");
    h.store.setTrafficWeights(id, { [env.id]: 100 }, stage.id);
    return { stage, env };
  }

  it("refuses a domain for another environment before the edge is installed", async () => {
    const { h, edgeId } = await production();
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    stagingOf(h, id);
    const add = await h.call("POST", `/projects/${id}/domains`, { host: "staging.acme.com", stage: "staging" });
    expect(add.status).toBe(409);
    expect(add.json.error).toBe("Install the edge first (nbo-server edge install on the server)");
    expect(h.store.listDomains(id)).toEqual([]);
  });

  it("adds a staging domain with its stage, routed to the stage's backends", async () => {
    const { h, kubectl, edgeId } = await productionWithEdge();
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const { stage, env } = stagingOf(h, id);

    const add = await h.call("POST", `/projects/${id}/domains`, { host: "staging.acme.com", stage: "staging" });
    expect(add.status).toBe(201);
    expect(add.json).toMatchObject({ host: "staging.acme.com", kind: "custom", stageId: stage.id, stage: "staging" });
    expect(h.store.getDomain(add.json.id as string).stageId).toBe(stage.id);
    expect(kubectl.table().targets["staging.acme.com"]!.backends.map((b) => b.id)).toEqual([env.id]);

    // A Production domain (no stage named) is Production's.
    const prod = await h.call("POST", `/projects/${id}/domains`, { host: "shop.acme.com" });
    expect(prod.json).toMatchObject({ stageId: h.store.productionStage(id).id, stage: "production" });
    expect(kubectl.table().targets["shop.acme.com"]!.backends.map((b) => b.id)).toEqual(
      h.store.listEnvironments(id).map((e) => e.id),
    );

    expect((await h.call("POST", `/projects/${id}/domains`, { host: "x.acme.com", stage: "nope" })).status).toBe(404);
    expect((await h.call("POST", `/projects/${id}/domains`, { host: "x.acme.com", stage: "preview" })).status).toBe(
      400,
    );
    expect((await h.call("POST", `/projects/${id}/domains`, { host: "x.acme.com", stage: 3 })).status).toBe(400);
    // A stage's default host is taken, like a project's.
    expect(
      (await h.call("POST", `/projects/${id}/domains`, { host: "staging--storefront.34-1-2-3.sslip.io" })).status,
    ).toBe(409);
  });

  it("the project's address stays Production's; a stage has its own", async () => {
    const { h, edgeId } = await productionWithEdge();
    const id = await deployedProject(h, { clouds: [{ target: "kubernetes", clusterId: edgeId }] });
    const { stage } = stagingOf(h, id);
    const staged = h.store.addDomain(id, "staging.acme.com", "custom", "edge", stage.id);
    h.store.updateDomain(staged.id, { status: "active" });
    const ctx = { store: h.store, mode: "production" as const, edgePublicPort: 9443 };

    expect((await h.call("GET", `/projects/${id}/summary`)).json.domainUrl).toBe("http://storefront.34-1-2-3.sslip.io");
    expect(domainUrlFor(h.store.getProject(id), ctx)).toBe("http://storefront.34-1-2-3.sslip.io");
    expect(stageUrlFor(h.store.getStage(stage.id), ctx)).toBe("https://staging.acme.com");
    expect(stageUrlFor(h.store.productionStage(id), ctx)).toBe("http://storefront.34-1-2-3.sslip.io");
    h.store.deleteDomain(staged.id);
    expect(stageUrlFor(h.store.getStage(stage.id), ctx)).toBe("http://staging--storefront.34-1-2-3.sslip.io");
    expect(stageUrlFor(h.store.getStage(stage.id), { ...ctx, mode: "dev" })).toBe(
      "http://staging--storefront.34-1-2-3.sslip.io:9443",
    );
  });
});
