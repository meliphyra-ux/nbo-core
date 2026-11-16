// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { redact } from "@nbo/deploy";
import type { Store } from "../store/store.js";
import { secretNames } from "../store/server-settings.js";

// The outbound filter: the second line after the handlers (which already
// leave secrets out of what an API token sees). Every reply that goes up the
// link passes here, so no secret core holds can leave it even if a handler
// echoes one.

// withheldKeys: a field with one of these names (any case, any depth) never
// crosses the link, whatever it holds.
export const withheldKeys: readonly string[] = [
  "value",
  "values",
  "secret",
  "token",
  "webhookSecret",
  "kubeconfig",
  "keyJson",
  "deployerKey",
  "pullerKey",
  "registryPassword",
  "privateKey",
  "keyPem",
  "caKeyPem",
  "password",
  "sealed",
];
const withheldLower = new Set(withheldKeys.map((k) => k.toLowerCase()));
export const WITHHELD = "[withheld over the link]";
const REDACTED = "[redacted]";
// A known secret shorter than this is not redacted inside strings: it would
// mangle ordinary words in structured answers (as the build log's rule for
// plain values). Withheld keys are withheld whatever their length.
export const MIN_REDACTED_LENGTH = 6;

// SecretSources: secrets core holds in memory, outside the store.
export interface SecretSources {
  // supplied: variable values deploy requests brought (names-only mode).
  supplied?: { values(): string[] };
  // github: installation tokens of the old per-server GitHub App.
  github?: { cachedTokens(): string[] };
}

const tryAll = (f: () => void): void => {
  try {
    f();
  } catch {
    // A row core can't open (or that is gone) has nothing to redact.
  }
};

// knownSecrets: every secret core holds that a reply could echo: variable
// values (secrets of any length, plain values of 6+ characters), git
// tokens and deploy keys, webhook secrets, revalidation secrets, cron
// signing secrets, relay tokens and keys, cloud credentials, certificate
// keys, server secrets, the link's own private keys, the secret key itself
// (hex and base64), and what sources hold in memory.
export function knownSecrets(store: Store, sources: SecretSources = {}): string[] {
  const out: string[] = [];
  const add = (v: string | undefined | null): void => {
    if (typeof v === "string" && v !== "") out.push(v);
  };
  tryAll(() => store.envValuesForRedaction().forEach(add));
  tryAll(() => {
    const keys = store.openLinkKeys();
    if (keys) {
      add(keys.identityPkcs8);
      add(keys.encryptionPkcs8);
    }
  });
  let projects: { id: string }[] = [];
  tryAll(() => (projects = store.listProjects()));
  for (const p of projects) {
    tryAll(() => add(store.openGitCredential(p.id)));
    tryAll(() => add(store.getWebhookSecret(p.id)));
    tryAll(() => {
      for (const s of store.listStages(p.id, { includeEphemeral: true }))
        tryAll(() => add(store.getRevalidateToken(s.id)?.token));
    });
    tryAll(() => {
      for (const e of store.listEnvironments(p.id, { includeArchived: true, allStages: true }))
        tryAll(() => add(store.getCronSigningSecret(e.id)));
    });
  }
  tryAll(() => {
    for (const c of store.listKubernetesConnections()) {
      tryAll(() => {
        const s = store.getKubernetesSecrets(c.id);
        add(s.kubeconfig);
        add(s.registryPassword);
      });
      tryAll(() => {
        const r = store.getRelay(c.id);
        if (r) [r.token, r.caKeyPem, r.keyPem].forEach(add);
      });
    }
  });
  tryAll(() => {
    const g = store.getGoogleSecrets();
    add(g.deployerKey);
    add(g.pullerKey);
  });
  tryAll(() => {
    for (const d of store.listDomains()) {
      tryAll(() => add(store.getPendingCert(d.id)?.keyPem));
      tryAll(() => add(store.getPastedCert(d.id)?.keyPem));
    }
  });
  for (const name of secretNames) tryAll(() => add(store.getServerSecret(name)));
  tryAll(() => {
    const k = store.secretKeyForRedaction();
    if (k) for (const enc of ["hex", "base64", "base64url"] as const) add(k.toString(enc));
  });
  tryAll(() => sources.supplied?.values().forEach(add));
  tryAll(() => sources.github?.cachedTokens().forEach(add));
  return [...new Set(out)];
}

