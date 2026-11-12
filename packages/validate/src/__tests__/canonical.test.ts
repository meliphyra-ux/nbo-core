// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { canonicalize } from "@nbo/digest";
import { checkCanonical } from "../canonical.js";

describe("checkCanonical", () => {
  it("accepts canonical JSON", () => {
    expect(checkCanonical("routes.json", Buffer.from(canonicalize({ version: 1, afterFiles: [] })))).toEqual([]);
  });

  it("refuses unsorted keys, naming the file", () => {
    const errs = checkCanonical("routes.json", Buffer.from('{"version":1,"afterFiles":[]}'));
    expect(errs.map((e) => e.message)).toEqual(["routes.json: not canonical JSON (RFC 8785)"]);
  });

  it("refuses whitespace and a trailing newline", () => {
    expect(checkCanonical("manifest.json", Buffer.from('{ "a": 1 }'))).toHaveLength(1);
    expect(checkCanonical("manifest.json", Buffer.from('{"a":1}\n'))).toHaveLength(1);
  });

  it("leaves invalid JSON to the parse error", () => {
    expect(checkCanonical("routes.json", Buffer.from("{not json"))).toEqual([]);
  });
});
