// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { defineConfig } from "vitest/config";

// Finding (discovered adding cli-deploy-image.test.ts, final review's
// own C2 fix pass): this package now has two test files that each
// run a real `pnpm --filter "@nbo/cli..." build` — a real tsc
// compile that writes to shared dist/ directories across the whole
// monorepo, not anything scoped to this package. Vitest runs
// separate test files in separate worker processes by default;
// confirmed directly that two such files racing on the same `tsc`
// output produces a real TS5033 "file in use by another process"
// failure, not a flaky one. fileParallelism: false serializes this
// package's own test FILES (tests within a file already run
// sequentially by default) — the correct scope, since no other
// package's suite shares this hazard.
export default defineConfig({
  test: {
    globalSetup: ["../../test-support/temp-global-setup.mjs"],
    fileParallelism: false,
  },
});
