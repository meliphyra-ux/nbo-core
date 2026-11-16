// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CommandRunner } from "@nbo/deploy";
import { createStore } from "../../store/store.js";
import { createInsightsDrain, type DrainBatch, type VitalsRow } from "../drain.js";
import { createClusterDrainSource } from "../../edge/edge-table.js";
import { bucketIndex } from "../histogram.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0)) await c();
});

const TOKEN = "drain-token-0123456789abcdef";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-drain-cluster-"));
  const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  store.updateServerSettings({ edgeClusterId: "kc_edge" });
  store.setServerSecret("edge_drain_token", TOKEN);
  const p = store.createProject("storefront");
  store.updateProject(p.id, { edgeHost: "storefront.example.net" });
  const env = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: "kc_edge" }));
  return { store, p, env };
}

function batch(over: Partial<DrainBatch>): DrainBatch {
  return {
    host: "storefront.example.net",
    environmentId: "",
    contentId: "",
    route: "/",
    metric: "LCP",
    device: "mobile",
    minute: "2026-11-03T10:15:00.000Z",
    buckets: { [bucketIndex(2000)]: 1 },
    count: 1,
    ...over,
  };
}

const sink = {
  writes: [] as VitalsRow[][],
  rows: () => sink.writes.flat(),
  sink: { write: async (r: VitalsRow[]) => void sink.writes.push(r) },
};

const pods = JSON.stringify({
  items: [
    { metadata: { name: "nbo-edge-a" }, status: { phase: "Running" } },
    { metadata: { name: "nbo-edge-b" }, status: { phase: "Running" } },
  ],
});

describe("cluster drain source", () => {
  it("drains every edge pod through the API server proxy, skipping a failing pod (logged once, token redacted)", async () => {
    const { store, env } = await setup();
    sink.writes.length = 0;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[][] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      const line = args.join(" ");
      if (line.includes("get pods -l app=nbo-edge -o json")) return pods;
      if (line.includes("/pods/nbo-edge-a:9444/proxy/insights/drain"))
        throw new Error(`kubectl ${line} failed: Error from server (ServiceUnavailable)`);
      if (line.includes("/pods/nbo-edge-b:9444/proxy/insights/drain")) {
        return JSON.stringify({
          batches: [batch({ environmentId: env.id }), batch({ environmentId: env.id, route: "/b" })],
        });
      }
      throw new Error(`unexpected ${line}`);
    };
    const kubeconfigs: string[] = [];
    const source = createClusterDrainSource({ store, run, kubeconfigFor: async (id) => (kubeconfigs.push(id), "kc") });
    const drain = createInsightsDrain(store, { sink: sink.sink, source });

    await drain.once();
    await drain.once();

    expect(kubeconfigs[0]).toBe("kc_edge");
    const listCall = calls.find((a) => a.join(" ").includes("get pods"))!;
    expect(listCall).toEqual(expect.arrayContaining(["-n", "nbo-edge", "-l", "app=nbo-edge"]));
    const raw = calls.find((a) => a.includes("--raw") && a.join(" ").includes("nbo-edge-b"))!;
    expect(raw[raw.indexOf("--raw") + 1]).toBe(
      `/api/v1/namespaces/nbo-edge/pods/nbo-edge-b:9444/proxy/insights/drain?token=${TOKEN}`,
    );
    const rows = sink.rows();
    expect(rows.map((r) => [r.route, r.count]).sort()).toEqual([
      ["/", 1],
      ["/", 1],
      ["/b", 1],
      ["/b", 1],
    ]);
    const logged = errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("nbo-edge-a"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain(TOKEN);
  });

  it("returns nothing (no kubectl calls) without an edge cluster", async () => {
    const { store } = await setup();
    store.updateServerSettings({ edgeClusterId: "" });
    const calls: string[][] = [];
    const run: CommandRunner = async (_c, args) => (calls.push(args), "{}");
    const source = createClusterDrainSource({ store, run, kubeconfigFor: async () => "kc" });
    expect(await source()).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
