// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createCloudRunURLs, cloudRunConfig, type IdentityTokenFetcher } from "../cloudrun.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function startBackend(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function fixedToken(token = "tok", ttlMs = 3600_000): IdentityTokenFetcher {
  return async () => ({ token, expiresAt: new Date(Date.now() + ttlMs) });
}

describe("createCloudRunURLs", () => {
  it("attaches the fetched token as a Bearer header", async () => {
    let gotAuth: string | undefined;
    const backendURL = await startBackend((req, res) => {
      gotAuth = req.headers.authorization;
      res.end();
    });

    const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken("secret-token"));
    await resolve("ssr")(new Request("http://example.com/x"));

    expect(gotAuth).toBe("Bearer secret-token");
  });

  // Real bug found running Slice 4's crons verify script for real on
  // Cloud Run: this resolver's own Authorization overwrite (above) was
  // clobbering a client's original Authorization header outright, with
  // nothing to tell host.mjs (the cloud-neutral place that restores it
  // — see local-spawner.test.ts's own matching case) what the original
  // value even was. The original must survive under the reserved
  // x-nbo-forwarded-authorization header so it can be restored there.
  it("preserves the original Authorization under x-nbo-forwarded-authorization", async () => {
    let gotForwarded: string | undefined;
    const backendURL = await startBackend((req, res) => {
      gotForwarded = req.headers["x-nbo-forwarded-authorization"] as string | undefined;
      res.end();
    });

    const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken("secret-token"));
    await resolve("ssr")(
      new Request("http://example.com/x", { headers: { authorization: "Bearer cron-hmac-signature" } }),
    );

    expect(gotForwarded).toBe("Bearer cron-hmac-signature");
  });

  it("sets no x-nbo-forwarded-authorization when the client sent no Authorization at all", async () => {
    let gotForwarded: string | undefined;
    const backendURL = await startBackend((req, res) => {
      gotForwarded = req.headers["x-nbo-forwarded-authorization"] as string | undefined;
      res.end();
    });

    const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken("secret-token"));
    await resolve("ssr")(new Request("http://example.com/x"));

    expect(gotForwarded).toBeUndefined();
  });

  it("rewrites the Host header to match the target", async () => {
    let gotHost: string | undefined;
    const backendURL = await startBackend((req, res) => {
      gotHost = req.headers.host;
      res.end();
    });

    const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
    await resolve("ssr")(new Request("http://example.com/x"));

    expect(gotHost).toBe(backendURL.replace("http://", ""));
  });

  it("caches the token across requests", async () => {
    const backendURL = await startBackend((_req, res) => res.end());
    let calls = 0;
    const fetchToken: IdentityTokenFetcher = async () => {
      calls++;
      return { token: "tok", expiresAt: new Date(Date.now() + 3600_000) };
    };

    const resolve = createCloudRunURLs({ ssr: backendURL }, fetchToken);
    const handler = resolve("ssr");
    await handler(new Request("http://example.com/a"));
    await handler(new Request("http://example.com/b"));

    expect(calls).toBe(1);
  });

  it("refetches an already-expired token", async () => {
    const backendURL = await startBackend((_req, res) => res.end());
    let calls = 0;
    const fetchToken: IdentityTokenFetcher = async () => {
      calls++;
      return { token: `tok${calls}`, expiresAt: new Date(Date.now() - 1000) };
    };

    const resolve = createCloudRunURLs({ ssr: backendURL }, fetchToken);
    const handler = resolve("ssr");
    await handler(new Request("http://example.com/a"));
    await handler(new Request("http://example.com/b"));

    expect(calls).toBe(2);
  });

  it("fails closed, not open, on a token-fetch error", async () => {
    let backendReached = false;
    const backendURL = await startBackend((_req, res) => {
      backendReached = true;
      res.end();
    });
    const fetchToken: IdentityTokenFetcher = async () => {
      throw new Error("token fetch failed");
    };

    const resolve = createCloudRunURLs({ ssr: backendURL }, fetchToken);
    const response = await resolve("ssr")(new Request("http://example.com/x"));

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(backendReached).toBe(false);
  });

  describe("a PPR resume", () => {
    const resumeRequest = (signal?: AbortSignal) =>
      new Request("http://example.com/x", { method: "POST", headers: { "next-resume": "1" }, body: "state", signal });

    function withConfig(overrides: Partial<typeof cloudRunConfig>, run: () => Promise<void>): Promise<void> {
      const saved = { ...cloudRunConfig };
      Object.assign(cloudRunConfig, overrides);
      return run().finally(() => Object.assign(cloudRunConfig, saved));
    }

    it("has a cold-start limit of 60 seconds", () => {
      expect(cloudRunConfig.resumeHeaderTimeoutMs).toBe(60_000);
    });

    it("waits past the ordinary header limit", () =>
      withConfig({ responseHeaderTimeoutMs: 20, resumeHeaderTimeoutMs: 2000 }, async () => {
        const backendURL = await startBackend((_req, res) => {
          setTimeout(() => res.end("resumed"), 100);
        });
        const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
        const response = await resolve("ssr")(resumeRequest());
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("resumed");
      }));

    // The resume limits here are 500 ms, not tens: on a busy CI runner (GitLab, 2026-11-16) a 30 ms limit could expire
    // before the retry even reached the test server, so the server counted one request instead of two.
    it("is retried once, with its body, when no bytes came back", () =>
      withConfig({ authRetryBackoffMs: [1, 1, 1], resumeHeaderTimeoutMs: 500 }, async () => {
        const bodies: string[] = [];
        const backendURL = await startBackend((req, res) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            bodies.push(body);
            if (bodies.length === 2) res.end("second try");
          });
        });
        const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
        const response = await resolve("ssr")(resumeRequest());
        expect(await response.text()).toBe("second try");
        expect(bodies).toEqual(["state", "state"]);
        server!.closeAllConnections();
      }));

    it("gives up after that one retry", () =>
      withConfig({ authRetryBackoffMs: [1, 1, 1], resumeHeaderTimeoutMs: 500 }, async () => {
        let calls = 0;
        const backendURL = await startBackend(() => {
          calls++;
        });
        const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
        const response = await resolve("ssr")(resumeRequest());
        expect(response.status).toBe(502);
        expect(calls).toBe(2);
        server!.closeAllConnections();
      }));

    it("isn't retried once the visitor has gone", () =>
      withConfig({ authRetryBackoffMs: [1, 1, 1], resumeHeaderTimeoutMs: 5000 }, async () => {
        let calls = 0;
        const backendURL = await startBackend(() => {
          calls++;
        });
        const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
        const visitor = new AbortController();
        setTimeout(() => visitor.abort(), 50);
        const response = await resolve("ssr")(resumeRequest(visitor.signal));
        expect(response.status).toBe(502);
        expect(calls).toBe(1);
        server!.closeAllConnections();
      }));

    it("an ordinary POST is still never retried on a timeout", () =>
      withConfig({ authRetryBackoffMs: [1, 1, 1], responseHeaderTimeoutMs: 500 }, async () => {
        let calls = 0;
        const backendURL = await startBackend(() => {
          calls++;
        });
        const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
        const response = await resolve("ssr")(new Request("http://example.com/x", { method: "POST", body: "x" }));
        expect(response.status).toBe(502);
        expect(calls).toBe(1);
        server!.closeAllConnections();
      }));
  });

  it("errors on an unknown function name", () => {
    const resolve = createCloudRunURLs({ ssr: "http://example.com" }, fixedToken());

    expect(() => resolve("missing")).toThrow();
  });

  it("shares one in-flight token fetch across concurrent resolve calls", async () => {
    const backendURL = await startBackend((_req, res) => res.end());
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const fetchToken: IdentityTokenFetcher = async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((r) => setTimeout(r, 20));
      concurrentCalls--;
      return { token: "tok", expiresAt: new Date(Date.now() + 3600_000) };
    };

    const resolve = createCloudRunURLs({ ssr: backendURL }, fetchToken);
    const handler = resolve("ssr");
    await Promise.all([
      handler(new Request(`${backendURL}/a`)),
      handler(new Request(`${backendURL}/b`)),
      handler(new Request(`${backendURL}/c`)),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  it("retries a 401 twice before succeeding on the third attempt", async () => {
    const origBackoff = cloudRunConfig.authRetryBackoffMs;
    cloudRunConfig.authRetryBackoffMs = [1, 1];
    try {
      let calls = 0;
      const backendURL = await startBackend((_req, res) => {
        calls++;
        if (calls < 3) {
          res.writeHead(401).end();
        } else {
          res.end();
        }
      });

      const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
      const response = await resolve("ssr")(new Request("http://example.com/x"));

      expect(calls).toBe(3);
      expect(response.status).toBe(200);
    } finally {
      cloudRunConfig.authRetryBackoffMs = origBackoff;
    }
  });

  it("gives up and returns the last rejection once the backoff schedule is exhausted", async () => {
    const origBackoff = cloudRunConfig.authRetryBackoffMs;
    cloudRunConfig.authRetryBackoffMs = [1, 1];
    try {
      let calls = 0;
      const backendURL = await startBackend((_req, res) => {
        calls++;
        res.writeHead(401).end();
      });

      const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
      const response = await resolve("ssr")(new Request("http://example.com/x"));

      const wantCalls = 1 + cloudRunConfig.authRetryBackoffMs.length;
      expect(calls).toBe(wantCalls);
      expect(response.status).toBe(401);
    } finally {
      cloudRunConfig.authRetryBackoffMs = origBackoff;
    }
  });

  it("gives up within a bounded time when the backend never responds", async () => {
    const origBackoff = cloudRunConfig.authRetryBackoffMs;
    const origTimeout = cloudRunConfig.responseHeaderTimeoutMs;
    cloudRunConfig.authRetryBackoffMs = [1, 1];
    cloudRunConfig.responseHeaderTimeoutMs = 50;
    try {
      const backendURL = await startBackend(() => {
        // never respond
      });

      const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
      const start = Date.now();
      const response = await resolve("ssr")(new Request("http://example.com/x"));

      expect(Date.now() - start).toBeLessThan(2000);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      cloudRunConfig.authRetryBackoffMs = origBackoff;
      cloudRunConfig.responseHeaderTimeoutMs = origTimeout;
    }
  });

  it("does not retry a connection-level failure for a non-safe method", async () => {
    const origBackoff = cloudRunConfig.authRetryBackoffMs;
    cloudRunConfig.authRetryBackoffMs = [1, 1];
    try {
      let calls = 0;
      server = createServer();
      server.on("connection", (socket) => {
        calls++;
        socket.destroy();
      });
      const backendURL = await new Promise<string>((resolvePromise) => {
        server!.listen(0, () => {
          const { port } = server!.address() as AddressInfo;
          resolvePromise(`http://127.0.0.1:${port}`);
        });
      });

      const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
      const response = await resolve("ssr")(new Request("http://example.com/x", { method: "POST", body: "payload" }));

      expect(calls).toBe(1);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      cloudRunConfig.authRetryBackoffMs = origBackoff;
    }
  });

  it("does not retry a response-header timeout for a non-safe method, since the handler may already be running", async () => {
    // Unlike the connection-reset case above, the backend here
    // accepts the request and the handler actually starts (calls++
    // proves it) before the response-header timeout fires — the
    // exact "may already be executing a non-idempotent mutation"
    // scenario isSafeRetryMethod exists to guard against.
    const origBackoff = cloudRunConfig.authRetryBackoffMs;
    const origTimeout = cloudRunConfig.responseHeaderTimeoutMs;
    cloudRunConfig.authRetryBackoffMs = [1, 1];
    cloudRunConfig.responseHeaderTimeoutMs = 500; // wide enough that the request reaches the server first, even on a busy CI runner
    try {
      let calls = 0;
      const backendURL = await startBackend((_req, _res) => {
        calls++;
        // never respond
      });

      const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
      const response = await resolve("ssr")(new Request("http://example.com/x", { method: "POST", body: "payload" }));

      expect(calls).toBe(1);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      cloudRunConfig.authRetryBackoffMs = origBackoff;
      cloudRunConfig.responseHeaderTimeoutMs = origTimeout;
    }
  });

  // A POST's own function can answer 401/403 too (a login form, a server
  // action), and retrying would run it again. Only a read, or a resume, is
  // safe to send twice.
  describe("401 and 403 retries", () => {
    function withBackoff(run: () => Promise<void>): Promise<void> {
      const saved = cloudRunConfig.authRetryBackoffMs;
      cloudRunConfig.authRetryBackoffMs = [1, 1, 1];
      return run().finally(() => {
        cloudRunConfig.authRetryBackoffMs = saved;
      });
    }

    function rejectTwice(status: number, calls: { n: number }) {
      return (_req: IncomingMessage, res: ServerResponse) => {
        calls.n++;
        if (calls.n < 3) res.writeHead(status).end();
        else res.end();
      };
    }

    it("fetches a new token after a POST was turned away, so only that one POST fails", () =>
      withBackoff(async () => {
        const seen: (string | undefined)[] = [];
        const backendURL = await startBackend((req, res) => {
          seen.push(req.headers.authorization);
          if (seen.length === 1) res.writeHead(401).end();
          else res.end();
        });
        let fetched = 0;
        const tokens: IdentityTokenFetcher = async () => ({
          token: `tok-${++fetched}`,
          expiresAt: new Date(Date.now() + 3600_000),
        });
        const resolve = createCloudRunURLs({ ssr: backendURL }, tokens);
        const post = () => resolve("ssr")(new Request("http://example.com/x", { method: "POST", body: "payload" }));
        expect((await post()).status).toBe(401);
        expect((await post()).status).toBe(200);
        expect(seen).toEqual(["Bearer tok-1", "Bearer tok-2"]);
      }));

    for (const status of [401, 403]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        it(`answers a ${method}'s ${status} at once, having called the function once`, () =>
          withBackoff(async () => {
            const calls = { n: 0 };
            const backendURL = await startBackend(rejectTwice(status, calls));
            const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
            const body = method === "OPTIONS" ? undefined : "payload";
            const response = await resolve("ssr")(new Request("http://example.com/x", { method, body }));
            expect(calls.n).toBe(1);
            expect(response.status).toBe(status);
          }));
      }

      for (const method of ["GET", "HEAD"]) {
        it(`retries a ${method}'s ${status}`, () =>
          withBackoff(async () => {
            const calls = { n: 0 };
            const backendURL = await startBackend(rejectTwice(status, calls));
            const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
            const response = await resolve("ssr")(new Request("http://example.com/x", { method }));
            expect(calls.n).toBe(3);
            expect(response.status).toBe(200);
          }));
      }

      it(`retries a resume's ${status}, with its body`, () =>
        withBackoff(async () => {
          const bodies: string[] = [];
          const backendURL = await startBackend((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              bodies.push(body);
              if (bodies.length < 3) res.writeHead(status).end();
              else res.end();
            });
          });
          const resolve = createCloudRunURLs({ ssr: backendURL }, fixedToken());
          const response = await resolve("ssr")(
            new Request("http://example.com/x", { method: "POST", headers: { "next-resume": "1" }, body: "state" }),
          );
          expect(bodies).toEqual(["state", "state", "state"]);
          expect(response.status).toBe(200);
        }));
    }
  });
});
