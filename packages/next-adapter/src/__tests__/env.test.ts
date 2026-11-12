// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { fromNextEnv } from "../env.js";

describe("fromNextEnv", () => {
  it("lists only NEXT_PUBLIC_* names, sorted", () => {
    const { inlinedAtBuild } = fromNextEnv({
      NEXT_PUBLIC_FLAG: "1",
      NEXT_PUBLIC_API_BASE: "https://api.example.com",
      OTHER_VAR: "ignored",
      PATH: "ignored",
    });
    expect(inlinedAtBuild).toEqual(["NEXT_PUBLIC_API_BASE", "NEXT_PUBLIC_FLAG"]);
  });

  it("produces a reproducible digest regardless of key insertion order", () => {
    const a = fromNextEnv({ NEXT_PUBLIC_A: "1", NEXT_PUBLIC_B: "2" });
    const b = fromNextEnv({ NEXT_PUBLIC_B: "2", NEXT_PUBLIC_A: "1" });
    expect(a.inlinedEnvDigest).toBe(b.inlinedEnvDigest);
  });

  it("changes the digest when an inlined value changes", () => {
    const a = fromNextEnv({ NEXT_PUBLIC_A: "1" });
    const b = fromNextEnv({ NEXT_PUBLIC_A: "2" });
    expect(a.inlinedEnvDigest).not.toBe(b.inlinedEnvDigest);
  });

  it("returns an empty list and a stable digest when there are no NEXT_PUBLIC_* vars at all", () => {
    const { inlinedAtBuild, inlinedEnvDigest } = fromNextEnv({ OTHER_VAR: "x" });
    expect(inlinedAtBuild).toEqual([]);
    expect(typeof inlinedEnvDigest).toBe("string");
    expect(inlinedEnvDigest.length).toBeGreaterThan(0);
  });
});
