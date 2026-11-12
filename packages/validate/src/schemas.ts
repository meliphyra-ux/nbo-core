// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv } from "ajv";
import type { Ajv as AjvInstance, AnySchemaObject } from "ajv";

// ajv-formats is a CJS module with only a default export (no real named
// export, unlike ajv's own "Ajv" class above). Its .d.ts declares
// `export default`, which NodeNext reads as a module namespace, so a
// default import isn't directly callable under TS — the same CJS-
// interop issue packages/digest's own digest.ts already found and
// worked around for "canonicalize": cast require()'s result to the real
// callable shape directly, not to the default-import's own type (that
// type reference hits the identical namespace problem).
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as (ajv: AjvInstance) => void;

function readSchema(specifier: string): AnySchemaObject {
  return JSON.parse(readFileSync(require.resolve(specifier), "utf8"));
}

const ajv = new Ajv();
addFormats(ajv);

export const compiledSchemas = {
  manifest: ajv.compile(readSchema("@nbo/spec/manifest.schema.json")),
  staticIndex: ajv.compile(readSchema("@nbo/spec/static-index.schema.json")),
  routes: ajv.compile(readSchema("@nbo/spec/routes.schema.json")),
  function: ajv.compile(readSchema("@nbo/spec/function.schema.json")),
  bundleIndex: ajv.compile(readSchema("@nbo/spec/bundle-index.schema.json")),
  prerender: ajv.compile(readSchema("@nbo/spec/prerender.schema.json")),
};
