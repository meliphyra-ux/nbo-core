// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { afterEach, describe, expect, it } from "vitest";
import { createTestMux } from "../../__tests__/test-mux.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CommandRunner } from "@nbo/deploy";
import { createStore, type Store } from "../../store/store.js";
import { wireV2 } from "../../v2.js";
import { parseMode, type Mode } from "../../mode.js";
import { createCloudSetup } from "../cloud-setup.js";
import { FIXTURE_CODE, saveWifConnection } from "./google-wif-fixture.js";
import { fakeCloudSetup, fakeDeploymentTrigger, fakeGoogleConnect, fakeKubeConnect } from "../../testing.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(mode: Mode, run?: CommandRunner) {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-conn-routes-"));
  const store: Store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const google = fakeGoogleConnect(store);
  const kube = fakeKubeConnect(store);
  const deploys = fakeDeploymentTrigger(store);
  const v2 = wireV2(store, {
    mode,
    deploymentTrigger: deploys,
    cloudSetup: fakeCloudSetup(),
    edgeAdminUrl: "http://127.0.0.1:1",
    edgePublicPort: 9443,
    googleConnect: google,
    kubeConnect: kube,
    run,
  });
  const mux = createTestMux(store, deploys, v2.queue, v2);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await mux(
      new Request(`http://cp${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
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
  return { store, google, kube, call };
}

describe("parseMode", () => {
  it("defaults to dev, accepts production, rejects anything else", () => {
    expect(parseMode({})).toBe("dev");
    expect(parseMode({ NBO_MODE: "dev" })).toBe("dev");
    expect(parseMode({ NBO_MODE: "production" })).toBe("production");
    expect(() => parseMode({ NBO_MODE: "staging" })).toThrow('NBO_MODE must be "dev" or "production"');
  });
});

describe("GET /system/connections", () => {
  it("reports setupComplete false in production on a fresh store, true in dev", async () => {
    const prod = await setup("production");
    expect((await prod.call("GET", "/system/connections")).json).toEqual({
      mode: "production",
      google: null,
      kubernetes: [],
      setupComplete: false,
    });
    const dev = await setup("dev");
    expect((await dev.call("GET", "/system/connections")).json).toMatchObject({ mode: "dev", setupComplete: true });
  });

  it("is complete in production once a connection exists, and never returns secrets", async () => {
    const t = await setup("production");
    await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "kubeconfig", kubeconfig: "KUBECONFIG-SECRET" },
      name: "prod",
      registry: { kind: "artifact-registry" },
    });
    const res = await t.call("GET", "/system/connections");
    expect(res.json.setupComplete).toBe(true);
    expect(res.json.kubernetes).toHaveLength(1);
    expect(res.json.kubernetes[0]).toMatchObject({ name: "prod", id: expect.stringMatching(/^kc_/) });
    expect(res.text).not.toContain("KUBECONFIG-SECRET");
  });

  it("tells whether a cluster has a saved load balancer location, without exposing it", async () => {
    const t = await setup("production");
    await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "kubeconfig", kubeconfig: "KUBECONFIG-SECRET" },
      name: "prod",
      registry: { kind: "artifact-registry" },
    });
    const id = t.store.listKubernetesConnections()[0]!.id;
    expect((await t.call("GET", "/system/connections")).json.kubernetes[0].lbLocationSaved).toBe(false);
    t.store.setClusterLbAnnotations(id, { "load-balancer.hetzner.cloud/location": "fsn1" });
    const res = await t.call("GET", "/system/connections");
    expect(res.json.kubernetes[0].lbLocationSaved).toBe(true);
    expect(res.text).not.toContain("fsn1");
  });
});

describe("detect and plan", () => {
  it("returns both detections", async () => {
    const t = await setup("dev");
    const res = await t.call("GET", "/system/connections/detect");
    expect(res.status).toBe(200);
    expect(res.json.google.found).toBe(true);
    expect(res.json.kubernetes.contexts[0].name).toBe("kind-nbo-local");
  });

  it("plans from the query, including the google source", async () => {
    const t = await setup("dev");
    const res = await t.call("GET", "/system/connections/plan?google=key,my-proj,us-central1&kubernetes=1");
    expect(res.json).toEqual({ google: ["plan google key my-proj us-central1"], kubernetes: ["plan kubernetes"] });
    expect((await t.call("GET", "/system/connections/plan")).json).toEqual({ google: [], kubernetes: [] });
    expect((await t.call("GET", "/system/connections/plan?google=bogus,p,r")).status).toBe(400);
  });
});

describe("POST /system/connections/google", () => {
  it("connects with a key (201) without echoing the key", async () => {
    const t = await setup("production");
    const keyJson = JSON.stringify({ project_id: "p", client_email: "a@b", private_key: "SECRET" });
    const res = await t.call("POST", "/system/connections/google", { source: "key", keyJson, region: "us-central1" });
    expect(res.status).toBe(201);
    expect(res.json.kind).toBe("google");
    expect(res.text).not.toContain("SECRET");
  });

  it("connects from the machine", async () => {
    const t = await setup("production");
    const res = await t.call("POST", "/system/connections/google", {
      source: "machine",
      project: "my-proj",
      region: "europe-north1",
    });
    expect(res.status).toBe(201);
    expect(t.google.calls).toEqual(["machine my-proj europe-north1"]);
  });

  it("scrubs a key the connector leaked into its error (raw and JSON-escaped)", async () => {
    const t = await setup("production");
    const pk = "-----BEGIN\nSECRET-PK\n-----END";
    const keyJson = JSON.stringify({ project_id: "p", client_email: "a@b", private_key: pk });
    t.google.failWith = new Error(`activate failed: ${pk} / ${JSON.stringify(pk).slice(1, -1)} / ${keyJson}`);
    const res = await t.call("POST", "/system/connections/google", { source: "key", keyJson, region: "us-central1" });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("SECRET-PK");
    expect(res.json.error).toContain("activate failed");
  });

  it("connects keyless with a connection code (201)", async () => {
    const t = await setup("production");
    const res = await t.call("POST", "/system/connections/google", {
      source: "wif",
      code: FIXTURE_CODE,
      region: "europe-west1",
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ kind: "google", auth: "wif" });
    expect(t.google.calls).toEqual([`wif ${FIXTURE_CODE} europe-west1`]);
  });

  it("answers a refused code with 400 and its sentence", async () => {
    const t = await setup("production");
    t.google.failWith = new Error("This connection code was made for another core.");
    const res = await t.call("POST", "/system/connections/google", { source: "wif", code: "x", region: "r" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("This connection code was made for another core.");
  });

  it("rejects missing or invalid fields with 400", async () => {
    const t = await setup("production");
    for (const body of [
      { source: "oauth", region: "r" },
      { source: "wif", region: "r" },
      { source: "wif", code: "c" },
      { source: "key", region: "r" },
      { source: "machine", region: "r" },
      { source: "machine", project: "p" },
      "nope",
    ]) {
      expect((await t.call("POST", "/system/connections/google", body)).status).toBe(400);
    }
    expect(t.google.calls).toEqual([]);
  });
});

describe("POST /system/connections/kubernetes", () => {
  it("passes a validated request to connect", async () => {
    const t = await setup("production");
    const res = await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "token", server: "https://k", caData: "ca", token: "tok" },
      name: "prod",
      registry: { kind: "custom", server: "ghcr.io", username: "me" },
      registryPassword: "pw",
    });
    expect(res.status).toBe(201);
    expect(t.kube.requests[0]).toEqual({
      source: { kind: "token", server: "https://k", caData: "ca", token: "tok" },
      name: "prod",
      registry: { kind: "custom", server: "ghcr.io", username: "me" },
      registryPassword: "pw",
    });
  });

  it("rejects invalid source or registry kinds with 400", async () => {
    const t = await setup("production");
    const ok = { source: { kind: "machine", context: "c" }, name: "n", registry: { kind: "artifact-registry" } };
    expect((await t.call("POST", "/system/connections/kubernetes", ok)).status).toBe(201);
    expect((await t.call("POST", "/system/connections/kubernetes", { ...ok, source: { kind: "oauth" } })).status).toBe(
      400,
    );
    expect(
      (await t.call("POST", "/system/connections/kubernetes", { ...ok, registry: { kind: "docker-hub" } })).status,
    ).toBe(400);
    expect(
      (await t.call("POST", "/system/connections/kubernetes", { ...ok, registry: { kind: "custom", server: "x" } }))
        .status,
    ).toBe(400);
    expect((await t.call("POST", "/system/connections/kubernetes", { ...ok, name: "" })).status).toBe(400);
  });

  it("scrubs kubeconfig, token, caData and registry password leaked into an error", async () => {
    const t = await setup("production");
    t.kube.failWith = new Error("failed: SECRET-KC SECRET-TOK SECRET-CA SECRET-RP");
    const cases = [
      {
        source: { kind: "kubeconfig", kubeconfig: "SECRET-KC" },
        name: "n",
        registry: { kind: "custom", server: "x", username: "u" },
        registryPassword: "SECRET-RP",
      },
      {
        source: { kind: "token", server: "https://k", caData: "SECRET-CA", token: "SECRET-TOK" },
        name: "n",
        registry: { kind: "artifact-registry" },
      },
    ];
    for (const body of cases) {
      const res = await t.call("POST", "/system/connections/kubernetes", body);
      expect(res.status).toBe(400);
      for (const secret of ["SECRET-KC", "SECRET-TOK", "SECRET-CA", "SECRET-RP"]) {
        if (JSON.stringify(body).includes(secret)) expect(res.text).not.toContain(secret);
      }
    }
  });

  it("returns a connect error as 400", async () => {
    const t = await setup("production");
    t.kube.failWith = new Error("cluster is 1.28; NBO needs 1.30+");
    const res = await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "machine", context: "c" },
      name: "n",
      registry: { kind: "artifact-registry" },
    });
    expect(res).toMatchObject({ status: 400, json: { error: "cluster is 1.28; NBO needs 1.30+" } });
  });
});

describe("several Kubernetes connections", () => {
  const body = (name: string, registry: unknown = { kind: "artifact-registry" }) => ({
    source: { kind: "machine", context: "c" },
    name,
    registry,
  });

  it("creates one connection per name and refuses a duplicate name with 400", async () => {
    const t = await setup("production");
    const a = await t.call("POST", "/system/connections/kubernetes", body("hetzner-eu"));
    const b = await t.call("POST", "/system/connections/kubernetes", body("gke-us"));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.json.id).not.toBe(b.json.id);
    const dup = await t.call("POST", "/system/connections/kubernetes", body("hetzner-eu"));
    expect(dup.status).toBe(400);
    expect(dup.json.error).toMatch(/hetzner-eu/);
    const list = await t.call("GET", "/system/connections");
    expect(list.json.kubernetes.map((c: { name: string }) => c.name)).toEqual(["hetzner-eu", "gke-us"]);
  });

  it("rejects a malformed cluster name with 400", async () => {
    const t = await setup("production");
    expect((await t.call("POST", "/system/connections/kubernetes", body("Not OK"))).status).toBe(400);
    expect(t.store.listKubernetesConnections()).toEqual([]);
  });

  it("tests one cluster by id; 404 for an unknown id or kind", async () => {
    const t = await setup("production");
    expect((await t.call("POST", "/system/connections/google/test")).status).toBe(404);
    await t.call("POST", "/system/connections/google", { source: "machine", project: "p", region: "us-central1" });
    const g = await t.call("POST", "/system/connections/google/test");
    expect(g.status).toBe(200);
    expect(g.json.kind).toBe("google");
    const a = await t.call("POST", "/system/connections/kubernetes", body("a"));
    const b = await t.call("POST", "/system/connections/kubernetes", body("b"));
    t.store.recordConnectionCheck("kubernetes", "boom", a.json.id);
    t.store.recordConnectionCheck("kubernetes", "boom", b.json.id);
    const res = await t.call("POST", `/system/connections/kubernetes/${b.json.id}/test`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: b.json.id, status: "connected" });
    expect(t.store.getKubernetesConnection(a.json.id)!.status).toBe("failing");
    expect((await t.call("POST", "/system/connections/kubernetes/kc_nope/test")).status).toBe(404);
    expect((await t.call("POST", "/system/connections/aws/test")).status).toBe(404);
  });

  it("PUT replaces one cluster's credentials and registry, keeping its id and name", async () => {
    const t = await setup("production");
    const a = await t.call("POST", "/system/connections/kubernetes", body("a"));
    const res = await t.call("PUT", `/system/connections/kubernetes/${a.json.id}`, {
      source: { kind: "kubeconfig", kubeconfig: "NEW-SECRET-KC" },
      registry: { kind: "custom", server: "ghcr.io", username: "me" },
      registryPassword: "pw",
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: a.json.id,
      name: "a",
      registry: { kind: "custom", server: "ghcr.io", username: "me" },
    });
    expect(res.text).not.toContain("NEW-SECRET-KC");
    expect(t.kube.requests[1]).toMatchObject({ id: a.json.id, name: "a" });
    expect(t.store.listKubernetesConnections()).toHaveLength(1);
    const renamed = await t.call("PUT", `/system/connections/kubernetes/${a.json.id}`, {
      name: "b",
      source: { kind: "machine", context: "c" },
      registry: { kind: "artifact-registry" },
    });
    expect(renamed.status).toBe(400);
    expect(renamed.json.error).toMatch(/name cannot change/);
    expect(
      (
        await t.call("PUT", `/system/connections/kubernetes/${a.json.id}`, {
          name: "a",
          source: { kind: "machine", context: "c" },
          registry: { kind: "artifact-registry" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.call("PUT", "/system/connections/kubernetes/kc_nope", {
          source: { kind: "machine", context: "c" },
          registry: { kind: "artifact-registry" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("DELETE /system/connections/kubernetes/{id}", () => {
  it("refuses with 409 naming the projects while environments use that cluster, then 204 after archiving", async () => {
    const t = await setup("production");
    const a = await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "machine", context: "c" },
      name: "hetzner-eu",
      registry: { kind: "artifact-registry" },
    });
    const b = await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "machine", context: "c" },
      name: "gke-us",
      registry: { kind: "artifact-registry" },
    });
    const project = t.store.createProject("storefront");
    const env = t.store.createEnvironment(
      project.id,
      "k8s-hetzner-eu",
      "kubernetes",
      JSON.stringify({ clusterId: a.json.id }),
    );
    const blocked = await t.call("DELETE", `/system/connections/kubernetes/${a.json.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe(
      'projects still run on hetzner-eu: storefront — archive those environments first. Archiving does not stop running sites: to take them down, delete the project with "also delete what it runs" while hetzner-eu is still connected.',
    );
    expect(t.store.getKubernetesConnection(a.json.id)).not.toBeNull();
    // Another cluster is not held by that environment.
    expect((await t.call("DELETE", `/system/connections/kubernetes/${b.json.id}`)).status).toBe(204);

    t.store.archiveEnvironment(env.id);
    expect((await t.call("DELETE", `/system/connections/kubernetes/${a.json.id}`)).status).toBe(204);
    expect(t.store.listKubernetesConnections()).toEqual([]);
    expect((await t.call("DELETE", `/system/connections/kubernetes/${a.json.id}`)).status).toBe(404);
  });
});

