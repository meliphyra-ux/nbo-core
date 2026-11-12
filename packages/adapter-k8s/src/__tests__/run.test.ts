// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { childEnv, run } from "../run.js";

describe("childEnv", () => {
  const host = { PATH: "/bin", CLOUDSDK_CORE_PROJECT: "host-proj", GOOGLE_APPLICATION_CREDENTIALS: "/host/key.json" };

  it("leaves dev calls (no env) unchanged and strips host gcloud overrides from connected calls", () => {
    expect(childEnv(host, undefined)).toBeUndefined();
    expect(childEnv(host, { CLOUDSDK_CONFIG: "/c" })).toEqual({ PATH: "/bin", CLOUDSDK_CONFIG: "/c" });
    expect(childEnv(host, { DOCKER_CONFIG: "/d" })).toEqual({ ...host, DOCKER_CONFIG: "/d" });
  });

  it("run applies it to the child process", async () => {
    process.env.CLOUDSDK_CORE_PROJECT = "host-proj";
    try {
      const out = await run(process.execPath, ["-e", "console.log(String(process.env.CLOUDSDK_CORE_PROJECT))"], { env: { CLOUDSDK_CONFIG: "/tmp/x" } });
      expect(out.trim()).toBe("undefined");
    } finally {
      delete process.env.CLOUDSDK_CORE_PROJECT;
    }
  });
});

describe("run", () => {
  // A child that exits before reading its stdin makes the write emit
  // EPIPE/EOF on the stdin stream — with no listener, that is an
  // uncaught exception that crashes the whole process. Verified
  // directly outside this suite (a standalone script, since the
  // unfixed crash takes the whole process down with it, not just one
  // test): piping 4MB to a child that exits immediately killed the
  // process outright (exit code 1); the same call against the fixed
  // run() below resolves/rejects cleanly instead.
  it("does not crash the process when a child exits before reading a large stdin input", async () => {
    const largeInput = "x".repeat(4_000_000);
    await expect(run("node", ["-e", "process.exit(0)"], { input: largeInput })).resolves.toBe("");
  });
});
