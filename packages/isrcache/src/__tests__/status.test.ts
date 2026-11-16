// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createStore } from "../store.js";
import { createMux } from "../mux.js";

// The cache keeps a render's status, so 404s and redirects come back as
// they were rendered.
describe("isrcache entry status", () => {
  it("PUT with a status, GET returns it", async () => {
    const mux = createMux(createStore());
    const body = JSON.stringify({
      body: Buffer.from("gone").toString("base64"),
      status: 404,
      revalidateSec: 60,
      expireSec: 600,
    });
    expect((await mux(new Request("http://c/entries/k", { method: "PUT", body }))).status).toBe(204);
    const got = await (await mux(new Request("http://c/entries/k"))).json();
    expect(got.status).toBe(404);
  });

  it("an entry without a status reads back with none", async () => {
    const mux = createMux(createStore());
    const body = JSON.stringify({ body: Buffer.from("x").toString("base64"), revalidateSec: 60, expireSec: 600 });
    await mux(new Request("http://c/entries/k", { method: "PUT", body }));
    const got = await (await mux(new Request("http://c/entries/k"))).json();
    expect(got.status).toBeUndefined();
  });

  it("PUT rejects a status that is not an integer from 200 to 599", async () => {
    const mux = createMux(createStore());
    for (const status of [199, 600, 20.5, "404"]) {
      const body = JSON.stringify({ body: "", status, revalidateSec: 60, expireSec: 600 });
      expect((await mux(new Request("http://c/entries/k", { method: "PUT", body }))).status).toBe(400);
    }
  });
});
