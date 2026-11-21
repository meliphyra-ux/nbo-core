// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../store/store.js";
import type { Mode } from "../../mode.js";
import type { Stage } from "../stages.js";
import { ErrConflict } from "../../store/errors.js";
import { parseRevalidateBody, revalidateStage, type RevalidateDeps } from "../revalidate.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const EDGE_HOST = "shop.127.0.0.1.sslip.io";

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-revalidate-"));
  const s = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    s.close();
    await rm(dir, { recursive: true, force: true });
  });
  return s;
}

// shop: a project with a Kubernetes and a Cloud Run cloud, both live.
async function shop(): Promise<{ store: Store; stage: Stage; k8s: string; cr: string }> {
  const store = await openStore();
  const p = store.createProject("shop");
  store.updateProject(p.id, { edgeHost: EDGE_HOST });
  const stage = store.productionStage(p.id);
  const k8s = store.createEnvironment(p.id, "k8s", "kubernetes", "{}").id;
  const cr = store.createEnvironment(p.id, "cloudrun", "cloudrun", "{}").id;
  for (const [id, url] of [
    [k8s, "http://pshop-k8s.nbo-p.svc:8080"],
    [cr, "https://pshop-cr-abc123-uc.a.run.app"],
  ] as const) {
    const d = store.createDeployment(id);
    store.completeDeployment(d.id, "sha256:x", url);
  }
  return { store, stage, k8s, cr };
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  redirect: RequestRedirect | undefined;
}

function fakeFetch(answer: (url: string) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
      redirect: init?.redirect,
    });
    return answer(url);
  }) as typeof fetch;
  return { fetch: f, calls };
}

function deps(store: Store, mode: Mode, f: typeof fetch): RevalidateDeps {
  return { store, mode, urlContext: { store, mode, edgePublicPort: 9443 }, fetch: f };
}

describe("parseRevalidateBody", () => {
  const bad: [string, unknown][] = [
    ["an empty object", {}],
    ["empty tags", { tags: [] }],
    ["a non-string tag", { tags: ["a", 1] }],
    ["a 257-character tag", { tags: ["x".repeat(257)] }],
    ["an empty tag", { tags: [""] }],
    ["257 paths", { paths: Array.from({ length: 257 }, (_, i) => `/p${i}`) }],
    ["a path without /", { paths: ["blog"] }],
    ["an extra field", { tags: ["a"], purge: true }],
    ["not an object", ["a"]],
    ["tags not an array", { tags: "a" }],
  ];
  for (const [name, raw] of bad) {
    it(`refuses ${name} with a message`, () => {
      const out = parseRevalidateBody(raw);
      expect(typeof out).toBe("string");
      expect((out as string).length).toBeGreaterThan(0);
    });
  }

  it("accepts tags, paths or both (256 entries, 256-character tags)", () => {
    expect(parseRevalidateBody({ tags: ["posts"] })).toEqual({ tags: ["posts"] });
    expect(parseRevalidateBody({ paths: ["/blog/x"], tags: [] })).toEqual({ paths: ["/blog/x"] });
    const many = Array.from({ length: 256 }, (_, i) => `t${i}`);
    expect(parseRevalidateBody({ tags: many, paths: ["/"] })).toEqual({ tags: many, paths: ["/"] });
    expect(parseRevalidateBody({ tags: ["x".repeat(256)] })).toEqual({ tags: ["x".repeat(256)] });
  });
});

