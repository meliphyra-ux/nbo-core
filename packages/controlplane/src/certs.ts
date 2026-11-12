// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Domains and certificates (spec A5): the control-plane checks each
// domain's DNS, gets a Let's Encrypt certificate over HTTP-01 through the
// public edge (the challenge answer goes into the route table), stores it
// as the host's TLS Secret in nbo-edge, and renews it with < 30 days left.
// A domain behind Cloudflare proves its path with a real request instead of
// its DNS answer, and may carry a pasted Origin CA certificate instead.
import { X509Certificate, randomBytes } from "node:crypto";
import { request } from "node:http";
import * as acmeLib from "acme-client";
import type { ClientAutoOptions } from "acme-client";
import { redact, type CommandRunner } from "@nbo/deploy";
import type { Store } from "./store.js";
import type { PendingCert } from "./server-settings.js";
import type { Domain } from "./domains.js";
import { MappingNotVerifiedError, type CloudRunDomains } from "./cloudrun-domains.js";
import type { EdgeSync } from "./edge-sync.js";
import { dnsPointsAtEdge, type Resolver } from "./dns-check.js";
import { EDGE_VERSION, certSecretName, renderCertSecret } from "./edge-manifests.js";
import { withEdgeCluster } from "./edge-table.js";
import {
  brokenWarning,
  flexibleCheck,
  flexibleWarning,
  hostUnreachableWarning,
  noRecordWarning,
  notProxiedWarning,
  pathWarningIn,
  reachCheck,
  renewalAlwaysHttpsMessage,
  validatePastedCert,
  type ReachResult,
} from "./cloudflare-check.js";
import type { CloudflareRanges } from "./cloudflare-ranges.js";
import { ErrConflict } from "./errors.js";
import { ephemeralCertWindowMs } from "./ephemeral-certs.js";

export interface AcmeClient {
  issue(host: string, onChallenge: (token: string, keyAuth: string) => Promise<void>, onCleanup: (token: string) => Promise<void>): Promise<{ certPem: string; keyPem: string; notAfter: string }>;
}

// AcmeLib is the slice of acme-client createAcmeClient uses (tests fake it).
export interface AcmeLib {
  directory: { production: string; staging: string };
  createPrivateKey(): Promise<Buffer>;
  createCsr(data: { commonName: string; altNames: string[] }): Promise<[Buffer, Buffer]>;
  createClient(opts: { directoryUrl: string; accountKey: string }): { auto(opts: ClientAutoOptions): Promise<string> };
}

const realAcmeLib: AcmeLib = {
  directory: acmeLib.directory.letsencrypt,
  createPrivateKey: () => acmeLib.crypto.createPrivateKey(),
  createCsr: (data) => acmeLib.crypto.createCsr(data),
  createClient: (opts) => new acmeLib.Client(opts),
};

// createAcmeClient: one Let's Encrypt account per NBO; its key is created
// on first use and kept sealed (platform secret acme_account_key).
export function createAcmeClient(store: Store, lib: AcmeLib = realAcmeLib): AcmeClient {
  let creatingKey: Promise<string> | null = null;
  const accountKey = (): Promise<string> => {
    const existing = store.getServerSecret("acme_account_key");
    if (existing) return Promise.resolve(existing);
    creatingKey ??= lib
      .createPrivateKey()
      .then((k) => {
        const pem = k.toString();
        store.setServerSecret("acme_account_key", pem);
        return pem;
      })
      .finally(() => {
        creatingKey = null;
      });
    return creatingKey;
  };
  return {
    async issue(host, onChallenge, onCleanup) {
      const settings = store.getServerSettings();
      const client = lib.createClient({ directoryUrl: lib.directory[settings.acmeDirectory], accountKey: await accountKey() });
      const [key, csr] = await lib.createCsr({ commonName: host, altNames: [host] });
      const certPem = await client.auto({
        csr,
        email: settings.acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ["http-01"],
        // The domain loop already proved the edge serves the answer
        // (through the edge's own address, as Let's Encrypt will see it).
        skipChallengeVerification: true,
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => onChallenge(challenge.token, keyAuthorization),
        challengeRemoveFn: async (_authz, challenge) => onCleanup(challenge.token),
      });
      return { certPem, keyPem: key.toString(), notAfter: new Date(new X509Certificate(certPem).validTo).toISOString() };
    },
  };
}

