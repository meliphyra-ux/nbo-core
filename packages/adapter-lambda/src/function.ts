// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aws, awsJson, type ToolContext } from "./run.js";

// One Lambda function (the app, or one NBO function) with its own execution
// role /nbo/<name> and a RESPONSE_STREAM function URL.
export interface LambdaFunctionSpec {
  name: string; // lambdaName(...)
  // The ECR image URI. A tag URI lets a caller run the "already live" check
  // before building or pushing; Lambda resolves it to a digest at deploy.
  image: string;
  accountId: string;
  contentID: string;
  // From function.json; absent (the app): Cloud Run's defaults, 512 MB and 300 s.
  memoryMB?: number;
  maxDurationSec?: number;
  env: Record<string, string>;
  envFingerprint?: string;
  // true: the app (URL auth NONE, open to anyone); false: a project function (AWS_IAM).
  public: boolean;
  // Lambda names this function's role may call by function URL (the app's functions).
  invokes?: string[];
}

export interface LiveFunctionState {
  url: string; // "" when the function has no URL yet
  contentID: string;
  config: string;
  fingerprint: string;
  // State Active and the last update Successful.
  ready: boolean;
}

const DEFAULT_MEMORY_MB = 512;
const DEFAULT_TIMEOUT_SEC = 300;
const BASIC_EXECUTION = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const INVOKE_POLICY = "nbo-invoke";
const ENV_LIMIT = 4096;

// BOUNDARY_POLICY: the managed policy every role NBO makes carries as its
// permissions boundary (the person connecting AWS creates it; awsIamPolicy
// lets NBO make a role only with it).
export const BOUNDARY_POLICY = "nbo-boundary";

const notFound = /ResourceNotFoundException|NoSuchEntity/;
// IAM can't know a missing role's path, so under the /nbo/ policy a call on a
// role that is gone may answer AccessDenied instead of NoSuchEntity.
const roleGone = /NoSuchEntity|AccessDenied/;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// lambdaName: "nbo-<app>" or "nbo-<app>-fn-<function>" (the IAM policy scopes
// Lambda to function:nbo-*), past Lambda's 64 characters the variable part
// is shortened with a hash, keeping the whole prefix (apps are at most 50
// characters, so "nbo-<app>-fn-" fits).
export function lambdaName(app: string, fn?: string): string {
  const name = fn ? `nbo-${app}-fn-${fn}` : `nbo-${app}`;
  if (name.length <= 64) return name;
  const head = fn ? `nbo-${app}-fn-` : "nbo-";
  const room = 64 - head.length;
  if (room < 6) throw new Error(`the app name ${app} is too long for a Lambda name`);
  const hash = createHash("sha256").update(name).digest("hex");
  const keep = (fn ?? app).slice(0, Math.max(0, room - 9)).replace(/-+$/, "");
  return keep ? `${head}${keep}-${hash.slice(0, 8)}` : `${head}${hash.slice(0, room)}`;
}

// checkEnvSize refuses variables over Lambda's 4 KB, naming the largest ones
// but never a value. Lambda measures the JSON of the variables map (its
// refusal quotes it: "String measured: {"NAME":"value",...}").
export function checkEnvSize(env: Record<string, string>): void {
  const json = (s: string) => Buffer.byteLength(JSON.stringify(s));
  // Each variable's share: "name":"value" plus its comma.
  const sizes = Object.entries(env).map(([k, v]) => [k, json(k) + json(v) + 2] as const);
  const total = Buffer.byteLength(JSON.stringify(env));
  if (total <= ENV_LIMIT) return;
  const largest = [...sizes]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, s]) => `${k} (${s} bytes)`)
    .join(", ");
  throw new Error(
    `Lambda allows 4 KB of environment variables in all (names and values, measured as JSON); this deploy needs ${total} bytes. The largest: ${largest}.`,
  );
}

