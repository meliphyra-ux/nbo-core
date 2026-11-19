// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { b64u, keyFingerprint, type Envelope } from "@nbo/link-protocol";
import { createStore, type Store } from "../../store/store.js";
import type { Mux } from "../../http/handlers.js";
import { createDispatcher, type Dispatcher, type LinkReply } from "../dispatch.js";
import { startLinkClient } from "../client.js";
import { createLinkControl } from "../routes.js";
import { resetCodeHash } from "../verify.js";
import { startHarness, bearer, type Harness } from "../../__tests__/v2-harness.js";
import {
  CORE_ID,
  TEAM_ID,
  makeEnvelope,
  makeLinkTestKeys,
  noSecrets,
  pinLink,
  signInstruction,
  type LinkTestKeys,
  type TestMemberKey,
} from "../../__tests__/link-keys-fixture.js";
import { makeTestKey, startFakePlatform } from "../../__tests__/link-fake-platform.js";

let keys: LinkTestKeys;
beforeAll(async () => {
  keys = await makeLinkTestKeys();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const LAST_OWNER =
  "the last Owner key can't be removed; register another Owner key first, or run nbo-server keys reset --key <your key's fingerprint> on the server";

interface Setup {
  h: Harness;
  control: ReturnType<typeof createLinkControl>;
  dispatcher: Dispatcher;
}

async function setup(opts: { linked?: boolean; mux?: (h: Harness) => Mux } = {}): Promise<Setup> {
  const control = createLinkControl();
  const h = await startHarness({ secretKey: true, v2: { link: control } });
  cleanups.push(() => h.close());
  if (opts.linked !== false) await pinLink(h.store, keys);
  const dispatcher = createDispatcher({ ...noSecrets, store: h.store, mux: opts.mux ? opts.mux(h) : h.mux });
  return { h, control, dispatcher };
}

async function bodyOf(reply: LinkReply): Promise<string> {
  if (reply.kind === "response") return new TextDecoder().decode(reply.body);
  const parts: Uint8Array[] = [];
  for await (const c of reply.chunks) parts.push(c);
  return Buffer.concat(parts).toString("utf8");
}

// send: an instruction from the platform, signed by member when given.
async function send(
  d: Dispatcher,
  over: Partial<Envelope>,
  member?: TestMemberKey,
): Promise<{ status: number; json: any }> {
  const i = await signInstruction(keys, makeEnvelope(keys, new Date(), over), member ? { member } : {});
  const reply = await d.dispatch(i);
  const text = await bodyOf(reply);
  return { status: reply.status, json: text === "" ? null : JSON.parse(text) };
}

const register = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  routePattern: "/link/member-keys",
  body,
});