describe("revalidateStage with an edge", () => {
  it("posts once to the stage's address with the token, and lists each live cloud on 204", async () => {
    const { store, stage, k8s, cr } = await shop();
    const { token } = store.ensureRevalidateToken(stage.id);
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const out = await revalidateStage(deps(store, "dev", fetch), stage, { tags: ["posts"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://${EDGE_HOST}:9443/_nbo/revalidate`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.body)).toEqual({ tags: ["posts"] });
    expect(out).toEqual({
      ok: true,
      results: [
        { environmentId: k8s, cloud: "Kubernetes", status: 204 },
        { environmentId: cr, cloud: "Cloud Run", status: 204 },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it("maps an edge 502's backend ids to cloud names", async () => {
    const { store, stage, k8s, cr } = await shop();
    store.ensureRevalidateToken(stage.id);
    const { fetch } = fakeFetch(() =>
      Response.json(
        {
          backends: [
            { id: k8s, status: 204 },
            { id: cr, status: 0 },
          ],
        },
        { status: 502 },
      ),
    );
    const out = await revalidateStage(deps(store, "dev", fetch), stage, { paths: ["/blog/x"] });
    expect(out.ok).toBe(false);
    expect(out.results).toEqual([
      { environmentId: k8s, cloud: "Kubernetes", status: 204 },
      { environmentId: cr, cloud: "Cloud Run", status: 0, error: expect.stringMatching(/unreachable|timed out/) },
    ]);
  });

  it("gives ok: false when the edge answers 401 (every app refused the secret)", async () => {
    const { store, stage } = await shop();
    store.ensureRevalidateToken(stage.id);
    const { fetch } = fakeFetch(() => new Response("bad secret: <html>long upstream page</html>", { status: 401 }));
    const out = await revalidateStage(deps(store, "dev", fetch), stage, { tags: ["a"] });
    expect(out.ok).toBe(false);
    expect(out.results.map((r) => r.status)).toEqual([401, 401]);
    expect(JSON.stringify(out)).not.toContain("upstream page");
  });

  it("records a fetch error mentioning the token as [redacted]", async () => {
    const { store, stage } = await shop();
    const { token } = store.ensureRevalidateToken(stage.id);
    const { fetch } = fakeFetch(() => {
      throw new Error(`connect failed for Bearer ${token}`);
    });
    const out = await revalidateStage(deps(store, "dev", fetch), stage, { tags: ["a"] });
    expect(out.ok).toBe(false);
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.status).toBe(0);
      expect(r.error).toContain("[redacted]");
      expect(r.error).not.toContain(token);
    }
  });

  it("never posts to a domain Cloud Run serves: uses the default host instead", async () => {
    const { store, stage } = await shop();
    store.ensureRevalidateToken(stage.id);
    store.updateServerSettings({ edgeClusterId: "kc_default" });
    const mapped = store.addDomain(stage.projectId, "shop.example.com", "custom", "cloudrun");
    store.updateDomain(mapped.id, { status: "active" });
    const def = store.addDomain(stage.projectId, EDGE_HOST, "default");
    store.updateDomain(def.id, { status: "active" });
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await revalidateStage(deps(store, "production", fetch), stage, { tags: ["a"] });
    expect(calls.map((c) => c.url)).toEqual([`https://${EDGE_HOST}/_nbo/revalidate`]);
  });

  it("uses an active custom domain the edge serves", async () => {
    const { store, stage } = await shop();
    store.ensureRevalidateToken(stage.id);
    store.updateServerSettings({ edgeClusterId: "kc_default" });
    const d = store.addDomain(stage.projectId, "www.shop.example", "custom", "edge");
    store.updateDomain(d.id, { status: "active" });
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await revalidateStage(deps(store, "production", fetch), stage, { tags: ["a"] });
    expect(calls.map((c) => c.url)).toEqual(["https://www.shop.example/_nbo/revalidate"]);
  });
});

describe("revalidateStage over plain http", () => {
  it("in production refuses to send the secret to an http:// address (no active certificate): 409, nothing called", async () => {
    const { store, stage } = await shop();
    store.ensureRevalidateToken(stage.id);
    store.updateServerSettings({ edgeClusterId: "kc_default" });
    // The default host's certificate isn't issued yet.
    store.addDomain(stage.projectId, EDGE_HOST, "default");
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const err = await revalidateStage(deps(store, "production", fetch), stage, { tags: ["a"] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ErrConflict);
    expect((err as Error).message).toMatch(/certificate isn't active yet/);
    expect((err as Error).message).toMatch(/https/);
    expect(calls).toHaveLength(0);
  });

  it("in dev mode still posts over http on the loopback edge", async () => {
    const { store, stage } = await shop();
    store.ensureRevalidateToken(stage.id);
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const out = await revalidateStage(deps(store, "dev", fetch), stage, { tags: ["a"] });
    expect(out.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`http://${EDGE_HOST}:9443/_nbo/revalidate`]);
  });
});

describe("revalidateStage: what the edge reaches", () => {
  it("lists on a 204 only the clouds the route table holds (not a cluster without a relay)", async () => {
    const { store, stage, cr } = await shop();
    store.ensureRevalidateToken(stage.id);
    store.updateServerSettings({ edgeClusterId: "kc_edge" });
    const def = store.addDomain(stage.projectId, EDGE_HOST, "default");
    store.updateDomain(def.id, { status: "active" });
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    // The k8s cloud sits on kc_default, which has no relay to the kc_edge edge.
    const out = await revalidateStage(deps(store, "production", fetch), stage, { tags: ["a"] });
    expect(out).toEqual({ ok: true, results: [{ environmentId: cr, cloud: "Cloud Run", status: 204 }] });
  });

  it("reports an edge redirect as answered 3xx and never follows it", async () => {
    const { store, stage } = await shop();
    const { token } = store.ensureRevalidateToken(stage.id);
    const { fetch, calls } = fakeFetch(
      () => new Response(null, { status: 301, headers: { location: "https://elsewhere.example/_nbo/revalidate" } }),
    );
    const out = await revalidateStage(deps(store, "dev", fetch), stage, { tags: ["a"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe("manual");
    expect(out.ok).toBe(false);
    for (const r of out.results) {
      expect(r.status).toBe(301);
      expect(r.error).toBe("answered 301");
    }
    expect(JSON.stringify(out)).not.toContain(token);
    expect(JSON.stringify(out)).not.toContain("elsewhere");
  });
});

describe("revalidateStage without an edge", () => {
  it("reports a call that times out as status 0, timed out", async () => {
    const { store, stage, cr } = await shop();
    store.ensureRevalidateToken(stage.id);
    const { fetch } = fakeFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const out = await revalidateStage(deps(store, "production", fetch), stage, { tags: ["a"] });
    expect(out).toEqual({
      ok: false,
      results: [{ environmentId: cr, cloud: "Cloud Run", status: 0, error: "timed out" }],
    });
  });

  it("calls each live Cloud Run URL directly (production, no edge cluster)", async () => {
    const { store, stage, cr } = await shop();
    const { token } = store.ensureRevalidateToken(stage.id);
    const p = stage.projectId;
    const cr2 = store.createEnvironment(p, "cloudrun-2", "cloudrun", "{}").id;
    const d = store.createDeployment(cr2);
    store.completeDeployment(d.id, "sha256:x", "https://pshop-cr2-abc123-ew.a.run.app");
    // A Cloud Run cloud with nothing live is skipped.
    store.createEnvironment(p, "cloudrun-3", "cloudrun", "{}");
    const { fetch, calls } = fakeFetch((url) => new Response(null, { status: url.includes("cr2") ? 401 : 204 }));
    const out = await revalidateStage(deps(store, "production", fetch), stage, { tags: ["a"] });
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://pshop-cr-abc123-uc.a.run.app/_nbo/revalidate",
      "https://pshop-cr2-abc123-ew.a.run.app/_nbo/revalidate",
    ]);
    for (const c of calls) expect(c.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(out.ok).toBe(false);
    expect(out.results).toEqual([
      { environmentId: cr, cloud: "Cloud Run", status: 204 },
      { environmentId: cr2, cloud: "Cloud Run", status: 401, error: expect.stringContaining("401") },
    ]);
  });
  it("calls a live Lambda app on its function URL directly too (no edge cluster)", async () => {
    const { store, stage, cr } = await shop();
    store.ensureRevalidateToken(stage.id);
    const lm = store.createEnvironment(stage.projectId, "lambda", "lambda", JSON.stringify({ region: "eu-west-1" })).id;
    store.completeDeployment(store.createDeployment(lm).id, "sha256:x", "https://abc.lambda-url.eu-west-1.on.aws");
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const out = await revalidateStage(deps(store, "production", fetch), stage, { tags: ["a"] });
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://abc.lambda-url.eu-west-1.on.aws/_nbo/revalidate",
      "https://pshop-cr-abc123-uc.a.run.app/_nbo/revalidate",
    ]);
    expect(out.results).toEqual([
      { environmentId: cr, cloud: "Cloud Run", status: 204 },
      { environmentId: lm, cloud: "AWS Lambda", status: 204 },
    ]);
  });
});

describe("revalidateStage refusals", () => {
  it("is a 409 conflict when the stage has no token yet", async () => {
    const { store, stage } = await shop();
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const err = await revalidateStage(deps(store, "dev", fetch), stage, { tags: ["a"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrConflict);
    expect((err as Error).message).toBe("Nothing in this environment uses ISR yet");
    expect(calls).toHaveLength(0);
  });

  it("is a 409 naming why when there is no address and no public cloud URL", async () => {
    const store = await openStore();
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: EDGE_HOST });
    const stage = store.productionStage(p.id);
    const k8s = store.createEnvironment(p.id, "k8s", "kubernetes", "{}").id;
    const d = store.createDeployment(k8s);
    store.completeDeployment(d.id, "sha256:x", "http://pshop-k8s.nbo-p.svc:8080");
    store.ensureRevalidateToken(stage.id);
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const err = await revalidateStage(deps(store, "production", fetch), stage, { tags: ["a"] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ErrConflict);
    expect((err as Error).message).toMatch(/no address/);
    expect(calls).toHaveLength(0);
  });
});
