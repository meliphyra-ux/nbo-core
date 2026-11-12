// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createRegistry } from "../registry.js";
import { createAdminMux } from "../admin.js";

// A backend's optional `id` is its stable key for keeping visitors on one
// cloud (the control-plane sends the environment id): its URL can change
// on a redeploy, its id never does.
describe("createAdminMux backend id", () => {
  it("PUT accepts an id per backend and GET returns it", async () => {
    const mux = createAdminMux(createRegistry());
    const body = JSON.stringify({
      backends: [
        { id: "env_a", url: "https://a", weight: 90 },
        { url: "https://b", weight: 10 },
      ],
    });
    expect((await mux(new Request("http://admin/targets/app.test", { method: "PUT", body }))).status).toBe(204);
    const target = await (await mux(new Request("http://admin/targets/app.test"))).json();
    expect(target.backends[0].id).toBe("env_a");
    expect(target.backends[1].id).toBeUndefined();
  });

  it("PUT rejects a non-string or empty id", async () => {
    const mux = createAdminMux(createRegistry());
    for (const id of [42, "", null]) {
      const body = JSON.stringify({ backends: [{ id, url: "https://a", weight: 1 }] });
      expect((await mux(new Request("http://admin/targets/app.test", { method: "PUT", body }))).status).toBe(400);
    }
  });

  it("PUT rejects two backends with the same id", async () => {
    const mux = createAdminMux(createRegistry());
    const body = JSON.stringify({
      backends: [
        { id: "x", url: "https://a", weight: 1 },
        { id: "x", url: "https://b", weight: 1 },
      ],
    });
    expect((await mux(new Request("http://admin/targets/app.test", { method: "PUT", body }))).status).toBe(400);
  });
});
