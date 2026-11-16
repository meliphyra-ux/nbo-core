// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { redact } from "@nbo/deploy";
import { ErrNotFound, type Environment, type Store } from "../store/store.js";
import type { SuppliedValues } from "../variables/supplied-values.js";
import type { EdgeSync } from "../edge/edge-sync.js";
import type { CloudTeardown } from "../clouds/cloud-teardown.js";
import type { CertWriter } from "../domains/certs.js";
import type { Mode } from "../mode.js";
import { hasOwnHost, type Stage } from "./stages.js";
import { deployAppName, googleSecrets, kubeconfigSecrets } from "../deploys/deploy.js";
import { certSecretName } from "../edge/edge-manifests.js";

// Ephemeral stages expire on their own: a pass every 10 minutes removes
// every ephemeral stage whose expiresAt has passed, and retries failed
// removals with backoff. Core does this itself, so ephemeral stages stop
// running (and costing cloud money) even when whoever made them is gone.
// Removal deletes only the stage's own objects: its domain rows, its route,
// its certificate Secret and its own app (teardown scope "app", with every
// other cloud row of the project kept). The stage row stays, "removed",
// with its builds in history.

export interface ExpiryDeps {
  store: Store;
  edgeSync: EdgeSync;
  cloudTeardown: CloudTeardown;
  certs: Pick<CertWriter, "deleteCert">;
  mode: Mode;
  // supplied: the names-only values held for queued jobs; a build removal
  // skips has its values dropped at once.
  supplied?: Pick<SuppliedValues, "drop">;
  now?: () => Date;
}

export type RemovalReason = "expired" | "manual";

const MIN = 60_000;
// Retries of a failed removal: 10 minutes, 1 hour, then every 6 hours.
export const removalBackoffMs = [10 * MIN, 60 * MIN, 6 * 60 * MIN];
export const expiryEveryMs = 10 * MIN;
export const stageRemovedNote = "ephemeral environment removed";
const maxErrorLength = 2000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const nowOf = (deps: ExpiryDeps): Date => (deps.now ?? (() => new Date()))();

// dueReason: why the pass removes the stage now, or null to leave it.
function dueReason(s: Stage, now: Date): RemovalReason | null {
  if (s.kind !== "ephemeral") return null;
  if (s.removal === "removing") return "expired";
  if (s.removal === "removal-failed") {
    const due = s.nextAttemptAt === "" || Date.parse(s.nextAttemptAt) <= now.getTime();
    return due ? "expired" : null;
  }
  if (s.removal !== "") return null;
  if (s.expiresAt === "") return null;
  const at = Date.parse(s.expiresAt);
  return Number.isFinite(at) && at <= now.getTime() ? "expired" : null;
}

// scrub: a teardown error as it may be stored and shown: no credential of
// the cloud it ran against, no PEM block, bounded.
function scrub(store: Store, mode: Mode, env: Environment | undefined, err: unknown): string {
  const secrets: string[] = [];
  if (env && mode === "production") {
    try {
      if (env.target === "kubernetes") {
        const clusterId = (JSON.parse(env.config) as { clusterId?: unknown }).clusterId;
        if (typeof clusterId === "string" && store.getKubernetesConnection(clusterId)) {
          const s = store.getKubernetesSecrets(clusterId);
          secrets.push(...kubeconfigSecrets(s.kubeconfig), s.registryPassword ?? "");
        }
      } else if (env.target === "cloudrun" && store.getGoogleConnection()) {
        secrets.push(...googleSecrets(store.getGoogleSecrets()));
      }
    } catch {
      // nothing more to scrub with
    }
  }
  const s = redact(errText(err), secrets.filter(Boolean)).replace(
    /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g,
    "[redacted]",
  );
  return s.length > maxErrorLength ? `${s.slice(0, maxErrorLength)}…` : s;
}

