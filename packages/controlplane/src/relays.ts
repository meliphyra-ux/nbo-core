// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { ErrSecretKey, open, seal } from "./secrets.js";
import type { Store } from "./store.js";

// A relay is the public entry NBO installs in a cluster that runs projects
// but is not the edge cluster: the edge reaches that cluster's apps through
// it, verifying it against its own private CA and authenticating with token.
export const relaysSchema = `
CREATE TABLE IF NOT EXISTS relays (
	cluster_id TEXT PRIMARY KEY,
	address TEXT NOT NULL DEFAULT '',
	ca_pem TEXT NOT NULL,
	secret TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at TEXT NOT NULL
);
`;

// RelaySecrets is sealed at rest; caPem (public) and address are not.
export interface RelaySecrets {
  token: string;
  caKeyPem: string;
  certPem: string;
  keyPem: string;
}

export interface Relay extends RelaySecrets {
  clusterId: string;
  // address is the relay LoadBalancer's IP or hostname ("" until assigned).
  address: string;
  caPem: string;
  status: string;
  createdAt: string;
}

export type RelayInput = Omit<Relay, "createdAt">;

interface Row {
  cluster_id: string;
  address: string;
  ca_pem: string;
  secret: string;
  status: string;
  created_at: string;
}

// attachRelayMethods mutates store in place like attachServerSettingsMethods,
// wrapping the secret-key hooks so relay rows count as sealed data.
export function attachRelayMethods(db: DatabaseSync, store: Store, initialKey?: Buffer): Store {
  let key: Buffer | undefined = initialKey;
  const needKey = (): Buffer => {
    if (!key) throw new ErrSecretKey("no secret key loaded");
    return key;
  };
  const origSetKey = store.setSecretKey.bind(store);
  const origHasSealed = store.hasSealedSecrets.bind(store);
  const origVerify = store.verifySecretKey.bind(store);

  Object.assign(store, {
    setSecretKey(k: Buffer): void {
      key = k;
      origSetKey(k);
    },
    hasSealedSecrets(): boolean {
      return origHasSealed() || (db.prepare("SELECT COUNT(*) AS n FROM relays").get() as { n: number }).n > 0;
    },
    verifySecretKey(): void {
      origVerify();
      const k = needKey();
      for (const r of db.prepare("SELECT secret FROM relays").all() as { secret: string }[]) open(k, r.secret);
    },
    getRelay(clusterId: string): Relay | null {
      const r = db.prepare("SELECT * FROM relays WHERE cluster_id = ?").get(clusterId) as Row | undefined;
      if (!r) return null;
      const s = JSON.parse(open(needKey(), r.secret)) as RelaySecrets;
      return {
        clusterId: r.cluster_id,
        address: r.address,
        caPem: r.ca_pem,
        status: r.status,
        createdAt: r.created_at,
        token: s.token,
        caKeyPem: s.caKeyPem,
        certPem: s.certPem,
        keyPem: s.keyPem,
      };
    },
    saveRelay(rec: RelayInput): void {
      // Only the declared secret fields are sealed; nothing else can ride along.
      const sealed = seal(needKey(), JSON.stringify({ token: rec.token, caKeyPem: rec.caKeyPem, certPem: rec.certPem, keyPem: rec.keyPem }));
      db.prepare(
        `INSERT INTO relays (cluster_id, address, ca_pem, secret, status, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cluster_id) DO UPDATE SET address = excluded.address, ca_pem = excluded.ca_pem, secret = excluded.secret, status = excluded.status`,
      ).run(rec.clusterId, rec.address, rec.caPem, sealed, rec.status, new Date().toISOString());
    },
  });
  return store;
}
