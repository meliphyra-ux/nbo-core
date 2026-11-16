// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyFingerprint } from "@nbo/link-protocol";
import { createStore, type Store } from "../../store/store.js";
import { ErrConflict, ErrInvalid } from "../../store/errors.js";
import { enrollCore, enrollFromEnvironment } from "../enroll.js";
import { makeLinkTestKeys, pinLink, type LinkTestKeys } from "../../__tests__/link-keys-fixture.js";
import { startFakePlatform, type FakePlatform, type FakePlatformOptions } from "../../__tests__/link-fake-platform.js";

let keys: LinkTestKeys;
let ownerFp: string;
beforeAll(async () => {
  keys = await makeLinkTestKeys();
  ownerFp = await keyFingerprint(keys.owner.publicKey);
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

// A code that looks like a real one: the tests look for it in every message.
const CODE = "enr_9fQx2LmWvT7bZk4pRs";

async function platform(opts: FakePlatformOptions = {}): Promise<FakePlatform> {
  const p = await startFakePlatform(keys, opts);
  cleanups.push(() => p.close());
  return p;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nbo-link-enroll-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function bareStore(): Promise<Store> {
  const dir = await tempDir();
  const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(() => store.close());
  return store;
}

const deps = (store: Store) => ({ store, fetch: (...a: Parameters<typeof fetch>) => fetch(...a) });

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a refusal");
}

describe("enrollCore", () => {
  it("enrolls, pins the platform key and adds the first owner key", async () => {
    const p = await platform({ codes: [CODE] });
    const store = await bareStore();
    const state = await enrollCore(deps(store), { url: p.url, code: CODE, ownerKeyFingerprint: ownerFp });
    expect(state.coreId).toBe("core_test");
    expect(state.teamId).toBe("team_test");
    expect(state.platformKeyId).toBe(keys.platform.keyId);
    expect(state.platformKey).toBe(keys.platform.publicKey);
    expect(state.linkHost).toBe(p.host);
    expect(store.getLinkState()).toEqual(state);
    expect(store.openLinkKeys()).not.toBeNull();
    const members = store.listMemberKeys();
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      keyId: ownerFp,
      memberId: keys.owner.memberId,
      role: "owner",
      publicKey: keys.owner.publicKey,
      addedBy: "enrollment",
    });
    // The platform got core's identity key with a valid proof.
    expect(p.enrollRequests).toHaveLength(1);
    expect(JSON.parse(p.enrollRequests[0]!).identityKey).toBe(state.identityPublic);
  });

  it("refuses an owner key that does not match the fingerprint", async () => {
    const p = await platform({ codes: [CODE] });
    const store = await bareStore();
    const err = await caught(
      enrollCore(deps(store), {
        url: p.url,
        code: CODE,
        ownerKeyFingerprint: await keyFingerprint(keys.stranger.publicKey),
      }),
    );
    expect(err).toBeInstanceOf(ErrInvalid);
    expect(err.message).toBe("the platform's owner key does not match the fingerprint you gave");
    expect(store.getLinkState()).toBeNull();
    expect(store.listMemberKeys()).toEqual([]);
  });

  it("refuses a small-order owner or platform key", async () => {
    const zero = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    for (const which of ["owner", "platform"] as const) {
      const p = await platform();
      p.options.enroll = () => ({
        status: 200,
        body: {
          coreId: "core_test",
          teamId: "team_test",
          platformKey:
            which === "platform"
              ? { keyId: "k", publicKey: zero }
              : { keyId: keys.platform.keyId, publicKey: keys.platform.publicKey },
          linkHost: p.host,
          ownerKey: { memberId: "mem_owner", publicKey: which === "owner" ? zero : keys.owner.publicKey },
        },
      });
      const store = await bareStore();
      const fp = which === "owner" ? await keyFingerprint(zero) : ownerFp;
      const err = await caught(enrollCore(deps(store), { url: p.url, code: CODE, ownerKeyFingerprint: fp }));
      expect(err).toBeInstanceOf(ErrInvalid);
      expect(store.getLinkState()).toBeNull();
    }
  });

  it("refuses a core id, team id or owner member id that is not 1 to 128 printable characters", async () => {
    const bad = ["", "has space", "tab\there", "x".repeat(129), "café", "nl\n"];
    for (const field of ["coreId", "teamId", "memberId"] as const) {
      for (const value of bad) {
        const p = await platform();
        p.options.enroll = () => ({
          status: 200,
          body: {
            coreId: field === "coreId" ? value : "core_test",
            teamId: field === "teamId" ? value : "team_test",
            platformKey: { keyId: keys.platform.keyId, publicKey: keys.platform.publicKey },
            linkHost: p.host,
            ownerKey: { memberId: field === "memberId" ? value : "mem_owner", publicKey: keys.owner.publicKey },
          },
        });
        const store = await bareStore();
        const err = await caught(enrollCore(deps(store), { url: p.url, code: CODE, ownerKeyFingerprint: ownerFp }));
        expect(err, `${field}=${JSON.stringify(value)}`).toBeInstanceOf(ErrInvalid);
        expect(store.getLinkState()).toBeNull();
      }
    }
  });

  it("refuses a different link host", async () => {
    const p = await platform({ codes: [CODE], linkHost: "evil.example.test" });
    const store = await bareStore();
    const err = await caught(enrollCore(deps(store), { url: p.url, code: CODE, ownerKeyFingerprint: ownerFp }));
    expect(err).toBeInstanceOf(ErrInvalid);
    expect(err.message).toMatch(/link host/);
    expect(store.getLinkState()).toBeNull();
  });

  it("refuses http on a non-loopback host, and a URL with a path, query or user", async () => {
    const store = await bareStore();
    let called = 0;
    const f = (async () => {
      called++;
      return new Response("{}");
    }) as typeof fetch;
    for (const url of [
      "http://link.example.test",
      "https://link.example.test/v1",
      "https://link.example.test/?a=1",
      "https://u:p@link.example.test",
      "ftp://link.example.test",
      "not a url",
    ]) {
      const err = await caught(enrollCore({ store, fetch: f }, { url, code: CODE, ownerKeyFingerprint: ownerFp }));
      expect(err).toBeInstanceOf(ErrInvalid);
      expect(err.message).not.toContain(CODE);
    }
    expect(called).toBe(0);
  });

  it("refuses when already linked", async () => {
    const p = await platform({ codes: [CODE] });
    const store = await bareStore();
    await pinLink(store, keys);
    const before = store.getLinkState();
    const err = await caught(enrollCore(deps(store), { url: p.url, code: CODE, ownerKeyFingerprint: ownerFp }));
    expect(err).toBeInstanceOf(ErrConflict);
    expect(err.message).toBe("this core is already linked; run nbo-server unlink first");
    expect(p.enrollRequests).toHaveLength(0);
    expect(store.getLinkState()).toEqual(before);
  });

  it("never puts the code in an error", async () => {
    const p = await platform({ enroll: (req) => ({ status: 500, body: { error: `bad code ${req.code}` } }) });
    const store = await bareStore();
    const err = await caught(enrollCore(deps(store), { url: p.url, code: CODE, ownerKeyFingerprint: ownerFp }));
    expect(err.message).not.toContain(CODE);
    expect(String(err.stack)).not.toContain(CODE);
    expect(JSON.stringify(err)).not.toContain(CODE);
    // A 200 whose body is not an enrollment answer, echoing the code, too.
    p.options.enroll = (req) => ({ status: 200, body: { error: req.code } });
    const err2 = await caught(enrollCore(deps(store), { url: p.url, code: CODE, ownerKeyFingerprint: ownerFp }));
    expect(err2.message).not.toContain(CODE);
    expect(store.getLinkState()).toBeNull();
  });

  it("does not follow a redirect", async () => {
    const store = await bareStore();
    const err = await caught(
      enrollCore(
        {
          store,
          fetch: (async () =>
            new Response(null, {
              status: 307,
              headers: { location: "https://elsewhere.test/v1/enroll" },
            })) as typeof fetch,
        },
        { url: "https://link.example.test", code: CODE, ownerKeyFingerprint: ownerFp },
      ),
    );
    expect(err.message).toMatch(/307/);
    expect(store.getLinkState()).toBeNull();
  });
});

