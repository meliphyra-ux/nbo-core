// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import type { PrerenderConfig } from "../serve.js";

const spied = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spied.calls++;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { secretEquals } = await import("../secret-equals.js");
const { isDraftMode } = await import("../prerender-cache.js");

afterEach(() => {
  spied.calls = 0;
  delete process.env.TEST_DRAFT_BYPASS;
});

describe("secretEquals", () => {
  it("is true only for the same string, whatever the lengths", () => {
    expect(secretEquals("secret-bypass", "secret-bypass")).toBe(true);
    expect(secretEquals("secret-bypasx", "secret-bypass")).toBe(false);
    expect(secretEquals("short", "secret-bypass")).toBe(false);
    expect(secretEquals("", "secret-bypass")).toBe(false);
    expect(secretEquals("é", "e")).toBe(false);
  });

  it("compares in constant time (sha256 digests through timingSafeEqual)", () => {
    secretEquals("a", "a much longer value");
    expect(spied.calls).toBe(1);
  });
});

describe("isDraftMode", () => {
  const cfg = { bypassToken: { env: "TEST_DRAFT_BYPASS" } } as PrerenderConfig;
  const req = (cookie: string) => new Request("http://x/", { headers: { cookie } });

  it("matches the bypass cookie through the constant-time compare", () => {
    process.env.TEST_DRAFT_BYPASS = "draft-secret";
    expect(isDraftMode(req("a=1; __nbo_bypass=draft-secret"), cfg)).toBe(true);
    expect(spied.calls).toBe(1);
    expect(isDraftMode(req("__nbo_bypass=draft-secrex"), cfg)).toBe(false);
    expect(isDraftMode(req("__nbo_bypass=x"), cfg)).toBe(false);
    expect(isDraftMode(req("__nbo_bypass="), cfg)).toBe(false);
  });

  it("is false with no token configured, without comparing", () => {
    expect(isDraftMode(req("__nbo_bypass=anything"), cfg)).toBe(false);
    expect(spied.calls).toBe(0);
  });
});
