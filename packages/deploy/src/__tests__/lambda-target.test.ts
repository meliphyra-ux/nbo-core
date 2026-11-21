// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsContext } from "@nbo/adapter-lambda";

// Real adapter-lambda argument building against a fake `aws` CLI and fake
// docker; only the local base image builds are stubbed.
vi.mock("@nbo/adapter-k8s", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nbo/adapter-k8s")>()),
  buildImage: vi.fn().mockResolvedValue(undefined),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const k8s = await import("@nbo/adapter-k8s");
const { createLambdaTarget } = await import("../lambda-target.js");
const { deploy } = await import("../deploy.js");
const { writeManifestFixtureWithFunction } = await import("./nbo-fixture.js");

const creds = {
  accessKeyId: "AKIAABCDEFGHIJKLMNOP",
  secretAccessKey: "s3cr3t/KEY+value0123456789abcdef",
  region: "eu-west-1",
};
const account = "123456789012";
const repo = `${account}.dkr.ecr.eu-west-1.amazonaws.com/nbo`;
const ecrPassword = "ecr-password-token";

type Call = {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  input?: string;
  fileEnv?: Record<string, string>;
};

// fakeAws keeps Lambda functions in memory: what get-function reads back
// is what create-function, the URL config and tag-resource wrote.
function fakeAws() {
  const calls: Call[] = [];
  const fns = new Map<string, { tags: Record<string, string>; url: string }>();
  const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
  const run = async (cmd: string, args: string[], opts?: { env?: Record<string, string>; input?: string }) => {
    const call: Call = { cmd, args, env: opts?.env, input: opts?.input };
    calls.push(call);
    if (cmd === "docker") {
      if (args[0] === "push") return `x: digest: sha256:${"a".repeat(64)} size: 1\n`;
      return "";
    }
    const [svc, op] = args;
    if (svc === "ecr" && op === "get-login-password") return `${ecrPassword}\n`;
    if (svc === "iam" && op === "get-role") throw new Error("An error occurred (NoSuchEntity) when calling GetRole");
    if (svc !== "lambda") return "{}";
    const environment = args.includes("--environment") ? arg(args, "--environment") : undefined;
    if (environment) call.fileEnv = JSON.parse(await readFile(environment.slice("file://".length), "utf8")).Variables;
    const name = args.includes("--function-name") ? arg(args, "--function-name") : "";
    switch (op) {
      case "get-function": {
        const fn = fns.get(name);
        if (!fn) throw new Error("An error occurred (ResourceNotFoundException) when calling GetFunction");
        return JSON.stringify({ Configuration: { State: "Active", LastUpdateStatus: "Successful" }, Tags: fn.tags });
      }
      case "get-function-url-config": {
        const fn = fns.get(name);
        if (!fn?.url) throw new Error("An error occurred (ResourceNotFoundException)");
        return JSON.stringify({ FunctionUrl: fn.url });
      }
      case "create-function":
        fns.set(name, { tags: {}, url: "" });
        return "{}";
      case "create-function-url-config":
      case "update-function-url-config": {
        const url = `https://${name}.lambda-url.eu-west-1.on.aws/`;
        fns.get(name)!.url = url;
        return JSON.stringify({ FunctionUrl: url });
      }
      case "tag-resource": {
        const fn = arg(args, "--resource").split(":function:")[1]!;
        fns.get(fn)!.tags = JSON.parse(arg(args, "--tags"));
        return "{}";
      }
      default:
        return "{}";
    }
  };
  return { calls, fns, ctx: awsContext(creds, run) };
}

const writes = (calls: Call[]) =>
  calls.filter(
    (c) => c.cmd === "docker" || (c.cmd === "aws" && !/^(get-|wait$)/.test(c.args[1]!) && c.args[0] !== "ecr"),
  );

function lambdaTarget(ctx: ReturnType<typeof fakeAws>["ctx"], userValue = "value-1") {
  const target = createLambdaTarget({ ctx, accountId: account, repository: repo });
  target.extraEnv = { NBO_CRON_SIGNING_SECRET: "cron-secret" };
  target.userEnv = { vars: { API_KEY: userValue }, secretNames: ["API_KEY"], fingerprint: "fp-1" };
  return target;
}

let dir: string;
beforeEach(async () => {
  vi.mocked(k8s.buildImage).mockClear();
  vi.mocked(k8s.buildFunctionImage).mockClear();
  dir = await mkdtemp(join(tmpdir(), "lambda-target-"));
  await writeManifestFixtureWithFunction(dir, "ssr");
  return () => rm(dir, { recursive: true, force: true });
});

describe("createLambdaTarget", () => {
  it("deploys the function, then the app with its function URL, variables and tags", async () => {
    const { calls, fns, ctx } = fakeAws();
    const result = await deploy(lambdaTarget(ctx).deployer, dir, "pabc-lambda");

    const appURL = "https://nbo-pabc-lambda.lambda-url.eu-west-1.on.aws/";
    const fnURL = "https://nbo-pabc-lambda-fn-ssr.lambda-url.eu-west-1.on.aws/";
    expect(result).toMatchObject({ alreadyLive: false, url: appURL });

    // The function first, its URL private; then the app, public.
    const creates = calls.filter((c) => c.args[1] === "create-function");
    expect(creates.map((c) => c.args[c.args.indexOf("--function-name") + 1])).toEqual([
      "nbo-pabc-lambda-fn-ssr",
      "nbo-pabc-lambda",
    ]);
    const urlAuth = (name: string) => {
      const c = calls.find((c) => c.args[1] === "create-function-url-config" && c.args.includes(name))!;
      return c.args[c.args.indexOf("--auth-type") + 1];
    };
    expect(urlAuth("nbo-pabc-lambda-fn-ssr")).toBe("AWS_IAM");
    expect(urlAuth("nbo-pabc-lambda")).toBe("NONE");

    // /functions.json gets the function URL, /env.json nothing: values are Lambda environment.
    expect(vi.mocked(k8s.buildImage).mock.calls[0]![3]).toEqual({ ssr: fnURL });
    expect(vi.mocked(k8s.buildImage).mock.calls[0]![4]).toEqual({});
    for (const c of creates) expect(c.fileEnv).toEqual({ API_KEY: "value-1", NBO_CRON_SIGNING_SECRET: "cron-secret" });

    // Images: the Web Adapter layer on each, pushed to the one ECR repository by tag.
    const pushes = calls.filter((c) => c.cmd === "docker" && c.args[0] === "push").map((c) => c.args[1]!);
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatch(new RegExp(`^${repo}:nbo-pabc-lambda-fn-ssr_[0-9a-f]{24}-l[0-9a-f]{8}$`));
    expect(pushes[1]).toMatch(new RegExp(`^${repo}:nbo-pabc-lambda_[0-9a-f]{12}-b[0-9a-f]{8}-l[0-9a-f]{8}$`));
    const layers = calls.filter((c) => c.cmd === "docker" && c.args[0] === "build");
    expect(layers.map((c) => c.input!.split("\n")[0])).toEqual([
      expect.stringMatching(/^FROM nbo-fn-pabc-lambda-ssr:/),
      expect.stringMatching(/^FROM nbo-app-pabc-lambda:/),
    ]);
    for (const c of calls.filter((c) => c.cmd === "docker" && c.args[0] !== "build"))
      expect(c.env?.DOCKER_CONFIG).toBeTruthy();

    // The app's role may call its function; tags carry the content id and fingerprint.
    const invoke = calls.find((c) => c.args[1] === "put-role-policy")!;
    expect(invoke.args).toContain("nbo-pabc-lambda");
    expect(invoke.args.join(" ")).toContain(`arn:aws:lambda:eu-west-1:${account}:function:nbo-pabc-lambda-fn-ssr`);
    expect(fns.get("nbo-pabc-lambda")!.tags).toMatchObject({ "nbo-content-id": result.contentID, "nbo-env": "fp-1" });

    // The key pair only ever travels in the environment.
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain(creds.secretAccessKey);
      if (c.cmd === "aws") expect(c.env?.AWS_SECRET_ACCESS_KEY).toBe(creds.secretAccessKey);
      if (c.cmd === "docker") expect(c.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    }
  }, 30000);

  it("changes nothing on AWS when the same build and variables are live", async () => {
    const { calls, ctx } = fakeAws();
    await deploy(lambdaTarget(ctx).deployer, dir, "pabc-lambda");
    calls.length = 0;

    const target = lambdaTarget(ctx);
    const result = await deploy(target.deployer, dir, "pabc-lambda");
    expect(result).toMatchObject({ alreadyLive: true, url: "https://nbo-pabc-lambda.lambda-url.eu-west-1.on.aws/" });
    expect(writes(calls)).toEqual([]);
    expect(calls.every((c) => c.cmd === "aws" && c.args[1]!.startsWith("get-"))).toBe(true);
  }, 30000);

  it("refuses variables over Lambda's 4 KB before building or pushing anything", async () => {
    const { calls, ctx } = fakeAws();
    await expect(deploy(lambdaTarget(ctx, "x".repeat(5000)).deployer, dir, "pabc-lambda")).rejects.toThrow(
      /Lambda allows 4 KB of environment variables/,
    );
    expect(writes(calls)).toEqual([]);
    expect(vi.mocked(k8s.buildFunctionImage)).not.toHaveBeenCalled();
  }, 30000);
});
