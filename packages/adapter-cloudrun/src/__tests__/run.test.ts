// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { childEnv, run } from "../run.js";

describe("childEnv", () => {
  const host = { PATH: "/bin", CLOUDSDK_CORE_PROJECT: "host-proj", GOOGLE_APPLICATION_CREDENTIALS: "/host/key.json" };

  it("leaves dev calls (no env) unchanged and strips host gcloud overrides from connected calls", () => {
    expect(childEnv(host, undefined)).toBeUndefined();
    expect(childEnv(host, { CLOUDSDK_CONFIG: "/c" })).toEqual({ PATH: "/bin", CLOUDSDK_CONFIG: "/c" });
    expect(childEnv(host, { DOCKER_CONFIG: "/d" })).toEqual({ ...host, DOCKER_CONFIG: "/d" });
  });

  it("strips the host's AWS_* settings from a call that brings its own AWS key pair", () => {
    const aws = { PATH: "/bin", AWS_PROFILE: "host", AWS_SESSION_TOKEN: "host-token", aws_ca_bundle: "/x" };
    const own = { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "eu-west-1" };
    expect(childEnv(aws, own)).toEqual({ PATH: "/bin", ...own });
    expect(childEnv(aws, { DOCKER_CONFIG: "/d" })).toEqual({ ...aws, DOCKER_CONFIG: "/d" });
  });

  it("run applies it to the child process", async () => {
    process.env.CLOUDSDK_CORE_PROJECT = "host-proj";
    try {
      const out = await run("node", ["-e", "console.log(String(process.env.CLOUDSDK_CORE_PROJECT))"], {
        env: { CLOUDSDK_CONFIG: "/tmp/x" },
      });
      expect(out.trim()).toBe("undefined");
    } finally {
      delete process.env.CLOUDSDK_CORE_PROJECT;
    }
  });
});

// gcloud's own Windows installer ships gcloud as a .cmd script (plus
// an extensionless shell script), not a .exe — Node's spawn() refuses
// to run a .cmd/.bat directly (CVE-2024-27980) and, without a shell,
// does not consult PATHEXT the way cmd.exe itself does when resolving
// a bare command name, so `spawn("gcloud", [...])` fails with ENOENT
// even though gcloud is genuinely on PATH. Reproduced here with a
// fake .cmd rather than real gcloud, so this test doesn't depend on
// the SDK being installed.
describe.skipIf(process.platform !== "win32")("run on Windows", () => {
  it("invokes a .cmd-shaped executable found on PATH by its bare name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-cmd-test-"));
    await writeFile(join(dir, "fake-gcloud.cmd"), "@echo off\r\necho hello-from-cmd %1\r\n");

    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${originalPath}`;
    try {
      const out = await run("fake-gcloud", ["world"]);
      expect(out).toContain("hello-from-cmd");
      expect(out).toContain("world");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("refuses an argument containing a shell metacharacter rather than risk injection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-cmd-test-"));
    await writeFile(join(dir, "fake-gcloud.cmd"), "@echo off\r\necho should-never-run\r\n");

    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${originalPath}`;
    try {
      await expect(run("fake-gcloud", ["safe", "danger&ous"])).rejects.toThrow(/shell metacharacter/);
    } finally {
      process.env.PATH = originalPath;
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
