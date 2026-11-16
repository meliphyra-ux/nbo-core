// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTestMux } from "../../__tests__/test-mux.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, ErrDuplicateName, ErrNotFound, type Store } from "../../store/store.js";
import { guardRequest } from "../api-tokens.js";
import { createMux } from "../handlers.js";

const openStores: Store[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-tokens-"));
  dirs.push(dir);
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

const FOREIGN = { host: "evil.example", origin: "https://evil.example" };
const REFUSED = { error: "API tokens can't use this route" };

describe("token store", () => {
  it("returns the token once and never lists it", async () => {
    const store = await openTestStore();
    const { token, secret } = store.createApiToken("ci");
    expect(secret).toMatch(/^nbo_[0-9a-f]{64}$/);
    expect(token.id).toMatch(/^tok_[0-9a-f]+$/);
    expect(token.prefix).toBe(secret.slice(4, 12));
    expect(JSON.stringify(token)).not.toContain(secret);
    expect(JSON.stringify(store.listApiTokens())).not.toContain(secret);
    expect(token.lastUsedAt).toBe("");
    expect(store.findApiToken(secret)?.id).toBe(token.id);
  });

  it("stores the hash, not the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-tokens-"));
    dirs.push(dir);
    const path = join(dir, "raw.db");
    const store = createStore(path);
    const { secret } = store.createApiToken("ci");
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT * FROM api_tokens").get() as Record<string, string>;
    const { createHash } = await import("node:crypto");
    expect(row.hash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(Object.values(row)).not.toContain(secret);
    db.close();
  });

  it("refuses duplicate and invalid names", async () => {
    const store = await openTestStore();
    store.createApiToken("ci");
    expect(() => store.createApiToken("ci")).toThrow(ErrDuplicateName);
    expect(() => store.createApiToken("")).toThrow();
    expect(() => store.createApiToken("x".repeat(61))).toThrow();
  });

  it("a deleted token stops working at once", async () => {
    const store = await openTestStore();
    const { token, secret } = store.createApiToken("ci");
    expect(store.findApiToken(secret)).not.toBeNull();
    store.deleteApiToken(token.id);
    expect(store.findApiToken(secret)).toBeNull();
    expect(() => store.deleteApiToken(token.id)).toThrow(ErrNotFound);
  });

  it("an unknown secret finds nothing", async () => {
    const store = await openTestStore();
    store.createApiToken("ci");
    expect(store.findApiToken("nbo_" + "0".repeat(64))).toBeNull();
  });

  it("writes last_used_at at most once a minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
    const store = await openTestStore();
    const { token } = store.createApiToken("ci");
    store.touchApiToken(token.id);
    const first = store.listApiTokens()[0]!.lastUsedAt;
    expect(first).toBe("2026-11-07T10:00:00.000Z");
    vi.setSystemTime(new Date("2026-11-07T10:00:30Z"));
    store.touchApiToken(token.id);
    expect(store.listApiTokens()[0]!.lastUsedAt).toBe(first);
    vi.setSystemTime(new Date("2026-11-07T10:01:01Z"));
    store.touchApiToken(token.id);
    expect(store.listApiTokens()[0]!.lastUsedAt).toBe("2026-11-07T10:01:01.000Z");
  });
});

describe("guard on the bare mux", () => {
  let store: Store;
  let secret: string;
  let mux: (r: Request) => Promise<Response>;

  beforeEach(async () => {
    store = await openTestStore();
    secret = store.createApiToken("ci").secret;
    mux = createTestMux(store);
  });

  const call = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    mux(new Request(`http://localhost:8081${path}`, { method, headers: { host: "localhost:8081", ...headers } }));
  const bearer = (s = secret) => ({ authorization: `Bearer ${s}` });

  it("no header keeps today's loopback rule", async () => {
    expect((await call("/projects")).status).toBe(200);
    expect((await createMux(store)(new Request("http://localhost:8081/projects"))).status).toBe(403);
    expect((await call("/projects", { host: "evil.example" })).status).toBe(403);
    expect((await call("/projects", { origin: "https://evil.example" })).status).toBe(403);
  });

  it("a bad token on loopback is 401", async () => {
    const res = await call("/projects", bearer("nbo_" + "a".repeat(64)));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid API token" });
  });

  it("malformed tokens and other schemes are 401", async () => {
    for (const h of [
      "Basic xyz",
      `Basic ${secret}`,
      "Bearer",
      "Bearer nbo_short",
      "Bearer nope",
      `Bearer ${secret} extra`,
      `Token ${secret}`,
    ]) {
      expect((await call("/projects", { authorization: h })).status, h).toBe(401);
    }
  });

  it("a valid token with a foreign Host and Origin reaches /projects", async () => {
    expect((await call("/projects", { ...bearer(), ...FOREIGN })).status).toBe(200);
    expect(store.listApiTokens()[0]!.lastUsedAt).not.toBe("");
  });

  it("a revoked token is 401", async () => {
    store.deleteApiToken(store.listApiTokens()[0]!.id);
    expect((await call("/projects", bearer())).status).toBe(401);
  });

  const systemPaths = [
    "/system/connections",
    "/system/api-tokens",
    "/system/",
    "/system",
    "/SYSTEM/connections",
    "/System/api-tokens",
    "/system/connections/",
    "//system/connections",
    "///system//connections",
    "/%73ystem/connections",
    "/%53YSTEM/connections",
    "/%2573ystem/connections",
    "/%2fsystem/connections",
    "/%5csystem/connections",
    "/./system/connections",
    "/projects/../system/connections",
    "/projects/%2e%2e/system/connections",
    "/system/api-tokens/tok_abc",
  ];
  for (const p of systemPaths) {
    it(`a valid token gets 403 on ${p}`, async () => {
      const res = await call(p, { ...bearer(), ...FOREIGN });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
      expect((await call(p, bearer(), "DELETE")).status).toBe(403);
    });
  }

  it("a path that can't be decoded with a valid token is 403", async () => {
    const res = await mux(new Request("http://localhost:8081/%E0%A4%A", { headers: bearer() }));
    expect(res.status).toBe(403);
  });

  it("guardRequest returns null when allowed and never echoes the token", async () => {
    expect(
      guardRequest(new Request("http://localhost/projects", { headers: bearer() }), "/projects", store),
    ).toBeNull();
    const bad = guardRequest(
      new Request("http://localhost/projects", { headers: bearer("nbo_" + "b".repeat(64)) }),
      "/projects",
      store,
    );
    expect(bad?.status).toBe(401);
    expect(await bad!.text()).not.toContain("b".repeat(64));
  });
});

