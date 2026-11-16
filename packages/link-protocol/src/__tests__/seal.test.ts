// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import {
  generateEncryptionKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importEncryptionPrivateKey,
  sealTo,
  openSealed,
  isSealedBox,
  requestPath,
  sealedFormatProblem,
  b64u,
  LinkProtocolError,
} from "../index.js";

const at = {
  coreId: "core-1",
  route: "PUT /projects/{projectID}/env/{name}",
  path: "/projects/p_1/env/FOO",
  field: "value",
};

describe("sealed box", () => {
  it("a sealed value opens with the recipient key", async () => {
    const r = await generateEncryptionKeyPair(false);
    const pub = await exportPublicKey(r.publicKey);
    const box = await sealTo(pub, "s3cret value é", at);
    expect(isSealedBox(box)).toBe(true);
    expect(box.$sealed.v).toBe(2);
    expect(await openSealed(r.privateKey, pub, box, at)).toBe("s3cret value é");
  });

  it("opens with a key restored from pkcs8", async () => {
    const r = await generateEncryptionKeyPair(true);
    const pub = await exportPublicKey(r.publicKey);
    const box = await sealTo(pub, "x", at);
    const priv = await importEncryptionPrivateKey(await exportPrivateKey(r.privateKey));
    expect(await openSealed(priv, pub, box, at)).toBe("x");
  });

  it("it does not open with another key", async () => {
    const r = await generateEncryptionKeyPair(false);
    const other = await generateEncryptionKeyPair(false);
    const box = await sealTo(await exportPublicKey(r.publicKey), "x", at);
    await expect(openSealed(other.privateKey, await exportPublicKey(other.publicKey), box, at)).rejects.toThrow(
      LinkProtocolError,
    );
    await expect(openSealed(other.privateKey, await exportPublicKey(other.publicKey), box, at)).rejects.toThrow(
      "sealed value does not open",
    );
  });

  it("a flipped ciphertext byte does not open", async () => {
    const r = await generateEncryptionKeyPair(false);
    const pub = await exportPublicKey(r.publicKey);
    const box = await sealTo(pub, "hello", at);
    const ct = b64u.decode(box.$sealed.ct);
    ct[0] ^= 1;
    const bad = { $sealed: { ...box.$sealed, ct: b64u.encode(ct) } };
    await expect(openSealed(r.privateKey, pub, bad, at)).rejects.toThrow("sealed value does not open");
  });

  it("a malformed box does not open", async () => {
    const r = await generateEncryptionKeyPair(false);
    const pub = await exportPublicKey(r.publicKey);
    const box = await sealTo(pub, "hello", at);
    await expect(openSealed(r.privateKey, pub, { $sealed: { ...box.$sealed, epk: "!!" } }, at)).rejects.toThrow(
      "sealed value does not open",
    );
  });

  it("two seals of the same text differ", async () => {
    const r = await generateEncryptionKeyPair(false);
    const pub = await exportPublicKey(r.publicKey);
    const a = await sealTo(pub, "same", at);
    const b = await sealTo(pub, "same", at);
    expect(a.$sealed.ct).not.toBe(b.$sealed.ct);
    expect(a.$sealed.epk).not.toBe(b.$sealed.epk);
  });

  it("isSealedBox is strict", () => {
    expect(isSealedBox(null)).toBe(false);
    expect(isSealedBox({ $sealed: { v: 2, epk: "a", iv: "b", ct: "c" } })).toBe(true);
    expect(isSealedBox({ $sealed: { v: 1, epk: "a", iv: "b", ct: "c" } })).toBe(false);
    expect(isSealedBox({ $sealed: { v: 2, epk: "a", iv: "b" } })).toBe(false);
    expect(isSealedBox({ $sealed: { v: 2, epk: "a", iv: "b", ct: "c" }, x: 1 })).toBe(false);
  });

  it("sealTo refuses a bad recipient key with a protocol error", async () => {
    await expect(sealTo("!!", "x", at)).rejects.toThrow(LinkProtocolError);
    await expect(sealTo(b64u.encode(new Uint8Array(5)), "x", at)).rejects.toThrow("recipient key is not valid");
  });

  it("opens only where it was sealed: another field, route or core fails", async () => {
    const r = await generateEncryptionKeyPair(false);
    const pub = await exportPublicKey(r.publicKey);
    const box = await sealTo(pub, "s3cret", at);
    for (const moved of [
      { ...at, field: "values" },
      { ...at, route: "POST /projects/{projectID}/builds" },
      { ...at, coreId: "core-2" },
      { ...at, path: "/projects/p_2/env/FOO" },
      { ...at, path: "/projects/p_1/env/BAR" },
    ]) {
      await expect(openSealed(r.privateKey, pub, box, moved)).rejects.toThrow("sealed value does not open");
    }
    expect(await openSealed(r.privateKey, pub, box, { ...at })).toBe("s3cret");
  });

  it("the binding is part of the additional data, not of the box", async () => {
    const r = await generateEncryptionKeyPair(false);
    const box = await sealTo(await exportPublicKey(r.publicKey), "s3cret", at);
    expect(Object.keys(box.$sealed).sort()).toEqual(["ct", "epk", "iv", "v"]);
    expect(JSON.stringify(box)).not.toContain("core-1");
  });

  it("sealing or opening needs the whole binding", async () => {
    const r = await generateEncryptionKeyPair(false);
    const pub = await exportPublicKey(r.publicKey);
    for (const bad of [
      { ...at, coreId: "" },
      { ...at, route: "" },
      { ...at, field: "" },
      { ...at, path: "" },
      undefined,
    ]) {
      await expect(sealTo(pub, "x", bad as never)).rejects.toThrow("a sealed value needs its binding");
    }
    const box = await sealTo(pub, "x", at);
    await expect(openSealed(r.privateKey, pub, box, { ...at, coreId: "" })).rejects.toThrow(
      "a sealed value needs its binding",
    );
  });

  it("requestPath fills a pattern the way core's dispatcher does: each param percent-encoded, no query", () => {
    expect(requestPath("/projects/{projectID}/env/{name}", { projectID: "p_1", name: "A B/C" })).toBe(
      "/projects/p_1/env/A%20B%2FC",
    );
    expect(requestPath("/projects", {})).toBe("/projects");
    expect(() => requestPath("/projects/{projectID}", {})).toThrow("param projectID is missing");
    expect(() => requestPath("/projects", { x: "1" })).toThrow("param x is not in the route");
    expect(() => requestPath("/projects/a{b}", {})).toThrow("route pattern is malformed");
  });

  it("sealedFormatProblem names an old or unknown box and passes a v2 box or plain data", async () => {
    const r = await generateEncryptionKeyPair(false);
    const box = await sealTo(await exportPublicKey(r.publicKey), "x", at);
    expect(sealedFormatProblem(box)).toBeNull();
    expect(sealedFormatProblem({ $sealed: { ...box.$sealed, v: 1 } })).toBe("the old sealed format (v1)");
    expect(sealedFormatProblem({ $sealed: { v: 3 } })).toBe("an unknown sealed format");
    expect(sealedFormatProblem({ $sealed: "x" })).toBe("an unknown sealed format");
    expect(sealedFormatProblem({ A: "1" })).toBeNull();
    expect(sealedFormatProblem("text")).toBeNull();
  });

  it("a version 1 box is refused as the old sealed format", async () => {
    const r = await generateEncryptionKeyPair(false);
    const pub = await exportPublicKey(r.publicKey);
    const box = await sealTo(pub, "x", at);
    const old = { $sealed: { ...box.$sealed, v: 1 } } as never;
    await expect(openSealed(r.privateKey, pub, old, at)).rejects.toThrow("old sealed format");
  });
});
