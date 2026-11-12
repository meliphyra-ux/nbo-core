// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../store.js";
import { createCloudflareRanges, bundledCloudflareRanges } from "../cloudflare-ranges.js";
import { migrate } from "../migrate.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // closed
    }
  }
});
async function openStore(): Promise<{ store: Store; path: string; key: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-cf-"));
  const path = join(dir, "test.db");
  const key = randomBytes(32);
  const store = createStore(path, { secretKey: key });
  stores.push(store);
  return { store, path, key };
}

const answer = (v4: unknown, v6: unknown, success = true, status = 200): typeof fetch =>
  (async (url: string | URL | Request) => {
    expect(String(url)).toBe("https://api.cloudflare.com/client/v4/ips");
    return new Response(JSON.stringify({ success, result: { ipv4_cidrs: v4, ipv6_cidrs: v6 } }), { status });
  }) as typeof fetch;

describe("cloudflare ranges", () => {
  it("starts with the bundled list", async () => {
    const { store } = await openStore();
    const r = createCloudflareRanges({ store });
    expect(r.current()).toEqual(bundledCloudflareRanges);
    expect(r.isCloudflare("104.16.1.1")).toBe(true);
    expect(r.isCloudflare("2606:4700::1")).toBe(true);
    expect(r.isCloudflare("8.8.8.8")).toBe(false);
    expect(r.isCloudflare("not-an-ip")).toBe(false);
  });

  it("stores a good answer, rebuilds the matcher, and survives a new instance", async () => {
    const { store } = await openStore();
    const r = createCloudflareRanges({ store, fetch: answer(["104.16.0.0/13", "198.51.100.0/24"], ["2606:4700::/32"]) });
    expect(r.isCloudflare("198.51.100.7")).toBe(false);
    expect(await r.refresh()).toBe(true);
    expect(r.current()).toEqual(["104.16.0.0/13", "198.51.100.0/24", "2606:4700::/32"]);
    expect(r.isCloudflare("198.51.100.7")).toBe(true);
    expect(r.isCloudflare("173.245.48.1")).toBe(false);
    const again = createCloudflareRanges({ store });
    expect(again.current()).toEqual(r.current());
    expect(again.isCloudflare("198.51.100.7")).toBe(true);
    expect(await r.refresh()).toBe(false);
  });

  const bad: [string, typeof fetch][] = [
    ["network error", (async () => { throw new Error("down"); }) as typeof fetch],
    ["HTTP 500", answer(["104.16.0.0/13"], ["2606:4700::/32"], true, 500)],
    ["success false", answer(["104.16.0.0/13"], ["2606:4700::/32"], false)],
    ["empty arrays", answer([], [])],
    ["non-CIDR entry", answer(["104.16.0.0/13", "hello"], ["2606:4700::/32"])],
    ["bad prefix text", answer(["104.16.0.0/13x"], ["2606:4700::/32"])],
    ["bare address", answer(["104.16.0.1"], ["2606:4700::/32"])],
    ["0.0.0.0/0", answer(["0.0.0.0/0"], ["2606:4700::/32"])],
    ["::/0", answer(["104.16.0.0/13"], ["::/0"])],
    ["v4 under /10", answer(["104.0.0.0/9"], ["2606:4700::/32"])],
    ["v6 under /24", answer(["104.16.0.0/13"], ["2600::/16"])],
    ["::/24", answer(["104.16.0.0/13"], ["::/24"])],
    ["::ffff:0.0.0.0/96", answer(["104.16.0.0/13"], ["::ffff:0.0.0.0/96"])],
    ["v4 in v6 list", answer(["104.16.0.0/13"], ["104.16.0.0/16"])],
    ["non-string entry", answer([5], ["2606:4700::/32"])],
    ["non-array", answer("x", ["2606:4700::/32"])],
  ];
  for (const [name, f] of bad) {
    it(`ignores ${name}, keeping the last good list`, async () => {
      const { store } = await openStore();
      const good = createCloudflareRanges({ store, fetch: answer(["198.51.100.0/24"], ["2606:4700::/32"]) });
      expect(await good.refresh()).toBe(true);
      const r = createCloudflareRanges({ store, fetch: f });
      expect(await r.refresh()).toBe(false);
      expect(r.current()).toEqual(["198.51.100.0/24", "2606:4700::/32"]);
    });
  }

  it("falls back to bundled when the persisted list is invalid", async () => {
    const { store } = await openStore();
    store.updateServerSettings({ cloudflareRanges: JSON.stringify(["0.0.0.0/0"]) });
    expect(createCloudflareRanges({ store }).current()).toEqual(bundledCloudflareRanges);
    store.updateServerSettings({ cloudflareRanges: JSON.stringify(["::/24"]) });
    expect(createCloudflareRanges({ store }).current()).toEqual(bundledCloudflareRanges);
    store.updateServerSettings({ cloudflareRanges: JSON.stringify(["::ffff:0.0.0.0/96"]) });
    expect(createCloudflareRanges({ store }).isCloudflare("8.8.8.8")).toBe(false);
    store.updateServerSettings({ cloudflareRanges: "not json" });
    expect(createCloudflareRanges({ store }).current()).toEqual(bundledCloudflareRanges);
  });
});

