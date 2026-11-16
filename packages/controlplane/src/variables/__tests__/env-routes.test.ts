// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { afterEach, describe, expect, it } from "vitest";
import { createTestMux } from "../../__tests__/test-mux.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createStore, type Store } from "../../store/store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-env-routes-"));
  const store: Store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const mux = createTestMux(store);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await mux(
      new Request(`http://127.0.0.1${path}`, {
        method,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, json, text };
  };
  return { store, call };
}

describe("workspace env routes", () => {
  it("creates, lists, updates and deletes variables", async () => {
    const { call } = await setup();
    const put = await call("PUT", "/workspace/env/API_URL", { value: "https://x", secret: false });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ name: "API_URL", value: "https://x", secret: false });
    expect((await call("PUT", "/workspace/env/API_URL", { value: "https://y", secret: false })).json.value).toBe(
      "https://y",
    );
    const list = await call("GET", "/workspace/env");
    expect(list.status).toBe(200);
    expect(list.json).toEqual([expect.objectContaining({ name: "API_URL", value: "https://y" })]);
    expect((await call("DELETE", "/workspace/env/API_URL")).status).toBe(204);
    expect((await call("GET", "/workspace/env")).json).toEqual([]);
    expect((await call("DELETE", "/workspace/env/API_URL")).status).toBe(404);
  });

  it("never returns a secret value", async () => {
    const { call } = await setup();
    const put = await call("PUT", "/workspace/env/TOKEN", { value: "super-secret-zzz", secret: true });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain("super-secret-zzz");
    expect(put.json.value).toBeUndefined();
    expect((await call("GET", "/workspace/env")).text).not.toContain("super-secret-zzz");
  });

  it("rejects bad names, values and bodies with 400", async () => {
    const { call } = await setup();
    expect((await call("PUT", "/workspace/env/lower", { value: "v", secret: false })).status).toBe(400);
    expect((await call("PUT", "/workspace/env/NBO_X", { value: "v", secret: false })).status).toBe(400);
    expect((await call("PUT", "/workspace/env/PORT", { value: "v", secret: false })).status).toBe(400);
    expect((await call("PUT", "/workspace/env/A", { value: "x".repeat(64 * 1024 + 1), secret: false })).status).toBe(
      400,
    );
    expect((await call("PUT", "/workspace/env/A", "not json")).status).toBe(400);
    expect((await call("PUT", "/workspace/env/A", { value: 5, secret: false })).status).toBe(400);
    // No value declares the name.
    expect((await call("PUT", "/workspace/env/A", { secret: false })).json).toMatchObject({
      name: "A",
      hasValue: false,
    });
    expect((await call("PUT", "/workspace/env/A", { value: "v" })).status).toBe(400);
    expect((await call("PUT", "/workspace/env/A", { value: "v", secret: "true" })).status).toBe(400);
    expect((await call("PUT", "/workspace/env/A", [])).status).toBe(400);
  });

  it("refuses an empty secret value with 400", async () => {
    const { call } = await setup();
    const res = await call("PUT", "/workspace/env/S", { value: "", secret: true });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("Secret values can't be empty");
  });

  it("refuses secret to plain with 400", async () => {
    const { call } = await setup();
    await call("PUT", "/workspace/env/S", { value: "a", secret: true });
    const res = await call("PUT", "/workspace/env/S", { value: "b", secret: false });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("secret");
  });

  it("redacts the request's secret value from error responses", async () => {
    const { call } = await setup();
    const big = "BIGMARKER" + "x".repeat(64 * 1024);
    const r1 = await call("PUT", "/workspace/env/A", { value: big, secret: true });
    expect(r1.status).toBe(400);
    expect(r1.text).not.toContain("BIGMARKER");
    // the error text names the variable, which here equals the value, so only redact keeps it out
    await call("PUT", "/workspace/env/PLAINMARK", { value: "v", secret: true });
    const r2 = await call("PUT", "/workspace/env/PLAINMARK", { value: "PLAINMARK", secret: false });
    expect(r2.status).toBe(400);
    expect(r2.text).not.toContain("PLAINMARK");
    const r3 = await call("PUT", "/workspace/env/bad-NAMEMARK", { value: "bad-NAMEMARK", secret: true });
    expect(r3.status).toBe(400);
    expect(r3.text).not.toContain("NAMEMARK");
  });

  it("url-decodes the name", async () => {
    const { call } = await setup();
    expect((await call("PUT", "/workspace/env/%41BC", { value: "v", secret: false })).json.name).toBe("ABC");
  });
});

