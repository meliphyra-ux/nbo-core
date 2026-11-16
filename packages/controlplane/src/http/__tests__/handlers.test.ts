// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createTestMux } from "../../__tests__/test-mux.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, ErrNotFound, ErrInvalidEnvironmentConfig, type Store } from "../../store/store.js";
import { type DeploymentTrigger } from "../handlers.js";

const openStores: Store[] = [];

afterEach(() => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test itself — fine
    }
  }
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-handlers-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

describe("createMux", () => {
  it("creating a project returns camelCase JSON keys", async () => {
    const mux = createTestMux(await openTestStore());
    const res = await mux(new Request("http://x/projects", { method: "POST", body: JSON.stringify({ name: "acme" }) }));
    const body = await res.text();
    expect(body).toContain('"id":"');
    expect(body).toContain('"createdAt":"');
  });

  it("create-then-get a project", async () => {
    const mux = createTestMux(await openTestStore());
    const createRes = await mux(
      new Request("http://x/projects", { method: "POST", body: JSON.stringify({ name: "acme" }) }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const getRes = await mux(new Request(`http://x/projects/${created.id}`));
    expect(getRes.status).toBe(200);
  });

  it("getting an unknown project id returns 404", async () => {
    const mux = createTestMux(await openTestStore());
    const res = await mux(new Request("http://x/projects/nope"));
    expect(res.status).toBe(404);
  });

  it("a duplicate environment name returns 409", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store);
    const p = store.createProject("acme");
    const body = JSON.stringify({ name: "production", target: "kubernetes", config: {} });

    await mux(new Request(`http://x/projects/${p.id}/environments`, { method: "POST", body }));
    const res = await mux(new Request(`http://x/projects/${p.id}/environments`, { method: "POST", body }));
    expect(res.status).toBe(409);
  });

  // Asserting the JSON error body (which only the real handler,
  // calling through to the orchestrator and mapping ErrNotFound,
  // produces) pins this to the real behavior instead of just the
  // status code, which net/http's own default "no route registered"
  // 404 would satisfy just as well even with the real handler deleted
  // entirely.
  it("triggering a deploy against an unknown environment returns 404 with a JSON error body naming it", async () => {
    const store = await openTestStore();
    // A minimal stub matching DeploymentTrigger's own shape — Task
    // 4's real triggerDeploy throws this exact error class for an
    // unknown environment id (it calls store.getEnvironment first),
    // so this stub reproduces the real status-mapping behavior
    // without needing Task 4's own wiring here.
    const orchestrator: DeploymentTrigger = {
      triggerDeploy(environmentId: string) {
        throw new ErrNotFound(`environment "${environmentId}"`);
      },
    };
    const mux = createTestMux(store, orchestrator);
    const res = await mux(
      new Request("http://x/environments/nope/deployments", { method: "POST", body: JSON.stringify({ nboDir: "/x" }) }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toContain("nope");
  });

  it("an invalid Cloud Run environment config returns 400", async () => {
    const store = await openTestStore();
    const orchestrator: DeploymentTrigger = {
      triggerDeploy() {
        throw new ErrInvalidEnvironmentConfig("cloudrun environment needs project, region and arRepo");
      },
    };
    const mux = createTestMux(store, orchestrator);
    const p = store.createProject("acme");
    const env = store.createEnvironment(p.id, "production", "cloudrun", "{}");
    const res = await mux(
      new Request(`http://x/environments/${env.id}/deployments`, {
        method: "POST",
        body: JSON.stringify({ nboDir: "/x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("listing deployments for an environment with none returns [], not null", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store);
    const p = store.createProject("acme");
    const env = store.createEnvironment(p.id, "production", "kubernetes");
    const res = await mux(new Request(`http://x/environments/${env.id}/deployments`));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trim()).not.toBe("null");
    expect(JSON.parse(text)).toEqual([]);
  });

  // No Go source to port from, closing this plan's own Review Focus
  // gap on the router: Go's net/http.ServeMux decodes a {param}
  // segment automatically; this plan's own custom router must do the
  // same explicitly.
  it("decodes a percent-encoded path parameter before it reaches the handler", async () => {
    const mux = createTestMux(await openTestStore());
    const res = await mux(new Request("http://x/projects/with%20space"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("with space");
  });

  // Final-review finding I1: Environment.config is a json.RawMessage
  // in Go, sent as a JSON object; the TS port stored it as a plain
  // string and sent it back double-encoded.
  it("returns an environment's config as a real JSON object, not a double-encoded string", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store);
    const p = store.createProject("acme");
    const res = await mux(
      new Request(`http://x/projects/${p.id}/environments`, {
        method: "POST",
        body: JSON.stringify({ name: "production", target: "cloudrun", config: { project: "x" } }),
      }),
    );
    const env = JSON.parse(await res.text()) as { config: unknown };
    expect(env.config).toEqual({ project: "x" });
  });

  // Final-review finding I2: a literal JSON `null` body makes every
  // POST handler throw a TypeError reading a field off it (outside
  // any try), which — once bridged to a real socket — is an
  // unhandled rejection that can take the whole process down.
  it("a null JSON body returns 400 instead of crashing the handler", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store, { triggerDeploy: async () => Promise.reject(new Error("not reached")) });

    const projRes = await mux(new Request("http://x/projects", { method: "POST", body: "null" }));
    expect(projRes.status).toBe(400);

    const p = store.createProject("acme");
    const envRes = await mux(new Request(`http://x/projects/${p.id}/environments`, { method: "POST", body: "null" }));
    expect(envRes.status).toBe(400);

    const env = store.createEnvironment(p.id, "production", "kubernetes");
    const depRes = await mux(
      new Request(`http://x/environments/${env.id}/deployments`, { method: "POST", body: "null" }),
    );
    expect(depRes.status).toBe(400);
  });

  // Final-review finding I3: decodeURIComponent throws URIError on a
  // malformed percent-escape, another pre-handler crash in the same
  // family as I2 — the router's own top-level catch is the backstop
  // for both.
  it("a malformed percent-escape in the path returns an error response instead of crashing", async () => {
    const mux = createTestMux(await openTestStore());
    const res = await mux(new Request("http://x/projects/%E0%A4%A"));
    expect(res.status).toBe(500);
  });
});

describe("GET /healthz", () => {
  it("answers 200 { ok: true } from a non-loopback Host with no token", async () => {
    const mux = createTestMux(await openTestStore());
    const res = await mux(new Request("http://nbo.example.com/healthz", { headers: { host: "nbo.example.com" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // Only exactly GET /healthz is public: another method or a longer path from
  // a non-loopback Host with no token goes through the gate and is refused.
  it.each([
    ["HEAD", "/healthz"],
    ["POST", "/healthz"],
    ["GET", "/healthz/x"],
    ["GET", "/healthz/../projects"],
    ["GET", "/%68ealthz/../projects"],
  ])("%s %s from a non-loopback Host with no token is refused", async (method, path) => {
    const mux = createTestMux(await openTestStore());
    const res = await mux(
      new Request(`http://nbo.example.com${path}`, { method, headers: { host: "nbo.example.com" } }),
    );
    expect(res.status).toBe(403);
  });
});
