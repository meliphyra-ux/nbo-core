// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serveFetch } from "@nbo/nodehost";
import { createAdminMux, createRegistry, type Registry } from "@nbo/edge";
import { createStore, type Store } from "../store.js";
import { createEdgeSync } from "../edge-sync.js";

// The edge keeps each visitor on one cloud by hashing their cookie id
// against each backend's stable key. The control-plane sends the
// environment id as that key: a backend's URL can change, its
// environment never does.

const openStores: Store[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of openStores.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-edgesticky-"));
  const store = createStore(join(dir, "test.db"));
  openStores.push(store);
  const registry: Registry = createRegistry();
  const server = await new Promise<Server>((resolve) => {
    const srv = serveFetch(createAdminMux(registry), { host: "127.0.0.1", port: 0 }, () => resolve(srv));
  });
  servers.push(server);
  const adminUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const p = store.createProject("storefront");
  store.updateProject(p.id, { edgeHost: "storefront.127.0.0.1.sslip.io" });
  const k8s = store.createEnvironment(p.id, "k8s", "kubernetes");
  const cr = store.createEnvironment(p.id, "cloudrun", "cloudrun");
  for (const [env, url] of [
    [k8s.id, "https://pabc-k8s.127.0.0.1.sslip.io"],
    [cr.id, "https://pabc-cloudrun-xyz.a.run.app"],
  ] as const) {
    const d = store.createDeployment(env);
    store.completeDeployment(d.id, "sha256:x", url);
  }
  store.setTrafficWeights(p.id, { [k8s.id]: 70, [cr.id]: 30 });
  return { store, registry, adminUrl, p, k8s, cr };
}

describe("edge sync sends stable backend ids", () => {
  it("push sends each environment's id with its backend", async () => {
    const { store, registry, adminUrl, p, k8s, cr } = await setup();
    await createEdgeSync(store, { adminUrl }).push(p.id);
    expect(registry.get("storefront.127.0.0.1.sslip.io")?.backends.map((b) => b.id)).toEqual([k8s.id, cr.id]);
  });

  it("an edge holding the split without ids (from before this change) is not in sync, so it gets re-pushed", async () => {
    const { store, registry, adminUrl, p } = await setup();
    const sync = createEdgeSync(store, { adminUrl });
    const desired = sync.desiredTarget(p.id)!;
    registry.set(
      desired.host,
      desired.backends.map(({ url, weight, insecureSkipVerify }) => ({ url, weight, insecureSkipVerify })),
    );
    expect(await sync.inSync(p.id)).toBe(false);
    await sync.push(p.id);
    expect(await sync.inSync(p.id)).toBe(true);
  });
});
