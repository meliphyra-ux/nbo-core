// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { ErrInvalid } from "./errors.js";
import { open, seal, secretKeyHooks } from "./secrets.js";
import type { Store } from "./store.js";

export const serverSettingsSchema = `
CREATE TABLE IF NOT EXISTS server_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
-- A certificate Let's Encrypt issued whose TLS Secret could not be
-- written yet (sealed JSON {certPem, keyPem, notAfter}); retried without
-- a new order, so a failing write never burns the duplicate-cert limit.
CREATE TABLE IF NOT EXISTS domain_pending_certs (
	domain_id TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
-- An origin certificate the operator pasted for a domain (sealed JSON
-- {certPem, keyPem, notAfter}).
CREATE TABLE IF NOT EXISTS domain_pasted_certs (
	domain_id TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

export interface PendingCert {
  certPem: string;
  keyPem: string;
  notAfter: string;
}

export interface ServerSettings {
  baseDomain: string;
  acmeEmail: string;
  acmeDirectory: "production" | "staging";
  edgeClusterId: string;
  edgeAddress: string;
  // The edge version last installed ("" means an older install).
  edgeVersion: string;
  // JSON array of Cloudflare CIDRs last fetched ("" means none yet).
  cloudflareRanges: string;
  // "none": NBO keeps variable names only; values come with each deploy.
  // Turned on only through clearStoredValues (env-vars.ts), which blanks
  // the stored values in the same transaction.
  envValues: "stored" | "none";
}

// EdgeJob is the latest long-running edge job (install, reinstall, or
// enabling a cluster's relay), kept so a reconnecting dashboard sees it.
export interface EdgeJob {
  id: string;
  kind: "install" | "reinstall" | "relay";
  status: "running" | "failed" | "succeeded";
  step?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

// google_client_secret: the Google sign-in client's secret (auth.ts keeps
// the rest of the sign-in settings under their own keys). github_*: the NBO
// GitHub App's private key, client secret and webhook secret (an older NBO
// stored the app's other settings under their own keys; github-legacy.ts
// still reads the private key for projects linked to it).
export type ServerSecretName =
  | "acme_account_key"
  | "edge_drain_token"
  | "google_client_secret"
  | "github_private_key"
  | "github_client_secret"
  | "github_webhook_secret";
export const secretNames: readonly ServerSecretName[] = [
  "acme_account_key",
  "edge_drain_token",
  "google_client_secret",
  "github_private_key",
  "github_client_secret",
  "github_webhook_secret",
];

const settingKeys: Record<keyof ServerSettings, string> = {
  baseDomain: "base_domain",
  acmeEmail: "acme_email",
  acmeDirectory: "acme_directory",
  edgeClusterId: "edge_cluster_id",
  edgeAddress: "edge_address",
  edgeVersion: "edge_version",
  cloudflareRanges: "cloudflare_ranges",
  envValues: "env_values",
};

// attachServerSettingsMethods mutates store in place like attachEnvMethods; it
// wraps the secret-key hooks so the sealed rows count as sealed data.
export function attachServerSettingsMethods(db: DatabaseSync, store: Store, initialKey?: Buffer): Store {
  const { needKey, hooks } = secretKeyHooks(store, initialKey, {
    hasSealed: () =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM server_settings WHERE key IN (${marks})`).get(...secretNames) as {
          n: number;
        }
      ).n > 0 ||
      (db.prepare("SELECT COUNT(*) AS n FROM domain_pending_certs").get() as { n: number }).n > 0 ||
      (db.prepare("SELECT COUNT(*) AS n FROM domain_pasted_certs").get() as { n: number }).n > 0,
    verify: (k) => {
      for (const r of db.prepare(`SELECT value FROM server_settings WHERE key IN (${marks})`).all(...secretNames) as {
        value: string;
      }[])
        open(k, r.value);
      for (const r of db.prepare("SELECT value FROM domain_pending_certs").all() as { value: string }[])
        open(k, r.value);
      for (const r of db.prepare("SELECT value FROM domain_pasted_certs").all() as { value: string }[])
        open(k, r.value);
    },
  });
  const get = (k: string): string | undefined =>
    (db.prepare("SELECT value FROM server_settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const put = (k: string, v: string): void => {
    db.prepare(
      "INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(k, v);
  };
  const marks = secretNames.map(() => "?").join(",");

  const read = (): ServerSettings => ({
    baseDomain: get("base_domain") ?? "",
    acmeEmail: get("acme_email") ?? "",
    acmeDirectory: get("acme_directory") === "staging" ? "staging" : "production",
    edgeClusterId: get("edge_cluster_id") ?? "",
    edgeAddress: get("edge_address") ?? "",
    edgeVersion: get("edge_version") ?? "",
    cloudflareRanges: get("cloudflare_ranges") ?? "",
    envValues: get("env_values") === "none" ? "none" : "stored",
  });

  Object.assign(store, {
    ...hooks,
    getServerSettings: read,
    updateServerSettings(patch: Partial<ServerSettings>): ServerSettings {
      if (
        patch.acmeDirectory !== undefined &&
        patch.acmeDirectory !== "production" &&
        patch.acmeDirectory !== "staging"
      ) {
        throw new ErrInvalid(`acmeDirectory must be "production" or "staging"`);
      }
      // Names only is turned on by clearStoredValues, never by a plain write
      // that would leave the stored values behind.
      if (patch.envValues !== undefined && patch.envValues !== "stored") {
        throw new ErrInvalid(`envValues can only be set back to "stored" here`);
      }
      db.exec("BEGIN");
      try {
        for (const [field, k] of Object.entries(settingKeys)) {
          const v = patch[field as keyof ServerSettings];
          if (v !== undefined) put(k, String(v));
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return read();
    },
    // key: "edge" or "relay:<clusterId>"; stored beside the settings.
    getEdgeJob(key: string): EdgeJob | undefined {
      const v = get(`job:${key}`);
      return v === undefined ? undefined : (JSON.parse(v) as EdgeJob);
    },
    setEdgeJob(key: string, job: EdgeJob): void {
      put(`job:${key}`, JSON.stringify(job));
    },
    getServerSecret(name: ServerSecretName): string | undefined {
      const v = get(name);
      return v === undefined ? undefined : open(needKey(), v);
    },
    getPendingCert(domainId: string): PendingCert | undefined {
      const r = db.prepare("SELECT value FROM domain_pending_certs WHERE domain_id = ?").get(domainId) as
        { value: string } | undefined;
      return r === undefined ? undefined : (JSON.parse(open(needKey(), r.value)) as PendingCert);
    },
    setPendingCert(domainId: string, cert: PendingCert | null): void {
      if (cert === null) {
        db.prepare("DELETE FROM domain_pending_certs WHERE domain_id = ?").run(domainId);
        return;
      }
      db.prepare(
        "INSERT INTO domain_pending_certs (domain_id, value) VALUES (?, ?) ON CONFLICT(domain_id) DO UPDATE SET value = excluded.value",
      ).run(domainId, seal(needKey(), JSON.stringify(cert)));
    },
    getPastedCert(domainId: string): PendingCert | undefined {
      const r = db.prepare("SELECT value FROM domain_pasted_certs WHERE domain_id = ?").get(domainId) as
        { value: string } | undefined;
      return r === undefined ? undefined : (JSON.parse(open(needKey(), r.value)) as PendingCert);
    },
    setPastedCert(domainId: string, cert: PendingCert | null): void {
      if (cert === null) {
        db.prepare("DELETE FROM domain_pasted_certs WHERE domain_id = ?").run(domainId);
        return;
      }
      db.prepare(
        "INSERT INTO domain_pasted_certs (domain_id, value) VALUES (?, ?) ON CONFLICT(domain_id) DO UPDATE SET value = excluded.value",
      ).run(domainId, seal(needKey(), JSON.stringify(cert)));
    },
    setServerSecret(name: ServerSecretName, value: string): void {
      if (!secretNames.includes(name)) throw new ErrInvalid(`unknown platform secret "${name}"`);
      put(name, seal(needKey(), value));
    },
  });
  return store;
}
