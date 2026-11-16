// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  fireOne,
  generateLoad,
  aggregate,
  K8S_BACKEND_ID,
  CLOUDRUN_BACKEND_ID,
  type Phase,
  type LoadResponse,
} from "../generator.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function startBackend(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("fireOne", () => {
  it("treats a body shorter than its declared Content-Length as a failure, even with status 200", async () => {
    const url = await startBackend((_req, res) => {
      res.setHeader("content-length", "100");
      res.writeHead(200);
      res.write("short");
      // A plain res.end() leaves the keep-alive socket open — from the
      // client's perspective, nothing yet proves the remaining
      // declared bytes won't still arrive. Destroying the socket
      // forces a real premature-close the client can actually detect.
      res.socket?.destroy();
    });

    const result = await fireOne(new AbortController().signal, url, "test.local");

    expect(result.err).toBeDefined();
  });

  it("respects AbortSignal cancellation", async () => {
    const url = await startBackend((_req, res) => {
      setTimeout(() => res.end("too late"), 2000);
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const start = Date.now();
    const result = await fireOne(controller.signal, url, "test.local");
    const elapsed = Date.now() - start;

    expect(result.err).toBeDefined();
    expect(elapsed).toBeLessThan(500);
  });
});

describe("fireOne", () => {
  // Final-review finding I3: the first Review Focus item (fetch()
  // cannot spoof Host, so fireOne must use node:http/node:https
  // directly) had no test asserting the backend actually observed
  // the spoofed Host — every other test in this file happened to
  // pass even if fireOne silently switched back to fetch(), which
  // would make every real phase's backend-attribution count
  // meaningless without ever failing loudly.
  it("delivers the given host as the real Host header, distinct from the connection target", async () => {
    let gotHost: string | undefined;
    const url = await startBackend((req, res) => {
      gotHost = req.headers.host;
      res.end();
    });

    await fireOne(new AbortController().signal, url, "spoofed.example");

    expect(gotHost).toBe("spoofed.example");
  });
});

describe("generateLoad", () => {
  it("fires roughly the expected number of requests", async () => {
    let count = 0;
    const url = await startBackend((_req, res) => {
      count++;
      res.end();
    });

    // A 200ms window with a floor of 5 flaked under real system load
    // (a full monorepo test run, many packages' own real subprocess
    // tests contending for the CPU at once) — confirmed directly:
    // passes 3/3 in isolation, fails intermittently in that contended
    // condition. A longer window gives the scheduler more ticks to
    // average jitter over, matching this session's own precedent of
    // generous, not aspirationally tight, timing bounds.
    const responses = await generateLoad(new AbortController().signal, url, "test.local", 50, 10, 600);

    expect(responses.length).toBeGreaterThanOrEqual(10);
    expect(responses.length).toBeLessThanOrEqual(50);
    expect(count).toBe(responses.length);
  });

  // Final-review finding I2(b): Go's own ticker blocks on a buffered
  // channel send when the semaphore is full, so a tick that arrives
  // while saturated is simply dropped, not queued — "the ticker
  // adjusts... or drops ticks to make up for slow receivers" (Go's
  // own time.Ticker doc). A TS port that instead queues one waiter
  // per tick indefinitely would let a huge backlog accumulate behind
  // one slow backend and keep firing real requests long after the
  // nominal deadline, rather than bounding total load the way the
  // configured requestsPerSec/duration promise.
  it("drops a tick instead of queueing it when saturated, rather than firing a backlog later", async () => {
    let started = 0;
    const url = await startBackend((_req, res) => {
      started++;
      setTimeout(() => res.end(), 300);
    });

    const responses = await generateLoad(new AbortController().signal, url, "test.local", 1000, 1, 100);

    // With concurrency 1 and a 300ms backend against a 100ms window,
    // Go's own semantics fire essentially one request (the slot is
    // busy for the rest of the window) — a generous upper bound of 3
    // absorbs real scheduling jitter while still clearly separating
    // this from the hundred-plus a queueing implementation would fire.
    expect(responses.length).toBeLessThanOrEqual(3);
    expect(started).toBe(responses.length);
  }, 2000);

  it("never exceeds the given concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const url = await startBackend((_req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        res.end();
      }, 50);
    });

    await generateLoad(new AbortController().signal, url, "test.local", 100, 3, 150);

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

describe("aggregate", () => {
  it("counts attributed hits and failures correctly", () => {
    const weights: Phase = { k8sWeight: 50, cloudRunWeight: 50 };
    const responses: LoadResponse[] = [
      { statusCode: 200, backend: K8S_BACKEND_ID },
      { statusCode: 200, backend: CLOUDRUN_BACKEND_ID },
      { statusCode: 502, backend: K8S_BACKEND_ID },
      { statusCode: 200, backend: "https://k8s" },
      { err: new Error("dial error") },
    ];

    const result = aggregate(weights, responses);

    expect(result).toEqual({ weights, total: 5, failures: 2, k8sHits: 1, cloudRunHits: 1 });
  });
});
