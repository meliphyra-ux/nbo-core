// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ClientRequest } from "node:http";

// LoadResponse is the outcome of one load-generated request — named
// LoadResponse, not Response, to avoid shadowing the Fetch Response
// this whole rewrite otherwise uses everywhere — port of Response
// (generator.go lines 14-19; Go's own name collides with nothing since
// Go has no ambient Response type).
export interface LoadResponse {
  statusCode?: number;
  backend?: string;
  err?: Error;
}

// Phase names a weight split toward Kubernetes and Cloud Run — port of
// Phase (generator.go lines 21-25).
export interface Phase {
  k8sWeight: number;
  cloudRunWeight: number;
}

// PhaseResult is the counted outcome of one Phase's load window — port
// of PhaseResult (generator.go lines 27-34).
export interface PhaseResult {
  weights: Phase;
  total: number;
  failures: number;
  k8sHits: number;
  cloudRunHits: number;
}

// adminClientTimeoutMs bounds every load and admin request — matching
// Go's own adminClientTimeout (run.go line 35) — so a hung edge or
// backend fails the run instead of blocking it forever. Final review
// finding I2(c): neither fireOne nor setWeights had any timeout at
// all before this.
export const adminClientTimeoutMs = 30_000;

// fireOne fires a single GET request at url with a spoofed Host header
// — fetch() cannot do this (confirmed directly: Node's fetch always
// computes Host from the destination URL, overriding any manual
// attempt to set it — the same restriction @nbo/funcproxy's own
// proxyRequest comment documents for the outgoing-rewrite case), so
// node:http/node:https's own request() is used directly instead, which
// does let a caller set Host distinct from the real connection target
// (confirmed directly) — port of fireOne (generator.go lines 74-98).
export function fireOne(signal: AbortSignal, url: string, host: string): Promise<LoadResponse> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(adminClientTimeoutMs)]);

    const req: ClientRequest = requestFn(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "GET",
        headers: { Host: host },
        signal: combinedSignal,
      },
      (res: IncomingMessage) => {
        const statusCode = res.statusCode;
        const backend = res.headers["x-nbo-edge-backend"] as string | undefined;

        (async () => {
          try {
            // A short read (e.g. a declared Content-Length the body
            // doesn't actually reach) must not count as a success just
            // because the status line already arrived.
            for await (const _chunk of res) {
              // draining only
            }
            resolve({ statusCode, backend });
          } catch (err) {
            resolve({ statusCode, backend, err: err instanceof Error ? err : new Error(String(err)) });
          }
        })();
      },
    );

    req.on("error", (err) => {
      resolve({ err: err instanceof Error ? err : new Error(String(err)) });
    });
    req.end();
  });
}

// generateLoad fires one request every 1000/requestsPerSec ms against
// url with the given Host header, bounded by a concurrency cap, until
// durationMs elapses or signal is aborted. It waits for every
// already-fired request to finish before returning — port of
// GenerateLoad (generator.go lines 36-72).
//
// Ruling (final review, finding I2(b)): a tick that arrives while
// already at the concurrency cap is dropped, not queued. Go's own
// ticker blocks on a buffered-channel send when the semaphore is
// full, so a slow receiver simply never sees the ticks that arrived
// while blocked — Go's own time.Ticker doc: "the ticker adjusts the
// time interval or drops ticks to make up for slow receivers".
// Confirmed directly: queueing instead (this function's own original
// shape) lets an unbounded backlog pile up behind one slow backend,
// firing real requests for far longer than durationMs ever promised.
export function generateLoad(
  signal: AbortSignal,
  url: string,
  host: string,
  requestsPerSec: number,
  concurrency: number,
  durationMs: number,
): Promise<LoadResponse[]> {
  return new Promise((resolveAll) => {
    const deadline = Date.now() + durationMs;
    const responses: LoadResponse[] = [];
    const inFlight = new Set<Promise<void>>();
    let active = 0;

    const interval = setInterval(() => {
      if (Date.now() >= deadline || signal.aborted) {
        clearInterval(interval);
        Promise.all(inFlight).then(() => resolveAll(responses));
        return;
      }
      if (active >= concurrency) return;
      active++;
      const task = fireOne(signal, url, host).then((result) => {
        responses.push(result);
        active--;
      });
      inFlight.add(task);
      task.then(() => inFlight.delete(task));
    }, 1000 / requestsPerSec);
  });
}

// The ids the run gives its two backends. The edge names the backend that
// answered by its id in x-nbo-edge-backend (never by its URL).
export const K8S_BACKEND_ID = "loadtest-kubernetes";
export const CLOUDRUN_BACKEND_ID = "loadtest-cloudrun";

// aggregate counts responses into a PhaseResult. A response is a
// failure if it errored or its status wasn't 200, regardless of any
// backend marker it carries; k8sHits/cloudRunHits count only
// non-failure responses attributed to the matching backend id — port
// of aggregate (generator.go lines 100-119).
export function aggregate(weights: Phase, responses: LoadResponse[]): PhaseResult {
  const result: PhaseResult = { weights, total: responses.length, failures: 0, k8sHits: 0, cloudRunHits: 0 };
  for (const r of responses) {
    if (r.err || r.statusCode !== 200) {
      result.failures++;
      continue;
    }
    if (r.backend === K8S_BACKEND_ID) result.k8sHits++;
    else if (r.backend === CLOUDRUN_BACKEND_ID) result.cloudRunHits++;
  }
  return result;
}
