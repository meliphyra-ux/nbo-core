// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLambdaURLs, lambdaConfig } from "../lambda.js";
import { cloudRunConfig } from "../cloudrun.js";
import { signRequest } from "../sigv4.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer };

function backend(delayMs = 0): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
        setTimeout(() => res.end("ok"), delayMs);
      });
    });
    server.listen(0, () => resolve({ base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen }));
  });
}

const env = {
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  AWS_SESSION_TOKEN: "session-token",
  AWS_REGION: "eu-west-1",
};
const now = new Date("2026-11-20T12:00:00Z");

describe("createLambdaURLs", () => {
  it("signs the call it sends (host, path, query, body) with SigV4 for the lambda service", async () => {
    const { base, seen } = await backend();
    const resolve = createLambdaURLs({ ssr: base }, env, () => now);
    const response = await resolve("ssr")(
      new Request("http://visitor.example/a%20b/c?z=1&a=2", {
        method: "POST",
        body: "hello",
        headers: { authorization: "Bearer visitor", "content-type": "text/plain" },
      }),
    );
    expect(await response.text()).toBe("ok");

    const got = seen[0]!;
    expect(got.body.toString()).toBe("hello");
    expect(got.headers["x-amz-date"]).toBe("20261120T120000Z");
    expect(got.headers["x-amz-security-token"]).toBe("session-token");
    // The visitor's own Authorization survives for the function (host.mjs restores it).
    expect(got.headers["x-nbo-forwarded-authorization"]).toBe("Bearer visitor");
    // Recompute from what arrived: the signature covers exactly that request.
    const expected = signRequest({
      method: got.method,
      url: `${base}${got.url}`,
      headers: {},
      body: got.body,
      region: "eu-west-1",
      service: "lambda",
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
      },
      now,
    });
    expect(got.headers.authorization).toBe(expected.authorization);
    expect(got.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261120\/eu-west-1\/lambda\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
  });

  it("answers 502 without calling the function when the environment has no credentials", async () => {
    const { base, seen } = await backend();
    const response = await createLambdaURLs({ ssr: base }, {})("ssr")(new Request("http://x/"));
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("funcproxy: no AWS credentials in the environment");
    expect(seen).toHaveLength(0);
  });

  it("drops the visitor's own x-amz-* headers before signing", async () => {
    const { base, seen } = await backend();
    const response = await createLambdaURLs({ ssr: base }, { ...env, AWS_SESSION_TOKEN: "" }, () => now)("ssr")(
      new Request("http://visitor.example/", {
        headers: { "x-amz-security-token": "visitor", "X-Amz-Content-Sha256": "visitor", "x-other": "kept" },
      }),
    );
    expect(response.status).toBe(200);
    const got = seen[0]!;
    expect(got.headers["x-amz-security-token"]).toBeUndefined();
    expect(got.headers["x-amz-content-sha256"]).toBeUndefined();
    expect(got.headers["x-other"]).toBe("kept");
    expect(got.headers.authorization).toMatch(/SignedHeaders=host;x-amz-date, /);
  });

  it("waits longer than Cloud Run for a cold function's first header", async () => {
    expect(lambdaConfig.responseHeaderTimeoutMs).toBe(15_000);
    const saved = cloudRunConfig.responseHeaderTimeoutMs;
    cloudRunConfig.responseHeaderTimeoutMs = 50;
    try {
      // A POST is never retried, so a 50 ms limit would fail it outright.
      const { base } = await backend(300);
      const response = await createLambdaURLs({ ssr: base }, env, () => now)("ssr")(
        new Request("http://visitor.example/", { method: "POST", body: "x" }),
      );
      expect(response.status).toBe(200);
    } finally {
      cloudRunConfig.responseHeaderTimeoutMs = saved;
    }
  });
});
