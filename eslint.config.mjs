// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { config as base } from "@repo/eslint-config/base";

export default [
  ...base,
  {
    // Generated or vendored: never hand-edited.
    // edge-rs/assets is a minified browser bundle (web-vitals) served byte for byte.
    // fixtures/ are test inputs (real Next/Vite apps with their own configs).
    // The lint script names the folders it checks, so anything outside the
    // workspace is never linted.
    ignores: ["spec/generated/**", "fixtures/**", "packages/edge-rs/assets/**"],
  },
];
