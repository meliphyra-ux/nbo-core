// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { b64u } from "./encoding.js";
import { LinkProtocolError } from "./messages.js";

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

// WebCrypto wants a BufferSource; Uint8Array<ArrayBufferLike> needs a cast for the strict typings.
export const buf = (u: Uint8Array): BufferSource => u as BufferSource;

export function generateSigningKeyPair(extractable: boolean): Promise<CryptoKeyPair> {
  return subtle().generateKey({ name: "Ed25519" }, extractable, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

export function generateEncryptionKeyPair(extractable: boolean): Promise<CryptoKeyPair> {
  return subtle().generateKey({ name: "X25519" }, extractable, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

/** Raw public key, base64url (32 bytes). Public keys are always exportable. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return b64u.encode(new Uint8Array(await subtle().exportKey("raw", key)));
}

// Ed25519 points of small order (libsodium's blacklist, little-endian y with the sign bit cleared).
// A key like these makes some signatures verify for every message, so none is accepted.
const SMALL_ORDER: string[] = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];
const SMALL_ORDER_B64U = new Set(
  SMALL_ORDER.map((hex) => b64u.encode(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))))),
);

function isSmallOrder(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  const c = raw.slice();
  c[31] = (c[31] ?? 0) & 0x7f;
  return SMALL_ORDER_B64U.has(b64u.encode(c));
}

export async function importVerifyKey(raw: string): Promise<CryptoKey> {
  const bytes = b64u.decode(raw);
  if (isSmallOrder(bytes)) throw new LinkProtocolError("public key is not valid");
  return subtle().importKey("raw", buf(bytes), { name: "Ed25519" }, true, ["verify"]);
}

export function importEncryptionPublicKey(raw: string): Promise<CryptoKey> {
  return subtle().importKey("raw", buf(b64u.decode(raw)), { name: "X25519" }, true, []);
}

/** pkcs8, base64url. The key must have been made extractable. */
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  return b64u.encode(new Uint8Array(await subtle().exportKey("pkcs8", key)));
}

export function importSigningPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", buf(b64u.decode(pkcs8)), { name: "Ed25519" }, false, ["sign"]);
}

export function importEncryptionPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", buf(b64u.decode(pkcs8)), { name: "X25519" }, false, ["deriveBits"]);
}

export async function sign(privateKey: CryptoKey, bytes: Uint8Array): Promise<string> {
  return b64u.encode(new Uint8Array(await subtle().sign({ name: "Ed25519" }, privateKey, buf(bytes))));
}

/** False, never a throw, on a malformed key or signature. */
export async function verify(publicKeyRaw: string, signature: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const sig = b64u.decode(signature);
    if (sig.length !== 64) return false;
    const key = await importVerifyKey(publicKeyRaw);
    return await subtle().verify({ name: "Ed25519" }, key, buf(sig), buf(bytes));
  } catch {
    return false;
  }
}

/** "sha256:" + base64url of SHA-256 over the 32 raw public key bytes. */
export async function keyFingerprint(publicKeyRaw: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", buf(b64u.decode(publicKeyRaw)));
  return "sha256:" + b64u.encode(new Uint8Array(digest));
}