// ChallengeStore holds the pending HTTP-01 answers every route table write
// publishes (wired as V2Options.edgeChallenges).
export interface ChallengeStore {
  set(token: string, keyAuth: string): void;
  delete(token: string): void;
  snapshot(): Record<string, string>;
}

export function createChallengeStore(): ChallengeStore {
  const m = new Map<string, string>();
  return {
    set: (t, k) => void m.set(t, k),
    delete: (t) => void m.delete(t),
    snapshot: () => Object.fromEntries(m),
  };
}

export interface CertWriter {
  writeCert(name: string, certPem: string, keyPem: string): Promise<void>;
  deleteCert(name: string): Promise<void>;
}

// createCertWriter writes (and deletes) a host's TLS Secret in nbo-edge of
// the edge cluster; the key never reaches an argument or an error message.
export function createCertWriter(deps: { store: Store; run: CommandRunner; kubeconfigFor: (clusterId: string) => Promise<string> }): CertWriter {
  return {
    async writeCert(name, certPem, keyPem) {
      try {
        await withEdgeCluster(deps, (kubectl) => kubectl(["apply", "-f", "-"], renderCertSecret(name, certPem, keyPem)));
      } catch (err) {
        throw new Error(`writing the certificate Secret ${name} failed: ${redact(errText(err), [keyPem])}`);
      }
    },
    async deleteCert(name) {
      await withEdgeCluster(deps, (kubectl) => kubectl(["delete", "secret", name, "--ignore-not-found"]));
    },
  };
}

// httpProbe asks the edge itself (its public address, port 80) for the
// challenge with the domain's Host, as Let's Encrypt will.
export function httpProbe(edgeAddress: () => string): (host: string, token: string, keyAuth: string) => Promise<boolean> {
  return (host, token, keyAuth) =>
    new Promise((resolve) => {
      const req = request(
        { host: edgeAddress().replace(/^\[(.*)\]$/, "$1"), port: 80, path: `/.well-known/acme-challenge/${token}`, headers: { host }, timeout: 5_000 },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            if (body.length < 4096) body += c;
          });
          res.on("end", () => resolve(res.statusCode === 200 && body === keyAuth));
          res.on("error", () => resolve(false));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => resolve(false));
      req.end();
    });
}

