// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGate, parseProtectionHash, verifyPassword } from "../protection.js";

// The same literal is pinned in packages/controlplane's protection test (hashPassword with a salt of sixteen 7s).
const FIXTURE = {
  password: "correct horse battery",
  hash: "scrypt$16384$8$1$BwcHBwcHBwcHBwcHBwcHBw$jqNYMZJ6k8yP9UrEwEFdAphyQW3NDqRG8javhwKNA-0",
};
const SITE = "https://site.example";

const page = (path = "/", headers: Record<string, string> = {}) =>
  new Request(SITE + path, { headers: { accept: "text/html", ...headers } });
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${SITE}/_nbo/protect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

describe("verifyPassword", () => {
  it("verifies the shared fixture hash", async () => {
    expect(await verifyPassword(FIXTURE.hash, FIXTURE.password)).toBe(true);
    expect(await verifyPassword(FIXTURE.hash, "wrong horse battery")).toBe(false);
  });

  it("refuses a malformed hash, naming the variable", () => {
    expect(() => parseProtectionHash("plain-password")).toThrow("NBO_PROTECTION is not a valid protection hash");
    expect(() => parseProtectionHash("scrypt$x$8$1$a$b")).toThrow("NBO_PROTECTION is not a valid protection hash");
    // scrypt needs N to be a power of two; such a hash would pass the start and fail every login.
    expect(() =>
      parseProtectionHash("scrypt$16383$8$1$BwcHBwcHBwcHBwcHBwcHBw$jqNYMZJ6k8yP9UrEwEFdAphyQW3NDqRG8javhwKNA-0"),
    ).toThrow("NBO_PROTECTION is not a valid protection hash");
  });
});

