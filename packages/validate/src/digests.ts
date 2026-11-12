// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@nbo/digest";
import { resolveStatic } from "@nbo/nbopath";

// fileDigest is the sha256: a prefixed digest over raw file bytes — not
// the RFC 8785 canonical-JSON digestOf @nbo/digest's own contentId uses
// for content ids elsewhere. Wraps @nbo/digest's own sha256Hex (raw hex,
// no prefix) rather than reimplementing SHA-256 a third time.
export function fileDigest(raw: Buffer): string {
  return `sha256:${sha256Hex(raw)}`;
}

// checkManifestDigests requires manifest.digests["static.index.json"] and
// ["routes.json"] and re-verifies them against the raw bytes of those two
// files. Without an entry a file would sit outside the content id. Every
// writer has written both since the first one (a79d445, 2026-10-22), so
// stored builds keep validating. The caller already has the raw bytes.
export function checkManifestDigests(manifestDoc: unknown, staticIndexRaw: Buffer | undefined, routesRaw: Buffer | undefined): Error[] {
  const errs: Error[] = [];
  const manifest = manifestDoc as { digests?: Record<string, unknown> } | null;
  const digests = manifest?.digests && typeof manifest.digests === "object" ? manifest.digests : {};
  for (const rel of ["static.index.json", "routes.json"]) {
    if (digests[rel] === undefined) errs.push(missingDigest(rel));
  }

  if (typeof digests["static.index.json"] === "string" && staticIndexRaw !== undefined) {
    const want = digests["static.index.json"];
    const got = fileDigest(staticIndexRaw);
    if (got !== want) {
      errs.push(new Error(`static.index.json: digest mismatch: manifest says ${want}, actual is ${got}`));
    }
  }
  if (typeof digests["routes.json"] === "string" && routesRaw !== undefined) {
    const want = digests["routes.json"];
    const got = fileDigest(routesRaw);
    if (got !== want) {
      errs.push(new Error(`routes.json: digest mismatch: manifest says ${want}, actual is ${got}`));
    }
  }
  return errs;
}

// missingDigest is the error for a core file (static.index.json,
// routes.json, a function.json) that manifest.digests doesn't name.
export function missingDigest(rel: string): Error {
  return new Error(`${rel}: manifest.json digests has no entry for it`);
}

// reservedStaticKeys names every static.index.json key under /_nbo/,
// which belongs to the platform. validate reports these as warnings
// (an error under strict): a build made before 1.0 final may carry one
// from a site's own files, and such a stored build must keep promoting.
export function reservedStaticKeys(staticIndexDoc: unknown): Error[] {
  const files = (staticIndexDoc as { files?: unknown } | null)?.files;
  if (typeof files !== "object" || files === null) return [];
  return Object.keys(files)
    .filter((key) => key.startsWith("/_nbo/"))
    .map((key) => new Error(`static.index.json: "${key}": paths under /_nbo/ are reserved for the platform`));
}

interface StaticIndexFileEntry {
  file?: string;
  digest?: string;
}

// checkStaticFiles walks staticIndexDoc.files, resolves each declared
// "file" value under <dir>/static (rejecting any that escape it), and
// compares its on-disk content against the declared digest — port of
// validate.go's own inline check (lines 247-274, minus the
// unreferencedStaticFiles call at the end, which is its own function
// here per the plan's own split). referenced is every resolved full
// path this function actually checked, for unreferencedStaticFiles to
// use.
export function checkStaticFiles(dir: string, staticIndexDoc: unknown): { errors: Error[]; referenced: Set<string> } {
  const errors: Error[] = [];
  const referenced = new Set<string>();
  const doc = staticIndexDoc as { files?: Record<string, StaticIndexFileEntry | null> } | null;
  const files = doc?.files;
  if (!files) return { errors, referenced };

  for (const [urlPath, entry] of Object.entries(files)) {
    if (!entry) continue;
    const file = entry.file;
    const wantDigest = entry.digest;
    if (typeof file !== "string") continue;
    const resolved = resolveStatic(dir, file);
    if (!resolved.ok) {
      errors.push(new Error(`${urlPath} (${file}): file path escapes static/`));
      continue;
    }
    referenced.add(resolved.path);
    let raw: Buffer;
    try {
      raw = readFileSync(resolved.path);
    } catch (err) {
      errors.push(new Error(`${urlPath} (${file}): ${(err as Error).message}`));
      continue;
    }
    const got = fileDigest(raw);
    if (got !== wantDigest) {
      errors.push(new Error(`${urlPath} (${file}): digest mismatch: static.index.json says ${wantDigest}, actual is ${got}`));
    }
  }
  return { errors, referenced };
}

// unreferencedStaticFiles walks <dir>/static and reports every entry
// that is not a file in referenced: stale leftovers from an earlier
// build, hand-added files, and anything that is not a regular file (the
// spec allows no symlinks) — port of validate.go's own
// unreferencedStaticFiles (lines 77-106).
export function unreferencedStaticFiles(dir: string, referenced: Set<string>): Error[] {
  const errs: Error[] = [];
  const staticDir = join(dir, "static");
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(staticDir, { recursive: true, withFileTypes: true, encoding: "utf8" });
  } catch {
    return errs;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const full = join(entry.parentPath ?? staticDir, entry.name);
    const rel =
      "static/" +
      full
        .slice(staticDir.length + 1)
        .split("\\")
        .join("/");
    if (!entry.isFile()) {
      errs.push(new Error(`${rel}: not a regular file`));
      continue;
    }
    if (!referenced.has(full)) {
      errs.push(new Error(`${rel}: not referenced by any static.index.json entry`));
    }
  }
  return errs;
}
