// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { RouteTable } from "./route-table.js";

// Backend is one possible destination for a Target's traffic.
// insecureSkipVerify is an explicit, per-backend opt-in — never a global
// setting — for backends whose TLS cert is self-signed (the local kind
// cluster's cert-manager selfsigned-issuer); a backend that doesn't set
// it is verified normally — port of Backend (registry.go lines 12-21).
export interface Backend {
  // id is the backend's stable key for keeping visitors on one cloud (the
  // control-plane sends the environment id). Optional: without it the URL
  // is the key.
  id?: string;
  url: string;
  weight: number;
  insecureSkipVerify: boolean;
  // via reaches the backend through a relay (private clusters): the edge
  // connects to via.url, trusting via.caPem, and authenticates with token.
  via?: RelayVia;
}

export interface RelayVia {
  url: string;
  caPem: string;
  token: string;
}

// Target is one app's current traffic split, keyed by the public Host
// clients send — port of Target (registry.go lines 23-28).
export interface Target {
  host: string;
  backends: Backend[];
  // insights is the host's Speed Insights setting; absent means off.
  insights?: InsightsSettings;
  // tls names the Secret holding the host's certificate; absent = no TLS.
  tls?: string;
  redirectHttps?: boolean;
  // cloudflare: the host sits behind Cloudflare, so cf-connecting-ip is
  // believed when the socket peer is a Cloudflare address.
  cloudflare?: boolean;
}

// InsightsSettings: Speed Insights for one host. enabled turns on the
// script and beacon endpoints; inject makes the edge insert the script
// tag into HTML pages (off = the site adds the tag itself); sampleRate is
// the percentage of page views that report.
export interface InsightsSettings {
  enabled: boolean;
  inject: boolean;
  sampleRate: 100 | 50 | 25 | 10;
}

// pick weighted-randomly selects one Backend. A Backend with weight 0
// is never selected — not rarely, never — since Registry.set already
// rejects any configuration whose weights are all 0, there's always a
// positive total to draw from once a Target has been through set — port
// of Target.Pick (registry.go lines 30-50).
export function pick(target: Target): Backend {
  let total = 0;
  for (const b of target.backends) total += b.weight;
  if (total <= 0) {
    throw new Error(`edge: target ${JSON.stringify(target.host)} has no pickable backend`);
  }
  let draw = Math.floor(Math.random() * total);
  for (const b of target.backends) {
    if (draw < b.weight) return b;
    draw -= b.weight;
  }
  throw new Error(`edge: target ${JSON.stringify(target.host)} has no pickable backend`);
}

// normalizeHost strips a port (a real client that doesn't override its
// own Host header sends one) and lowercases the rest, so set and get
// agree on the same key regardless of how a caller happened to spell it
// — new URL("http://" + host).hostname does both in one call (confirmed
// directly), falling back to a plain lowercase if host itself isn't
// URL-parseable even with that prefix — port of normalizeHost
// (registry.go lines 64-73).
export function normalizeHost(host: string): string {
  let h: string;
  try {
    h = new URL("http://" + host).hostname;
  } catch {
    h = host.toLowerCase();
  }
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

// Registry holds every app's current Target — the data-plane proxy
// reads it on every request while the admin API writes to it live,
// without a restart — port of Registry (registry.go lines 52-62).
export interface Registry {
  // set replaces host's Target, validating before storing: every weight
  // must be >= 0, the backends must not all sum to a weight of 0 (either
  // would leave a Target that pick can never draw from), and every
  // backend URL must actually be a valid http(s) URL — an operator's
  // typo accepted here would otherwise 502 on every real request routed
  // to it — port of Registry.Set (registry.go lines 75-101).
  set(host: string, backends: Backend[], insights?: InsightsSettings): void;
  // replaceAll validates every target like set, then swaps the whole table
  // in one step; a bad table changes nothing.
  replaceAll(targets: RouteTable["targets"]): void;
  get(host: string): Target | undefined;
  // remove drops host's Target; removing an unknown host is a no-op.
  remove(host: string): void;
}

function validate(host: string, backends: Backend[]): void {
  let total = 0;
  for (const b of backends) {
    if (b.weight < 0) {
      throw new Error(`edge: backend ${JSON.stringify(b.url)} has a negative weight ${b.weight}`);
    }
    let parsed: URL;
    try {
      parsed = new URL(b.url);
    } catch {
      throw new Error(`edge: backend ${JSON.stringify(b.url)} is not a valid http(s) url`);
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.host === "") {
      throw new Error(`edge: backend ${JSON.stringify(b.url)} is not a valid http(s) url`);
    }
    total += b.weight;
  }
  if (total <= 0) {
    throw new Error(`edge: target ${JSON.stringify(host)} has no backend with a positive weight`);
  }
}

export function createRegistry(): Registry {
  let targets = new Map<string, Target>();

  return {
    set(host, backends, insights) {
      validate(host, backends);
      const normalized = normalizeHost(host);
      targets.set(normalized, { host: normalized, backends, ...(insights ? { insights } : {}) });
    },
    replaceAll(table) {
      const next = new Map<string, Target>();
      for (const [host, t] of Object.entries(table)) {
        validate(host, t.backends);
        const normalized = normalizeHost(host);
        if (next.has(normalized)) throw new Error(`edge: duplicate host ${JSON.stringify(normalized)} in route table`);
        next.set(normalized, {
          host: normalized,
          backends: t.backends,
          ...(t.insights ? { insights: t.insights } : {}),
          ...(t.tls !== undefined ? { tls: t.tls } : {}),
          ...(t.redirectHttps !== undefined ? { redirectHttps: t.redirectHttps } : {}),
          ...(t.cloudflare !== undefined ? { cloudflare: t.cloudflare } : {}),
        });
      }
      targets = next;
    },
    get(host) {
      return targets.get(normalizeHost(host));
    },
    remove(host) {
      targets.delete(normalizeHost(host));
    },
  };
}
