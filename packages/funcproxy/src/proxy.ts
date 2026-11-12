// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { fileURLToPath } from "node:url";
import type { Dispatcher } from "undici";

export type FetchHandler = (request: Request) => Promise<Response>;
export type Resolver = (name: string) => FetchHandler;

// hostScriptPath resolves the real, on-disk path to this package's
// own host.mjs copy — the single public accessor other packages use
// instead of keeping their own copy of the file (adapter-k8s's own
// buildFunctionImage bakes this same file into a function's Docker
// image, retiring internal/nodehost's second and final Go caller).
// Matches local-spawner.ts's own identical resolution.
export function hostScriptPath(): string {
  return fileURLToPath(new URL("./host.mjs", import.meta.url));
}

// proxyRequest forwards request to target, preserving method/body/
// streaming — the one real proxying primitive every resolver in this
// package builds on (createStaticURLs, createLocalSpawner directly;
// createCloudRunURLs via its own extraHeaders for Authorization).
// Go split this across two near-duplicate implementations
// (funcproxy.go's own newReverseProxy, cloudrun.go's own inline
// httputil.NewSingleHostReverseProxy) because httputil.ReverseProxy
// has no clean hook for a per-request header a caller controls;
// Fetch-based proxying has no such limit, so one real implementation
// covers every resolver here.
//
// Host-header rewriting (the fix both of Go's own implementations
// needed after a real regression — see each one's own comment) is
// automatic here: Fetch forbids setting "host" on an outgoing
// request, and confirmed directly (a real local server observing the
// Host header it actually received) that Node's own fetch() always
// computes it from the destination URL, overriding any attempt to
// set it manually. Excluding "host" below when copying headers is
// about not confusing anything downstream with a header fetch() will
// ignore anyway, not about working around a limitation.
export interface ProxyRequestOptions {
  // An AbortSignal bounding this one attempt — createCloudRunURLs's own
  // retry loop uses it to enforce cloudRunConfig.responseHeaderTimeoutMs
  // per attempt, rebuilding a fresh controller each retry.
  signal?: AbortSignal;
  // Overrides the forwarded body. createCloudRunURLs's own retry loop
  // buffers the original request's body once (so it survives a replay
  // across retries, since a stream can only be read once) and passes
  // that buffer here on every attempt instead of request.body directly.
  body?: BodyInit | null;
  // A per-call undici Dispatcher — @nbo/edge's own proxying needs this
  // to scope TLS trust (a self-signed backend's own InsecureSkipVerify
  // flag) and a response-header timeout to exactly the backends that
  // opt in, never globally.
  dispatcher?: Dispatcher;
}

// joinPath joins a target's own path with the forwarded request's path
// without doubling or dropping the slash between them — port of Go's
// httputil.singleJoiningSlash, used by NewSingleHostReverseProxy's own
// default Director.
function joinPath(targetPath: string, requestPath: string): string {
  const targetEndsSlash = targetPath.endsWith("/");
  const requestStartsSlash = requestPath.startsWith("/");
  if (targetEndsSlash && requestStartsSlash) return targetPath + requestPath.slice(1);
  if (!targetEndsSlash && !requestStartsSlash) return `${targetPath}/${requestPath}`;
  return targetPath + requestPath;
}

// mergeQuery concatenates the target's own query string with the
// forwarded request's, matching NewSingleHostReverseProxy's own
// default Director (neither side is dropped, unlike a plain
// assignment that overwrites one with the other).
function mergeQuery(targetQuery: string, requestQuery: string): string {
  if (!targetQuery) return requestQuery;
  if (!requestQuery) return targetQuery;
  return `${targetQuery}&${requestQuery}`;
}

// Hop-by-hop headers are connection-specific and must never be
// forwarded as-is — RFC 7230 §6.1, and the same set
// httputil.ReverseProxy strips. Node's own fetch() throws outright on
// several of these ("invalid transfer-encoding header") rather than
// silently ignoring them, so forwarding them unfiltered doesn't just
// mismatch Go's behavior, it breaks the request entirely.
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "expect"]);

// The codings Node's built-in fetch() (undici) decodes itself. A probe test
// pins this against the running Node, so an upgrade that changes it fails a
// test instead of breaking pages.
export const FETCH_DECODED_CODINGS: ReadonlySet<string> = new Set(["gzip", "x-gzip", "deflate", "br", "zstd"]);

