// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// isDocumentNavigation reports whether a request is the browser loading a
// page (not a script's fetch(), an image or another asset): Sec-Fetch-Dest
// says "document", or, from a browser that sends no Sec-Fetch-Dest, Accept
// asks for text/html. The edge sets its visitor cookie and inserts the
// Speed Insights tag only on these.
export function isDocumentNavigation(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  if (dest !== null) return dest.trim().toLowerCase() === "document";
  return /(^|,)\s*text\/html\s*(;|,|$)/i.test(headers.get("accept") ?? "");
}

// visitorScheme is the scheme the visitor used to reach the edge: the
// edge's own, or what a TLS terminator in front of it says in
// X-Forwarded-Proto or Forwarded (the first hop of each).
export function visitorScheme(request: Request): "http" | "https" {
  if (new URL(request.url).protocol === "https:") return "https";
  const xfp = (request.headers.get("x-forwarded-proto") ?? "").split(",")[0]!.trim().toLowerCase();
  if (xfp === "https") return "https";
  const first = (request.headers.get("forwarded") ?? "").split(",")[0]!;
  for (const pair of first.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq).trim().toLowerCase() !== "proto") continue;
    if (
      pair
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "")
        .toLowerCase() === "https"
    )
      return "https";
  }
  return "http";
}
