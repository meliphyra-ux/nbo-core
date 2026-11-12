// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mapLimit } from "../concurrency.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("runs at most `limit` items at once and returns results in input order", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapLimit([30, 5, 20, 10, 1, 15], 4, async (ms, i) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await sleep(ms);
      inFlight--;
      return `r${i}`;
    });
    expect(max).toBe(4);
    expect(out).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("rejects with the first failure only after every started item has settled, and starts no new items", async () => {
    const started: number[] = [];
    const settled: number[] = [];
    const err = await mapLimit([0, 1, 2, 3, 4, 5], 4, async (i) => {
      started.push(i);
      try {
        if (i === 1) {
          await sleep(5);
          throw new Error("boom 1");
        }
        if (i === 2) {
          await sleep(15);
          throw new Error("boom 2");
        }
        await sleep(30);
        return i;
      } finally {
        settled.push(i);
      }
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("boom 1");
    expect(started.sort()).toEqual([0, 1, 2, 3]);
    expect(settled.sort()).toEqual([0, 1, 2, 3]);
  });

  it("handles an empty list", async () => {
    await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([]);
  });
});