export interface DomainLoopDeps {
  store: Store;
  resolver: Resolver;
  acme: AcmeClient;
  edgeSync: Pick<EdgeSync, "push">;
  // Google's domain mappings, for domains served by Cloud Run itself.
  cloudRun?: Pick<CloudRunDomains, "targetFor" | "describe" | "create" | "remove">;
  challenges?: ChallengeStore;
  ranges: Pick<CloudflareRanges, "isCloudflare" | "refresh">;
  reach?: typeof reachCheck;
  flexible?: typeof flexibleCheck;
  writeCert: (name: string, certPem: string, keyPem: string) => Promise<void>;
  deleteCert: (name: string) => Promise<void>;
  now?: () => Date;
  probe?: (host: string, token: string, keyAuth: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DomainLoop {
  tick(): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  checkNow(domainId: string): Promise<Domain>;
  // moveToEdge and removeMapped run in the loop's queue, so they never
  // interleave with a pass that is talking to Google about the same row.
  moveToEdge(domainId: string): Promise<Domain>;
  removeMapped(domainId: string): Promise<void>;
  setBehindCloudflare(domainId: string, on: boolean): Promise<Domain>;
  pasteCert(domainId: string, certPem: string, keyPem: string): Promise<Domain>;
  removePastedCert(domainId: string): Promise<Domain>;
  // challenges: the pending answers, for every route table write.
  challenges(): Record<string, string>;
  deleteCert(name: string): Promise<void>;
}

export const noEmailMessage = "Set the Let's Encrypt email first (nbo-server domains settings --acme-email <address>)";
export const edgeClusterGoneMessage = "The edge's cluster is no longer connected. Connect it again or install the edge on another cluster first";

// The ephemeral certificate cap: NBO orders at most 20 certificates for
// ephemeral environments' hosts in any 7 days per registered domain, so
// Let's Encrypt's 50 a week leave room for Production, custom environments
// and renewals.
export const ephemeralCertCap = 20;
export const ephemeralCertCapWarning = "Waiting: NBO's weekly limit for ephemeral environments' certificates is reached";
// The same warning in the words earlier NBO versions stored on a domain row.
const legacyCapWarning = "Waiting: NBO's weekly limit for preview certificates is reached";

// registeredDomainOf: an ephemeral host minus its first label (the base
// domain, or the IP-dashed sslip.io name).
export function registeredDomainOf(host: string): string {
  const i = host.indexOf(".");
  return i < 0 ? host : host.slice(i + 1);
}

export function ephemeralCertCapReached(store: Store, registeredDomain: string, now: Date): boolean {
  return store.countEphemeralCertOrders(registeredDomain, new Date(now.getTime() - ephemeralCertWindowMs).toISOString()) >= ephemeralCertCap;
}

// isEphemeralDomain: does the row belong to an ephemeral stage?
function isEphemeralDomain(store: Store, d: Domain): boolean {
  if (d.stageId === "") return false;
  try {
    return store.getStage(d.stageId).kind === "ephemeral";
  } catch {
    return false;
  }
}

const withoutOne = (warning: string, w: string): string => warning.replace(` ${w}`, "").replace(`${w} `, "").replace(w, "").trim();
const withoutCapWarning = (warning: string): string => withoutOne(withoutOne(warning, ephemeralCertCapWarning), legacyCapWarning);

// moveRefusal says why no domain can move to the edge right now, or "": the
// edge could never get the certificate. Without it, HTTPS would stay down.
export function moveRefusal(store: Store): string {
  const { acmeEmail, edgeClusterId } = store.getServerSettings();
  if (acmeEmail === "") return noEmailMessage;
  if (!store.getKubernetesConnection(edgeClusterId)) return edgeClusterGoneMessage;
  return "";
}

const tickMs = 60_000;
const checkNowEveryMs = 60_000;
const probeEveryMs = 2_000;
const probeForMs = 30_000;
// The edge's two replicas each poll the table every 5 s, and a probe reaches
// only one: one poll later, the other has the challenge too.
const replicaPickupMs = 6_000;
const renewBeforeMs = 30 * 24 * 3_600_000;
const dailyMs = 24 * 3_600_000;
const reachRetryMs = 5 * 60_000;
const mappingRetryMs = 5 * 60_000;
// How long a moved domain's mapping outlives Active: visitors with cached DNS
// still reach Google.
const mappingKeepMs = 24 * 3_600_000;
// A cluster outage must not hold the serial queue on every tick: each
// failed write can take kubectl's full timeout.
const pastedRetryMs = 3_600_000;
// A blip at activation must not hide a warning for a whole day.
const unknownRetryMs = 3_600_000;
const backoffMs = [3_600_000, 6 * 3_600_000, 24 * 3_600_000];

// The warning of a mapping that could not be removed always ends the row's
// warning, so it can be found by its prefix and taken out alone.
const removalPrefix = (host: string): string => `NBO can't remove the old Cloud Run mapping for ${host}: `;
function removalWarningIn(warning: string, host: string): string {
  const i = warning.indexOf(removalPrefix(host));
  return i < 0 ? "" : warning.slice(i);
}
const withoutRemovalWarning = (warning: string, host: string): string => {
  const i = warning.indexOf(removalPrefix(host));
  return (i < 0 ? warning : warning.slice(0, i)).trim();
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// cleanError: what may be stored as lastError (shown in the dashboard) —
// no PEM block (account key, certificate key) and not unbounded.
function cleanError(msg: string, secrets: string[]): string {
  const s = redact(msg, secrets).replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g, "[redacted]");
  return s.length > 1000 ? `${s.slice(0, 1000)}…` : s;
}

// createDomainLoop drives every domain row: dns_pending → cert_pending →
// active, failed → retried after its backoff, active → renewed. Only one
// domain is worked on at a time (so at most one issuance is in flight), and
// one domain's failure never stops the others.
export function createDomainLoop(deps: DomainLoopDeps): DomainLoop {
  const { store } = deps;
  const challenges = deps.challenges ?? createChallengeStore();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const probe = deps.probe ?? httpProbe(() => store.getServerSettings().edgeAddress);
  const reach = deps.reach ?? reachCheck;
  const flexible = deps.flexible ?? flexibleCheck;

  // checkNow bypasses the backoff at most once a minute per domain (each
  // bypass can place a Let's Encrypt order).
  const lastCheckNow = new Map<string, number>();
  // Daily passes. In memory: a restart just runs them once more.
  const nextFlexible = new Map<string, number>();
  const nextPastedWrite = new Map<string, number>();
  const nextMappingRemoval = new Map<string, number>();
  let lastRangeRefresh: number | undefined;

  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn);
    tail = next.catch(() => undefined);
    return next;
  };

