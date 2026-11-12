// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { ErrDuplicateName, ErrInvalid, ErrNotFound } from "./errors.js";
import type { Store } from "./store.js";

export const domainsSchema = `
CREATE TABLE IF NOT EXISTS domains (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	host TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL,
	status TEXT NOT NULL,
	last_error TEXT NOT NULL DEFAULT '',
	cert_not_after TEXT NOT NULL DEFAULT '',
	next_attempt_at TEXT NOT NULL DEFAULT '',
	failures INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	checked_at TEXT NOT NULL DEFAULT '',
	behind_cloudflare INTEGER NOT NULL DEFAULT 0,
	cert_source TEXT NOT NULL DEFAULT 'letsencrypt',
	warning TEXT NOT NULL DEFAULT '',
	serving TEXT NOT NULL DEFAULT 'edge',
	mapping_records TEXT NOT NULL DEFAULT '',
	mapping_kept INTEGER NOT NULL DEFAULT 0,
	mapping_remove_after TEXT NOT NULL DEFAULT ''
);
`;

export type DomainStatus = "verify_pending" | "dns_pending" | "cert_pending" | "active" | "failed";

// One DNS record Cloud Run asks the owner to create for a domain mapping.
export interface MappingRecord {
  type: string;
  name: string;
  value: string;
}

export interface Domain {
  id: string;
  projectId: string;
  // The stage (stages.ts) whose site the host serves: Production unless a
  // custom environment's.
  stageId: string;
  host: string;
  kind: "default" | "custom";
  status: DomainStatus;
  lastError: string;
  certNotAfter: string;
  nextAttemptAt: string;
  failures: number;
  createdAt: string;
  checkedAt: string;
  behindCloudflare: boolean;
  certSource: "letsencrypt" | "pasted";
  warning: string;
  // Who answers for the host: NBO's edge, or a Cloud Run domain mapping.
  serving: "edge" | "cloudrun";
  mappingRecords: MappingRecord[];
  // The Cloud Run mapping is kept (a moved domain waits for the edge row).
  mappingKept: boolean;
  // When a kept mapping may go: 24 hours after the edge row went active, so
  // visitors with cached DNS still reach Google. Empty until then.
  mappingRemoveAfter: string;
}

export type DomainPatch = Partial<Pick<Domain, "kind" | "status" | "lastError" | "certNotAfter" | "nextAttemptAt" | "failures" | "checkedAt" | "behindCloudflare" | "certSource" | "warning" | "serving" | "mappingRecords" | "mappingKept" | "mappingRemoveAfter">>;

// normalizeDomainHost: trim, lowercase, drop one trailing dot, then require a
// plain DNS name of at least two labels that is not an IP address.
export function normalizeDomainHost(input: string): string {
  let h = input.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  const bad = (why: string): ErrInvalid => new ErrInvalid(`"${input.trim()}" is not a valid domain name: ${why}`);
  if (h === "") throw bad("it is empty");
  if (h.includes("*")) throw bad("wildcards are not supported");
  if (h.length > 253) throw bad("it is longer than 253 characters");
  const labels = h.split(".");
  if (labels.length < 2) throw bad("it needs at least two parts, like example.com");
  for (const l of labels) {
    if (l.length < 1 || l.length > 63) throw bad("each part must be 1-63 characters");
    if (!/^[a-z0-9-]+$/.test(l)) throw bad("use only letters, digits and hyphens");
    if (l.startsWith("-") || l.endsWith("-")) throw bad("a part can not start or end with a hyphen");
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) throw bad("IP addresses are not allowed");
  return h;
}

interface Row {
  id: string;
  project_id: string;
  stage_id: string;
  host: string;
  kind: string;
  status: string;
  last_error: string;
  cert_not_after: string;
  next_attempt_at: string;
  failures: number;
  created_at: string;
  checked_at: string;
  behind_cloudflare: number;
  cert_source: string;
  warning: string;
  serving: string;
  mapping_records: string;
  mapping_kept: number;
  mapping_remove_after: string;
}

function parseRecords(text: string): MappingRecord[] {
  try {
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is MappingRecord => typeof r === "object" && r !== null && typeof r.type === "string" && typeof r.name === "string" && typeof r.value === "string",
    );
  } catch {
    return [];
  }
}

