// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { checkCrons } from "../crons.js";

function cronEntry(id: string, fn: string) {
  return { id, schedule: "* * * * *", target: { function: fn, path: "/api/cron", method: "POST" } };
}

describe("checkCrons", () => {
  it("returns an error naming the cron and the missing function when a cron targets an undeclared function", () => {
    const manifestDoc = { functions: ["ssr"], crons: [cronEntry("a", "nonexistent")] };
    const errs = checkCrons(manifestDoc);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('cron "a"');
    expect(errs[0]!.message).toContain("nonexistent");
  });

  it("returns no cron-related error when a cron targets a declared function", () => {
    // functions is [""] deliberately — isolates the cron check from
    // validateFunction's own on-disk bundle check, mirroring
    // validate_test.go's own TestValidate_PassesWhenACronTargetsADeclaredFunction.
    const manifestDoc = { functions: [""], crons: [cronEntry("a", "")] };
    expect(checkCrons(manifestDoc)).toHaveLength(0);
  });

  it("does not throw when crons is not an array", () => {
    expect(() => checkCrons({ functions: ["ssr"], crons: {} })).not.toThrow();
  });

  it('returns an error containing "duplicate cron id" when two crons share an id', () => {
    const manifestDoc = { functions: ["ssr"], crons: [cronEntry("a", "ssr"), cronEntry("a", "ssr")] };
    const errs = checkCrons(manifestDoc);
    const found = errs.some((e) => e.message.includes("duplicate cron id"));
    expect(found).toBe(true);
  });
});

describe("checkCrons schedule grammar", () => {
  const withSchedule = (schedule: string) => ({ functions: ["ssr"], crons: [{ id: "c", schedule, target: { function: "ssr" } }] });

  for (const ok of ["0 3 * * *", "*/5 * * * *", "0,15,30,45 0 1 1,12 0,6", "59 23 31 12 6", " 0 3 * * * "]) {
    it(`accepts "${ok}"`, () => {
      expect(checkCrons(withSchedule(ok))).toEqual([]);
    });
  }

  for (const bad of ["0-5 * * * *", "60 * * * *", "* * *", "* * * * * *", "*/0 * * * *", "* * 0 * *", "* * * 13 *", "* * * * 7", "+5 * * * *", "1e1 * * * *", ", * * * *", "*/x * * * *", "*/05x * * * *"]) {
    it(`refuses "${bad}", naming the cron`, () => {
      const errs = checkCrons(withSchedule(bad));
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain(`manifest.json: crons: cron "c": schedule "${bad}"`);
    });
  }
});
