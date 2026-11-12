// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { run, evaluate, type Config, type Result } from "../run.js";
import type { PhaseResult } from "../generator.js";

let adminServer: Server | undefined;
let proxyServer: Server | undefined;

afterEach(async () => {
  for (const s of [adminServer, proxyServer]) {
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  adminServer = undefined;
  proxyServer = undefined;
});

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, () => {
      const { port } = s.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
    if (!adminServer) adminServer = s;
    else proxyServer = s;
  });
}

const baseConfig: Omit<Config, "proxyURL" | "host" | "adminURL" | "k8sBackendURL" | "cloudRunBackendURL" | "phases" | "phaseDurationMs"> = {
  requestsPerSec: 20,
  concurrency: 5,
};

describe("run", () => {
  it("walks every phase and sets weights in order", async () => {
    const putBodies: string[] = [];
    const adminURL = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        putBodies.push(body);
        res.writeHead(204).end();
      });
    });
    const proxyURL = await startServer((_req, res) => {
      res.setHeader("x-nbo-edge-backend", "https://k8s");
      res.end();
    });

    const cfg: Config = {
      proxyURL,
      host: "test.local",
      adminURL,
      k8sBackendURL: "https://k8s",
      cloudRunBackendURL: "https://cloudrun",
      phases: [
        { k8sWeight: 99, cloudRunWeight: 1 },
        { k8sWeight: 0, cloudRunWeight: 100 },
      ],
      phaseDurationMs: 50,
      ...baseConfig,
    };

    const result = await run(new AbortController().signal, cfg);

    expect(result.phases).toHaveLength(2);
    expect(putBodies).toHaveLength(2);
    expect(putBodies[0]).toContain('"weight":99');
    expect(putBodies[1]).toContain('"weight":100');
  });

  it("skips TLS verification for the second backend only when cloudRunInsecureSkipVerify is set", async () => {
    const putBodies: string[] = [];
    const adminURL = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        putBodies.push(body);
        res.writeHead(204).end();
      });
    });
    const proxyURL = await startServer((_req, res) => {
      res.setHeader("x-nbo-edge-backend", "https://k8s");
      res.end();
    });
    const cfg: Config = {
      proxyURL,
      host: "test.local",
      adminURL,
      k8sBackendURL: "https://k8s",
      cloudRunBackendURL: "https://k8s-b",
      phases: [{ k8sWeight: 50, cloudRunWeight: 50 }],
      phaseDurationMs: 50,
      ...baseConfig,
    };
    await run(new AbortController().signal, cfg);
    await run(new AbortController().signal, { ...cfg, cloudRunInsecureSkipVerify: true });
    const second = (body: string) => (JSON.parse(body) as { backends: { url: string; insecureSkipVerify?: boolean }[] }).backends[1]!;
    expect(second(putBodies[0]!).insecureSkipVerify).toBeUndefined();
    expect(second(putBodies[1]!)).toEqual({ url: "https://k8s-b", weight: 50, insecureSkipVerify: true });
  });

  it("aborts on a weight-setting failure, firing no load at all after it", async () => {
    const adminURL = await startServer((_req, res) => {
      res.writeHead(400).end("nope");
    });
    let proxyHit = false;
    const proxyURL = await startServer((_req, res) => {
      proxyHit = true;
      res.end();
    });

    const cfg: Config = {
      proxyURL,
      host: "test.local",
      adminURL,
      k8sBackendURL: "https://k8s",
      cloudRunBackendURL: "https://cloudrun",
      phases: [{ k8sWeight: 99, cloudRunWeight: 1 }],
      phaseDurationMs: 50,
      ...baseConfig,
    };

    await expect(run(new AbortController().signal, cfg)).rejects.toThrow();
    expect(proxyHit).toBe(false);
  });

  it("changes weights promptly even with slow in-flight requests", async () => {
    const putTimes: number[] = [];
    const adminURL = await startServer((_req, res) => {
      putTimes.push(Date.now());
      res.writeHead(204).end();
    });
    const proxyURL = await startServer((_req, res) => {
      setTimeout(() => {
        res.setHeader("x-nbo-edge-backend", "https://k8s");
        res.end();
      }, 200);
    });

    const cfg: Config = {
      proxyURL,
      host: "test.local",
      adminURL,
      k8sBackendURL: "https://k8s",
      cloudRunBackendURL: "https://cloudrun",
      phases: [
        { k8sWeight: 99, cloudRunWeight: 1 },
        { k8sWeight: 0, cloudRunWeight: 100 },
      ],
      phaseDurationMs: 50,
      requestsPerSec: 100,
      concurrency: 5,
    };

    await run(new AbortController().signal, cfg);

    expect(putTimes).toHaveLength(2);
    expect(putTimes[1]! - putTimes[0]!).toBeLessThan(150);
  });

  // Final-review finding I2(a)+(b): with concurrency 1 and a backend
  // slower than the phase duration, the semaphore stays held by the
  // very first request for the whole run — a queueing implementation
  // would pile up dozens of waiters (one per dropped tick) and fire
  // every one of them later, misattributed to whichever phase
  // happened to be active when it finally got its turn. Dropping
  // saturated ticks instead (matching Go's own ticker semantics)
  // means a request is only ever attributed to the phase active at
  // the moment it was actually sent, and the total stays bounded by
  // how many requests the one open slot could actually get through.
  it("attributes requests to the phase active when sent, and never fires a backlog of queued ticks", async () => {
    const adminURL = await startServer((_req, res) => res.writeHead(204).end());
    const proxyURL = await startServer((_req, res) => {
      setTimeout(() => {
        res.setHeader("x-nbo-edge-backend", "https://k8s");
        res.end();
      }, 300);
    });

    const cfg: Config = {
      proxyURL,
      host: "test.local",
      adminURL,
      k8sBackendURL: "https://k8s",
      cloudRunBackendURL: "https://cloudrun",
      phases: [
        { k8sWeight: 99, cloudRunWeight: 1 },
        { k8sWeight: 0, cloudRunWeight: 100 },
      ],
      phaseDurationMs: 50,
      requestsPerSec: 1000,
      concurrency: 1,
    };

    const result = await run(new AbortController().signal, cfg);

    const totalRequests = result.phases.reduce((sum, p) => sum + p.total, 0);
    expect(totalRequests).toBeLessThanOrEqual(3);
    // The one held slot was acquired right at the start of phase 0,
    // before the weight change to phase 1 could ever land — so any
    // request that did fire must be attributed to phase 0, never to
    // phase 1 (which got zero chances to send anything at all).
    expect(result.phases[1]!.total).toBe(0);
  }, 5000);

  it("rejects an invalid config with a clear error instead of panicking", async () => {
    const adminURL = await startServer((_req, res) => res.writeHead(204).end());
    const proxyURL = await startServer((_req, res) => res.end());
    const base: Config = {
      proxyURL,
      host: "test.local",
      adminURL,
      k8sBackendURL: "https://k8s",
      cloudRunBackendURL: "https://cloudrun",
      phases: [{ k8sWeight: 99, cloudRunWeight: 1 }],
      phaseDurationMs: 1000,
      requestsPerSec: 10,
      concurrency: 5,
    };

    await expect(run(new AbortController().signal, { ...base, requestsPerSec: 0 })).rejects.toThrow();
    await expect(run(new AbortController().signal, { ...base, concurrency: 0 })).rejects.toThrow();
    await expect(run(new AbortController().signal, { ...base, phases: [] })).rejects.toThrow();
    await expect(run(new AbortController().signal, { ...base, phaseDurationMs: 0 })).rejects.toThrow();
  });
});

describe("evaluate", () => {
  it("passes a clean result", () => {
    const result: Result = {
      phases: [
        { weights: { k8sWeight: 99, cloudRunWeight: 1 }, total: 100, failures: 0, k8sHits: 95, cloudRunHits: 5 },
        { weights: { k8sWeight: 0, cloudRunWeight: 100 }, total: 100, failures: 0, k8sHits: 0, cloudRunHits: 100 },
      ],
    };
    expect(evaluate(result)).toHaveLength(0);
  });

  it("flags a weight-0 backend that still got hits", () => {
    const phase: PhaseResult = { weights: { k8sWeight: 0, cloudRunWeight: 100 }, total: 100, failures: 0, k8sHits: 3, cloudRunHits: 97 };
    expect(evaluate({ phases: [phase] }).length).toBeGreaterThan(0);
  });

  it("flags a phase with zero requests instead of silently passing it", () => {
    const phase: PhaseResult = { weights: { k8sWeight: 99, cloudRunWeight: 1 }, total: 0, failures: 0, k8sHits: 0, cloudRunHits: 0 };
    expect(evaluate({ phases: [phase] }).length).toBeGreaterThan(0);
  });
});
