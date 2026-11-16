// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// What a domain row warns about, the pasted-certificate Secret, and the daily Cloudflare range refresh.
import type { Domain } from "./domains.js";
import {
  brokenWarning,
  flexibleWarning,
  hostUnreachableWarning,
  noRecordWarning,
  notProxiedWarning,
  pathWarningIn,
} from "./cloudflare-check.js";
import { certSecretName } from "../edge/edge-manifests.js";
import type { LoopCtx } from "./cert-loop-ctx.js";
import {
  cleanError,
  dailyMs,
  ephemeralCertCapWarning,
  errText,
  pastedRetryMs,
  removalWarningIn,
  renewBeforeMs,
  replicaPickupMs,
  unknownRetryMs,
} from "./cert-policy.js";

// Re-checks a domain's DNS, reachability and Cloudflare settings, then rewrites its warning text.
export function createWarnings(ctx: LoopCtx) {
  const { deps, store, now, sleep, flexible, nextFlexible, nextPastedWrite, due, push } = ctx;
  const dailyDue = (last: number | undefined): boolean => last === undefined || now().getTime() - last >= dailyMs;
  let lastRangeRefresh: number | undefined;

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
      if (res !== "unknown")
        path = res === "flexible" ? flexibleWarning : res === "fine" ? "" : brokenWarning(res.status);
      if (d.certSource === "pasted") {
        unreachable = res === "unknown" ? hostUnreachableWarning(d.host) : "";
        dns = await proxyWarning(d.host, dns);
      }
    }
    // An ephemeral renewal waiting for the cap keeps its warning until it is renewed.
    const capped = d.warning.includes(ephemeralCertCapWarning) && !due(d) ? ephemeralCertCapWarning : "";
    const warning = [path, unreachable, dns, expiryWarning(d), capped, removalWarningIn(d.warning, d.host)]
      .filter((w) => w !== "")
      .join(" ");
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
      store.updateDomain(d.id, {
        lastError: cleanError(errText(err), [pasted.keyPem]),
        checkedAt: now().toISOString(),
      });
      return;
    }
    nextPastedWrite.set(d.id, now().getTime() + dailyMs);
    if (d.lastError !== "") store.updateDomain(d.id, { lastError: "" });
  }

  // dropPasted: the row first, then the table, then the Secret, so the edge
  // is never told to use a Secret that is gone.
  async function dropPasted(d: Domain, on: boolean): Promise<Domain> {
    store.setPastedCert(d.id, null);
    store.updateDomain(d.id, {
      behindCloudflare: on,
      certSource: "letsencrypt",
      status: "dns_pending",
      certNotAfter: "",
      warning: "",
      lastError: "",
      failures: 0,
      nextAttemptAt: "",
    });
    nextPastedWrite.delete(d.id);
    nextFlexible.delete(d.id);
    await push(d.projectId);
    try {
      await deps.deleteCert(certSecretName(d.host));
    } catch (err) {
      console.error(
        `control-plane: domains: ${d.host}: deleting the certificate Secret failed: ${cleanError(errText(err), [])}`,
      );
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

  return { updateWarnings, rewritePasted, dropPasted, refreshRanges };
}
