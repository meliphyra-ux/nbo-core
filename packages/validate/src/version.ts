// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// SPEC_VERSION is the NBO spec version this validator reads, from the
// one source of it: @nbo/spec/version.json (the writer writes the same
// file's value into every manifest).
export const SPEC_VERSION: string = readSpecVersion(readFileSync(require.resolve("@nbo/spec/version.json"), "utf8"));

function parseVersion(v: string): { major: number; minor: number } | undefined {
  const m = /^([0-9]+)\.([0-9]+)$/.exec(v);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// readSpecVersion parses the text of @nbo/spec/version.json and throws
// when it isn't usable: a broken version file must stop validate from
// loading, not let every manifest through.
export function readSpecVersion(text: string): string {
  let value: unknown;
  try {
    value = (JSON.parse(text) as { specVersion?: unknown } | null)?.specVersion;
  } catch (err) {
    throw new Error(`@nbo/spec/version.json: invalid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (typeof value !== "string" || !parseVersion(value)) {
    throw new Error(
      `@nbo/spec/version.json: specVersion must be "<major>.<minor>", got ${JSON.stringify(value) ?? "nothing"}`,
    );
  }
  return value;
}

// checkSpecVersion accepts a manifest whose specVersion has this
// validator's major and a minor no newer than its own. A newer minor
// may carry fields this validator can't know, so it is refused rather
// than half-read. A missing or malformed value is left to the schema.
export function checkSpecVersion(manifestDoc: unknown): Error[] {
  if (typeof manifestDoc !== "object" || manifestDoc === null) return [];
  const value = (manifestDoc as { specVersion?: unknown }).specVersion;
  if (typeof value !== "string") return [];
  const got = parseVersion(value);
  const own = parseVersion(SPEC_VERSION);
  if (!got || !own) return [];
  if (got.major !== own.major) {
    return [new Error(`manifest.json: NBO spec ${value} is not supported; this nbo reads ${own.major}.x`)];
  }
  if (got.minor > own.minor) {
    return [
      new Error(
        `manifest.json: built for NBO spec ${value}; this nbo reads spec ${SPEC_VERSION} and older ${own.major}.x; upgrade NBO`,
      ),
    ];
  }
  return [];
}