async function newMember(memberId: string, role: string): Promise<TestMemberKey> {
  return { ...(await makeTestKey()), memberId, role };
}

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("link status", () => {
  it("status says not linked on a fresh core", async () => {
    const { h } = await setup({ linked: false });
    const res = await h.call("GET", "/link/status");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      linked: false,
      connection: "off",
      transport: null,
      lastConnectedAt: null,
      lastError: null,
      memberKeys: 0,
      version: "dev",
    });
  });

  it("status names the release the image was built from", async () => {
    const { h } = await setup();
    vi.stubEnv("NBO_VERSION", "v2026.11.19");
    try {
      expect((await h.call("GET", "/link/status")).json).toMatchObject({ version: "v2026.11.19" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("status names the core, the team and the pinned platform key once linked", async () => {
    const { h } = await setup();
    const res = await h.call("GET", "/link/status");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      linked: true,
      coreId: CORE_ID,
      teamId: TEAM_ID,
      linkUrl: "https://platform.example.test/link",
      platformKeyId: keys.platform.keyId,
      platformKeyFingerprint: await keyFingerprint(keys.platform.publicKey),
      connection: "off",
      memberKeys: 3,
    });
    expect(res.text).not.toMatch(/Pkcs8|sealed|identity|encryptionPublic|"encryptionKey"/i);
  });
});

describe("member keys", () => {
  it("an Owner-signed instruction registers an Admin key", async () => {
    const { h, dispatcher } = await setup();
    const admin = await newMember("mem_new_admin", "admin");
    const res = await send(
      dispatcher,
      register({ memberId: admin.memberId, role: "admin", publicKey: admin.publicKey }),
      keys.owner,
    );
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      keyId: admin.keyId,
      memberId: admin.memberId,
      role: "admin",
      fingerprint: admin.keyId,
    });
    const list = await h.call("GET", "/link/member-keys");
    expect(list.json).toContainEqual(
      expect.objectContaining({
        keyId: admin.keyId,
        memberId: admin.memberId,
        role: "admin",
        fingerprint: admin.keyId,
        addedBy: `${keys.owner.memberId}/${keys.owner.keyId}`,
      }),
    );
    for (const k of list.json)
      expect(Object.keys(k).sort()).toEqual(["addedAt", "addedBy", "fingerprint", "keyId", "memberId", "role"]);
    // The new key signs Tier 2 instructions an Admin may sign.
    const made = await send(dispatcher, { method: "POST", routePattern: "/projects", body: { name: "shop" } }, admin);
    expect(made.status).toBe(201);
    // But not the member-keys routes, which are the Owners'.
    const other = await newMember("mem_other", "admin");
    const refused = await send(
      dispatcher,
      register({ memberId: other.memberId, role: "admin", publicKey: other.publicKey }),
      admin,
    );
    expect(refused.status).toBe(403);
  });

  it("a key registered from this computer is added by local", async () => {
    const { h } = await setup();
    const owner = await newMember("mem_local", "owner");
    const res = await h.call("POST", "/link/member-keys", {
      memberId: owner.memberId,
      role: "owner",
      publicKey: owner.publicKey,
    });
    expect(res.status).toBe(201);
    expect(h.store.getMemberKey(owner.keyId)).toMatchObject({ addedBy: "local", role: "owner" });
    // The same key again is a conflict.
    expect(
      (
        await h.call("POST", "/link/member-keys", {
          memberId: owner.memberId,
          role: "owner",
          publicKey: owner.publicKey,
        })
      ).status,
    ).toBe(409);
  });

  it("a platform-sent registration with no Owner signature is refused and its key can't sign", async () => {
    const { h, dispatcher } = await setup();
    const planted = await newMember("mem_planted", "owner");
    const res = await send(
      dispatcher,
      register({ memberId: planted.memberId, role: "owner", publicKey: planted.publicKey }),
    );
    expect(res.status).toBe(403);
    expect(h.store.getMemberKey(planted.keyId)).toBeUndefined();
    const signedByPlanted = await send(
      dispatcher,
      { method: "POST", routePattern: "/projects", body: { name: "shop" } },
      planted,
    );
    expect(signedByPlanted.status).toBe(403);
    expect(h.store.listProjects()).toHaveLength(0);
  });

  it("registration refuses role developer", async () => {
    const { h, dispatcher } = await setup();
    const dev = await newMember("mem_dev2", "developer");
    const res = await send(
      dispatcher,
      register({ memberId: dev.memberId, role: "developer", publicKey: dev.publicKey }),
      keys.owner,
    );
    expect(res.status).toBe(400);
    expect(h.store.getMemberKey(dev.keyId)).toBeUndefined();
    for (const role of ["developer", "Owner", "", "__proto__"]) {
      expect(
        (await h.call("POST", "/link/member-keys", { memberId: dev.memberId, role, publicKey: dev.publicKey })).status,
        role,
      ).toBe(400);
    }
  });

  it("registration refuses a key that does not import, a small-order key and a bad member id", async () => {
    const { h } = await setup();
    const good = await newMember("mem_x", "admin");
    const smallOrder = b64u.encode(Uint8Array.from([1, ...new Array<number>(31).fill(0)]));
    for (const publicKey of ["not-a-key", smallOrder, "", 42]) {
      expect(
        (await h.call("POST", "/link/member-keys", { memberId: "mem_x", role: "admin", publicKey })).status,
        String(publicKey),
      ).toBe(400);
    }
    for (const memberId of ["", "has space", "x".repeat(129), "tab\there", 7]) {
      expect(
        (await h.call("POST", "/link/member-keys", { memberId, role: "admin", publicKey: good.publicKey })).status,
        String(memberId),
      ).toBe(400);
    }
    expect((await h.call("POST", "/link/member-keys", "nope")).status).toBe(400);
  });

  it("registration needs a linked core", async () => {
    const { h } = await setup({ linked: false });
    const owner = await newMember("mem_o", "owner");
    expect(
      (
        await h.call("POST", "/link/member-keys", {
          memberId: owner.memberId,
          role: "owner",
          publicKey: owner.publicKey,
        })
      ).status,
    ).toBe(409);
  });

  it("refuses removing the last Owner key", async () => {
    const { h, dispatcher } = await setup();
    const res = await h.call("DELETE", `/link/member-keys/${encodeURIComponent(keys.owner.keyId)}`);
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: LAST_OWNER });
    expect(h.store.getMemberKey(keys.owner.keyId)).toBeDefined();
    // Over the link, signed by that Owner, too.
    const linked = await send(
      dispatcher,
      { method: "DELETE", routePattern: "/link/member-keys/{keyId}", params: { keyId: keys.owner.keyId } },
      keys.owner,
    );
    expect(linked.status).toBe(409);
    // An Admin key goes; an unknown one is 404.
    expect((await h.call("DELETE", `/link/member-keys/${encodeURIComponent(keys.admin.keyId)}`)).status).toBe(204);
    expect(h.store.getMemberKey(keys.admin.keyId)).toBeUndefined();
    expect((await h.call("DELETE", `/link/member-keys/${encodeURIComponent(keys.admin.keyId)}`)).status).toBe(404);
    // With a second Owner, the first can go.
    const second = await newMember("mem_owner2", "owner");
    expect(
      (
        await send(
          dispatcher,
          register({ memberId: second.memberId, role: "owner", publicKey: second.publicKey }),
          keys.owner,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await send(
          dispatcher,
          { method: "DELETE", routePattern: "/link/member-keys/{keyId}", params: { keyId: keys.owner.keyId } },
          second,
        )
      ).status,
    ).toBe(204);
    expect(h.store.getMemberKey(keys.owner.keyId)).toBeUndefined();
  });

  it("keys-reset prints a code that registers one Owner key, the one it names, once", async () => {
    const { h, dispatcher } = await setup();
    const back = await newMember("mem_back", "owner");
    const before = Date.now();
    const res = await h.call("POST", "/system/link/keys-reset", { keyFingerprint: back.keyId });
    expect(res.status).toBe(200);
    const { code, expiresAt, keyFingerprint } = res.json as { code: string; expiresAt: string; keyFingerprint: string };
    expect(keyFingerprint).toBe(back.keyId);
    expect(code).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{1,4})+$/);
    expect(code.replace(/-/g, "")).toHaveLength(26);
    const exp = Date.parse(expiresAt);
    expect(exp).toBeGreaterThanOrEqual(before + 3600_000 - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 3600_000 + 1000);
    // Only its SHA-256 is stored, with the key it is for.
    const raw = new DatabaseSync(h.dbPath);
    const rows = raw.prepare("SELECT code_hash, key_fingerprint FROM link_reset_codes").all() as {
      code_hash: string;
      key_fingerprint: string;
    }[];
    raw.close();
    expect(rows).toEqual([{ code_hash: resetCodeHash(code), key_fingerprint: back.keyId }]);
    // Two codes are never the same.
    const again = await h.call("POST", "/system/link/keys-reset", { keyFingerprint: back.keyId });
    expect(again.json.code).not.toBe(code);

    const ok = await send(
      dispatcher,
      register({ memberId: back.memberId, role: "owner", publicKey: back.publicKey, resetCode: code }),
    );
    expect(ok.status).toBe(201);
    expect(h.store.getMemberKey(back.keyId)).toMatchObject({ role: "owner", addedBy: "reset-code" });
    const twice = await newMember("mem_twice", "owner");
    const used = await send(
      dispatcher,
      register({ memberId: twice.memberId, role: "owner", publicKey: twice.publicKey, resetCode: code }),
    );
    expect(used.status).toBe(403);
    expect(h.store.getMemberKey(twice.keyId)).toBeUndefined();
  });

  it("a reset code refuses another key and is used up by the try", async () => {
    const { h, dispatcher } = await setup();
    const meant = await newMember("mem_meant", "owner");
    const thief = await newMember("mem_thief", "owner");
    const { code } = (await h.call("POST", "/system/link/keys-reset", { keyFingerprint: meant.keyId })).json as {
      code: string;
    };
    const stolen = await send(
      dispatcher,
      register({ memberId: thief.memberId, role: "owner", publicKey: thief.publicKey, resetCode: code }),
    );
    expect(stolen.status).toBe(403);
    expect(stolen.json.error).toMatch(/this reset code is for the key .* it is used up now/);
    expect(h.store.getMemberKey(thief.keyId)).toBeUndefined();
    const late = await send(
      dispatcher,
      register({ memberId: meant.memberId, role: "owner", publicKey: meant.publicKey, resetCode: code }),
    );
    expect(late.status).toBe(403);
    expect(h.store.getMemberKey(meant.keyId)).toBeUndefined();
  });

  it("keys-reset needs the fingerprint of the key it is for", async () => {
    const { h } = await setup();
    for (const body of [{}, { keyFingerprint: "" }, { keyFingerprint: "abc" }, { keyFingerprint: 7 }, null]) {
      const res = await h.call("POST", "/system/link/keys-reset", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error).toMatch(/keyFingerprint/);
    }
    const raw = new DatabaseSync(h.dbPath);
    const codes = raw.prepare("SELECT COUNT(*) AS n FROM link_reset_codes").get() as { n: number };
    raw.close();
    expect(codes.n).toBe(0);
  });

  it("a reset code registers an Owner key only", async () => {
    const { h, dispatcher } = await setup();
    const admin = await newMember("mem_admin_reset", "admin");
    const { code } = (await h.call("POST", "/system/link/keys-reset", { keyFingerprint: admin.keyId })).json as {
      code: string;
    };
    const res = await send(
      dispatcher,
      register({ memberId: admin.memberId, role: "admin", publicKey: admin.publicKey, resetCode: code }),
    );
    expect(res.status).toBe(400);
    expect(h.store.getMemberKey(admin.keyId)).toBeUndefined();
  });

  it("keys-reset needs a linked core", async () => {
    const { h } = await setup({ linked: false });
    const fp = (await newMember("mem_x", "owner")).keyId;
    expect((await h.call("POST", "/system/link/keys-reset", { keyFingerprint: fp })).status).toBe(409);
  });
});

