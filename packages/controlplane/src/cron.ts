// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ErrNotFound } from "./errors.js";
import type { Store } from "./store.js";

// signCron produces the HMAC-SHA256 signature, hex-encoded, a cron
// target function verifies against the same secret — standard enough
// to verify from any language. Verification is the function
// author's own job per the spec's "otherwise an ordinary public
// route" framing; this is the signing side only — port of signCron
// (cron.go lines 25-29).
export function signCron(secret: string, cronID: string, ts: number): string {
  return createHmac("sha256", secret).update(`${cronID}:${ts}`).digest("hex");
}

// cronFieldSpec parses one of the 5 standard cron fields (minute,
// hour, day-of-month, month, day-of-week) into a predicate. Supports
// "*", a single number, a comma list, and a "*/N" step — not ranges
// (a documented scope cut, matching Go's own). min is the field's
// own lowest legal value (0 for minute/hour/weekday, 1 for
// day-of-month/month) — a "*/N" step counts from min, not from 0, so
// day-of-month's own "*/5" means day 1, 6, 11, ... not an off-by-one
// set — port of cronFieldSpec (cron.go lines 39-62).
function cronFieldSpec(raw: string, name: string, min: number, max: number): (v: number) => boolean {
  if (raw === "*") return () => true;
  if (raw.startsWith("*/")) {
    const n = Number(raw.slice(2));
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`cron: invalid step in ${name} field "${raw}"`);
    }
    return (v) => (v - min) % n === 0;
  }
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number(part);
    if (!Number.isInteger(n)) {
      throw new Error(`cron: invalid ${name} field "${raw}"`);
    }
    if (n < min || n > max) {
      throw new Error(`cron: ${name} field "${raw}" out of range [${min},${max}]`);
    }
    values.add(n);
  }
  return (v) => values.has(v);
}

