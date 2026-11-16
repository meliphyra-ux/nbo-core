// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { childEnv } from "@nbo/adapter-cloudrun";
import { run } from "../run.js";

describe("childEnv", () => {
  const host = { PATH: "/bin", CLOUDSDK_CORE_PROJECT: "host-proj", GOOGLE_APPLICATION_CREDENTIALS: "/host/key.json" };

  it("leaves dev calls (no env) unchanged and strips host gcloud overrides from connected calls", () => {
    expect(childEnv(host, undefined)).toBeUndefined();
    expect(childEnv(host, { CLOUDSDK_CONFIG: "/c" })).toEqual({ PATH: "/bin", CLOUDSDK_CONFIG: "/c" });
    expect(childEnv(host, { GOOS: "linux" })).toEqual({ ...host, GOOS: "linux" });
  });

  it("run applies it to the child process", async () => {
    process.env.CLOUDSDK_CORE_PROJECT = "host-proj";
    try {
      const out = await run(process.execPath, ["-e", "console.log(String(process.env.CLOUDSDK_CORE_PROJECT))"], {
        env: { CLOUDSDK_CONFIG: "/tmp/x" },
      });
      expect(out.trim()).toBe("undefined");
    } finally {
      delete process.env.CLOUDSDK_CORE_PROJECT;
    }
  });
});
