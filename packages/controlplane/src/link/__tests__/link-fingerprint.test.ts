// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyFingerprint } from "@nbo/link-protocol";
import { createStore } from "../../store/store.js";
import { enrollFromEnvironment } from "../enroll.js";
import { createLinkControl } from "../routes.js";
import { startHarness } from "../../__tests__/v2-harness.js";
import { makeLinkTestKeys, pinLink, type LinkTestKeys } from "../../__tests__/link-keys-fixture.js";
import { startFakePlatform } from "../../__tests__/link-fake-platform.js";

let keys: LinkTestKeys;
beforeAll(async () => {
  keys = await makeLinkTestKeys();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const FP = /^sha256:[A-Za-z0-9_-]{43}$/;
const CODE = "enr_fp_5Tq8LmWvT7bZk4pRs";

async function harness(linked: boolean) {
  const h = await startHarness({ secretKey: true, v2: { link: createLinkControl() } });
  cleanups.push(() => h.close());
  if (linked) await pinLink(h.store, keys);
  return h;
}

describe("encryption key fingerprint", () => {
  it("link status of a linked core carries encryptionKeyFingerprint equal to keyFingerprint(encryptionPublic)", async () => {
    const h = await harness(true);
    const res = await h.call("GET", "/link/status");
    const fp = (res.json as { encryptionKeyFingerprint: string }).encryptionKeyFingerprint;
    expect(fp).toMatch(FP);
    expect(fp).toBe(await keyFingerprint(h.store.getLinkState()!.encryptionPublic));
  });

  it("an unlinked core's status has no encryptionKeyFingerprint", async () => {
    const h = await harness(false);
    const res = await h.call("GET", "/link/status");
    expect(res.json).not.toHaveProperty("encryptionKeyFingerprint");
  });

  it("the enroll answer carries the same fingerprint", async () => {
    const p = await startFakePlatform(keys, { codes: [CODE] });
    cleanups.push(() => p.close());
    const h = await harness(false);
    const res = await h.call("POST", "/system/link/enroll", {
      url: p.url,
      code: CODE,
      ownerKeyFingerprint: keys.owner.keyId,
    });
    expect(res.status).toBe(201);
    const fp = (res.json as { encryptionKeyFingerprint: string }).encryptionKeyFingerprint;
    expect(fp).toMatch(FP);
    expect(fp).toBe(await keyFingerprint(h.store.getLinkState()!.encryptionPublic));
  });

  it("env enrollment logs one line with the core id and the fingerprint, and never the code", async () => {
    const p = await startFakePlatform(keys, { codes: [CODE] });
    cleanups.push(() => p.close());
    const dir = await mkdtemp(join(tmpdir(), "nbo-link-fp-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
    cleanups.push(() => store.close());
    const lines: string[] = [];
    await enrollFromEnvironment(
      { NBO_LINK_ENROLL_URL: p.url, NBO_LINK_ENROLL_CODE: CODE, NBO_LINK_OWNER_KEY: keys.owner.keyId },
      {
        store,
        signal: new AbortController().signal,
        onLinked: () => undefined,
        retryMs: 1,
        log: (l) => void lines.push(l),
      },
    );
    const state = store.getLinkState()!;
    expect(lines).toEqual([
      `control-plane: linked to the platform as ${state.coreId}; encryption key fingerprint ${await keyFingerprint(state.encryptionPublic)}`,
    ]);
    expect(lines.join("\n")).not.toContain(CODE);
  });
});
