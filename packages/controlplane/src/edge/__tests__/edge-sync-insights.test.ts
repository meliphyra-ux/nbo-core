// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serveFetch } from "@nbo/nodehost";
import { createStore, type Store } from "../../store/store.js";
import { createEdgeSync } from "../edge-sync.js";

const openStores: Store[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of openStores.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

// fakeAdmin stores each PUT body as the host's target and returns it on GET,
// as an edge with insights support does.
async function fakeAdmin() {
  const targets = new Map<string, Record<string, unknown>>();
  const server = await new Promise<Server>((resolve) => {
    const srv = serveFetch(
      async (req) => {
        const host = decodeURIComponent(new URL(req.url).pathname.replace(/^\/targets\//, ""));
        if (req.method === "PUT") {
          targets.set(host, (await req.json()) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        const t = targets.get(host);
        return t ? Response.json(t) : new Response("no", { status: 404 });
      },
      { host: "127.0.0.1", port: 0 },
      () => resolve(srv),
    );
  });
  servers.push(server);
  return { targets, adminUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-edgesync-insights-"));
  const store = createStore(join(dir, "test.db"));
  openStores.push(store);
  const p = store.createProject("storefront");
  store.updateProject(p.id, { edgeHost: "storefront.127.0.0.1.sslip.io" });
  const env = store.createEnvironment(p.id, "k8s", "kubernetes");
  const d = store.createDeployment(env.id);
  store.completeDeployment(d.id, "sha256:x", "https://pabc-k8s.127.0.0.1.sslip.io");
  store.setTrafficWeights(p.id, { [env.id]: 100 });
  return { store, p };
}

describe("edge sync: Speed Insights settings", () => {
  it("a disabled project never sends insights", async () => {
    const { store, p } = await setup();
    const { targets, adminUrl } = await fakeAdmin();
    const sync = createEdgeSync(store, { adminUrl });
    expect(sync.desiredTarget(p.id)?.insights).toBeUndefined();
    await sync.push(p.id);
    expect(Object.keys(targets.get("storefront.127.0.0.1.sslip.io")!)).toEqual(["backends"]);
    expect(await sync.inSync(p.id)).toBe(true);
  });

  it("an enabled project sends its settings and inSync compares them", async () => {
    const { store, p } = await setup();
    const { targets, adminUrl } = await fakeAdmin();
    const sync = createEdgeSync(store, { adminUrl });
    await sync.push(p.id);
    store.updateProject(p.id, { speedInsights: true, speedInsightsInject: false, speedInsightsSampleRate: 25 });
    expect(await sync.inSync(p.id)).toBe(false);
    await sync.push(p.id);
    expect(targets.get("storefront.127.0.0.1.sslip.io")!.insights).toEqual({
      enabled: true,
      inject: false,
      sampleRate: 25,
    });
    expect(await sync.inSync(p.id)).toBe(true);

    store.updateProject(p.id, { speedInsightsSampleRate: 10 });
    expect(await sync.inSync(p.id)).toBe(false);

    store.updateProject(p.id, { speedInsights: false });
    expect(await sync.inSync(p.id)).toBe(false);
    await sync.push(p.id);
    expect(targets.get("storefront.127.0.0.1.sslip.io")!.insights).toBeUndefined();
    expect(await sync.inSync(p.id)).toBe(true);
  });
});
