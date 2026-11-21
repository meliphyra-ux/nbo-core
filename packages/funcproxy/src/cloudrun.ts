// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { outgoingURL, proxyRequest, type Resolver } from "./proxy.js";

export type IdentityTokenFetcher = (audience: string) => Promise<{ token: string; expiresAt: Date }>;

// cloudRunConfig is a mutable settings object, not plain constants —
// the idiomatic TS equivalent of Go's own cloudRunAuthRetryBackoff/
// cloudRunTransport `var`s, which tests there swap and restore. An
// ES module's imported `let` binding is read-only to importers, so a
// test can't reassign the binding itself; reassigning this object's
// own properties is what a test does instead. Both values are
// already-tuned, real-regression-derived (see cloudrun.go's own
// comments) and copied exactly, not re-derived: a 3-step 200/400/
// 800ms backoff and a 3s response-header timeout.
//
// A PPR resume gets its own limit: its headers can't come before Next
// writes its first bytes, so a cold start lands on it in full, and a
// visitor is already looking at the fallback while it waits.
export const cloudRunConfig = {
  authRetryBackoffMs: [200, 400, 800],
  responseHeaderTimeoutMs: 3000,
  resumeHeaderTimeoutMs: 60_000,
};

// isResume is the platform's own call to render a PPR hole. It is a POST
// only because Next wants the state as a body: rendering it changes
// nothing, so it can be retried where another POST can't. Clients can't
// send this header (@nbo/serve strips it).
function isResume(request: Request): boolean {
  return request.method === "POST" && request.headers.get("next-resume") === "1";
}

// isSafeRetryMethod is true only for methods RFC 7231 §4.2.1 defines
// as safe — a connection-level failure (the backend never responded
// at all) is only safe to blindly retry for these, since otherwise
// the function may already be executing a non-idempotent mutation by
// the time the timeout fires.
function isSafeRetryMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

// cachedToken caches one audience's identity token, serializing
// concurrent fetches through a shared in-flight promise so N
// concurrently-awaited resolve() calls never trigger N redundant
// fetches (a real GCP metadata-server round trip in production) —
// port of cachedToken's own get/invalidate (cloudrun.go lines 22-54).
class CachedToken {
  private value: string | undefined;
  private expiresAt = new Date(0);
  private inFlight: Promise<string> | null = null;

