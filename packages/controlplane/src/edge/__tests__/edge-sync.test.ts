// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serveFetch } from "@nbo/nodehost";
import { createAdminMux, createRegistry, type Registry } from "@nbo/edge";
import { createStore, type Store } from "../../store/store.js";
import { createEdgeSync } from "../edge-sync.js";
import { ErrNotFound } from "../../store/errors.js";

const openStores: Store[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of openStores.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-edgesync-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

async function startEdge(port = 0): Promise<{ registry: Registry; adminUrl: string; server: Server }> {
  const registry = createRegistry();
  const server = await new Promise<Server>((resolve) => {
    const srv = serveFetch(createAdminMux(registry), { host: "127.0.0.1", port }, () => resolve(srv));
  });
  servers.push(server);
  return { registry, adminUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

function deployOk(store: Store, envId: string, url: string): void {
  const d = store.createDeployment(envId);
  store.completeDeployment(d.id, "sha256:x", url);
}

async function projectWithEnvs(store: Store, name = "storefront") {
  const p = store.createProject(name);
  store.updateProject(p.id, { edgeHost: `${name}.127.0.0.1.sslip.io` });
  const k8s = store.createEnvironment(p.id, "k8s", "kubernetes");
  const cr = store.createEnvironment(p.id, "cloudrun", "cloudrun");
  return { p, k8s, cr };
}

describe("createEdgeSync", () => {
  it("desiredTarget is null before any successful deployment", async () => {
    const store = await openTestStore();
    const { adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    const failed = store.createDeployment(k8s.id);
    store.failDeployment(failed.id, "boom");
    expect(createEdgeSync(store, { adminUrl }).desiredTarget(p.id)).toBeNull();
  });

  it("onDeployed on a fresh project registers its host at 100% to that environment", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    const sync = createEdgeSync(store, { adminUrl });

    await sync.onDeployed(p.id, k8s.id);

    expect(registry.get("storefront.127.0.0.1.sslip.io")?.backends).toEqual([
      { id: k8s.id, url: "https://pabc-k8s.127.0.0.1.sslip.io", weight: 100, insecureSkipVerify: true },
    ]);
    expect(store.getEnvironment(k8s.id).trafficWeight).toBe(100);
  });

  it("onDeployed on a project that already has weights keeps them", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s, cr } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    deployOk(store, cr.id, "https://pabc-cloudrun-xyz.a.run.app");
    store.setTrafficWeights(p.id, { [k8s.id]: 90, [cr.id]: 10 });
    const sync = createEdgeSync(store, { adminUrl });

    await sync.onDeployed(p.id, cr.id);

    expect(store.getEnvironment(k8s.id).trafficWeight).toBe(90);
    expect(store.getEnvironment(cr.id).trafficWeight).toBe(10);
    expect(registry.get("storefront.127.0.0.1.sslip.io")?.backends.map((b) => b.weight)).toEqual([90, 10]);
  });

  it("push skips an all-zero split instead of sending it", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    await createEdgeSync(store, { adminUrl }).push(p.id);
    expect(registry.get("storefront.127.0.0.1.sslip.io")).toBeUndefined();
  });

  it("sslip.io backends are sent with insecureSkipVerify true, run.app ones false", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s, cr } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    deployOk(store, cr.id, "https://pabc-cloudrun-xyz.a.run.app");
    store.setTrafficWeights(p.id, { [k8s.id]: 50, [cr.id]: 50 });
    await createEdgeSync(store, { adminUrl }).push(p.id);
    expect(registry.get("storefront.127.0.0.1.sslip.io")?.backends.map((b) => b.insecureSkipVerify)).toEqual([
      true,
      false,
    ]);
  });

  it("inSync is false when the edge has no target and true after push", async () => {
    const store = await openTestStore();
    const { adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    const sync = createEdgeSync(store, { adminUrl });
    expect(await sync.inSync(p.id)).toBe(false);
    await sync.push(p.id);
    expect(await sync.inSync(p.id)).toBe(true);
  });

  it("inSync is false when the edge is unreachable", async () => {
    const store = await openTestStore();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    expect(await createEdgeSync(store, { adminUrl: "http://127.0.0.1:1" }).inSync(p.id)).toBe(false);
  });

  it("reconcile re-pushes a project whose edge target is missing", async () => {
    const store = await openTestStore();
    const first = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    await createEdgeSync(store, { adminUrl: first.adminUrl }).push(p.id);

    // The edge restarts with an empty in-memory registry.
    const restarted = await startEdge();
    expect(restarted.registry.get("storefront.127.0.0.1.sslip.io")).toBeUndefined();
    await createEdgeSync(store, { adminUrl: restarted.adminUrl }).reconcile();
    expect(restarted.registry.get("storefront.127.0.0.1.sslip.io")?.backends[0]?.weight).toBe(100);
  });

  it("reconcile keeps going when one project's push fails", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const bad = await projectWithEnvs(store, "aaa-bad");
    deployOk(store, bad.k8s.id, "not a url");
    store.setTrafficWeights(bad.p.id, { [bad.k8s.id]: 100 });
    const good = await projectWithEnvs(store, "zzz-good");
    deployOk(store, good.k8s.id, "https://pgood-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(good.p.id, { [good.k8s.id]: 100 });

    await createEdgeSync(store, { adminUrl }).reconcile();

    expect(registry.get("aaa-bad.127.0.0.1.sslip.io")).toBeUndefined();
    expect(registry.get("zzz-good.127.0.0.1.sslip.io")?.backends[0]?.weight).toBe(100);
  });
});

