// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { ErrDuplicateName, ErrInvalidEnvironmentConfig, ErrNotFound } from "../store/errors.js";
import { ErrSecretKey, open, seal } from "../store/secrets.js";
import type { Store } from "../store/store.js";

export type ConnectionStatus = "connected" | "failing";
export type RegistryConfig = { kind: "artifact-registry" } | { kind: "custom"; server: string; username: string };

export interface GoogleConnection {
  kind: "google";
  project: string;
  region: string;
  arRepo: string;
  deployer: string;
  puller: string;
  // "key": a service-account key is stored (deployerKey). "wif": keyless; the
  // core signs its own tokens and Google trusts its public key through the
  // workload identity pool provider below (deployerKey is empty).
  auth: "key" | "wif";
  projectNumber?: string;
  pool?: string;
  provider?: string;
  // Notes from connecting, then the latest self-check's findings.
  warnings: string[];
  // The latest self-check's findings alone (keyless only), without the
  // connect notes: what `nbo-server google check` reports.
  checkWarnings?: string[];
  // Other cores the deployer also trusts (nbo-cores pool subjects), listed by
  // the self-check without a warning.
  otherCores?: string[];
  status: ConnectionStatus;
  lastChecked: string;
  lastError: string;
  createdAt: string;
}

// What a connect saves: warnings here are the connect notes; the self-check
// adds its own with recordGoogleSelfCheck.
export type GoogleConnectionInput = Omit<
  GoogleConnection,
  Meta | "auth" | "warnings" | "checkWarnings" | "otherCores"
> & {
  auth?: "key" | "wif";
  warnings?: string[];
};

// One connected Kubernetes cluster. NBO keeps any number of them; each
// environment of target kubernetes names its cluster by id (config.clusterId).
export interface KubernetesConnection {
  kind: "kubernetes";
  id: string;
  name: string;
  server: string;
  registry: RegistryConfig;
  status: ConnectionStatus;
  lastChecked: string;
  lastError: string;
  createdAt: string;
  // True when a load balancer location result is saved for this cluster
  // (the value itself is never listed).
  lbLocationSaved?: boolean;
}

// Service-account key JSON.
export interface GoogleSecrets {
  deployerKey: string;
  pullerKey: string;
  // True when NBO's own connect created deployerKey (rather than the operator
  // pasting it), so NBO may delete it when it is replaced.
  deployerKeyMadeByNbo?: boolean;
}
export interface KubernetesSecrets {
  kubeconfig: string;
  registryPassword?: string;
}

export type ConnectionKind = "google" | "kubernetes";
type Meta = "kind" | "createdAt" | "status" | "lastChecked" | "lastError";
export type KubernetesConnectionInput = Omit<KubernetesConnection, Meta | "id"> & { id?: string };

// The id an upgraded install's single Kubernetes connection keeps, named
// "default"; its environments keep their names (k8s) and cloud objects.
export const defaultClusterId = "kc_default";
export const defaultClusterName = "default";

// Cluster names: lowercase letters, digits and hyphens, at most 30
// characters, starting and ending with a letter or digit ("k8s-<name>"
// must stay a valid environment name).
export const validClusterName = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;
// reservedClusterName: `isr` and `*-isr` are refused for new clusters.
// Environment k8s-<name>'s app p<id>-k8s-<name> would otherwise equal the
// ISR cache p<id>-k8s-isr (`<app>-isr`) of another environment in the same
// namespace. Clusters connected earlier keep their names.
export function reservedClusterName(name: string): boolean {
  return name === "isr" || name.endsWith("-isr");
}
export const reservedClusterNameRule =
  'cluster names "isr" and ending in "-isr" are reserved for NBO\'s ISR caches; choose another name';

export const clusterNameRule =
  "a cluster name is 1–30 lowercase letters, digits or hyphens, starting and ending with a letter or digit";

// legacyConnectionsSchema: Google's single row lives here. Before multiple
// clusters, Kubernetes had one row here too (kind='kubernetes'); the
// migration below moves it to kube_connections.
export const legacyConnectionsSchema = `
CREATE TABLE IF NOT EXISTS connections (
	kind TEXT PRIMARY KEY CHECK (kind IN ('google','kubernetes')),
	config TEXT NOT NULL,
	secret TEXT NOT NULL,
	status TEXT NOT NULL,
	last_checked TEXT NOT NULL DEFAULT '',
	last_error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
`;

export const kubeConnectionsSchema = `
CREATE TABLE IF NOT EXISTS kube_connections (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	config TEXT NOT NULL,
	secret TEXT NOT NULL,
	status TEXT NOT NULL,
	last_checked TEXT NOT NULL DEFAULT '',
	last_error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
`;

