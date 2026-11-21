// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { awsContext, type ToolContext } from "../run.js";
import {
  checkEnvSize,
  deleteFunction,
  deployFunction,
  functionConfigHash,
  lambdaName,
  liveFunctionState,
  type LambdaFunctionSpec,
} from "../function.js";

const creds = {
  accessKeyId: "AKIAABCDEFGHIJKLMNOP",
  secretAccessKey: "s3cr3t/KEY+value0123456789abcdef",
  region: "eu-west-1",
};
const ARN = (n: string) => `arn:aws:lambda:eu-west-1:123456789012:function:${n}`;

type Call = { cmd: string; args: string[]; env?: Record<string, string>; file?: string };

// fakeAws answers each aws call from handler (by its first two words, e.g. "lambda get-function");
// unhandled calls answer "{}". An env file named in the args is read while the call runs.
function fakeAws(handler: (op: string, args: string[]) => string | Error | undefined = () => undefined) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const ctx: ToolContext = {
    ...awsContext(creds, async (cmd, args, opts) => {
      const call: Call = { cmd, args, env: opts?.env };
      const f = args.find((a) => a.startsWith("file://"));
      if (f) call.file = readFileSync(f.slice("file://".length), "utf8");
      calls.push(call);
      const r = handler(`${args[0]} ${args[1]}`, args);
      if (r instanceof Error) throw r;
      return r ?? "{}";
    }),
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { calls, sleeps, ctx, ops: () => calls.map((c) => `${c.args[0]} ${c.args[1]}`) };
}

const notFound = new Error("An error occurred (ResourceNotFoundException) when calling the GetFunction operation");
const roleExists = new Error(
  "An error occurred (EntityAlreadyExists) when calling the CreateRole operation: Role with name x already exists.",
);
const BOUNDARY = "arn:aws:iam::123456789012:policy/nbo-boundary";

function spec(over: Partial<LambdaFunctionSpec> = {}): LambdaFunctionSpec {
  return {
    name: "nbo-pabc-lambda",
    image: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/nbo:nbo-app-pabc-lambda-1",
    accountId: "123456789012",
    contentID: "sha256:" + "a".repeat(64),
    env: { PLAIN: "visible-value", TOKEN: "very-secret-value" },
    envFingerprint: "f".repeat(32),
    public: true,
    invokes: ["nbo-pabc-lambda-fn-ssr"],
    ...over,
  };
}

const writes = (ops: string[]) =>
  ops.filter((o) => !/ get-|wait |ecr get-login-password/.test(o) && !o.startsWith("lambda wait"));

describe("lambdaName", () => {
  it("is nbo-<app> or nbo-<app>-fn-<name>, hash-shortened past 64 characters", () => {
    expect(lambdaName("pabc-lambda")).toBe("nbo-pabc-lambda");
    expect(lambdaName("pabc-lambda", "ssr")).toBe("nbo-pabc-lambda-fn-ssr");
    const long = lambdaName("pabc-s-staging-lm", "a-very-long-function-name-that-goes-on-and-on-and-on");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^nbo-pabc-s-staging-lm-fn-a-very.*-[0-9a-f]{8}$/);
    expect(lambdaName("pabc-s-staging-lm", "a-very-long-function-name-that-goes-on-and-on-and-ox")).not.toBe(long);
  });

  // The IAM policy scopes Lambda to function:nbo-*, and teardown finds functions by "nbo-<app>-fn-".
  it("keeps the whole nbo-<app>-fn- prefix for the longest app name (50 characters)", () => {
    const app = "p" + "1".repeat(8) + "-" + "e".repeat(40);
    for (const fn of ["ssr", "x".repeat(60)]) {
      const name = lambdaName(app, fn);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.startsWith(`nbo-${app}-fn-`)).toBe(true);
    }
    expect(lambdaName(app, "x".repeat(60))).not.toBe(lambdaName(app, "x".repeat(59) + "y"));
  });
});