describe("journal", () => {
  it("lists newest first, with limit and before", async () => {
    const { h } = await setup();
    const at = (n: number) => new Date(Date.UTC(2026, 10, 13, 12, 0, n)).toISOString();
    for (let n = 0; n < 5; n++) {
      h.store.appendJournal({
        id: `ins_${n}`,
        at: at(n),
        seq: n + 1,
        nonce: `n${n}`,
        tier: 0,
        method: "GET",
        route: "/projects",
        signedBy: "platform",
        status: 200,
        reason: "",
        accepted: true,
      });
    }
    const all = await h.call("GET", "/link/journal");
    expect(all.status).toBe(200);
    expect(all.json.map((e: any) => e.id)).toEqual(["ins_4", "ins_3", "ins_2", "ins_1", "ins_0"]);
    expect((await h.call("GET", "/link/journal?limit=2")).json.map((e: any) => e.id)).toEqual(["ins_4", "ins_3"]);
    expect(
      (await h.call("GET", `/link/journal?before=${encodeURIComponent(at(2))}`)).json.map((e: any) => e.id),
    ).toEqual(["ins_1", "ins_0"]);
    for (const q of ["limit=0", "limit=501", "limit=abc", "limit=1.5", "before=yesterday"]) {
      expect((await h.call("GET", `/link/journal?${q}`)).status, q).toBe(400);
    }
    expect((await h.call("GET", "/link/journal?limit=500")).status).toBe(200);
  });

  it("the client prunes journal rows older than 90 days", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nbo-link-routes-"));
    const store: Store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
    cleanups.push(async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    });
    const now = new Date("2026-11-13T12:00:00.000Z");
    const row = (id: string, at: string) => ({
      id,
      at,
      seq: -1,
      nonce: "",
      tier: -1,
      method: "LINK",
      route: "revoked",
      signedBy: "platform",
      status: 403,
      reason: "",
      accepted: false,
    });
    store.appendJournal(row("old", new Date(now.getTime() - 91 * 86_400_000).toISOString()));
    store.appendJournal(row("recent", new Date(now.getTime() - 89 * 86_400_000).toISOString()));
    const ac = new AbortController();
    const c = startLinkClient({
      store,
      dispatcher: {
        dispatch: async () => {
          throw new Error("none");
        },
      },
      signal: ac.signal,
      now: () => now,
    });
    cleanups.push(() => c.stop());
    await until(() => store.listJournal({ limit: 10 }).length === 1);
    expect(store.listJournal({ limit: 10 }).map((e) => e.id)).toEqual(["recent"]);
  });
});

