// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createRegistry } from "../registry.js";
import { createAdminMux } from "../admin.js";

describe("createAdminMux", () => {
  it("PUT then GET round-trips", async () => {
    const mux = createAdminMux(createRegistry());
    const body = JSON.stringify({
      backends: [
        { url: "https://a", weight: 90 },
        { url: "https://b", weight: 10 },
      ],
    });

    const putResponse = await mux(new Request("http://admin/targets/app.test", { method: "PUT", body }));
    expect(putResponse.status).toBe(204);

    const getResponse = await mux(new Request("http://admin/targets/app.test"));
    expect(getResponse.status).toBe(200);
    const target = await getResponse.json();
    expect(target.backends).toHaveLength(2);
  });

  it("DELETE removes a target, and deleting an unknown host is still 204", async () => {
    const mux = createAdminMux(createRegistry());
    await mux(new Request("http://admin/targets/app.test", { method: "PUT", body: JSON.stringify({ backends: [{ url: "https://a", weight: 100 }] }) }));

    expect((await mux(new Request("http://admin/targets/app.test", { method: "DELETE" }))).status).toBe(204);
    expect((await mux(new Request("http://admin/targets/app.test"))).status).toBe(404);
    expect((await mux(new Request("http://admin/targets/app.test", { method: "DELETE" }))).status).toBe(204);
  });

  it("GET of an unknown host is 404", async () => {
    const mux = createAdminMux(createRegistry());

    const response = await mux(new Request("http://admin/targets/nope.test"));

    expect(response.status).toBe(404);
  });

  it("PUT with an invalid weight configuration is 400", async () => {
    const mux = createAdminMux(createRegistry());
    const body = JSON.stringify({ backends: [{ url: "https://a", weight: -1 }] });

    const response = await mux(new Request("http://admin/targets/app.test", { method: "PUT", body }));

    expect(response.status).toBe(400);
  });

  it("PUT with a misspelled backend field is 400, not silently accepted as a missing field", async () => {
    const mux = createAdminMux(createRegistry());
    // A second, correctly-weighted backend keeps the total weight
    // positive, isolating this test from the all-zero-weight rejection
    // — the misspelled "wieght" alone must be what fails this.
    const body = JSON.stringify({
      backends: [
        { url: "https://a", wieght: 100 },
        { url: "https://b", weight: 1 },
      ],
    });

    const response = await mux(new Request("http://admin/targets/app.test", { method: "PUT", body }));

    expect(response.status).toBe(400);
  });

  // Final-review finding I4: Boolean(raw.insecureSkipVerify) turns the
  // STRING "false" into the boolean true, silently disabling TLS
  // verification for a backend an operator plainly intended to keep
  // strict. Go's own typed bool decode rejects this with 400.
  it("PUT rejects a non-boolean insecureSkipVerify instead of coercing it", async () => {
    const mux = createAdminMux(createRegistry());
    const body = JSON.stringify({ backends: [{ url: "https://a", weight: 1, insecureSkipVerify: "false" }] });

    const response = await mux(new Request("http://admin/targets/app.test", { method: "PUT", body }));

    expect(response.status).toBe(400);
  });

  // Final-review finding I4: a fractional weight (0.5/0.5) makes
  // pick's own Math.floor(Math.random() * total) always resolve to
  // index 0 for a two-backend split, so the second backend never
  // gets picked at all — a silent, total loss of the configured
  // split rather than the clear rejection Go's typed int decode gives.
  it("PUT rejects a non-integer weight instead of silently breaking the split", async () => {
    const mux = createAdminMux(createRegistry());
    const body = JSON.stringify({
      backends: [
        { url: "https://a", weight: 0.5 },
        { url: "https://b", weight: 0.5 },
      ],
    });

    const response = await mux(new Request("http://admin/targets/app.test", { method: "PUT", body }));

    expect(response.status).toBe(400);
  });
});

describe("createAdminMux route-table-only fields", () => {
  const put = (body: unknown) =>
    createAdminMux(createRegistry())(new Request("http://admin/targets/app.test", { method: "PUT", body: JSON.stringify(body) }));
  const backend = { url: "https://a", weight: 100 };

  it("rejects a backend with via", async () => {
    const via = { url: "https://r", caPem: "PEM", token: "t" };
    expect((await put({ backends: [{ ...backend, via }] })).status).toBe(400);
  });
  it("rejects tls and redirectHttps on the body", async () => {
    expect((await put({ backends: [backend], tls: "s" })).status).toBe(400);
    expect((await put({ backends: [backend], redirectHttps: true })).status).toBe(400);
  });
});
