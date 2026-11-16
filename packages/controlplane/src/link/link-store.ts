// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { open, seal, secretKeyHooks } from "../store/secrets.js";
import type { Store } from "../store/store.js";

// The link's own tables: core's identity keys (private halves sealed with the
// secret key), the platform key core pinned at enrollment, the member keys that
// sign Tier 2 instructions, the journal of every instruction core saw, and
// one-time reset codes. Nothing here is read by a deploy, poll or build path.
export const linkSchema = `
CREATE TABLE IF NOT EXISTS link_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	core_id TEXT NOT NULL,
	team_id TEXT NOT NULL,
	link_url TEXT NOT NULL,
	link_host TEXT NOT NULL,
	platform_key_id TEXT NOT NULL,
	platform_key TEXT NOT NULL,
	identity_public TEXT NOT NULL,
	identity_sealed TEXT NOT NULL,
	encryption_public TEXT NOT NULL,
	encryption_sealed TEXT NOT NULL,
	high_seq INTEGER NOT NULL DEFAULT 0,
	enrolled_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link_member_keys (
	key_id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL,
	role TEXT NOT NULL,
	public_key TEXT NOT NULL,
	added_at TEXT NOT NULL,
	added_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link_journal (
	row_id INTEGER PRIMARY KEY AUTOINCREMENT,
	core_id TEXT NOT NULL DEFAULT '',
	instruction_id TEXT,
	at TEXT NOT NULL,
	seq INTEGER NOT NULL,
	nonce TEXT NOT NULL,
	tier INTEGER NOT NULL,
	method TEXT NOT NULL,
	route TEXT NOT NULL,
	signed_by TEXT NOT NULL,
	status INTEGER NOT NULL,
	reason TEXT NOT NULL DEFAULT '',
	accepted INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS link_journal_at ON link_journal(at);
CREATE INDEX IF NOT EXISTS link_journal_seq ON link_journal(core_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS link_journal_nonce_accepted ON link_journal(nonce) WHERE accepted = 1;
CREATE TABLE IF NOT EXISTS link_reset_codes (
	code_hash TEXT PRIMARY KEY,
	expires_at TEXT NOT NULL,
	used_at TEXT,
	key_fingerprint TEXT NOT NULL DEFAULT ''
);
`;

// LinkState: what the API and the client may see. No private material.
export interface LinkState {
  coreId: string;
  teamId: string;
  linkUrl: string;
  linkHost: string;
  platformKeyId: string;
  platformKey: string;
  identityPublic: string;
  encryptionPublic: string;
  highSeq: number;
  enrolledAt: string;
}

export interface LinkStateInput extends LinkState {
  identityPkcs8: string;
  encryptionPkcs8: string;
}

export interface MemberKeyInput {
  keyId: string;
  memberId: string;
  role: string;
  publicKey: string;
  addedBy: string;
}

export interface MemberKey extends MemberKeyInput {
  addedAt: string;
}

export interface JournalEntry {
  // id: the instruction's id (null for a message that had none).
  id: string | null;
  at: string;
  seq: number;
  nonce: string;
  tier: number;
  method: string;
  route: string;
  signedBy: string;
  status: number;
  reason: string;
  // accepted: the verifier accepted it (whatever the handler answered); false for a refusal.
  accepted: boolean;
}

export interface LinkStore {
  getLinkState(): LinkState | null;
  saveLinkState(s: LinkStateInput): void;
  // clearLink drops the link state, member keys and reset codes; the journal stays.
  clearLink(): void;
  openLinkKeys(): { identityPkcs8: string; encryptionPkcs8: string } | null;
  // secretKeyForRedaction: the loaded secret key, so the link's reply filter
  // can redact it; nothing else reads it here.
  secretKeyForRedaction(): Buffer | null;
  setPlatformKey(keyId: string, publicKey: string): void;
  setHighSeq(n: number): void;
  listMemberKeys(): MemberKey[];
  addMemberKey(k: MemberKeyInput): MemberKey;
  removeMemberKey(keyId: string): void;
  getMemberKey(keyId: string): MemberKey | undefined;
  // journalHas: true when an accepted instruction of the current link used
  // this sequence number, or any accepted instruction used this nonce. Each
  // link numbers its instructions from 1, so a seq counts only within the
  // link (core id) it was accepted under.
  journalHas(seq: number, nonce: string): boolean;
  appendJournal(e: JournalEntry): void;
  // setJournalOutcome records what the handler answered on the accepted row
  // for this nonce (the dispatcher journals it accepted before running it).
  setJournalOutcome(nonce: string, status: number, reason: string): void;
  // listJournal: newest first; before is an exclusive upper bound on `at`.
  listJournal(opts: { limit: number; before?: string }): JournalEntry[];
  pruneJournal(olderThan: Date): number;
  // createResetCode: a code that registers only the key with this fingerprint.
  createResetCode(hash: string, keyFingerprint: string, expiresAt: string): void;
  // useResetCode: the fingerprint of the key the code is for, once, and only
  // before the code expires; null otherwise. A code from before codes named a
  // key (fingerprint '') is never usable.
  useResetCode(hash: string, now: Date): string | null;
}

