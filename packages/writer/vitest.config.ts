// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Per-run temp folder, removed afterwards (tests create many with mkdtemp).
    globalSetup: ["../../test-support/temp-global-setup.mjs"],
  },
});
