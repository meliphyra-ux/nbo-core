// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  reachCheck,
  flexibleCheck,
  validatePastedCert,
  flexibleWarning,
  renewalAlwaysHttpsMessage,
  brokenWarning,
  pathWarningIn,
  hostUnreachableWarning,
  noRecordWarning,
  notProxiedWarning,
} from "../cloudflare-check.js";
import { ErrInvalid } from "../errors.js";

const fx = (n: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8");

const host = "shop.example.com";
const token = "tok123";
const body = "tok123.thumbprint";

type Answer = { status: number; body?: string; location?: string; headers?: Record<string, string> } | "throw";

// fakeFetch answers by URL prefix and records every call.
function fakeFetch(answers: Record<string, Answer>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const a = answers[url];
    if (a === undefined || a === "throw") throw new Error("network down");
    const headers = new Headers(a.headers);
    if (a.location) headers.set("location", a.location);
    return new Response(a.body ?? "", { status: a.status, headers });
  }) as typeof fetch;
  return { f, calls };
}

const http = `http://${host}/.well-known/acme-challenge/${token}`;
const https = `https://${host}/.well-known/acme-challenge/${token}`;

describe("reachCheck", () => {
  const run = (answers: Record<string, Answer>) => {
    const { f, calls } = fakeFetch(answers);
    return reachCheck(host, token, body, f).then((r) => ({ r, calls }));
  };

  it("passes on http 200 with the right body", async () => {
    const { r, calls } = await run({ [http]: { status: 200, body } });
    expect(r).toEqual({ ok: true });
    expect(calls[0]!.init?.redirect).toBe("manual");
    expect(calls[0]!.init?.signal).toBeDefined();
  });

  it("follows one redirect to https on the same host", async () => {
    const { r } = await run({ [http]: { status: 301, location: https }, [https]: { status: 200, body } });
    expect(r).toEqual({ ok: true });
  });

  it.each([525, 526])("reports always_https when https answers %i", async (status) => {
    const { r } = await run({ [http]: { status: 301, location: https }, [https]: { status } });
    expect(r).toMatchObject({ ok: false, code: "always_https" });
    if (!r.ok) expect(r.message).toContain(host);
  });

  it("reports always_https when https throws", async () => {
    const { r } = await run({ [http]: { status: 301, location: https }, [https]: "throw" });
    expect(r).toMatchObject({ ok: false, code: "always_https" });
  });

  it("reports unreachable on a redirect to another host", async () => {
    const { r } = await run({ [http]: { status: 301, location: "https://other.example.net/x" } });
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("follows at most one redirect", async () => {
    const { r, calls } = await run({ [http]: { status: 301, location: https }, [https]: { status: 301, location: https } });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it.each([403, 503])("reports blocked on %i", async (status) => {
    const { r } = await run({ [http]: { status } });
    expect(r).toMatchObject({ ok: false, code: "blocked" });
    if (!r.ok) expect(r.message).toContain("/.well-known/acme-challenge/");
  });

  it("reports blocked on any answer with cf-mitigated", async () => {
    const { r } = await run({ [http]: { status: 200, body, headers: { "cf-mitigated": "challenge" } } });
    expect(r).toMatchObject({ ok: false, code: "blocked" });
  });

  it.each([404, 520, 521, 522, 523, 524, 530])("reports unreachable on %i", async (status) => {
    const { r } = await run({ [http]: { status } });
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
    if (!r.ok) expect(r.message).toContain(host);
  });

  it("reports unreachable on a 200 with the wrong body", async () => {
    const { r } = await run({ [http]: { status: 200, body: "nope" } });
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("reports unreachable when fetch throws", async () => {
    const { r } = await run({ [http]: "throw" });
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
  });
});

describe("the warnings for a broken site", () => {
  it("526 names the certificate, trust and Let's Encrypt staging", () => {
    const w = brokenWarning(526);
    expect(w).toContain("526");
    expect(w).toContain("certificate");
    expect(w).toContain("Full (strict)");
    expect(w).toContain("staging");
  });

  it.each([525, 520, 530])("%i says Cloudflare can't complete the connection", (status) => {
    const w = brokenWarning(status);
    expect(w).toContain(String(status));
    expect(w).toContain("can't complete the connection");
  });

  it("pathWarningIn finds the Flexible or broken part of a longer warning", () => {
    expect(pathWarningIn(`${flexibleWarning} The pasted certificate expires.`)).toBe(flexibleWarning);
    expect(pathWarningIn(`${brokenWarning(525)} The pasted certificate expires.`)).toBe(brokenWarning(525));
    expect(pathWarningIn("The pasted certificate expires.")).toBe("");
    expect(pathWarningIn("")).toBe("");
  });

  it("the pasted-domain warnings name the host; the DNS ones explain why the record must be proxied", () => {
    expect(hostUnreachableWarning(host)).toContain(host);
    expect(hostUnreachableWarning(host)).toContain("DNS record");
    expect(notProxiedWarning(host)).toContain(host);
    expect(notProxiedWarning(host)).toContain("Proxied");
    expect(notProxiedWarning(host)).toContain("Browsers don't trust");
    expect(noRecordWarning(host)).toContain(host);
    expect(noRecordWarning(host)).toContain("Create");
  });
});

describe("renewalAlwaysHttpsMessage", () => {
  it("names the host and the renewal, and doesn't claim there is no certificate", () => {
    const m = renewalAlwaysHttpsMessage(host);
    expect(m).toContain(host);
    expect(m).toContain("renew");
    expect(m).not.toContain("no certificate");
    expect(m).not.toContain("until the domain is Active");
  });
});

describe("flexibleCheck", () => {
  const root = `https://${host}/`;
  const run = (a: Answer) => flexibleCheck(host, fakeFetch({ [root]: a }).f);

  it.each([520, 521, 525, 526, 530])("reports broken on a %i", async (status) => {
    expect(await run({ status })).toEqual({ kind: "broken", status });
  });

  it.each([200, 404, 500, 519, 531])("stays fine on a %i", async (status) => {
    expect(await run({ status })).toBe("fine");
  });

  it.each([308, 301])("detects flexible on a %i back to the same address", async (status) => {
    expect(await run({ status, location: root })).toBe("flexible");
  });
  it("detects flexible when the location has no slash", async () => {
    expect(await run({ status: 308, location: `https://${host}` })).toBe("flexible");
  });
  it("is fine on a redirect to another path or host", async () => {
    expect(await run({ status: 308, location: "/en" })).toBe("fine");
    expect(await run({ status: 301, location: "https://other.example.net/" })).toBe("fine");
  });
  it("is fine on 200", async () => {
    expect(await run({ status: 200 })).toBe("fine");
  });
  it("is unknown when fetch throws", async () => {
    expect(await run("throw")).toBe("unknown");
  });
  it("does not follow redirects", async () => {
    const { f, calls } = fakeFetch({ [root]: { status: 200 } });
    await flexibleCheck(host, f);
    expect(calls[0]!.init?.redirect).toBe("manual");
  });
  it("has a warning that names the fix", () => {
    expect(flexibleWarning).toMatch(/Full \(strict\)/);
  });
});

describe("validatePastedCert", () => {
  const now = new Date("2027-01-01T00:00:00Z");

  it("accepts a matching pair and returns notAfter as ISO", () => {
    const r = validatePastedCert(host, fx("good.crt"), fx("good.key"), now);
    expect(r.notAfter).toBe(new Date(r.notAfter).toISOString());
    expect(new Date(r.notAfter).getUTCFullYear()).toBeGreaterThan(2060);
  });

  it("accepts a wildcard certificate", () => {
    expect(() => validatePastedCert(host, fx("wildcard.crt"), fx("wildcard.key"), now)).not.toThrow();
  });

  it("uses the first certificate of a chain", () => {
    const chain = fx("good.crt") + fx("wronghost.crt");
    expect(() => validatePastedCert(host, chain, fx("good.key"), now)).not.toThrow();
  });

  const bad: [string, string, string][] = [
    ["wrong host", "wronghost.crt", "wronghost.key"],
    ["expired", "expired.crt", "expired.key"],
    ["mismatched key", "good.crt", "unrelated.key"],
  ];
  it.each(bad)("rejects %s", (_n, c, k) => {
    expect(() => validatePastedCert(host, fx(c), fx(k), now)).toThrow(ErrInvalid);
  });

  it("rejects garbage and empty input without leaking the key", () => {
    const key = fx("good.key");
    const keyBody = key.split("\n")[1]!;
    const cases: [string, string][] = [
      ["garbage", key],
      [fx("good.crt"), "garbage"],
      ["", ""],
      [fx("good.crt"), ""],
      [fx("wronghost.crt"), key],
      [fx("expired.crt"), fx("expired.key")],
      [fx("good.crt"), fx("unrelated.key")],
    ];
    for (const [c, k] of cases) {
      try {
        validatePastedCert(host, c, k, now);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ErrInvalid);
        const m = (e as Error).message;
        expect(m).not.toContain("PRIVATE KEY");
        expect(m).not.toContain(keyBody);
        expect(m.length).toBeGreaterThan(5);
      }
    }
  });
});
