// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Backend, InsightsSettings, RelayVia } from "./registry.js";
import { normalizeHost } from "./registry.js";
import { isIP } from "node:net";

export type { RelayVia } from "./registry.js";
export { normalizeHost } from "./registry.js";

// RouteTable is the whole public-edge configuration, replaced atomically.
export interface RouteTable {
  version: 1;
  targets: Record<
    string,
    { backends: Backend[]; insights?: InsightsSettings; tls?: string; redirectHttps?: boolean; cloudflare?: boolean }
  >;
  challenges: Record<string, string>;
  // cloudflareRanges are the addresses Cloudflare connects from (IPv4 and IPv6 CIDRs).
  cloudflareRanges?: string[];
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((k) => allowed.has(k));
}

const insightsKeys = new Set(["enabled", "inject", "sampleRate"]);
const sampleRates = new Set([100, 50, 25, 10]);

// parseInsightsSettings validates an insights object; undefined passes through.
export function parseInsightsSettings(raw: unknown): InsightsSettings | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, insightsKeys) ||
    typeof raw.enabled !== "boolean" ||
    typeof raw.inject !== "boolean" ||
    typeof raw.sampleRate !== "number" ||
    !sampleRates.has(raw.sampleRate)
  ) {
    return "invalid";
  }
  return { enabled: raw.enabled, inject: raw.inject, sampleRate: raw.sampleRate as InsightsSettings["sampleRate"] };
}

const backendKeys = new Set(["id", "url", "weight", "insecureSkipVerify"]);
const backendKeysWithVia = new Set([...backendKeys, "via"]);
const viaKeys = new Set(["url", "caPem", "token"]);

function parseVia(raw: unknown): RelayVia | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, viaKeys)) return null;
  if (typeof raw.url !== "string" || typeof raw.caPem !== "string" || typeof raw.token !== "string") return null;
  if (raw.caPem === "" || raw.token === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.host === "") return null;
  return { url: raw.url, caPem: raw.caPem, token: raw.token };
}

// parseBackend is the one backend validator, shared by the admin API (no
// via) and the route table (via allowed). Returns null when invalid.
export function parseBackend(raw: unknown, allowVia: boolean, seenIds: Set<string>): Backend | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, allowVia ? backendKeysWithVia : backendKeys)) return null;
  if (typeof raw.url !== "string" || typeof raw.weight !== "number" || !Number.isInteger(raw.weight)) return null;
  // A real JSON boolean only: the string "false" must not turn into true.
  if (raw.insecureSkipVerify !== undefined && typeof raw.insecureSkipVerify !== "boolean") return null;
  // id: the backend's stable key for sticky visitors, non-empty and unique within the target.
  if (raw.id !== undefined && (typeof raw.id !== "string" || raw.id === "" || seenIds.has(raw.id))) return null;
  let via: RelayVia | undefined;
  if (raw.via !== undefined) {
    const parsed = parseVia(raw.via);
    if (!parsed) return null;
    via = parsed;
  }
  if (typeof raw.id === "string") seenIds.add(raw.id);
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    url: raw.url,
    weight: raw.weight,
    insecureSkipVerify: raw.insecureSkipVerify === true,
    ...(via ? { via } : {}),
  };
}

const tableKeys = new Set(["version", "targets", "challenges", "cloudflareRanges"]);
const targetKeys = new Set(["backends", "insights", "tls", "redirectHttps", "cloudflare"]);
const tokenRe = /^[A-Za-z0-9_-]{1,128}$/;

