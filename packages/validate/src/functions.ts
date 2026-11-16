// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { compiledSchemas } from "./schemas.js";
import { fileDigest, missingDigest } from "./digests.js";
import { checkCanonical } from "./canonical.js";

// resolveBundlePath joins rel onto <dir>/functions/<name>/bundle/ and
// reports whether the result still lives inside that directory once
// resolved — the same escape guard resolveStatic applies to
// static.index.json's "file" values, but scoped to a function's bundle
// tree instead of static/, since the two are never interchangeable.
// Kept as its own function rather than generalizing resolveStatic,
// matching validate.go's own choice.
export function resolveBundlePath(dir: string, name: string, rel: string): { ok: true; path: string } | { ok: false } {
  const bundleDir = resolve(dir, "functions", name, "bundle");
  const full = resolve(join(bundleDir, rel));
  const relBack = relative(bundleDir, full);
  if (relBack === ".." || relBack.startsWith(".." + "/") || relBack.startsWith(".." + "\\")) {
    return { ok: false };
  }
  return { ok: true, path: full };
}

interface BundleIndexFileEntry {
  digest?: string;
}

// FUNCTION_NAME is function.json's name pattern (DNS-safe). Validate
// checks a manifest's function names against it before joining any of
// them into a path, so a name like "../x" never reads outside .nbo/.
export const FUNCTION_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export function functionNameError(name: string): Error | undefined {
  if (FUNCTION_NAME.test(name)) return undefined;
  return new Error(
    `manifest.json: function name "${name}" is not valid (lowercase letters, digits and hyphens, starting with a letter, at most 63 characters)`,
  );
}

