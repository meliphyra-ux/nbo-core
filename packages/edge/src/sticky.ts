// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash, randomBytes } from "node:crypto";
import type { Backend, Target } from "./registry.js";

// Keeping a visitor on one cloud.
//
// Each visitor carries a random id in a cookie. The backend that serves
// them is chosen by weighted rendezvous hashing: every backend scores the
// visitor id (a hash of id + the backend's stable key, scaled by its
// weight) and the best score wins. Three properties follow, with no state
// kept anywhere but the cookie:
//
// - The same visitor gets the same backend for as long as the split does
//   not change, on every edge replica.
// - Across many visitors the split is honoured.
// - When weights change, a visitor moves only to a backend whose share
//   grew, so a transfer A+B → C moves people to C and nowhere else, and
//   70/30 → 50/50 moves only the 20% that has to move.
//
// A new deploy on a backend changes nothing here: its visitors stay on it
// and get the new version there.

export const VISITOR_COOKIE = "nbo_v";

// VISITOR_COOKIE_MAX_AGE_SEC: a week. Long enough that a returning visitor
// keeps their cloud; the cookie is only a random number.
export const VISITOR_COOKIE_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const ID_PATTERN = /^[0-9a-f]{32}$/;

export function newVisitorId(): string {
  return randomBytes(16).toString("hex");
}

// readVisitorId returns the first valid visitor id (exactly 32 lowercase
// hex characters) in a Cookie header, or undefined when there is none.
export function readVisitorId(headers: Headers): string | undefined {
  const raw = headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== VISITOR_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    // A malformed one (another path's stale cookie, say) does not hide a
    // valid one later in the header.
    if (ID_PATTERN.test(value)) return value;
  }
  return undefined;
}

export function visitorCookie(id: string, secure: boolean): string {
  return `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE_SEC}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

// stripVisitorCookie removes the edge's own cookie from a request's Cookie
// header, so the app never sees it (nor varies a cache on it). A header
// left empty is dropped.
export function stripVisitorCookie(headers: Headers): void {
  const raw = headers.get("cookie");
  if (raw === null) return;
  const kept = raw
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p.slice(0, p.indexOf("=") < 0 ? p.length : p.indexOf("=")).trim() !== VISITOR_COOKIE);
  if (kept.length === 0) headers.delete("cookie");
  else headers.set("cookie", kept.join("; "));
}

// unitHash maps (visitor id, backend key) to a number strictly between 0
// and 1, uniformly.
function unitHash(visitorId: string, key: string): number {
  const digest = createHash("sha256").update(visitorId).update("\0").update(key).digest();
  // 52 bits fit a double exactly.
  const hi = digest.readUInt32BE(0) & 0xfffff;
  const lo = digest.readUInt32BE(4);
  const n = hi * 2 ** 32 + lo;
  return (n + 0.5) / 2 ** 52;
}

// pickSticky chooses visitorId's backend: the lowest -ln(u)/weight wins
// (weighted rendezvous hashing). Backends with weight 0 never win. The key
// is the backend's id, or its URL when it has none.
export function pickSticky(target: Target, visitorId: string): Backend {
  let best: Backend | undefined;
  let bestScore = Infinity;
  for (const b of target.backends) {
    if (b.weight <= 0) continue;
    const score = -Math.log(unitHash(visitorId, b.id ?? b.url)) / b.weight;
    if (score < bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (!best) throw new Error(`edge: target ${JSON.stringify(target.host)} has no pickable backend`);
  return best;
}
