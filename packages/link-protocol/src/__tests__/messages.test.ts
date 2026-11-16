// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import {
  parseMessage,
  parseEnrollRequest,
  parseEnrollResponse,
  LinkProtocolError,
  MAX_MESSAGE_BYTES,
  canonicalJson,
  instructionBytes,
  tier2Bytes,
  authBytes,
  rotateBytes,
  enrollBytes,
  type Envelope,
} from "../index.js";

const envelope: Envelope = {
  linkVersion: 1,
  id: "i1",
  coreId: "c1",
  teamId: "t1",
  seq: 1,
  nonce: "n1",
  expiresAt: 1000,
  method: "POST",
  routePattern: "/projects/{projectID}/builds",
  params: { projectID: "p" },
  query: {},
  body: { b: 1, a: [1, 2] },
  platformKeyId: "k1",
};
const messages: Record<string, unknown>[] = [
  { type: "challenge-answer", linkVersion: 1, coreId: "c", challenge: "x", signature: "s" },
  { type: "response", linkVersion: 1, id: "i", status: 200, headers: { a: "b" }, body: "AAAA" },
  { type: "stream-start", linkVersion: 1, id: "i", status: 200, headers: {} },
  { type: "stream-chunk", linkVersion: 1, id: "i", index: 0, data: "AA" },
  { type: "stream-end", linkVersion: 1, id: "i" },
  { type: "stream-end", linkVersion: 1, id: "i", error: "boom" },
  { type: "rotation-ack", linkVersion: 1, keyId: "k" },
  { type: "challenge", linkVersion: 1, challenge: "x", linkHost: "link.example" },
  { type: "welcome", linkVersion: 1, coreId: "c", platformKeyId: "k" },
  { type: "instruction", linkVersion: 1, instruction: { envelope, platformSignature: "s" } },
  {
    type: "instruction",
    linkVersion: 1,
    instruction: { envelope, platformSignature: "s", tier2Signature: { keyId: "k", memberId: "m", signature: "s" } },
  },
  { type: "rotate-key", linkVersion: 1, newKeyId: "k2", newPublicKey: "pk", signature: "s" },
  { type: "revoked", linkVersion: 1 },
  { type: "cancel", linkVersion: 1, id: "i" },
];

describe("parseMessage", () => {
  it("parses every message type", () => {
    for (const m of messages) expect(parseMessage(JSON.stringify(m))).toEqual(m);
  });
  it("refuses linkVersion 2", () => {
    expect(() => parseMessage(JSON.stringify({ ...messages[0], linkVersion: 2 }))).toThrow(/linkVersion/);
  });
  it("refuses an unknown field", () => {
    for (const m of messages) {
      expect(() => parseMessage(JSON.stringify({ ...m, extra: 1 }))).toThrow(/extra/);
    }
  });
  it("refuses an unknown field inside an envelope", () => {
    const bad = { ...messages[9], instruction: { envelope: { ...envelope, extra: 1 }, platformSignature: "s" } };
    expect(() => parseMessage(JSON.stringify(bad))).toThrow(/extra/);
  });
  it("refuses a missing or mistyped field naming it", () => {
    expect(() => parseMessage(JSON.stringify({ type: "revoked" }))).toThrow(/linkVersion/);
    expect(() => parseMessage(JSON.stringify({ ...messages[1], status: "200" }))).toThrow(/status/);
    expect(() => parseMessage(JSON.stringify({ ...messages[3], index: undefined }))).toThrow(/index/);
  });
  it("parses a cancel", () => {
    expect(parseMessage('{"type":"cancel","linkVersion":1,"id":"ins_1"}')).toEqual({
      type: "cancel",
      linkVersion: 1,
      id: "ins_1",
    });
  });
  it("refuses a cancel with an extra field or without an id", () => {
    expect(() => parseMessage('{"type":"cancel","linkVersion":1,"id":"ins_1","reason":"x"}')).toThrow(/reason/);
    expect(() => parseMessage('{"type":"cancel","linkVersion":1}')).toThrow(/id/);
    expect(() => parseMessage('{"type":"cancel","linkVersion":1,"id":7}')).toThrow(/id/);
  });
  it("refuses an unknown type", () => {
    expect(() => parseMessage(JSON.stringify({ type: "nope", linkVersion: 1 }))).toThrow(LinkProtocolError);
    expect(() => parseMessage("not json")).toThrow(LinkProtocolError);
  });
  it("refuses a message over 5 MiB", () => {
    const big = JSON.stringify({
      type: "response",
      linkVersion: 1,
      id: "i",
      status: 200,
      headers: {},
      body: "A".repeat(MAX_MESSAGE_BYTES),
    });
    expect(() => parseMessage(big)).toThrow(LinkProtocolError);
  });
});

