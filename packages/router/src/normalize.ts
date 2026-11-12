// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { posix } from "node:path";

export type TrailingSlashPolicy = "never" | "always" | "preserve";

function isUnreserved(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2d || // -
    b === 0x2e || // .
    b === 0x5f || // _
    b === 0x7e // ~
  );
}

function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

// decodeUnreserved percent-decodes only RFC 3986 unreserved characters
// (A-Z a-z 0-9 - . _ ~), leaving every other escape — notably %2F ("/")
// and %25 ("%") — untouched, so a segment can never smuggle a path
// separator past routing rules via percent-encoding. Operates on raw
// UTF-8 bytes, not JS string characters: a multi-byte UTF-8 sequence
// (e.g. "é" as %C3%A9) must be decoded or left alone as a whole
// two-byte unit, never one byte in isolation — the same reason Go's
// own version indexes a []byte, not a rune slice.
function decodeUnreserved(p: string): string {
  const bytes = Buffer.from(p, "utf8");
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x25 /* % */ && i + 2 < bytes.length) {
      const hi = hexVal(bytes[i + 1]!);
      const lo = hexVal(bytes[i + 2]!);
      if (hi >= 0 && lo >= 0) {
        const decoded = hi * 16 + lo;
        if (isUnreserved(decoded)) {
          out.push(decoded);
          i += 2;
          continue;
        }
      }
    }
    out.push(bytes[i]!);
  }
  return Buffer.from(out).toString("utf8");
}

// normalizePath decodes unreserved percent-escapes, resolves dot
// segments, and applies the trailing-slash policy, matching
// docs/nbo-spec.md's Routing > Matching rules section.
export function normalizePath(p: string, policy: TrailingSlashPolicy): string {
  const decoded = decodeUnreserved(p);
  const hadTrailingSlash = decoded.length > 1 && decoded.endsWith("/");
  let cleaned = posix.normalize(decoded);
  if (cleaned === ".") cleaned = "/";
  if (!cleaned.startsWith("/")) cleaned = "/" + cleaned;

  switch (policy) {
    case "always":
      if (cleaned !== "/" && !cleaned.endsWith("/")) cleaned += "/";
      break;
    case "never":
      if (cleaned !== "/" && cleaned.endsWith("/")) cleaned = cleaned.slice(0, -1);
      break;
    case "preserve":
      if (hadTrailingSlash && cleaned !== "/" && !cleaned.endsWith("/")) cleaned += "/";
      break;
  }
  return cleaned;
}