export const connectionsSchema = legacyConnectionsSchema + kubeConnectionsSchema;

// migrateKubernetesConnections moves a pre-multi-cluster Kubernetes row
// (connections.kind='kubernetes') to kube_connections as kc_default /
// "default", copying its sealed secret verbatim (no key needed), and
// links every Kubernetes environment without a clusterId to it. One
// transaction: a restart can only see the old shape or the new one, and
// a second run finds no old row and does nothing.
export function migrateKubernetesConnections(db: DatabaseSync): void {
  db.exec(legacyConnectionsSchema);
  db.exec(kubeConnectionsSchema);
  // lb_annotations: the load balancer annotations detected from the cluster's
  // nodes when NBO held admin credentials (JSON, NULL = never detected).
  if (
    !(db.prepare("PRAGMA table_info(kube_connections)").all() as { name: string }[]).some(
      (col) => col.name === "lb_annotations",
    )
  ) {
    db.exec("ALTER TABLE kube_connections ADD COLUMN lb_annotations TEXT");
  }
  type Old = {
    config: string;
    secret: string;
    status: string;
    last_checked: string;
    last_error: string;
    created_at: string;
  };
  const old = db
    .prepare(
      "SELECT config, secret, status, last_checked, last_error, created_at FROM connections WHERE kind = 'kubernetes'",
    )
    .get() as Old | undefined;
  if (!old) return;
  // Never drop credentials: if kc_default is somehow already taken, keep
  // the old row for the operator to sort out and say so.
  if (db.prepare("SELECT 1 FROM kube_connections WHERE id = ? OR name = ?").get(defaultClusterId, defaultClusterName)) {
    console.error(
      `control-plane: not migrating the old Kubernetes connection: ${defaultClusterId} already exists (or the name "${defaultClusterName}" is taken); the old connection row is kept in the connections table (kind 'kubernetes')`,
    );
    return;
  }
  const cfg = JSON.parse(old.config) as { server?: string; registry?: RegistryConfig };
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO kube_connections (id, name, config, secret, status, last_checked, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      defaultClusterId,
      defaultClusterName,
      JSON.stringify({ server: cfg.server ?? "", registry: cfg.registry }),
      old.secret,
      old.status,
      old.last_checked,
      old.last_error,
      old.created_at,
    );
    const envs = db.prepare("SELECT id, config FROM environments WHERE target = 'kubernetes'").all() as {
      id: string;
      config: string;
    }[];
    for (const e of envs) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(e.config) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || parsed.clusterId !== undefined)
        continue;
      db.prepare("UPDATE environments SET config = ? WHERE id = ?").run(
        JSON.stringify({ ...parsed, clusterId: defaultClusterId }),
        e.id,
      );
    }
    db.prepare("DELETE FROM connections WHERE kind = 'kubernetes'").run();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

type Row = {
  kind: string;
  config: string;
  secret: string;
  status: string;
  last_checked: string;
  last_error: string;
  created_at: string;
};
type KubeRow = {
  id: string;
  name: string;
  config: string;
  secret: string;
  status: string;
  last_checked: string;
  last_error: string;
  created_at: string;
  lb_annotations?: string | null;
};

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

