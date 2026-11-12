// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { handleBeacon } from "../insights/beacon.js";
import { createAggregator } from "../insights/aggregator.js";
import type { Target } from "../registry.js";
import { pickSticky, VISITOR_COOKIE } from "../sticky.js";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const target: Target = {
  host: "app.test",
  backends: [
    { id: "env_a", url: "http://a", weight: 50, insecureSkipVerify: false },
    { id: "env_b", url: "http://b", weight: 50, insecureSkipVerify: false },
  ],
  insights: { enabled: true, inject: true, sampleRate: 100 },
};

function beacon(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("http://app.test/_nbo/insights/v1/vitals", {
    method,
    headers: { "user-agent": CHROME, "content-type": "text/plain;charset=UTF-8", ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

const good = { metric: "LCP", value: 1234.5, route: "/users/42", device: "mobile", environmentId: "env_a", contentId: "sha256:abc" };

describe("handleBeacon", () => {
  it("refuses a beacon over the host's rate before reading its body", async () => {
    let now = Date.UTC(2026, 10, 3, 10, 0, 0);
    const agg = createAggregator({ now: () => now, maxBeaconsPerHostSecond: 2 });
    for (let i = 0; i < 2; i++) expect((await handleBeacon(beacon(good), target, agg)).status).toBe(204);
    let read = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        read = true;
        c.enqueue(new TextEncoder().encode(JSON.stringify(good)));
        c.close();
      },
    });
    const over = new Request("http://app.test/_nbo/insights/v1/vitals", { method: "POST", headers: { "user-agent": CHROME }, body, duplex: "half" } as RequestInit);
    expect((await handleBeacon(over, target, agg)).status).toBe(204);
    expect(read).toBe(false);
    expect(agg.stats().dropped).toBe(1);
    expect(agg.drain().batches[0]!.count).toBe(2);
    now += 1000;
    expect((await handleBeacon(beacon(good), target, agg)).status).toBe(204);
    expect(agg.drain().batches[0]!.count).toBe(1);
  });

  it("accepts a well-formed beacon with 204 and aggregates it under the normalised route", async () => {
    const agg = createAggregator();
    const res = await handleBeacon(beacon(good), target, agg);
    expect(res.status).toBe(204);
    const [b] = agg.drain().batches;
    expect(b).toMatchObject({ host: "app.test", environmentId: "env_a", contentId: "sha256:abc", route: "/users/[id]", metric: "LCP", device: "mobile", count: 1 });
  });

  it("is 404 when the host has insights off", async () => {
    const agg = createAggregator();
    expect((await handleBeacon(beacon(good), { ...target, insights: undefined }, agg)).status).toBe(404);
    expect((await handleBeacon(beacon(good), { ...target, insights: { enabled: false, inject: true, sampleRate: 100 } }, agg)).status).toBe(404);
  });

  it("is 405 for anything but POST", async () => {
    expect((await handleBeacon(beacon(undefined, {}, "GET"), target, createAggregator())).status).toBe(405);
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", [good]],
    ["an unknown metric", { ...good, metric: "FID" }],
    ["a string value", { ...good, value: "12" }],
    ["a negative value", { ...good, value: -1 }],
    ["a value over 120 s", { ...good, value: 120_001 }],
    ["a CLS over 10", { ...good, metric: "CLS", value: 10.5 }],
    ["a route over 200 characters", { ...good, route: "/" + "a".repeat(200) }],
    ["a route that is not a path", { ...good, route: "https://x/y" }],
    ["a bad device", { ...good, device: "tablet" }],
    ["a non-string environment", { ...good, environmentId: 5 }],
    ["an odd content id", { ...good, contentId: "<script>" }],
    ["a body over 2 KB", { ...good, pad: "x".repeat(2100) }],
  ])("is 400 for %s", async (_name, body) => {
    const agg = createAggregator();
    expect((await handleBeacon(beacon(body), target, agg)).status).toBe(400);
    expect(agg.drain().batches).toHaveLength(0);
  });

  it("drops an environment that does not belong to the host, still with 204", async () => {
    const agg = createAggregator();
    expect((await handleBeacon(beacon({ ...good, environmentId: "env_zzz" }), target, agg)).status).toBe(204);
    expect(agg.drain().batches).toHaveLength(0);
  });

  it.each(["Googlebot/2.1", "Mozilla/5.0 (X11) HeadlessChrome/130.0", "Mozilla/5.0 Chrome-Lighthouse", "", "Mozilla/5.0 (compatible; bingbot/2.0)"])(
    "drops bot user-agent %j with 204",
    async (ua) => {
      const agg = createAggregator();
      expect((await handleBeacon(beacon(good, { "user-agent": ua }), target, agg)).status).toBe(204);
      expect(agg.drain().batches).toHaveLength(0);
    },
  );

  it("without an environment, uses the visitor's sticky backend; without a cookie, drops", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const expected = pickSticky(target, id).id;
    const agg = createAggregator();
    const { environmentId: _e, contentId: _c, ...manual } = good;
    expect((await handleBeacon(beacon(manual, { cookie: `${VISITOR_COOKIE}=${id}` }), target, agg)).status).toBe(204);
    expect((await handleBeacon(beacon(manual), target, agg)).status).toBe(204);
    const batches = agg.drain().batches;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ environmentId: expected, contentId: "" });
  });

  it('accepts a backend without an id as environment ""', async () => {
    const agg = createAggregator();
    const t: Target = { ...target, backends: [{ url: "http://a", weight: 1, insecureSkipVerify: false }] };
    expect((await handleBeacon(beacon({ ...good, environmentId: "" }), t, agg)).status).toBe(204);
    expect(agg.drain().batches[0]!.environmentId).toBe("");
  });

  it("refuses a declared content-length over 2 KB before reading the body", async () => {
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const req = new Request("http://app.test/_nbo/insights/v1/vitals", {
      method: "POST",
      headers: { "user-agent": CHROME, "content-length": "5000" },
      body: never,
      duplex: "half",
    } as RequestInit);
    expect((await handleBeacon(req, target, createAggregator())).status).toBe(400);
  });
});
