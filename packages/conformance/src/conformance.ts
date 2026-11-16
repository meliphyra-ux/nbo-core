// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { Agent } from "undici";

// Transcript is one HTTP request/expected-response pair, matching
// docs/nbo-spec.md's own transcript description: request, expected
// status, body digest. Exactly one of expectBodySha256/
// expectBodyContains should be set — expectBodyContains exists for a
// page whose exact bytes aren't reproducible build to build — port of
// Transcript (conformance.go lines 13-37).
export interface Transcript {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  expectStatus: number;
  expectBodySha256?: string;
  expectBodyContains?: string;
  // Exact values of response headers (names in any case), checked next to
  // whichever body check is set.
  expectHeaders?: Record<string, string>;
  // Header name to a regular expression the whole value must match.
  expectHeaderPatterns?: Record<string, string>;
}

function sha256Digest(raw: string): string {
  return "sha256:" + createHash("sha256").update(raw).digest("hex");
}

// run executes every transcript against baseURL and returns one error
// per mismatch, each naming the transcript's Path so failures are easy
// to place. An empty return means every transcript passed. insecure
// skips TLS certificate verification — needed against the local kind
// cluster's own selfsigned-issuer cert; never set it against a real
// deployment — port of Run (conformance.go lines 45-98).
//
// Ruling (real bug found running this for real on Windows): an
// unconditionally-created, never-explicitly-closed undici Agent,
// still alive when the CLI's own main.ts calls process.exit()
// immediately after this resolves, crashed the whole process with a
// native libuv assertion ("!(handle->flags & UV_HANDLE_CLOSING)") —
// confirmed directly, reproducible 100% of the time against this
// package's own real fixture, even on a run that never set insecure
// at all (the Agent's own internal timers start on construction, not
// on first use). The dispatcher is now created only when insecure is
// actually requested, and explicitly closed before this function
// returns, so no handle is left for process.exit() to race with.
export async function run(baseURL: string, transcripts: Transcript[], insecure: boolean): Promise<string[]> {
  const errors: string[] = [];
  const dispatcher = insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;

  try {
    for (const tr of transcripts) {
      let response: Response;
      try {
        response = await fetch(`${baseURL}${tr.path}`, {
          method: tr.method,
          headers: tr.headers,
          body: tr.body,
          dispatcher,
        } as RequestInit);
      } catch (err) {
        errors.push(`${tr.path}: request failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const body = await response.text();

      if (response.status !== tr.expectStatus) {
        errors.push(`${tr.path}: expected status ${tr.expectStatus}, got ${response.status}`);
        continue;
      }

      for (const [name, want] of Object.entries(tr.expectHeaders ?? {})) {
        const got = response.headers.get(name);
        if (got !== want)
          errors.push(`${tr.path}: expected header ${name} ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }

      for (const [name, pattern] of Object.entries(tr.expectHeaderPatterns ?? {})) {
        const got = response.headers.get(name);
        if (got === null || !new RegExp(`^(?:${pattern})$`).test(got)) {
          errors.push(
            `${tr.path}: expected header ${name} to match ${JSON.stringify(pattern)}, got ${JSON.stringify(got)}`,
          );
        }
      }

      if (tr.expectBodyContains !== undefined) {
        if (!body.includes(tr.expectBodyContains)) {
          errors.push(
            `${tr.path}: expected body to contain ${JSON.stringify(tr.expectBodyContains)}, got ${JSON.stringify(body)}`,
          );
        }
        continue;
      }

      if (tr.expectBodySha256 === undefined) {
        // Neither body-check field is set: a status-only transcript.
        continue;
      }

      const gotDigest = sha256Digest(body);
      if (gotDigest !== tr.expectBodySha256) {
        errors.push(`${tr.path}: expected body digest ${tr.expectBodySha256}, got ${gotDigest}`);
      }
    }
  } finally {
    await dispatcher?.close();
  }

  return errors;
}
