// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createStore, baseSchema, ErrDuplicateName, ErrNotFound, type Store } from "../store.js";
import { gitSchema } from "../../git/git.js";
import { ErrInvalid } from "../errors.js";
import { normalizeDomainHost, domainsSchema } from "../../domains/domains.js";

const open: Store[] = [];
afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
});

async function openStore(): Promise<{ store: Store; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-pd-"));
  const path = join(dir, "test.db");
  const store = createStore(path, { secretKey: randomBytes(32) });
  open.push(store);
  return { store, path };
}

describe("platform settings", () => {
  it("has defaults and round-trips patches", async () => {
    const { store } = await openStore();
    expect(store.getServerSettings()).toEqual({
      baseDomain: "",
      acmeEmail: "",
      acmeDirectory: "production",
      edgeClusterId: "",
      edgeAddress: "",
      edgeVersion: "",
      cloudflareRanges: "",
      envValues: "stored",
    });
    const after = store.updateServerSettings({ baseDomain: "apps.example.com", acmeDirectory: "staging" });
    expect(after.baseDomain).toBe("apps.example.com");
    expect(after.acmeDirectory).toBe("staging");
    expect(after.acmeEmail).toBe("");
    expect(store.updateServerSettings({ acmeEmail: "a@b.co" }).baseDomain).toBe("apps.example.com");
    expect(store.getServerSettings().acmeEmail).toBe("a@b.co");
  });

  it("rejects an unknown acme directory", async () => {
    const { store } = await openStore();
    expect(() => store.updateServerSettings({ acmeDirectory: "x" as "staging" })).toThrow(ErrInvalid);
  });

  it("seals secrets in the table", async () => {
    const { store, path } = await openStore();
    expect(store.getServerSecret("edge_drain_token")).toBeUndefined();
    store.setServerSecret("edge_drain_token", "plain-token-123");
    expect(store.getServerSecret("edge_drain_token")).toBe("plain-token-123");
    store.setServerSecret("acme_account_key", "KEYDATA");
    expect(store.hasSealedSecrets()).toBe(true);
    const raw = new DatabaseSync(path);
    const rows = raw.prepare("SELECT key, value FROM server_settings").all() as { key: string; value: string }[];
    raw.close();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.value).not.toContain("plain-token-123");
      expect(r.value).not.toContain("KEYDATA");
    }
    expect(store.getServerSettings().edgeAddress).toBe("");
  });
});

describe("normalizeDomainHost", () => {
  it("normalizes valid hosts", () => {
    expect(normalizeDomainHost("Shop.Acme.com.")).toBe("shop.acme.com");
    expect(normalizeDomainHost("  a-b.example.org ")).toBe("a-b.example.org");
  });
  it.each([
    "*.a.com",
    "1.2.3.4",
    "a",
    "",
    "a..com",
    "-a.com",
    "a-.com",
    `${"a".repeat(64)}.com`,
    "a.com..",
    "exa_mple.com",
    `${"a.".repeat(130)}com`,
  ])("rejects %j", (h) => {
    expect(() => normalizeDomainHost(h)).toThrow(ErrInvalid);
  });
});