describe("enrollFromEnvironment retries", () => {
  const env = (url: string) => ({ NBO_LINK_ENROLL_URL: url, NBO_LINK_ENROLL_CODE: CODE, NBO_LINK_OWNER_KEY: ownerFp });

  it("retries a network error up to 5 times with the given delay", async () => {
    const store = await bareStore();
    const lines: string[] = [];
    let calls = 0;
    const started = Date.now();
    await enrollFromEnvironment(env("https://link.example.test"), {
      store,
      signal: new AbortController().signal,
      onLinked: () => undefined,
      retryMs: 20,
      log: (l) => void lines.push(l),
      fetch: (async () => {
        calls++;
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(calls).toBe(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4 * 20 - 5);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/after 5 attempts/);
    expect(lines[0]).not.toContain(CODE);
    expect(store.getLinkState()).toBeNull();
  });

  it("does not retry an HTTP answer", async () => {
    const p = await platform();
    const store = await bareStore();
    const lines: string[] = [];
    await enrollFromEnvironment(env(p.url), {
      store,
      signal: new AbortController().signal,
      onLinked: () => undefined,
      retryMs: 1,
      log: (l) => void lines.push(l),
    });
    expect(p.enrollRequests).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/was refused/);
  });

  it("a restart error after linking is not logged as a refusal", async () => {
    const p = await platform({ codes: [CODE] });
    const store = await bareStore();
    const lines: string[] = [];
    await enrollFromEnvironment(env(p.url), {
      store,
      signal: new AbortController().signal,
      onLinked: () => {
        throw new Error("restart failed");
      },
      retryMs: 1,
      log: (l) => void lines.push(l),
    });
    expect(store.getLinkState()).not.toBeNull();
    expect(lines.some((l) => l.includes("refused"))).toBe(false);
    expect(lines.some((l) => l.includes("linked to the platform"))).toBe(true);
    expect(lines.some((l) => /restart/i.test(l))).toBe(true);
    expect(p.enrollRequests).toHaveLength(1);
  });
});

describe("enrollment from the environment at startup", () => {
  function logs(): { lines: () => string[] } {
    const seen: string[] = [];
    const take = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(take);
    vi.spyOn(console, "error").mockImplementation(take);
    vi.spyOn(console, "warn").mockImplementation(take);
    return { lines: () => [...seen] };
  }

  async function startMain(env: Record<string, string>, prepare?: (store: Store) => Promise<void>) {
    const { main } = await import("../../main.js");
    const dir = await tempDir();
    const dbPath = join(dir, "nbo.db");
    const keyFile = join(dir, "nbo-secret.key");
    const secretKey = randomBytes(32);
    await writeFile(keyFile, secretKey);
    if (prepare) {
      const s = createStore(dbPath, { secretKey });
      await prepare(s);
      s.close();
    }
    const before = process.exitCode;
    const started = main({
      NBO_CONTROL_PLANE_DB: dbPath,
      NBO_SECRET_KEY_FILE: keyFile,
      NBO_CONTROL_PLANE_ADDR: "127.0.0.1:0",
      NBO_EDGE_ADMIN_URL: "http://127.0.0.1:9",
      ...env,
    });
    cleanups.push(async () => {
      process.exitCode = before;
      await started?.close();
    });
    expect(started).toBeDefined();
    expect(process.exitCode).toBe(before);
    const port = await started!.listening;
    return { port, dbPath, secretKey };
  }

  it("a used code in the environment of a linked core is ignored", async () => {
    const out = logs();
    const p = await platform({ codes: [CODE] });
    const { port } = await startMain(
      { NBO_LINK_ENROLL_URL: p.url, NBO_LINK_ENROLL_CODE: CODE, NBO_LINK_OWNER_KEY: ownerFp },
      (s) => pinLink(s, keys, { linkUrl: "https://platform.example.test", linkHost: "platform.example.test" }),
    );
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(p.enrollRequests).toHaveLength(0);
    expect(out.lines().some((l) => l.includes(CODE))).toBe(false);
    expect(out.lines().some((l) => l.includes("NBO_LINK_ENROLL_CODE"))).toBe(false);
  });

  it("a refused code never stops startup", async () => {
    const out = logs();
    // No codes: the platform answers 410 for every enrollment.
    const p = await platform();
    const { port } = await startMain({
      NBO_LINK_ENROLL_URL: p.url,
      NBO_LINK_ENROLL_CODE: CODE,
      NBO_LINK_OWNER_KEY: ownerFp,
    });
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const refusals = () =>
      out
        .lines()
        .filter((l) => l.startsWith("control-plane: linking with the code from NBO_LINK_ENROLL_CODE was refused: "));
    await p.waitFor(() => refusals().length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(refusals()).toHaveLength(1);
    expect(p.enrollRequests).toHaveLength(1);
    expect(out.lines().some((l) => l.includes(CODE))).toBe(false);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });

  it("enrolls in the background and the link client connects", async () => {
    const out = logs();
    const p = await platform({ codes: [CODE] });
    const { port } = await startMain({
      NBO_LINK_ENROLL_URL: p.url,
      NBO_LINK_ENROLL_CODE: CODE,
      NBO_LINK_OWNER_KEY: ownerFp,
    });
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    await p.waitFor(() => p.connects.length > 0, 10_000);
    expect(out.lines().some((l) => l.includes(CODE))).toBe(false);
  });

  it("names the missing settings when only some are set, and starts", async () => {
    const out = logs();
    const { port } = await startMain({ NBO_LINK_ENROLL_CODE: CODE });
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const lines = out.lines().filter((l) => l.includes("NBO_LINK_ENROLL_URL"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("NBO_LINK_OWNER_KEY");
    expect(out.lines().some((l) => l.includes(CODE))).toBe(false);
  });
});