// skipQueued skips the stage's queued builds (dropping the values they
// held) and says whether one is running.
function skipQueued(deps: ExpiryDeps, projectId: string, stageId: string): boolean {
  const { store } = deps;
  let running = false;
  for (const b of store.listBuilds(projectId)) {
    if (b.stageId !== stageId) continue;
    if (b.status === "running") running = true;
    if (b.status === "queued") {
      store.setBuildDetails(b.id, { note: stageRemovedNote });
      store.completeBuild(b.id, "skipped");
      deps.supplied?.drop(b.id);
    }
  }
  return running;
}

// failRemoval records a failed attempt with its backoff.
function failRemoval(deps: ExpiryDeps, stage: Stage, error: string): void {
  const attempts = deps.store.getStage(stage.id).removalAttempts + 1;
  const wait = removalBackoffMs[Math.min(attempts, removalBackoffMs.length) - 1]!;
  console.error(`control-plane: removing environment ${stage.name} (${stage.id}) failed: ${error}`);
  deps.store.updateStage(stage.id, {
    removal: "removal-failed",
    removalError: error,
    removalAttempts: attempts,
    nextAttemptAt: new Date(nowOf(deps).getTime() + wait).toISOString(),
  });
}

// heldElsewhere: is host the address of anything still routed besides
// stageId: a project, a stage with its own host, or a domain row?
function heldElsewhere(store: Store, host: string, stageId: string): boolean {
  if (store.listDomains().some((d) => d.host === host)) return true;
  for (const p of store.listProjects()) {
    if (p.edgeHost === host) return true;
    if (
      store
        .listStages(p.id, { includeEphemeral: true })
        .some((s) => s.id !== stageId && hasOwnHost(s) && s.host === host)
    )
      return true;
  }
  return false;
}

// removeOne runs the four steps for one stage. A running build of it
// leaves the stage "removing" for the next pass.
async function removeOne(deps: ExpiryDeps, stageId: string, reason: RemovalReason): Promise<void> {
  const { store } = deps;
  let stage: Stage;
  try {
    stage = store.getStage(stageId);
  } catch (err) {
    if (err instanceof ErrNotFound) return;
    throw err;
  }
  if (stage.kind !== "ephemeral" || stage.removal === "removed") return;
  const projectId = stage.projectId;

  // 1. Mark it removing (its address stops routing: hasOwnHost is false
  // from here on), skip its queued builds; wait for a running one.
  if (stage.removal === "")
    console.error(`control-plane: removing environment ${stage.name} (${stage.id}) of project ${projectId}: ${reason}`);
  if (stage.removal !== "removal-failed") stage = store.updateStage(stageId, { removal: "removing" });
  if (skipQueued(deps, projectId, stageId)) {
    if (stage.removal === "removal-failed") store.updateStage(stageId, { removal: "removing" });
    return;
  }

  // 2. Its route off the edge: the records first (domain rows), so a
  // reconcile can't push it back. The row keeps its host.
  const ownDomains = store.listDomains(projectId).filter((d) => d.stageId === stageId);
  for (const d of ownDomains) store.deleteDomain(d.id);
  const host = stage.host;
  if (host !== "" && !heldElsewhere(store, host, stageId)) {
    try {
      await deps.edgeSync.remove(host);
    } catch (err) {
      console.error(`control-plane: removing ${host} from the edge failed: ${errText(err)}`);
    }
  }
  // Certificate Secrets: of its domain rows, and of its own host on every
  // attempt (a failed deletion is retried after the rows are gone), unless
  // something else took the host since (a new stage on the same address,
  // whose Secret it is now).
  let certError = "";
  if (deps.mode === "production" && store.getServerSettings().edgeClusterId !== "") {
    const certHosts = [...new Set([...ownDomains.map((d) => d.host), host])].filter(
      (h) => h !== "" && !heldElsewhere(store, h, stageId),
    );
    if (certHosts.length > 0) {
      // The table first, so the edge is never told to use a Secret that is gone.
      try {
        await deps.edgeSync.push(projectId);
      } catch (err) {
        console.error(
          `control-plane: environment ${stage.name} left the records, but updating the edge route table failed: ${errText(err)}`,
        );
      }
      for (const h of certHosts) {
        try {
          await deps.certs.deleteCert(certSecretName(h));
        } catch (err) {
          certError = `deleting the certificate Secret of ${h} failed: ${scrub(store, deps.mode, undefined, err)}`;
        }
      }
    }
  }

  // 3. Its own app on each of its clouds, never the namespace or another
  // row's objects.
  const own = store.listEnvironments(projectId, { stageId });
  const keep = store
    .listEnvironments(projectId, { allStages: true, includeArchived: true })
    .filter((e) => e.stageId !== stageId)
    .map(deployAppName);
  for (const env of own) {
    try {
      await deps.cloudTeardown.remove({
        target: env.target,
        appName: deployAppName(env),
        projectId,
        config: JSON.parse(env.config) as Record<string, unknown>,
        scope: "app",
        keep,
      });
    } catch (err) {
      failRemoval(deps, stage, scrub(store, deps.mode, env, err));
      return;
    }
  }
  // A build queued another way (the API refuses one, but an older path may
  // not) during the teardown is skipped; one that started running waits
  // for the next pass, which tears down again.
  if (skipQueued(deps, projectId, stageId)) {
    store.updateStage(stageId, { removal: "removing" });
    return;
  }
  // A certificate Secret left behind: retried with the usual backoff.
  if (certError !== "") {
    failRemoval(deps, stage, certError);
    return;
  }

  // 4. Archive its cloud rows and mark it removed.
  for (const env of own) store.archiveEnvironment(env.id);
  store.updateStage(stageId, {
    removal: "removed",
    removalError: "",
    nextAttemptAt: "",
    removedAt: nowOf(deps).toISOString(),
  });
}