  const edgeInstalled = (): boolean => store.getServerSettings().edgeClusterId !== "";
  const due = (d: Domain): boolean => d.nextAttemptAt === "" || Date.parse(d.nextAttemptAt) <= now().getTime();
  const dailyDue = (last: number | undefined): boolean => last === undefined || now().getTime() - last >= dailyMs;

  async function push(projectId: string): Promise<void> {
    try {
      await deps.edgeSync.push(projectId);
    } catch (err) {
      console.error(`control-plane: domains: updating the edge route table failed: ${errText(err)}`);
    }
  }

  // servedByEdge returns once the edge answers token with value, and throws
  // if it doesn't in time. Each failed validation counts against Let's
  // Encrypt's limit and starts NBO's backoff, so a replica that lags must
  // not be asked yet: the check repeats one edge poll later.
  async function servedByEdge(d: Domain, token: string, value: string): Promise<void> {
    const served = async (): Promise<void> => {
      for (let waited = 0; ; waited += probeEveryMs) {
        if (await probe(d.host, token, value).catch(() => false)) return;
        if (waited >= probeForMs) break;
        await sleep(probeEveryMs);
      }
      throw new Error(`the edge did not serve the challenge for ${d.host} within ${probeForMs / 1000} s — check that the edge is running and port 80 of ${store.getServerSettings().edgeAddress} is reachable`);
    };
    await served();
    await sleep(replicaPickupMs);
    await served();
  }

  // cloudflareReady: does a request from the public internet reach the edge
  // through Cloudflare? A one-time token stands in for a real challenge.
  async function cloudflareReady(d: Domain): Promise<ReachResult> {
    const token = randomBytes(16).toString("base64url");
    const value = `${token}.${randomBytes(16).toString("base64url")}`;
    challenges.set(token, value);
    try {
      await deps.edgeSync.push(d.projectId);
      await servedByEdge(d, token, value);
      return await reach(d.host, token, value);
    } catch (err) {
      return { ok: false, code: "unreachable", message: errText(err) };
    } finally {
      challenges.delete(token);
      await push(d.projectId);
    }
  }

  // reachPasses gates a Let's Encrypt order. A failed check is not a Let's
  // Encrypt failure: nothing counts against the backoff, a domain without a
  // certificate goes back to waiting and the check runs again in 5 minutes.
  async function reachPasses(d: Domain): Promise<boolean> {
    const res = await cloudflareReady(d);
    if (res.ok) return true;
    const active = d.status === "active";
    store.updateDomain(d.id, {
      status: active ? "active" : "dns_pending",
      lastError: cleanError(active && res.code === "always_https" ? renewalAlwaysHttpsMessage(d.host) : res.message, []),
      checkedAt: now().toISOString(),
      nextAttemptAt: new Date(now().getTime() + reachRetryMs).toISOString(),
    });
    return false;
  }

  // The DNS answer as dnsPointsAtEdge words it: addresses, perhaps after a
  // CNAME chain.
  const looksProxied = (found: string): boolean => found.split(/[\s,()→]+/).some((a) => deps.ranges.isCloudflare(a));

  function expiryWarning(d: Domain): string {
    if (d.certSource !== "pasted" || d.certNotAfter === "") return "";
    const left = Date.parse(d.certNotAfter) - now().getTime();
    if (left >= renewBeforeMs) return "";
    const day = d.certNotAfter.slice(0, 10);
    return `The pasted Origin CA certificate ${left > 0 ? "expires" : "expired"} on ${day}. NBO can't renew it: create a new one in Cloudflare and paste it here.`;
  }

  // proxyWarning: is the record proxied? A pasted certificate is trusted by
  // Cloudflare only. A failed lookup says nothing, so current stays.
  async function proxyWarning(host: string, current: string): Promise<string> {
    try {
      const answers = [...(await deps.resolver.resolve4(host)), ...(await deps.resolver.resolve6(host))];
      if (answers.length === 0) return noRecordWarning(host);
      return answers.every((a) => deps.ranges.isCloudflare(a)) ? "" : notProxiedWarning(host);
    } catch {
      return current;
    }
  }

