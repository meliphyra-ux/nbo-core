// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Black-box: the dev-mode admin API (PUT/GET/DELETE /targets/{host}, drain).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPut, send, startEdge, type RunningEdge } from "./harness.js";

describe("black-box: dev admin API", () => {
  let edge: RunningEdge;
  beforeAll(async () => {
    edge = await startEdge({ mode: "dev" });
  }, 30_000);
  afterAll(async () => {
    await edge?.stop();
  });

  const target = (host: string, method = "GET") => send(`${edge.adminUrl}/targets/${host}`, { method });

  it("PUT then GET round-trips the target as JSON, normalising the host", async () => {
    const put = await adminPut(edge.adminUrl, "App.Test", {
      backends: [
        { id: "env_a", url: "https://a.example", weight: 90 },
        { url: "http://b.example:8080/base", weight: 10, insecureSkipVerify: true },
      ],
      insights: { enabled: true, inject: false, sampleRate: 25 },
    });
    expect(put.status).toBe(204);
    expect(put.body).toBe("");

    const got = await target("app.test");
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(got.body)).toEqual({
      host: "app.test",
      backends: [
        { id: "env_a", url: "https://a.example", weight: 90, insecureSkipVerify: false },
        { url: "http://b.example:8080/base", weight: 10, insecureSkipVerify: true },
      ],
      insights: { enabled: true, inject: false, sampleRate: 25 },
    });
  });

  it("GET of an unknown host is 404 with the edge's text", async () => {
    const r = await target("nope.test");
    expect(r.status).toBe(404);
    expect(r.body).toBe("edge: no target registered for host nope.test");
  });

  it("DELETE removes a target, and deleting an unknown host is still 204", async () => {
    await adminPut(edge.adminUrl, "del.test", { backends: [{ url: "https://a", weight: 100 }] });
    expect((await target("del.test", "DELETE")).status).toBe(204);
    expect((await target("del.test")).status).toBe(404);
    expect((await target("del.test", "DELETE")).status).toBe(204);
  });

  it("answers 405 for other methods and 404 for other paths", async () => {
    expect((await target("x.test", "POST")).status).toBe(405);
    expect((await send(`${edge.adminUrl}/`)).status).toBe(404);
    expect((await send(`${edge.adminUrl}/targets/`)).status).toBe(404);
    expect((await send(`${edge.adminUrl}/other`)).status).toBe(404);
  });

  it("serves an empty drain in dev mode, GET only, with no token needed", async () => {
    const r = await send(`${edge.adminUrl}/insights/drain`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ batches: [] });
    expect((await send(`${edge.adminUrl}/insights/drain`, { method: "POST" })).status).toBe(405);
  });

  const backend = { url: "https://a", weight: 100 };
  const badBodies: [string, unknown][] = [
    ["not JSON", "{not json"],
    ["an array body", [backend]],
    ["no backends", {}],
    ["backends not an array", { backends: backend }],
    ["an unknown top-level field", { backends: [backend], extra: 1 }],
    ["a negative weight", { backends: [{ url: "https://a", weight: -1 }] }],
    ["all weights zero", { backends: [{ url: "https://a", weight: 0 }] }],
    ["no backends at all (total 0)", { backends: [] }],
    [
      "a misspelled backend field",
      {
        backends: [
          { url: "https://a", wieght: 100 },
          { url: "https://b", weight: 1 },
        ],
      },
    ],
    ["a string insecureSkipVerify", { backends: [{ url: "https://a", weight: 1, insecureSkipVerify: "false" }] }],
    [
      "a fractional weight",
      {
        backends: [
          { url: "https://a", weight: 0.5 },
          { url: "https://b", weight: 0.5 },
        ],
      },
    ],
    ["a string weight", { backends: [{ url: "https://a", weight: "1" }] }],
    ["a missing url", { backends: [{ weight: 1 }] }],
    ["a non-http url", { backends: [{ url: "ftp://a", weight: 1 }] }],
    ["an unparseable url", { backends: [{ url: "not a url", weight: 1 }] }],
    ["an empty id", { backends: [{ id: "", url: "https://a", weight: 1 }] }],
    [
      "a duplicate id",
      {
        backends: [
          { id: "e", url: "https://a", weight: 1 },
          { id: "e", url: "https://b", weight: 1 },
        ],
      },
    ],
    ["a backend with via", { backends: [{ ...backend, via: { url: "https://r", caPem: "PEM", token: "t" } }] }],
    ["tls on the body", { backends: [backend], tls: "s" }],
    ["redirectHttps on the body", { backends: [backend], redirectHttps: true }],
    ["cloudflare on the body", { backends: [backend], cloudflare: true }],
    [
      "insights with a bad sample rate",
      { backends: [backend], insights: { enabled: true, inject: true, sampleRate: 33 } },
    ],
    [
      "insights with an unknown field",
      { backends: [backend], insights: { enabled: true, inject: true, sampleRate: 10, x: 1 } },
    ],
    ["insights not an object", { backends: [backend], insights: true }],
  ];

  it.each(badBodies)("PUT with %s is 400 and changes nothing", async (_name, body) => {
    await adminPut(edge.adminUrl, "bad.test", { backends: [{ url: "https://kept", weight: 1 }] });
    const r = await adminPut(edge.adminUrl, "bad.test", body);
    expect(r.status).toBe(400);
    expect(r.body.startsWith("edge: ")).toBe(true);
    expect(JSON.parse((await target("bad.test")).body).backends[0].url).toBe("https://kept");
  });

  it("names the exact rule in the 400 text for registry validation failures", async () => {
    expect((await adminPut(edge.adminUrl, "v.test", { backends: [{ url: "https://a", weight: -1 }] })).body).toBe(
      'edge: backend "https://a" has a negative weight -1',
    );
    expect((await adminPut(edge.adminUrl, "v.test", { backends: [{ url: "ftp://a", weight: 1 }] })).body).toBe(
      'edge: backend "ftp://a" is not a valid http(s) url',
    );
    expect((await adminPut(edge.adminUrl, "v.test", { backends: [{ url: "https://a", weight: 0 }] })).body).toBe(
      'edge: target "v.test" has no backend with a positive weight',
    );
    expect((await adminPut(edge.adminUrl, "v.test", { backends: [backend], extra: 1 })).body).toBe(
      "edge: invalid request body",
    );
    expect((await adminPut(edge.adminUrl, "v.test", { backends: [backend], insights: { enabled: true } })).body).toBe(
      "edge: invalid insights settings",
    );
  });
});
