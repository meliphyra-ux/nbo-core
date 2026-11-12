// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { lookup } from "mime-types";

const TEXTUAL_TYPES = new Set(["application/javascript", "application/json", "image/svg+xml"]);

export function contentTypeFor(filePath: string): string {
  const base = lookup(filePath);
  if (!base) return "application/octet-stream";
  if (base.startsWith("text/") || TEXTUAL_TYPES.has(base)) {
    return `${base}; charset=utf-8`;
  }
  return base;
}