// functionConfigHash fingerprints everything a deploy sets besides the
// content id and variables fingerprint (tagged on their own): image, memory,
// timeout, URL auth, the invoke grant and every variable's value. 32 hex
// characters, the nbo-fn-config tag.
export function functionConfigHash(spec: LambdaFunctionSpec): string {
  const env = Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash("sha256")
    .update(
      JSON.stringify({
        image: spec.image,
        memoryMB: spec.memoryMB ?? DEFAULT_MEMORY_MB,
        timeout: spec.maxDurationSec ?? DEFAULT_TIMEOUT_SEC,
        public: spec.public,
        invokes: [...(spec.invokes ?? [])].sort(),
        env,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

// liveFunctionState reads a function's tags, state and URL; undefined when
// the function doesn't exist. Other failures are thrown: create versus
// update must not be guessed.
export async function liveFunctionState(name: string, ctx: ToolContext): Promise<LiveFunctionState | undefined> {
  let fn: { Configuration?: { State?: string; LastUpdateStatus?: string }; Tags?: Record<string, string> };
  try {
    fn = await awsJson(ctx, ["lambda", "get-function", "--function-name", name]);
  } catch (err) {
    if (notFound.test(message(err))) return undefined;
    throw err;
  }
  let url = "";
  try {
    url =
      (await awsJson<{ FunctionUrl?: string }>(ctx, ["lambda", "get-function-url-config", "--function-name", name]))
        .FunctionUrl ?? "";
  } catch (err) {
    if (!notFound.test(message(err))) throw err;
  }
  const tags = fn.Tags ?? {};
  return {
    url,
    contentID: tags["nbo-content-id"] ?? "",
    config: tags["nbo-fn-config"] ?? "",
    fingerprint: tags["nbo-env"] ?? "",
    ready: fn.Configuration?.State === "Active" && fn.Configuration.LastUpdateStatus === "Successful",
  };
}

// isLive: the live function is ready, has its URL and is tagged with this
// spec's content id, config hash and variables fingerprint (nothing to do).
export function isLive(live: LiveFunctionState | undefined, spec: LambdaFunctionSpec): boolean {
  return (
    !!live?.ready &&
    !!live.url &&
    live.contentID === spec.contentID &&
    live.config === functionConfigHash(spec) &&
    live.fingerprint === (spec.envFingerprint ?? "")
  );
}

const sleepFor = (ctx: ToolContext) => ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

// A just-created role takes a few seconds before Lambda can assume it.
async function retryRoleNotAssumable<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  const delays = [2000, 4000, 8000, 16000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= delays.length || !/cannot be assumed/i.test(message(err))) throw err;
      await sleepFor(ctx)(delays[i]!);
    }
  }
}

async function ignoring(pattern: RegExp, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!pattern.test(message(err))) throw err;
  }
}

const functionArn = (ctx: ToolContext, accountId: string, name: string) =>
  `arn:aws:lambda:${ctx.env.AWS_REGION}:${accountId}:function:${name}`;

// ensureRole makes the function's execution role /nbo/<name> (logs only,
// within the nbo-boundary permissions boundary), and for the app an inline
// policy to call its own functions' URLs. It creates first and never reads:
// IAM can't know a missing role's path, so GetRole on it may be refused.
async function ensureRole(spec: LambdaFunctionSpec, ctx: ToolContext): Promise<string> {
  const role = spec.name;
  const boundary = `arn:aws:iam::${spec.accountId}:policy/${BOUNDARY_POLICY}`;
  const trust = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
  };
  try {
    await aws(ctx, [
      "iam",
      "create-role",
      "--role-name",
      role,
      "--path",
      "/nbo/",
      "--assume-role-policy-document",
      JSON.stringify(trust),
      "--permissions-boundary",
      boundary,
    ]);
  } catch (err) {
    if (!/EntityAlreadyExists/.test(message(err))) throw err;
    // An existing role gets the boundary too (idempotent).
    await aws(ctx, ["iam", "put-role-permissions-boundary", "--role-name", role, "--permissions-boundary", boundary]);
  }
  await aws(ctx, ["iam", "attach-role-policy", "--role-name", role, "--policy-arn", BASIC_EXECUTION]);
  const invokes = spec.invokes ?? [];
  if (invokes.length > 0) {
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          // Function URLs made since October 2025 also need InvokeFunction.
          Action: ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"],
          Resource: invokes.map((n) => functionArn(ctx, spec.accountId, n)),
        },
      ],
    };
    await aws(ctx, [
      "iam",
      "put-role-policy",
      "--role-name",
      role,
      "--policy-name",
      INVOKE_POLICY,
      "--policy-document",
      JSON.stringify(policy),
    ]);
  } else {
    await ignoring(notFound, () =>
      aws(ctx, ["iam", "delete-role-policy", "--role-name", role, "--policy-name", INVOKE_POLICY]),
    );
  }
  return `arn:aws:iam::${spec.accountId}:role/nbo/${role}`;
}