describe("unlink", () => {
  it("unlink drops pinned keys and member keys and keeps the journal", async () => {
    const { h, dispatcher } = await setup();
    const read = await send(dispatcher, { method: "GET", routePattern: "/projects" });
    expect(read.status).toBe(200);
    const res = await h.call("POST", "/system/link/unlink", {});
    expect(res.status).toBe(204);
    expect(h.store.getLinkState()).toBeNull();
    expect(h.store.openLinkKeys()).toBeNull();
    expect(h.store.listMemberKeys()).toEqual([]);
    const journal = await h.call("GET", "/link/journal");
    expect(journal.json.length).toBeGreaterThanOrEqual(1);
    expect((await h.call("GET", "/link/status")).json).toMatchObject({ linked: false, memberKeys: 0 });
    // Nothing the platform signed runs any more.
    expect((await send(dispatcher, { method: "GET", routePattern: "/projects" })).status).toBe(403);
  });

  it("unlink drops in-flight answers and stays unlinked", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let handlerDone = false;
    // A mux whose POST /projects handler waits on the gate before it runs.
    const gated = (h: Harness): Mux =>
      Object.assign((r: Request) => h.mux(r), {
        routes: () => h.mux.routes(),
        match: (r: Request) => {
          const m = h.mux.match(r);
          if (!m || m.pattern !== "/projects" || m.method !== "POST") return m;
          return {
            ...m,
            handler: async (req: Request, params: Record<string, string>) => {
              await gate;
              const res = await m.handler(req, params);
              handlerDone = true;
              return res;
            },
          };
        },
      });
    const p = await startFakePlatform(keys);
    cleanups.push(() => p.close());
    const control = createLinkControl();
    const h = await startHarness({ secretKey: true, v2: { link: control } });
    cleanups.push(() => h.close());
    await pinLink(h.store, keys, { linkUrl: p.url, linkHost: p.host });
    p.trust(CORE_ID, h.store.getLinkState()!.identityPublic);
    const dispatcher = createDispatcher({ ...noSecrets, store: h.store, mux: gated(h) });
    const ac = new AbortController();
    const client = startLinkClient({ store: h.store, dispatcher, signal: ac.signal, random: () => 0 });
    cleanups.push(() => client.stop());
    control.attach(client);
    await until(() => control.status().connection === "connected");
    expect((await h.call("GET", "/link/status")).json).toMatchObject({
      linked: true,
      connection: "connected",
      transport: "websocket",
    });

    const id = await p.sendInstruction(
      { method: "POST", routePattern: "/projects", body: { name: "inflight" } },
      { member: keys.owner },
    );
    await until(() => h.store.listJournal({ limit: 10 }).some((j) => j.id === id && j.accepted));
    expect((await h.call("POST", "/system/link/unlink", {})).status).toBe(204);
    release();
    await until(() => handlerDone);
    // The handler's work is done: core work is never cut short.
    expect(h.store.listProjects().map((x) => x.name)).toContain("inflight");
    await new Promise((r) => setTimeout(r, 3000));
    expect(p.messagesFor(id).some((m) => m.type === "response" || m.type === "stream-start")).toBe(false);
    expect(p.connects).toHaveLength(1);
    expect(control.status().connection).toBe("off");
    // The old socket is gone: nothing more can reach core on it.
    await expect(p.sendInstruction({ method: "GET", routePattern: "/projects" })).rejects.toThrow(/no live connection/);
    expect(h.store.getLinkState()).toBeNull();
  }, 15_000);
});

