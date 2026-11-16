// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportPublicKey,
  generateSigningKeyPair,
  instructionBytes,
  keyFingerprint,
  sign,
  type SignedInstruction,
} from "@nbo/link-protocol";
import { createStore, type Store } from "../../store/store.js";
import { resetCodeHash, verifyInstruction, type Verdict } from "../verify.js";
import {
  makeEnvelope,
  makeLinkTestKeys,
  pinLink,
  signInstruction,
  type LinkTestKeys,
  type TestMemberKey,
} from "../../__tests__/link-keys-fixture.js";

let keys: LinkTestKeys;
let dir: string;
let dbPath: string;
let secret: Buffer;
let store: Store;
const now = new Date("2026-11-13T12:00:00.000Z");

beforeAll(async () => {
  keys = await makeLinkTestKeys();
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nbo-link-verify-"));
  dbPath = join(dir, "test.db");
  secret = randomBytes(32);
  store = createStore(dbPath, { secretKey: secret });
  await pinLink(store, keys);
});
afterEach(async () => {
  try {
    store.close();
  } catch {
    // already closed
  }
  await rm(dir, { recursive: true, force: true });
});

// journal: what the dispatcher does with an accepted verdict.
function journal(i: SignedInstruction, v: Verdict): void {
  if (!v.ok) throw new Error(`expected an accepted verdict, got ${v.reason}`);
  store.appendJournal({
    id: i.envelope.id,
    at: now.toISOString(),
    seq: i.envelope.seq,
    nonce: i.envelope.nonce,
    tier: v.tier,
    method: i.envelope.method,
    route: i.envelope.routePattern,
    signedBy: v.signedBy,
    status: 200,
    reason: "",
    accepted: true,
  });
}

const refused = (v: Verdict, status: number, reason: string | RegExp): void => {
  expect(v.ok).toBe(false);
  if (v.ok) return;
  expect(v.status).toBe(status);
  if (typeof reason === "string") expect(v.reason).toBe(reason);
  else expect(v.reason).toMatch(reason);
};

const tier2Env = (over: Parameters<typeof makeEnvelope>[2] = {}) =>
  makeEnvelope(keys, now, { method: "POST", routePattern: "/projects", body: { name: "site" }, ...over });

const memberKeysEnv = (body: unknown) =>
  makeEnvelope(keys, now, { method: "POST", routePattern: "/link/member-keys", body });

