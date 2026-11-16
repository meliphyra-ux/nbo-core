// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  enrollBytes,
  importSigningPrivateKey,
  importVerifyKey,
  keyFingerprint,
  parseEnrollResponse,
  sign,
  type EnrollRequest,
} from "@nbo/link-protocol";
import { ErrConflict, ErrInvalid } from "../store/errors.js";
import type { Store } from "../store/store.js";
import { createLinkKeys } from "./keys.js";
import type { LinkState } from "./link-store.js";
import { HttpStatusError, isLoopbackHost, postJson, sameLinkHost } from "./transport.js";

// Enrollment: core trades a one-time code from the platform for its pinned
// platform key, link host and first owner key. The code goes to the platform
// in the request body and nowhere else: no log line, error message or
// journal row carries it.

// ErrEnrollUnreachable: the platform could not be reached (a network error or
// a timeout). Only this kind is worth trying again: any answer at all is a
// refusal, and a code is single use.
export class ErrEnrollUnreachable extends Error {}

const ENROLL_TIMEOUT_MS = 30_000;
const FINGERPRINT = /^sha256:[A-Za-z0-9_-]{43}$/;

// isKeyFingerprint: a key fingerprint as keyFingerprint writes it (sha256: and
// the base64url SHA-256 of the raw public key), the form the dashboard shows.
export function isKeyFingerprint(v: unknown): v is string {
  return typeof v === "string" && FINGERPRINT.test(v);
}

// isLinkId: an id the platform names (core, team, member) is 1 to 128
// printable ASCII characters with no space, so it can't break a log line,
// a journal row or a key list.
export function isLinkId(v: unknown): v is string {
  return typeof v === "string" && /^[!-~]{1,128}$/.test(v);
}

// parseLinkUrl: the platform's base address. https, or http only on a
// loopback host; no path, query, fragment or user.
export function parseLinkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ErrInvalid("the link address is not a valid URL");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    throw new ErrInvalid("the link address must use https (plain http only on a loopback host)");
  }
  if (u.username !== "" || u.password !== "")
    throw new ErrInvalid("the link address must not carry a user name or password");
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "")
    throw new ErrInvalid("the link address must have no path, query or fragment");
  return u;
}

function refusal(status: number): string {
  if (status === 410) return "the platform says the code is used, expired or unknown";
  if (status >= 300 && status < 400) return `the platform answered HTTP ${status} (a redirect, which is not followed)`;
  return `the platform answered HTTP ${status}`;
}

async function validKey(raw: string, what: string): Promise<void> {
  try {
    await importVerifyKey(raw);
  } catch {
    throw new ErrInvalid(`the platform's ${what} is not a valid key`);
  }
}

export async function enrollCore(
  deps: { store: Store; fetch: typeof fetch; signal?: AbortSignal },
  input: { url: string; code: string; ownerKeyFingerprint: string },
): Promise<LinkState> {
  const { store } = deps;
  if (store.getLinkState()) throw new ErrConflict("this core is already linked; run nbo-server unlink first");
  const url = parseLinkUrl(input.url);
  const scheme = url.protocol as "https:" | "http:";
  if (input.code.trim() === "") throw new ErrInvalid("the enrollment code is empty");
  if (!isKeyFingerprint(input.ownerKeyFingerprint))
    throw new ErrInvalid("the owner key fingerprint is not valid (expected sha256:...)");

  const keys = await createLinkKeys();
  const identity = await importSigningPrivateKey(keys.identityPkcs8);
  const request: EnrollRequest = {
    linkVersion: 1,
    code: input.code,
    identityKey: keys.identityPublic,
    encryptionKey: keys.encryptionPublic,
    proof: await sign(
      identity,
      enrollBytes({ code: input.code, identityKey: keys.identityPublic, encryptionKey: keys.encryptionPublic }),
    ),
  };

  let answer: unknown;
  try {
    answer = await postJson(deps.fetch, `${url.origin}/v1/enroll`, request, {
      signal: deps.signal ?? new AbortController().signal,
      timeoutMs: ENROLL_TIMEOUT_MS,
      what: "the platform's enrollment",
    });
  } catch (err) {
    if (err instanceof HttpStatusError) throw new ErrInvalid(refusal(err.status));
    const name = err instanceof Error ? err.name : "";
    if (name === "TypeError" || name === "AbortError" || name === "TimeoutError") {
      throw new ErrEnrollUnreachable(`could not reach the platform at ${url.origin}`);
    }
    throw new ErrInvalid("the platform's enrollment answer is not valid");
  }

  let res;
  try {
    res = parseEnrollResponse(JSON.stringify(answer));
  } catch {
    throw new ErrInvalid("the platform's enrollment answer is not valid");
  }
  if (
    !isLinkId(res.coreId) ||
    !isLinkId(res.teamId) ||
    !isLinkId(res.ownerKey.memberId) ||
    res.platformKey.keyId === ""
  ) {
    throw new ErrInvalid("the platform's enrollment answer is not valid");
  }
  if (!sameLinkHost(res.linkHost, url.host, scheme)) {
    throw new ErrInvalid("the platform named a different link host than the address you gave");
  }
  await validKey(res.platformKey.publicKey, "instruction key");
  await validKey(res.ownerKey.publicKey, "owner key");
  const ownerKeyId = await keyFingerprint(res.ownerKey.publicKey);
  if (ownerKeyId !== input.ownerKeyFingerprint) {
    throw new ErrInvalid("the platform's owner key does not match the fingerprint you gave");
  }

  // Another enrollment may have finished while this one waited.
  if (store.getLinkState()) throw new ErrConflict("this core is already linked; run nbo-server unlink first");
  store.saveLinkState({
    coreId: res.coreId,
    teamId: res.teamId,
    linkUrl: url.origin,
    linkHost: url.host,
    platformKeyId: res.platformKey.keyId,
    platformKey: res.platformKey.publicKey,
    identityPublic: keys.identityPublic,
    identityPkcs8: keys.identityPkcs8,
    encryptionPublic: keys.encryptionPublic,
    encryptionPkcs8: keys.encryptionPkcs8,
    highSeq: 0,
    enrolledAt: new Date().toISOString(),
  });
  try {
    store.addMemberKey({
      keyId: ownerKeyId,
      memberId: res.ownerKey.memberId,
      role: "owner",
      publicKey: res.ownerKey.publicKey,
      addedBy: "enrollment",
    });
  } catch (err) {
    // Half a link is worse than none: without the owner key nothing Tier 2 works.
    store.clearLink();
    throw err;
  }
  const state = store.getLinkState();
  if (!state) throw new Error("the link state was not saved");
  return state;
}

