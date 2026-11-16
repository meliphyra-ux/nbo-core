// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Ordering a certificate: wait for the edge to serve the challenge, the Cloudflare reach gate, issue and store.
import { randomBytes } from "node:crypto";
import type { PendingCert } from "../store/server-settings.js";
import type { Domain } from "./domains.js";
import { renewalAlwaysHttpsMessage, type ReachResult } from "./cloudflare-check.js";
import { certSecretName } from "../edge/edge-manifests.js";
import { ephemeralCertWindowMs } from "./ephemeral-certs.js";
import type { LoopCtx } from "./cert-loop-ctx.js";
import {
  backoffMs,
  cleanError,
  ephemeralCertCapReached,
  ephemeralCertCapWarning,
  errText,
  isEphemeralDomain,
  noEmailMessage,
  probeEveryMs,
  probeForMs,
  reachRetryMs,
  registeredDomainOf,
  renewBeforeMs,
  replicaPickupMs,
  withoutCapWarning,
} from "./cert-policy.js";

// Certificate issuing for edge-served domains; waits for the edge and the reach check before ordering, to protect the ACME limits.
export function createIssuer(ctx: LoopCtx) {
  const { deps, store, challenges, now, sleep, probe, reach, push } = ctx;

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
      throw new Error(
        `the edge did not serve the challenge for ${d.host} within ${probeForMs / 1000} s — check that the edge is running and port 80 of ${store.getServerSettings().edgeAddress} is reachable`,
      );
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
      lastError: cleanError(
        active && res.code === "always_https" ? renewalAlwaysHttpsMessage(d.host) : res.message,
        [],
      ),
      checkedAt: now().toISOString(),
      nextAttemptAt: new Date(now().getTime() + reachRetryMs).toISOString(),
    });
    return false;
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
      if (d.warning.includes(ephemeralCertCapWarning))
        d = store.updateDomain(d.id, { warning: withoutCapWarning(d.warning) });
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
        if (ephemeralRegistered !== "")
          store.recordEphemeralCertOrder(ephemeralRegistered, d.host, now().toISOString());
        out = await deps.acme.issue(d.host, onChallenge, onCleanup);
        store.setPendingCert(d.id, out);
      }
      try {
        await deps.writeCert(certSecretName(d.host), out.certPem, out.keyPem);
      } catch (err) {
        // eslint-disable-next-line preserve-caught-error -- the cause may carry the private key; the message is redacted by hand
        throw new Error(cleanError(errText(err), [out.keyPem]));
      }
      store.setPendingCert(d.id, null);
      store.updateDomain(d.id, {
        status: "active",
        certNotAfter: out.notAfter,
        failures: 0,
        lastError: "",
        nextAttemptAt: "",
      });
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

  return { reachPasses, usableKept, issue };
}