interface StateRow {
  core_id: string;
  team_id: string;
  link_url: string;
  link_host: string;
  platform_key_id: string;
  platform_key: string;
  identity_public: string;
  identity_sealed: string;
  encryption_public: string;
  encryption_sealed: string;
  high_seq: number;
  enrolled_at: string;
}
interface MemberRow {
  key_id: string;
  member_id: string;
  role: string;
  public_key: string;
  added_at: string;
  added_by: string;
}
interface JournalRow {
  instruction_id: string | null;
  at: string;
  seq: number;
  nonce: string;
  tier: number;
  method: string;
  route: string;
  signed_by: string;
  status: number;
  reason: string;
  accepted: number;
}

const toMember = (r: MemberRow): MemberKey => ({
  keyId: r.key_id,
  memberId: r.member_id,
  role: r.role,
  publicKey: r.public_key,
  addedAt: r.added_at,
  addedBy: r.added_by,
});
const toJournal = (r: JournalRow): JournalEntry => ({
  id: r.instruction_id,
  at: r.at,
  seq: r.seq,
  nonce: r.nonce,
  tier: r.tier,
  method: r.method,
  route: r.route,
  signedBy: r.signed_by,
  status: r.status,
  reason: r.reason,
  accepted: r.accepted === 1,
});