describe("verifyInstruction", () => {
  it("accepts a signed Tier 0 instruction", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now, { seq: 7 }));
    expect(await verifyInstruction(i, { store, now })).toEqual({ ok: true, tier: 0, signedBy: "platform" });
    expect(store.getLinkState()?.highSeq).toBe(7);
  });

  it("refuses when this core is not linked", async () => {
    store.clearLink();
    const i = await signInstruction(keys, makeEnvelope(keys, now));
    refused(await verifyInstruction(i, { store, now }), 403, "this core is not linked");
  });

  it("refuses an unsigned instruction", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now));
    refused(
      await verifyInstruction({ ...i, platformSignature: "" }, { store, now }),
      401,
      "instruction signature is not valid",
    );
  });

  it("refuses a signature by another key", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now), { platformKey: keys.stranger });
    refused(await verifyInstruction(i, { store, now }), 401, "instruction signature is not valid");
  });

  it("refuses an instruction naming another platform key id", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now, { platformKeyId: keys.stranger.keyId }));
    refused(await verifyInstruction(i, { store, now }), 401, "instruction signature is not valid");
  });

  it("refuses another core's id", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now, { coreId: "core_other" }));
    refused(await verifyInstruction(i, { store, now }), 403, "instruction is for another core");
    const t = await signInstruction(keys, makeEnvelope(keys, now, { teamId: "team_other" }));
    refused(await verifyInstruction(t, { store, now }), 403, "instruction is for another core");
  });

  it("refuses an empty id or nonce", async () => {
    for (const over of [{ id: "" }, { nonce: "" }]) {
      const i = await signInstruction(keys, makeEnvelope(keys, now, over));
      refused(await verifyInstruction(i, { store, now }), 401, "instruction has no id or nonce");
    }
  });

  it("refuses an expired instruction", async () => {
    const env = makeEnvelope(keys, now);
    const i = await signInstruction(keys, env);
    refused(
      await verifyInstruction(i, { store, now: new Date(env.expiresAt + 6_000) }),
      401,
      /^instruction expired at /,
    );
  });

  it("accepts an instruction inside the 5 s skew after its expiry", async () => {
    const env = makeEnvelope(keys, now);
    const i = await signInstruction(keys, env);
    expect((await verifyInstruction(i, { store, now: new Date(env.expiresAt + 5_000) })).ok).toBe(true);
  });

  it("a refusal for expiry names core's clock and the instruction's expiry", async () => {
    const env = makeEnvelope(keys, now);
    const i = await signInstruction(keys, env);
    const at = new Date(env.expiresAt + 6_000);
    refused(
      await verifyInstruction(i, { store, now: at }),
      401,
      `instruction expired at ${new Date(env.expiresAt).toISOString()}; this core's clock says ${at.toISOString()}`,
    );
  });

  it("refuses an expiry more than 65 s ahead", async () => {
    const env = makeEnvelope(keys, now, { expiresAt: now.getTime() + 65_001 });
    const i = await signInstruction(keys, env);
    refused(
      await verifyInstruction(i, { store, now }),
      401,
      `instruction expires too far ahead (${new Date(env.expiresAt).toISOString()}); this core's clock says ${now.toISOString()}`,
    );
    const ok = await signInstruction(keys, makeEnvelope(keys, now, { expiresAt: now.getTime() + 65_000 }));
    expect((await verifyInstruction(ok, { store, now })).ok).toBe(true);
  });

  it("refuses an expiry no date can show without throwing", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now, { expiresAt: Number.MAX_SAFE_INTEGER }));
    refused(await verifyInstruction(i, { store, now }), 401, /^instruction expires too far ahead/);
  });

  it("refuses a replayed instruction", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now));
    const v = await verifyInstruction(i, { store, now });
    journal(i, v);
    refused(await verifyInstruction(i, { store, now }), 409, "instruction was already received");
  });

  it("refuses a reused nonce under a new seq", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now));
    journal(i, await verifyInstruction(i, { store, now }));
    const again = await signInstruction(keys, makeEnvelope(keys, now, { nonce: i.envelope.nonce }));
    refused(await verifyInstruction(again, { store, now }), 409, "instruction was already received");
  });

  it("refuses a seq below the window", async () => {
    store.setHighSeq(100);
    const i = await signInstruction(keys, makeEnvelope(keys, now, { seq: 36 }));
    refused(await verifyInstruction(i, { store, now }), 409, "instruction was already received");
    const edge = await signInstruction(keys, makeEnvelope(keys, now, { seq: 37 }));
    expect((await verifyInstruction(edge, { store, now })).ok).toBe(true);
  });

  it("accepts out-of-order seqs inside the window", async () => {
    store.setHighSeq(100);
    const a = await signInstruction(keys, makeEnvelope(keys, now, { seq: 101 }));
    const va = await verifyInstruction(a, { store, now });
    journal(a, va);
    const b = await signInstruction(keys, makeEnvelope(keys, now, { seq: 99 }));
    const vb = await verifyInstruction(b, { store, now });
    expect(vb.ok).toBe(true);
    journal(b, vb);
    expect(store.getLinkState()?.highSeq).toBe(101);
  });

  it("a refused instruction does not raise highSeq", async () => {
    const i = await signInstruction(
      keys,
      makeEnvelope(keys, now, { seq: 500, routePattern: "/system/api-tokens", method: "POST" }),
    );
    expect((await verifyInstruction(i, { store, now })).ok).toBe(false);
    expect(store.getLinkState()?.highSeq).toBe(0);
  });

  it("an instruction accepted before a restart is refused after it", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now));
    journal(i, await verifyInstruction(i, { store, now }));
    store.close();
    store = createStore(dbPath, { secretKey: secret });
    refused(await verifyInstruction(i, { store, now }), 409, "instruction was already received");
  });

  it("after an unlink and a new link, the new link's seqs start again from 1", async () => {
    for (const seq of [1, 2, 3]) {
      const i = await signInstruction(keys, makeEnvelope(keys, now, { seq }));
      journal(i, await verifyInstruction(i, { store, now }));
    }
    store.clearLink();
    await pinLink(store, keys, { coreId: "core_new" });
    expect(store.getLinkState()?.highSeq).toBe(0);
    const first = await signInstruction(keys, makeEnvelope(keys, now, { seq: 1, coreId: "core_new" }));
    const v = await verifyInstruction(first, { store, now });
    expect(v).toEqual({ ok: true, tier: 0, signedBy: "platform" });
    journal(first, v);
    // Within the new link, a replay is still refused.
    refused(await verifyInstruction(first, { store, now }), 409, "instruction was already received");
    const again = await signInstruction(keys, makeEnvelope(keys, now, { seq: 1, coreId: "core_new" }));
    refused(await verifyInstruction(again, { store, now }), 409, "instruction was already received");
  });

  it("refuses a route with a null tier", async () => {
    const i = await signInstruction(
      keys,
      makeEnvelope(keys, now, { method: "POST", routePattern: "/system/api-tokens", body: {} }),
    );
    refused(
      await verifyInstruction(i, { store, now }),
      403,
      "route is not allowed over the link: POST /system/api-tokens",
    );
  });

  it("refuses a route with no row", async () => {
    const i = await signInstruction(keys, makeEnvelope(keys, now, { routePattern: "/__proto__" }));
    refused(await verifyInstruction(i, { store, now }), 403, "route is not allowed over the link: GET /__proto__");
  });

  it("accepts a Tier 1 instruction on the platform's signature alone", async () => {
    const i = await signInstruction(
      keys,
      makeEnvelope(keys, now, {
        method: "POST",
        routePattern: "/projects/{projectID}/builds",
        params: { projectID: "p1" },
        body: {},
      }),
    );
    expect(await verifyInstruction(i, { store, now })).toEqual({ ok: true, tier: 1, signedBy: "platform" });
  });

  it("accepts a Tier 2 signed by an Admin key", async () => {
    const i = await signInstruction(keys, tier2Env(), { member: keys.admin });
    expect(await verifyInstruction(i, { store, now })).toEqual({
      ok: true,
      tier: 2,
      signedBy: `${keys.admin.memberId}/${keys.admin.keyId}`,
    });
  });

  it("refuses a Tier 2 without a member signature", async () => {
    const i = await signInstruction(keys, tier2Env());
    refused(await verifyInstruction(i, { store, now }), 403, "Tier 2 needs a valid member signature");
  });

  it("refuses a custom environment, a new domain and a certificate on the platform's signature alone", async () => {
    for (const over of [
      { routePattern: "/projects/{projectID}/stages", body: { name: "staging", branch: "staging", clouds: [] } },
      { routePattern: "/projects/{projectID}/stages", body: { kind: "custom", name: "staging", branch: "staging" } },
      { routePattern: "/projects/{projectID}/domains", body: { host: "shop.example.com" } },
      {
        method: "PUT" as const,
        routePattern: "/projects/{projectID}/domains/{domainID}/certificate",
        params: { projectID: "p1", domainID: "d1" },
        body: { certPem: "x" },
      },
    ]) {
      const i = await signInstruction(
        keys,
        makeEnvelope(keys, now, { method: "POST", params: { projectID: "p1" }, ...over }),
      );
      refused(await verifyInstruction(i, { store, now }), 403, "Tier 2 needs a valid member signature");
    }
  });

  it("accepts an ephemeral stage on the platform's signature alone", async () => {
    const i = await signInstruction(
      keys,
      makeEnvelope(keys, now, {
        method: "POST",
        routePattern: "/projects/{projectID}/stages",
        params: { projectID: "p1" },
        body: { kind: "ephemeral", branch: "feature/x", hostLabel: "feature-x", clouds: [], ttlHours: 24 },
      }),
    );
    expect(await verifyInstruction(i, { store, now })).toEqual({ ok: true, tier: 1, signedBy: "platform" });
  });

  it("refuses a Tier 2 signed over other bytes", async () => {
    const env = tier2Env();
    const i = await signInstruction(keys, env, { member: keys.admin });
    const other = await signInstruction(keys, { ...env, body: { name: "other" } }, { member: keys.admin });
    refused(
      await verifyInstruction(
        { ...i, tier2Signature: { ...i.tier2Signature!, signature: other.tier2Signature!.signature } },
        { store, now },
      ),
      403,
      "Tier 2 needs a valid member signature",
    );
    // the platform's bytes are not the member's bytes
    const asPlatform = await sign(keys.admin.privateKey, instructionBytes(env));
    refused(
      await verifyInstruction(
        { ...i, tier2Signature: { ...i.tier2Signature!, signature: asPlatform } },
        { store, now },
      ),
      403,
      "Tier 2 needs a valid member signature",
    );
  });

  it("refuses a Tier 2 signed by a key not on the list", async () => {
    const i = await signInstruction(keys, tier2Env(), { member: keys.stranger });
    refused(await verifyInstruction(i, { store, now }), 403, "Tier 2 needs a valid member signature");
  });

  it("refuses a Tier 2 whose member id does not match the key's", async () => {
    const i = await signInstruction(keys, tier2Env(), { member: keys.admin });
    refused(
      await verifyInstruction(
        { ...i, tier2Signature: { ...i.tier2Signature!, memberId: keys.owner.memberId } },
        { store, now },
      ),
      403,
      "Tier 2 needs a valid member signature",
    );
  });

  it("refuses a Tier 2 with empty signature fields", async () => {
    const i = await signInstruction(keys, tier2Env(), { member: keys.admin });
    for (const field of ["keyId", "memberId", "signature"] as const) {
      refused(
        await verifyInstruction({ ...i, tier2Signature: { ...i.tier2Signature!, [field]: "" } }, { store, now }),
        403,
        "Tier 2 needs a valid member signature",
      );
    }
  });

  it("refuses a Developer-role key on a Tier 2 route", async () => {
    const i = await signInstruction(keys, tier2Env(), { member: keys.developer });
    refused(
      await verifyInstruction(i, { store, now }),
      403,
      "the signing key's role developer can't sign POST /projects",
    );
  });

  it("refuses an Admin key on POST /link/member-keys", async () => {
    const i = await signInstruction(keys, memberKeysEnv({ memberId: "m9", role: "admin", publicKey: "PUB" }), {
      member: keys.admin,
    });
    refused(
      await verifyInstruction(i, { store, now }),
      403,
      "the signing key's role admin can't sign POST /link/member-keys",
    );
  });

  it("accepts an Owner key on POST /link/member-keys", async () => {
    const i = await signInstruction(keys, memberKeysEnv({ memberId: "m9", role: "admin", publicKey: "PUB" }), {
      member: keys.owner,
    });
    expect(await verifyInstruction(i, { store, now })).toEqual({
      ok: true,
      tier: 2,
      signedBy: `${keys.owner.memberId}/${keys.owner.keyId}`,
    });
  });

  it("accepts a reset code once instead of a member signature", async () => {
    store.createResetCode(
      resetCodeHash("RESET-1234"),
      await keyFingerprint("PUB"),
      new Date(now.getTime() + 600_000).toISOString(),
    );
    const body = { memberId: "m9", role: "owner", publicKey: "PUB", resetCode: "RESET-1234" };
    const i = await signInstruction(keys, memberKeysEnv(body));
    const v = await verifyInstruction(i, { store, now });
    expect(v).toEqual({ ok: true, tier: 2, signedBy: "reset-code" });
    journal(i, v);
    const again = await signInstruction(keys, memberKeysEnv(body));
    refused(await verifyInstruction(again, { store, now }), 403, "Tier 2 needs a valid member signature");
  });

  it("a refused instruction never uses up a reset code", async () => {
    store.createResetCode(
      resetCodeHash("RESET-5678"),
      await keyFingerprint("PUB"),
      new Date(now.getTime() + 600_000).toISOString(),
    );
    const body = { memberId: "m9", role: "owner", publicKey: "PUB", resetCode: "RESET-5678" };
    const bad = await signInstruction(keys, memberKeysEnv(body), { platformKey: keys.stranger });
    refused(await verifyInstruction(bad, { store, now }), 401, "instruction signature is not valid");
    const expired = await signInstruction(
      keys,
      makeEnvelope(keys, now, {
        method: "POST",
        routePattern: "/link/member-keys",
        body,
        expiresAt: now.getTime() - 10_000,
      }),
    );
    expect((await verifyInstruction(expired, { store, now })).ok).toBe(false);
    const good = await signInstruction(keys, memberKeysEnv(body));
    expect(await verifyInstruction(good, { store, now })).toEqual({ ok: true, tier: 2, signedBy: "reset-code" });
  });

  it("a reset code registers only the key it was made for, and a wrong key uses it up", async () => {
    const other = await exportPublicKey((await generateSigningKeyPair(false)).publicKey);
    store.createResetCode(
      resetCodeHash("RESET-KEY"),
      await keyFingerprint(other),
      new Date(now.getTime() + 600_000).toISOString(),
    );
    const wrong = await signInstruction(
      keys,
      memberKeysEnv({ memberId: "m9", role: "owner", publicKey: "PUB", resetCode: "RESET-KEY" }),
    );
    const v = await verifyInstruction(wrong, { store, now });
    refused(
      v,
      403,
      `this reset code is for the key ${await keyFingerprint(other)}, not ${await keyFingerprint("PUB")}; it is used up now: run nbo-server keys reset --key <fingerprint> again`,
    );
    // The code is gone: not even the key it named can use it now.
    const right = await signInstruction(
      keys,
      memberKeysEnv({ memberId: "m9", role: "owner", publicKey: other, resetCode: "RESET-KEY" }),
    );
    refused(await verifyInstruction(right, { store, now }), 403, "Tier 2 needs a valid member signature");
  });

  it("a reset code with a malformed public key is refused and used up", async () => {
    store.createResetCode(
      resetCodeHash("RESET-BAD"),
      await keyFingerprint("PUB"),
      new Date(now.getTime() + 600_000).toISOString(),
    );
    const bad = await signInstruction(
      keys,
      memberKeysEnv({ memberId: "m9", role: "owner", publicKey: 42, resetCode: "RESET-BAD" }),
    );
    expect((await verifyInstruction(bad, { store, now })).ok).toBe(false);
    expect(store.useResetCode(resetCodeHash("RESET-BAD"), now)).toBeNull();
  });

  it("a reset code works only on POST /link/member-keys", async () => {
    store.createResetCode(
      resetCodeHash("RESET-9"),
      await keyFingerprint("PUB"),
      new Date(now.getTime() + 600_000).toISOString(),
    );
    const i = await signInstruction(keys, tier2Env({ body: { name: "site", resetCode: "RESET-9" } }));
    refused(await verifyInstruction(i, { store, now }), 403, "Tier 2 needs a valid member signature");
  });

  it("refuses a seeded key whose role is named after an Object member", async () => {
    for (const role of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      const pair = await generateSigningKeyPair(false);
      const publicKey = await exportPublicKey(pair.publicKey);
      const member: TestMemberKey = {
        keyId: await keyFingerprint(publicKey),
        publicKey,
        privateKey: pair.privateKey,
        memberId: `mem_${role}`,
        role,
      };
      store.addMemberKey({ keyId: member.keyId, memberId: member.memberId, role, publicKey, addedBy: "test" });
      const i = await signInstruction(keys, tier2Env(), { member });
      refused(
        await verifyInstruction(i, { store, now }),
        403,
        `the signing key's role ${role} can't sign POST /projects`,
      );
    }
  });

  it("a badly signed Tier 2 learns nothing about the key's role", async () => {
    const i = await signInstruction(keys, tier2Env(), { member: keys.developer });
    const other = await signInstruction(keys, tier2Env(), { member: keys.developer });
    refused(
      await verifyInstruction(
        { ...i, tier2Signature: { ...i.tier2Signature!, signature: other.tier2Signature!.signature } },
        { store, now },
      ),
      403,
      "Tier 2 needs a valid member signature",
    );
  });

  it("never rejects on a body nested too deep to sign", async () => {
    let body: unknown = "x";
    for (let n = 0; n < 70; n++) body = { a: body };
    const env = makeEnvelope(keys, now, { method: "POST", routePattern: "/projects", body });
    const v = verifyInstruction({ envelope: env, platformSignature: "AAAA" }, { store, now });
    await expect(v).resolves.toEqual({ ok: false, status: 401, reason: "instruction signature is not valid" });
  });

  it("refuses a malformed seq or expiry", async () => {
    for (const over of [
      { expiresAt: Number.NaN },
      { expiresAt: Number.POSITIVE_INFINITY },
      { expiresAt: 1.5 },
      { seq: -1 },
      { seq: 1.5 },
      { seq: Number.NaN },
    ]) {
      const env = makeEnvelope(keys, now, over);
      const v = await verifyInstruction({ envelope: env, platformSignature: "AAAA" }, { store, now });
      refused(v, 401, "instruction is malformed");
    }
  });

  it("refuses a seq that jumps more than 1,000,000 ahead", async () => {
    store.setHighSeq(10);
    const far = await signInstruction(keys, makeEnvelope(keys, now, { seq: 1_000_011 }));
    refused(await verifyInstruction(far, { store, now }), 401, "instruction sequence jumps too far ahead");
    expect(store.getLinkState()?.highSeq).toBe(10);
    const edge = await signInstruction(keys, makeEnvelope(keys, now, { seq: 1_000_010 }));
    expect((await verifyInstruction(edge, { store, now })).ok).toBe(true);
  });
});