const toDomain = (r: Row): Domain => ({
  id: r.id,
  projectId: r.project_id,
  stageId: r.stage_id,
  host: r.host,
  kind: r.kind as Domain["kind"],
  status: r.status as DomainStatus,
  lastError: r.last_error,
  certNotAfter: r.cert_not_after,
  nextAttemptAt: r.next_attempt_at,
  failures: r.failures,
  createdAt: r.created_at,
  checkedAt: r.checked_at,
  behindCloudflare: r.behind_cloudflare === 1,
  certSource: r.cert_source === "pasted" ? "pasted" : "letsencrypt",
  warning: r.warning,
  serving: r.serving === "cloudrun" ? "cloudrun" : "edge",
  mappingRecords: parseRecords(r.mapping_records),
  mappingKept: r.mapping_kept === 1,
  mappingRemoveAfter: r.mapping_remove_after,
});

const patchColumns: Record<keyof DomainPatch, string> = {
  kind: "kind",
  status: "status",
  lastError: "last_error",
  certNotAfter: "cert_not_after",
  nextAttemptAt: "next_attempt_at",
  failures: "failures",
  checkedAt: "checked_at",
  behindCloudflare: "behind_cloudflare",
  certSource: "cert_source",
  warning: "warning",
  serving: "serving",
  mappingRecords: "mapping_records",
  mappingKept: "mapping_kept",
  mappingRemoveAfter: "mapping_remove_after",
};

export function attachDomainMethods(db: DatabaseSync, store: Store): Store {
  const getRow = (id: string): Row => {
    const r = db.prepare("SELECT * FROM domains WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new ErrNotFound(`domain "${id}"`);
    return r;
  };
  Object.assign(store, {
    // addDomain records a host for stageId's site (Production when omitted).
    addDomain(projectId: string, host: string, kind: Domain["kind"], serving: Domain["serving"] = "edge", stageId?: string): Domain {
      const h = normalizeDomainHost(host);
      const id = `dom_${randomBytes(8).toString("hex")}`;
      const stage =
        stageId ?? (db.prepare("SELECT id FROM stages WHERE project_id = ? AND name = 'production'").get(projectId) as { id: string } | undefined)?.id ?? "";
      try {
        db.prepare("INSERT INTO domains (id, project_id, stage_id, host, kind, status, serving, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          id,
          projectId,
          stage,
          h,
          kind,
          serving === "cloudrun" ? "verify_pending" : "dns_pending",
          serving,
          new Date().toISOString(),
        );
      } catch (err) {
        if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) throw new ErrDuplicateName(`the domain "${h}" is already in use`);
        throw err;
      }
      return toDomain(getRow(id));
    },
    listDomains(projectId?: string): Domain[] {
      const rows = (
        projectId === undefined
          ? db.prepare("SELECT * FROM domains ORDER BY created_at, id").all()
          : db.prepare("SELECT * FROM domains WHERE project_id = ? ORDER BY created_at, id").all(projectId)
      ) as unknown as Row[];
      return rows.map(toDomain);
    },
    getDomain(id: string): Domain {
      return toDomain(getRow(id));
    },
    updateDomain(id: string, patch: DomainPatch): Domain {
      getRow(id);
      const sets: string[] = [];
      const vals: (string | number)[] = [];
      for (const [field, col] of Object.entries(patchColumns)) {
        const v = patch[field as keyof DomainPatch];
        if (v !== undefined) {
          sets.push(`${col} = ?`);
          vals.push(typeof v === "boolean" ? (v ? 1 : 0) : Array.isArray(v) ? JSON.stringify(v) : v);
        }
      }
      if (sets.length > 0) db.prepare(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      return toDomain(getRow(id));
    },
    deleteDomain(id: string): void {
      getRow(id);
      db.prepare("DELETE FROM domains WHERE id = ?").run(id);
      db.prepare("DELETE FROM domain_pending_certs WHERE domain_id = ?").run(id);
      db.prepare("DELETE FROM domain_pasted_certs WHERE domain_id = ?").run(id);
    },
  });
  return store;
}
