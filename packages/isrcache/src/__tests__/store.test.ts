// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createStore } from "../store.js";

describe("Store", () => {
  it("is fresh within revalidateSec", () => {
    const store = createStore();
    store.set("k", { body: new Uint8Array([1]) }, 1, 10);
    const got = store.get("k");
    expect(got?.state).toBe("fresh");
  });

  it("is stale after revalidateSec but before expireSec", () => {
    const store = createStore();
    store.set("k", { body: new Uint8Array([1]) }, 0, 10);
    const got = store.get("k");
    expect(got?.state).toBe("stale");
    expect(got?.entry.body).toEqual(new Uint8Array([1]));
  });

  it("is missing after expireSec", () => {
    const store = createStore();
    store.set("k", { body: new Uint8Array([1]) }, 0, 0);
    expect(store.get("k")).toBeUndefined();
  });

  it("an unknown key is missing", () => {
    const store = createStore();
    expect(store.get("nope")).toBeUndefined();
  });

  it("invalidateTags removes only entries carrying any of the given tags", () => {
    const store = createStore();
    store.set("a", { body: new Uint8Array(), tags: ["blog"] }, 10, 10);
    store.set("b", { body: new Uint8Array(), tags: ["other"] }, 10, 10);
    store.invalidateTags(["blog"]);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).not.toBeUndefined();
  });

  it("invalidatePaths removes only entries whose own path is in the given list", () => {
    const store = createStore();
    store.set("a", { body: new Uint8Array(), path: "/blog/1" }, 10, 10);
    store.set("b", { body: new Uint8Array(), path: "/blog/2" }, 10, 10);
    store.invalidatePaths(["/blog/1"]);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).not.toBeUndefined();
  });
});

describe("Store byte limit", () => {
  const big = (n: number) => ({ body: new Uint8Array(n) });

  // The spec refuses any entry over a quarter of the limit, so at least
  // four entries always fit: eviction is shown with five 200-byte ones
  // (the plan's three 400-byte example cannot be stored under that rule).
  it("evicts the oldest entries over maxBytes", () => {
    const store = createStore({ maxBytes: 1000 });
    for (const k of ["a", "b", "c", "d", "e"]) store.set(k, big(200), 60, 600);
    expect(store.get("a")).toBeUndefined();
    for (const k of ["b", "c", "d", "e"]) expect(store.get(k)).toBeDefined();
  });

  it("a get makes an entry most recently used", () => {
    const store = createStore({ maxBytes: 1000 });
    for (const k of ["a", "b", "c", "d"]) store.set(k, big(200), 60, 600);
    expect(store.get("a")).toBeDefined();
    store.set("e", big(200), 60, 600);
    expect(store.get("a")).toBeDefined();
    expect(store.get("b")).toBeUndefined();
  });

  it("refuses an entry over a quarter of the limit", () => {
    const store = createStore({ maxBytes: 1000 });
    store.set("big", big(300), 60, 600);
    expect(store.get("big")).toBeUndefined();
  });

  it("invalidateTags frees bytes", () => {
    const store = createStore({ maxBytes: 1000 });
    for (const k of ["a", "b", "c", "d"]) store.set(k, { body: new Uint8Array(240), tags: ["t"] }, 60, 600);
    store.invalidateTags(["t"]);
    store.set("e", big(240), 60, 600);
    store.set("f", big(240), 60, 600);
    store.set("g", big(240), 60, 600);
    expect(store.get("e")).toBeDefined();
    expect(store.get("f")).toBeDefined();
    expect(store.get("g")).toBeDefined();
  });

  it("replacing a key does not double count", () => {
    const store = createStore({ maxBytes: 1000 });
    for (let i = 0; i < 10; i++) store.set("a", big(240), 60, 600);
    store.set("b", big(240), 60, 600);
    expect(store.get("a")).toBeDefined();
    expect(store.get("b")).toBeDefined();
  });
});

describe("Store sizing and validation", () => {
  it("counts key, tags and path against the budget", () => {
    const store = createStore({ maxBytes: 1000 });
    for (const k of ["a", "b", "c", "d", "e"])
      store.set(k, { body: new Uint8Array(1), tags: ["x".repeat(100)], path: "p".repeat(100) }, 60, 600);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("e")).toBeDefined();
  });

  it.each([0, -5, NaN, Infinity])("createStore rejects maxBytes %s", (n) => {
    expect(() => createStore({ maxBytes: n })).toThrow();
  });
});