describe("DELETE /system/connections/google", () => {
  it("refuses while any cluster pushes to Artifact Registry", async () => {
    const t = await setup("production");
    await t.call("POST", "/system/connections/google", { source: "machine", project: "p", region: "us-central1" });
    await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "machine", context: "c" },
      name: "a",
      registry: { kind: "custom", server: "ghcr.io", username: "me" },
    });
    const b = await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "machine", context: "c" },
      name: "b",
      registry: { kind: "artifact-registry" },
    });
    const blocked = await t.call("DELETE", "/system/connections/google");
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe(
      "Kubernetes cluster b pushes images to Google Artifact Registry — replace its registry or disconnect it first",
    );
    expect(t.store.getGoogleConnection()).not.toBeNull();

    await t.call("PUT", `/system/connections/kubernetes/${b.json.id}`, {
      source: { kind: "machine", context: "c" },
      registry: { kind: "custom", server: "ghcr.io", username: "me" },
    });
    expect((await t.call("DELETE", "/system/connections/google")).status).toBe(204);
  });

  it("refuses with 409 while Cloud Run environments use it; 404 on an unknown kind", async () => {
    const t = await setup("production");
    await t.call("POST", "/system/connections/google", { source: "machine", project: "p", region: "us-central1" });
    const project = t.store.createProject("storefront");
    t.store.createEnvironment(project.id, "cloudrun", "cloudrun");
    expect((await t.call("DELETE", "/system/connections/google")).status).toBe(409);
    expect((await t.call("DELETE", "/system/connections/aws")).status).toBe(404);
  });
});

