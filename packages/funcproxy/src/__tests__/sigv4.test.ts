// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { signRequest } from "../sigv4.js";

// Cases from AWS's SigV4 test suite (awslabs/aws-c-auth,
// tests/aws-signing-test-suite/v4), with its credentials and time.
const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const base = { region: "us-east-1", service: "service", credentials, now: new Date("2015-08-30T12:36:00Z") };
const scope = "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request";
const token =
  "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==";

describe("signRequest (AWS SigV4 test suite)", () => {
  it("get-vanilla", () => {
    const h = signRequest({ ...base, method: "GET", url: "https://example.amazonaws.com/", headers: {} });
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 ${scope}, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`,
    );
  });

  it("post-vanilla", () => {
    const h = signRequest({ ...base, method: "POST", url: "https://example.amazonaws.com/", headers: {} });
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 ${scope}, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b`,
    );
  });

  it("get-vanilla-query-order-key-case", () => {
    const h = signRequest({
      ...base,
      method: "GET",
      url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      headers: {},
    });
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 ${scope}, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500`,
    );
  });

  it("post-x-www-form-urlencoded (a signed x-amz-content-sha256)", () => {
    const h = signRequest({
      ...base,
      method: "POST",
      url: "https://example.amazonaws.com/",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "13",
        "x-amz-content-sha256": "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
      },
      body: "Param1=value1",
    });
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 ${scope}, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b`,
    );
  });

  it("post-sts-header-before (a session token, signed)", () => {
    const h = signRequest({
      ...base,
      credentials: { ...credentials, sessionToken: token },
      method: "POST",
      url: "https://example.amazonaws.com/",
      headers: {},
    });
    expect(h["x-amz-security-token"]).toBe(token);
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 ${scope}, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead`,
    );
  });

  it("signs a session token and x-amz-content-sha256 together, and hashes the body when no hash is given", () => {
    const sign = (body: string, headers: Record<string, string> = {}) =>
      signRequest({
        ...base,
        credentials: { ...credentials, sessionToken: token },
        method: "POST",
        url: "https://example.amazonaws.com/",
        headers,
        body,
      }).authorization;
    const sha = "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e"; // sha256("Param1=value1")
    expect(sign("Param1=value1", { "x-amz-content-sha256": sha })).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,",
    );
    expect(sign("a")).not.toBe(sign("b"));
  });
});