  // updateWarnings keeps the one warning field true for all of its causes,
  // so no check wipes another's. A domain that just went Active gets its
  // check one edge poll later: until the edge has the new table it doesn't
  // redirect, and Flexible would look fine.
  async function updateWarnings(id: string, justActive: boolean, force: boolean): Promise<void> {
    const d = store.getDomain(id);
    if (justActive && d.behindCloudflare) await sleep(replicaPickupMs);
    const carried = (...known: string[]): string => known.find((w) => d.warning.includes(w)) ?? "";
    let path = pathWarningIn(d.warning);
    let unreachable = carried(hostUnreachableWarning(d.host));
    let dns = carried(noRecordWarning(d.host), notProxiedWarning(d.host));
    if (d.behindCloudflare && (justActive || force || now().getTime() >= (nextFlexible.get(id) ?? 0))) {
      const res = await flexible(d.host).catch(() => "unknown" as const);
      nextFlexible.set(id, now().getTime() + (res === "unknown" ? unknownRetryMs : dailyMs));
      if (res !== "unknown") path = res === "flexible" ? flexibleWarning : res === "fine" ? "" : brokenWarning(res.status);
      if (d.certSource === "pasted") {
        unreachable = res === "unknown" ? hostUnreachableWarning(d.host) : "";
        dns = await proxyWarning(d.host, dns);
      }
    }
    // An ephemeral renewal waiting for the cap keeps its warning until it is renewed.
    const capped = d.warning.includes(ephemeralCertCapWarning) && !due(d) ? ephemeralCertCapWarning : "";
    const warning = [path, unreachable, dns, expiryWarning(d), capped, removalWarningIn(d.warning, d.host)].filter((w) => w !== "").join(" ");
    if (warning !== d.warning) store.updateDomain(id, { warning });
  }

  // rewritePasted puts the Secret back from the sealed copy, so a moved or
  // rebuilt edge gets its certificate without the user pasting it again.
  async function rewritePasted(d: Domain): Promise<void> {
    if (now().getTime() < (nextPastedWrite.get(d.id) ?? 0)) return;
    const pasted = store.getPastedCert(d.id);
    if (pasted === undefined) return;
    try {
      await deps.writeCert(certSecretName(d.host), pasted.certPem, pasted.keyPem);
    } catch (err) {
      nextPastedWrite.set(d.id, now().getTime() + pastedRetryMs);
      store.updateDomain(d.id, { lastError: cleanError(errText(err), [pasted.keyPem]), checkedAt: now().toISOString() });
      return;
    }
    nextPastedWrite.set(d.id, now().getTime() + dailyMs);
    if (d.lastError !== "") store.updateDomain(d.id, { lastError: "" });
  }

  // dropPasted: the row first, then the table, then the Secret, so the edge
  // is never told to use a Secret that is gone.
  async function dropPasted(d: Domain, on: boolean): Promise<Domain> {
    store.setPastedCert(d.id, null);
    store.updateDomain(d.id, { behindCloudflare: on, certSource: "letsencrypt", status: "dns_pending", certNotAfter: "", warning: "", lastError: "", failures: 0, nextAttemptAt: "" });
    nextPastedWrite.delete(d.id);
    nextFlexible.delete(d.id);
    await push(d.projectId);
    try {
      await deps.deleteCert(certSecretName(d.host));
    } catch (err) {
      console.error(`control-plane: domains: ${d.host}: deleting the certificate Secret failed: ${cleanError(errText(err), [])}`);
    }
    return store.getDomain(d.id);
  }

  async function refreshRanges(): Promise<void> {
    if (!dailyDue(lastRangeRefresh)) return;
    lastRangeRefresh = now().getTime();
    try {
      // The whole table is written, whichever project is named.
      if (await deps.ranges.refresh()) await push("");
    } catch (err) {
      console.error(`control-plane: domains: refreshing Cloudflare's address ranges failed: ${errText(err)}`);
    }
  }

  // A certificate already issued whose Secret write failed: write that one
  // again rather than order a new one (Let's Encrypt allows only 5 duplicate
  // certificates a week).
  function usableKept(d: Domain): PendingCert | undefined {
    const kept = store.getPendingCert(d.id);
    return kept !== undefined && Date.parse(kept.notAfter) - now().getTime() > renewBeforeMs ? kept : undefined;
  }

