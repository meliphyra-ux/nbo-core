// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ErrSecretKey covers every way the secret box can fail: a missing or
// malformed key file, or a stored secret that will not decrypt.
export class ErrSecretKey extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrSecretKey";
  }
}

const DECRYPT_MESSAGE = "could not decrypt a stored secret — is NBO_SECRET_KEY_FILE the key this database was created with?";

export function secretKeyPath(env: NodeJS.ProcessEnv, dbPath: string): string {
  return env.NBO_SECRET_KEY_FILE || join(dirname(dbPath), "nbo-secret.key");
}

// loadOrCreateKey reads the 32-byte AES key at path. It creates one only
// when none exists AND nothing in the database is sealed — a missing key
// next to sealed data must never be silently replaced.
export function loadOrCreateKey(path: string, opts: { hasSealedData: boolean }): Buffer {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== 32) {
      throw new ErrSecretKey(`secret key file ${path} must be exactly 32 bytes (found ${key.length})`);
    }
    return key;
  }
  if (opts.hasSealedData) {
    throw new ErrSecretKey(`secret key file ${path} is missing but the database holds sealed secrets; restore the key file or set NBO_SECRET_KEY_FILE`);
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  return key;
}

// seal returns v1:<iv>:<tag>:<ciphertext>, each part base64.
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function open(key: Buffer, sealed: string): string {
  try {
    const parts = sealed.split(":");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("bad format");
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const ct = Buffer.from(parts[3]!, "base64");
    // Pin the tag length: GCM would otherwise accept a truncated tag.
    if (tag.length !== 16) throw new Error("bad tag length");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new ErrSecretKey(DECRYPT_MESSAGE);
  }
}