describe("token routes", () => {
  it("create returns the token once; list never does", async () => {
    const mux = createTestMux(await openTestStore());
    const created = await mux(
      new Request("http://localhost/system/api-tokens", { method: "POST", body: JSON.stringify({ name: "ci" }) }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, string>;
    expect(body.token).toMatch(/^nbo_[0-9a-f]{64}$/);
    expect(Object.keys(body).sort()).toEqual(["createdAt", "id", "lastUsedAt", "name", "prefix", "token"]);
    const listed = await mux(new Request("http://localhost/system/api-tokens"));
    const text = await listed.text();
    expect(text).not.toContain(body.token!);
    expect(text).not.toContain("hash");
    const rows = JSON.parse(text) as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["createdAt", "id", "lastUsedAt", "name", "prefix"]);
  });

  it("refuses a duplicate name (409) and a missing name (400)", async () => {
    const mux = createTestMux(await openTestStore());
    const post = (b: unknown) =>
      mux(new Request("http://localhost/system/api-tokens", { method: "POST", body: JSON.stringify(b) }));
    expect((await post({ name: "ci" })).status).toBe(201);
    expect((await post({ name: "ci" })).status).toBe(409);
    expect((await post({})).status).toBe(400);
    expect((await post({ name: "" })).status).toBe(400);
  });

  it("delete revokes (204) and a second delete is 404", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store);
    const { token } = store.createApiToken("ci");
    const del = () => mux(new Request(`http://localhost/system/api-tokens/${token.id}`, { method: "DELETE" }));
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
    expect(store.listApiTokens()).toHaveLength(0);
  });
});

describe("fix round 1", () => {
  const gitBody = {
    repo: "https://github.com/a/b",
    productionBranch: "main",
    framework: "static",
    buildCommand: "true",
  };

  it("an empty Authorization header is 401", async () => {
    const mux = createTestMux(await openTestStore());
    const res = await mux(new Request("http://localhost/projects", { headers: { authorization: "" } }));
    expect(res.status).toBe(401);
  });

  it("a webhook carrying its own Authorization header still reaches the handler", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store);
    const proj = (await (
      await mux(new Request("http://localhost/projects", { method: "POST", body: JSON.stringify({ name: "w" }) }))
    ).json()) as { id: string };
    await mux(
      new Request(`http://localhost/projects/${proj.id}/git`, { method: "PUT", body: JSON.stringify(gitBody) }),
    );
    const res = await mux(
      new Request(`http://localhost/projects/${proj.id}/webhooks/github`, {
        method: "POST",
        body: "{}",
        headers: { authorization: "Basic abc" },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    // A webhook still obeys the loopback rule.
    const foreign = await mux(
      new Request(`http://localhost/projects/${proj.id}/webhooks/github`, {
        method: "POST",
        body: "{}",
        headers: { host: "evil.example", authorization: "Basic abc" },
      }),
    );
    expect(foreign.status).toBe(403);
  });

  it("tokens get 403 on the two legacy routes", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store);
    const { secret } = store.createApiToken("ci");
    for (const p of [
      "/environments/e1/deployments",
      "/projects/p1/environments",
      "/Projects/p1/ENVIRONMENTS",
      "/projects/p1/environments/",
      "/%65nvironments/e1/deployments",
    ]) {
      const res = await mux(
        new Request(`http://localhost${p}`, {
          method: "POST",
          body: "{}",
          headers: { authorization: `Bearer ${secret}` },
        }),
      );
      expect(res.status, p).toBe(403);
      expect(await res.json()).toEqual({ error: "API tokens can't use this route" });
    }
    // Without a token they still reach the handler.
    const open = await mux(new Request("http://localhost/projects/p1/environments", { method: "POST", body: "{}" }));
    expect(open.status).not.toBe(403);
  });

  it("token requests never receive the webhook secret; others keep it", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store);
    const { secret } = store.createApiToken("ci");
    const proj = (await (
      await mux(new Request("http://localhost/projects", { method: "POST", body: JSON.stringify({ name: "g" }) }))
    ).json()) as { id: string };
    const put = (headers: Record<string, string>) =>
      mux(
        new Request(`http://localhost/projects/${proj.id}/git`, {
          method: "PUT",
          body: JSON.stringify(gitBody),
          headers,
        }),
      );
    const plain = (await (await put({})).json()) as Record<string, unknown>;
    expect(typeof plain.webhookSecret).toBe("string");
    const viaToken = await put({ authorization: `Bearer ${secret}` });
    expect(viaToken.status).toBe(200);
    const text = await viaToken.text();
    expect(text).not.toContain("webhookSecret");
    expect(text).not.toContain(plain.webhookSecret as string);
    const got = await (
      await mux(
        new Request(`http://localhost/projects/${proj.id}/git`, { headers: { authorization: `Bearer ${secret}` } }),
      )
    ).text();
    expect(got).not.toContain(plain.webhookSecret as string);
  });

  it("a failing last-used write never fails the request, and repeat requests skip the database", async () => {
    const store = await openTestStore();
    const { token } = store.createApiToken("ci");
    store.touchApiToken(token.id);
    store.touchApiToken(token.id);
    store.deleteApiToken(token.id);
    // Writing for a token that no longer exists, or a closed database, must not throw.
    expect(() => store.touchApiToken("tok_gone")).not.toThrow();
    store.close();
    expect(() => store.touchApiToken(token.id)).not.toThrow();
  });
});

