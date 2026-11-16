// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { canonicalJson } from "./canonical.js";
import type { Envelope } from "./messages.js";

const enc = new TextEncoder();

function prefixed(prefix: string, value: unknown): Uint8Array {
  return enc.encode(prefix + canonicalJson(value));
}

/** What the platform signs for an instruction. */
export function instructionBytes(e: Envelope): Uint8Array {
  return prefixed("nbo-link/instruction/v1\n", e);
}

/** What a member signs for a Tier 2 instruction: the same envelope, another prefix. */
export function tier2Bytes(e: Envelope): Uint8Array {
  return prefixed("nbo-link/tier2/v1\n", e);
}

export function authBytes(a: { coreId: string; challenge: string; linkHost: string }): Uint8Array {
  return prefixed("nbo-link/auth/v1\n", { coreId: a.coreId, challenge: a.challenge, linkHost: a.linkHost });
}

export function rotateBytes(a: { coreId: string; newKeyId: string; newPublicKey: string }): Uint8Array {
  return prefixed("nbo-link/rotate/v1\n", { coreId: a.coreId, newKeyId: a.newKeyId, newPublicKey: a.newPublicKey });
}

export function enrollBytes(a: { code: string; identityKey: string; encryptionKey: string }): Uint8Array {
  return prefixed("nbo-link/enroll/v1\n", { code: a.code, identityKey: a.identityKey, encryptionKey: a.encryptionKey });
}