describe("createGate", () => {
  it("refuses a page without a cookie with the password page, and lets one with a valid cookie through", async () => {
    const gate = createGate({ hash: FIXTURE.hash });
    const refused = (await gate(page()))!;
    expect(refused.status).toBe(401);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(refused.headers.get("x-robots-tag")).toBe("noindex");
    const html = await refused.text();
    expect(html).toContain("This site is protected.");
    expect(html).toContain('<label for="password">Password</label>');
    // The page names no product: it shows on the site owner's own domain.
    expect(html).not.toMatch(/NBO/);

    const signedIn = (await gate(post({ password: FIXTURE.password, next: "/docs" })))!;
    expect(await gate(page("/", { cookie: cookieOf(signedIn) }))).toBeNull();
  });

  it("answers non-page requests with plain text", async () => {
    const res = (await createGate({ hash: FIXTURE.hash })(
      new Request(SITE + "/api", { headers: { accept: "application/json" } }),
    ))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("This site is protected.");
  });

  it("sets the cookie on the right password and goes back to next", async () => {
    const res = (await createGate({ hash: FIXTURE.hash })(post({ password: FIXTURE.password, next: "/docs?a=1" })))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/docs?a=1");
    expect(res.headers.get("set-cookie")).toMatch(
      /^nbo_protect=\d+\.[0-9a-f]{64}; .*HttpOnly.*Secure.*SameSite=Lax.*Max-Age=604800/,
    );
  });

  it("never redirects off the site", async () => {
    const gate = createGate({ hash: FIXTURE.hash });
    for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example", "/\t/evil.example", ""]) {
      const res = (await gate(post({ password: FIXTURE.password, next })))!;
      expect(res.headers.get("location"), next).toBe("/");
    }
  });

  it("says a wrong password is wrong", async () => {
    const res = (await createGate({ hash: FIXTURE.hash })(post({ password: "nope nope nope", next: "/" })))!;
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("That password is not right.");
  });

  it("serves the form itself at /_nbo/protect", async () => {
    const res = (await createGate({ hash: FIXTURE.hash })(page("/_nbo/protect")))!;
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("This site is protected.");
  });

  it("rejects a cookie from an older password", async () => {
    const other = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$jqNYMZJ6k8yP9UrEwEFdAphyQW3NDqRG8javhwKNA-0";
    const signedIn = (await createGate({ hash: FIXTURE.hash })(post({ password: FIXTURE.password, next: "/" })))!;
    expect((await createGate({ hash: other })(page("/", { cookie: cookieOf(signedIn) })))!.status).toBe(401);
  });

  it("rejects an expired or forged cookie", async () => {
    let now = 1_800_000_000_000;
    const gate = createGate({ hash: FIXTURE.hash, now: () => now });
    const cookie = cookieOf((await gate(post({ password: FIXTURE.password, next: "/" })))!);
    now += 7 * 24 * 3600 * 1000 + 1000;
    expect((await gate(page("/", { cookie })))!.status).toBe(401);
    const [, expiry] = /=(\d+)\./.exec(cookie)!;
    expect(
      (await gate(page("/", { cookie: `nbo_protect=${Number(expiry) + 999999}.${"0".repeat(64)}` })))!.status,
    ).toBe(401);
  });

  it("limits guesses per address and per process", async () => {
    let now = 1_800_000_000_000;
    const gate = createGate({ hash: FIXTURE.hash, now: () => now });
    const from = (ip: string) => ({ "x-forwarded-for": `9.9.9.9, ${ip}` });
    for (let i = 0; i < 10; i++)
      expect((await gate(post({ password: "wrong guess!" }, from("1.1.1.1"))))!.status).toBe(401);
    const limited = (await gate(post({ password: "wrong guess!" }, from("1.1.1.1"))))!;
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("Too many attempts. Try again in a minute.");
    expect((await gate(post({ password: FIXTURE.password }, from("1.1.1.1"))))!.status).toBe(429);
    expect((await gate(post({ password: "wrong guess!" }, from("2.2.2.2"))))!.status).toBe(401);
    now += 60_000;
    expect((await gate(post({ password: FIXTURE.password }, from("1.1.1.1"))))!.status).toBe(303);

    now += 60_000;
    for (let i = 0; i < 100; i++)
      await gate(post({ password: "wrong guess!" }, from(`10.0.${Math.floor(i / 10)}.${i % 10}`)));
    expect((await gate(post({ password: "wrong guess!" }, from("3.3.3.3"))))!.status).toBe(429);
  }, 60_000);

  it("lets a signed cron through and refuses a bad signature or an old timestamp", async () => {
    const now = 1_800_000_000_000;
    const gate = createGate({ hash: FIXTURE.hash, cronSecret: "cron-secret", now: () => now });
    const cron = (ts: number, secret = "cron-secret") =>
      new Request(SITE + "/api/cron", {
        headers: {
          "x-nbo-cron": "nightly",
          "x-nbo-cron-timestamp": String(ts),
          authorization: `Bearer ${createHmac("sha256", secret).update(`nightly:${ts}`).digest("hex")}`,
        },
      });
    const ts = Math.floor(now / 1000);
    expect(await gate(cron(ts))).toBeNull();
    expect((await gate(cron(ts, "other")))!.status).toBe(401);
    expect((await gate(cron(ts - 301)))!.status).toBe(401);
    expect((await createGate({ hash: FIXTURE.hash, now: () => now })(cron(ts)))!.status).toBe(401);
  });

  it("counts parallel guesses before checking them, so a burst cannot get past the limit", async () => {
    const gate = createGate({ hash: FIXTURE.hash });
    const from = { "x-forwarded-for": "4.4.4.4" };
    const answers = await Promise.all(
      Array.from({ length: 30 }, () => gate(post({ password: "wrong guess!" }, from)).then((r) => r!.status)),
    );
    expect(answers.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
    expect(answers.filter((s) => s === 429).length).toBeGreaterThanOrEqual(20);
  }, 60_000);

  it("refuses a form body over 8 KiB even without a content-length", async () => {
    const big = new TextEncoder().encode("password=" + "x".repeat(20_000));
    const body = new ReadableStream({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const req = new Request(`${SITE}/_nbo/protect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit);
    expect((await createGate({ hash: FIXTURE.hash })(req))!.status).toBe(413);
  });

  it("leaves /_nbo/revalidate to its own secret", async () => {
    const req = new Request(SITE + "/_nbo/revalidate", { method: "POST", body: "{}" });
    expect(await createGate({ hash: FIXTURE.hash })(req)).toBeNull();
  });
});
