// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { startHarness, deployedProject, type Harness } from "./v2-harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const HOUR = 3_600_000;
const t0 = new Date("2026-11-12T10:00:00.000Z");

async function dev(): Promise<Harness> {
  const h = await startHarness({ v2: { now: () => t0 }, secretKey: true });
  harnesses.push(h);
  return h;
}

const printVar = (name: string) => (process.platform === "win32" ? `echo VAL_${name}=%${name}%` : `echo VAL_${name}=$${name}`);

async function shop(h: Harness): Promise<string> {
  return deployedProject(h, {
    name: "shop",
    buildCommand: `${printVar("GREETING")} && ${printVar("NBO_ENV")} && mkdir dist && echo hi > dist/index.html`,
  });
}

const ephemeral = (body: Record<string, unknown> = {}) => ({ kind: "ephemeral", branch: "feature/x", hostLabel: "feat-x", clouds: [{ target: "kubernetes" }], ttlHours: 24, ...body });

describe("POST /projects/{id}/stages with kind ephemeral", () => {
  it("creates a pv- stage on <hostLabel>--<project> that expires ttlHours after now", async () => {
    const h = await dev();
    const id = await shop(h);
    const res = await h.call("POST", `/projects/${id}/stages`, ephemeral({ label: "pr #12" }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      kind: "ephemeral",
      branch: "feature/x",
      host: "feat-x--shop.127.0.0.1.sslip.io",
      expiresAt: new Date(t0.getTime() + 24 * HOUR).toISOString(),
      label: "pr #12",
      removal: "",
    });
    expect(res.json.name).toMatch(/^pv-[0-9a-f]{8}$/);
    expect(res.json.environments).toHaveLength(1);
    const stage = h.store.getStage(res.json.id);
    expect(stage).toMatchObject({ kind: "ephemeral", host: "feat-x--shop.127.0.0.1.sslip.io", label: "pr #12" });
    // Listed with the project's environments, with its expiry.
    const list = await h.call("GET", `/projects/${id}/stages`);
    expect(list.json.find((s: { id: string }) => s.id === stage.id)).toMatchObject({ kind: "ephemeral", expiresAt: stage.expiresAt, removal: "" });
  });

  it("takes an exact expiresAt instead", async () => {
    const h = await dev();
    const id = await shop(h);
    const at = new Date(t0.getTime() + 3 * HOUR).toISOString();
    const res = await h.call("POST", `/projects/${id}/stages`, ephemeral({ ttlHours: undefined, expiresAt: at }));
    expect(res.status).toBe(201);
    expect(res.json.expiresAt).toBe(at);
  });

  it("needs exactly one of expiresAt or ttlHours, a ttl of 1 to 2160 hours and a valid address label (400)", async () => {
    const h = await dev();
    const id = await shop(h);
    const bad = [
      ephemeral({ expiresAt: new Date(t0.getTime() + HOUR).toISOString() }),
      ephemeral({ ttlHours: undefined }),
      ephemeral({ ttlHours: 0 }),
      ephemeral({ ttlHours: 2161 }),
      ephemeral({ ttlHours: 1.5 }),
      ephemeral({ ttlHours: undefined, expiresAt: "tomorrow" }),
      ephemeral({ hostLabel: "Feat" }),
      ephemeral({ hostLabel: "ab" }),
      ephemeral({ hostLabel: "a--b" }),
      ephemeral({ hostLabel: `a${"b".repeat(40)}` }),
      ephemeral({ label: "x".repeat(201) }),
      ephemeral({ name: "pv-12345678" }),
      ephemeral({ autoDeploy: false }),
      ephemeral({ clouds: [] }),
      ephemeral({ clouds: [{ target: "kubernetes" }, { target: "cloudrun", mode: "auto" }] }),
    ];
    for (const body of bad) expect((await h.call("POST", `/projects/${id}/stages`, body)).status, JSON.stringify(body)).toBe(400);
    expect(h.store.listStages(id, { includeEphemeral: true })).toHaveLength(3);
  });

  it("a taken address is 409", async () => {
    const h = await dev();
    const id = await shop(h);
    expect((await h.call("POST", `/projects/${id}/stages`, ephemeral())).status).toBe(201);
    const again = await h.call("POST", `/projects/${id}/stages`, ephemeral({ branch: "feature/y" }));
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("that address is taken");
    // A custom environment's address too.
    expect((await h.call("POST", `/projects/${id}/stages`, { name: "staging", branch: "staging", clouds: [{ target: "kubernetes" }] })).status).toBe(201);
    const custom = await h.call("POST", `/projects/${id}/stages`, ephemeral({ branch: "feature/z", hostLabel: "staging" }));
    expect(custom.status).toBe(409);
    expect(custom.json.error).toBe("that address is taken");
  });

  it("a push to the stage's branch builds it with Preview's variables", async () => {
    const h = await dev();
    const id = await shop(h);
    h.store.setEnv({ projectId: id }, "GREETING", "hello-from-preview", false, "preview");
    h.store.setEnv({ projectId: id }, "GREETING", "hello-from-production", false, "production");
    const created = await h.call("POST", `/projects/${id}/stages`, ephemeral());
    expect(created.status).toBe(201);
    const stageId = created.json.id as string;
    const sha = await h.commit("feature work");
    const payload = JSON.stringify({ ref: "refs/heads/feature/x", before: "0".repeat(40), after: sha });
    const secret = h.store.ensureWebhookSecret(id);
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const res = await h.mux(new Request(`http://cp/projects/${id}/webhooks/github`, { method: "POST", body: payload, headers: { "x-hub-signature-256": signature, "x-github-event": "push" } }));
    expect(res.status).toBe(202);
    await h.v2.queue.idle(id);
    const build = h.store.listBuilds(id).find((b) => b.stageId === stageId)!;
    expect(build).toMatchObject({ revision: sha, status: "succeeded" });
    const log = h.store.getBuild(build.id).log;
    expect(log).toMatch(/^VAL_GREETING=hello-from-preview/m);
    expect(log).toMatch(/^VAL_NBO_ENV=preview/m);
  }, 60_000);

  it("PATCH changes expiresAt; DELETE removes the stage's own app and keeps its row as removed", async () => {
    const h = await dev();
    const id = await shop(h);
    const created = await h.call("POST", `/projects/${id}/stages`, ephemeral());
    const stageId = created.json.id as string;
    const at = new Date(t0.getTime() + 48 * HOUR).toISOString();
    const patched = await h.call("PATCH", `/projects/${id}/stages/${stageId}`, { expiresAt: at });
    expect(patched.status).toBe(200);
    expect(patched.json.expiresAt).toBe(at);
    expect((await h.call("PATCH", `/projects/${id}/stages/${stageId}`, { branch: "other" })).status).toBe(400);

    const del = await h.call("DELETE", `/projects/${id}/stages/${stageId}`);
    expect(del.status).toBe(202);
    for (let i = 0; i < 50 && h.store.getStage(stageId).removal !== "removed"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.store.getStage(stageId).removal).toBe("removed");
    expect(h.teardown.removed.map((t) => t.scope)).toEqual(["app"]);
    // Production keeps its cloud.
    expect(h.store.listEnvironments(id).every((e) => !e.archived)).toBe(true);
    expect((await h.call("DELETE", `/projects/${id}/stages/${stageId}`)).status).toBe(409);
    // The address is free again.
    expect((await h.call("POST", `/projects/${id}/stages`, ephemeral({ branch: "feature/again" }))).status).toBe(201);
  });

  it("a removed stage is listed for 7 days after its removal, then only with ?all=1", async () => {
    const h = await dev();
    const id = await shop(h);
    const created = await h.call("POST", `/projects/${id}/stages`, ephemeral());
    const stageId = created.json.id as string;
    await h.call("DELETE", `/projects/${id}/stages/${stageId}`);
    for (let i = 0; i < 50 && h.store.getStage(stageId).removal !== "removed"; i++) await new Promise((r) => setTimeout(r, 20));
    // Removed at the harness's clock.
    expect(h.store.getStage(stageId).removedAt).toBe(t0.toISOString());
    expect((await h.call("GET", `/projects/${id}/stages`)).json.find((s: { id: string }) => s.id === stageId).removedAt).toBe(t0.toISOString());
    const ids = async (query = "") => ((await h.call("GET", `/projects/${id}/stages${query}`)).json as { id: string }[]).map((s) => s.id);
    expect(await ids()).toContain(stageId);

    h.store.updateStage(stageId, { removedAt: new Date(t0.getTime() - 7 * 24 * HOUR + HOUR).toISOString() });
    expect(await ids()).toContain(stageId);
    h.store.updateStage(stageId, { removedAt: new Date(t0.getTime() - 7 * 24 * HOUR - HOUR).toISOString() });
    expect(await ids()).not.toContain(stageId);
    expect(await ids("?all=1")).toContain(stageId);
    // Removed before NBO recorded when: counted as old.
    h.store.updateStage(stageId, { removedAt: "" });
    expect(await ids()).not.toContain(stageId);
    expect(await ids("?all=1")).toContain(stageId);
  });
});
