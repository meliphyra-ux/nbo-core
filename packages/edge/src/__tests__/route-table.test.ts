// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, expect, it } from "vitest";
import { createRegistry } from "../registry.js";
import { parseRouteTable } from "../route-table.js";

const via = { url: "https://relay.example:8443", caPem: "PEM", token: "t" };
const valid = {
  version: 1,
  targets: {
    "Shop.Acme.COM.": {
      backends: [{ id: "a", url: "http://10.0.0.1", weight: 100, insecureSkipVerify: false, via }],
      insights: { enabled: true, inject: true, sampleRate: 100 },
      tls: "shop-tls",
      redirectHttps: true,
    },
  },
  challenges: { "tok-1_A": "tok-1_A.keyauth" },
};
const parse = (o: unknown) => parseRouteTable(JSON.stringify(o));

describe("parseRouteTable", () => {
  it("accepts a full valid table and normalises hosts", () => {
    const t = parse(valid);
    expect(Object.keys(t.targets)).toEqual(["shop.acme.com"]);
    expect(t.targets["shop.acme.com"]!.backends[0]!.via).toEqual(via);
    expect(t.targets["shop.acme.com"]!.tls).toBe("shop-tls");
    expect(t.challenges["tok-1_A"]).toBe("tok-1_A.keyauth");
  });
  it("rejects version 2", () => {
    expect(() => parse({ ...valid, version: 2 })).toThrow(/version/);
  });
  it("rejects an unknown key in a target", () => {
    expect(() => parse({ ...valid, targets: { "a.com": { backends: [], extra: 1 } } })).toThrow(/extra/);
  });
  it("rejects a non-https via.url", () => {
    const bad = {
      ...valid,
      targets: { "a.com": { backends: [{ url: "http://x", weight: 1, via: { ...via, url: "http://r" } }] } },
    };
    expect(() => parse(bad)).toThrow(/backends\[0\]/);
  });
  it("rejects a challenge token with a slash", () => {
    expect(() => parse({ ...valid, challenges: { "a/b": "x" } })).toThrow(/challenges/);
  });
});

describe("Registry.replaceAll", () => {
  it("keeps the previous targets when one is invalid", () => {
    const r = createRegistry();
    r.set("old.com", [{ url: "http://1.1.1.1", weight: 1, insecureSkipVerify: false }]);
    expect(() =>
      r.replaceAll({
        "new.com": { backends: [{ url: "http://2.2.2.2", weight: 1, insecureSkipVerify: false }] },
        "bad.com": { backends: [{ url: "http://3.3.3.3", weight: -1, insecureSkipVerify: false }] },
      }),
    ).toThrow();
    expect(r.get("old.com")).toBeDefined();
    expect(r.get("new.com")).toBeUndefined();
  });
  it("swaps the table and stores tls/redirectHttps; get ignores case and trailing dot", () => {
    const r = createRegistry();
    r.set("old.com", [{ url: "http://1.1.1.1", weight: 1, insecureSkipVerify: false }]);
    r.replaceAll(parse(valid).targets);
    expect(r.get("old.com")).toBeUndefined();
    const t = r.get("SHOP.acme.com.");
    expect(t?.host).toBe("shop.acme.com");
    expect(t?.tls).toBe("shop-tls");
    expect(t?.redirectHttps).toBe(true);
  });
});

describe("route table key hygiene", () => {
  const b = [{ url: "http://1.1.1.1", weight: 1 }];
  it("rejects hosts that normalise to the same key", () => {
    expect(() => parse({ version: 1, targets: { "A.com": { backends: b }, "a.com.": { backends: b } } })).toThrow(
      /a\.com/,
    );
  });
  it("replaceAll rejects duplicate normalised hosts", () => {
    const r = createRegistry();
    const be = [{ url: "http://1.1.1.1", weight: 1, insecureSkipVerify: false }];
    expect(() => r.replaceAll({ "A.com": { backends: be }, "a.com": { backends: be } })).toThrow(/a\.com/);
  });
  it("keeps a __proto__ host as own data", () => {
    const t = parse({
      version: 1,
      targets: JSON.parse('{"__proto__":{"backends":[{"url":"http://1.1.1.1","weight":1}]}}'),
    });
    expect(Object.keys(t.targets)).toEqual(["__proto__"]);
  });
  it("treats constructor as a plain challenge token", () => {
    const t = parse({ version: 1, targets: {}, challenges: { constructor: "x" } });
    expect(t.challenges["constructor"]).toBe("x");
    expect(t.challenges["toString"]).toBeUndefined();
    expect(Object.keys(t.challenges)).toEqual(["constructor"]);
  });
});

describe("parseRouteTable cloudflare", () => {
  const withTarget = (extra: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
    version: 1,
    targets: { "a.test": { backends: [{ url: "http://10.0.0.1", weight: 1 }], ...extra } },
    ...top,
  });
  it("accepts cloudflare and cloudflareRanges", () => {
    const t = parse(withTarget({ cloudflare: true }, { cloudflareRanges: ["104.16.0.0/13", "2606:4700::/32"] }));
    expect(t.targets["a.test"]!.cloudflare).toBe(true);
    expect(t.cloudflareRanges).toEqual(["104.16.0.0/13", "2606:4700::/32"]);
  });
  it("rejects a non-boolean cloudflare", () => {
    expect(() => parse(withTarget({ cloudflare: "yes" }))).toThrow(/cloudflare/);
  });
  it("rejects bad cloudflareRanges", () => {
    expect(() => parse(withTarget({}, { cloudflareRanges: "x" }))).toThrow(/cloudflareRanges/);
    expect(() => parse(withTarget({}, { cloudflareRanges: ["nope"] }))).toThrow(/cloudflareRanges/);
    expect(() => parse(withTarget({}, { cloudflareRanges: ["10.0.0.0/99"] }))).toThrow(/cloudflareRanges/);
  });
});