  async get(audience: string, fetchToken: IdentityTokenFetcher): Promise<string> {
    if (this.value !== undefined && Date.now() < this.expiresAt.getTime()) {
      return this.value;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const fetchPromise = (async () => {
      try {
        const { token, expiresAt } = await fetchToken(audience);
        this.value = token;
        this.expiresAt = expiresAt;
        return token;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = fetchPromise;
    return fetchPromise;
  }

  invalidate(): void {
    this.value = undefined;
    this.expiresAt = new Date(0);
  }
}

// createCloudRunURLs returns a resolver that proxies each name to its
// given Cloud Run URL, attaching a Bearer identity token fetched (and
// cached) via fetchToken — port of the token-caching half of
// NewCloudRunURLs (cloudrun.go lines 56-133). Retry-on-401/403 and the
// non-safe-method connection-error rule are Task 5's own addition.
export function createCloudRunURLs(urls: Record<string, string>, fetchToken: IdentityTokenFetcher): Resolver {
  const targets = new Map<string, URL>();
  for (const [name, rawURL] of Object.entries(urls)) {
    try {
      targets.set(name, new URL(rawURL));
    } catch {
      continue;
    }
  }

  const tokens = new Map<string, CachedToken>();

  return (name: string) => {
    const target = targets.get(name);
    if (!target) {
      throw new Error(`funcproxy: no Cloud Run URL for function "${name}"`);
    }
    let cached = tokens.get(name);
    if (!cached) {
      cached = new CachedToken();
      tokens.set(name, cached);
    }
    const token = cached;
    const auth: Auth = {
      headers: async () => {
        try {
          return { Authorization: `Bearer ${await token.get(target.origin, fetchToken)}` };
        } catch (err) {
          throw new Error(`failed to fetch identity token: ${String(err)}`, { cause: err });
        }
      },
      invalidate: () => token.invalidate(),
    };

    return (request: Request): Promise<Response> => proxyWithAuthRetry(request, target, auth);
  };
}

// Auth is what a call to a private function adds: Cloud Run's identity
// token (above) or Lambda's SigV4 signature (lambda.ts), computed per
// attempt over the outgoing URL, method and buffered body. invalidate
// drops a cached credential after a 401/403.
export interface Auth {
  headers: (url: URL, method: string, body: ArrayBuffer | null) => Promise<Record<string, string>>;
  invalidate: () => void;
  // responseHeaderTimeoutMs: this backend's wait for response headers
  // (cloudRunConfig.responseHeaderTimeoutMs when absent).
  responseHeaderTimeoutMs?: number;
}

// proxyWithAuthRetry buffers the request body up front so it can be
// replayed across attempts, then loops: a 401/403 response is retryable
// only for a GET, a HEAD or a PPR resume. It's usually Cloud Run's IAM
// layer turning the call away before the function ran, but the function
// can answer 401/403 itself, so a POST is never sent twice on a guess; a
// thrown/aborted attempt (the backend never responded within
// cloudRunConfig.responseHeaderTimeoutMs, or a connection-level
// failure) is retryable only for a safe method, or once for a PPR resume
// — port of isSafeRetryMethod/roundTripWithAuthRetry (cloudrun.go lines
// 135-211). A thrown attempt means no response headers arrived, so no
// bytes of it have gone anywhere.
export async function proxyWithAuthRetry(request: Request, target: URL, auth: Auth): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const bodyBuffer = hasBody ? await request.arrayBuffer() : null;
  const backoffs = cloudRunConfig.authRetryBackoffMs;
  const resume = isResume(request);

  for (let attempt = 0; ; attempt++) {
    let authHeaders: Record<string, string>;
    try {
      authHeaders = await auth.headers(outgoingURL(request, target), request.method, bodyBuffer);
    } catch (err) {
      return new Response(`funcproxy: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      resume
        ? cloudRunConfig.resumeHeaderTimeoutMs
        : (auth.responseHeaderTimeoutMs ?? cloudRunConfig.responseHeaderTimeoutMs),
    );
    let response: Response | undefined;
    let threwError: unknown;
    // Overwriting Authorization below is Cloud Run's and Lambda's own
    // requirement (their IAM layer needs the token or signature there to
    // let the request through at all) — it would otherwise silently discard
    // whatever Authorization the client sent for the function's own
    // code to check. Stash it under a reserved header so host.mjs can
    // restore it before the function ever sees the request; absent
    // entirely when the client sent no Authorization, matching every
    // other (non-Cloud-Run) path where this header never appears.
    const extraHeaders: Record<string, string> = { ...authHeaders };
    const originalAuth = request.headers.get("authorization");
    if (originalAuth !== null) {
      extraHeaders["X-Nbo-Forwarded-Authorization"] = originalAuth;
    }
    try {
      response = await proxyRequest(request, target, extraHeaders, { signal: controller.signal, body: bodyBuffer });
    } catch (err) {
      threwError = err;
    } finally {
      clearTimeout(timer);
    }

    const rejected = response !== undefined && (response.status === 401 || response.status === 403);
    const retryableStatus = rejected && (request.method === "GET" || request.method === "HEAD" || resume);
    const retryableError =
      threwError !== undefined &&
      !request.signal.aborted &&
      (isSafeRetryMethod(request.method) || (resume && attempt === 0));
    const canRetry = (retryableStatus || retryableError) && attempt < backoffs.length;

    if (!canRetry) {
      // Not retried, but the next call mustn't reuse a token that may be why
      // this one was turned away.
      if (rejected) auth.invalidate();
      if (response !== undefined) return response;
      return new Response(`funcproxy: backend request failed: ${String(threwError)}`, { status: 502 });
    }

    auth.invalidate();
    await new Promise((r) => setTimeout(r, backoffs[attempt]));
  }
}

// metadataServerConfig is a mutable settings object, matching
// cloudRunConfig's own pattern — a test swaps baseURL/timeoutMs and
// restores them afterward.
export const metadataServerConfig = {
  baseURL: "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/identity",
  timeoutMs: 5000,
};

// metadataServerIdentityToken is the real production IdentityTokenFetcher
// — it only works inside a GCP compute environment. The metadata
// server's response body is the raw token string, not JSON; this
// doesn't decode the JWT for one field, and conservatively caches for
// 50 minutes under Google's documented ~1hr token lifetime — port of
// MetadataServerIdentityToken (cloudrun.go lines 213-262).
export const metadataServerIdentityToken: IdentityTokenFetcher = async (audience: string) => {
  const url = new URL(metadataServerConfig.baseURL);
  url.searchParams.set("audience", audience);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), metadataServerConfig.timeoutMs);
  try {
    // The body read happens inside this same try, under the same
    // signal/timer as the request itself: clearing the timer as soon
    // as fetch() resolves on headers (rather than once the body is
    // fully read) would leave a stalled body completely unbounded —
    // and, combined with CachedToken's own in-flight sharing, every
    // concurrent caller waiting on that one shared fetch would hang
    // right along with it, permanently.
    const response = await fetch(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`funcproxy: metadata server returned ${response.status}`);
    }
    const token = await response.text();
    return { token, expiresAt: new Date(Date.now() + 50 * 60 * 1000) };
  } finally {
    clearTimeout(timer);
  }
};
