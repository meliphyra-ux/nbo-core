// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import {
  generateSigningKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importSigningPrivateKey,
  importVerifyKey,
  sign,
  verify,
  keyFingerprint,
  b64u,
  LinkProtocolError,
} from "../index.js";

const bytes = new TextEncoder().encode("hello link");

describe("signatures", () => {
  it("a signature verifies with its public key and not with another", async () => {
    const a = await generateSigningKeyPair(false);
    const b = await generateSigningKeyPair(false);
    const sig = await sign(a.privateKey, bytes);
    expect(b64u.decode(sig).length).toBe(64);
    expect(await verify(await exportPublicKey(a.publicKey), sig, bytes)).toBe(true);
    expect(await verify(await exportPublicKey(b.publicKey), sig, bytes)).toBe(false);
    expect(await verify(await exportPublicKey(a.publicKey), sig, new TextEncoder().encode("other"))).toBe(false);
  });

  it("verify is false for a 63-byte signature and a malformed key", async () => {
    const a = await generateSigningKeyPair(false);
    const pub = await exportPublicKey(a.publicKey);
    expect(b64u.decode(pub).length).toBe(32);
    const sig = b64u.decode(await sign(a.privateKey, bytes));
    expect(await verify(pub, b64u.encode(sig.slice(0, 63)), bytes)).toBe(false);
    expect(await verify("not a key!", b64u.encode(sig), bytes)).toBe(false);
    expect(await verify(b64u.encode(new Uint8Array(5)), b64u.encode(sig), bytes)).toBe(false);
    expect(await verify(pub, "***", bytes)).toBe(false);
  });

  it("a private key round-trips through pkcs8 and an imported public key verifies", async () => {
    const a = await generateSigningKeyPair(true);
    const priv = await importSigningPrivateKey(await exportPrivateKey(a.privateKey));
    const sig = await sign(priv, bytes);
    const pub = await importVerifyKey(await exportPublicKey(a.publicKey));
    expect(await crypto.subtle.verify("Ed25519", pub, b64u.decode(sig) as BufferSource, bytes as BufferSource)).toBe(
      true,
    );
  });

  it("a fingerprint is sha256: plus 43 base64url characters and stable", async () => {
    const a = await generateSigningKeyPair(false);
    const pub = await exportPublicKey(a.publicKey);
    const f = await keyFingerprint(pub);
    expect(f).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(await keyFingerprint(pub)).toBe(f);
  });

  const small = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  ];
  const toB64u = (hex: string, flipSign = false) => {
    const b = Uint8Array.from(Buffer.from(hex, "hex"));
    if (flipSign) b[31] ^= 0x80;
    return b64u.encode(b);
  };

  it("verify is false for the identity key with an R=identity S=0 signature", async () => {
    const identity = toB64u(small[1]);
    const sig = new Uint8Array(64);
    sig[0] = 1;
    expect(await verify(identity, b64u.encode(sig), bytes)).toBe(false);
    expect(await verify(identity, b64u.encode(sig), new TextEncoder().encode("anything"))).toBe(false);
  });

  it("importVerifyKey refuses a small-order key", async () => {
    for (const hex of small) {
      for (const flip of [false, true]) {
        await expect(importVerifyKey(toB64u(hex, flip)), hex).rejects.toThrow(LinkProtocolError);
      }
    }
  });
});
