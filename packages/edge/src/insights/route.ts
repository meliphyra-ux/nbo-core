// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Reducing a URL to a route: path only (no query, no hash), with
// segments that look like ids or personal data collapsed to [id]. The
// browser loader does the same with the same patterns (script.ts builds
// it from ID_PATTERNS), and the edge re-normalises whatever it receives.

export const MAX_ROUTE_LENGTH = 200;

export const ID_PATTERNS: RegExp[] = [
  // digits
  /^\d+$/,
  // UUIDs
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // long hex
  /^[0-9a-f]{16,}$/i,
  // 20+ character tokens. A token has a digit; a long readable slug
  // ("how-to-deploy-on-kubernetes") does not and is kept.
  /^(?=.*\d)[A-Za-z0-9_.~%+=-]{20,}$/,
  // anything with an @ (email addresses)
  /@/,
];

export function isIdSegment(segment: string): boolean {
  return ID_PATTERNS.some((p) => p.test(segment));
}

// normalizeRoute returns the route for a path, or undefined when the input
// is not a path.
export function normalizeRoute(path: string): string | undefined {
  const cut = path.search(/[?#]/);
  const p = cut < 0 ? path : path.slice(0, cut);
  if (!p.startsWith("/") || p.startsWith("//")) return undefined;
  return p
    .split("/")
    .map((s) => (s !== "" && isIdSegment(s) ? "[id]" : s))
    .join("/");
}