describe("checkEnvSize", () => {
  it("measures the JSON of the variables, as Lambda does: 4 KB passes, one byte more is refused", () => {
    // {"A":"x…"} is 8 bytes plus the value.
    expect(() => checkEnvSize({ A: "x".repeat(4088) })).not.toThrow();
    expect(() => checkEnvSize({ A: "x".repeat(4089) })).toThrow(/4 KB/);
    // 40 variables of 3,900 bytes by names and values alone are about 4,141 bytes of JSON.
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`V${String(i).padStart(2, "0")}`, "x".repeat(94)]),
    );
    expect(() => checkEnvSize(many)).toThrow(/4 KB/);
    // Escaping counts: a quote is two bytes.
    expect(() => checkEnvSize({ A: '"'.repeat(2045) })).toThrow(/4 KB/);
  });

  it("names Lambda's limit and the largest variables, never their values", () => {
    const env = { BIG: "v".repeat(3100), MEDIUM: "w".repeat(1000), SMALL: "x", TINY: "" };
    expect(() => checkEnvSize(env)).toThrow(/Lambda.*4 KB/);
    try {
      checkEnvSize(env);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/BIG \(3109 bytes\), MEDIUM \(1012 bytes\), SMALL/);
      expect(msg).not.toContain("vvvv");
    }
  });
});

