// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import {
  CLOCK_SKEW_MS,
  MAX_EXPIRY_MS,
  instructionBytes,
  keyFingerprint,
  tier2Bytes,
  verify,
  type SignedInstruction,
  type Tier,
} from "@nbo/link-protocol";
import type { Store } from "../store/store.js";
import { requiredRole, resolveTier } from "./tiers.js";

export type Verdict =
  { ok: true; tier: Tier; signedBy: string } | { ok: false; status: 401 | 403 | 409; reason: string };

// How far below the highest accepted sequence number an instruction may
// still arrive (out of order); anything older is a replay.
const SEQ_WINDOW = 64;

// How far above the highest accepted sequence number an instruction may
// jump, so one signed huge seq can't make every later one a replay.
const MAX_SEQ_JUMP = 1_000_000;

// roleAllows: compared by value, never looked up in an object, so a stored
// role such as "constructor" or "__proto__" can't pass.
function roleAllows(role: string, need: "admin" | "owner"): boolean {
  if (need === "owner") return role === "owner";
  return role === "owner" || role === "admin";
}

const MEMBER_KEYS_ROUTE = "POST /link/member-keys";

// resetCodeHash: how a one-time reset code is stored and looked up.
export function resetCodeHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

const refuse = (status: 401 | 403 | 409, reason: string): Verdict => ({ ok: false, status, reason });

// iso: an ISO time for a reason text; a number no Date can hold is shown as is.
function iso(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

function resetCodeOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const code = (body as Record<string, unknown>).resetCode;
  return typeof code === "string" && code !== "" ? code : null;
}

// publicKeyFingerprintOf: the fingerprint of the body's publicKey, or null
// when there is none or it can't be read.
async function publicKeyFingerprintOf(body: unknown): Promise<string | null> {
  const publicKey = (body as Record<string, unknown>).publicKey;
  if (typeof publicKey !== "string" || publicKey === "") return null;
  try {
    return await keyFingerprint(publicKey);
  } catch {
    return null;
  }
}

// bytesOf: the signing bytes, or null when the envelope can't be
// canonicalised (nested too deep, a cycle, a non-finite number).
function bytesOf(
  make: (e: SignedInstruction["envelope"]) => Uint8Array,
  e: SignedInstruction["envelope"],
): Uint8Array | null {
  try {
    return make(e);
  } catch {
    return null;
  }
}

// verifyInstruction: every check an instruction from the platform passes
// before anything runs. It never journals (the caller journals every
// verdict); it raises highSeq only for an accepted instruction, and it uses
// up a reset code only once every other check has passed. It never
// rejects on a malformed instruction: every refusal is a verdict.
export async function verifyInstruction(i: SignedInstruction, deps: { store: Store; now: Date }): Promise<Verdict> {
  const { store, now } = deps;
  const e = i.envelope;

  // 1. linked, and signed by the pinned platform key.
  const state = store.getLinkState();
  if (!state) return refuse(403, "this core is not linked");
  if (!Number.isSafeInteger(e.seq) || e.seq < 0 || !Number.isSafeInteger(e.expiresAt)) {
    return refuse(401, "instruction is malformed");
  }
  const signed = bytesOf(instructionBytes, e);
  if (
    signed === null ||
    e.platformKeyId === "" ||
    e.platformKeyId !== state.platformKeyId ||
    i.platformSignature === "" ||
    !(await verify(state.platformKey, i.platformSignature, signed))
  ) {
    return refuse(401, "instruction signature is not valid");
  }
  if (e.id === "" || e.nonce === "") return refuse(401, "instruction has no id or nonce");

  // 2. for this core and this team.
  if (e.coreId === "" || e.teamId === "" || e.coreId !== state.coreId || e.teamId !== state.teamId) {
    return refuse(403, "instruction is for another core");
  }

  // 3. expiry, with the allowed clock skew on each side.
  const t = now.getTime();
  if (t > e.expiresAt + CLOCK_SKEW_MS) {
    return refuse(401, `instruction expired at ${iso(e.expiresAt)}; this core's clock says ${now.toISOString()}`);
  }
  if (e.expiresAt - t > MAX_EXPIRY_MS + CLOCK_SKEW_MS) {
    return refuse(
      401,
      `instruction expires too far ahead (${iso(e.expiresAt)}); this core's clock says ${now.toISOString()}`,
    );
  }

  // 4. replay: below the window, or a seq or nonce already accepted.
  if (e.seq <= state.highSeq - SEQ_WINDOW || store.journalHas(e.seq, e.nonce)) {
    return refuse(409, "instruction was already received");
  }
  if (e.seq > state.highSeq + MAX_SEQ_JUMP) return refuse(401, "instruction sequence jumps too far ahead");

  // 5. the route has a link tier.
  const routeKey = `${e.method} ${e.routePattern}`;
  const tier = resolveTier(routeKey, { body: e.body, params: e.params, store });
  if (tier === null) return refuse(403, `route is not allowed over the link: ${routeKey}`);

  // 6. Tier 2: a member's signature, or a reset code for registering a key.
  let signedBy = "platform";
  if (tier === 2) {
    const s = i.tier2Signature;
    if (s) {
      if (s.keyId === "" || s.memberId === "" || s.signature === "")
        return refuse(403, "Tier 2 needs a valid member signature");
      const key = store.getMemberKey(s.keyId);
      if (!key || key.keyId !== s.keyId || key.memberId !== s.memberId)
        return refuse(403, "Tier 2 needs a valid member signature");
      // The signature first, so a request that isn't signed learns nothing about the key's role.
      const memberBytes = bytesOf(tier2Bytes, e);
      if (memberBytes === null) return refuse(401, "instruction signature is not valid");
      if (!(await verify(key.publicKey, s.signature, memberBytes)))
        return refuse(403, "Tier 2 needs a valid member signature");
      if (!roleAllows(key.role, requiredRole(routeKey))) {
        return refuse(403, `the signing key's role ${key.role} can't sign ${routeKey}`);
      }
      signedBy = `${key.memberId}/${key.keyId}`;
    } else {
      const code = routeKey === MEMBER_KEYS_ROUTE ? resetCodeOf(e.body) : null;
      if (code === null) return refuse(403, "Tier 2 needs a valid member signature");
      // The key's fingerprint before the code is touched (no await between
      // using the code up and the comparison).
      const presented = await publicKeyFingerprintOf(e.body);
      const boundTo = store.useResetCode(resetCodeHash(code), now);
      if (boundTo === null) return refuse(403, "Tier 2 needs a valid member signature");
      // A code registers only the key the operator named. Another key uses
      // the code up: whoever holds the code gets one try, and the operator
      // makes a new one.
      if (presented !== boundTo) {
        return refuse(
          403,
          `this reset code is for the key ${boundTo}, not ${presented ?? "this key"}; it is used up now: run nbo-server keys reset --key <fingerprint> again`,
        );
      }
      signedBy = "reset-code";
    }
  }

  // Accepted: raise highSeq. Read the state again: another instruction may
  // have raised it, or an unlink dropped it, during the awaits above.
  const current = store.getLinkState();
  if (!current) return refuse(403, "this core is not linked");
  if (e.seq > current.highSeq) store.setHighSeq(e.seq);
  return { ok: true, tier, signedBy };
}
