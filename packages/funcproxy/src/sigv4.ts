// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash, createHmac } from "node:crypto";

// AWS Signature Version 4 for one request (the app signing its calls to its
// functions' AWS_IAM function URLs). Header signing only, no presigned URLs.

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  // The payload hash is sha256 of body, unless headers carry
  // x-amz-content-sha256 (then its value is used and signed).
  body?: string | Uint8Array;
  region: string;
  service: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  now: Date;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding: everything but unreserved characters.
const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// signRequest returns the headers to add: x-amz-date, x-amz-security-token
// (with a session token) and authorization.
export function signRequest(input: SignInput): Record<string, string> {
  const u = new URL(input.url);
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const added: Record<string, string> = { "x-amz-date": amzDate };
  if (input.credentials.sessionToken) added["x-amz-security-token"] = input.credentials.sessionToken;

  const headers = new Map<string, string>([["host", u.host]]);
  for (const [k, v] of Object.entries({ ...input.headers, ...added }))
    headers.set(k.toLowerCase(), v.trim().replace(/\s+/g, " "));
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(";");

  // Every service but S3 encodes each path segment again (as sent, so % becomes %25).
  const path = u.pathname.split("/").map(encode).join("/") || "/";
  const query = u.search
    .slice(1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      const [k, v] = i < 0 ? [pair, ""] : [pair.slice(0, i), pair.slice(i + 1)];
      return [encode(decodeURIComponent(k)), encode(decodeURIComponent(v))] as const;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonical = [
    input.method.toUpperCase(),
    path,
    query,
    names.map((n) => `${n}:${headers.get(n)}\n`).join(""),
    signedHeaders,
    headers.get("x-amz-content-sha256") ?? sha256(input.body ?? ""),
  ].join("\n");
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let key = hmac("AWS4" + input.credentials.secretAccessKey, date);
  for (const part of [input.region, input.service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  added.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return added;
}
