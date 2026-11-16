// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { promises as dns, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

// The image optimizer fetches remote sources the build's remotePatterns
// allow. A source may redirect, and a hostname may resolve anywhere, so each
// hop is checked again: the URL against remotePatterns, and every address the
// hostname resolves to against the ranges below. The request then connects
// to the address that was checked (no second DNS lookup between the check and
// the connection), with the hostname kept as Host and TLS server name.

export const maxImageRedirects = 3;

// ResolveHost returns every address of a hostname (dns.lookup with all).
export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

// RemoteImageDeps replaces DNS and, in tests only, where a checked address is
// really dialled (a fake server on loopback stands in for a public address).
export interface RemoteImageDeps {
  resolve?: ResolveHost;
  dial?: (address: string, port: number) => { address: string; port: number };
}

const defaultResolve: ResolveHost = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // unspecified and "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4], // multicast
  ["192.0.0.0", 24], // IETF protocol assignments
  ["198.18.0.0", 15], // benchmarking
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // old site-local
  ["ff00::", 8], // multicast
  ["64:ff9b:1::", 48], // local-use NAT64
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

// ipv6Bytes expands an IPv6 literal (with "::", a trailing dotted IPv4 part
// or a zone) to its 16 bytes, or undefined when it doesn't parse.
function ipv6Bytes(literal: string): number[] | undefined {
  let s = literal.split("%")[0]!;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return undefined;
    tail.push(...dotted[1]!.split(".").map(Number));
    s = s.slice(0, -dotted[1]!.length) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => parseInt(h, 16)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (dotted) bytes.splice(12, 4, ...tail);
  return bytes;
}

// isBlockedAddress says whether an address is one a remote image may never
// come from: loopback, private, link-local, CGNAT, unspecified, multicast,
// unique local, benchmarking and protocol-assignment ranges, local-use NAT64,
// and the IPv4-mapped, IPv4-compatible, NAT64 and 6to4 forms of the IPv4
// ranges. Anything that isn't an IP literal is blocked too.
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address.split("%")[0]!);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  const embedsIPv4 =
    (zeros(0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) ||
    // 64:ff9b::/96, NAT64
    (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12));
  if (embedsIPv4 && !zeros(0, 16) && !(zeros(0, 15) && bytes[15] === 1)) {
    return blocked.check(bytes.slice(12).join("."), "ipv4");
  }
  // 2002::/16, 6to4: the IPv4 address is the next 32 bits.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return blocked.check(bytes.slice(2, 6).join("."), "ipv4");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return blocked.check(groups.join(":"), "ipv6");
}

// RemoteImageRefused is a refusal whose detail is for the log only.
export class RemoteImageRefused extends Error {}

interface Hop {
  status: number;
  location?: string;
  contentType: string;
  response: http.IncomingMessage;
}

function requestPinned(url: URL, address: string, family: number, deps: RemoteImageDeps, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const target = deps.dial ? deps.dial(address, port) : { address, port };
  const dialFamily = isIP(target.address) || family;
  const options: https.RequestOptions = {
    method: "GET",
    host: hostname,
    port: target.port,
    path: `${url.pathname}${url.search}`,
    headers: { host: url.host, accept: "image/*", "accept-encoding": "identity" },
    signal,
    // The one address that was checked; never a second DNS answer.
    lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      if (opts?.all) cb(null, [{ address: target.address, family: dialFamily }]);
      else cb(null, target.address, dialFamily);
    }) as unknown as https.RequestOptions["lookup"],
    agent: false,
  };
  if (url.protocol === "https:" && isIP(hostname) === 0) options.servername = hostname;
  const send = url.protocol === "https:" ? https.request : http.request;
  return new Promise<Hop>((resolve, reject) => {
    const req = send(options, (response) => {
      const location = response.headers.location;
      resolve({
        status: response.statusCode ?? 0,
        location: typeof location === "string" ? location : undefined,
        contentType: String(response.headers["content-type"] ?? ""),
        response,
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function readCapped(response: http.IncomingMessage, cap: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const all = Buffer.concat(chunks);
      resolve(new Uint8Array(all.subarray(0, Math.min(all.length, cap))));
    };
    response.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      // Truncate rather than read further; a truncated image fails to decode.
      if (total > cap) {
        finish();
        response.destroy();
      }
    });
    response.on("end", finish);
    response.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

// fetchRemoteImage fetches startURL (already matched against remotePatterns
// by the caller) following at most maxImageRedirects redirects. It throws
// RemoteImageRefused (or a network error) for anything it won't serve.
export async function fetchRemoteImage(
  startURL: URL,
  allowed: (url: URL) => boolean,
  opts: { timeoutMs: number; cap: number; deps?: RemoteImageDeps },
): Promise<Uint8Array> {
  const deps = opts.deps ?? {};
  const resolve = deps.resolve ?? defaultResolve;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = startURL;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new RemoteImageRefused(`scheme ${url.protocol} is not fetched`);
    }
    if (!allowed(url)) throw new RemoteImageRefused(`${url.href} matches no remote pattern`);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(hostname);
    const addresses = family !== 0 ? [{ address: hostname, family }] : await resolve(hostname);
    if (addresses.length === 0) throw new RemoteImageRefused(`${hostname} has no address`);
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) throw new RemoteImageRefused(`${hostname} resolves to the refused address ${bad.address}`);
    const first = addresses[0]!;

    const res = await requestPinned(url, first.address, first.family, deps, signal);
    if (redirectStatuses.has(res.status)) {
      res.response.destroy();
      if (!res.location) throw new RemoteImageRefused(`${url.href} redirected without a location`);
      if (hop >= maxImageRedirects) throw new RemoteImageRefused(`more than ${maxImageRedirects} redirects`);
      url = new URL(res.location, url);
      continue;
    }
    if (res.status < 200 || res.status > 299) {
      res.response.destroy();
      throw new RemoteImageRefused(`${url.href} answered ${res.status}`);
    }
    if (!/^image\//i.test(res.contentType.trim())) {
      res.response.destroy();
      throw new RemoteImageRefused(`${url.href} answered content type "${res.contentType}", not image/*`);
    }
    return readCapped(res.response, opts.cap);
  }
}