// fetchDecoded mirrors undici's rule for whether it decoded a response body:
// never for HEAD/CONNECT or 101/204/205/304, never without a header, and only
// when every listed coding is known (one unknown coding means no decoding).
export function fetchDecoded(method: string, status: number, contentEncoding: string | null): boolean {
  if (method === "HEAD" || method === "CONNECT") return false;
  if (status === 101 || status === 204 || status === 205 || status === 304) return false;
  if (contentEncoding === null || contentEncoding.trim() === "") return false;
  return contentEncoding.split(",").every((coding) => FETCH_DECODED_CODINGS.has(coding.trim().toLowerCase()));
}

export async function proxyRequest(request: Request, target: URL, extraHeaders?: Record<string, string>, options?: ProxyRequestOptions): Promise<Response> {
  const incoming = new URL(request.url);
  const outgoingURL = new URL(target.toString());
  outgoingURL.pathname = joinPath(target.pathname, incoming.pathname);
  outgoingURL.search = mergeQuery(target.search.slice(1), incoming.search.slice(1));

  // Connection may itself name additional headers that are hop-by-hop
  // for this connection only (RFC 7230 §6.1) — those get stripped too.
  const connectionNamed = new Set<string>();
  for (const name of (request.headers.get("connection") ?? "").split(",")) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed) connectionNamed.add(trimmed);
  }

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase();
    if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower) || connectionNamed.has(lower)) continue;
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(key, value);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = options && "body" in options ? options.body : hasBody ? request.body : undefined;

  // Combines the incoming request's own signal (e.g. @nbo/serve's
  // middleware invoker, bounding the whole middleware call at its
  // budget) with options.signal (a resolver's own per-attempt bound,
  // orthogonal to the first) — either aborting ends the outgoing
  // call. Without this, a caller's signal on request alone did
  // nothing: this function only ever read options.signal, so an
  // aborted inbound request still left its outbound fetch running
  // for however long the backend took to respond.
  const signals = [request.signal, options?.signal].filter((s): s is AbortSignal => s != null);
  const combinedSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

  const response = await fetch(outgoingURL, {
    method: request.method,
    headers,
    body,
    duplex: body instanceof ReadableStream ? "half" : undefined,
    signal: combinedSignal,
    dispatcher: options?.dispatcher,
    // httputil.ReverseProxy never follows a redirect on the backend's
    // behalf — it passes the 3xx straight back to the original
    // caller. fetch()'s own default ("follow") would instead fetch
    // the redirect target itself and serve its body under the
    // original URL, silently breaking every redirect-based response
    // (auth flows, Next.js's own redirect()).
    redirect: "manual",
    // A proxy has no credentials of its own to retry with. With fetch()'s
    // default ("same-origin"), undici answers a 401 to a streamed body with
    // a network error ("expected non-null body source", the spec's retry
    // step), which the edge turned into a 502; "omit" skips that step and
    // passes the backend's 401 through.
    credentials: "omit",
  } as RequestInit);

  // Node's fetch() decompresses a body whose content-encoding it knows
  // but leaves content-encoding/content-length describing the original
  // (now-stale) compressed bytes. Strip them only when fetch() really
  // decoded: it decodes nothing for HEAD, 204/304 and the like, and
  // nothing at all when any listed coding is unknown to it. Stripping
  // in those cases would hand the visitor compressed bytes with no label.
  if (fetchDecoded(request.method, response.status, response.headers.get("content-encoding"))) {
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}

// proxyRequestOrFail wraps proxyRequest, converting a thrown network
// error (backend unreachable, connection reset) into a 502 Response
// instead of letting it reject — the contract every resolver's
// returned FetchHandler should keep, matching what
// createCloudRunURLs already does for its own failures. Static-urls
// and local-spawner use this; createCloudRunURLs calls proxyRequest
// directly instead, since its own retry loop needs to observe a
// thrown error (vs. an ordinary response) to decide whether to retry.
export async function proxyRequestOrFail(request: Request, target: URL, extraHeaders?: Record<string, string>): Promise<Response> {
  try {
    return await proxyRequest(request, target, extraHeaders);
  } catch (err) {
    return new Response(`funcproxy: proxy request failed: ${String(err)}`, { status: 502 });
  }
}
