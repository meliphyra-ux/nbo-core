// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export const LINK_VERSION = 1 as const;
export const MAX_EXPIRY_MS = 60_000;
export const CLOCK_SKEW_MS = 5_000;
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

export type Tier = 0 | 1 | 2;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class LinkProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkProtocolError";
  }
}

export interface Envelope {
  linkVersion: 1;
  id: string;
  coreId: string;
  teamId: string;
  seq: number;
  nonce: string;
  expiresAt: number;
  method: Method;
  routePattern: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown | null;
  platformKeyId: string;
}

export interface SignedInstruction {
  envelope: Envelope;
  platformSignature: string;
  tier2Signature?: { keyId: string; memberId: string; signature: string };
}

export type LinkMessage =
  | { type: "challenge-answer"; linkVersion: 1; coreId: string; challenge: string; signature: string }
  | { type: "response"; linkVersion: 1; id: string; status: number; headers: Record<string, string>; body: string }
  | { type: "stream-start"; linkVersion: 1; id: string; status: number; headers: Record<string, string> }
  | { type: "stream-chunk"; linkVersion: 1; id: string; index: number; data: string }
  | { type: "stream-end"; linkVersion: 1; id: string; error?: string }
  | { type: "rotation-ack"; linkVersion: 1; keyId: string }
  | { type: "challenge"; linkVersion: 1; challenge: string; linkHost: string }
  | { type: "welcome"; linkVersion: 1; coreId: string; platformKeyId: string }
  | { type: "instruction"; linkVersion: 1; instruction: SignedInstruction }
  | { type: "rotate-key"; linkVersion: 1; newKeyId: string; newPublicKey: string; signature: string }
  | { type: "revoked"; linkVersion: 1 }
  // cancel: the platform no longer reads the answer to instruction id, so
  // core stops sending its stream. Unsigned: it can only stop relaying an
  // answer, never start or undo work.
  | { type: "cancel"; linkVersion: 1; id: string };

export interface EnrollRequest {
  linkVersion: 1;
  code: string;
  identityKey: string;
  encryptionKey: string;
  proof: string;
}

export interface EnrollResponse {
  coreId: string;
  teamId: string;
  platformKey: { keyId: string; publicKey: string };
  linkHost: string;
  ownerKey: { memberId: string; publicKey: string };
}

// ---- a small strict reader ----

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, what: string): never {
  throw new LinkProtocolError(`${path}: ${what}`);
}

function str(o: Obj, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== "string") fail(`${path}${k}`, "must be a string");
  return v;
}

function int(o: Obj, k: string, path: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) fail(`${path}${k}`, "must be an integer");
  return v;
}

function record(o: Obj, k: string, path: string): Record<string, string> {
  const v = o[k];
  if (!isObj(v)) fail(`${path}${k}`, "must be an object of strings");
  for (const [key, val] of Object.entries(v)) {
    if (typeof val !== "string") fail(`${path}${k}.${key}`, "must be a string");
  }
  return v as Record<string, string>;
}

function sub(o: Obj, k: string, path: string): Obj {
  const v = o[k];
  if (!isObj(v)) fail(`${path}${k}`, "must be an object");
  return v;
}

function only(o: Obj, allowed: string[], path: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) fail(`${path}${k}`, "unknown field");
  }
}

function tooDeep(v: unknown, depth: number): boolean {
  if (typeof v !== "object" || v === null) return false;
  if (depth >= 64) return true;
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (tooDeep(x, depth + 1)) return true;
  return false;
}

function envelope(o: Obj, path: string): Envelope {
  only(
    o,
    [
      "linkVersion",
      "id",
      "coreId",
      "teamId",
      "seq",
      "nonce",
      "expiresAt",
      "method",
      "routePattern",
      "params",
      "query",
      "body",
      "platformKeyId",
    ],
    path,
  );
  if (o.linkVersion !== LINK_VERSION) fail(`${path}linkVersion`, "must be 1");
  const method = str(o, "method", path);
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) fail(`${path}method`, "not a supported method");
  if (!("body" in o)) fail(`${path}body`, "is required (null for none)");
  if (tooDeep(o.body, 0)) fail(`${path}body`, "is nested deeper than 64 levels");
  return {
    linkVersion: 1,
    id: str(o, "id", path),
    coreId: str(o, "coreId", path),
    teamId: str(o, "teamId", path),
    seq: int(o, "seq", path),
    nonce: str(o, "nonce", path),
    expiresAt: int(o, "expiresAt", path),
    method: method as Method,
    routePattern: str(o, "routePattern", path),
    params: record(o, "params", path),
    query: record(o, "query", path),
    body: o.body,
    platformKeyId: str(o, "platformKeyId", path),
  };
}