export const ENROLL_SETTINGS = ["NBO_LINK_ENROLL_URL", "NBO_LINK_ENROLL_CODE", "NBO_LINK_OWNER_KEY"] as const;

// enrollFromEnvironment: the install-time enrollment. With all three settings
// and an unlinked core it runs enrollCore in the background (up to `attempts`
// tries, `retryMs` apart, for network errors only) and calls onLinked once
// linked. A linked core ignores the settings without a word, so a used code
// left in a Compose file is harmless. It never throws and never logs the code.
export function enrollFromEnvironment(
  env: Record<string, string | undefined>,
  deps: {
    store: Store;
    signal: AbortSignal;
    onLinked: () => void;
    fetch?: typeof fetch;
    attempts?: number;
    retryMs?: number;
    log?: (line: string) => void;
  },
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const [urlName, codeName, ownerName] = ENROLL_SETTINGS;
  const url = env[urlName]?.trim() ?? "";
  const code = env[codeName]?.trim() ?? "";
  const owner = env[ownerName]?.trim() ?? "";
  const set = [url, code, owner].filter((v) => v !== "").length;
  if (set === 0) return Promise.resolve();
  try {
    if (deps.store.getLinkState()) return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
  if (set < 3) {
    const missing = ENROLL_SETTINGS.filter((_, i) => [url, code, owner][i] === "");
    log(
      `control-plane: not linking: ${ENROLL_SETTINGS.join(", ")} go together, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set`,
    );
    return Promise.resolve();
  }
  // Belt and braces: whatever a message says, the code never reaches the log.
  const scrub = (s: string): string => s.split(code).join("[code]");
  const attempts = deps.attempts ?? 5;
  const retryMs = deps.retryMs ?? 30_000;
  const fetchFn = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (deps.signal.aborted) return resolve();
      const t = setTimeout(done, ms);
      function done(): void {
        clearTimeout(t);
        deps.signal.removeEventListener("abort", done);
        resolve();
      }
      deps.signal.addEventListener("abort", done, { once: true });
    });

  return (async () => {
    for (let n = 1; n <= attempts && !deps.signal.aborted; n++) {
      let state;
      try {
        state = await enrollCore(
          { store: deps.store, fetch: fetchFn, signal: deps.signal },
          { url, code, ownerKeyFingerprint: owner },
        );
      } catch (err) {
        if (deps.signal.aborted) return;
        if (err instanceof ErrConflict) return;
        if (err instanceof ErrEnrollUnreachable) {
          if (n < attempts) {
            await wait(retryMs);
            continue;
          }
          log(
            `control-plane: linking with the code from ${codeName} failed: ${scrub(err.message)} after ${attempts} attempts`,
          );
          return;
        }
        const reason = err instanceof ErrInvalid ? err.message : "an internal error";
        log(`control-plane: linking with the code from ${codeName} was refused: ${scrub(reason)}`);
        return;
      }
      log(
        `control-plane: linked to the platform as ${scrub(state.coreId)}; encryption key fingerprint ${await keyFingerprint(state.encryptionPublic)}`,
      );
      // Linked: a failure to start the link now is not a refusal of the code.
      try {
        deps.onLinked();
      } catch {
        log("control-plane: linked, but starting the link failed; restart NBO to connect");
      }
      return;
    }
  })().catch(() => undefined);
}