async function pass(deps: ExpiryDeps): Promise<void> {
  const { store } = deps;
  const now = nowOf(deps);
  for (const project of store.listProjects()) {
    for (const s of store.listStages(project.id, { includeEphemeral: true })) {
      const reason = dueReason(s, now);
      if (reason === null) continue;
      try {
        await removeOne(deps, s.id, reason);
      } catch (err) {
        console.error(`control-plane: removing environment ${s.name} (${s.id}) failed: ${errText(err)}`);
      }
    }
  }
}

// One chain per store: passes and single removals never overlap. A pass
// requested while one runs is queued once; later requests join it.
interface Chain {
  tail: Promise<unknown>;
  pending: Promise<void> | null;
}
const chains = new WeakMap<Store, Chain>();

function chainOf(store: Store): Chain {
  let c = chains.get(store);
  if (!c) {
    c = { tail: Promise.resolve(), pending: null };
    chains.set(store, c);
  }
  return c;
}

function enqueue<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const c = chainOf(store);
  const next = c.tail.then(fn);
  c.tail = next.catch(() => undefined);
  return next;
}

// expiryPass removes every ephemeral stage that is due (see dueReason).
export function expiryPass(deps: ExpiryDeps): Promise<void> {
  const c = chainOf(deps.store);
  if (c.pending) return c.pending;
  const p = enqueue(deps.store, async () => {
    c.pending = null;
    await pass(deps);
  });
  c.pending = p;
  return p;
}

// removeStage removes one ephemeral stage now (DELETE on the stage, a retry),
// after any pass already running.
export function removeStage(deps: ExpiryDeps, stageId: string, reason: RemovalReason): Promise<void> {
  return enqueue(deps.store, () => removeOne(deps, stageId, reason));
}

// runStageExpiry runs a pass every 10 minutes until signal aborts.
export async function runStageExpiry(deps: ExpiryDeps, signal: AbortSignal, everyMs = expiryEveryMs): Promise<void> {
  while (!signal.aborted) {
    try {
      await expiryPass(deps);
    } catch (err) {
      console.error(`control-plane: the expiry pass failed: ${errText(err)}`);
    }
    await new Promise<void>((resolve) => {
      // Aborted during the tick: no wait, the loop ends.
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, everyMs);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