describe("domains", () => {
  it("adds, lists, gets, updates, deletes", async () => {
    const { store } = await openStore();
    const p = store.createProject("shop");
    const d = store.addDomain(p.id, "Shop.acme.com", "custom");
    expect(d.id).toMatch(/^dom_[0-9a-f]{16}$/);
    expect(d).toMatchObject({
      projectId: p.id,
      host: "shop.acme.com",
      kind: "custom",
      status: "dns_pending",
      lastError: "",
      certNotAfter: "",
      nextAttemptAt: "",
      failures: 0,
      checkedAt: "",
    });
    expect(d.createdAt).not.toBe("");
    expect(store.listDomains(p.id)).toHaveLength(1);
    expect(store.listDomains()).toHaveLength(1);
    expect(store.listDomains("other")).toEqual([]);
    expect(store.getDomain(d.id)).toEqual(d);
    const u = store.updateDomain(d.id, {
      status: "failed",
      lastError: "boom",
      failures: 3,
      certNotAfter: "2027-01-01T00:00:00Z",
    });
    expect(u).toMatchObject({ status: "failed", lastError: "boom", failures: 3, host: "shop.acme.com" });
    store.deleteDomain(d.id);
    expect(() => store.getDomain(d.id)).toThrow(ErrNotFound);
    expect(() => store.deleteDomain(d.id)).toThrow(ErrNotFound);
    expect(() => store.updateDomain(d.id, { status: "active" })).toThrow(ErrNotFound);
  });

  it("serves from the edge by default and starts a Cloud Run row at verify_pending", async () => {
    const { store } = await openStore();
    const p = store.createProject("shop");
    const e = store.addDomain(p.id, "a.acme.com", "custom");
    expect(e).toMatchObject({
      serving: "edge",
      status: "dns_pending",
      mappingRecords: [],
      mappingKept: false,
      mappingRemoveAfter: "",
    });
    const c = store.addDomain(p.id, "b.acme.com", "custom", "cloudrun");
    expect(c).toMatchObject({ serving: "cloudrun", status: "verify_pending", mappingRecords: [], mappingKept: false });
  });

  it("round-trips mapping records and mappingKept", async () => {
    const { store } = await openStore();
    const p = store.createProject("shop");
    const d = store.addDomain(p.id, "b.acme.com", "custom", "cloudrun");
    const records = [{ type: "CNAME", name: "b", value: "ghs.googlehosted.com." }];
    const u = store.updateDomain(d.id, { mappingRecords: records, mappingKept: true, serving: "edge" });
    expect(u).toMatchObject({ mappingRecords: records, mappingKept: true, serving: "edge" });
    expect(store.getDomain(d.id)).toEqual(u);
    expect(store.updateDomain(d.id, { mappingKept: false }).mappingRecords).toEqual(records);
    expect(store.updateDomain(d.id, { mappingRemoveAfter: "2026-11-07T10:00:00.000Z" }).mappingRemoveAfter).toBe(
      "2026-11-07T10:00:00.000Z",
    );
    expect(store.updateDomain(d.id, { mappingRemoveAfter: "" }).mappingRemoveAfter).toBe("");
  });

  it("reads a corrupt mapping_records value as an empty list", async () => {
    const { store, path } = await openStore();
    const p = store.createProject("shop");
    const d = store.addDomain(p.id, "b.acme.com", "custom", "cloudrun");
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE domains SET mapping_records = ? WHERE id = ?").run("{not json", d.id);
    expect(store.getDomain(d.id).mappingRecords).toEqual([]);
    raw.prepare("UPDATE domains SET mapping_records = ? WHERE id = ?").run('{"a":1}', d.id);
    expect(store.getDomain(d.id).mappingRecords).toEqual([]);
    raw
      .prepare("UPDATE domains SET mapping_records = ? WHERE id = ?")
      .run('[1,null,{"type":"A","name":"x"},{"type":"A","name":"","value":"1.2.3.4"}]', d.id);
    expect(store.getDomain(d.id).mappingRecords).toEqual([{ type: "A", name: "", value: "1.2.3.4" }]);
    raw.close();
  });

  it("adds the Cloud Run columns to a database made before them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-pd-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(baseSchema);
    old.exec(gitSchema);
    old.exec(
      domainsSchema
        .replace(/,\s*serving TEXT[^,\n]*/, "")
        .replace(/,\s*mapping_records TEXT[^,\n]*/, "")
        .replace(/,\s*mapping_kept INTEGER[^,\n]*/, "")
        .replace(/,\s*mapping_remove_after TEXT[^,\n]*/, ""),
    );
    old.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_1', 'acme', '2026-01-01T00:00:00Z')").run();
    old
      .prepare(
        "INSERT INTO domains (id, project_id, host, kind, status, created_at) VALUES ('dom_1', 'proj_1', 'a.acme.com', 'custom', 'active', '2026-01-01T00:00:00Z')",
      )
      .run();
    expect((old.prepare("PRAGMA table_info(domains)").all() as { name: string }[]).map((c) => c.name)).not.toContain(
      "serving",
    );
    old.close();
    const store = createStore(path, { secretKey: randomBytes(32) });
    open.push(store);
    expect(store.getDomain("dom_1")).toMatchObject({
      serving: "edge",
      mappingRecords: [],
      mappingKept: false,
      mappingRemoveAfter: "",
      status: "active",
    });
  });

  it("rejects a duplicate host regardless of case", async () => {
    const { store } = await openStore();
    const p = store.createProject("shop");
    store.addDomain(p.id, "shop.acme.com", "custom");
    expect(() => store.addDomain(p.id, "Shop.acme.com", "custom")).toThrow(ErrDuplicateName);
  });

  it("deleting a project deletes its domains", async () => {
    const { store } = await openStore();
    const p = store.createProject("shop");
    const q = store.createProject("other");
    store.addDomain(p.id, "shop.acme.com", "custom");
    store.addDomain(q.id, "other.acme.com", "default");
    store.deleteProject(p.id);
    expect(store.listDomains().map((d) => d.host)).toEqual(["other.acme.com"]);
  });
});
