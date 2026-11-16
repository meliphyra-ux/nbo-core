// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { childEnv } from "@nbo/deploy";
import { run } from "../run.js";

describe("childEnv", () => {
  const host = {
    PATH: "/bin",
    CLOUDSDK_CORE_PROJECT: "host-proj",
    CLOUDSDK_AUTH_ACCESS_TOKEN: "host-tok",
    GOOGLE_APPLICATION_CREDENTIALS: "/host/key.json",
  };

  it("leaves dev calls (no env) to inherit the host environment", () => {
    expect(childEnv(host, undefined)).toBeUndefined();
  });

  it("strips the host's gcloud overrides from a connected call", () => {
    const env = childEnv(host, { CLOUDSDK_CONFIG: "/tmp/nbo-gcp/gcloud", DOCKER_CONFIG: "/tmp/d" })!;
    expect(env).toEqual({ PATH: "/bin", CLOUDSDK_CONFIG: "/tmp/nbo-gcp/gcloud", DOCKER_CONFIG: "/tmp/d" });
  });

  it("keeps CLOUDSDK_* values the call sets itself", () => {
    const env = childEnv(host, { CLOUDSDK_CONFIG: "/c", CLOUDSDK_CORE_PROJECT: "mine" })!;
    expect(env.CLOUDSDK_CORE_PROJECT).toBe("mine");
    expect(env.CLOUDSDK_AUTH_ACCESS_TOKEN).toBeUndefined();
  });

  it("merges other env overrides without stripping", () => {
    expect(childEnv(host, { NEXT_ADAPTER_PATH: "/a" })).toEqual({ ...host, NEXT_ADAPTER_PATH: "/a" });
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

// Final-review findings: run.ts was described as a copy of
// @nbo/deploy's own run.ts, but dropped stdin handling entirely and
// has no timeout at all — a build command (or `git clone` of a
// private repo prompting for credentials) that waits on stdin or
// just never exits would hang a Build in "running" forever.
describe("run", () => {
  it("closes the child's stdin immediately, so a command waiting on it doesn't hang", async () => {
    // Waits for stdin to END (EOF) before exiting — hangs forever if
    // the parent never closes stdin, exits immediately if it does.
    await run("node", ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"]);
  }, 5000);

  it("kills a child that outlives timeoutMs and rejects naming the timeout", async () => {
    await expect(run("node", ["-e", "setInterval(() => {}, 1000);"], { timeoutMs: 200 })).rejects.toThrow(/timed out/i);
  }, 5000);
});

describe("run onOutput", () => {
  it("onOutput receives every chunk the command writes", async () => {
    const chunks: string[] = [];
    const out = await run(process.execPath, ["-e", "process.stdout.write('one');process.stderr.write('two')"], {
      onOutput: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toContain("one");
    expect(chunks.join("")).toContain("two");
    expect(chunks.join("").length).toBe(out.length);
  });
});

describe("run timeout", () => {
  it("a timed-out shell command whose grandchild keeps the pipes open still settles", async () => {
    // The shell starts node, which starts another node holding stdout
    // open for 30s — killing only the shell would leave run() pending.
    const script =
      "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});setTimeout(()=>{},30000)";
    const started = Date.now();
    await expect(run(`"${process.execPath}" -e "${script}"`, [], { shell: true, timeoutMs: 500 })).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

describe("run exit codes", () => {
  it("a shell command that exits 1 reports exit code 1 with its output, not ENOENT", async () => {
    await expect(run("echo boom && exit 1", [], { shell: true })).rejects.toThrow(
      /failed with exit code 1:[\s\S]*boom/,
    );
  });
});
