// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { b64u } from "./encoding.js";
import { canonicalJson } from "./canonical.js";
import { buf, importEncryptionPublicKey } from "./crypto.js";
import { LinkProtocolError } from "./messages.js";

export interface SealedBox {
  $sealed: { v: 2; epk: string; iv: string; ct: string };
}

/**
 * Where a sealed value is used: the core's link id, the route key exactly as in `LINK_SEALED_FIELDS`
 * (`"PUT /projects/{projectID}/env/{name}"`), the concrete request path the instruction targets
 * (`requestPath(routePattern, params)`, e.g. `"/projects/p_1/env/FOO"`) and the dotted field path
 * (`"value"`). It is the box's AES-GCM additional data and never travels inside the box: the opener
 * derives it from the instruction it handles and where it finds the box, so a box moved to another
 * field, route, project, name or core does not open.
 */
export interface SealBinding {
  coreId: string;
  route: string;
  path: string;
  field: string;
}

/**
 * The request path an instruction targets: the route pattern with each `{param}` replaced by its
 * value percent-encoded (`encodeURIComponent`) so it fills exactly one segment; no query string.
 * Core's dispatcher builds the URL it routes with this same path. Throws on a missing or extra
 * param or a malformed pattern.
 */
export function requestPath(pattern: string, params: Readonly<Record<string, string>>): string {
  const names = new Set<string>();
  const segments = pattern.split("/").map((seg) => {
    const m = /^\{([^{}]+)\}$/.exec(seg);
    if (!m) {
      if (seg.includes("{") || seg.includes("}")) throw new LinkProtocolError("route pattern is malformed");
      return seg;
    }
    const name = m[1]!;
    if (!Object.prototype.hasOwnProperty.call(params, name)) throw new LinkProtocolError(`param ${name} is missing`);
    names.add(name);
    return encodeURIComponent(params[name]!);
  });
  for (const k of Object.keys(params)) {
    if (!names.has(k)) throw new LinkProtocolError(`param ${k} is not in the route`);
  }
  return segments.join("/");
}

const PREFIX = "nbo-link/seal/v2\n";
const enc = new TextEncoder();
const INFO = enc.encode("nbo-link/seal/v2");

function additionalData(b: SealBinding | undefined): Uint8Array {
  if (
    typeof b !== "object" ||
    b === null ||
    typeof b.coreId !== "string" ||
    typeof b.route !== "string" ||
    typeof b.path !== "string" ||
    typeof b.field !== "string" ||
    b.coreId === "" ||
    b.route === "" ||
    b.path === "" ||
    b.field === ""
  ) {
    throw new LinkProtocolError("a sealed value needs its binding: coreId, route, path and field");
  }
  return enc.encode(PREFIX + canonicalJson({ coreId: b.coreId, route: b.route, path: b.path, field: b.field }));
}

/**
 * For an object with a `$sealed` key that is not a v2 sealed box: `"the old sealed format (v1)"` for a
 * v1 box (whose additional data named no place), else `"an unknown sealed format"`. Null for a v2 box
 * and for anything without `$sealed`.
 */
export function sealedFormatProblem(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  if (!Object.prototype.hasOwnProperty.call(v, "$sealed") || isSealedBox(v)) return null;
  const s = (v as { $sealed: unknown }).$sealed;
  if (typeof s === "object" && s !== null && (s as { v?: unknown }).v === 1) return "the old sealed format (v1)";
  return "an unknown sealed format";
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function aesKey(shared: ArrayBuffer, epk: Uint8Array, recipientPub: Uint8Array): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(concat(epk, recipientPub)), info: buf(INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function isSealedBox(v: unknown): v is SealedBox {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "$sealed") return false;
  const s = (v as { $sealed: unknown }).$sealed;
  if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
  const o = s as Record<string, unknown>;
  const inner = Object.keys(o).sort().join(",");
  return (
    inner === "ct,epk,iv,v" &&
    o.v === 2 &&
    typeof o.epk === "string" &&
    typeof o.iv === "string" &&
    typeof o.ct === "string"
  );
}

/** Seal a string so only the holder of the recipient's X25519 private key can read it, where `at` says. */
export async function sealTo(recipientPublicRaw: string, plaintext: string, at: SealBinding): Promise<SealedBox> {
  const aad = additionalData(at);
  const subtle = globalThis.crypto.subtle;
  let recipientBytes: Uint8Array;
  let recipient: CryptoKey;
  try {
    recipientBytes = b64u.decode(recipientPublicRaw);
    recipient = await importEncryptionPublicKey(recipientPublicRaw);
  } catch {
    throw new LinkProtocolError("recipient key is not valid");
  }
  // Public keys export even from a non-extractable pair; the private half never leaves.
  const eph = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  let shared: ArrayBuffer;
  try {
    shared = await subtle.deriveBits({ name: "X25519", public: recipient }, eph.privateKey, 256);
  } catch {
    throw new LinkProtocolError("recipient key is not valid");
  }
  const key = await aesKey(shared, epk, recipientBytes);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(aad) }, key, buf(enc.encode(plaintext))),
  );
  return { $sealed: { v: 2, epk: b64u.encode(epk), iv: b64u.encode(iv), ct: b64u.encode(ct) } };
}

export async function openSealed(
  recipientPrivate: CryptoKey,
  recipientPublicRaw: string,
  box: SealedBox,
  at: SealBinding,
): Promise<string> {
  const aad = additionalData(at);
  if (sealedFormatProblem(box) === "the old sealed format (v1)")
    throw new LinkProtocolError("old sealed format (v1): seal the value again");
  try {
    if (!isSealedBox(box)) throw new Error("shape");
    const subtle = globalThis.crypto.subtle;
    const epk = b64u.decode(box.$sealed.epk);
    const iv = b64u.decode(box.$sealed.iv);
    const ephPub = await subtle.importKey("raw", buf(epk), { name: "X25519" }, true, []);
    const shared = await subtle.deriveBits({ name: "X25519", public: ephPub }, recipientPrivate, 256);
    const key = await aesKey(shared, epk, b64u.decode(recipientPublicRaw));
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: buf(aad) },
      key,
      buf(b64u.decode(box.$sealed.ct)),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(pt);
  } catch {
    throw new LinkProtocolError("sealed value does not open");
  }
}
