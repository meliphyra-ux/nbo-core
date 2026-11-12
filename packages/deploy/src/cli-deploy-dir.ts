// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { resolve } from "node:path";

// A deployed @nbo/cli bundle (prepareCliDeployDir: `pnpm --filter
// @nbo/cli... build` + `pnpm deploy`) is the same for every environment
// of one build, and two concurrent prepares would race on the same
// workspace dist/ folders. createCliDeployDirCache shares one bundle
// per build, keyed by the build's .nbo/ directory:
//
// - acquire(key) returns the build's bundle, preparing it on first use;
//   every acquirer of the same key while it is alive gets the same dir.
// - hold(key) keeps a build's bundle alive without preparing it (the
//   control-plane runner holds it across its parallel environments, so
//   an environment that reaches its app image later still reuses it).
// - The dir is removed when the last acquirer/holder releases; a later
//   acquire prepares fresh, so every new build still builds the CLI from
//   current source (the C1 property prepareCliDeployDir documents).
// - Prepares never overlap process-wide, even for different builds:
//   they all run `pnpm build` over the same workspace.
//
// Chosen over a per-process cache keyed by the CLI dist's content: that
// would have to hash the dist (and every workspace dependency's) before
// knowing whether to rebuild, i.e. build first anyway, and keep large
// node_modules trees around between builds with no clear owner.
export interface CliDeployDirLease {
  dir: string;
  release(): Promise<void>;
}

export interface CliDeployDirCache {
  acquire(key: string): Promise<CliDeployDirLease>;
  hold(key: string): { release(): Promise<void> };
}

interface Entry {
  refs: number;
  promise?: Promise<string>;
}

export function createCliDeployDirCache(prepare: () => Promise<string>, remove: (dir: string) => Promise<void>): CliDeployDirCache {
  const entries = new Map<string, Entry>();
  let queue: Promise<unknown> = Promise.resolve();
  const prepareSerially = (): Promise<string> => {
    const p = queue.then(() => prepare());
    queue = p.catch(() => {});
    return p;
  };

  const ref = (key: string): Entry => {
    let e = entries.get(key);
    if (!e) {
      e = { refs: 0 };
      entries.set(key, e);
    }
    e.refs++;
    return e;
  };

  const unref = async (key: string, e: Entry): Promise<void> => {
    e.refs--;
    if (e.refs > 0) return;
    if (entries.get(key) === e) entries.delete(key);
    if (!e.promise) return;
    let dir: string;
    try {
      dir = await e.promise;
    } catch {
      return;
    }
    try {
      await remove(dir);
    } catch {
      // Best-effort cleanup of a temp dir.
    }
  };

  const once = (fn: () => Promise<void>) => {
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      await fn();
    };
  };

  return {
    async acquire(rawKey) {
      const key = resolve(rawKey);
      const e = ref(key);
      if (!e.promise) {
        const p = prepareSerially();
        e.promise = p;
        // A failed prepare is not cached: the next acquire retries.
        p.catch(() => {
          if (e.promise === p) e.promise = undefined;
        });
      }
      let dir: string;
      try {
        dir = await e.promise;
      } catch (err) {
        await unref(key, e);
        throw err;
      }
      return { dir, release: once(() => unref(key, e)) };
    },
    hold(rawKey) {
      const key = resolve(rawKey);
      const e = ref(key);
      return { release: once(() => unref(key, e)) };
    },
  };
}