describe("cloudflare domain storage", () => {
  it("migrates an old domains table", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, [
      `CREATE TABLE domains (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, host TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, status TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '', cert_not_after TEXT NOT NULL DEFAULT '', next_attempt_at TEXT NOT NULL DEFAULT '',
        failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, checked_at TEXT NOT NULL DEFAULT '');`,
    ]);
    db.exec("INSERT INTO domains (id, project_id, host, kind, status, created_at) VALUES ('d','p','a.b.co','custom','active','x')");
    migrate(db);
    expect(db.prepare("SELECT behind_cloudflare, cert_source, warning FROM domains").get()).toEqual({ behind_cloudflare: 0, cert_source: "letsencrypt", warning: "" });
  });

  it("defaults and patches the new domain fields", async () => {
    const { store } = await openStore();
    const p = store.createProject("shop");
    const d = store.addDomain(p.id, "shop.acme.com", "custom");
    expect(d).toMatchObject({ behindCloudflare: false, certSource: "letsencrypt", warning: "" });
    const u = store.updateDomain(d.id, { behindCloudflare: true, certSource: "pasted", warning: "w" });
    expect(u).toMatchObject({ behindCloudflare: true, certSource: "pasted", warning: "w" });
  });

  it("round-trips a sealed pasted cert and cleans up", async () => {
    const { store, path } = await openStore();
    const p = store.createProject("shop");
    const d = store.addDomain(p.id, "shop.acme.com", "custom");
    const q = store.createProject("other");
    const e = store.addDomain(q.id, "o.acme.com", "custom");
    expect(store.getPastedCert(d.id)).toBeUndefined();
    const c = { certPem: "CERT-PLAINTEXT", keyPem: "KEY-PLAINTEXT", notAfter: "2027-01-01T00:00:00Z" };
    store.setPastedCert(d.id, c);
    store.setPastedCert(e.id, c);
    expect(store.getPastedCert(d.id)).toEqual(c);
    const raw = new DatabaseSync(path).prepare("SELECT value FROM domain_pasted_certs WHERE domain_id = ?").get(d.id) as { value: string };
    expect(raw.value).not.toContain("PLAINTEXT");
    expect(store.hasSealedSecrets()).toBe(true);
    store.deleteDomain(d.id);
    expect(store.getPastedCert(d.id)).toBeUndefined();
    store.deleteProject(q.id);
    expect(store.getPastedCert(e.id)).toBeUndefined();
    store.setPastedCert(e.id, c);
    store.setPastedCert(e.id, null);
    expect(store.getPastedCert(e.id)).toBeUndefined();
  });

  it("platform settings carry edgeVersion and cloudflareRanges", async () => {
    const { store } = await openStore();
    expect(store.getServerSettings()).toMatchObject({ edgeVersion: "", cloudflareRanges: "" });
    expect(store.updateServerSettings({ edgeVersion: "2" }).edgeVersion).toBe("2");
  });
});
