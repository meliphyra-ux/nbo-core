// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { canonicalize } from "@nbo/digest";

// checkCanonical refuses a metadata file that isn't written in RFC 8785
// canonical form. Every JSON file in .nbo/ is canonical, so the sha256
// of its bytes and the sha256 of its canonical JSON are the same digest.
// Invalid JSON is left to the caller's own parse error.
export function checkCanonical(rel: string, raw: Buffer): Error[] {
  const text = raw.toString("utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (canonicalize(doc) !== text) {
    return [new Error(`${rel}: not canonical JSON (RFC 8785)`)];
  }
  return [];
}
