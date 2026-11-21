// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { proxyWithAuthRetry, type Auth } from "./cloudrun.js";
import type { Resolver } from "./proxy.js";
import { signRequest } from "./sigv4.js";

// lambdaConfig: a cold Lambda container (image pull, Node start) can take
// well past Cloud Run's 3 s before the first header, so Lambda waits longer.
export const lambdaConfig = { responseHeaderTimeoutMs: 15_000 };

// withoutAwsHeaders drops a visitor's x-amz-* headers, so none of them can
// ride along with (and confuse) the signature AWS checks. The visitor's
// Authorization is moved aside by proxyWithAuthRetry.
function withoutAwsHeaders(request: Request): Request {
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!k.toLowerCase().startsWith("x-amz-")) headers.set(k, v);
  return new Request(request, { headers });
}

// createLambdaURLs returns a resolver that proxies each name to its AWS_IAM
// function URL, signed with SigV4 (service lambda) by the execution role's
// credentials Lambda puts in the environment. The body is already buffered
// for retries (proxyWithAuthRetry), so the signature covers its real sha256
// rather than UNSIGNED-PAYLOAD. Only host and the x-amz-* headers are signed:
// the forwarded headers stay free to pass through unchanged.
export function createLambdaURLs(
  urls: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): Resolver {
  const auth: Auth = {
    headers: async (url, method, body) => {
      const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_REGION: region } = env;
      if (!accessKeyId || !secretAccessKey || !region) throw new Error("no AWS credentials in the environment");
      return signRequest({
        method,
        url: url.toString(),
        headers: {},
        body: body ? new Uint8Array(body) : "",
        region,
        service: "lambda",
        credentials: { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN },
        now: now(),
      });
    },
    // Credentials are read from the environment on every attempt.
    invalidate: () => {},
    responseHeaderTimeoutMs: lambdaConfig.responseHeaderTimeoutMs,
  };
  return (name: string) => {
    const raw = urls[name];
    if (!raw) throw new Error(`funcproxy: no Lambda URL for function "${name}"`);
    const target = new URL(raw);
    return (request: Request) => proxyWithAuthRetry(withoutAwsHeaders(request), target, auth);
  };
}