describe("who may use the link routes", () => {
  it("the link routes under /system are refused over the link", async () => {
    const { h, dispatcher } = await setup();
    for (const route of ["/system/link/unlink", "/system/link/keys-reset", "/system/link/enroll"]) {
      const res = await send(dispatcher, { method: "POST", routePattern: route, body: {} }, keys.owner);
      expect(res.status, route).toBe(403);
      expect(res.json.error, route).toMatch(/not allowed over the link/);
    }
    expect(h.store.getLinkState()).not.toBeNull();
    const raw = new DatabaseSync(h.dbPath);
    const codes = raw.prepare("SELECT COUNT(*) AS n FROM link_reset_codes").get() as { n: number };
    raw.close();
    expect(codes.n).toBe(0);
  });

  it("a token can't call /system/link/*", async () => {
    const { h } = await setup();
    const token = bearer(h.store.createApiToken("ops").secret);
    for (const route of ["/system/link/unlink", "/system/link/keys-reset", "/system/link/enroll"]) {
      const res = await h.call("POST", route, {}, token);
      expect(res.status, route).toBe(403);
    }
    expect(h.store.getLinkState()).not.toBeNull();
    // The token routes take a token.
    expect((await h.call("GET", "/link/status", undefined, token)).status).toBe(200);
  });
});

