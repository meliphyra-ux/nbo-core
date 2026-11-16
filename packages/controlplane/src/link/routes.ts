// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { importVerifyKey, keyFingerprint } from "@nbo/link-protocol";
import type { Router } from "../http/router.js";
import type { Store } from "../store/store.js";
import { ErrConflict, ErrInvalid } from "../store/errors.js";
import type { LinkClient, LinkClientStatus } from "./client.js";
import { linkSignerOf } from "./dispatch.js";
import { ErrEnrollUnreachable, enrollCore, isKeyFingerprint, isLinkId } from "./enroll.js";
import type { MemberKey } from "./link-store.js";
import { resetCodeHash } from "./verify.js";

// The link's own routes: its status, the journal, the member keys that sign
// Tier 2 instructions, and the three local actions (enroll, unlink, keys
// reset) that only this computer may take. access.ts gives each its row.

// LinkControl: what the routes ask of the link client. main.ts makes it
// before the client exists and attaches the client once started; until then
// (and in tests without a client) it reports "off" and does nothing.
export interface LinkControl {
  status(): LinkClientStatus;
  restart(): void;
  disconnect(): void;
}

export function createLinkControl(): LinkControl & {
  attach(client: Pick<LinkClient, "status" | "restart" | "disconnect">): void;
} {
  let client: Pick<LinkClient, "status" | "restart" | "disconnect"> | null = null;
  return {
    attach(c) {
      client = c;
    },
    status: () => client?.status() ?? { connection: "off", transport: null, lastConnectedAt: null, lastError: null },
    restart: () => client?.restart(),
    disconnect: () => client?.disconnect(),
  };
}

const LAST_OWNER =
  "the last Owner key can't be removed; register another Owner key first, or run nbo-server keys reset --key <your key's fingerprint> on the server";
const RESET_CODE_MS = 60 * 60_000;
const JOURNAL_DEFAULT = 100;
const JOURNAL_MAX = 500;

const json = (value: unknown, status: number): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const error = (status: number, message: string): Response => json({ error: message }, status);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await request.json();
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

// memberKeyView: a key as the API shows it. The key id is the fingerprint
// of the public key; the public key itself is not repeated.
async function memberKeyView(k: MemberKey): Promise<Record<string, string>> {
  return {
    keyId: k.keyId,
    memberId: k.memberId,
    role: k.role,
    fingerprint: await keyFingerprint(k.publicKey),
    addedAt: k.addedAt,
    addedBy: k.addedBy,
  };
}

// newResetCode: 128 random bits as lowercase base32 (26 characters) in
// groups of four, easy to read out and type.
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export function newResetCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

