// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

describe("@nbo/spec exports", () => {
  it("resolves manifest.schema.json by bare specifier", () => {
    const require = createRequire(import.meta.url);
    const path = require.resolve("@nbo/spec/manifest.schema.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});