function signedInstruction(o: Obj, path: string): SignedInstruction {
  only(o, ["envelope", "platformSignature", "tier2Signature"], path);
  const out: SignedInstruction = {
    envelope: envelope(sub(o, "envelope", path), `${path}envelope.`),
    platformSignature: str(o, "platformSignature", path),
  };
  if (o.tier2Signature !== undefined) {
    const t = sub(o, "tier2Signature", path);
    const p = `${path}tier2Signature.`;
    only(t, ["keyId", "memberId", "signature"], p);
    out.tier2Signature = {
      keyId: str(t, "keyId", p),
      memberId: str(t, "memberId", p),
      signature: str(t, "signature", p),
    };
  }
  return out;
}

function readJson(json: string, what: string): Obj {
  if (json.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(json).length > MAX_MESSAGE_BYTES) {
    throw new LinkProtocolError(`${what} is over ${MAX_MESSAGE_BYTES} bytes`);
  }
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new LinkProtocolError(`${what} is not JSON`);
  }
  if (!isObj(v)) throw new LinkProtocolError(`${what} must be a JSON object`);
  return v;
}

export function parseMessage(json: string): LinkMessage {
  const o = readJson(json, "message");
  if (o.linkVersion !== LINK_VERSION) fail("linkVersion", "must be 1");
  const type = o.type;
  const base = ["type", "linkVersion"];
  const p = "";
  switch (type) {
    case "challenge-answer":
      only(o, [...base, "coreId", "challenge", "signature"], p);
      return {
        type,
        linkVersion: 1,
        coreId: str(o, "coreId", p),
        challenge: str(o, "challenge", p),
        signature: str(o, "signature", p),
      };
    case "response":
      only(o, [...base, "id", "status", "headers", "body"], p);
      return {
        type,
        linkVersion: 1,
        id: str(o, "id", p),
        status: int(o, "status", p),
        headers: record(o, "headers", p),
        body: str(o, "body", p),
      };
    case "stream-start":
      only(o, [...base, "id", "status", "headers"], p);
      return {
        type,
        linkVersion: 1,
        id: str(o, "id", p),
        status: int(o, "status", p),
        headers: record(o, "headers", p),
      };
    case "stream-chunk":
      only(o, [...base, "id", "index", "data"], p);
      return { type, linkVersion: 1, id: str(o, "id", p), index: int(o, "index", p), data: str(o, "data", p) };
    case "stream-end": {
      only(o, [...base, "id", "error"], p);
      const m: LinkMessage = { type, linkVersion: 1, id: str(o, "id", p) };
      if (o.error !== undefined) m.error = str(o, "error", p);
      return m;
    }
    case "rotation-ack":
      only(o, [...base, "keyId"], p);
      return { type, linkVersion: 1, keyId: str(o, "keyId", p) };
    case "challenge":
      only(o, [...base, "challenge", "linkHost"], p);
      return { type, linkVersion: 1, challenge: str(o, "challenge", p), linkHost: str(o, "linkHost", p) };
    case "welcome":
      only(o, [...base, "coreId", "platformKeyId"], p);
      return { type, linkVersion: 1, coreId: str(o, "coreId", p), platformKeyId: str(o, "platformKeyId", p) };
    case "instruction":
      only(o, [...base, "instruction"], p);
      return { type, linkVersion: 1, instruction: signedInstruction(sub(o, "instruction", p), "instruction.") };
    case "rotate-key":
      only(o, [...base, "newKeyId", "newPublicKey", "signature"], p);
      return {
        type,
        linkVersion: 1,
        newKeyId: str(o, "newKeyId", p),
        newPublicKey: str(o, "newPublicKey", p),
        signature: str(o, "signature", p),
      };
    case "revoked":
      only(o, base, p);
      return { type, linkVersion: 1 };
    case "cancel":
      only(o, [...base, "id"], p);
      return { type, linkVersion: 1, id: str(o, "id", p) };
    default:
      return fail("type", "unknown message type");
  }
}

export function parseEnrollRequest(json: string): EnrollRequest {
  const o = readJson(json, "enroll request");
  only(o, ["linkVersion", "code", "identityKey", "encryptionKey", "proof"], "");
  if (o.linkVersion !== LINK_VERSION) fail("linkVersion", "must be 1");
  return {
    linkVersion: 1,
    code: str(o, "code", ""),
    identityKey: str(o, "identityKey", ""),
    encryptionKey: str(o, "encryptionKey", ""),
    proof: str(o, "proof", ""),
  };
}

export function parseEnrollResponse(json: string): EnrollResponse {
  const o = readJson(json, "enroll response");
  only(o, ["coreId", "teamId", "platformKey", "linkHost", "ownerKey"], "");
  const pk = sub(o, "platformKey", "");
  only(pk, ["keyId", "publicKey"], "platformKey.");
  const ok = sub(o, "ownerKey", "");
  only(ok, ["memberId", "publicKey"], "ownerKey.");
  return {
    coreId: str(o, "coreId", ""),
    teamId: str(o, "teamId", ""),
    platformKey: { keyId: str(pk, "keyId", "platformKey."), publicKey: str(pk, "publicKey", "platformKey.") },
    linkHost: str(o, "linkHost", ""),
    ownerKey: { memberId: str(ok, "memberId", "ownerKey."), publicKey: str(ok, "publicKey", "ownerKey.") },
  };
}