// parseRouteTable parses and validates a route table document, throwing an
// Error that names the first bad field.
export function parseRouteTable(json: string): RouteTable {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    throw new Error(`route table: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(doc)) throw new Error("route table: must be an object");
  for (const k of Object.keys(doc)) {
    if (!tableKeys.has(k)) throw new Error(`route table: unknown field ${JSON.stringify(k)}`);
  }
  if (doc.version !== 1) throw new Error("route table: version must be 1");
  if (!isRecord(doc.targets)) throw new Error("route table: targets must be an object");
  // Null-prototype maps: "__proto__" and "constructor" are ordinary keys.
  const targets: RouteTable["targets"] = Object.create(null);
  for (const [rawHost, rawTarget] of Object.entries(doc.targets)) {
    const where = `targets[${JSON.stringify(rawHost)}]`;
    const host = normalizeHost(rawHost);
    if (host === "") throw new Error(`route table: ${where} has an empty host`);
    if (host in targets) throw new Error(`route table: ${where} duplicates host ${JSON.stringify(host)}`);
    if (!isRecord(rawTarget)) throw new Error(`route table: ${where} must be an object`);
    for (const k of Object.keys(rawTarget)) {
      if (!targetKeys.has(k)) throw new Error(`route table: ${where} has unknown field ${JSON.stringify(k)}`);
    }
    if (!Array.isArray(rawTarget.backends)) throw new Error(`route table: ${where}.backends must be an array`);
    const seenIds = new Set<string>();
    const backends: Backend[] = [];
    rawTarget.backends.forEach((rawBackend, i) => {
      const b = parseBackend(rawBackend, true, seenIds);
      if (!b) throw new Error(`route table: ${where}.backends[${i}] is invalid`);
      backends.push(b);
    });
    const insights = parseInsightsSettings(rawTarget.insights);
    if (insights === "invalid") throw new Error(`route table: ${where}.insights is invalid`);
    if (rawTarget.tls !== undefined && (typeof rawTarget.tls !== "string" || rawTarget.tls === "")) {
      throw new Error(`route table: ${where}.tls must be a non-empty string`);
    }
    if (rawTarget.redirectHttps !== undefined && typeof rawTarget.redirectHttps !== "boolean") {
      throw new Error(`route table: ${where}.redirectHttps must be a boolean`);
    }
    if (rawTarget.cloudflare !== undefined && typeof rawTarget.cloudflare !== "boolean") {
      throw new Error(`route table: ${where}.cloudflare must be a boolean`);
    }
    targets[host] = {
      backends,
      ...(insights ? { insights } : {}),
      ...(rawTarget.tls !== undefined ? { tls: rawTarget.tls as string } : {}),
      ...(rawTarget.redirectHttps !== undefined ? { redirectHttps: rawTarget.redirectHttps as boolean } : {}),
      ...(rawTarget.cloudflare !== undefined ? { cloudflare: rawTarget.cloudflare as boolean } : {}),
    };
  }
  const challenges: Record<string, string> = Object.create(null);
  if (doc.challenges !== undefined) {
    if (!isRecord(doc.challenges)) throw new Error("route table: challenges must be an object");
    for (const [token, value] of Object.entries(doc.challenges)) {
      if (!tokenRe.test(token)) throw new Error(`route table: challenges token ${JSON.stringify(token)} is invalid`);
      if (typeof value !== "string") throw new Error(`route table: challenges[${JSON.stringify(token)}] must be a string`);
      challenges[token] = value;
    }
  }
  let cloudflareRanges: string[] | undefined;
  if (doc.cloudflareRanges !== undefined) {
    if (!Array.isArray(doc.cloudflareRanges)) throw new Error("route table: cloudflareRanges must be an array");
    doc.cloudflareRanges.forEach((c, i) => {
      if (!isCidr(c)) throw new Error(`route table: cloudflareRanges[${i}] is not a CIDR`);
    });
    cloudflareRanges = doc.cloudflareRanges as string[];
  }
  return { version: 1, targets, challenges, ...(cloudflareRanges ? { cloudflareRanges } : {}) };
}

function isCidr(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = /^([^/]+)\/(\d{1,3})$/.exec(v);
  if (!m) return false;
  const family = isIP(m[1]!);
  return family !== 0 && Number(m[2]) <= (family === 4 ? 32 : 128);
}
