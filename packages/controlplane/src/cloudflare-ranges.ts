// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { BlockList, isIPv4, isIPv6 } from "node:net";
import type { Store } from "./store.js";

// Cloudflare's published address ranges, read from
// https://api.cloudflare.com/client/v4/ips on 2026-11-06.
export const bundledCloudflareRanges: string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const ipsUrl = "https://api.cloudflare.com/client/v4/ips";
// The edge trusts any CIDR it is handed, so these floors are the only
// defence against a list that would make every visitor "Cloudflare".
const minV4Prefix = 10;
const minV6Prefix = 24;
const maxEntries = 200;

export interface CloudflareRanges {
  current(): string[];
  refresh(): Promise<boolean>;
  isCloudflare(ip: string): boolean;
}

// parseCidr returns [address, prefix] for a strictly valid CIDR of the
// given family that is not wider than the floor, else undefined.
function parseCidr(entry: unknown, family: 4 | 6): [string, number] | undefined {
  if (typeof entry !== "string") return undefined;
  const m = /^([^/]+)\/(\d{1,3})$/.exec(entry);
  if (!m) return undefined;
  const addr = m[1]!;
  const prefix = Number(m[2]);
  if (family === 4) {
    if (!isIPv4(addr) || prefix < minV4Prefix || prefix > 32) return undefined;
  } else {
    if (!isIPv6(addr) || prefix < minV6Prefix || prefix > 128) return undefined;
    // Global unicast only (2000::/3). BlockList would otherwise let ::/24 or
    // ::ffff:0.0.0.0/96 match every IPv4 address.
    const first = addr.split(":")[0]!;
    const hextet = first === "" ? 0 : parseInt(first, 16);
    if (!(hextet >= 0x2000 && hextet <= 0x3fff)) return undefined;
  }
  return [addr, prefix];
}

const familyOf = (e: string): 4 | 6 => (e.includes(":") ? 6 : 4);

// validateList returns the list when every entry is a valid CIDR within
// the width floors; otherwise undefined.
function validateList(list: unknown): string[] | undefined {
  if (!Array.isArray(list) || list.length === 0 || list.length > maxEntries) return undefined;
  for (const e of list) {
    if (typeof e !== "string" || !parseCidr(e, familyOf(e))) return undefined;
  }
  return list as string[];
}

function buildMatcher(list: string[]): BlockList {
  const bl = new BlockList();
  for (const e of list) {
    const fam = familyOf(e);
    const [addr, prefix] = parseCidr(e, fam)!;
    bl.addSubnet(addr, prefix, fam === 4 ? "ipv4" : "ipv6");
  }
  return bl;
}

export function createCloudflareRanges(deps: { store: Store; fetch?: typeof fetch; now?: () => Date }): CloudflareRanges {
  const doFetch = deps.fetch ?? fetch;
  const load = (): string[] => {
    const raw = deps.store.getServerSettings().cloudflareRanges;
    if (raw === "") return bundledCloudflareRanges;
    try {
      return validateList(JSON.parse(raw)) ?? bundledCloudflareRanges;
    } catch {
      return bundledCloudflareRanges;
    }
  };
  let list = load();
  let matcher = buildMatcher(list);

  return {
    current: () => [...list],
    isCloudflare(ip: string): boolean {
      const v = isIPv4(ip) ? "ipv4" : isIPv6(ip) ? "ipv6" : undefined;
      if (v === undefined) return false;
      try {
        return matcher.check(ip, v);
      } catch {
        return false;
      }
    },
    async refresh(): Promise<boolean> {
      let body: unknown;
      try {
        const res = await doFetch(ipsUrl, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return false;
        body = await res.json();
      } catch {
        return false;
      }
      if (typeof body !== "object" || body === null) return false;
      const b = body as { success?: unknown; result?: { ipv4_cidrs?: unknown; ipv6_cidrs?: unknown } };
      if (b.success !== true || typeof b.result !== "object" || b.result === null) return false;
      const v4 = b.result.ipv4_cidrs;
      const v6 = b.result.ipv6_cidrs;
      if (!Array.isArray(v4) || !Array.isArray(v6) || v4.length === 0 || v6.length === 0) return false;
      if (!v4.every((e) => parseCidr(e, 4)) || !v6.every((e) => parseCidr(e, 6))) return false;
      const next = validateList([...v4, ...v6]);
      if (!next) return false;
      if (JSON.stringify(next) === JSON.stringify(list)) return false;
      deps.store.updateServerSettings({ cloudflareRanges: JSON.stringify(next) });
      list = next;
      matcher = buildMatcher(list);
      return true;
    },
  };
}
