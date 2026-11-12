// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import type { Store } from "./store.js";

// The ephemeral certificate count: NBO orders at most 20 certificates for
// ephemeral stages' hosts in any 7 days per registered domain (certs.ts),
// so Let's Encrypt's 50 a week stays free for real domains. Orders are kept
// in preview_cert_orders, the table earlier NBO versions kept them in, and
// are never deleted with a project.

// The 7-day window of the count.
export const ephemeralCertWindowMs = 7 * 24 * 3_600_000;

export const ephemeralCertsSchema = `
CREATE TABLE IF NOT EXISTS preview_cert_orders (
	registered_domain TEXT NOT NULL,
	host TEXT NOT NULL,
	ordered_at TEXT NOT NULL
);
`;

export interface EphemeralCertsStore {
  // recordEphemeralCertOrder also prunes every order older than the window.
  recordEphemeralCertOrder(registeredDomain: string, host: string, at: string): void;
  // countEphemeralCertOrders: orders for registeredDomain placed after since
  // (an order leaves the window exactly 7 days after it was placed).
  countEphemeralCertOrders(registeredDomain: string, since: string): number;
  oldestEphemeralCertOrder(registeredDomain: string, since: string): string | undefined;
}

// attachEphemeralCertMethods mutates store in place, like attachStageMethods.
export function attachEphemeralCertMethods(db: DatabaseSync, store: Store): Store {
  const methods: EphemeralCertsStore = {
    recordEphemeralCertOrder(registeredDomain, host, at) {
      const cutoff = new Date(Date.parse(at) - ephemeralCertWindowMs).toISOString();
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM preview_cert_orders WHERE ordered_at < ?").run(cutoff);
        db.prepare("INSERT INTO preview_cert_orders (registered_domain, host, ordered_at) VALUES (?, ?, ?)").run(registeredDomain, host, at);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    countEphemeralCertOrders(registeredDomain, since) {
      return (db.prepare("SELECT COUNT(*) AS n FROM preview_cert_orders WHERE registered_domain = ? AND ordered_at > ?").get(registeredDomain, since) as { n: number }).n;
    },
    oldestEphemeralCertOrder(registeredDomain, since) {
      const r = db.prepare("SELECT MIN(ordered_at) AS at FROM preview_cert_orders WHERE registered_domain = ? AND ordered_at > ?").get(registeredDomain, since) as { at: string | null };
      return r.at ?? undefined;
    },
  };
  Object.assign(store, methods);
  return store;
}
