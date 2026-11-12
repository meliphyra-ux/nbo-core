// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Behind Cloudflare: is the domain reaching NBO, is Cloudflare in Flexible
// mode, and is a pasted Origin CA certificate usable? All messages are
// plain words for a front-end developer and never carry key material.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { ErrInvalid } from "./errors.js";

export type ReachResult =
  | { ok: true }
  | { ok: false; code: "always_https" | "blocked" | "unreachable"; message: string };

export const flexibleWarning =
  "Cloudflare is set to Flexible, so visitors get stuck in a redirect loop. In Cloudflare, open SSL/TLS and set the mode to Full (strict).";

// renewalAlwaysHttpsMessage replaces the always_https message on an Active
// domain: it has a certificate, so that message's words would be wrong.
export const renewalAlwaysHttpsMessage = (host: string): string =>
  `Always Use HTTPS is on in Cloudflare and the check for ${host} failed over https, so NBO can't renew the certificate. Turn Always Use HTTPS off until the renewal is done, or paste an Origin CA certificate.`;

export type FlexibleResult = "flexible" | "fine" | "unknown" | { kind: "broken"; status: number };

// brokenWarning: Cloudflare answered https with one of its own 52x errors,
// so the domain is Active but visitors get an error page.
export const brokenWarning = (status: number): string =>
  status === 526
    ? "Cloudflare doesn't accept the certificate on the edge (error 526). Full (strict) refuses an untrusted certificate, and a Let's Encrypt staging certificate is one. Use a production certificate or paste an Origin CA certificate."
    : `Cloudflare can't complete the connection to the edge (error ${status}). Check that the edge is running and that the record in Cloudflare points at NBO's public address.`;

// pathWarningIn reads back the Flexible or broken part of a stored warning,
// which stays until the next check says otherwise.
export function pathWarningIn(warning: string): string {
  if (warning.includes(flexibleWarning)) return flexibleWarning;
  const status = /\(error (\d{3})\)/.exec(warning)?.[1];
  if (status === undefined) return "";
  const broken = brokenWarning(Number(status));
  return warning.includes(broken) ? broken : "";
}

// A pasted certificate goes Active without a reach check, so these say when
// nothing shows the site works.
export const hostUnreachableWarning = (host: string): string =>
  `NBO couldn't reach ${host} over https. Check the DNS record for ${host} in Cloudflare.`;
export const notProxiedWarning = (host: string): string =>
  `DNS for ${host} doesn't answer with Cloudflare's addresses. Set the record to Proxied (the orange cloud). Browsers don't trust Origin CA certificates, so visitors must come through Cloudflare.`;
export const noRecordWarning = (host: string): string =>
  `DNS has no record for ${host} yet. Create it in Cloudflare and set it to Proxied (the orange cloud).`;

const timeoutMs = 10_000;
const challengePath = "/.well-known/acme-challenge/";

const get = (f: typeof fetch, url: string): Promise<Response> =>
  f(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });

const isRedirect = (s: number): boolean => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

// reachCheck fetches the one-time token through Cloudflare. It follows at
// most one redirect, and only to https on the same host.
export async function reachCheck(
  host: string,
  token: string,
  expected: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReachResult> {
  const fail = (code: "always_https" | "blocked" | "unreachable", message: string): ReachResult => ({ ok: false, code, message });
  const blocked = () =>
    fail(
      "blocked",
      `Cloudflare is blocking ${host} before it reaches NBO. A WAF rule or Bot Fight Mode is likely stopping it; allow the path ${challengePath} in Cloudflare.`,
    );
  const unreachable = () =>
    fail(
      "unreachable",
      `Cloudflare can't reach NBO for ${host}. Check that the DNS record for ${host} in Cloudflare points at NBO's public address and that the record is proxied.`,
    );
  const alwaysHttps = () =>
    fail(
      "always_https",
      `Always Use HTTPS is on in Cloudflare and NBO has no certificate for ${host} yet. Turn Always Use HTTPS off until the domain is Active, or paste an Origin CA certificate.`,
    );
  const mitigated = (r: Response): boolean => r.headers.has("cf-mitigated") || r.status === 403 || r.status === 503;

  const startUrl = `http://${host}${challengePath}${token}`;
  let res: Response;
  try {
    res = await get(fetchImpl, startUrl);
  } catch {
    return unreachable();
  }
  if (mitigated(res)) return blocked();

  if (isRedirect(res.status)) {
    let target: URL;
    try {
      target = new URL(res.headers.get("location") ?? "", startUrl);
    } catch {
      return unreachable();
    }
    if (target.protocol !== "https:" || target.hostname.toLowerCase() !== host.toLowerCase()) return unreachable();
    try {
      res = await get(fetchImpl, target.toString());
    } catch {
      return alwaysHttps();
    }
    if (res.status === 525 || res.status === 526) return alwaysHttps();
    if (mitigated(res)) return blocked();
  }

  if (res.status !== 200) return unreachable();
  try {
    if ((await res.text()).trim() === expected) return { ok: true };
  } catch {
    // fall through
  }
  return unreachable();
}

// flexibleCheck: a 301/308 from https://host/ back to the same address means
// Cloudflare talks http to the edge (Flexible mode). A 520-530 is Cloudflare
// failing to get an answer from the edge at all.
export async function flexibleCheck(host: string, fetchImpl: typeof fetch = fetch): Promise<FlexibleResult> {
  const url = `https://${host}/`;
  let res: Response;
  try {
    res = await get(fetchImpl, url);
  } catch {
    return "unknown";
  }
  if (res.status >= 520 && res.status <= 530) return { kind: "broken", status: res.status };
  if (res.status !== 301 && res.status !== 308) return "fine";
  try {
    const t = new URL(res.headers.get("location") ?? "", url);
    const same = t.protocol === "https:" && t.hostname.toLowerCase() === host.toLowerCase() && t.pathname === "/" && !t.search;
    return same ? "flexible" : "fine";
  } catch {
    return "fine";
  }
}

// validatePastedCert checks an Origin CA pair: both parse, the key matches,
// the leaf covers the host and has not expired. Errors never include OpenSSL
// text, which could echo input.
export function validatePastedCert(host: string, certPem: string, keyPem: string, now: Date): { notAfter: string } {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    throw new ErrInvalid("The certificate couldn't be read. Paste the whole certificate, including the BEGIN CERTIFICATE and END CERTIFICATE lines.");
  }
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new ErrInvalid("The private key couldn't be read. Paste the whole key, including the BEGIN and END lines.");
  }
  let matches = false;
  try {
    matches = cert.checkPrivateKey(key);
  } catch {
    matches = false;
  }
  if (!matches) throw new ErrInvalid("The private key doesn't belong to this certificate. Paste the key Cloudflare showed with it.");
  if (cert.checkHost(host) === undefined) {
    throw new ErrInvalid(`This certificate doesn't cover ${host}. Create an Origin CA certificate that lists ${host} (or a wildcard that matches it).`);
  }
  const notAfter = new Date(cert.validTo);
  if (Number.isNaN(notAfter.getTime()) || notAfter.getTime() <= now.getTime()) {
    throw new ErrInvalid("This certificate has expired. Create a new Origin CA certificate in Cloudflare and paste it.");
  }
  if (new Date(cert.validFrom).getTime() > now.getTime()) {
    throw new ErrInvalid("This certificate isn't valid yet. Check its start date, or create a new one in Cloudflare.");
  }
  return { notAfter: notAfter.toISOString() };
}
