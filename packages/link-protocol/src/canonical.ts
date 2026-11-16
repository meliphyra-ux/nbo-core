// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import canonicalizeLib from "canonicalize";
import { LinkProtocolError } from "./messages.js";

export const MAX_DEPTH = 64;

const canonicalize = canonicalizeLib as unknown as (value: unknown) => string | undefined;

function check(value: unknown, path: string, seen: Set<object>, depth = 0): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`cannot canonicalize a non-finite number at ${path}`);
      return;
    case "object": {
      if (depth >= MAX_DEPTH) throw new LinkProtocolError(`nesting deeper than ${MAX_DEPTH} levels at ${path}`);
      if (seen.has(value)) throw new TypeError(`cannot canonicalize a cycle at ${path}`);
      seen.add(value);
      if (Array.isArray(value)) value.forEach((v, i) => check(v, `${path}[${i}]`, seen, depth + 1));
      else for (const [k, v] of Object.entries(value)) check(v, `${path}.${k}`, seen, depth + 1);
      seen.delete(value);
      return;
    }
    default:
      throw new TypeError(`cannot canonicalize a ${typeof value} at ${path}`);
  }
}

/** RFC 8785 canonical JSON. Throws TypeError on undefined, a non-finite number or a cycle. */
export function canonicalJson(value: unknown): string {
  check(value, "$", new Set());
  const out = canonicalize(value);
  if (out === undefined) throw new TypeError("cannot canonicalize undefined");
  return out;
}