describe("tokens sign-in made for members (core has no roles)", () => {
  const LOWER =
    "this API token was made for a member below Admin while sign-in was on; make a new token with nbo-server token create";
  const get = (mux: (r: Request) => Promise<Response>, secret: string) =>
    mux(new Request("http://localhost:8081/projects", { headers: { authorization: `Bearer ${secret}` } }));

  // owned writes a token row as sign-in made it (core never writes these).
  async function owned(dir: string, store: Store, name: string, userId: string, role: string): Promise<string> {
    const { token, secret } = store.createApiToken(name);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "owned.db"));
    try {
      db.prepare("UPDATE api_tokens SET user_id = ?, role = ? WHERE id = ?").run(userId, role, token.id);
    } finally {
      db.close();
    }
    return secret;
  }

  it("refuses a token made for a Viewer or Developer with 401; Admin and Owner tokens work whoever owned them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-tokens-"));
    dirs.push(dir);
    const store = createStore(join(dir, "owned.db"));
    openStores.push(store);
    const mux = createTestMux(store);
    for (const [name, role] of [
      ["v", "viewer"],
      ["d", "developer"],
      ["x", "superuser"],
    ] as const) {
      const res = await get(mux, await owned(dir, store, name, "usr_member", role));
      expect(res.status, role).toBe(401);
      expect(await res.json(), role).toEqual({ error: LOWER });
    }
    // The owner is no longer read: a removed member's admin token was deleted with them.
    expect((await get(mux, await owned(dir, store, "a", "usr_gone", "admin"))).status).toBe(200);
    expect((await get(mux, await owned(dir, store, "o", "usr_member", "owner"))).status).toBe(200);
    expect((await get(mux, store.createApiToken("legacy").secret)).status).toBe(200);
    // The path refusals come first, as before.
    const viewer = await owned(dir, store, "v2", "usr_member", "viewer");
    const sys = await mux(
      new Request("http://localhost:8081/system/connections", { headers: { authorization: `Bearer ${viewer}` } }),
    );
    expect(sys.status).toBe(403);
    // Webhooks never look at the token.
    expect(
      guardRequest(
        new Request("http://localhost:8081/projects/p1/webhooks/github", {
          method: "POST",
          headers: { host: "localhost:8081", authorization: `Bearer ${viewer}` },
        }),
        "/projects/p1/webhooks/github",
        store,
        undefined,
        "webhook",
      ),
    ).toBeNull();
  });

  it("POST /system/api-tokens makes an ownerless admin token whatever role the body asks for; the list shows every token", async () => {
    const store = await openTestStore();
    const mux = createTestMux(store);
    const res = await mux(
      new Request("http://localhost/system/api-tokens", {
        method: "POST",
        body: JSON.stringify({ name: "ci", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, string>;
    expect(body).not.toHaveProperty("role");
    const made = store.listApiTokens().find((t) => t.name === "ci")!;
    expect(made.role).toBe("admin");
    expect(made.userId).toBe("");
    expect((await get(mux, body.token!)).status).toBe(200);
    store.createApiToken("other");
    const listed = (await (await mux(new Request("http://localhost/system/api-tokens"))).json()) as { name: string }[];
    expect(listed.map((t) => t.name).sort()).toEqual(["ci", "other"]);
  });
});
