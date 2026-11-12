// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createEdgeJobs } from "../edge-jobs.js";
import type { EdgeJob } from "../server-settings.js";
import type { Store } from "../store.js";

function memoryStore(): Store {
  const jobs = new Map<string, EdgeJob>();
  return { getEdgeJob: (k: string) => jobs.get(k), setEdgeJob: (k: string, j: EdgeJob) => void jobs.set(k, j) } as unknown as Store;
}

describe("createEdgeJobs", () => {
  it("marks the job failed with a generic message when scrubbing the error throws", async () => {
    const jobs = createEdgeJobs(memoryStore());
    jobs.start(
      "edge",
      "install",
      "busy",
      async () => {
        throw new Error("kubectl said TOKEN-VALUE");
      },
      () => {
        throw new Error("the sealed relay can't be opened");
      },
    );
    await jobs.settled();
    const job = jobs.latest("edge")!;
    expect(job.status).toBe("failed");
    expect(job.finishedAt).toBeTruthy();
    expect(job.error).toBeTruthy();
    expect(job.error).not.toContain("TOKEN-VALUE");
    expect(jobs.running("edge")).toBe(false);
  });

  it("still scrubs the error of a failed job", async () => {
    const jobs = createEdgeJobs(memoryStore());
    jobs.start(
      "edge",
      "install",
      "busy",
      async () => {
        throw new Error("kubectl said TOKEN-VALUE");
      },
      () => ["TOKEN-VALUE"],
    );
    await jobs.settled();
    expect(jobs.latest("edge")).toMatchObject({ status: "failed" });
    expect(jobs.latest("edge")!.error).toContain("kubectl said");
    expect(jobs.latest("edge")!.error).not.toContain("TOKEN-VALUE");
  });
});
