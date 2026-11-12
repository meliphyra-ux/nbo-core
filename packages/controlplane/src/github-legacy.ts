// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Kept for a migration period: the read path for projects an older NBO linked to its own per-server
// GitHub App (GitConfig.github). It reads the app id and its sealed private
// key that NBO stored then, signs the app's JWT, and asks GitHub for an
// installation token narrowed to the one repository, read-only. Tokens are
// cached in memory until 5 minutes before they expire, never stored and
// never logged. Nothing else of the app is here: no events, check runs,
// webhooks or routes. Delete this file once no install has linked projects.
import { createSign } from "node:crypto";
import type { Store } from "./store.js";
import type { GitConfig } from "./git.js";
import { headerAuth, type GitAuth } from "./git-credentials.js";

export type GitHubLink = NonNullable<GitConfig["github"]>;

export interface LegacyGitHub {
  // env: the git environment for the linked repository. repo scopes the
  // header to that URL (the stored GitConfig.repo); without it, GitHub's.
  env(link: GitHubLink, repo?: string): Promise<GitAuth | null>;
}

export const lostAccessMessage = (fullName: string): string => `NBO's GitHub App can't reach ${fullName} any more. Check the app's access on GitHub.`;

const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

// signAppJwt: header {"alg":"RS256","typ":"JWT"}, claims { iat: now-60,
// exp: now+540, iss: appId } (GitHub allows at most 10 minutes).
function signAppJwt(appId: number, pem: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const part = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(pem).toString("base64url")}`;
}

// mintToken: POST /app/installations/{id}/access_tokens, one deadline,
// redirects never followed (the JWT goes nowhere but the API URL), errors
// that carry GitHub's status only.
async function mintToken(api: string, doFetch: typeof fetch, jwt: string, link: GitHubLink): Promise<{ token: string; expiresAt: number | null }> {
  const res = await doFetch(`${api}/app/installations/${link.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nbo-controlplane",
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repository_ids: [link.repoId], permissions: { contents: "read" } }),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("GitHub's answer was too large");
  if (res.status !== 201 && res.status !== 200) throw new Error(`GitHub answered ${res.status}`);
  let parsed: { token?: unknown; expires_at?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error("GitHub's answer wasn't JSON");
  }
  if (typeof parsed.token !== "string" || parsed.token === "") throw new Error("GitHub's answer had no token");
  const expiresAt = typeof parsed.expires_at === "string" ? Date.parse(parsed.expires_at) : NaN;
  return { token: parsed.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}

// createLegacyGitHub: urls.api is api.github.com in the real process (tests
// give the fake's address).
export function createLegacyGitHub(store: Store, urls: { api: string }, fetchImpl?: typeof fetch, now: () => number = Date.now): LegacyGitHub {
  const api = urls.api.replace(/\/+$/, "");
  const doFetch = fetchImpl ?? fetch;
  // Keyed by installation and repository; in-flight mints are shared so two
  // concurrent first calls mint once.
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();

  const token = (link: GitHubLink): Promise<string> => {
    const key = `${link.installationId}|${link.repoId}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt - now() > TOKEN_REUSE_MARGIN_MS) return Promise.resolve(hit.token);
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const p = (async () => {
      const appId = store.legacyGitHubAppId();
      const pem = store.getServerSecret("github_private_key");
      if (appId === null || pem === undefined) throw new Error("no GitHub App is stored");
      const minted = await mintToken(api, doFetch, signAppJwt(appId, pem, now()), link);
      cache.set(key, { token: minted.token, expiresAt: minted.expiresAt ?? now() + 60 * 60_000 });
      return minted.token;
    })().finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };

  return {
    async env(link, repo) {
      // The repository was removed from the installation (an older NBO
      // recorded it): say so rather than a generic git error.
      if (link.accessLost) throw new Error(lostAccessMessage(link.fullName));
      let t: string;
      try {
        t = await token(link);
      } catch (err) {
        throw new Error(lostAccessMessage(link.fullName), { cause: err });
      }
      return headerAuth(repo ?? `https://github.com/${link.fullName}.git`, "x-access-token", t);
    },
  };
}