// attachLinkMethods mutates store in place and wraps the secret-key hooks so
// sealed identity keys count as sealed data (a missing key file must not be
// silently replaced), as git-credentials.ts does.
export function attachLinkMethods(db: DatabaseSync, store: Store, initialKey?: Buffer): Store {
  const { needKey, currentKey, hooks } = secretKeyHooks(store, initialKey, {
    hasSealed: () =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM link_state WHERE identity_sealed <> '' OR encryption_sealed <> ''")
          .get() as { n: number }
      ).n > 0,
    verify: (k) => {
      for (const r of db.prepare("SELECT identity_sealed, encryption_sealed FROM link_state").all() as {
        identity_sealed: string;
        encryption_sealed: string;
      }[]) {
        if (r.identity_sealed !== "") open(k, r.identity_sealed);
        if (r.encryption_sealed !== "") open(k, r.encryption_sealed);
      }
    },
  });

  const methods: LinkStore & Pick<Store, "setSecretKey" | "hasSealedSecrets" | "verifySecretKey"> = {
    ...hooks,
    getLinkState() {
      const r = db.prepare("SELECT * FROM link_state WHERE id = 1").get() as StateRow | undefined;
      if (!r) return null;
      return {
        coreId: r.core_id,
        teamId: r.team_id,
        linkUrl: r.link_url,
        linkHost: r.link_host,
        platformKeyId: r.platform_key_id,
        platformKey: r.platform_key,
        identityPublic: r.identity_public,
        encryptionPublic: r.encryption_public,
        highSeq: r.high_seq,
        enrolledAt: r.enrolled_at,
      };
    },
    saveLinkState(s) {
      const k = needKey();
      db.prepare(
        `INSERT INTO link_state (id, core_id, team_id, link_url, link_host, platform_key_id, platform_key, identity_public, identity_sealed,
           encryption_public, encryption_sealed, high_seq, enrolled_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET core_id = excluded.core_id, team_id = excluded.team_id, link_url = excluded.link_url,
           link_host = excluded.link_host, platform_key_id = excluded.platform_key_id, platform_key = excluded.platform_key,
           identity_public = excluded.identity_public, identity_sealed = excluded.identity_sealed, encryption_public = excluded.encryption_public,
           encryption_sealed = excluded.encryption_sealed, high_seq = excluded.high_seq, enrolled_at = excluded.enrolled_at`,
      ).run(
        s.coreId,
        s.teamId,
        s.linkUrl,
        s.linkHost,
        s.platformKeyId,
        s.platformKey,
        s.identityPublic,
        seal(k, s.identityPkcs8),
        s.encryptionPublic,
        seal(k, s.encryptionPkcs8),
        s.highSeq,
        s.enrolledAt,
      );
    },
    clearLink() {
      db.exec("DELETE FROM link_state; DELETE FROM link_member_keys; DELETE FROM link_reset_codes;");
    },
    openLinkKeys() {
      const r = db.prepare("SELECT identity_sealed, encryption_sealed FROM link_state WHERE id = 1").get() as
        { identity_sealed: string; encryption_sealed: string } | undefined;
      if (!r) return null;
      const k = needKey();
      return { identityPkcs8: open(k, r.identity_sealed), encryptionPkcs8: open(k, r.encryption_sealed) };
    },
    secretKeyForRedaction() {
      return currentKey() ?? null;
    },
    setPlatformKey(keyId, publicKey) {
      const r = db
        .prepare("UPDATE link_state SET platform_key_id = ?, platform_key = ? WHERE id = 1")
        .run(keyId, publicKey);
      if (Number(r.changes) !== 1) throw new Error("this core is not linked");
    },
    setHighSeq(n) {
      const r = db.prepare("UPDATE link_state SET high_seq = ? WHERE id = 1").run(n);
      if (Number(r.changes) !== 1) throw new Error("this core is not linked");
    },
    listMemberKeys() {
      return (
        db.prepare("SELECT * FROM link_member_keys ORDER BY added_at, key_id").all() as unknown as MemberRow[]
      ).map(toMember);
    },
    addMemberKey(k) {
      const addedAt = new Date().toISOString();
      db.prepare(
        "INSERT INTO link_member_keys (key_id, member_id, role, public_key, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(k.keyId, k.memberId, k.role, k.publicKey, addedAt, k.addedBy);
      return { ...k, addedAt };
    },
    removeMemberKey(keyId) {
      db.prepare("DELETE FROM link_member_keys WHERE key_id = ?").run(keyId);
    },
    getMemberKey(keyId) {
      const r = db.prepare("SELECT * FROM link_member_keys WHERE key_id = ?").get(keyId) as MemberRow | undefined;
      return r ? toMember(r) : undefined;
    },
    journalHas(seq, nonce) {
      return (
        db
          .prepare(
            `SELECT 1 AS x FROM link_journal WHERE accepted = 1 AND (nonce = ? OR
             (seq = ? AND core_id = COALESCE((SELECT core_id FROM link_state WHERE id = 1), ''))) LIMIT 1`,
          )
          .get(nonce, seq) !== undefined
      );
    },
    appendJournal(e) {
      // Each row records the link it was received under (the core id linked
      // at that moment; empty while unlinked), for journalHas.
      db.prepare(
        `INSERT INTO link_journal (core_id, instruction_id, at, seq, nonce, tier, method, route, signed_by, status, reason, accepted)
           VALUES (COALESCE((SELECT core_id FROM link_state WHERE id = 1), ''), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.id, e.at, e.seq, e.nonce, e.tier, e.method, e.route, e.signedBy, e.status, e.reason, e.accepted ? 1 : 0);
    },
    setJournalOutcome(nonce, status, reason) {
      db.prepare("UPDATE link_journal SET status = ?, reason = ? WHERE nonce = ? AND accepted = 1").run(
        status,
        reason,
        nonce,
      );
    },
    listJournal({ limit, before }) {
      const rows = (before === undefined
        ? db.prepare("SELECT * FROM link_journal ORDER BY at DESC, row_id DESC LIMIT ?").all(limit)
        : db
            .prepare("SELECT * FROM link_journal WHERE at < ? ORDER BY at DESC, row_id DESC LIMIT ?")
            .all(before, limit)) as unknown as JournalRow[];
      return rows.map(toJournal);
    },
    pruneJournal(olderThan) {
      return Number(db.prepare("DELETE FROM link_journal WHERE at < ?").run(olderThan.toISOString()).changes);
    },
    createResetCode(hash, keyFingerprint, expiresAt) {
      db.prepare(
        "INSERT INTO link_reset_codes (code_hash, expires_at, used_at, key_fingerprint) VALUES (?, ?, NULL, ?)",
      ).run(hash, expiresAt, keyFingerprint);
    },
    useResetCode(hash, now) {
      const r = db
        .prepare(
          "UPDATE link_reset_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND key_fingerprint <> '' RETURNING key_fingerprint",
        )
        .get(now.toISOString(), hash, now.toISOString()) as { key_fingerprint: string } | undefined;
      return r?.key_fingerprint ?? null;
    },
  };
  Object.assign(store, methods);
  return store;
}
