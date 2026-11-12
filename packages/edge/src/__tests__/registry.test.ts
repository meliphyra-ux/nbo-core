// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createRegistry, pick, type Target } from "../registry.js";

describe("pick", () => {
  it("never picks a zero-weight backend", () => {
    const target: Target = {
      host: "app.test",
      backends: [
        { url: "https://zero", weight: 0, insecureSkipVerify: false },
        { url: "https://hundred", weight: 100, insecureSkipVerify: false },
      ],
    };
    for (let i = 0; i < 1000; i++) {
      expect(pick(target).url).not.toBe("https://zero");
    }
  });

  it("distributes roughly by weight", () => {
    const target: Target = {
      host: "app.test",
      backends: [
        { url: "https://a", weight: 90, insecureSkipVerify: false },
        { url: "https://b", weight: 10, insecureSkipVerify: false },
      ],
    };
    const counts: Record<string, number> = {};
    const n = 10000;
    for (let i = 0; i < n; i++) {
      const b = pick(target);
      counts[b.url] = (counts[b.url] ?? 0) + 1;
    }
    const aCount = counts["https://a"] ?? 0;
    expect(aCount).toBeGreaterThan((n * 80) / 100);
    expect(aCount).toBeLessThan((n * 98) / 100);
  });

  it("errors when the target has no backends", () => {
    const target: Target = { host: "app.test", backends: [] };
    expect(() => pick(target)).toThrow();
  });
});

describe("Registry", () => {
  it("set then get round-trips", () => {
    const r = createRegistry();
    r.set("app.test", [{ url: "https://a", weight: 1, insecureSkipVerify: false }]);
    const target = r.get("app.test");
    expect(target?.backends).toHaveLength(1);
  });

  it("get on an unknown host returns undefined", () => {
    const r = createRegistry();
    expect(r.get("nope.test")).toBeUndefined();
  });

  it("set rejects a negative weight", () => {
    const r = createRegistry();
    expect(() => r.set("app.test", [{ url: "https://a", weight: -1, insecureSkipVerify: false }])).toThrow();
  });

  it("set rejects an all-zero-weight configuration", () => {
    const r = createRegistry();
    expect(() =>
      r.set("app.test", [
        { url: "https://a", weight: 0, insecureSkipVerify: false },
        { url: "https://b", weight: 0, insecureSkipVerify: false },
      ]),
    ).toThrow();
  });

  it("get matches a host that includes a port and different case than what was set", () => {
    const r = createRegistry();
    r.set("App.Test", [{ url: "https://a", weight: 1, insecureSkipVerify: false }]);
    expect(r.get("app.test:9443")).toBeDefined();
  });

  it("set rejects a backend URL with no scheme", () => {
    const r = createRegistry();
    expect(() => r.set("app.test", [{ url: "edge-next-app.127.0.0.1.sslip.io", weight: 1, insecureSkipVerify: false }])).toThrow();
  });
});
