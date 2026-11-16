// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startHarness, deployedProject, noCommands, bearer, type Harness } from "./v2-harness.js";
import { parsePublicUrl } from "../http/public-url.js";

// The token-only gate: sign-in, members and roles left core. No header on
// loopback is allowed; a token is checked; webhooks check their signature;
// the public address (NBO_PUBLIC_URL) lets only tokens and webhooks in.

const PUBLIC = "nbo.example.com";
const LOWER_ROLE =
  "this API token was made for a member below Admin while sign-in was on; make a new token with nbo-server token create";

// ownedToken writes a token row as sign-in made it: an owner and a role.
function ownedToken(h: Harness, name: string, role: string): string {
  const { token, secret } = h.store.createApiToken(name);
  const db = new DatabaseSync(h.dbPath);
  try {
    db.prepare("UPDATE api_tokens SET user_id = ?, role = ? WHERE id = ?").run("usr_member", role, token.id);
  } finally {
    db.close();
  }
  return secret;
}

const sign = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("the token-only gate", () => {
  let h: Harness;
  let projectID: string;
  beforeAll(async () => {
    h = await startHarness({ v2: { run: noCommands, publicUrl: parsePublicUrl(`https://${PUBLIC}`) } });
    projectID = await deployedProject(h);
  }, 60_000);
  afterAll(async () => h.close());

  const onPublic = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    h.mux(new Request(`https://${PUBLIC}${path}`, { method, body, headers: { host: PUBLIC, ...headers } }));

  it("a token sign-in made for a Viewer is 401 on POST /projects/{id}/builds; an Admin-role token from the same member builds", async () => {
    const viewer = ownedToken(h, "viewer-token", "viewer");
    const refused = await h.call("POST", `/projects/${projectID}/builds`, {}, bearer(viewer));
    expect(refused.status).toBe(401);
    expect(refused.json).toEqual({ error: LOWER_ROLE });
    const admin = ownedToken(h, "admin-token", "admin");
    const built = await h.call("POST", `/projects/${projectID}/builds`, {}, bearer(admin));
    expect(built.status, built.text).toBe(202);
    await h.v2.queue.idle(projectID);
  });

  it("a Developer-role token and one with an unknown role are 401 too; an Owner-role token works", async () => {
    for (const role of ["developer", "superuser", ""]) {
      const res = await h.call("GET", "/projects", undefined, bearer(ownedToken(h, `t-${role || "empty"}`, role)));
      expect(res.status, role).toBe(401);
      expect(res.json, role).toEqual({ error: LOWER_ROLE });
    }
    expect((await h.call("GET", "/projects", undefined, bearer(ownedToken(h, "t-owner", "owner")))).status).toBe(200);
  });

  it("the public address without a token is 403 on GET /projects and POST /projects/setup", async () => {
    const before = h.store.listProjects().length;
    const list = await onPublic("GET", "/projects");
    expect(list.status).toBe(403);
    const setup = await onPublic(
      "POST",
      "/projects/setup",
      { "content-type": "application/json" },
      JSON.stringify({ name: "sneaky" }),
    );
    expect(setup.status).toBe(403);
    expect(h.store.listProjects()).toHaveLength(before);
    // Any spelling of the public name, and the routes that left core.
    for (const host of ["NBO.EXAMPLE.COM.", "nbo.example.com:443"]) {
      expect((await h.mux(new Request(`https://${PUBLIC}/projects`, { headers: { host } }))).status, host).toBe(403);
    }
    expect((await onPublic("GET", "/system/connections")).status).toBe(403);
    expect((await onPublic("POST", "/github/webhook", {}, "{}")).status).toBe(403);
  });

  it("the public address lets through only routes whose access row is webhook, not every path under webhooks/", async () => {
    expect((await onPublic("GET", `/projects/${projectID}/webhooks/github`)).status).toBe(403);
    expect((await onPublic("POST", `/projects/${projectID}/webhooks/gitlab`, {}, "{}")).status).toBe(403);
    expect((await onPublic("POST", `/projects/${projectID}/webhooks/github/../../builds`, {}, "{}")).status).toBe(403);
  });

  it("a signed per-project webhook push through the public address answers as on loopback, and builds", async () => {
    const secret = h.store.ensureWebhookSecret(projectID);
    const push = (sha: string, before = "0".repeat(40)) =>
      JSON.stringify({ ref: "refs/heads/main", before, after: sha });
    const path = `/projects/${projectID}/webhooks/github`;

    const viaPublicSha = await h.commit("through the public address");
    const body1 = push(viaPublicSha, h.store.getProject(projectID).lastSeenSha);
    const viaPublic = await onPublic(
      "POST",
      path,
      { "x-github-event": "push", "x-hub-signature-256": sign(secret, body1) },
      body1,
    );
    const publicJson = (await viaPublic.json()) as Record<string, unknown>;
    await h.v2.queue.idle(projectID);

    const viaLoopbackSha = await h.commit("through the tunnel");
    const body2 = push(viaLoopbackSha, viaPublicSha);
    const viaLoopback = await h.mux(
      new Request(`http://localhost:8081${path}`, {
        method: "POST",
        body: body2,
        headers: { host: "localhost:8081", "x-github-event": "push", "x-hub-signature-256": sign(secret, body2) },
      }),
    );
    const loopbackJson = (await viaLoopback.json()) as Record<string, unknown>;
    await h.v2.queue.idle(projectID);

    expect(viaPublic.status).toBe(viaLoopback.status);
    expect(viaPublic.status).toBe(202);
    expect(Object.keys(publicJson).sort()).toEqual(Object.keys(loopbackJson).sort());
    expect(publicJson.status).toBe(loopbackJson.status);
    expect(h.store.listBuilds(projectID).map((b) => b.revision)).toContain(viaPublicSha);

    // Unsigned, it reaches the handler and is refused there, as on loopback.
    const unsigned = await onPublic("POST", path, { "x-github-event": "push" }, body1);
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ error: "invalid signature" });
  }, 60_000);

  it("a token reaches the API through the public address; /healthz needs none", async () => {
    const { secret } = h.store.createApiToken("ci-public");
    expect((await onPublic("GET", "/projects", bearer(secret))).status).toBe(200);
    expect((await onPublic("GET", "/healthz")).status).toBe(200);
  });

  it("a token on /system/connections is 403", async () => {
    const { secret } = h.store.createApiToken("ci-system");
    const res = await h.call("GET", "/system/connections", undefined, bearer(secret));
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "API tokens can't use this route" });
    expect((await onPublic("GET", "/system/connections", bearer(secret))).status).toBe(403);
  });

  it("/auth/session and /system/members are 404 on loopback", async () => {
    for (const path of [
      "/auth/session",
      "/system/members",
      "/system/sign-in",
      "/system/audit",
      "/system/github",
      "/github/webhook",
    ]) {
      const method = path === "/github/webhook" ? "POST" : "GET";
      const res = await h.mux(
        new Request(`http://localhost:8081${path}`, { method, headers: { host: "localhost:8081" } }),
      );
      expect(res.status, path).toBe(404);
    }
  });
});
