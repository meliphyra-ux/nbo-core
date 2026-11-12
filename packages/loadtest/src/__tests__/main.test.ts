// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { parseLoadtestOptions } from "../main.js";

describe("parseLoadtestOptions", () => {
  it("defaults when no env vars are set", () => {
    expect(parseLoadtestOptions({})).toEqual({ requestsPerSec: 50, phaseDurationMs: 10_000, concurrency: 20 });
  });

  it("overrides each var independently", () => {
    expect(parseLoadtestOptions({ NBO_LOADTEST_RPS: "100" })).toMatchObject({ requestsPerSec: 100 });
    expect(parseLoadtestOptions({ NBO_LOADTEST_PHASE_DURATION: "5000" })).toMatchObject({ phaseDurationMs: 5000 });
    expect(parseLoadtestOptions({ NBO_LOADTEST_CONCURRENCY: "10" })).toMatchObject({ concurrency: 10 });
  });

  it("rejects an invalid value with a clear message instead of letting NaN propagate", () => {
    expect(() => parseLoadtestOptions({ NBO_LOADTEST_RPS: "not-a-number" })).toThrow(/NBO_LOADTEST_RPS/);
  });
});
