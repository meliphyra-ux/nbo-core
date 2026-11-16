// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Certificate loop constants, messages, ephemeral cap helpers and error cleaning.
import { redact } from "@nbo/deploy";
import type { Store } from "../store/store.js";
import type { Domain } from "./domains.js";
import { ephemeralCertWindowMs } from "./ephemeral-certs.js";

export const noEmailMessage = "Set the Let's Encrypt email first (nbo-server domains settings --acme-email <address>)";
export const edgeClusterGoneMessage =
  "The edge's cluster is no longer connected. Connect it again or install the edge on another cluster first";

// The ephemeral certificate cap: NBO orders at most 20 certificates for
// ephemeral environments' hosts in any 7 days per registered domain, so
// Let's Encrypt's 50 a week leave room for Production, custom environments
// and renewals.
const ephemeralCertCap = 20;
export const ephemeralCertCapWarning =
  "Waiting: NBO's weekly limit for ephemeral environments' certificates is reached";
// The same warning in the words earlier NBO versions stored on a domain row.
export const legacyCapWarning = "Waiting: NBO's weekly limit for preview certificates is reached";

// registeredDomainOf: an ephemeral host minus its first label (the base
// domain, or the IP-dashed sslip.io name).
export function registeredDomainOf(host: string): string {
  const i = host.indexOf(".");
  return i < 0 ? host : host.slice(i + 1);
}

export function ephemeralCertCapReached(store: Store, registeredDomain: string, now: Date): boolean {
  return (
    store.countEphemeralCertOrders(registeredDomain, new Date(now.getTime() - ephemeralCertWindowMs).toISOString()) >=
    ephemeralCertCap
  );
}

// isEphemeralDomain: does the row belong to an ephemeral stage?
export function isEphemeralDomain(store: Store, d: Domain): boolean {
  if (d.stageId === "") return false;
  try {
    return store.getStage(d.stageId).kind === "ephemeral";
  } catch {
    return false;
  }
}

export const withoutOne = (warning: string, w: string): string =>
  warning.replace(` ${w}`, "").replace(`${w} `, "").replace(w, "").trim();
export const withoutCapWarning = (warning: string): string =>
  withoutOne(withoutOne(warning, ephemeralCertCapWarning), legacyCapWarning);

// moveRefusal says why no domain can move to the edge right now, or "": the
// edge could never get the certificate. Without it, HTTPS would stay down.
export function moveRefusal(store: Store): string {
  const { acmeEmail, edgeClusterId } = store.getServerSettings();
  if (acmeEmail === "") return noEmailMessage;
  if (!store.getKubernetesConnection(edgeClusterId)) return edgeClusterGoneMessage;
  return "";
}

export const tickMs = 60_000;
export const checkNowEveryMs = 60_000;
export const probeEveryMs = 2_000;
export const probeForMs = 30_000;
// The edge's two replicas each poll the table every 5 s, and a probe reaches
// only one: one poll later, the other has the challenge too.
export const replicaPickupMs = 6_000;
export const renewBeforeMs = 30 * 24 * 3_600_000;
export const dailyMs = 24 * 3_600_000;
export const reachRetryMs = 5 * 60_000;
export const mappingRetryMs = 5 * 60_000;
// How long a moved domain's mapping outlives Active: visitors with cached DNS
// still reach Google.
export const mappingKeepMs = 24 * 3_600_000;
// A cluster outage must not hold the serial queue on every tick: each
// failed write can take kubectl's full timeout.
export const pastedRetryMs = 3_600_000;
// A blip at activation must not hide a warning for a whole day.
export const unknownRetryMs = 3_600_000;
export const backoffMs = [3_600_000, 6 * 3_600_000, 24 * 3_600_000];

// The warning of a mapping that could not be removed always ends the row's
// warning, so it can be found by its prefix and taken out alone.
export const removalPrefix = (host: string): string => `NBO can't remove the old Cloud Run mapping for ${host}: `;
export function removalWarningIn(warning: string, host: string): string {
  const i = warning.indexOf(removalPrefix(host));
  return i < 0 ? "" : warning.slice(i);
}
export const withoutRemovalWarning = (warning: string, host: string): string => {
  const i = warning.indexOf(removalPrefix(host));
  return (i < 0 ? warning : warning.slice(0, i)).trim();
};

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// cleanError: what may be stored as lastError (shown in the dashboard) —
// no PEM block (account key, certificate key) and not unbounded.
export function cleanError(msg: string, secrets: string[]): string {
  const s = redact(msg, secrets).replace(
    /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g,
    "[redacted]",
  );
  return s.length > 1000 ? `${s.slice(0, 1000)}…` : s;
}