// withStaging adds a custom stage with its own Kubernetes row to a project.
function withStaging(store: Store, projectId: string, host = "staging--storefront.127.0.0.1.sslip.io") {
  const stage = store.createStage(projectId, { name: "staging", branch: "staging", host });
  const env = store.createEnvironment(projectId, "s-staging-k8s", "kubernetes", "{}", stage.id);
  return { stage, env };
}

describe("createEdgeSync with stages", () => {
  it("push sends one target per stage with live backends, Speed Insights only on Production", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    store.updateProject(p.id, { speedInsights: true });
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    const { stage, env } = withStaging(store, p.id);
    deployOk(store, env.id, "https://pabc-s-staging-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [env.id]: 100 }, stage.id);
    // A stage with no live backend sends nothing.
    store.createStage(p.id, { name: "qat", branch: "qa", host: "qat--storefront.127.0.0.1.sslip.io" });
    const sent: string[] = [];
    const sync = createEdgeSync(store, {
      adminUrl,
      fetch: async (input, init) => {
        if (init?.method === "PUT") sent.push(String(input));
        return fetch(input, init);
      },
    });

    await sync.push(p.id);

    expect(sent.map((u) => decodeURIComponent(u.slice(adminUrl.length)))).toEqual([
      "/targets/storefront.127.0.0.1.sslip.io",
      "/targets/staging--storefront.127.0.0.1.sslip.io",
    ]);
    expect(registry.get("storefront.127.0.0.1.sslip.io")?.insights).toMatchObject({ enabled: true });
    expect(registry.get("staging--storefront.127.0.0.1.sslip.io")?.backends).toEqual([
      { id: env.id, url: "https://pabc-s-staging-k8s.127.0.0.1.sslip.io", weight: 100, insecureSkipVerify: true },
    ]);
    expect(registry.get("staging--storefront.127.0.0.1.sslip.io")?.insights?.enabled ?? false).toBe(false);
    expect(registry.get("qat--storefront.127.0.0.1.sslip.io")).toBeUndefined();
    // desiredTarget keeps meaning Production; desiredTargets has both.
    expect(sync.desiredTarget(p.id)?.host).toBe("storefront.127.0.0.1.sslip.io");
    expect(sync.desiredTargets(p.id).map((t) => t.host)).toEqual([
      "storefront.127.0.0.1.sslip.io",
      "staging--storefront.127.0.0.1.sslip.io",
    ]);
  });

  it("the first staging deploy gets 100% of staging and leaves Production untouched", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s, cr } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    deployOk(store, cr.id, "https://pabc-cloudrun-xyz.a.run.app");
    store.setTrafficWeights(p.id, { [k8s.id]: 70, [cr.id]: 30 });
    const sync = createEdgeSync(store, { adminUrl });
    await sync.push(p.id);
    const { env } = withStaging(store, p.id);
    deployOk(store, env.id, "https://pabc-s-staging-k8s.127.0.0.1.sslip.io");

    await sync.onDeployed(p.id, env.id);

    expect(store.getEnvironment(env.id).trafficWeight).toBe(100);
    expect(store.getEnvironment(k8s.id).trafficWeight).toBe(70);
    expect(store.getEnvironment(cr.id).trafficWeight).toBe(30);
    expect(registry.get("staging--storefront.127.0.0.1.sslip.io")?.backends.map((b) => [b.id, b.weight])).toEqual([
      [env.id, 100],
    ]);
    expect(registry.get("storefront.127.0.0.1.sslip.io")?.backends.map((b) => [b.id, b.weight])).toEqual([
      [k8s.id, 70],
      [cr.id, 30],
    ]);
  });

  it("setTrafficWeights with a stage accepts only that stage's rows", async () => {
    const store = await openTestStore();
    const { p, k8s } = await projectWithEnvs(store);
    const { stage, env } = withStaging(store, p.id);
    expect(() => store.setTrafficWeights(p.id, { [env.id]: 100 })).toThrow(ErrNotFound);
    expect(() => store.setTrafficWeights(p.id, { [k8s.id]: 100 }, stage.id)).toThrow(ErrNotFound);
    store.setTrafficWeights(p.id, { [env.id]: 100 }, stage.id);
    expect(store.getEnvironment(env.id).trafficWeight).toBe(100);
  });

  it("inSync is false while a stage host is missing, and reconcile re-pushes it", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    const sync = createEdgeSync(store, { adminUrl });
    await sync.push(p.id);
    expect(await sync.inSync(p.id)).toBe(true);
    const { stage, env } = withStaging(store, p.id);
    deployOk(store, env.id, "https://pabc-s-staging-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [env.id]: 100 }, stage.id);

    expect(await sync.inSync(p.id)).toBe(false);
    await sync.reconcile();
    expect(registry.get("staging--storefront.127.0.0.1.sslip.io")?.backends[0]?.weight).toBe(100);
    expect(await sync.inSync(p.id)).toBe(true);
  });

  it("a stage host the edge rejects doesn't fail Production's push; it is logged", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    const { stage, env } = withStaging(store, p.id);
    deployOk(store, env.id, "https://pabc-s-staging-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [env.id]: 100 }, stage.id);
    const sync = createEdgeSync(store, {
      adminUrl,
      fetch: async (input, init) => {
        if (init?.method === "PUT" && String(input).includes("staging--")) return new Response("nope", { status: 500 });
        return fetch(input, init);
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(sync.push(p.id)).resolves.toBeUndefined();
      expect(errors.mock.calls.some((c) => String(c[0]).includes("staging--storefront.127.0.0.1.sslip.io"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
    expect(registry.get("storefront.127.0.0.1.sslip.io")?.backends[0]?.weight).toBe(100);
  });

  it("push with stageHost also throws that stage's failure", async () => {
    const store = await openTestStore();
    const { adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    const { stage, env } = withStaging(store, p.id);
    deployOk(store, env.id, "https://pabc-s-staging-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [env.id]: 100 }, stage.id);
    const sync = createEdgeSync(store, {
      adminUrl,
      fetch: async (input, init) => {
        if (init?.method === "PUT" && String(input).includes("staging--")) return new Response("nope", { status: 500 });
        return fetch(input, init);
      },
    });
    await expect(sync.push(p.id, { stageHost: "staging--storefront.127.0.0.1.sslip.io" })).rejects.toThrow(
      "staging--storefront.127.0.0.1.sslip.io",
    );
  });

  it("Production's failure is still thrown, after the stages were tried", async () => {
    const store = await openTestStore();
    const { registry, adminUrl } = await startEdge();
    const { p, k8s } = await projectWithEnvs(store);
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [k8s.id]: 100 });
    const { stage, env } = withStaging(store, p.id);
    deployOk(store, env.id, "https://pabc-s-staging-k8s.127.0.0.1.sslip.io");
    store.setTrafficWeights(p.id, { [env.id]: 100 }, stage.id);
    const sync = createEdgeSync(store, {
      adminUrl,
      fetch: async (input, init) => {
        if (init?.method === "PUT" && String(input).endsWith("/targets/storefront.127.0.0.1.sslip.io"))
          return new Response("nope", { status: 500 });
        return fetch(input, init);
      },
    });
    await expect(sync.push(p.id)).rejects.toThrow("storefront.127.0.0.1.sslip.io");
    expect(registry.get("staging--storefront.127.0.0.1.sslip.io")?.backends[0]?.weight).toBe(100);
  });

  it("a Production-only project sends exactly what it sent before stages", async () => {
    const store = await openTestStore();
    const { adminUrl } = await startEdge();
    const { p, k8s, cr } = await projectWithEnvs(store);
    store.updateProject(p.id, { speedInsights: true, speedInsightsInject: false, speedInsightsSampleRate: 25 });
    deployOk(store, k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io");
    deployOk(store, cr.id, "https://pabc-cloudrun-xyz.a.run.app");
    store.setTrafficWeights(p.id, { [k8s.id]: 90, [cr.id]: 10 });
    const bodies: [string, string][] = [];
    await createEdgeSync(store, {
      adminUrl,
      fetch: async (input, init) => {
        if (init?.method === "PUT") bodies.push([String(input), String(init.body)]);
        return fetch(input, init);
      },
    }).push(p.id);
    expect(bodies).toEqual([
      [
        `${adminUrl}/targets/storefront.127.0.0.1.sslip.io`,
        JSON.stringify({
          backends: [
            { id: k8s.id, url: "https://pabc-k8s.127.0.0.1.sslip.io", weight: 90, insecureSkipVerify: true },
            { id: cr.id, url: "https://pabc-cloudrun-xyz.a.run.app", weight: 10, insecureSkipVerify: false },
          ],
          insights: { enabled: true, inject: false, sampleRate: 25 },
        }),
      ],
    ]);
  });
});
