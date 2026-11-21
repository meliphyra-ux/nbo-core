// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { awsContext, awsJson, NO_AWS_FILE, type CommandRunner } from "../run.js";

// Made up, and split so secret scanners don't take them for real keys.
const creds = {
  accessKeyId: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
  secretAccessKey: ["s3cr3t/KEY+value", "0123456789abcdefghijklmn"].join(""),
  region: "eu-west-1",
};

describe("aws runner", () => {
  it("passes credentials only through the child env, never the arguments", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const run: CommandRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      return 'warning on stderr\n{"Account":"123456789012"}\n';
    };
    const out = await awsJson<{ Account: string }>(awsContext(creds, run), ["sts", "get-caller-identity"]);
    expect(out.Account).toBe("123456789012");
    expect(calls[0]!.cmd).toBe("aws");
    expect(calls[0]!.args).toEqual(["sts", "get-caller-identity", "--output", "json"]);
    expect(calls[0]!.env).toEqual({
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_REGION: "eu-west-1",
      AWS_PAGER: "",
      AWS_CONFIG_FILE: NO_AWS_FILE,
      AWS_SHARED_CREDENTIALS_FILE: NO_AWS_FILE,
    });
    expect(calls[0]!.args.join(" ")).not.toContain(creds.secretAccessKey);
  });

  // The host's ~/.aws files (a default profile's endpoint_url, ca_bundle, keys) never apply.
  it("points the CLI's config and credentials files at a path that doesn't exist", () => {
    expect(existsSync(NO_AWS_FILE)).toBe(false);
  });

  // Lambda's 4 KB refusal quotes every variable: "String measured: {...}".
  it("cuts AWS's echo of the variables out of a failure", async () => {
    const run: CommandRunner = async () => {
      throw new Error(
        'An error occurred (InvalidParameterValueException): Lambda was unable to configure your environment variables because the environment variables you have provided exceeded the 4KB limit. String measured: {"TOKEN":"very-secret\\n-value","B":"x"}\nmore',
      );
    };
    const err = (await awsJson(awsContext(creds, run), ["lambda", "update-function-configuration"]).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain("exceeded the 4KB limit");
    expect(err.message).not.toContain("very-secret");
    expect(err.message).not.toContain("TOKEN");
    expect(err.message).not.toContain("more");
  });

  it("redacts the key pair from a failure and keeps the error code", async () => {
    const run: CommandRunner = async () => {
      throw Object.assign(new Error(`aws failed: echoed ${creds.secretAccessKey} and ${creds.accessKeyId}`), {
        code: "ENOENT",
      });
    };
    const err = (await awsJson(awsContext(creds, run), ["sts", "get-caller-identity"]).catch(
      (e: unknown) => e,
    )) as Error & { code?: string };
    expect(err.message).not.toContain(creds.secretAccessKey);
    expect(err.message).not.toContain(creds.accessKeyId);
    expect(err.message).toContain("[redacted]");
    expect(err.stack ?? "").not.toContain(creds.secretAccessKey);
    expect(err.code).toBe("ENOENT");
  });

  it("refuses output that holds no JSON", async () => {
    const run: CommandRunner = async () => "nothing here";
    await expect(awsJson(awsContext(creds, run), ["sts", "get-caller-identity"])).rejects.toThrow(/no JSON/);
  });
});
