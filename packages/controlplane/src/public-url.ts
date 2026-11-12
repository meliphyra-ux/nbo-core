// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// NBO's own public address (NBO_PUBLIC_URL), usually Caddy in front of the
// control-plane (compose.public.yaml). On it, API tokens and the per-project
// webhooks reach the API; a request with no token is refused (guardRequest
// in api-tokens.ts), since the loopback rule trusts the Host header. main.ts
// parses it once and refuses to start on a bad value; everything else reads
// V2.publicUrl.

// parsePublicUrl: undefined when unset; otherwise an https origin with no
// path, query, fragment or credentials, or it throws naming the problem.
export function parsePublicUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`NBO_PUBLIC_URL "${value}" is not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`NBO_PUBLIC_URL must be an https:// address, not ${url.protocol}//`);
  if (url.pathname !== "/") throw new Error(`NBO_PUBLIC_URL must not have a path (got "${url.pathname}"); NBO is served at the root of its address`);
  if (url.search !== "" || url.hash !== "") throw new Error("NBO_PUBLIC_URL must not have a query or fragment");
  if (url.username !== "" || url.password !== "") throw new Error("NBO_PUBLIC_URL must not hold a user name or password");
  return url;
}

// hostName: a Host header's name as a proxy matches it: lowercase, the port
// removed, one trailing dot removed, IPv6 kept in its brackets. Caddy's host
// matcher ignores the port and forwards Host unchanged, so "nbo.example.com:443"
// and "NBO.EXAMPLE.COM." reach NBO as the public address.
export function hostName(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end === -1 ? h : h.slice(0, end + 1);
  } else {
    const colon = h.lastIndexOf(":");
    if (colon !== -1) h = h.slice(0, colon);
  }
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

// isPublicHost: did this request arrive on the public address, in any
// spelling of its name (port, case, trailing dot)?
export function isPublicHost(request: Request, publicUrl: URL | undefined): boolean {
  const host = request.headers.get("host");
  return publicUrl !== undefined && host !== null && hostName(host) === hostName(publicUrl.hostname);
}