describe("deployFunction", () => {
  it("creates the role, the function, its public streaming URL and permissions, then tags it", async () => {
    let assumeFailures = 2;
    let envFile = "";
    const f = fakeAws((op, args) => {
      if (op === "lambda get-function" || op === "lambda get-function-url-config") return notFound;
      if (op === "iam create-role") return '{"Role":{"Arn":"arn:aws:iam::123456789012:role/nbo/nbo-pabc-lambda"}}';
      if (op === "lambda create-function") {
        envFile = args.find((a) => a.startsWith("file://"))!.slice(7);
        if (assumeFailures-- > 0)
          return new Error(
            "An error occurred (InvalidParameterValueException) when calling the CreateFunction operation: The role defined for the function cannot be assumed by Lambda.",
          );
      }
      if (op === "lambda create-function-url-config")
        return '{"FunctionUrl":"https://abc.lambda-url.eu-west-1.on.aws/"}';
    });
    const r = await deployFunction(spec(), f.ctx);
    expect(r).toEqual({ url: "https://abc.lambda-url.eu-west-1.on.aws/", skipped: false });
    expect(f.sleeps).toEqual([2000, 4000]);
    expect(f.ops()).toEqual([
      "lambda get-function",
      "iam create-role",
      "iam attach-role-policy",
      "iam put-role-policy",
      "lambda create-function",
      "lambda create-function",
      "lambda create-function",
      "lambda wait",
      "lambda create-function-url-config",
      "lambda add-permission",
      "lambda add-permission",
      "lambda tag-resource",
    ]);
    const c = (op: string) => f.calls.find((x) => `${x.args[0]} ${x.args[1]}` === op)!;
    const role = c("iam create-role").args;
    expect(role).toEqual(
      expect.arrayContaining(["--role-name", "nbo-pabc-lambda", "--path", "/nbo/", "--permissions-boundary", BOUNDARY]),
    );
    expect(role.join(" ")).toContain("lambda.amazonaws.com");
    expect(c("iam attach-role-policy").args).toContain(
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    );
    const policy = c("iam put-role-policy").args.join(" ");
    expect(policy).toContain("lambda:InvokeFunctionUrl");
    expect(policy).toContain(ARN("nbo-pabc-lambda-fn-ssr"));
    const create = c("lambda create-function").args;
    expect(create).toEqual(
      expect.arrayContaining([
        "--function-name",
        "nbo-pabc-lambda",
        "--package-type",
        "Image",
        "--role",
        "arn:aws:iam::123456789012:role/nbo/nbo-pabc-lambda",
        "--architectures",
        "x86_64",
      ]),
    );
    expect(c("lambda create-function").file).toBe(
      JSON.stringify({ Variables: { PLAIN: "visible-value", TOKEN: "very-secret-value" } }),
    );
    expect(existsSync(envFile)).toBe(false);
    expect(f.calls.find((x) => x.args[1] === "wait")!.args.slice(0, 3)).toEqual([
      "lambda",
      "wait",
      "function-active-v2",
    ]);
    const url = c("lambda create-function-url-config").args;
    expect(url).toEqual(expect.arrayContaining(["--auth-type", "NONE", "--invoke-mode", "RESPONSE_STREAM"]));
    const perms = f.calls.filter((x) => x.args[1] === "add-permission").map((x) => x.args.join(" "));
    expect(perms[0]).toMatch(/--action lambda:InvokeFunctionUrl --principal \* --function-url-auth-type NONE/);
    expect(perms[1]).toMatch(/--action lambda:InvokeFunction --principal \* .*--invoked-via-function-url/);
    const tags = JSON.parse(c("lambda tag-resource").args[c("lambda tag-resource").args.indexOf("--tags") + 1]!);
    expect(tags).toEqual({
      "nbo-content-id": spec().contentID,
      "nbo-fn-config": functionConfigHash(spec()),
      "nbo-env": "f".repeat(32),
    });
    expect(c("lambda tag-resource").args).toContain(ARN("nbo-pabc-lambda"));
    // Review Focus 1: neither the key pair nor a variable's value is ever an argument.
    for (const call of f.calls) {
      const line = call.args.join(" ");
      for (const s of [creds.accessKeyId, creds.secretAccessKey, "very-secret-value", "visible-value"])
        expect(line).not.toContain(s);
      expect(call.env?.AWS_SECRET_ACCESS_KEY).toBe(creds.secretAccessKey);
    }
  });

  it("gives a project function an AWS_IAM URL, no public permission and no invoke policy", async () => {
    const f = fakeAws((op) => {
      if (op === "lambda get-function" || op === "lambda get-function-url-config") return notFound;
      if (op === "lambda create-function-url-config")
        return '{"FunctionUrl":"https://fn.lambda-url.eu-west-1.on.aws/"}';
      if (op === "iam delete-role-policy") return new Error("An error occurred (NoSuchEntity) when calling");
    });
    await deployFunction(spec({ name: "nbo-pabc-lambda-fn-ssr", public: false, invokes: undefined }), f.ctx);
    expect(f.ops()).not.toContain("lambda add-permission");
    expect(f.ops()).not.toContain("iam put-role-policy");
    expect(f.calls.find((c) => c.args[1] === "create-function-url-config")!.args).toEqual(
      expect.arrayContaining(["--auth-type", "AWS_IAM"]),
    );
  });

  it("updates an existing function's code, then its configuration, waiting for each", async () => {
    const f = fakeAws((op) => {
      if (op === "iam create-role") return roleExists;
      if (op === "lambda get-function")
        return JSON.stringify({
          Configuration: { State: "Active", LastUpdateStatus: "Successful" },
          Code: { ImageUri: "old" },
          Tags: { "nbo-content-id": "sha256:old", "nbo-fn-config": "old", "nbo-env": "old" },
        });
      if (op === "lambda get-function-url-config") return '{"FunctionUrl":"https://abc.lambda-url.eu-west-1.on.aws/"}';
      if (op === "lambda update-function-url-config")
        return '{"FunctionUrl":"https://abc.lambda-url.eu-west-1.on.aws/"}';
      if (op === "lambda add-permission")
        return new Error(
          "An error occurred (ResourceConflictException): The statement id (x) provided already exists.",
        );
    });
    const r = await deployFunction(spec(), f.ctx);
    expect(r.skipped).toBe(false);
    expect(writes(f.ops())).toEqual([
      "iam create-role",
      "iam put-role-permissions-boundary",
      "iam attach-role-policy",
      "iam put-role-policy",
      "lambda tag-resource",
      "lambda update-function-code",
      "lambda update-function-configuration",
      "lambda update-function-url-config",
      "lambda add-permission",
      "lambda add-permission",
      "lambda tag-resource",
    ]);
    const waits = f.calls.filter((c) => c.args[1] === "wait").map((c) => c.args[2]);
    expect(waits).toEqual(["function-updated-v2", "function-updated-v2"]);
    const boundary = f.calls.find((c) => c.args[1] === "put-role-permissions-boundary")!.args;
    expect(boundary).toEqual(
      expect.arrayContaining(["--role-name", "nbo-pabc-lambda", "--permissions-boundary", BOUNDARY]),
    );
  });

  // Review I1: the old build's tags must not stay on a function that already runs new code.
  it("clears the live tags before replacing code, so a deploy that fails part way is never read as live", async () => {
    const a = spec({ contentID: "sha256:" + "a".repeat(64), image: "repo/nbo:a" });
    const b = spec({ contentID: "sha256:" + "b".repeat(64), image: "repo/nbo:b" });
    let tags: Record<string, string> = {
      "nbo-content-id": a.contentID,
      "nbo-fn-config": functionConfigHash(a),
      "nbo-env": a.envFingerprint!,
    };
    let failConfig = true;
    const f = fakeAws((op, args) => {
      if (op === "iam create-role") return roleExists;
      if (op === "lambda get-function")
        return JSON.stringify({ Configuration: { State: "Active", LastUpdateStatus: "Successful" }, Tags: tags });
      if (op === "lambda get-function-url-config" || op === "lambda update-function-url-config")
        return '{"FunctionUrl":"https://abc.lambda-url.eu-west-1.on.aws/"}';
      if (op === "lambda tag-resource")
        tags = { ...tags, ...(JSON.parse(args[args.indexOf("--tags") + 1]!) as Record<string, string>) };
      if (op === "lambda update-function-configuration" && failConfig)
        return new Error("An error occurred (TooManyRequestsException) when calling UpdateFunctionConfiguration");
      return undefined;
    });
    await expect(deployFunction(b, f.ctx)).rejects.toThrow(/TooManyRequests/);
    expect(f.ops()).toContain("lambda update-function-code");
    expect((await liveFunctionState(a.name, f.ctx))!.contentID).not.toBe(a.contentID);
    failConfig = false;
    const before = f.calls.length;
    expect((await deployFunction(a, f.ctx)).skipped).toBe(false);
    expect(f.ops().slice(before)).toContain("lambda update-function-code");
    expect(tags["nbo-content-id"]).toBe(a.contentID);
  });

  // Review I2: an AWS refusal may quote the values NBO sent; none reaches the error.
  it("redacts every variable value from a refused configuration update, raw and JSON-escaped", async () => {
    const env = {
      PLAIN: "visible-value",
      PEM: '-----BEGIN KEY-----\nabc"def\n-----END KEY-----',
      NBO_CRON_SIGNING_SECRET: "cron-secret-0123456789",
    };
    const echoed = `raw ${env.NBO_CRON_SIGNING_SECRET} ${env.PLAIN} json ${JSON.stringify(env.PEM)}`;
    const f = fakeAws((op) => {
      if (op === "iam create-role") return roleExists;
      if (op === "lambda get-function")
        return JSON.stringify({ Configuration: { State: "Active", LastUpdateStatus: "Successful" }, Tags: {} });
      if (op === "lambda update-function-configuration")
        return new Error(`An error occurred (InvalidParameterValueException): ${echoed}`);
      return undefined;
    });
    const err = (await deployFunction(spec({ env }), f.ctx).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("InvalidParameterValueException");
    for (const v of Object.values(env)) {
      expect(err.message).not.toContain(v);
      expect(err.message).not.toContain(JSON.stringify(v).slice(1, -1));
    }
    expect(err.message).not.toContain("abc");
  });

  // Review I4: IAM can't know a missing role's path, so GetRole on it may be AccessDenied under the /nbo/ policy.
  it("never reads the role first: create-role, and an existing role is fine", async () => {
    const f = fakeAws((op) => {
      if (op === "lambda get-function" || op === "lambda get-function-url-config") return notFound;
      if (op === "iam get-role")
        return new Error("An error occurred (AccessDenied) when calling the GetRole operation: not authorized");
      if (op === "lambda create-function-url-config")
        return '{"FunctionUrl":"https://abc.lambda-url.eu-west-1.on.aws/"}';
      return undefined;
    });
    await deployFunction(spec(), f.ctx);
    expect(f.ops()).not.toContain("iam get-role");
    expect(f.ops()).toContain("iam create-role");
  });

  // Review Focus 2.
  it("makes no AWS write when the live function has this content, config and variables", async () => {
    const s = spec();
    const f = fakeAws((op) => {
      if (op === "lambda get-function")
        return JSON.stringify({
          Configuration: { State: "Active", LastUpdateStatus: "Successful" },
          Code: { ImageUri: s.image },
          Tags: { "nbo-content-id": s.contentID, "nbo-fn-config": functionConfigHash(s), "nbo-env": s.envFingerprint },
        });
      if (op === "lambda get-function-url-config") return '{"FunctionUrl":"https://abc.lambda-url.eu-west-1.on.aws/"}';
    });
    expect(await deployFunction(s, f.ctx)).toEqual({ url: "https://abc.lambda-url.eu-west-1.on.aws/", skipped: true });
    expect(f.ops()).toEqual(["lambda get-function", "lambda get-function-url-config"]);
  });

  it("redeploys when a variable's value changes (config hash) or a deploy didn't finish", async () => {
    const s = spec();
    expect(functionConfigHash({ ...s, env: { ...s.env, TOKEN: "rotated" } })).not.toBe(functionConfigHash(s));
    expect(functionConfigHash({ ...s, memoryMB: 1024 })).not.toBe(functionConfigHash(s));
    expect(functionConfigHash({ ...s, contentID: "sha256:other", envFingerprint: "e" })).toBe(functionConfigHash(s));
    const f = fakeAws((op) => {
      if (op === "lambda get-function")
        return JSON.stringify({
          Configuration: { State: "Active", LastUpdateStatus: "Failed" },
          Tags: { "nbo-content-id": s.contentID, "nbo-fn-config": functionConfigHash(s), "nbo-env": s.envFingerprint },
        });
      if (op === "lambda get-function-url-config") return '{"FunctionUrl":"https://abc.lambda-url.eu-west-1.on.aws/"}';
    });
    expect((await deployFunction(s, f.ctx)).skipped).toBe(false);
  });

  // Review Focus 4.
  it("refuses variables over 4 KB before any AWS call", async () => {
    const f = fakeAws();
    await expect(deployFunction(spec({ env: { HUGE: "x".repeat(5000) } }), f.ctx)).rejects.toThrow(/4 KB/);
    expect(f.calls).toEqual([]);
  });
});

describe("liveFunctionState", () => {
  it("is undefined for a missing function and throws on other failures", async () => {
    expect(await liveFunctionState("x", fakeAws(() => notFound).ctx)).toBeUndefined();
    await expect(liveFunctionState("x", fakeAws(() => new Error("AccessDenied")).ctx)).rejects.toThrow(/AccessDenied/);
  });
});

describe("deleteFunction", () => {
  it("deletes exactly the named function and its role, tolerating what is already gone", async () => {
    const f = fakeAws((op) => {
      if (op === "lambda delete-function") return notFound;
      if (op.startsWith("iam ")) return new Error("An error occurred (NoSuchEntity) when calling");
    });
    await deleteFunction("nbo-pabc-lambda-fn-ssr", f.ctx);
    expect(f.ops()).toEqual([
      "lambda delete-function",
      "iam detach-role-policy",
      "iam delete-role-policy",
      "iam delete-role",
    ]);
    for (const c of f.calls) expect(c.args).toContain("nbo-pabc-lambda-fn-ssr");
  });

  // Review I4: for a role already gone IAM may answer AccessDenied (it can't know the path); cleanup goes on.
  it("treats AccessDenied on a role step as a role already gone", async () => {
    const f = fakeAws((op) =>
      op.startsWith("iam ")
        ? new Error("An error occurred (AccessDenied) when calling the DetachRolePolicy operation")
        : undefined,
    );
    await deleteFunction("nbo-pabc-lambda-fn-ssr", f.ctx);
    expect(f.ops()).toEqual([
      "lambda delete-function",
      "iam detach-role-policy",
      "iam delete-role-policy",
      "iam delete-role",
    ]);
  });

  it("throws other failures", async () => {
    const f = fakeAws(() => new Error("AccessDeniedException"));
    await expect(deleteFunction("x", f.ctx)).rejects.toThrow(/AccessDenied/);
  });
});
