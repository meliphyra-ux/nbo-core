// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compiledSchemas } from "./schemas.js";
import { checkManifestDigests, checkStaticFiles, reservedStaticKeys, unreferencedStaticFiles } from "./digests.js";
import { FUNCTION_NAME, validateFunction } from "./functions.js";
import { checkCrons } from "./crons.js";
import { checkRoutePatterns } from "./routes.js";
import { scanForSecrets } from "./secrets.js";
import { checkSpecVersion } from "./version.js";
import { checkCanonical } from "./canonical.js";
import { checkPrerender } from "./prerender.js";
import { checkReferences } from "./references.js";
import { checkExtensionKeys, declaredExtensions } from "./extensions.js";

export { SPEC_VERSION, checkSpecVersion } from "./version.js";

type ReadResult = { doc: unknown; raw: Buffer } | { error: Error };

// readJSON reads and parses path, returning the real read/parse error
// on failure instead of swallowing it — matching Go's own readJSON
// (validate.go:60-70), which returns (doc, raw, err) and lets the
// caller decide whether a missing/malformed file is fatal.
function readJSON(path: string): ReadResult {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    return { error: err as Error };
  }
  try {
    return { doc: JSON.parse(raw.toString("utf8")), raw };
  } catch (err) {
    return { error: new Error(`${path}: invalid JSON: ${(err as Error).message}`) };
  }
}

function isReadError(r: ReadResult): r is { error: Error } {
  return "error" in r;
}

// validate checks an .nbo/ directory in the order docs/nbo-spec.md
// "Validation and conformance" lists: spec version, schemas, canonical
// JSON, digests (with unreferenced static files and reserved /_nbo/
// keys), prerender.json, functions (bundle listing, name), references,
// crons, extension keys, RE2, secrets. Returns one error per problem
// found, or an empty array when the directory is valid. Warnings (see
// validateReport) are left out unless options.strict makes them errors.
export function validate(rawDir: string, options: ValidateOptions = {}): Error[] {
  return validateReport(rawDir, options).errors;
}

export interface ValidateOptions {
  // strict turns warnings into errors. Producers' own tests and CI use
  // it on fresh builds; promote, deploy and serve don't, so a build
  // stored before 1.0 final keeps validating.
  strict?: boolean;
}

// validateReport is validate with warnings kept apart: problems that a
// fresh 1.0 build must not have but a build stored before 1.0 final may
// (a static key under /_nbo/, an unlisted dispatch.json at a bundle root,
// a duplicate prerender id).
export function validateReport(rawDir: string, options: ValidateOptions = {}): { errors: Error[]; warnings: Error[] } {
  let warnings: Error[] = [];
  // Resolved once, up front, to an absolute path — checkStaticFiles/
  // validateFunction already resolve internally via resolveStatic/
  // resolveBundlePath, but unreferencedStaticFiles and scanForSecrets
  // build their own paths by joining onto whatever was passed in; a
  // relative rawDir made every real static file compare unequal
  // against resolveStatic's own absolute "referenced" paths, so every
  // file read as unreferenced. One resolve() here keeps every phase
  // working from the same absolute base, the same way Go's own
  // filepath.Clean/Join calls are resolution-order-independent.
  const dir = resolve(rawDir);
  let errs: Error[] = [];

  const manifest = readJSON(join(dir, "manifest.json"));
  if (isReadError(manifest)) {
    return { errors: [manifest.error], warnings: [] };
  }
  // The version comes first: a newer spec's other errors would mislead.
  // The remaining checks still run.
  errs = errs.concat(checkSpecVersion(manifest.doc));
  if (!compiledSchemas.manifest(manifest.doc)) {
    errs.push(new Error(`manifest.json: schema validation failed: ${compiledSchemas.manifest.errors ? JSON.stringify(compiledSchemas.manifest.errors) : ""}`));
  }

  const staticIndex = readJSON(join(dir, "static.index.json"));
  if (isReadError(staticIndex)) {
    errs.push(staticIndex.error);
  } else if (!compiledSchemas.staticIndex(staticIndex.doc)) {
    errs.push(new Error(`static.index.json: schema validation failed: ${compiledSchemas.staticIndex.errors ? JSON.stringify(compiledSchemas.staticIndex.errors) : ""}`));
  }

  const routes = readJSON(join(dir, "routes.json"));
  if (isReadError(routes)) {
    errs.push(routes.error);
  } else if (!compiledSchemas.routes(routes.doc)) {
    errs.push(new Error(`routes.json: schema validation failed: ${compiledSchemas.routes.errors ? JSON.stringify(compiledSchemas.routes.errors) : ""}`));
  }

  const staticIndexOk = !isReadError(staticIndex) ? staticIndex : undefined;
  const routesOk = !isReadError(routes) ? routes : undefined;

  // Every metadata file is RFC 8785 canonical (function.json and
  // bundle.index.json are checked in validateFunction).
  errs = errs.concat(checkCanonical("manifest.json", manifest.raw));
  if (staticIndexOk) errs = errs.concat(checkCanonical("static.index.json", staticIndexOk.raw));
  if (routesOk) errs = errs.concat(checkCanonical("routes.json", routesOk.raw));

  errs = errs.concat(checkManifestDigests(manifest.doc, staticIndexOk?.raw, routesOk?.raw));

  if (staticIndexOk) {
    const { errors, referenced } = checkStaticFiles(dir, staticIndexOk.doc);
    errs = errs.concat(errors);
    errs = errs.concat(unreferencedStaticFiles(dir, referenced));
    warnings = warnings.concat(reservedStaticKeys(staticIndexOk.doc));
  }

  const prerender = checkPrerender(dir, manifest.doc);
  errs = errs.concat(prerender.errors);
  warnings = warnings.concat(prerender.warnings ?? []);

  const manifestDoc = manifest.doc as { functions?: unknown[]; digests?: Record<string, unknown> } | null;
  const functionNames = Array.isArray(manifestDoc?.functions) ? manifestDoc.functions : [];
  const extensionDocs: { rel: string; doc: unknown }[] = [{ rel: "manifest.json", doc: manifest.doc }];
  for (const name of functionNames) {
    if (typeof name === "string") {
      errs = errs.concat(validateFunction(dir, name, manifestDoc?.digests ?? {}, warnings));
      if (!FUNCTION_NAME.test(name)) continue;
      const fn = readJSON(join(dir, "functions", name, "function.json"));
      if (!isReadError(fn)) extensionDocs.push({ rel: `functions/${name}/function.json`, doc: fn.doc });
    }
  }

  errs = errs.concat(
    checkReferences({ manifest: manifest.doc, routes: routesOk?.doc, staticIndex: staticIndexOk?.doc, prerender: prerender.doc }),
  );

  errs = errs.concat(checkCrons(manifest.doc));

  if (routesOk) extensionDocs.push({ rel: "routes.json", doc: routesOk.doc });
  if (prerender.doc !== undefined) extensionDocs.push({ rel: "prerender.json", doc: prerender.doc });
  if (staticIndexOk) extensionDocs.push({ rel: "static.index.json", doc: staticIndexOk.doc });
  errs = errs.concat(checkExtensionKeys(extensionDocs, declaredExtensions(manifest.doc)));

  errs = errs.concat(checkRoutePatterns(routesOk?.doc ?? null, prerender.doc));

  errs = errs.concat(scanForSecrets(dir));

  return options.strict ? { errors: errs.concat(warnings), warnings: [] } : { errors: errs, warnings };
}