  async function issue(d: Domain, renewing: boolean): Promise<void> {
    const settings = store.getServerSettings();
    const kept = usableKept(d);
    if (kept === undefined && settings.acmeEmail === "") {
      store.updateDomain(d.id, { lastError: noEmailMessage });
      return;
    }
    // The ephemeral cap, for first certificates and renewals alike. Over it the
    // row keeps its status (cert_pending, or active for a renewal) and waits
    // until the oldest order in the window leaves it.
    const ephemeralRegistered = kept === undefined && isEphemeralDomain(store, d) ? registeredDomainOf(d.host) : "";
    if (ephemeralRegistered !== "") {
      if (ephemeralCertCapReached(store, ephemeralRegistered, now())) {
        const since = new Date(now().getTime() - ephemeralCertWindowMs).toISOString();
        const oldest = store.oldestEphemeralCertOrder(ephemeralRegistered, since) ?? now().toISOString();
        store.updateDomain(d.id, {
          warning: [withoutCapWarning(d.warning), ephemeralCertCapWarning].filter((w) => w !== "").join(" "),
          lastError: "",
          nextAttemptAt: new Date(Date.parse(oldest) + ephemeralCertWindowMs).toISOString(),
        });
        return;
      }
      if (d.warning.includes(ephemeralCertCapWarning)) d = store.updateDomain(d.id, { warning: withoutCapWarning(d.warning) });
    }
    const tokens = new Set<string>();
    const onChallenge = async (token: string, keyAuth: string): Promise<void> => {
      tokens.add(token);
      challenges.set(token, keyAuth);
      await deps.edgeSync.push(d.projectId);
      await servedByEdge(d, token, keyAuth);
    };
    const onCleanup = async (token: string): Promise<void> => {
      tokens.delete(token);
      challenges.delete(token);
      await push(d.projectId);
    };
    try {
      let out = kept;
      if (out === undefined) {
        // An order counts from the moment Let's Encrypt is asked, whether or not it succeeds.
        if (ephemeralRegistered !== "") store.recordEphemeralCertOrder(ephemeralRegistered, d.host, now().toISOString());
        out = await deps.acme.issue(d.host, onChallenge, onCleanup);
        store.setPendingCert(d.id, out);
      }
      try {
        await deps.writeCert(certSecretName(d.host), out.certPem, out.keyPem);
      } catch (err) {
        throw new Error(cleanError(errText(err), [out.keyPem]));
      }
      store.setPendingCert(d.id, null);
      store.updateDomain(d.id, { status: "active", certNotAfter: out.notAfter, failures: 0, lastError: "", nextAttemptAt: "" });
      await push(d.projectId);
    } catch (err) {
      const failures = d.failures + 1;
      const wait = backoffMs[Math.min(failures, backoffMs.length) - 1]!;
      const accountKey = (() => {
        try {
          return store.getServerSecret("acme_account_key") ?? "";
        } catch {
          return "";
        }
      })();
      store.updateDomain(d.id, {
        status: renewing ? "active" : "failed",
        lastError: cleanError(errText(err), [accountKey]),
        failures,
        nextAttemptAt: new Date(now().getTime() + wait).toISOString(),
      });
    } finally {
      if (tokens.size > 0) {
        for (const t of tokens) challenges.delete(t);
        await push(d.projectId);
      }
    }
  }

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
      store.updateDomain(id, { lastError: "This project has no Cloud Run environment to serve the domain from", checkedAt, nextAttemptAt: at(mappingRetryMs) });
      return;
    }
    try {
      if (d.status === "verify_pending" || d.status === "failed") {
        try {
          await cloudRun.create(target, d.host);
        } catch (err) {
          if (!(err instanceof MappingNotVerifiedError)) throw err;
          store.updateDomain(id, { status: "verify_pending", lastError: "", checkedAt, nextAttemptAt: at(mappingRetryMs) });
          return;
        }
        const state = await cloudRun.describe(target, d.host);
        store.updateDomain(id, { status: "cert_pending", mappingRecords: state?.records ?? [], lastError: "", failures: 0, checkedAt, nextAttemptAt: "" });
        return;
      }
      const state = await cloudRun.describe(target, d.host);
      if (state === null) {
        const lost = d.status === "active";
        store.updateDomain(id, {
          status: "verify_pending",
          warning: "",
          ...(lost ? { mappingRecords: [], lastError: "Google no longer has this mapping, so NBO is recreating it." } : {}),
          checkedAt,
          nextAttemptAt: "",
        });
        return;
      }
      if (d.status === "cert_pending") {
        if (state.ready) {
          store.updateDomain(id, { status: "active", mappingRecords: state.records, lastError: "", warning: "", failures: 0, checkedAt, nextAttemptAt: at(dailyMs) });
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
        store.updateDomain(id, { status: "failed", lastError: msg, failures, checkedAt, nextAttemptAt: at(backoffMs[Math.min(failures, backoffMs.length) - 1]!) });
      } else {
        store.updateDomain(id, { lastError: msg, checkedAt, nextAttemptAt: at(d.status === "active" ? unknownRetryMs : mappingRetryMs) });
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
    store.updateDomain(id, { mappingKept: false, mappingRemoveAfter: "", mappingRecords: [], warning: withoutRemovalWarning(store.getDomain(id).warning, d.host) });
  }

  async function process(id: string, force: boolean): Promise<void> {
    if (store.getDomain(id).serving === "cloudrun") {
      await advanceMapped(id, force);
      return;
    }
    if (store.getServerSettings().edgeAddress === "") {
      store.updateDomain(id, { lastError: "The edge has no public address yet" });
      return;
    }
    const wasActive = store.getDomain(id).status === "active";
    await advance(id, force);
    if (store.getDomain(id).status === "active") await updateWarnings(id, !wasActive, force);
    await removeKeptMapping(id, force);
  }

  async function advance(id: string, force: boolean): Promise<void> {
    let d = store.getDomain(id);
    const settings = store.getServerSettings();
    // The reach check protects Let's Encrypt orders: a kept certificate needs
    // none, and without an email none can follow.
    const reachNeeded = d.behindCloudflare && usableKept(d) === undefined;
    const gated = reachNeeded && settings.acmeEmail !== "";
    let reached = false;
    if (d.status === "failed") {
      if (!force && !due(d)) return;
      d = store.updateDomain(id, { status: "dns_pending" });
    }
    if (d.status === "dns_pending") {
      if (d.behindCloudflare && !force && !due(d)) return;
      const res = await dnsPointsAtEdge(d.host, settings.edgeAddress, deps.resolver);
      // Cloudflare hides the target, so for its domains any answer will do:
      // the reach check below is the real test.
      if (d.behindCloudflare ? res.found === "" : !res.ok) {
        const hint = !d.behindCloudflare && looksProxied(res.found) ? ". This record looks proxied by Cloudflare: turn on Behind Cloudflare for this domain" : "";
        store.updateDomain(id, { checkedAt: now().toISOString(), lastError: `${d.host} does not point at the edge (${settings.edgeAddress}) yet: DNS answers ${res.found === "" ? "nothing" : res.found}${hint}` });
        return;
      }
      if (reachNeeded) {
        if (!(await reachPasses(d))) return;
        reached = true;
      }
      d = store.updateDomain(id, { status: "cert_pending", checkedAt: now().toISOString(), lastError: "", nextAttemptAt: "" });
    }
    if (d.status === "cert_pending") {
      if (!force && !due(d)) return;
      if (gated && !reached && !(await reachPasses(d))) return;
      await issue(d, false);
      return;
    }
    if (d.status === "active") {
      if (d.certSource === "pasted") {
        await rewritePasted(d);
        return;
      }
      const left = d.certNotAfter === "" ? 0 : Date.parse(d.certNotAfter) - now().getTime();
      if (left >= renewBeforeMs) return;
      if (!force && !due(d)) return;
      if (gated && !(await reachPasses(d))) return;
      await issue(d, true);
    }
  }

  async function processSafely(id: string, force: boolean): Promise<void> {
    try {
      await process(id, force);
    } catch (err) {
      const msg = cleanError(errText(err), []);
      console.error(`control-plane: domains: ${id}: ${msg}`);
      try {
        store.updateDomain(id, { lastError: msg, checkedAt: now().toISOString() });
      } catch {
        // deleted meanwhile
      }
    }
  }

  const loop: DomainLoop = {
    tick() {
      return serial(async () => {
        const edge = edgeInstalled();
        if (edge) await refreshRanges();
        for (const d of store.listDomains()) {
          if (edge || d.serving === "cloudrun") await processSafely(d.id, false);
        }
      });
    },
    async run(signal) {
      while (!signal.aborted) {
        try {
          await loop.tick();
        } catch (err) {
          console.error(`control-plane: domains: ${errText(err)}`);
        }
        await new Promise<void>((resolve) => {
          // Aborted during the tick: no wait, the loop ends.
          if (signal.aborted) return resolve();
          const t = setTimeout(resolve, tickMs);
          signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
        });
      }
    },
    checkNow(domainId) {
      return serial(async () => {
        const row = store.getDomain(domainId);
        const at = now().getTime();
        const last = lastCheckNow.get(domainId);
        if (last !== undefined && at - last < checkNowEveryMs) return store.getDomain(domainId);
        if (edgeInstalled() || row.serving === "cloudrun") {
          lastCheckNow.set(domainId, at);
          store.updateDomain(domainId, { nextAttemptAt: "" });
          await processSafely(domainId, true);
        }
        return store.getDomain(domainId);
      });
    },
    moveToEdge(domainId) {
      return serial(async () => {
        // Checked again here: the row may have changed while this waited.
        if (store.getDomain(domainId).serving !== "cloudrun") throw new ErrConflict("This domain is already served by the edge");
        const refusal = moveRefusal(store);
        if (refusal) throw new ErrConflict(refusal);
        return store.updateDomain(domainId, {
          serving: "edge",
          status: "dns_pending",
          mappingKept: true,
          mappingRemoveAfter: "",
          warning: "",
          lastError: "",
          failures: 0,
          nextAttemptAt: "",
          checkedAt: "",
        });
      });
    },
    removeMapped(domainId) {
      return serial(async () => {
        const d = store.getDomain(domainId);
        if (d.serving === "cloudrun" || d.mappingKept) {
          const target = deps.cloudRun?.targetFor(d.projectId) ?? null;
          if (target) await deps.cloudRun!.remove(target, d.host);
          else console.error(`control-plane: domains: ${d.host}: removed without deleting Google's domain mapping, because this project has no Cloud Run environment; check Google Cloud for a leftover mapping`);
        }
        store.deleteDomain(domainId);
      });
    },
    setBehindCloudflare(domainId, on) {
      return serial(async () => {
        const d = store.getDomain(domainId);
        if (d.behindCloudflare === on) return d;
        if (on) {
          if (d.kind === "default") throw new ErrConflict("The default address can't be behind Cloudflare: its record stays DNS only");
          if (store.getServerSettings().edgeVersion !== EDGE_VERSION) throw new ErrConflict("Reinstall the edge first");
          const restart = d.status === "failed" ? { status: "dns_pending" as const, failures: 0, nextAttemptAt: "" } : {};
          store.updateDomain(domainId, { behindCloudflare: true, ...restart, ...(d.status === "active" ? {} : { lastError: "" }) });
          nextFlexible.delete(domainId);
        } else {
          // Origin CA certificates are trusted only by Cloudflare.
          if (d.certSource === "pasted") return dropPasted(d, false);
          store.updateDomain(domainId, { behindCloudflare: false, warning: "" });
        }
        await push(d.projectId);
        return store.getDomain(domainId);
      });
    },
    pasteCert(domainId, certPem, keyPem) {
      return serial(async () => {
        const d = store.getDomain(domainId);
        if (!d.behindCloudflare) throw new ErrConflict("Turn on Behind Cloudflare first");
        const { notAfter } = validatePastedCert(d.host, certPem, keyPem, now());
        try {
          await deps.writeCert(certSecretName(d.host), certPem, keyPem);
        } catch (err) {
          throw new Error(cleanError(errText(err), [keyPem]));
        }
        nextPastedWrite.set(domainId, now().getTime() + dailyMs);
        store.setPastedCert(domainId, { certPem, keyPem, notAfter });
        store.setPendingCert(domainId, null);
        store.updateDomain(domainId, { status: "active", certSource: "pasted", certNotAfter: notAfter, failures: 0, lastError: "", nextAttemptAt: "", checkedAt: now().toISOString() });
        await push(d.projectId);
        await updateWarnings(domainId, true, false);
        return store.getDomain(domainId);
      });
    },
    removePastedCert(domainId) {
      return serial(async () => {
        const d = store.getDomain(domainId);
        if (d.certSource !== "pasted") throw new ErrConflict("This domain has no pasted certificate");
        return dropPasted(d, d.behindCloudflare);
      });
    },
    challenges: () => challenges.snapshot(),
    deleteCert: (name) => deps.deleteCert(name),
  };
  return loop;
}
