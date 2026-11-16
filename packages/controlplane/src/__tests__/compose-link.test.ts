// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..", "..", "..");

describe("compose", () => {
  it("compose passes the three enrollment settings from .env", () => {
    const doc = parse(readFileSync(join(root, "compose.yaml"), "utf8")) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    const env = Object.values(doc.services).find((s) => s.environment?.NBO_MODE)!.environment;
    for (const name of ["NBO_LINK_ENROLL_URL", "NBO_LINK_ENROLL_CODE", "NBO_LINK_OWNER_KEY"]) {
      expect(env[name]).toBe("${" + name + ":-}");
    }
  });
});
