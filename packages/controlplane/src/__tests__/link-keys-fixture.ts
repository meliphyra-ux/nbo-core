// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { randomUUID } from "node:crypto";
import {
  exportPublicKey,
  generateSigningKeyPair,
  instructionBytes,
  keyFingerprint,
  sign,
  tier2Bytes,
  type Envelope,
  type SignedInstruction,
} from "@nbo/link-protocol";
import { createLinkKeys } from "../link/keys.js";
import type { Store } from "../store/store.js";

// Test keys for the link: a platform instruction key, member signing keys
// for an owner, an admin and a developer, and a stranger key that is never
// registered. Other link tests reuse these helpers.

export interface TestKey {
  keyId: string;
  publicKey: string;
  privateKey: CryptoKey;
}

export interface TestMemberKey extends TestKey {
  memberId: string;
  role: string;
}

export interface LinkTestKeys {
  platform: TestKey;
  owner: TestMemberKey;
  admin: TestMemberKey;
  developer: TestMemberKey;
  stranger: TestMemberKey;
}

export const CORE_ID = "core_test";
export const TEAM_ID = "team_test";

async function makeKey(): Promise<TestKey> {
  const pair = await generateSigningKeyPair(false);
  const publicKey = await exportPublicKey(pair.publicKey);
  return { keyId: await keyFingerprint(publicKey), publicKey, privateKey: pair.privateKey };
}

async function makeMember(memberId: string, role: string): Promise<TestMemberKey> {
  return { ...(await makeKey()), memberId, role };
}

export async function makeLinkTestKeys(): Promise<LinkTestKeys> {
  return {
    platform: await makeKey(),
    owner: await makeMember("mem_owner", "owner"),
    admin: await makeMember("mem_admin", "admin"),
    developer: await makeMember("mem_dev", "developer"),
    stranger: await makeMember("mem_stranger", "owner"),
  };
}

// pinLink saves link state pinned to keys.platform and registers the owner,
// admin and developer member keys (the developer row is seeded directly; the
// member-keys route would refuse that role). The store needs a secret key.
// linkUrl and linkHost point the link at a fake platform.
export async function pinLink(
  store: Store,
  keys: LinkTestKeys,
  opts: { highSeq?: number; linkUrl?: string; linkHost?: string; coreId?: string } = {},
): Promise<void> {
  const own = await createLinkKeys();
  store.saveLinkState({
    coreId: opts.coreId ?? CORE_ID,
    teamId: TEAM_ID,
    linkUrl: opts.linkUrl ?? "https://platform.example.test/link",
    linkHost: opts.linkHost ?? "platform.example.test",
    platformKeyId: keys.platform.keyId,
    platformKey: keys.platform.publicKey,
    identityPublic: own.identityPublic,
    identityPkcs8: own.identityPkcs8,
    encryptionPublic: own.encryptionPublic,
    encryptionPkcs8: own.encryptionPkcs8,
    highSeq: opts.highSeq ?? 0,
    enrolledAt: "2026-11-13T00:00:00.000Z",
  });
  for (const m of [keys.owner, keys.admin, keys.developer]) {
    store.addMemberKey({ keyId: m.keyId, memberId: m.memberId, role: m.role, publicKey: m.publicKey, addedBy: "test" });
  }
}

let nextSeq = 1;

// makeEnvelope: a valid Tier 0 envelope for the pinned core, expiring 60 s
// after now, with a fresh seq and nonce unless overridden.
export function makeEnvelope(keys: LinkTestKeys, now: Date, over: Partial<Envelope> = {}): Envelope {
  return {
    linkVersion: 1,
    id: `ins_${randomUUID()}`,
    coreId: CORE_ID,
    teamId: TEAM_ID,
    seq: nextSeq++,
    nonce: randomUUID(),
    expiresAt: now.getTime() + 60_000,
    method: "GET",
    routePattern: "/projects",
    params: {},
    query: {},
    body: null,
    platformKeyId: keys.platform.keyId,
    ...over,
  };
}

// signInstruction: the platform's signature over the envelope, plus a member's
// Tier 2 signature when member is given.
export async function signInstruction(
  keys: LinkTestKeys,
  envelope: Envelope,
  opts: { member?: TestMemberKey; platformKey?: TestKey } = {},
): Promise<SignedInstruction> {
  const platformKey = opts.platformKey ?? keys.platform;
  const out: SignedInstruction = {
    envelope,
    platformSignature: await sign(platformKey.privateKey, instructionBytes(envelope)),
  };
  if (opts.member) {
    out.tier2Signature = {
      keyId: opts.member.keyId,
      memberId: opts.member.memberId,
      signature: await sign(opts.member.privateKey, tier2Bytes(envelope)),
    };
  }
  return out;
}

// noSecrets: empty in-memory secret sources for a dispatcher in tests.
export const noSecrets = { supplied: { values: (): string[] => [] }, github: { cachedTokens: (): string[] => [] } };