describe("disconnect guards for domains", () => {
  it("refuses to disconnect the edge cluster while an edge custom domain exists, naming the hosts", async () => {
    const t = await setup("production");
    const a = await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "machine", context: "c" },
      name: "edge",
      registry: { kind: "artifact-registry" },
    });
    const b = await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "machine", context: "c" },
      name: "other",
      registry: { kind: "artifact-registry" },
    });
    const project = t.store.createProject("storefront");
    t.store.updateServerSettings({ edgeClusterId: a.json.id });
    t.store.addDomain(project.id, "shop.example.com", "custom");
    t.store.addDomain(project.id, "www.example.com", "custom");
    // A Cloud Run row and a default row do not count.
    t.store.addDomain(project.id, "g.example.com", "custom", "cloudrun");
    const blocked = await t.call("DELETE", `/system/connections/kubernetes/${a.json.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("shop.example.com");
    expect(blocked.json.error).toContain("www.example.com");
    expect(blocked.json.error).not.toContain("g.example.com");
    expect(t.store.getKubernetesConnection(a.json.id)).not.toBeNull();
    // Another cluster is not the edge cluster.
    expect((await t.call("DELETE", `/system/connections/kubernetes/${b.json.id}`)).status).toBe(204);
    for (const d of t.store.listDomains(project.id)) if (d.serving === "edge") t.store.deleteDomain(d.id);
    expect((await t.call("DELETE", `/system/connections/kubernetes/${a.json.id}`)).status).toBe(204);
  });

  it("refuses to disconnect Google while a Cloud Run row or a kept mapping exists, naming the hosts", async () => {
    const t = await setup("production");
    await t.call("POST", "/system/connections/google", { source: "machine", project: "p", region: "us-central1" });
    const project = t.store.createProject("storefront");
    const mapped = t.store.addDomain(project.id, "shop.example.com", "custom", "cloudrun");
    const kept = t.store.addDomain(project.id, "kept.example.com", "custom");
    t.store.updateDomain(kept.id, { mappingKept: true });
    t.store.addDomain(project.id, "plain.example.com", "custom");
    const blocked = await t.call("DELETE", "/system/connections/google");
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("shop.example.com");
    expect(blocked.json.error).toContain("kept.example.com");
    expect(blocked.json.error).not.toContain("plain.example.com");
    expect(t.store.getGoogleConnection()).not.toBeNull();
    t.store.deleteDomain(mapped.id);
    t.store.updateDomain(kept.id, { mappingKept: false });
    expect((await t.call("DELETE", "/system/connections/google")).status).toBe(204);
  });
});

describe("GET /system/regions/domain-mapping", () => {
  it("answers without a connection or credentials", async () => {
    const t = await setup("production");
    const res = await t.call("GET", "/system/regions/domain-mapping");
    expect(res.status).toBe(200);
    expect(res.json.regions).toContain("us-central1");
    expect(res.json.regions).not.toContain("europe-west2");
    expect(res.json.source).toMatch(/^https:/);
    expect(res.json.takenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("GET /system/regions", () => {
  it("409s without a Google connection", async () => {
    const t = await setup("production");
    expect((await t.call("GET", "/system/regions")).status).toBe(409);
  });

  it("lists regions with the connection's own credentials and drops warning lines", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const run: CommandRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      if (args[0] === "run") return "WARNING: something odd\nus-central1\neurope-north1\nus-central1\n";
      return "";
    };
    const t = await setup("production", run);
    await t.call("POST", "/system/connections/google", { source: "machine", project: "p", region: "us-central1" });
    const res = await t.call("GET", "/system/regions");
    expect(res.status).toBe(200);
    expect(res.json.map((r: { id: string }) => r.id)).toEqual(["europe-north1", "us-central1"]);
    const list = calls.find((c) => c.args[0] === "run")!;
    expect(list.env?.CLOUDSDK_CONFIG).toBeTruthy();
    expect(list.args).toContain("--project");
    expect(list.args[list.args.indexOf("--project") + 1]).toBe("p");
    expect(calls.some((c) => c.args.join(" ").startsWith("auth activate-service-account"))).toBe(true);
  });
});

describe("GET /system/regions with a keyless connection", () => {
  it("signs in with googleCredential's token exchange, never a key", async () => {
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      return args[0] === "run" ? "us-central1\n" : "";
    };
    const t = await setup("production", run);
    saveWifConnection(t.store, "p", "us-central1");
    expect((await t.call("GET", "/system/regions")).status).toBe(200);
    const lines = calls.map((c) => c.args.join(" "));
    expect(lines.some((l) => l.startsWith("auth login --cred-file="))).toBe(true);
    expect(lines.some((l) => l.includes("activate-service-account"))).toBe(false);
  });
});

describe("production preflight", () => {
  const probes: string[] = [];
  const run: CommandRunner = async (cmd) => {
    probes.push(cmd);
    return "27.1.0";
  };

  it("reflects a failing Kubernetes connection and never probes the host's gcloud/kubectl", async () => {
    const t = await setup("production");
    const c = await t.call("POST", "/system/connections/kubernetes", {
      source: { kind: "machine", context: "c" },
      name: "prod",
      registry: { kind: "artifact-registry" },
    });
    t.store.recordConnectionCheck("kubernetes", "Unauthorized", c.json.id);
    probes.length = 0;
    const p = await createCloudSetup(run, { mode: "production", store: t.store }).preflight();
    expect(p.kubernetes).toEqual({
      reachable: false,
      context: "prod",
      ready: false,
      reason: "Unauthorized",
      summary: "failing",
      clusters: [{ id: c.json.id, name: "prod", ready: false, reason: "Unauthorized" }],
    });
    expect(p.gcloud.ready).toBe(false);
    expect(p.gcloud.reason).toBe("Google Cloud is not connected");
    expect(p.docker.ready).toBe(true);
    expect(probes).toEqual(["docker"]);
  });

  it("is ready from connected statuses, with project and region from the Google connection", async () => {
    const t = await setup("production");
    await t.call("POST", "/system/connections/google", { source: "machine", project: "p", region: "us-central1" });
    const p = await createCloudSetup(run, { mode: "production", store: t.store }).preflight();
    expect(p.gcloud).toMatchObject({ ready: true, reason: null, project: "p", region: "us-central1" });
  });
});

describe("secrets never leave the real store", () => {
  it("GET /system/connections returns no secret nor sealed value", async () => {
    const t = await setup("production");
    t.store.saveGoogleConnection(
      { project: "p", region: "us-central1", arRepo: "r", deployer: "d@x", puller: "p@x" },
      { deployerKey: "SECRET-DEPLOYER-KEY", pullerKey: "SECRET-PULLER-KEY" },
    );
    t.store.saveKubernetesConnection(
      { name: "prod", server: "https://k", registry: { kind: "custom", server: "ghcr.io", username: "me" } },
      { kubeconfig: "SECRET-KUBECONFIG", registryPassword: "SECRET-REGISTRY-PW" },
    );
    for (const path of ["/system/connections"]) {
      const res = await t.call("GET", path);
      expect(res.status).toBe(200);
      expect(res.json.google.project).toBe("p");
      for (const secret of [
        "SECRET-DEPLOYER-KEY",
        "SECRET-PULLER-KEY",
        "SECRET-KUBECONFIG",
        "SECRET-REGISTRY-PW",
        "v1:",
      ])
        expect(res.text).not.toContain(secret);
    }
  });
});

describe("createCloudSetup in production", () => {
  it("refuses to be built without the connections store", () => {
    expect(() => createCloudSetup(undefined, { mode: "production" })).toThrow(
      "production preflight needs the connections store",
    );
  });
});
