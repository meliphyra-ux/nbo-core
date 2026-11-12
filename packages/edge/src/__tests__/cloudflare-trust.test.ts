// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, expect, it } from "vitest";
import { createCloudflareTrust } from "../cloudflare-trust.js";

describe("createCloudflareTrust", () => {
  it("is empty before any replace", () => {
    expect(createCloudflareTrust().has("104.16.0.1")).toBe(false);
  });
  it("matches IPv4 ranges", () => {
    const t = createCloudflareTrust();
    t.replace(["104.16.0.0/13"]);
    expect(t.has("104.16.0.1")).toBe(true);
    expect(t.has("8.8.8.8")).toBe(false);
  });
  it("matches IPv6 ranges", () => {
    const t = createCloudflareTrust();
    t.replace(["2606:4700::/32"]);
    expect(t.has("2606:4700::1")).toBe(true);
    expect(t.has("2001:db8::1")).toBe(false);
  });
  it("is false for non-addresses and replace swaps the whole set", () => {
    const t = createCloudflareTrust();
    t.replace(["104.16.0.0/13"]);
    expect(t.has("not-an-ip")).toBe(false);
    t.replace([]);
    expect(t.has("104.16.0.1")).toBe(false);
  });
});