// nextRun returns the first minute strictly after `after` that
// schedule (standard 5-field cron syntax: minute hour day-of-month
// month day-of-week) matches, walking forward one UTC minute at a
// time — cron's own real resolution. Bounded to roughly 4 years of
// minutes before giving up with an error, rather than looping forever
// on a schedule that can never match (e.g. February 30th) — port of
// nextRun (cron.go lines 71-106).
export function nextRun(schedule: string, after: Date): Date {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron: schedule "${schedule}" must have exactly 5 fields`);
  }
  const minuteOK = cronFieldSpec(fields[0]!, "minute", 0, 59);
  const hourOK = cronFieldSpec(fields[1]!, "hour", 0, 23);
  const domOK = cronFieldSpec(fields[2]!, "day-of-month", 1, 31);
  const monthOK = cronFieldSpec(fields[3]!, "month", 1, 12);
  const dowOK = cronFieldSpec(fields[4]!, "day-of-week", 0, 6);

  let t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t = new Date(t.getTime() + 60_000);

  const maxIterations = 4 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (minuteOK(t.getUTCMinutes()) && hourOK(t.getUTCHours()) && domOK(t.getUTCDate()) && monthOK(t.getUTCMonth() + 1) && dowOK(t.getUTCDay())) {
      return t;
    }
    t = new Date(t.getTime() + 60_000);
  }
  throw new Error(`cron: schedule "${schedule}" never matches within the lookahead window`);
}

// CronRow is one registered (environment, cron) pair, as dueCrons
// reports it.
export interface CronRow {
  environmentId: string;
  cronId: string;
  config: string; // the cron's own manifest.json entry, verbatim
  nextRun: Date;
  running: boolean;
}

export const cronsSchema = `
CREATE TABLE IF NOT EXISTS crons (
	environment_id TEXT NOT NULL REFERENCES environments(id),
	cron_id TEXT NOT NULL,
	config TEXT NOT NULL,
	next_run TEXT NOT NULL,
	last_run TEXT NOT NULL DEFAULT '',
	running INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (environment_id, cron_id)
);
CREATE TABLE IF NOT EXISTS environment_cron_secrets (
	environment_id TEXT PRIMARY KEY REFERENCES environments(id),
	secret TEXT NOT NULL
);
`;

// checkTimezone rejects anything but an absent/empty timezone or the
// literal "UTC" — nextRun and every other time comparison in this
// package work in UTC throughout, so a schedule declaring any other
// zone would silently be evaluated against the wrong wall-clock time
// rather than failing loudly. Supporting real IANA zones is a real
// feature, not a one-line fix (DST transitions change which
// wall-clock minutes exist at all) — out of scope here; rejecting it
// clearly beats silently mis-firing — port of checkTimezone (cron.go
// lines 199-204).
function checkTimezone(cronID: string, tz: string | undefined): void {
  if (tz && tz !== "UTC") {
    throw new Error(`cron "${cronID}": timezone "${tz}" is not supported — only UTC (or omitting the field) is`);
  }
}

interface ManifestCron {
  id: string;
  schedule: string;
  timezone?: string;
}

// attachCronMethods mutates store in place, adding every cron-related
// Store method, and returns it — called once, from store.ts's own
// createStore, after that function has already built every
// non-cron method onto the same object. See store.ts's own comment
// on why the wiring happens there rather than this file importing
// store.ts to build a Store itself (it would create a circular
// import — errors.ts's own comment explains the same concern from
// the other side).
export function attachCronMethods(db: DatabaseSync, store: Store): Store {
  Object.assign(store, {
    setCronSigningSecret(environmentId: string, secret: string): void {
      db.prepare(
        `INSERT INTO environment_cron_secrets (environment_id, secret) VALUES (?, ?)
         ON CONFLICT(environment_id) DO UPDATE SET secret = excluded.secret`,
      ).run(environmentId, secret);
    },

    getCronSigningSecret(environmentId: string): string {
      const row = db.prepare("SELECT secret FROM environment_cron_secrets WHERE environment_id = ?").get(environmentId) as { secret: string } | undefined;
      if (!row) throw new ErrNotFound(`cron signing secret for environment "${environmentId}"`);
      return row.secret;
    },

    // ensureCronSigningSecret returns environmentId's own existing
    // secret, generating and storing a fresh, random one the first
    // time it's called for that environment — stable across every
    // later call.
    ensureCronSigningSecret(environmentId: string): string {
      try {
        return store.getCronSigningSecret(environmentId);
      } catch (err) {
        if (!(err instanceof ErrNotFound)) throw err;
      }
      const secret = randomBytes(32).toString("hex");
      store.setCronSigningSecret(environmentId, secret);
      return secret;
    },

    // registerCronsFromManifest reads nboDir's own manifest.json
    // crons array and makes the crons table match it exactly for
    // environmentId: a cron present in the manifest but not yet
    // registered is inserted with a freshly computed next_run; one
    // no longer present in the manifest is deleted outright, so a
    // redeploy that removes a cron stops it from ever firing again
    // rather than leaving a stale row behind.
    registerCronsFromManifest(environmentId: string, nboDir: string): void {
      const raw = readFileSync(join(nboDir, "manifest.json"), "utf8");
      const doc = JSON.parse(raw) as { crons?: ManifestCron[] };
      const crons = doc.crons ?? [];

      const seen = new Set<string>();
      const now = new Date();
      for (const c of crons) {
        seen.add(c.id);
        checkTimezone(c.id, c.timezone);
        let next: Date;
        try {
          next = nextRun(c.schedule, now);
        } catch (err) {
          throw new Error(`cron "${c.id}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
        db.prepare(
          `INSERT INTO crons (environment_id, cron_id, config, next_run) VALUES (?, ?, ?, ?)
           ON CONFLICT(environment_id, cron_id) DO UPDATE SET config = excluded.config, next_run = excluded.next_run`,
        ).run(environmentId, c.id, JSON.stringify(c), next.toISOString());
      }

      const rows = db.prepare("SELECT cron_id FROM crons WHERE environment_id = ?").all(environmentId) as { cron_id: string }[];
      for (const row of rows) {
        if (!seen.has(row.cron_id)) {
          db.prepare("DELETE FROM crons WHERE environment_id = ? AND cron_id = ?").run(environmentId, row.cron_id);
        }
      }
    },

    // dueCrons returns every registered cron whose own next_run is
    // at or before now.
    dueCrons(now: Date): CronRow[] {
      const rows = db.prepare("SELECT environment_id, cron_id, config, next_run, running FROM crons WHERE next_run <= ?").all(now.toISOString()) as {
        environment_id: string;
        cron_id: string;
        config: string;
        next_run: string;
        running: number;
      }[];
      return rows.map((r) => ({ environmentId: r.environment_id, cronId: r.cron_id, config: r.config, nextRun: new Date(r.next_run), running: r.running !== 0 }));
    },

    // claimCron atomically sets running=1 for (environmentId,
    // cronId) only if it was 0, returning whether the claim succeeded
    // — the mechanism "overlap: skip" is built on, and what keeps a
    // single tick from firing the same cron twice even if two tick
    // calls overlap.
    claimCron(environmentId: string, cronId: string): boolean {
      const res = db.prepare("UPDATE crons SET running = 1 WHERE environment_id = ? AND cron_id = ? AND running = 0").run(environmentId, cronId);
      return res.changes > 0;
    },

    // releaseNextRunOnly advances last_run/next_run without touching
    // running — used for overlap: allow, which never claims in the
    // first place (the flag's only purpose is implementing skip), so
    // there's nothing to release in the running-flag sense.
    releaseNextRunOnly(environmentId: string, cronId: string, next: Date): void {
      db.prepare("UPDATE crons SET last_run = ?, next_run = ? WHERE environment_id = ? AND cron_id = ?").run(new Date().toISOString(), next.toISOString(), environmentId, cronId);
    },

    // releaseCron clears running and records the new
    // last_run/next_run — called whether the HTTP call that followed
    // a claim succeeded or failed, since delivery is at-least-once
    // and a failed invocation still advances to its next scheduled
    // tick rather than retrying.
    releaseCron(environmentId: string, cronId: string, ranAt: Date, next: Date): void {
      db.prepare("UPDATE crons SET running = 0, last_run = ?, next_run = ? WHERE environment_id = ? AND cron_id = ?").run(
        ranAt.toISOString(),
        next.toISOString(),
        environmentId,
        cronId,
      );
    },
  });
  return store;
}
