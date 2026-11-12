// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// DEFAULT_MAX_BYTES is the cache's memory budget: 96 MiB.
export const DEFAULT_MAX_BYTES = 100663296;

// Entry is one cached render. tags and path exist purely so
// invalidateTags/invalidatePaths can find entries to remove — the
// store does not interpret either otherwise — port of Entry
// (store.go lines 25-33).
export interface Entry {
  body: Uint8Array;
  header?: Record<string, string[]>;
  tags?: string[];
  path?: string;
  // status is the render's HTTP status (200, 404, a redirect…). Absent
  // means 200.
  status?: number;
}

// State classifies a present entry; a missing or past-expireSec
// entry never gets one — get's return value is undefined instead —
// port of State/Fresh/Stale (store.go lines 16-23).
export type State = "fresh" | "stale";

interface StoredEntry {
  entry: Entry;
  size: number;
  revalidateAt: number;
  expireAt: number;
}

export interface Store {
  set(key: string, entry: Entry, revalidateSec: number, expireSec: number): void;
  get(key: string): { entry: Entry; state: State } | undefined;
  invalidateTags(tags: string[]): void;
  invalidatePaths(paths: string[]): void;
}

// createStore holds every cached entry in memory, within the one,
// separately deployed cache-service process every app instance on
// either cloud reaches over HTTP (cmd/isrcache) — never per-app-
// instance state. No lock needed: every method below runs to
// completion with no `await` inside it, so two calls can never
// interleave on Node's single-threaded event loop — port of Store
// (store.go lines 41-127).
export function createStore(opts: { maxBytes?: number; now?: () => number } = {}): Store {
  const entries = new Map<string, StoredEntry>();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`isrcache: maxBytes must be a positive number, got ${maxBytes}`);
  }
  const clock = opts.now ?? Date.now;
  let usedBytes = 0;

  // remove drops one entry and frees its bytes.
  function remove(key: string): void {
    const stored = entries.get(key);
    if (!stored) return;
    usedBytes -= stored.size;
    entries.delete(key);
  }

  return {
    set(key, entry, revalidateSec, expireSec) {
      // Body and header bytes, plus the key, tags and path, so many small
      // entries with long keys or tags still count against the budget.
      const size =
        entry.body.byteLength +
        Buffer.byteLength(JSON.stringify(entry.header ?? {})) +
        Buffer.byteLength(key) +
        (entry.tags ?? []).reduce((n, t) => n + Buffer.byteLength(t), 0) +
        Buffer.byteLength(entry.path ?? "");
      // Replacing a key frees the old entry first. An entry over a
      // quarter of the limit is refused (and the old one stays gone, so
      // a stale render is never served after a newer one was rejected).
      remove(key);
      if (size > maxBytes / 4) return;
      // A Map iterates in insertion order: the first key is the least
      // recently used one.
      while (usedBytes + size > maxBytes) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        remove(oldest.value);
      }
      const now = clock();
      entries.set(key, {
        entry,
        size,
        revalidateAt: now + revalidateSec * 1000,
        expireAt: now + expireSec * 1000,
      });
      usedBytes += size;
    },

    get(key) {
      const stored = entries.get(key);
      if (!stored) return undefined;
      // "at or after" (>=), not "after" (>): a revalidateSec/expireSec
      // of 0 must take effect immediately, including at the exact
      // instant computed in set — and two Date.now() calls close
      // enough together can read back equal, which a strict ">"
      // would wrongly read as "still fresh".
      const now = clock();
      if (now >= stored.expireAt) {
        remove(key);
        return undefined;
      }
      // A hit makes the entry the most recently used.
      entries.delete(key);
      entries.set(key, stored);
      if (now >= stored.revalidateAt) return { entry: stored.entry, state: "stale" };
      return { entry: stored.entry, state: "fresh" };
    },

    invalidateTags(tags) {
      const want = new Set(tags);
      for (const [key, stored] of entries) {
        if (stored.entry.tags?.some((t) => want.has(t))) {
          remove(key);
        }
      }
    },

    invalidatePaths(paths) {
      const want = new Set(paths);
      for (const [key, stored] of entries) {
        if (stored.entry.path !== undefined && want.has(stored.entry.path)) {
          remove(key);
        }
      }
    },
  };
}
