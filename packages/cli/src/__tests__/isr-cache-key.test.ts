// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { ISR_CACHE_KEY as serveKey } from "@nbo/serve";
import { ISR_CACHE_KEY as deployKey } from "@nbo/deploy";

// @nbo/deploy bakes the cache URL into /functions.json under its own
// copy of the key (it does not depend on @nbo/serve); the app server
// reads it under @nbo/serve's. The two must never drift apart.
describe("ISR_CACHE_KEY", () => {
  it("is the same in @nbo/deploy and @nbo/serve", () => {
    expect(deployKey).toBe(serveKey);
    expect(deployKey).toBe("__isrcache");
  });
});
