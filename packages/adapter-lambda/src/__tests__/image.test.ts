// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { awsContext } from "../run.js";
import { buildLambdaImage, lambdaDockerfile, pushImage } from "../image.js";

const creds = {
  accessKeyId: "AKIAABCDEFGHIJKLMNOP",
  secretAccessKey: "s3cr3t/KEY+value0123456789abcdef",
  region: "eu-west-1",
};
const repo = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/nbo";
const password = "eyJwYXlsb2FkIjoiZWNyLXRva2VuIn0=";
const digest = "sha256:" + "b".repeat(64);

type Call = { cmd: string; args: string[]; env?: Record<string, string>; input?: string };

function fake(loginFails = false) {
  const calls: Call[] = [];
  const ctx = awsContext(creds, async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, input: opts?.input });
    if (cmd === "aws") return `${password}\n`;
    if (args[0] === "login" && loginFails) throw new Error(`docker login failed: bad password ${password}`);
    if (args[0] === "push") return `The push refers to repository [${repo}]\napp-1: digest: ${digest} size: 1234\n`;
    return "";
  });
  return { calls, ctx };
}

describe("pushImage", () => {
  it("logs docker in with the ECR password on stdin, tags, pushes and returns the digest URI", async () => {
    const { calls, ctx } = fake();
    const uri = await pushImage(ctx, "nbo-app-x:1", `${repo}:app-1`, { DOCKER_CONFIG: "/tmp/d" });
    expect(uri).toBe(`${repo}@${digest}`);
    expect(calls.map((c) => [c.cmd, c.args[0]])).toEqual([
      ["aws", "ecr"],
      ["docker", "login"],
      ["docker", "tag"],
      ["docker", "push"],
    ]);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["ecr", "get-login-password"]);
    expect(calls[1]!.args).toEqual([
      "login",
      "--username",
      "AWS",
      "--password-stdin",
      "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
    ]);
    expect(calls[1]!.input).toBe(password);
    // docker gets only its own config, never the key pair.
    for (const c of calls.slice(1)) expect(c.env).toEqual({ DOCKER_CONFIG: "/tmp/d" });
    for (const c of calls) expect(c.args.join(" ")).not.toContain(password);
  });

  it("never shows the password when docker login fails", async () => {
    const { ctx } = fake(true);
    const err = await pushImage(ctx, "a:1", `${repo}:a-1`, { DOCKER_CONFIG: "/tmp/d" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/docker login failed/);
    expect((err as Error).message).not.toContain(password);
  });
});

describe("buildLambdaImage", () => {
  it("adds the pinned Web Adapter and its settings on top of the unchanged image, no context, no credentials", async () => {
    const { calls, ctx } = fake();
    await buildLambdaImage(ctx, "nbo-app-a:1", "nbo-app-a:1-lambda");
    expect(calls).toEqual([
      { cmd: "docker", args: ["build", "-t", "nbo-app-a:1-lambda", "-"], input: lambdaDockerfile("nbo-app-a:1") },
    ]);
    const dockerfile = calls[0]!.input!;
    expect(dockerfile.split("\n")[0]).toBe("FROM nbo-app-a:1");
    expect(dockerfile).toMatch(
      /COPY --from=public\.ecr\.aws\/awsguru\/aws-lambda-adapter:[\w.-]+@sha256:[0-9a-f]{64} \/lambda-adapter \/opt\/extensions\/lambda-adapter/,
    );
    expect(dockerfile).toContain("AWS_LWA_PORT=8080");
    expect(dockerfile).toContain("AWS_LWA_INVOKE_MODE=response_stream");
  });
});