function clusterIdOf(config: string): string | undefined {
  try {
    const id = (JSON.parse(config) as { clusterId?: unknown }).clusterId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

// attachConnectionMethods mutates store in place, like attachGitMethods.
// The secret key arrives later via setSecretKey (main.ts needs the store
// to decide whether a missing key file is an error), so it lives in a
// closure variable.
export function attachConnectionMethods(db: DatabaseSync, store: Store, initialKey?: Buffer): Store {
  let key: Buffer | undefined = initialKey;

  const needKey = (): Buffer => {
    if (!key) throw new ErrSecretKey("no secret key loaded");
    return key;
  };

  const getGoogleRow = (): Row | undefined =>
    db.prepare("SELECT * FROM connections WHERE kind = 'google'").get() as Row | undefined;
  const getKubeRow = (id: string): KubeRow | undefined =>
    db.prepare("SELECT * FROM kube_connections WHERE id = ?").get(id) as KubeRow | undefined;

  const toGoogle = (): GoogleConnection | null => {
    const r = getGoogleRow();
    if (!r) return null;
    const { notes, checkWarnings, otherCores, auth, ...cfg } = JSON.parse(r.config) as StoredGoogleConfig;
    return {
      kind: "google",
      ...cfg,
      // Rows saved before keyless connections are key connections.
      auth: auth ?? "key",
      warnings: [...(notes ?? []), ...(checkWarnings ?? [])],
      ...(checkWarnings ? { checkWarnings } : {}),
      ...(otherCores ? { otherCores } : {}),
      status: r.status,
      lastChecked: r.last_checked,
      lastError: r.last_error,
      createdAt: r.created_at,
    } as GoogleConnection;
  };

  const toKube = (r: KubeRow): KubernetesConnection => {
    const cfg = JSON.parse(r.config) as { server: string; registry: RegistryConfig };
    return {
      kind: "kubernetes",
      id: r.id,
      name: r.name,
      server: cfg.server,
      registry: cfg.registry,
      status: r.status as ConnectionStatus,
      lastChecked: r.last_checked,
      lastError: r.last_error,
      createdAt: r.created_at,
      lbLocationSaved: r.lb_annotations != null,
    };
  };

  const saveKube = (c: KubernetesConnectionInput, s: KubernetesSecrets): KubernetesConnection => {
    if (typeof c.name !== "string" || !validClusterName.test(c.name))
      throw new ErrInvalidEnvironmentConfig(clusterNameRule);
    // Only declared fields are persisted, so a caller cannot smuggle extra
    // (possibly secret) data into the plaintext config column.
    const config = JSON.stringify({ server: c.server, registry: c.registry });
    const sealed = seal(needKey(), JSON.stringify(s));
    const taken = (): ErrDuplicateName =>
      new ErrDuplicateName(`a cluster named "${c.name}" is already connected — choose another name`);
    if (c.id !== undefined) {
      if (!getKubeRow(c.id)) throw new ErrNotFound(`Kubernetes connection "${c.id}"`);
      try {
        db.prepare(
          "UPDATE kube_connections SET name = ?, config = ?, secret = ?, status = 'connected', last_checked = '', last_error = '' WHERE id = ?",
        ).run(c.name, config, sealed, c.id);
      } catch (err) {
        if (isUniqueViolation(err)) throw taken();
        throw err;
      }
      return toKube(getKubeRow(c.id)!);
    }
    if (reservedClusterName(c.name)) throw new ErrInvalidEnvironmentConfig(reservedClusterNameRule);
    const id = `kc_${randomBytes(8).toString("hex")}`;
    try {
      db.prepare(
        "INSERT INTO kube_connections (id, name, config, secret, status, last_checked, last_error, created_at) VALUES (?, ?, ?, ?, 'connected', '', '', ?)",
      ).run(id, c.name, config, sealed, new Date().toISOString());
    } catch (err) {
      if (isUniqueViolation(err)) throw taken();
      throw err;
    }
    return toKube(getKubeRow(id)!);
  };

  Object.assign(store, {
    setSecretKey(k: Buffer): void {
      key = k;
    },
    hasSealedSecrets(): boolean {
      const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      return n("SELECT COUNT(*) AS n FROM connections") + n("SELECT COUNT(*) AS n FROM kube_connections") > 0;
    },
    // verifySecretKey opens every sealed row, so a wrong key file is
    // caught at startup rather than at the first deploy.
    verifySecretKey(): void {
      const k = needKey();
      for (const r of db
        .prepare("SELECT secret FROM connections UNION ALL SELECT secret FROM kube_connections")
        .all() as { secret: string }[])
        open(k, r.secret);
    },
    getGoogleConnection: toGoogle,
    getGoogleSecrets(): GoogleSecrets {
      const r = getGoogleRow();
      if (!r) throw new ErrNotFound("google connection");
      return JSON.parse(open(needKey(), r.secret)) as GoogleSecrets;
    },
    // recordGoogleSelfCheck replaces the previous self-check's findings,
    // keeping the connect notes.
    recordGoogleSelfCheck(warnings: string[], otherCores: string[]): void {
      const r = getGoogleRow();
      if (!r) return;
      const cfg = JSON.parse(r.config) as StoredGoogleConfig;
      db.prepare("UPDATE connections SET config = ? WHERE kind = 'google'").run(
        JSON.stringify({ ...cfg, checkWarnings: warnings, otherCores }),
      );
    },
    saveGoogleConnection(c: GoogleConnectionInput, s: GoogleSecrets): GoogleConnection {
      const sealed = seal(needKey(), JSON.stringify(s));
      db.prepare(
        `INSERT INTO connections (kind, config, secret, status, last_checked, last_error, created_at) VALUES ('google', ?, ?, 'connected', '', '', ?)
         ON CONFLICT(kind) DO UPDATE SET config = excluded.config, secret = excluded.secret, status = 'connected', last_checked = '', last_error = '', created_at = excluded.created_at`,
      ).run(JSON.stringify(pickGoogle(c)), sealed, new Date().toISOString());
      return toGoogle()!;
    },
    listKubernetesConnections(): KubernetesConnection[] {
      return (db.prepare("SELECT * FROM kube_connections ORDER BY created_at, rowid").all() as KubeRow[]).map(toKube);
    },
    getKubernetesConnection(id: string): KubernetesConnection | null {
      const r = getKubeRow(id);
      return r ? toKube(r) : null;
    },
    getKubernetesSecrets(id: string): KubernetesSecrets {
      const r = getKubeRow(id);
      if (!r) throw new ErrNotFound(`Kubernetes connection "${id}"`);
      return JSON.parse(open(needKey(), r.secret)) as KubernetesSecrets;
    },
    saveKubernetesConnection: saveKube,
    getClusterLbAnnotations(id: string): Record<string, string> | null {
      const raw = (
        db.prepare("SELECT lb_annotations AS v FROM kube_connections WHERE id = ?").get(id) as
          { v: string | null } | undefined
      )?.v;
      if (raw === null || raw === undefined) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : null;
      } catch {
        return null;
      }
    },
    setClusterLbAnnotations(id: string, annotations: Record<string, string>): void {
      db.prepare("UPDATE kube_connections SET lb_annotations = ? WHERE id = ?").run(JSON.stringify(annotations), id);
    },
    deleteKubernetesConnection(id: string): void {
      db.prepare("DELETE FROM kube_connections WHERE id = ?").run(id);
    },
    recordConnectionCheck(kind: ConnectionKind, error: string | null, id?: string): void {
      const status = error === null ? "connected" : "failing";
      const now = new Date().toISOString();
      if (kind === "google") {
        db.prepare("UPDATE connections SET status = ?, last_checked = ?, last_error = ? WHERE kind = 'google'").run(
          status,
          now,
          error ?? "",
        );
        return;
      }
      if (!id) throw new Error("recordConnectionCheck: a Kubernetes check needs the connection id");
      db.prepare("UPDATE kube_connections SET status = ?, last_checked = ?, last_error = ? WHERE id = ?").run(
        status,
        now,
        error ?? "",
        id,
      );
    },
    deleteConnection(kind: "google"): void {
      db.prepare("DELETE FROM connections WHERE kind = ?").run(kind);
    },
    environmentsUsing(_kind: "google"): { projectName: string; environmentId: string }[] {
      const rows = db
        .prepare(
          `SELECT p.name AS name, e.id AS id FROM environments e JOIN projects p ON p.id = e.project_id
           WHERE e.archived = 0 AND e.target = 'cloudrun' ORDER BY e.created_at, e.rowid`,
        )
        .all() as { name: string; id: string }[];
      return rows.map((r) => ({ projectName: r.name, environmentId: r.id }));
    },
    environmentsUsingCluster(id: string): { projectName: string; environmentId: string }[] {
      const rows = db
        .prepare(
          `SELECT p.name AS name, e.id AS id, e.config AS config FROM environments e JOIN projects p ON p.id = e.project_id
           WHERE e.archived = 0 AND e.target = 'kubernetes' ORDER BY e.created_at, e.rowid`,
        )
        .all() as { name: string; id: string; config: string }[];
      return rows
        .filter((r) => clusterIdOf(r.config) === id)
        .map((r) => ({ projectName: r.name, environmentId: r.id }));
    },
  });
  return store;
}

// environmentClusterId reads config.clusterId of an environment (undefined
// for Cloud Run, for dev-mode Kubernetes, and for unparsable configs).
export function environmentClusterId(config: string): string | undefined {
  return clusterIdOf(config);
}

// The config column of the Google row (plaintext: nothing here is secret).
interface StoredGoogleConfig {
  project: string;
  region: string;
  arRepo: string;
  deployer: string;
  puller: string;
  auth?: "key" | "wif";
  projectNumber?: string;
  pool?: string;
  provider?: string;
  notes?: string[];
  checkWarnings?: string[];
  otherCores?: string[];
}

function pickGoogle(c: GoogleConnectionInput): StoredGoogleConfig {
  const base = { project: c.project, region: c.region, arRepo: c.arRepo, deployer: c.deployer, puller: c.puller };
  const notes = c.warnings ?? [];
  if (c.auth !== "wif") return { ...base, auth: "key", notes };
  return { ...base, auth: "wif", projectNumber: c.projectNumber, pool: c.pool, provider: c.provider, notes };
}
