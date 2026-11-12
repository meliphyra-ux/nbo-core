// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// canonicalize is a CJS module (module.exports = fn). Its .d.ts declares
// `export default`, which NodeNext reads as a module namespace, so the
// default import is not callable under TS. Load it via require to get the
// real function shape.
const requireCjs = createRequire(import.meta.url);
const canonicalizeImpl = requireCjs("canonicalize") as (input: unknown) => string | undefined;

export function canonicalize(value: unknown): string {
  const result = canonicalizeImpl(value);
  if (result === undefined) {
    throw new TypeError("canonicalize: value is undefined");
  }
  return result;
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

// contentId mirrors internal/contentid.ContentID exactly: only the
// manifest's own top-level "build" key is removed (nothing nested is
// touched), then the rest is digested. The two implementations must
// agree bit-for-bit on the same input for nbo deploy's idempotency
// check to mean anything.
export function contentId(manifest: Record<string, unknown>): string {
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (k === "build") continue;
    stripped[k] = v;
  }
  return digestOf(stripped);
}
