// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serveFetch } from "@nbo/nodehost";
import { createStore, type Store } from "../store.js";
import { main } from "../main.js";
import { createInsightsDrain, startInsightsDrain, type DrainBatch, type InsightsSink, type VitalsRow } from "../insights/drain.js";
import { bucketIndex } from "../insights/histogram.js";

// collect is a fake sink: every write is kept; rows() is all rows written.
function collect(failFirst = 0): { sink: InsightsSink; writes: VitalsRow[][]; rows(): VitalsRow[] } {
  const writes: VitalsRow[][] = [];
  let failures = failFirst;
  return {
    writes,
    rows: () => writes.flat(),
    sink: {
      async write(rows) {
        if (failures > 0) {
          failures--;
          throw new Error("sink is down");
        }
        writes.push(rows);
      },
    },
  };
}
let sink = collect();
beforeEach(() => {
  sink = collect();
});

const openStores: Store[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of openStores.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-insights-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

// fakeEdge serves GET /insights/drain from a queue of responses.
async function fakeEdge(responses: (() => Response)[]): Promise<{ adminUrl: string; calls: string[] }> {
  const calls: string[] = [];
  const server = await new Promise<Server>((resolve) => {
    const srv = serveFetch(
      async (req) => {
        const url = new URL(req.url);
        calls.push(`${req.method} ${url.pathname}`);
        if (req.method === "GET" && url.pathname === "/insights/drain") {
          const next = responses.shift();
          return next ? next() : Response.json({ batches: [] });
        }
        return new Response("not found", { status: 404 });
      },
      { host: "127.0.0.1", port: 0 },
      () => resolve(srv),
    );
  });
  servers.push(server);
  return { adminUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

async function project(store: Store) {
  const p = store.createProject("storefront");
  store.updateProject(p.id, { edgeHost: "storefront.127.0.0.1.sslip.io" });
  const env = store.createEnvironment(p.id, "k8s", "kubernetes");
  const build = store.createBuild(p.id, "a".repeat(40));
  store.setBuildDetails(build.id, { contentId: "sha256:abc" });
  return { p, env, build };
}

function batch(over: Partial<DrainBatch>): DrainBatch {
  return {
    host: "storefront.127.0.0.1.sslip.io",
    environmentId: "",
    contentId: "sha256:abc",
    route: "/",
    metric: "LCP",
    device: "mobile",
    minute: "2026-11-03T10:15:00.000Z",
    buckets: { [bucketIndex(2000)]: 2 },
    count: 2,
    ...over,
  };
}

describe("insights drain", () => {
  it("maps host and content id, merges minutes into one hourly row", async () => {
    const store = await openTestStore();
    const { p, env, build } = await project(store);
    const { adminUrl } = await fakeEdge([
      () =>
        Response.json({
          batches: [
            batch({ environmentId: env.id }),
            batch({ environmentId: env.id, minute: "2026-11-03T10:47:00.000Z", buckets: { [bucketIndex(3000)]: 1 }, count: 1 }),
            batch({ environmentId: env.id, contentId: "sha256:unknown", metric: "CLS", buckets: { "0": 1 }, count: 1 }),
          ],
        }),
      () => Response.json({ batches: [batch({ environmentId: env.id, minute: "2026-11-03T10:59:00.000Z", buckets: { [bucketIndex(2000)]: 1 }, count: 1 })] }),
    ]);
    const drain = createInsightsDrain(store, { sink: sink.sink, adminUrl });

    await drain.once();
    await drain.once();

    // Each tick is one write; minutes of one hour merge within a tick, and
    // the sink adds ticks together.
    expect(sink.writes).toHaveLength(2);
    const rows = sink.writes[0]!;
    const lcp = rows.find((r) => r.metric === "LCP")!;
    expect(lcp).toMatchObject({ projectId: p.id, environmentId: env.id, buildId: build.id, route: "/", device: "mobile", hour: "2026-11-03T10:00:00.000Z", count: 3 });
    expect(lcp.histogram).toEqual({ [bucketIndex(2000)]: 2, [bucketIndex(3000)]: 1 });
    const cls = rows.find((r) => r.metric === "CLS")!;
    expect(cls.buildId).toBe("");
    expect(rows).toHaveLength(2);
    expect(sink.writes[1]).toHaveLength(1);
    expect(sink.writes[1]![0]).toMatchObject({ count: 1, histogram: { [bucketIndex(2000)]: 1 } });
  });

  it("without a known content id, uses the environment's live build at drain time", async () => {
    const store = await openTestStore();
    const { p, env } = await project(store);
    const live = store.createBuild(p.id, "b".repeat(40));
    store.setBuildDetails(live.id, { contentId: "sha256:live" });
    const d = store.createDeployment(env.id, { buildId: live.id });
    store.completeDeployment(d.id, "sha256:live", "https://pabc-k8s.127.0.0.1.sslip.io");
    const bare = store.createEnvironment(p.id, "cloudrun", "cloudrun");
    const { adminUrl } = await fakeEdge([
      () =>
        Response.json({
          batches: [
            batch({ environmentId: env.id, contentId: "", route: "/empty" }),
            batch({ environmentId: env.id, contentId: "sha256:unknown", route: "/unknown" }),
            batch({ environmentId: env.id, contentId: "sha256:abc", route: "/known" }),
            batch({ environmentId: bare.id, contentId: "", route: "/nolive" }),
          ],
        }),
    ]);
    await createInsightsDrain(store, { sink: sink.sink, adminUrl }).once();
    const byRoute = Object.fromEntries(sink.rows().map((r) => [r.route, r.buildId]));
    expect(byRoute).toEqual({ "/empty": live.id, "/unknown": live.id, "/known": (await store.listBuilds(p.id)).find((b) => b.contentId === "sha256:abc")!.id, "/nolive": "" });
  });

  it("a beacon with the live build's content id goes to the live build, even when a newer build shares it", async () => {
    const store = await openTestStore();
    const { p, env, build: first } = await project(store);
    const newer = store.createBuild(p.id, "c".repeat(40));
    store.setBuildDetails(newer.id, { contentId: "sha256:abc" });
    const d = store.createDeployment(env.id, { buildId: first.id });
    store.completeDeployment(d.id, "sha256:abc", "https://pabc-k8s.127.0.0.1.sslip.io");
    const { adminUrl } = await fakeEdge([() => Response.json({ batches: [batch({ environmentId: env.id })] })]);
    await createInsightsDrain(store, { sink: sink.sink, adminUrl }).once();
    const rows = sink.rows();
    expect(rows.map((r) => r.buildId)).toEqual([first.id]);
  });

  it("a beacon whose id matches a non-live build goes to that build; an empty id falls back to the live one", async () => {
    const store = await openTestStore();
    const { p, env, build: old } = await project(store);
    const live = store.createBuild(p.id, "d".repeat(40));
    store.setBuildDetails(live.id, { contentId: "sha256:live" });
    const d = store.createDeployment(env.id, { buildId: live.id });
    store.completeDeployment(d.id, "sha256:live", "https://pabc-k8s.127.0.0.1.sslip.io");
    const { adminUrl } = await fakeEdge([
      () => Response.json({ batches: [batch({ environmentId: env.id, route: "/old" }), batch({ environmentId: env.id, contentId: "", route: "/bare" })] }),
    ]);
    await createInsightsDrain(store, { sink: sink.sink, adminUrl }).once();
    const byRoute = Object.fromEntries(sink.rows().map((r) => [r.route, r.buildId]));
    expect(byRoute).toEqual({ "/old": old.id, "/bare": live.id });
  });

  it("drops unknown hosts, foreign environments and malformed batches", async () => {
    const store = await openTestStore();
    const { p, env } = await project(store);
    const other = store.createProject("other");
    const otherEnv = store.createEnvironment(other.id, "k8s", "kubernetes");
    const { adminUrl } = await fakeEdge([
      () =>
        Response.json({
          batches: [
            batch({ host: "nobody.example", environmentId: env.id }),
            batch({ environmentId: otherEnv.id }),
            batch({ environmentId: env.id, metric: "XYZ" as never }),
            batch({ environmentId: env.id, device: "tablet" as never }),
            batch({ environmentId: env.id, minute: "not a date" }),
            batch({ environmentId: env.id, buckets: { "-1": 2 } }),
            batch({ environmentId: env.id, route: "/ok" }),
            batch({ environmentId: env.id, route: "/caps", host: "StoreFront.127.0.0.1.SSLIP.io" }),
          ],
        }),
    ]);
    await createInsightsDrain(store, { sink: sink.sink, adminUrl }).once();
    const rows = sink.rows();
    expect(rows.map((r) => r.route)).toEqual(["/ok", "/caps"]);
  });

  it("an edge without the route or an unreachable edge is a quiet no-op, logged once", async () => {
    const store = await openTestStore();
    await project(store);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { adminUrl } = await fakeEdge([() => new Response("not found", { status: 404 }), () => new Response("not found", { status: 404 })]);
    const drain = createInsightsDrain(store, { sink: sink.sink, adminUrl });
    await drain.once();
    await drain.once();
    expect(errors).toHaveBeenCalledTimes(1);

    const gone = createInsightsDrain(store, { sink: sink.sink, adminUrl: "http://127.0.0.1:1" });
    await gone.once();
    await gone.once();
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it("a sink that throws loses that batch and the next tick runs", async () => {
    const store = await openTestStore();
    const { env } = await project(store);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = collect(1);
    const { adminUrl, calls } = await fakeEdge([
      () => Response.json({ batches: [batch({ environmentId: env.id, route: "/lost" })] }),
      () => Response.json({ batches: [batch({ environmentId: env.id, route: "/kept" })] }),
    ]);
    const drain = createInsightsDrain(store, { sink: flaky.sink, adminUrl });
    await drain.once();
    await drain.once();
    expect(calls).toHaveLength(2);
    expect(flaky.rows().map((r) => r.route)).toEqual(["/kept"]);
    expect(errors.mock.calls.map((c) => String(c[0])).some((m) => m.includes("sink is down"))).toBe(true);
  });

  it("an empty tick writes nothing", async () => {
    const store = await openTestStore();
    await project(store);
    const { adminUrl } = await fakeEdge([]);
    await createInsightsDrain(store, { sink: sink.sink, adminUrl }).once();
    expect(sink.writes).toEqual([]);
  });

  it("without a sink nothing starts and the edge's drain endpoint is never called", async () => {
    const store = await openTestStore();
    await project(store);
    const stop = new AbortController();
    const source = vi.fn(async () => [] as unknown[]);
    expect(startInsightsDrain(store, undefined, { source }, stop.signal)).toBeUndefined();
    expect(startInsightsDrain(store, sink.sink, { source, intervalMs: 5 }, stop.signal)).toBeInstanceOf(Promise);
    await new Promise((r) => setTimeout(r, 40));
    stop.abort();
    expect(source).toHaveBeenCalled();
  });

  it("main drains the edge only when it is given a sink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-insights-main-"));
    const env = (adminUrl: string, db: string) => ({
      NBO_CONTROL_PLANE_DB: join(dir, db),
      NBO_CONTROL_PLANE_ADDR: "127.0.0.1:0",
      NBO_EDGE_ADMIN_URL: adminUrl,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bare = await fakeEdge([]);
    const a = main(env(bare.adminUrl, "a.db"));
    await a!.listening;
    await new Promise((r) => setTimeout(r, 300));
    await a!.close();
    expect(bare.calls).not.toContain("GET /insights/drain");

    const withSink = await fakeEdge([]);
    const b = main(env(withSink.adminUrl, "b.db"), { insightsSink: sink.sink });
    await b!.listening;
    await new Promise((r) => setTimeout(r, 300));
    await b!.close();
    expect(withSink.calls).toContain("GET /insights/drain");
  });

  it("run loop stops on abort", async () => {
    const store = await openTestStore();
    const { adminUrl, calls } = await fakeEdge([]);
    const stop = new AbortController();
    const done = createInsightsDrain(store, { sink: sink.sink, adminUrl, intervalMs: 10 }).run(stop.signal);
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await done;
    expect(calls.length).toBeGreaterThan(1);
  });

  it("a project can be deleted: there is no vitals table in core", async () => {
    const store = await openTestStore();
    const { p } = await project(store);
    store.deleteProject(p.id);
    expect(store.listProjects()).toEqual([]);
  });
});

describe("insights drain and stages", () => {
  it("doesn't attribute beacons for a stage's host or domain (Speed Insights is Production only)", async () => {
    const store = await openTestStore();
    const { p, env } = await project(store);
    const stage = store.createStage(p.id, { name: "staging", branch: "staging", host: "staging--storefront.127.0.0.1.sslip.io" });
    const staging = store.createEnvironment(p.id, "s-staging-k8s", "kubernetes", "{}", stage.id);
    store.addDomain(p.id, "staging.acme.com", "custom", "edge", stage.id);
    const { adminUrl } = await fakeEdge([
      () =>
        Response.json({
          batches: [
            batch({ host: "staging--storefront.127.0.0.1.sslip.io", environmentId: staging.id, route: "/stage-host" }),
            batch({ host: "staging.acme.com", environmentId: staging.id, route: "/stage-domain" }),
            batch({ environmentId: env.id, route: "/production" }),
          ],
        }),
    ]);
    await createInsightsDrain(store, { sink: sink.sink, adminUrl }).once();
    expect(sink.rows().map((r) => r.route)).toEqual(["/production"]);
  });
});
