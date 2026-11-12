// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { dnsPointsAtEdge, type Resolver } from "../dns-check.js";

// fakeResolver answers from fixed record maps; a missing name has no records.
function fakeResolver(records: { a?: Record<string, string[]>; aaaa?: Record<string, string[]>; cname?: Record<string, string[]> }) {
  const calls: string[] = [];
  const r: Resolver = {
    async resolve4(h) {
      calls.push(`A ${h}`);
      return records.a?.[h] ?? [];
    },
    async resolve6(h) {
      calls.push(`AAAA ${h}`);
      return records.aaaa?.[h] ?? [];
    },
    async resolveCname(h) {
      calls.push(`CNAME ${h}`);
      return records.cname?.[h] ?? [];
    },
  };
  return { r, calls };
}

describe("dnsPointsAtEdge", () => {
  it("passes sslip.io hosts without asking DNS", async () => {
    const { r, calls } = fakeResolver({});
    expect((await dnsPointsAtEdge("shop.34-1-2-3.sslip.io", "34.1.2.3", r)).ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it("passes when an A record is the edge's IPv4 address", async () => {
    const { r } = fakeResolver({ a: { "shop.example.com": ["10.0.0.9", "34.1.2.3"] } });
    expect(await dnsPointsAtEdge("shop.example.com", "34.1.2.3", r)).toEqual({ ok: true, found: "10.0.0.9, 34.1.2.3" });
  });

  it("fails on an A mismatch and reports the addresses it found", async () => {
    const { r } = fakeResolver({ a: { "shop.example.com": ["5.6.7.8"] } });
    expect(await dnsPointsAtEdge("shop.example.com", "34.1.2.3", r)).toEqual({ ok: false, found: "5.6.7.8" });
  });

  it("reports nothing found when there are no records", async () => {
    const { r } = fakeResolver({});
    expect(await dnsPointsAtEdge("shop.example.com", "34.1.2.3", r)).toEqual({ ok: false, found: "" });
  });

  it("checks AAAA records for an IPv6 edge (brackets and case ignored)", async () => {
    const { r } = fakeResolver({ aaaa: { "shop.example.com": ["2001:DB8::1"] } });
    expect((await dnsPointsAtEdge("shop.example.com", "[2001:db8::1]", r)).ok).toBe(true);
  });

  it("follows a CNAME chain to a hostname edge", async () => {
    const { r } = fakeResolver({
      cname: { "www.shop.com": ["shop.cdn.example.net."], "shop.cdn.example.net": ["lb-123.elb.example.com"] },
    });
    expect(await dnsPointsAtEdge("www.shop.com", "LB-123.elb.example.com", r)).toEqual({ ok: true, found: "www.shop.com → shop.cdn.example.net → lb-123.elb.example.com" });
  });

  it("passes a hostname edge when the host's A records equal the edge hostname's", async () => {
    const { r } = fakeResolver({ a: { "shop.com": ["9.9.9.2", "9.9.9.1"], "lb.example.com": ["9.9.9.1", "9.9.9.2"] } });
    expect((await dnsPointsAtEdge("shop.com", "lb.example.com", r)).ok).toBe(true);
  });

  it("fails a hostname edge when A records differ", async () => {
    const { r } = fakeResolver({ a: { "shop.com": ["9.9.9.3"], "lb.example.com": ["9.9.9.1"] } });
    expect(await dnsPointsAtEdge("shop.com", "lb.example.com", r)).toEqual({ ok: false, found: "9.9.9.3" });
  });

  it("stops following a CNAME loop after 8 hops", async () => {
    const { r, calls } = fakeResolver({ cname: { "a.com": ["b.com"], "b.com": ["a.com"] } });
    const res = await dnsPointsAtEdge("a.com", "lb.example.com", r);
    expect(res.ok).toBe(false);
    expect(calls.filter((c) => c.startsWith("CNAME"))).toHaveLength(8);
  });
});
