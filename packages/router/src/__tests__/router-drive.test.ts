// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { compileMatch } from "../match.js";
import { drivePhase, type CompiledRule, type MiddlewareInvoker } from "../router.js";
import type { Action, Match } from "../rule.js";

function compileRuleForTest(r: { id: string; match: Match; action: Action }): CompiledRule {
  return { id: r.id, compiled: compileMatch(r.match), action: r.action, continue: false };
}

const failMiddleware: MiddlewareInvoker = (fn) => {
  throw new Error("unexpected middleware invocation: " + fn);
};

describe("drivePhase", () => {
  it("advances past a rewrite miss without retrying when retryOnMiss is false", async () => {
    const rules = [
      compileRuleForTest({ id: "r", match: { path: "^/old$" }, action: { type: "rewrite", path: "/new" } }),
    ];
    const rewrites = { count: 0 };
    const result = await drivePhase(
      rules,
      "/old",
      "GET",
      [],
      new Set(),
      rewrites,
      () => false,
      false,
      failMiddleware,
      "never",
    );
    expect(result).toEqual({ done: false, decision: null, path: "/new" });
    expect(rewrites.count).toBe(1);
  });

  it("retries the same rules against the rewritten path when retryOnMiss is true", async () => {
    const rules = [
      compileRuleForTest({ id: "hop1", match: { path: "^/deep$" }, action: { type: "rewrite", path: "/mid" } }),
      compileRuleForTest({ id: "hop2", match: { path: "^/mid$" }, action: { type: "rewrite", path: "/" } }),
    ];
    const rewrites = { count: 0 };
    const result = await drivePhase(
      rules,
      "/deep",
      "GET",
      [],
      new Set(),
      rewrites,
      (p) => p === "/",
      true,
      failMiddleware,
      "never",
    );
    expect(result).toEqual({ done: true, decision: { kind: "serve", staticPath: "/" }, path: "/" });
    expect(rewrites.count).toBe(2);
  });

  it("returns LoopDetected the instant the shared rewrite counter exceeds 8, mid-phase", async () => {
    const rules = [compileRuleForTest({ id: "r", match: { path: "^/x$" }, action: { type: "rewrite", path: "/x" } })];
    const rewrites = { count: 8 };
    const result = await drivePhase(
      rules,
      "/x",
      "GET",
      [],
      new Set(),
      rewrites,
      () => false,
      true,
      failMiddleware,
      "never",
    );
    expect(result.done).toBe(true);
    expect(result.decision?.kind).toBe("loopDetected");
  });
});
