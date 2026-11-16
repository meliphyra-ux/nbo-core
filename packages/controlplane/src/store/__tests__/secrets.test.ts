// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, open, loadOrCreateKey, secretKeyPath, ErrSecretKey } from "../secrets.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nbo-secrets-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("secret box", () => {
  it("round-trips and produces different ciphertext each time", () => {
    const key = randomBytes(32);
    const a = seal(key, "hello"),
      b = seal(key, "hello");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(open(key, a)).toBe("hello");
  });

  it("rejects tampered data and the wrong key", () => {
    const key = randomBytes(32);
    const s = seal(key, "hello");
    expect(() => open(randomBytes(32), s)).toThrow(ErrSecretKey);
    expect(() => open(key, s.slice(0, -2) + "AA")).toThrow(ErrSecretKey);
    expect(() => open(key, "garbage")).toThrow(ErrSecretKey);
  });

  it("rejects a truncated auth tag", () => {
    const key = randomBytes(32);
    const parts = seal(key, "hello").split(":");
    const short = Buffer.from(parts[2]!, "base64").subarray(0, 4).toString("base64");
    expect(() => open(key, [parts[0], parts[1], short, parts[3]].join(":"))).toThrow(ErrSecretKey);
  });

  it("creates a 32-byte key with mode 0600 when none exists and nothing is sealed", () => {
    const p = join(tmp, "k.key");
    const key = loadOrCreateKey(p, { hasSealedData: false });
    expect(key.length).toBe(32);
    expect(readFileSync(p).equals(key)).toBe(true);
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadOrCreateKey(p, { hasSealedData: true }).equals(key)).toBe(true);
  });

  it("refuses to create a key when sealed data exists", () => {
    expect(() => loadOrCreateKey(join(tmp, "missing.key"), { hasSealedData: true })).toThrow(/missing\.key/);
  });

  it("rejects a key file that is not 32 bytes", () => {
    const p = join(tmp, "short.key");
    writeFileSync(p, randomBytes(10));
    expect(() => loadOrCreateKey(p, { hasSealedData: false })).toThrow(ErrSecretKey);
    expect(() => loadOrCreateKey(p, { hasSealedData: false })).toThrow(/short\.key/);
  });

  it("secretKeyPath honours NBO_SECRET_KEY_FILE else sits beside the db", () => {
    expect(secretKeyPath({ NBO_SECRET_KEY_FILE: "/x/k" }, "/d/nbo.db")).toBe("/x/k");
    expect(secretKeyPath({}, join("/d", "nbo.db"))).toBe(join("/d", "nbo-secret.key"));
  });
});