// validateFunction checks one named function's function.json against its
// schema and manifest digest, then its bundle.index.json against its own
// schema and the function's artifact digest, then every file the bundle
// index lists against its actual digest on disk — port of validate.go's
// own validateFunction (lines 126-199). Problems a build stored before
// spec 1.0 final may have (an unlisted root dispatch.json) go to warnings.
export function validateFunction(
  dir: string,
  name: string,
  manifestDigests: Record<string, unknown>,
  warnings: Error[] = [],
): Error[] {
  const nameErr = functionNameError(name);
  if (nameErr) return [nameErr];
  const errs: Error[] = [];

  const fnPath = join(dir, "functions", name, "function.json");
  let fnRaw: Buffer;
  try {
    fnRaw = readFileSync(fnPath);
  } catch (err) {
    return [err as Error];
  }
  let fnDoc: unknown;
  try {
    fnDoc = JSON.parse(fnRaw.toString("utf8"));
  } catch (err) {
    errs.push(new Error(`functions/${name}/function.json: invalid JSON: ${(err as Error).message}`));
    return errs;
  }
  if (!compiledSchemas.function(fnDoc)) {
    errs.push(new Error(`functions/${name}/function.json: schema validation failed`));
  }
  errs.push(...checkCanonical(`functions/${name}/function.json`, fnRaw));
  const declaredName = (fnDoc as { name?: unknown } | null)?.name;
  if (typeof declaredName === "string" && declaredName !== name) {
    errs.push(new Error(`functions/${name}/function.json: name "${declaredName}" does not match its folder`));
  }
  const wantFnDigest = manifestDigests[`functions/${name}/function.json`];
  if (wantFnDigest === undefined) {
    // Every writer has pinned each function.json since functions existed
    // (1212316, 2026-10-23), so a stored build always has the entry.
    errs.push(missingDigest(`functions/${name}/function.json`));
  } else if (typeof wantFnDigest === "string") {
    const got = fileDigest(fnRaw);
    if (got !== wantFnDigest) {
      errs.push(
        new Error(`functions/${name}/function.json: digest mismatch: manifest says ${wantFnDigest}, actual is ${got}`),
      );
    }
  }

  const artifact = (fnDoc as { artifact?: { digest?: string } } | null)?.artifact;
  if (!artifact) {
    errs.push(new Error(`functions/${name}/function.json: missing artifact`));
    return errs;
  }
  const wantArtifactDigest = artifact.digest;

  const bundleIndexPath = join(dir, "functions", name, "bundle", "bundle.index.json");
  let bundleIndexRaw: Buffer;
  try {
    bundleIndexRaw = readFileSync(bundleIndexPath);
  } catch (err) {
    errs.push(err as Error);
    return errs;
  }
  let bundleIndexDoc: unknown;
  try {
    bundleIndexDoc = JSON.parse(bundleIndexRaw.toString("utf8"));
  } catch (err) {
    errs.push(new Error(`functions/${name}/bundle/bundle.index.json: invalid JSON: ${(err as Error).message}`));
    return errs;
  }
  if (!compiledSchemas.bundleIndex(bundleIndexDoc)) {
    errs.push(new Error(`functions/${name}/bundle/bundle.index.json: schema validation failed`));
  }
  errs.push(...checkCanonical(`functions/${name}/bundle/bundle.index.json`, bundleIndexRaw));
  const gotArtifactDigest = fileDigest(bundleIndexRaw);
  if (gotArtifactDigest !== wantArtifactDigest) {
    errs.push(
      new Error(
        `functions/${name}/bundle/bundle.index.json: digest mismatch: function.json says ${wantArtifactDigest}, actual is ${gotArtifactDigest}`,
      ),
    );
  }

  const files = (bundleIndexDoc as { files?: Record<string, BundleIndexFileEntry | null> } | null)?.files;
  if (files) {
    for (const [relPath, entry] of Object.entries(files)) {
      if (!entry) continue;
      const wantDigest = entry.digest;
      const resolved = resolveBundlePath(dir, name, relPath);
      if (!resolved.ok) {
        errs.push(new Error(`functions/${name}/bundle: ${relPath}: file path escapes bundle/`));
        continue;
      }
      let raw: Buffer;
      try {
        raw = readFileSync(resolved.path);
      } catch (err) {
        errs.push(new Error(`functions/${name}/bundle/${relPath}: ${(err as Error).message}`));
        continue;
      }
      const got = fileDigest(raw);
      if (got !== wantDigest) {
        errs.push(
          new Error(
            `functions/${name}/bundle/${relPath}: digest mismatch: bundle.index.json says ${wantDigest}, actual is ${got}`,
          ),
        );
      }
    }
  }

  if (files && typeof files === "object") {
    const unlisted = unlistedBundleFiles(dir, name, new Set(Object.keys(files)));
    errs.push(...unlisted.errors);
    warnings.push(...unlisted.warnings);
  }

  return errs;
}

// unlistedBundleFiles walks bundle/ the way the writer's walkBundleFiles
// does (regular files, '/'-separated relative paths) and reports every
// file bundle.index.json doesn't list, so nothing in the bundle sits
// outside the content id. Anything that is not a regular file or a
// directory (a symlink) is an error: the writer never makes one. The one
// allowance is an unlisted dispatch.json at the bundle root, which
// builds made before 1.0 final wrote after computing the index: it is a
// warning, so stored builds keep validating and --strict refuses it.
export function unlistedBundleFiles(
  dir: string,
  name: string,
  listed: Set<string>,
): { errors: Error[]; warnings: Error[] } {
  const errs: Error[] = [];
  const warnings: Error[] = [];
  const bundleDir = join(dir, "functions", name, "bundle");
  const walk = (sub: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(sub ? join(bundleDir, sub) : bundleDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.isFile()) {
        errs.push(new Error(`functions/${name}/bundle/${rel}: not a regular file`));
        continue;
      }
      if (rel === "bundle.index.json" || listed.has(rel)) continue;
      if (rel === "dispatch.json") {
        warnings.push(
          new Error(
            `functions/${name}/bundle/dispatch.json: not listed in bundle.index.json (accepted only for builds made before spec 1.0 final)`,
          ),
        );
        continue;
      }
      errs.push(new Error(`functions/${name}/bundle/${rel}: not listed in bundle.index.json`));
    }
  };
  walk("");
  return { errors: errs, warnings };
}