export function registerLinkRoutes(
  router: Router,
  store: Store,
  link: LinkControl,
  opts: { fetch?: typeof fetch } = {},
): void {
  const fetchFn: typeof fetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  router.handle("GET", "/link/status", async () => {
    const state = store.getLinkState();
    const memberKeys = state ? store.listMemberKeys().length : 0;
    const client = link.status();
    const conn = {
      connection: client.connection,
      transport: client.transport,
      lastConnectedAt: client.lastConnectedAt,
      lastError: client.lastError,
    };
    if (!state) return json({ linked: false, ...conn, memberKeys }, 200);
    return json(
      {
        linked: true,
        coreId: state.coreId,
        teamId: state.teamId,
        linkUrl: state.linkUrl,
        platformKeyId: state.platformKeyId,
        platformKeyFingerprint: await keyFingerprint(state.platformKey),
        encryptionKeyFingerprint: await keyFingerprint(state.encryptionPublic),
        ...conn,
        memberKeys,
      },
      200,
    );
  });

  router.handle("GET", "/link/journal", async (request) => {
    const q = new URL(request.url).searchParams;
    let limit = JOURNAL_DEFAULT;
    const rawLimit = q.get("limit");
    if (rawLimit !== null) {
      if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > JOURNAL_MAX) {
        return error(400, `limit must be a whole number from 1 to ${JOURNAL_MAX}`);
      }
      limit = Number(rawLimit);
    }
    const rawBefore = q.get("before");
    let before: string | undefined;
    if (rawBefore !== null) {
      const t = Date.parse(rawBefore);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(rawBefore) || Number.isNaN(t))
        return error(400, "before must be an ISO time, such as 2026-11-13T12:00:00.000Z");
      before = new Date(t).toISOString();
    }
    return json(store.listJournal({ limit, ...(before === undefined ? {} : { before }) }), 200);
  });

  router.handle("GET", "/link/member-keys", async () =>
    json(await Promise.all(store.listMemberKeys().map(memberKeyView)), 200),
  );

  router.handle("POST", "/link/member-keys", async (request) => {
    const body = await bodyOf(request);
    if (!body) return error(400, "the body must be { memberId, role, publicKey }");
    const { memberId, role, publicKey } = body;
    if (!isLinkId(memberId)) return error(400, "memberId must be 1 to 128 printable characters with no spaces");
    if (role !== "owner" && role !== "admin") return error(400, 'role must be "owner" or "admin"');
    if (typeof publicKey !== "string") return error(400, "publicKey is not a valid signing key");
    try {
      await importVerifyKey(publicKey);
    } catch {
      return error(400, "publicKey is not a valid signing key");
    }
    const addedBy = linkSignerOf(request) ?? "local";
    // A reset code stands in for an Owner who lost every key: it brings back an Owner.
    if (addedBy === "reset-code" && role !== "owner") return error(400, "a reset code registers an Owner key only");
    if (!store.getLinkState()) return error(409, "this core is not linked");
    const keyId = await keyFingerprint(publicKey);
    if (store.getMemberKey(keyId)) return error(409, "this key is already registered");
    let added: MemberKey;
    try {
      added = store.addMemberKey({ keyId, memberId, role, publicKey, addedBy });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) return error(409, "this key is already registered");
      throw err;
    }
    return json(await memberKeyView(added), 201);
  });

  router.handle("DELETE", "/link/member-keys/{keyId}", async (_request, params) => {
    const key = store.getMemberKey(params.keyId!);
    if (!key) return error(404, "no member key with this id");
    if (key.role === "owner" && store.listMemberKeys().filter((k) => k.role === "owner").length <= 1)
      return error(409, LAST_OWNER);
    store.removeMemberKey(key.keyId);
    return new Response(null, { status: 204 });
  });

  router.handle("POST", "/system/link/enroll", async (request) => {
    const body = await bodyOf(request);
    const url = body?.url;
    const code = body?.code;
    const ownerKeyFingerprint = body?.ownerKeyFingerprint;
    if (typeof url !== "string" || typeof code !== "string" || typeof ownerKeyFingerprint !== "string") {
      return error(400, "url, code and ownerKeyFingerprint are required");
    }
    try {
      const state = await enrollCore({ store, fetch: fetchFn }, { url, code, ownerKeyFingerprint });
      link.restart();
      return json(
        {
          linked: true,
          coreId: state.coreId,
          teamId: state.teamId,
          linkUrl: state.linkUrl,
          platformKeyId: state.platformKeyId,
          encryptionKeyFingerprint: await keyFingerprint(state.encryptionPublic),
        },
        201,
      );
    } catch (err) {
      // enrollCore's messages never hold the code; anything else is not shown.
      if (err instanceof ErrConflict) return error(409, err.message);
      if (err instanceof ErrInvalid) return error(400, err.message);
      if (err instanceof ErrEnrollUnreachable) return error(502, err.message);
      return error(500, "linking failed");
    }
  });

  router.handle("POST", "/system/link/unlink", async () => {
    store.clearLink();
    link.disconnect();
    return new Response(null, { status: 204 });
  });

  // keys-reset: a one-time code that registers one Owner key, the one whose
  // fingerprint the operator names here, so a code read out to the wrong
  // person can't bring in their key.
  router.handle("POST", "/system/link/keys-reset", async (request) => {
    const keyFingerprint = (await bodyOf(request))?.keyFingerprint;
    if (!isKeyFingerprint(keyFingerprint))
      return error(400, "keyFingerprint is required: the sha256:... fingerprint of the key the code may register");
    if (!store.getLinkState()) return error(409, "this core is not linked");
    const code = newResetCode();
    const expiresAt = new Date(Date.now() + RESET_CODE_MS).toISOString();
    store.createResetCode(resetCodeHash(code), keyFingerprint, expiresAt);
    return json({ code, expiresAt, keyFingerprint }, 200);
  });
}
