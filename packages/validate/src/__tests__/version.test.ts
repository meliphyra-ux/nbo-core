// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SPEC_VERSION, checkSpecVersion, readSpecVersion } from "../version.js";

const require = createRequire(import.meta.url);

describe("SPEC_VERSION", () => {
  it("is the version in @nbo/spec/version.json", () => {
    const file = JSON.parse(readFileSync(require.resolve("@nbo/spec/version.json"), "utf8"));
    expect(SPEC_VERSION).toBe(file.specVersion);
    expect(SPEC_VERSION).toBe("1.0");
  });
});

describe("checkSpecVersion", () => {
  it("accepts 1.0", () => {
    expect(checkSpecVersion({ specVersion: "1.0" })).toEqual([]);
  });

  it("refuses a newer minor with an upgrade message", () => {
    expect(checkSpecVersion({ specVersion: "1.1" }).map((e) => e.message)).toEqual([
      "manifest.json: built for NBO spec 1.1; this nbo reads spec 1.0 and older 1.x; upgrade NBO",
    ]);
  });

  it("compares minors as numbers, not strings", () => {
    expect(checkSpecVersion({ specVersion: "1.10" }).map((e) => e.message)).toEqual([
      "manifest.json: built for NBO spec 1.10; this nbo reads spec 1.0 and older 1.x; upgrade NBO",
    ]);
  });

  it("refuses another major (newer or older)", () => {
    expect(checkSpecVersion({ specVersion: "2.0" }).map((e) => e.message)).toEqual([
      "manifest.json: NBO spec 2.0 is not supported; this nbo reads 1.x",
    ]);
    expect(checkSpecVersion({ specVersion: "0.9" }).map((e) => e.message)).toEqual([
      "manifest.json: NBO spec 0.9 is not supported; this nbo reads 1.x",
    ]);
  });

  it("leaves a missing or malformed value to the schema", () => {
    expect(checkSpecVersion({})).toEqual([]);
    expect(checkSpecVersion(null)).toEqual([]);
    expect(checkSpecVersion("1.0")).toEqual([]);
    expect(checkSpecVersion({ specVersion: 1 })).toEqual([]);
    expect(checkSpecVersion({ specVersion: "1" })).toEqual([]);
    expect(checkSpecVersion({ specVersion: "v1.1" })).toEqual([]);
    expect(checkSpecVersion({ specVersion: "1.1.0" })).toEqual([]);
  });
});

describe("readSpecVersion", () => {
  it("returns the version from a well-formed file", () => {
    expect(readSpecVersion('{"specVersion":"1.0"}')).toBe("1.0");
  });

  it("fails loudly on a malformed file instead of accepting everything", () => {
    expect(() => readSpecVersion('{"specVersion":"1"}')).toThrow(
      '@nbo/spec/version.json: specVersion must be "<major>.<minor>", got "1"',
    );
    expect(() => readSpecVersion("{}")).toThrow("@nbo/spec/version.json");
    expect(() => readSpecVersion("{not json")).toThrow("@nbo/spec/version.json");
  });
});