describe("nesting depth", () => {
  const deep = (n: number): unknown => {
    let v: unknown = 1;
    for (let i = 0; i < n; i++) v = { a: v };
    return v;
  };
  it("canonicalJson and instructionBytes throw LinkProtocolError past 64 levels", () => {
    expect(() => canonicalJson(deep(1000))).toThrow(LinkProtocolError);
    expect(() => instructionBytes({ ...envelope, body: deep(100) })).toThrow(LinkProtocolError);
    expect(() => canonicalJson(deep(40))).not.toThrow();
  });
  it("parseMessage refuses a body deeper than 64", () => {
    const msg = (b: unknown) =>
      JSON.stringify({
        type: "instruction",
        linkVersion: 1,
        instruction: { envelope: { ...envelope, body: b }, platformSignature: "s" },
      });
    expect(() => parseMessage(msg(deep(100)))).toThrow(/deeper than 64/);
    expect(() => parseMessage(msg(deep(20)))).not.toThrow();
  });
});

describe("enrollment bodies", () => {
  const req = { linkVersion: 1, code: "c", identityKey: "a", encryptionKey: "b", proof: "p" };
  const res = {
    coreId: "c",
    teamId: "t",
    platformKey: { keyId: "k", publicKey: "p" },
    linkHost: "h",
    ownerKey: { memberId: "m", publicKey: "p" },
  };
  it("parses both and refuses unknown fields", () => {
    expect(parseEnrollRequest(JSON.stringify(req))).toEqual(req);
    expect(parseEnrollResponse(JSON.stringify(res))).toEqual(res);
    expect(() => parseEnrollRequest(JSON.stringify({ ...req, extra: 1 }))).toThrow(/extra/);
    expect(() => parseEnrollResponse(JSON.stringify({ ...res, extra: 1 }))).toThrow(/extra/);
  });
});

describe("signing bytes", () => {
  const t = new TextDecoder();
  it("instructionBytes and tier2Bytes differ only in the prefix", () => {
    const e = envelope;
    expect(t.decode(instructionBytes(e)).startsWith("nbo-link/instruction/v1\n")).toBe(true);
    expect(t.decode(tier2Bytes(e)).startsWith("nbo-link/tier2/v1\n")).toBe(true);
    expect(t.decode(tier2Bytes(e)).slice(18)).toBe(t.decode(instructionBytes(e)).slice(24));
  });
  it("instructionBytes ignores key order in params and body", () => {
    const a = { ...envelope, params: { x: "1", y: "2" }, body: { p: 1, q: { r: 1, s: 2 } } };
    const b = { ...envelope, params: { y: "2", x: "1" }, body: { q: { s: 2, r: 1 }, p: 1 } };
    expect(instructionBytes(a)).toEqual(instructionBytes(b));
  });
  it("other prefixes", () => {
    expect(t.decode(authBytes({ coreId: "c", challenge: "x", linkHost: "h" }))).toBe(
      'nbo-link/auth/v1\n{"challenge":"x","coreId":"c","linkHost":"h"}',
    );
    expect(
      t.decode(rotateBytes({ coreId: "c", newKeyId: "k", newPublicKey: "p" })).startsWith("nbo-link/rotate/v1\n"),
    ).toBe(true);
    expect(
      t.decode(enrollBytes({ code: "c", identityKey: "a", encryptionKey: "b" })).startsWith("nbo-link/enroll/v1\n"),
    ).toBe(true);
  });
});
