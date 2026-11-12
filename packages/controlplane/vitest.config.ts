// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../../test-support/temp-global-setup.mjs"],
    // Many tests run real git clones, builds and loopback servers; under
    // full-repo parallel load that exceeds vitest's 5s default.
    testTimeout: 20_000,
  },
});
