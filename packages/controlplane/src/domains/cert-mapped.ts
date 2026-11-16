// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Domains Google serves through a Cloud Run domain mapping, and removing a mapping a moved domain kept.
import { MappingNotVerifiedError } from "./cloudrun-domains.js";
import type { LoopCtx } from "./cert-loop-ctx.js";
import {
  backoffMs,
  cleanError,
  dailyMs,
  errText,
  mappingKeepMs,
  mappingRetryMs,
  reachRetryMs,
  removalPrefix,
  unknownRetryMs,
  withoutRemovalWarning,
} from "./cert-policy.js";

// Domains served through a Cloud Run mapping take this path instead of the edge's: Google decides readiness.
export function createMapped(ctx: LoopCtx) {
  const { deps, store, now, due } = ctx;
  const nextMappingRemoval = new Map<string, number>();

  // advanceMapped drives a domain Google serves through a domain mapping:
  // verify_pending (create the mapping once the domain is verified) →
  // cert_pending (Google issues the certificate) → active (checked daily).
  // It never touches DNS checks, ACME or the edge.
  async function advanceMapped(id: string, force: boolean): Promise<void> {
    const cloudRun = deps.cloudRun;
    if (!cloudRun) return;
    const d = store.getDomain(id);
    const at = (ms: number): string => new Date(now().getTime() + ms).toISOString();
    const checkedAt = now().toISOString();
    if (!force && !due(d)) return;
    const target = cloudRun.targetFor(d.projectId);
    if (target === null) {
      store.updateDomain(id, {
        lastError: "This project has no Cloud Run environment to serve the domain from",
        checkedAt,
        nextAttemptAt: at(mappingRetryMs),
      });
      return;
    }
    try {
      if (d.status === "verify_pending" || d.status === "failed") {
        try {
          await cloudRun.create(target, d.host);
        } catch (err) {
          if (!(err instanceof MappingNotVerifiedError)) throw err;
          store.updateDomain(id, {
            status: "verify_pending",
            lastError: "",
            checkedAt,
            nextAttemptAt: at(mappingRetryMs),
          });
          return;
        }
        const state = await cloudRun.describe(target, d.host);
        store.updateDomain(id, {
          status: "cert_pending",
          mappingRecords: state?.records ?? [],
          lastError: "",
          failures: 0,
          checkedAt,
          nextAttemptAt: "",
        });
        return;
      }
      const state = await cloudRun.describe(target, d.host);
      if (state === null) {
        const lost = d.status === "active";
        store.updateDomain(id, {
          status: "verify_pending",
          warning: "",
          ...(lost
            ? { mappingRecords: [], lastError: "Google no longer has this mapping, so NBO is recreating it." }
            : {}),
          checkedAt,
          nextAttemptAt: "",
        });
        return;
      }
      if (d.status === "cert_pending") {
        if (state.ready) {
          store.updateDomain(id, {
            status: "active",
            mappingRecords: state.records,
            lastError: "",
            warning: "",
            failures: 0,
            checkedAt,
            nextAttemptAt: at(dailyMs),
          });
        } else {
          store.updateDomain(id, {
            mappingRecords: state.records,
            lastError: cleanError(state.message || "Waiting for Google to issue the certificate", []),
            checkedAt,
            nextAttemptAt: at(mappingRetryMs),
          });
        }
        return;
      }
      // active
      store.updateDomain(id, {
        mappingRecords: state.records,
        lastError: "",
        warning: state.ready ? "" : cleanError(state.message || "Google reports this domain is not ready", []),
        checkedAt,
        nextAttemptAt: at(dailyMs),
      });
    } catch (err) {
      const msg = cleanError(errText(err), []);
      if (d.status === "verify_pending" || d.status === "failed") {
        const failures = d.failures + 1;
        store.updateDomain(id, {
          status: "failed",
          lastError: msg,
          failures,
          checkedAt,
          nextAttemptAt: at(backoffMs[Math.min(failures, backoffMs.length) - 1]!),
        });
      } else {
        store.updateDomain(id, {
          lastError: msg,
          checkedAt,
          nextAttemptAt: at(d.status === "active" ? unknownRetryMs : mappingRetryMs),
        });
      }
    }
  }

  // removeKeptMapping: a domain moved to the edge keeps Google's mapping
  // until 24 hours after the edge serves it; a failed removal stays flagged
  // and retries. Check now never shortens the wait.
  async function removeKeptMapping(id: string, force: boolean): Promise<void> {
    const d = store.getDomain(id);
    if (!d.mappingKept || d.status !== "active" || !deps.cloudRun) return;
    if (d.mappingRemoveAfter === "") {
      store.updateDomain(id, { mappingRemoveAfter: new Date(now().getTime() + mappingKeepMs).toISOString() });
      return;
    }
    if (now().getTime() < Date.parse(d.mappingRemoveAfter)) return;
    if (!force && now().getTime() < (nextMappingRemoval.get(id) ?? 0)) return;
    const fail = (msg: string): void => {
      nextMappingRemoval.set(id, now().getTime() + reachRetryMs);
      const base = withoutRemovalWarning(d.warning, d.host);
      store.updateDomain(id, { warning: [base, removalPrefix(d.host) + msg].filter((w) => w !== "").join(" ") });
    };
    const target = deps.cloudRun.targetFor(d.projectId);
    if (target === null) {
      fail("this project has no Cloud Run environment");
      return;
    }
    try {
      await deps.cloudRun.remove(target, d.host);
    } catch (err) {
      const msg = cleanError(errText(err), []);
      console.error(`control-plane: domains: ${d.host}: removing the Cloud Run domain mapping failed: ${msg}`);
      fail(msg);
      return;
    }
    nextMappingRemoval.delete(id);
    store.updateDomain(id, {
      mappingKept: false,
      mappingRemoveAfter: "",
      mappingRecords: [],
      warning: withoutRemovalWarning(store.getDomain(id).warning, d.host),
    });
  }

  return { advanceMapped, removeKeptMapping };
}
