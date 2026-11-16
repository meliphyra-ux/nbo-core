// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Domains and certificates (spec A5): the control-plane checks each
// domain's DNS, gets a Let's Encrypt certificate over HTTP-01 through the
// public edge (the challenge answer goes into the route table), stores it
// as the host's TLS Secret in nbo-edge, and renews it with < 30 days left.
// A domain behind Cloudflare proves its path with a real request instead of
// its DNS answer, and may carry a pasted Origin CA certificate instead.
import { dnsPointsAtEdge } from "./dns-check.js";
import { EDGE_VERSION, certSecretName } from "../edge/edge-manifests.js";
import { validatePastedCert } from "./cloudflare-check.js";
import { ErrConflict } from "../store/errors.js";
import { createIssuer } from "./cert-issue.js";
import { createLoopCtx, type DomainLoop, type DomainLoopDeps } from "./cert-loop-ctx.js";
import { createMapped } from "./cert-mapped.js";
import { cleanError, checkNowEveryMs, dailyMs, errText, moveRefusal, renewBeforeMs, tickMs } from "./cert-policy.js";
import { createWarnings } from "./cert-warnings.js";

export {
  createAcmeClient,
  createCertWriter,
  createChallengeStore,
  type AcmeClient,
  type AcmeLib,
  type CertWriter,
  type ChallengeStore,
} from "./cert-acme.js";
export type { DomainLoop, DomainLoopDeps } from "./cert-loop-ctx.js";
export {
  edgeClusterGoneMessage,
  ephemeralCertCapReached,
  ephemeralCertCapWarning,
  moveRefusal,
  noEmailMessage,
  registeredDomainOf,
} from "./cert-policy.js";

// createDomainLoop drives every domain row: dns_pending → cert_pending →
// active, failed → retried after its backoff, active → renewed. Only one
// domain is worked on at a time (so at most one issuance is in flight), and
// one domain's failure never stops the others.
export function createDomainLoop(deps: DomainLoopDeps): DomainLoop {
  const ctx = createLoopCtx(deps);
  const { store, challenges, now, nextFlexible, nextPastedWrite, due, push } = ctx;
  const { reachPasses, usableKept, issue } = createIssuer(ctx);
  const { updateWarnings, rewritePasted, dropPasted, refreshRanges } = createWarnings(ctx);
  const { advanceMapped, removeKeptMapping } = createMapped(ctx);

  // checkNow bypasses the backoff at most once a minute per domain (each
  // bypass can place a Let's Encrypt order).
  const lastCheckNow = new Map<string, number>();

  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn);
    tail = next.catch(() => undefined);
    return next;
  };

  const edgeInstalled = (): boolean => store.getServerSettings().edgeClusterId !== "";

  // The DNS answer as dnsPointsAtEdge words it: addresses, perhaps after a
  // CNAME chain.
  const looksProxied = (found: string): boolean => found.split(/[\s,()→]+/).some((a) => deps.ranges.isCloudflare(a));

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
        const hint =
          !d.behindCloudflare && looksProxied(res.found)
            ? ". This record looks proxied by Cloudflare: turn on Behind Cloudflare for this domain"
            : "";
        store.updateDomain(id, {
          checkedAt: now().toISOString(),
          lastError: `${d.host} does not point at the edge (${settings.edgeAddress}) yet: DNS answers ${res.found === "" ? "nothing" : res.found}${hint}`,
        });
        return;
      }
      if (reachNeeded) {
        if (!(await reachPasses(d))) return;
        reached = true;
      }
      d = store.updateDomain(id, {
        status: "cert_pending",
        checkedAt: now().toISOString(),
        lastError: "",
        nextAttemptAt: "",
      });
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
        if (store.getDomain(domainId).serving !== "cloudrun")
          throw new ErrConflict("This domain is already served by the edge");
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
          else
            console.error(
              `control-plane: domains: ${d.host}: removed without deleting Google's domain mapping, because this project has no Cloud Run environment; check Google Cloud for a leftover mapping`,
            );
        }
        store.deleteDomain(domainId);
      });
    },
    setBehindCloudflare(domainId, on) {
      return serial(async () => {
        const d = store.getDomain(domainId);
        if (d.behindCloudflare === on) return d;
        if (on) {
          if (d.kind === "default")
            throw new ErrConflict("The default address can't be behind Cloudflare: its record stays DNS only");
          if (store.getServerSettings().edgeVersion !== EDGE_VERSION) throw new ErrConflict("Reinstall the edge first");
          const restart =
            d.status === "failed" ? { status: "dns_pending" as const, failures: 0, nextAttemptAt: "" } : {};
          store.updateDomain(domainId, {
            behindCloudflare: true,
            ...restart,
            ...(d.status === "active" ? {} : { lastError: "" }),
          });
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
          // eslint-disable-next-line preserve-caught-error -- the cause may carry the private key; the message is redacted by hand
          throw new Error(cleanError(errText(err), [keyPem]));
        }
        nextPastedWrite.set(domainId, now().getTime() + dailyMs);
        store.setPastedCert(domainId, { certPem, keyPem, notAfter });
        store.setPendingCert(domainId, null);
        store.updateDomain(domainId, {
          status: "active",
          certSource: "pasted",
          certNotAfter: notAfter,
          failures: 0,
          lastError: "",
          nextAttemptAt: "",
          checkedAt: now().toISOString(),
        });
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
  return loop;
}
