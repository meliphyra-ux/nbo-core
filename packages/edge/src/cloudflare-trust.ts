// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { BlockList, isIP } from "node:net";

// CloudflareTrust holds the address ranges Cloudflare connects from. The
// edge believes cf-connecting-ip only when the socket peer is in them.
export interface CloudflareTrust {
  replace(cidrs: string[]): void;
  has(ip: string): boolean;
}

export function createCloudflareTrust(): CloudflareTrust {
  let list = new BlockList();
  return {
    replace(cidrs) {
      const next = new BlockList();
      for (const cidr of cidrs) {
        const slash = cidr.indexOf("/");
        if (slash < 0) continue;
        const family = isIP(cidr.slice(0, slash));
        const prefix = Number(cidr.slice(slash + 1));
        if (family === 0 || !Number.isInteger(prefix)) continue;
        try {
          next.addSubnet(cidr.slice(0, slash), prefix, family === 4 ? "ipv4" : "ipv6");
        } catch {
          // an invalid range is skipped; parseRouteTable already rejects them
        }
      }
      list = next;
    },
    has(ip) {
      const family = isIP(ip);
      if (family === 0) return false;
      return list.check(ip, family === 4 ? "ipv4" : "ipv6");
    },
  };
}