describe("project env routes", () => {
  it("returns 404 for an unknown project", async () => {
    const { call } = await setup();
    expect((await call("GET", "/projects/nope/env")).status).toBe(404);
    expect((await call("PUT", "/projects/nope/env/A", { value: "v", secret: false })).status).toBe(404);
    expect((await call("DELETE", "/projects/nope/env/A")).status).toBe(404);
  });

  it("does CRUD with inherited and overridden flags", async () => {
    const { store, call } = await setup();
    const p = store.createProject("app");
    await call("PUT", "/workspace/env/SHARED", { value: "ws", secret: false });
    await call("PUT", "/workspace/env/BOTH", { value: "ws", secret: false });
    const put = await call("PUT", `/projects/${p.id}/env/BOTH`, { value: "proj", secret: false });
    expect(put.status).toBe(200);
    await call("PUT", `/projects/${p.id}/env/OWN`, { value: "mine-secret-qqq", secret: true });
    const list = await call("GET", `/projects/${p.id}/env`);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("mine-secret-qqq");
    const by = Object.fromEntries(list.json.map((v: any) => [v.name, v]));
    expect(by.SHARED).toMatchObject({ inherited: true, value: "ws" });
    expect(by.BOTH).toMatchObject({ overridden: true, value: "proj" });
    expect(by.OWN).toMatchObject({ secret: true });
    expect(by.OWN.value).toBeUndefined();
    expect((await call("DELETE", `/projects/${p.id}/env/BOTH`)).status).toBe(204);
    expect((await call("DELETE", `/projects/${p.id}/env/BOTH`)).status).toBe(404);
    expect((await call("PUT", `/projects/${p.id}/env/OWN`, { value: "x", secret: false })).status).toBe(400);
  });
});

describe("env routes per environment", () => {
  it("defaults the stage to production, returns it on each row and deletes by ?stage", async () => {
    const { store, call } = await setup();
    const p = store.createProject("app");
    const a = await call("PUT", `/projects/${p.id}/env/URL`, { value: "p", secret: false });
    expect(a.json.stage).toBe("production");
    const b = await call("PUT", `/projects/${p.id}/env/URL?stage=preview`, { value: "v", secret: false });
    expect(b.json.stage).toBe("preview");
    const list = await call("GET", `/projects/${p.id}/env`);
    expect(list.json.map((v: any) => [v.stage, v.value])).toEqual([
      ["preview", "v"],
      ["production", "p"],
    ]);
    expect((await call("DELETE", `/projects/${p.id}/env/URL?stage=preview`)).status).toBe(204);
    expect((await call("DELETE", `/projects/${p.id}/env/URL?stage=preview`)).status).toBe(404);
    expect((await call("GET", `/projects/${p.id}/env`)).json.map((v: any) => v.stage)).toEqual(["production"]);
    expect((await call("DELETE", `/projects/${p.id}/env/URL`)).status).toBe(204);
  });

  it("refuses a workspace variable for a custom stage and an unknown project stage", async () => {
    const { store, call } = await setup();
    const p = store.createProject("app");
    store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    expect((await call("PUT", "/workspace/env/X?stage=staging", { value: "1", secret: false })).status).toBe(400);
    expect((await call("PUT", "/workspace/env/X?stage=*", { value: "1", secret: false })).json.stage).toBe("*");
    expect((await call("PUT", "/workspace/env/X?stage=preview", { value: "1", secret: false })).status).toBe(200);
    expect((await call("GET", "/workspace/env")).json.map((v: any) => v.stage)).toEqual(["*", "preview"]);
    expect((await call("PUT", `/projects/${p.id}/env/X?stage=staging`, { value: "1", secret: false })).status).toBe(
      200,
    );
    expect((await call("PUT", `/projects/${p.id}/env/X?stage=nope`, { value: "1", secret: false })).status).toBe(404);
  });

  it("gives a fingerprint per stage", async () => {
    const { store, call } = await setup();
    const p = store.createProject("app");
    store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    expect((await call("GET", `/projects/${p.id}/env/fingerprint?stage=staging`)).json.fingerprint).toBeNull();
    await call("PUT", `/projects/${p.id}/env/A?stage=staging`, { value: "1", secret: false });
    const staging = (await call("GET", `/projects/${p.id}/env/fingerprint?stage=staging`)).json.fingerprint;
    expect(staging).toMatch(/^[0-9a-f]{32}$/);
    expect((await call("GET", `/projects/${p.id}/env/fingerprint`)).json.fingerprint).toBeNull();
  });
});
