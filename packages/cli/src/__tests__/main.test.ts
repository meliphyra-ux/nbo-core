// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../main.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const cliDist = join(repoRoot, "packages", "cli", "dist", "main.js");
const nextAppNboDir = join(repoRoot, "fixtures", "next-app", ".nbo");
const imageConformanceDir = join(repoRoot, "fixtures", "conformance", "slice4-image");
// The transcripts resize this image; until it is committed, a build from a
// clean checkout has no /images.jpg and the run answers 404.
const nextAppImage = join(repoRoot, "fixtures", "next-app", "public", "images.jpg");

function makeHandlers() {
  return {
    validate: vi.fn().mockResolvedValue(0),
    serve: vi.fn().mockResolvedValue(0),
    deploy: vi.fn().mockResolvedValue(0),
    plan: vi.fn().mockResolvedValue(0),
    conformance: vi.fn().mockResolvedValue(0),
    contentId: vi.fn().mockResolvedValue(0),
    isrcache: vi.fn().mockResolvedValue(0),
  };
}

describe("dispatch", () => {
  it("routes validate to runValidate with the sliced args", async () => {
    const handlers = makeHandlers();
    await dispatch(["validate", "dir"], handlers);
    expect(handlers.validate).toHaveBeenCalledWith(["dir"]);
  });

  it("routes serve to runServe with the sliced args", async () => {
    const handlers = makeHandlers();
    await dispatch(["serve", "dir", "--port", "5000"], handlers);
    expect(handlers.serve).toHaveBeenCalledWith(["dir", "--port", "5000"]);
  });

  it("routes deploy to runDeploy with the sliced args", async () => {
    const handlers = makeHandlers();
    await dispatch(["deploy", "dir", "--app", "myapp"], handlers);
    expect(handlers.deploy).toHaveBeenCalledWith(["dir", "--app", "myapp"]);
  });

  it("routes plan to runPlan with the sliced args", async () => {
    const handlers = makeHandlers();
    await dispatch(["plan", "dir", "--target", "kubernetes"], handlers);
    expect(handlers.plan).toHaveBeenCalledWith(["dir", "--target", "kubernetes"]);
  });

  it("routes conformance to runConformance with the sliced args", async () => {
    const handlers = makeHandlers();
    await dispatch(["conformance", "dir", "http://x"], handlers);
    expect(handlers.conformance).toHaveBeenCalledWith(["dir", "http://x"]);
  });

  it("routes content-id to the contentId handler with the sliced args", async () => {
    const handlers = makeHandlers();
    await dispatch(["content-id", "x"], handlers);
    expect(handlers.contentId).toHaveBeenCalledWith(["x"]);
  });

  it("routes isrcache to the isrcache handler", async () => {
    const handlers = makeHandlers();
    await dispatch(["isrcache"], handlers);
    expect(handlers.isrcache).toHaveBeenCalledWith([]);
  });

  it("an unknown subcommand prints the usage line and returns 1", async () => {
    const handlers = makeHandlers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatch(["bogus"], handlers)).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a missing subcommand prints the usage line and returns 1", async () => {
    const handlers = makeHandlers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatch([], handlers)).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Real bug found running Slice 4's next/image verify script for real
// on Windows: the real built CLI, running `conformance` against the
// real /_nbo/image endpoint (a real resized JPEG, streamed through
// sharp and @nbo/nodehost's own serveFetch), printed its own "ok"
// success line and then crashed with a native libuv assertion
// ("!(handle->flags & UV_HANDLE_CLOSING)") — exit code non-zero, not
// 0 — right as the process tried to exit. A synthetic server
// returning a plain, non-streamed buffer of the same size did NOT
// reproduce it — confirmed directly; whatever handle state triggers
// this is specific to the real streamed response, not just "a large
// binary body" in general, so this test uses the real fixture rather
// than a stand-in. Root cause: main.ts's own `process.exit(code)`,
// called immediately after dispatch() resolves, forcibly terminates
// the process without letting pending I/O settle first;
// `process.exitCode = code` lets Node drain the event loop naturally
// instead. Skipped when fixtures/next-app/.nbo hasn't been built or the
// fixture's public/images.jpg isn't there
// (a real Next.js build takes 90+ seconds — too slow for a routine
// unit-test run; the real verify scripts always build it fresh).
describe.skipIf(!existsSync(nextAppNboDir) || !existsSync(nextAppImage))("the real compiled CLI's own process exit", () => {
  it("exits 0, not a native crash, after a real conformance run against the real /_nbo/image endpoint", async () => {
    const serveProc = execFileAsync("node", [cliDist, "serve", nextAppNboDir, "--port", "0"]);
    // This test kills the server deliberately once done — the
    // promise then rejects (SIGTERM), which is expected, not a real
    // failure; swallow it so vitest doesn't report an unhandled
    // rejection for a kill this test itself asked for.
    serveProc.catch(() => {});
    // serveFetch's own onListening callback logs the real chosen
    // port to stdout — port 0 above asks the OS for a free one, so
    // this test can run concurrently with anything else using 4108
    // (the verify script's own hardcoded port).
    let port: number | undefined;
    const serveChild = (serveProc as unknown as { child: import("node:child_process").ChildProcess }).child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("nbo serve never logged its own listening port")), 10000);
      serveChild.stdout?.on("data", (chunk: Buffer) => {
        const m = chunk.toString().match(/on :(\d+)/);
        if (m) {
          port = Number(m[1]);
          clearTimeout(timer);
          resolve();
        }
      });
    });

    try {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync("node", [cliDist, "conformance", imageConformanceDir, `http://127.0.0.1:${port}`]));
      } catch (err) {
        throw new Error(`expected exit 0, got: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      expect(stdout).toContain("ok");
    } finally {
      serveChild.kill();
    }
  }, 20000);
});