describe("enroll route", () => {
  it("enrolls with the code and restarts the link", async () => {
    const CODE = "enr_route_7Hq2pLx9";
    const p = await startFakePlatform(keys, { codes: [CODE] });
    cleanups.push(() => p.close());
    const { h, control } = await setup({ linked: false });
    let restarts = 0;
    control.attach({
      status: () => ({ connection: "off", transport: null, lastConnectedAt: null, lastError: null }),
      restart: () => void restarts++,
      disconnect: () => undefined,
    });
    const res = await h.call("POST", "/system/link/enroll", {
      url: p.url,
      code: CODE,
      ownerKeyFingerprint: keys.owner.keyId,
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ linked: true, coreId: CORE_ID, teamId: TEAM_ID });
    expect(res.text).not.toContain(CODE);
    expect(restarts).toBe(1);
    // Used: a second try is a refusal that names no code.
    const again = await h.call("POST", "/system/link/enroll", {
      url: p.url,
      code: CODE,
      ownerKeyFingerprint: keys.owner.keyId,
    });
    expect(again.status).toBe(409);
    expect(again.text).not.toContain(CODE);
  });

  it("refuses a missing field and a refused code without the code in the answer", async () => {
    const CODE = "enr_route_unknown_Zk3";
    const p = await startFakePlatform(keys);
    cleanups.push(() => p.close());
    const { h } = await setup({ linked: false });
    expect((await h.call("POST", "/system/link/enroll", { url: p.url, code: CODE })).status).toBe(400);
    const res = await h.call("POST", "/system/link/enroll", {
      url: p.url,
      code: CODE,
      ownerKeyFingerprint: keys.owner.keyId,
    });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(CODE);
    expect(h.store.getLinkState()).toBeNull();
  });
});
