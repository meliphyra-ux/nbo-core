// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { normalizeRoute } from "../insights/route.js";

describe("normalizeRoute", () => {
  it("keeps plain paths", () => {
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("/blog/hello-world")).toBe("/blog/hello-world");
    expect(normalizeRoute("/docs/")).toBe("/docs/");
  });

  it("drops the query and hash", () => {
    expect(normalizeRoute("/search?q=secret#top")).toBe("/search");
  });

  it("collapses digits, UUIDs, long hex and 20+ character tokens", () => {
    expect(normalizeRoute("/users/12345/posts/7")).toBe("/users/[id]/posts/[id]");
    expect(normalizeRoute("/o/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("/o/[id]");
    expect(normalizeRoute("/c/deadbeefcafebabe1234")).toBe("/c/[id]");
    expect(normalizeRoute("/reset/aZ9_kQ2xLm8PpR4tYv0Wn")).toBe("/reset/[id]");
  });

  it("collapses segments that look like email addresses", () => {
    expect(normalizeRoute("/u/jane@example.com")).toBe("/u/[id]");
  });

  it("keeps long readable slugs without digits", () => {
    expect(normalizeRoute("/blog/how-to-deploy-on-kubernetes")).toBe("/blog/how-to-deploy-on-kubernetes");
  });

  it("returns undefined for something that is not a path", () => {
    expect(normalizeRoute("")).toBeUndefined();
    expect(normalizeRoute("https://evil/x")).toBeUndefined();
  });
});
