// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createRegistry } from "../registry.js";
import { createAdminMux } from "../admin.js";

const backends = [{ id: "env_a", url: "https://a", weight: 100 }];

function put(mux: ReturnType<typeof createAdminMux>, body: unknown) {
  return mux(new Request("http://admin/targets/app.test", { method: "PUT", body: JSON.stringify(body) }));
}

describe("admin: insights settings", () => {
  it("PUT with insights round-trips through GET", async () => {
    const mux = createAdminMux(createRegistry());
    const insights = { enabled: true, inject: false, sampleRate: 25 };
    expect((await put(mux, { backends, insights })).status).toBe(204);
    const target = await (await mux(new Request("http://admin/targets/app.test"))).json();
    expect(target.insights).toEqual(insights);
  });

  it("GET has no insights when the PUT had none", async () => {
    const mux = createAdminMux(createRegistry());
    await put(mux, { backends, insights: { enabled: true, inject: true, sampleRate: 100 } });
    await put(mux, { backends });
    const target = await (await mux(new Request("http://admin/targets/app.test"))).json();
    expect(target.insights).toBeUndefined();
  });

  it.each([
    ["a sample rate outside 100|50|25|10", { enabled: true, inject: true, sampleRate: 33 }],
    ["a missing field", { enabled: true, inject: true }],
    ["a non-boolean enabled", { enabled: "true", inject: true, sampleRate: 100 }],
    ["an unknown field", { enabled: true, inject: true, sampleRate: 100, extra: 1 }],
    ["a non-object", true],
  ])("rejects %s with 400", async (_name, insights) => {
    const mux = createAdminMux(createRegistry());
    expect((await put(mux, { backends, insights })).status).toBe(400);
  });

  it("GET /insights/drain is empty without an aggregator, and only GET is allowed", async () => {
    const mux = createAdminMux(createRegistry());
    expect(await (await mux(new Request("http://admin/insights/drain"))).json()).toEqual({ batches: [] });
    expect((await mux(new Request("http://admin/insights/drain", { method: "POST" }))).status).toBe(405);
  });
});
