// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, expect, it } from "vitest";
import { defaultRunner } from "../cloud-teardown.js";

describe("teardown's default runner", () => {
  // Google commands run under a private CLOUDSDK_CONFIG: dropping env would
  // activate NBO's service account in the host's own gcloud config.
  it("passes env to the command", async () => {
    const out = await defaultRunner(process.execPath, ["-e", "console.log(process.env.NBO_TEARDOWN_TEST)"], {
      env: { NBO_TEARDOWN_TEST: "seen" },
    });
    expect(out.trim()).toBe("seen");
  });
});