// forms: each secret of MIN_REDACTED_LENGTH or more as it may appear in a
// reply: as is, and escaped inside a JSON string (a key's line breaks become
// \n). redact adds base64 of each.
function forms(secrets: string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    if (s.length < MIN_REDACTED_LENGTH) continue;
    out.add(s);
    out.add(JSON.stringify(s).slice(1, -1));
  }
  return [...out];
}

// filterJson: withheld keys become WITHHELD, and every known secret (6+
// characters) inside any string value becomes [redacted]; keys are never
// changed. Own properties only; the result is built with Object.fromEntries
// so a "__proto__" key stays a plain key.
export function filterJson(body: unknown, secrets: string[]): unknown {
  const list = forms(secrets);
  const scrub = (s: string): string => (list.length ? redact(s, list) : s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.keys(v).map((k) => [
          k,
          withheldLower.has(k.toLowerCase()) ? WITHHELD : walk((v as Record<string, unknown>)[k]),
        ]),
      );
    }
    return v;
  };
  return walk(body);
}

// Byte forms for the stream filter: as is, JSON-escaped, and base64 of each.
function byteForms(secrets: string[]): Buffer[] {
  const out = new Map<string, Buffer>();
  for (const f of forms(secrets)) {
    for (const s of [f, Buffer.from(f).toString("base64")]) out.set(s, Buffer.from(s, "utf8"));
  }
  return [...out.values()].filter((b) => b.length > 0);
}

// spansIn: every occurrence of every form in buf, merged where they overlap
// or touch, sorted by start.
function spansIn(buf: Buffer, list: Buffer[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const f of list) {
    for (let i = buf.indexOf(f); i !== -1; i = buf.indexOf(f, i + 1)) spans.push([i, i + f.length]);
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

const redactedBytes = Buffer.from(REDACTED, "utf8");

function replaceSpans(buf: Buffer, spans: [number, number][]): Buffer {
  if (spans.length === 0) return buf;
  const parts: Buffer[] = [];
  let pos = 0;
  for (const [s, e] of spans) {
    parts.push(buf.subarray(pos, s), redactedBytes);
    pos = e;
  }
  parts.push(buf.subarray(pos));
  return Buffer.concat(parts);
}

// filterStream: redacts known secrets in a byte stream. It works on bytes,
// so a stream with no secret in it passes byte for byte (binary files
// included), and holds back the last (longest form - 1) bytes of each chunk,
// so a secret cut across two chunks is still caught.
export async function* filterStream(chunks: AsyncIterable<Uint8Array>, secrets: string[]): AsyncIterable<Uint8Array> {
  const list = byteForms(secrets);
  if (list.length === 0) {
    for await (const c of chunks) yield c;
    return;
  }
  const keep = Math.max(...list.map((f) => f.length)) - 1;
  let carry: Buffer = Buffer.alloc(0);
  for await (const c of chunks) {
    const buf = carry.length === 0 ? Buffer.from(c) : Buffer.concat([carry, c]);
    const spans = spansIn(buf, list);
    // Everything before cut is final: any form starting before cut ends
    // inside buf. A span crossing cut is emitted whole.
    let cut = Math.max(0, buf.length - keep);
    for (const [s, e] of spans) if (s < cut && e > cut) cut = e;
    const done = spans.filter(([, e]) => e <= cut);
    const out = replaceSpans(buf.subarray(0, cut), done);
    carry = Buffer.from(buf.subarray(cut));
    if (out.length > 0) yield new Uint8Array(out);
  }
  if (carry.length > 0) yield new Uint8Array(replaceSpans(carry, spansIn(carry, list)));
}
