// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compiledSchemas } from "./schemas.js";
import { checkCanonical } from "./canonical.js";
import { fileDigest } from "./digests.js";

// checkPrerender checks the optional prerender.json: the file and its
// manifest digest come together or not at all, and a present file must
// match its schema, be canonical and match the digest. doc is returned
// when the file parses, for the reference, extension and RE2 checks.
export function checkPrerender(
  dir: string,
  manifestDoc: unknown,
): { errors: Error[]; doc?: unknown; warnings?: Error[] } {
  const errors: Error[] = [];
  const digests = (manifestDoc as { digests?: Record<string, unknown> } | null)?.digests;
  const want = digests && typeof digests === "object" ? digests["prerender.json"] : undefined;
  const path = join(dir, "prerender.json");

  if (!existsSync(path)) {
    if (want !== undefined) {
      errors.push(new Error("prerender.json: manifest.json digests names it, but the file is missing"));
    }
    return { errors };
  }

  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    errors.push(new Error(`prerender.json: ${(err as Error).message}`));
    return { errors };
  }

  if (want === undefined) {
    errors.push(new Error("prerender.json: present, but manifest.json digests has no entry for it"));
  } else {
    const got = fileDigest(raw);
    if (got !== want) {
      errors.push(new Error(`prerender.json: digest mismatch: manifest says ${String(want)}, actual is ${got}`));
    }
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    errors.push(new Error(`prerender.json: invalid JSON: ${(err as Error).message}`));
    return { errors };
  }
  if (!compiledSchemas.prerender(doc)) {
    errors.push(
      new Error(
        `prerender.json: schema validation failed: ${compiledSchemas.prerender.errors ? JSON.stringify(compiledSchemas.prerender.errors) : ""}`,
      ),
    );
  }
  errors.push(...checkCanonical("prerender.json", raw));
  return { errors, doc, warnings: duplicatePrerenderIds(doc) };
}

// duplicatePrerenderIds names every id that appears more than once. A
// warning, an error under strict: the Next adapter keyed entries by route
// until 53e7b6e (2026-10-26), so a page and its .rsc variant shared an id,
// and a build stored from then must keep promoting.
export function duplicatePrerenderIds(doc: unknown): Error[] {
  const list = (doc as { prerenders?: unknown } | null)?.prerenders;
  if (!Array.isArray(list)) return [];
  const seen = new Set<unknown>();
  const reported = new Set<unknown>();
  const out: Error[] = [];
  for (const entry of list) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (seen.has(id) && !reported.has(id)) {
      reported.add(id);
      out.push(new Error(`prerender.json: duplicate prerender id ${JSON.stringify(id)}`));
    }
    seen.add(id);
  }
  return out;
}
