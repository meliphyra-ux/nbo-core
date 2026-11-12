// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// NULL_BODY_STATUSES must be built with a null body: Node's Response
// constructor throws ("Invalid response status code") on any body for
// them, even an empty one.
export const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

// CACHEABLE_STATUSES are the render results ISR stores, matching what Next
// keeps in its own ISR cache: the page, a not-found page (so a deleted
// post stops being served once it regenerates, and a scan of missing
// slugs doesn't render each time) and redirects. A 5xx (or anything else)
// is never cached: a failed regeneration keeps the stale page.
export const CACHEABLE_STATUSES: ReadonlySet<number> = new Set([200, 301, 302, 307, 308, 404, 410]);

export function isCacheableStatus(status: number): boolean {
  return CACHEABLE_STATUSES.has(status);
}
