// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createStore } from "../store.js";
import { createMux } from "../mux.js";

describe("createMux", () => {
  it("PUT then GET round-trips and reports state fresh", async () => {
    const mux = createMux(createStore());
    const body = JSON.stringify({
      body: Buffer.from("hello").toString("base64"),
      header: { "Content-Type": ["text/plain"] },
      revalidateSec: 300,
      expireSec: 86400,
    });

    const putResponse = await mux(new Request("http://isrcache/entries/k1", { method: "PUT", body }));
    expect(putResponse.status).toBe(204);

    const getResponse = await mux(new Request("http://isrcache/entries/k1"));
    expect(getResponse.status).toBe(200);
    const got = await getResponse.json();
    expect(got.state).toBe("fresh");
    expect(Buffer.from(got.body, "base64").toString("utf8")).toBe("hello");
  });

  it("GET of an unknown key is 404", async () => {
    const mux = createMux(createStore());

    const response = await mux(new Request("http://isrcache/entries/nope"));

    expect(response.status).toBe(404);
  });

  it("invalidate by tag removes a PUT entry", async () => {
    const mux = createMux(createStore());
    const body = JSON.stringify({
      body: Buffer.from("hello").toString("base64"),
      tags: ["blog"],
      revalidateSec: 300,
      expireSec: 86400,
    });
    await mux(new Request("http://isrcache/entries/k1", { method: "PUT", body }));

    const invResponse = await mux(
      new Request("http://isrcache/invalidate", { method: "POST", body: JSON.stringify({ tags: ["blog"] }) }),
    );
    expect(invResponse.status).toBe(204);

    const getResponse = await mux(new Request("http://isrcache/entries/k1"));
    expect(getResponse.status).toBe(404);
  });

  it("rejects a PUT body with an unknown field", async () => {
    const mux = createMux(createStore());
    const body = JSON.stringify({
      body: Buffer.from("hello").toString("base64"),
      unknownField: "x",
      revalidateSec: 300,
      expireSec: 86400,
    });

    const response = await mux(new Request("http://isrcache/entries/k1", { method: "PUT", body }));

    expect(response.status).toBe(400);
  });
});

describe("createMux health", () => {
  it("GET /healthz is 200 ok", async () => {
    const mux = createMux(createStore());
    const res = await mux(new Request("http://isrcache/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("createMux request limits", () => {
  it("answers 413 for a PUT body over the cap without storing it", async () => {
    const store = createStore();
    const mux = createMux(store, { maxBodyBytes: 100 });
    const body = JSON.stringify({ body: Buffer.alloc(500).toString("base64"), revalidateSec: 1, expireSec: 2 });
    const res = await mux(new Request("http://isrcache/entries/k", { method: "PUT", body }));
    expect(res.status).toBe(413);
    expect(store.get("k")).toBeUndefined();
  });

  it("stops reading a streamed body (no content-length) past the cap", async () => {
    const mux = createMux(createStore(), { maxBodyBytes: 100 });
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 50;
        controller.enqueue(new Uint8Array(50));
        if (pulled > 5000) controller.close();
      },
    });
    const res = await mux(
      new Request("http://isrcache/entries/k", { method: "PUT", body: stream, duplex: "half" } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(1000);
  });

  it.each([-1, "x", null])("rejects revalidateSec %s with 400", async (bad) => {
    const mux = createMux(createStore());
    const body = JSON.stringify({ body: "", revalidateSec: bad, expireSec: 10 });
    const res = await mux(new Request("http://isrcache/entries/k", { method: "PUT", body }));
    expect(res.status).toBe(400);
  });

  it("rejects a negative expireSec with 400", async () => {
    const mux = createMux(createStore());
    const body = JSON.stringify({ body: "", revalidateSec: 1, expireSec: -5 });
    const res = await mux(new Request("http://isrcache/entries/k", { method: "PUT", body }));
    expect(res.status).toBe(400);
  });
});