// deployFunction creates or updates the function, its role and its URL and
// returns the URL. When the live function is ready and tagged with this
// content id, config hash and variables fingerprint, nothing is written.
// Tags are written last, so an unfinished deploy never reads as live.
export async function deployFunction(
  spec: LambdaFunctionSpec,
  ctx: ToolContext,
): Promise<{ url: string; skipped: boolean }> {
  checkEnvSize(spec.env);
  const config = functionConfigHash(spec);
  const live = await liveFunctionState(spec.name, ctx);
  if (isLive(live, spec)) return { url: live!.url, skipped: true };

  const roleArn = await ensureRole(spec, ctx);
  const name = ["--function-name", spec.name];
  const settings = [
    "--memory-size",
    String(spec.memoryMB ?? DEFAULT_MEMORY_MB),
    "--timeout",
    String(spec.maxDurationSec ?? DEFAULT_TIMEOUT_SEC),
  ];
  // Values go through a file in a private temp directory, never arguments.
  const dir = await mkdtemp(join(tmpdir(), "nbo-lambda-env-"));
  try {
    await chmod(dir, 0o700);
    const file = join(dir, "env.json");
    await writeFile(file, JSON.stringify({ Variables: spec.env }), { encoding: "utf8", mode: 0o600 });
    const environment = ["--environment", `file://${file}`];
    await redactingValues(spec.env, async () => {
      if (!live) {
        await retryRoleNotAssumable(ctx, () =>
          aws(ctx, [
            "lambda",
            "create-function",
            ...name,
            "--package-type",
            "Image",
            "--code",
            `ImageUri=${spec.image}`,
            "--role",
            roleArn,
            "--architectures",
            "x86_64",
            ...settings,
            ...environment,
          ]),
        );
        await aws(ctx, ["lambda", "wait", "function-active-v2", ...name]);
      } else {
        // The old build's tags would otherwise stay on new code if a later step fails.
        await tagFunction(ctx, spec, { "nbo-content-id": "pending", "nbo-fn-config": "pending" });
        await aws(ctx, ["lambda", "update-function-code", ...name, "--image-uri", spec.image]);
        await aws(ctx, ["lambda", "wait", "function-updated-v2", ...name]);
        await aws(ctx, [
          "lambda",
          "update-function-configuration",
          ...name,
          "--role",
          roleArn,
          ...settings,
          ...environment,
        ]);
        await aws(ctx, ["lambda", "wait", "function-updated-v2", ...name]);
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const urlArgs = [...name, "--auth-type", spec.public ? "NONE" : "AWS_IAM", "--invoke-mode", "RESPONSE_STREAM"];
  const url = (
    await awsJson<{ FunctionUrl: string }>(ctx, [
      "lambda",
      live?.url ? "update-function-url-config" : "create-function-url-config",
      ...urlArgs,
    ])
  ).FunctionUrl;
  // shortcut: a function never turns from public to private (the app and its functions have distinct names),
  // so the public grants are only ever added.
  if (spec.public) {
    const exists = /already exists/;
    await ignoring(exists, () =>
      aws(ctx, [
        "lambda",
        "add-permission",
        ...name,
        "--statement-id",
        "nbo-public-url",
        "--action",
        "lambda:InvokeFunctionUrl",
        "--principal",
        "*",
        "--function-url-auth-type",
        "NONE",
      ]),
    );
    await ignoring(exists, () =>
      aws(ctx, [
        "lambda",
        "add-permission",
        ...name,
        "--statement-id",
        "nbo-public-invoke",
        "--action",
        "lambda:InvokeFunction",
        "--principal",
        "*",
        "--invoked-via-function-url",
      ]),
    );
  }
  await tagFunction(ctx, spec, {
    "nbo-content-id": spec.contentID,
    "nbo-fn-config": config,
    "nbo-env": spec.envFingerprint ?? "",
  });
  return { url, skipped: false };
}

const tagFunction = (ctx: ToolContext, spec: LambdaFunctionSpec, tags: Record<string, string>) =>
  aws(ctx, [
    "lambda",
    "tag-resource",
    "--resource",
    functionArn(ctx, spec.accountId, spec.name),
    "--tags",
    JSON.stringify(tags),
  ]);

// redactingValues: an AWS refusal may quote the variables it was sent; every
// value of 6 or more characters, raw and JSON-escaped, becomes [redacted].
async function redactingValues(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const forms = Object.values(env)
      .filter((v) => v.length >= 6)
      .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])
      .sort((a, b) => b.length - a.length);
    let text = message(err);
    for (const f of forms) text = text.split(f).join("[redacted]");
    const out = new Error(text);
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== undefined) Object.assign(out, { code });
    // No cause: the original error carries the values.
    throw out;
  }
}

// deleteFunction deletes the named function (its URL goes with it) and its
// role; what is already gone is fine.
export async function deleteFunction(name: string, ctx: ToolContext): Promise<void> {
  await ignoring(notFound, () => aws(ctx, ["lambda", "delete-function", "--function-name", name]));
  // shortcut: AccessDenied reads as gone (a role left behind is boundary-limited and harmless); list roles
  // under /nbo/ at teardown if orphans turn up.
  await ignoring(roleGone, () =>
    aws(ctx, ["iam", "detach-role-policy", "--role-name", name, "--policy-arn", BASIC_EXECUTION]),
  );
  await ignoring(roleGone, () =>
    aws(ctx, ["iam", "delete-role-policy", "--role-name", name, "--policy-name", INVOKE_POLICY]),
  );
  await ignoring(roleGone, () => aws(ctx, ["iam", "delete-role", "--role-name", name]));
}
