// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { pickSticky, newVisitorId, readVisitorId, visitorCookie, stripVisitorCookie, VISITOR_COOKIE } from "../sticky.js";
import type { Backend, Target } from "../registry.js";

function target(...backends: [string, number][]): Target {
  return { host: "app.example", backends: backends.map(([id, weight]) => ({ id, url: `http://${id}.internal`, weight, insecureSkipVerify: false })) };
}

function ids(n: number): string[] {
  return Array.from({ length: n }, () => newVisitorId());
}

function share(t: Target, visitors: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of visitors) {
    const b = pickSticky(t, v);
    counts[b.id!] = (counts[b.id!] ?? 0) + 1;
  }
  return counts;
}

describe("pickSticky", () => {
  it("is deterministic: the same visitor always gets the same backend for the same split", () => {
    const t = target(["k8s", 70], ["cloudrun", 30]);
    for (const v of ids(200)) {
      const first = pickSticky(t, v).id;
      for (let i = 0; i < 5; i++) expect(pickSticky(t, v).id).toBe(first);
    }
  });

  it("honours the weights across many visitors", () => {
    const counts = share(target(["k8s", 70], ["cloudrun", 30]), ids(20_000));
    expect(counts.k8s! / 20_000).toBeGreaterThan(0.67);
    expect(counts.k8s! / 20_000).toBeLessThan(0.73);
  });

  it("never picks a backend with weight 0", () => {
    const t = target(["k8s", 100], ["cloudrun", 0]);
    for (const v of ids(2_000)) expect(pickSticky(t, v).id).toBe("k8s");
  });

  it("70/30 → 50/50 moves only visitors toward the backend that gained, about 20% of them", () => {
    const visitors = ids(20_000);
    const before = target(["k8s", 70], ["cloudrun", 30]);
    const after = target(["k8s", 50], ["cloudrun", 50]);
    let moved = 0;
    for (const v of visitors) {
      const a = pickSticky(before, v).id;
      const b = pickSticky(after, v).id;
      if (a !== b) {
        moved++;
        expect(a).toBe("k8s");
        expect(b).toBe("cloudrun");
      }
    }
    expect(moved / 20_000).toBeGreaterThan(0.17);
    expect(moved / 20_000).toBeLessThan(0.23);
  });

  // Rendezvous moves a visitor only to a backend that gained weight
  // relative to theirs. A transfer shrinks the others in proportion, so
  // when the proportions stay exact everyone who moves goes to the target.
  it("during a transfer A+B → C with proportional steps, visitors only ever move to C", () => {
    const visitors = ids(5_000);
    const steps = [
      target(["a", 60], ["b", 40], ["c", 0]),
      target(["a", 57], ["b", 38], ["c", 5]),
      target(["a", 54], ["b", 36], ["c", 10]),
      target(["a", 30], ["b", 20], ["c", 50]),
      target(["a", 0], ["b", 0], ["c", 100]),
    ];
    for (const v of visitors) {
      let prev = pickSticky(steps[0]!, v).id;
      for (const step of steps.slice(1)) {
        const next = pickSticky(step, v).id;
        if (next !== prev) expect(next).toBe("c");
        prev = next;
      }
    }
  });

  // Whole-number rounding (60/40 → 59/40/1, where exact would be
  // 59.4/39.6) nudges B up relative to A, so a few A visitors move to B.
  // Bounded: well under 2% of all visitors.
  it("a rounded transfer step moves only a sliver of visitors anywhere but the target", () => {
    const visitors = ids(20_000);
    const before = target(["a", 60], ["b", 40], ["c", 0]);
    const after = target(["a", 59], ["b", 40], ["c", 1]);
    let sideways = 0;
    for (const v of visitors) {
      const a = pickSticky(before, v).id;
      const b = pickSticky(after, v).id;
      if (a !== b && b !== "c") sideways++;
    }
    expect(sideways / 20_000).toBeLessThan(0.02);
  });

  it("does not depend on backend order", () => {
    const a = target(["k8s", 70], ["cloudrun", 30]);
    const b = target(["cloudrun", 30], ["k8s", 70]);
    for (const v of ids(500)) expect(pickSticky(a, v).id).toBe(pickSticky(b, v).id);
  });

  it("falls back to the url as the key when a backend has no id", () => {
    const t: Target = {
      host: "h",
      backends: [{ url: "http://one", weight: 1, insecureSkipVerify: false } as Backend, { url: "http://two", weight: 1, insecureSkipVerify: false } as Backend],
    };
    const v = newVisitorId();
    expect(pickSticky(t, v).url).toBe(pickSticky(t, v).url);
  });
});

describe("visitor cookie", () => {
  it("newVisitorId is 32 lowercase hex characters and random", () => {
    const a = newVisitorId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newVisitorId()).not.toBe(a);
  });

  it("readVisitorId finds a valid id among other cookies and rejects malformed ones", () => {
    const id = newVisitorId();
    expect(readVisitorId(new Headers({ cookie: `theme=dark; ${VISITOR_COOKIE}=${id}; x=1` }))).toBe(id);
    expect(readVisitorId(new Headers({ cookie: `${VISITOR_COOKIE}=not-hex` }))).toBeUndefined();
    expect(readVisitorId(new Headers({ cookie: `${VISITOR_COOKIE}=${id}extra` }))).toBeUndefined();
    expect(readVisitorId(new Headers())).toBeUndefined();
    expect(readVisitorId(new Headers({ cookie: `${VISITOR_COOKIE}=bad; ${VISITOR_COOKIE}=${id}` }))).toBe(id);
  });

  it("visitorCookie is HttpOnly, SameSite=Lax, Path=/, has a Max-Age, and adds Secure only for https", () => {
    const id = newVisitorId();
    const plain = visitorCookie(id, false);
    expect(plain).toMatch(new RegExp(`^${VISITOR_COOKIE}=${id};`));
    expect(plain).toContain("Path=/");
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Lax");
    expect(plain).toMatch(/Max-Age=\d+/);
    expect(plain).not.toContain("Secure");
    expect(visitorCookie(id, true)).toContain("Secure");
  });

  it("stripVisitorCookie removes only the edge's cookie and drops an emptied header", () => {
    const id = newVisitorId();
    const h = new Headers({ cookie: `theme=dark; ${VISITOR_COOKIE}=${id}; x=1` });
    stripVisitorCookie(h);
    expect(h.get("cookie")).toBe("theme=dark; x=1");
    const only = new Headers({ cookie: `${VISITOR_COOKIE}=${id}` });
    stripVisitorCookie(only);
    expect(only.has("cookie")).toBe(false);
  });
});
