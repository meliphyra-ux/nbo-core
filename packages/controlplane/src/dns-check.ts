// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// DNS checks for domains (spec A5): does a host point at the public edge?
import { Resolver as DnsResolver } from "node:dns/promises";
import { isIP } from "node:net";

export interface Resolver {
  resolve4(h: string): Promise<string[]>;
  resolve6(h: string): Promise<string[]>;
  resolveCname(h: string): Promise<string[]>;
}

const maxCnameHops = 8;

const norm = (h: string): string => {
  const l = h.trim().toLowerCase();
  return l.endsWith(".") ? l.slice(0, -1) : l;
};

// createResolver is NBO's own resolver: 5 s per lookup, one try; a name
// with no records of the asked type (ENOTFOUND/ENODATA) is an empty list.
export function createResolver(): Resolver {
  const r = new DnsResolver({ timeout: 5_000, tries: 1 });
  const empty = async (p: Promise<string[]>): Promise<string[]> => {
    try {
      return await p;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOTFOUND" || code === "ENODATA") return [];
      throw err;
    }
  };
  return {
    resolve4: (h) => empty(r.resolve4(h)),
    resolve6: (h) => empty(r.resolve6(h)),
    resolveCname: (h) => empty(r.resolveCname(h)),
  };
}

// dnsPointsAtEdge: sslip.io hosts pass (the name is the address); an IP
// edge needs an A/AAAA record equal to it; a hostname edge needs the
// host's CNAME chain (at most 8 hops) to reach it, or the host's A records
// to equal the edge hostname's. found says what DNS answered.
export async function dnsPointsAtEdge(host: string, edgeAddress: string, r: Resolver): Promise<{ ok: boolean; found: string }> {
  const h = norm(host);
  if (h.endsWith(".sslip.io")) return { ok: true, found: h };
  const edge = norm(edgeAddress.replace(/^\[(.*)\]$/, "$1"));
  const family = isIP(edge);
  if (family !== 0) {
    const records = family === 4 ? await r.resolve4(h) : await r.resolve6(h);
    const all = family === 4 ? [...records, ...(await r.resolve6(h))] : [...(await r.resolve4(h)), ...records];
    const ok = records.some((a) => a.toLowerCase() === edge || (family === 6 && sameV6(a, edge)));
    return { ok, found: all.join(", ") };
  }

  const chain = [h];
  let current = h;
  for (let hop = 0; hop < maxCnameHops; hop++) {
    const next = (await r.resolveCname(current))[0];
    if (next === undefined) break;
    current = norm(next);
    chain.push(current);
    if (current === edge) return { ok: true, found: chain.join(" → ") };
  }
  const mine = (await r.resolve4(h)).slice().sort();
  const theirs = (await r.resolve4(edge)).slice().sort();
  const ok = mine.length > 0 && mine.length === theirs.length && mine.every((a, i) => a === theirs[i]);
  const found = chain.length > 1 ? `${chain.join(" → ")}${mine.length > 0 ? ` (${mine.join(", ")})` : ""}` : mine.join(", ");
  return { ok, found };
}

// sameV6 compares two IPv6 addresses by value (2001:db8::1 = 2001:0db8:0:0:0:0:0:1).
function sameV6(a: string, b: string): boolean {
  const expand = (s: string): string | null => {
    const lower = s.toLowerCase();
    if (isIP(lower) !== 6 || lower.includes(".")) return null;
    const [head, tail] = lower.split("::") as [string, string | undefined];
    const left = head === "" ? [] : head.split(":");
    const right = tail === undefined || tail === "" ? [] : tail.split(":");
    const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
    return [...left, ...fill, ...right].map((p) => p.padStart(4, "0")).join(":");
  };
  const x = expand(a);
  return x !== null && x === expand(b);
}
