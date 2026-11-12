// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { spawn } from "node:child_process";

export type CommandRunner = (cmd: string, args: string[], opts?: { env?: Record<string, string>; input?: string }) => Promise<string>;

// ToolContext matches @nbo/deploy's ToolContext structurally (this
// package sits below @nbo/deploy), plus an optional runner and sleep so
// callers can route every command through their own boundary and tests
// can fake both. Without a context, commands run against the ambient
// gcloud/docker exactly as before.
export interface ToolContext {
  env?: Record<string, string>;
  run?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
}

// input, when given, is written to the command's stdin (secret values
// travel this way, never as arguments).
export function runWith(ctx: ToolContext | undefined, cmd: string, args: string[], input?: string): Promise<string> {
  const runner: CommandRunner = ctx?.run ?? run;
  if (input !== undefined) return runner(cmd, args, ctx?.env ? { env: ctx.env, input } : { input });
  return ctx?.env ? runner(cmd, args, { env: ctx.env }) : runner(cmd, args);
}

const propagationDelays = [2000, 4000, 8000, 16000];
const notYetPropagated = /service account[^\n]*does not exist|does not exist[^\n]*service account|or it may not exist|iam\.serviceaccounts\.actAs/i;

// retryWhile retries fn, with 2/4/8/16s backoff, while its error
// matches retryable.
export async function retryWhile<T>(ctx: ToolContext | undefined, fn: () => Promise<T>, retryable: RegExp): Promise<T> {
  const sleep = ctx?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (i >= propagationDelays.length || !retryable.test(text)) throw err;
      await sleep(propagationDelays[i]!);
    }
  }
}

// retryPropagation retries fn while IAM reports a just-created service
// account as missing (it takes a few seconds to become visible), or,
// with also, while that error matches (another not-yet-visible grant).
export function retryPropagation<T>(ctx: ToolContext | undefined, fn: () => Promise<T>, also?: RegExp): Promise<T> {
  return retryWhile(ctx, fn, also ? new RegExp(`${notYetPropagated.source}|${also.source}`, "i") : notYetPropagated);
}

// Windows requires a .cmd/.bat script (gcloud's own Windows installer
// ships gcloud.cmd) to run through a shell — Node refuses to spawn
// one directly, even via an absolute path (the CVE-2024-27980 fix),
// and without a shell it does not consult PATHEXT the way cmd.exe
// itself does when resolving a bare command name, so a plain
// spawn("gcloud", args) fails with ENOENT even though gcloud is
// genuinely on PATH — a real regression against Go's own
// exec.Command("gcloud", ...), which resolves this correctly via its
// own LookPath. shell:true leaves argument quoting entirely to the
// caller (Node's own deprecation warning: "arguments are not
// escaped, only concatenated"), so every argument is quoted for
// cmd.exe's parser here, and one containing a shell metacharacter is
// rejected outright — safer to fail loudly on an unexpected value
// than to risk a subtle injection for args that should never
// legitimately need one.
const WINDOWS_SHELL_METACHARACTERS = /[&|<>^%]/;

function quoteWindowsArg(arg: string): string {
  if (WINDOWS_SHELL_METACHARACTERS.test(arg)) {
    throw new Error(`refusing to pass an argument containing a shell metacharacter to a Windows shell: ${arg}`);
  }
  // Standard CommandLineToArgvW quoting: double every backslash
  // immediately preceding a quote (or the string's own end, before
  // the closing quote this wrapping adds), then escape the quote.
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

// run shells out to cmd with args, rejecting with the combined
// stdout+stderr on a non-zero exit — matching Go's own
// `fmt.Errorf("... failed: %w\n%s", err, out)` shape wherever this
// adapter's Go source calls exec.Command(...).CombinedOutput(). This
// package's own copy of @nbo/adapter-k8s's identical helper — not a
// shared import, per this plan's own Architecture (each is ~15 lines,
// not worth a third package just to avoid two small copies).
// childEnv builds a child's environment from the host's plus overrides.
// A connected call (one that brings its own CLOUDSDK_CONFIG) must not
// inherit the host's gcloud overrides (CLOUDSDK_* properties or
// GOOGLE_APPLICATION_CREDENTIALS), which would beat the connection's own
// credentials or project. Calls without overrides inherit as before.
export function childEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string> | undefined): NodeJS.ProcessEnv | undefined {
  if (!overrides) return undefined;
  const env: NodeJS.ProcessEnv = { ...base };
  if (overrides.CLOUDSDK_CONFIG !== undefined) {
    for (const k of Object.keys(env)) {
      const upper = k.toUpperCase();
      if (upper.startsWith("CLOUDSDK_") || upper === "GOOGLE_APPLICATION_CREDENTIALS") delete env[k];
    }
  }
  return { ...env, ...overrides };
}

export function run(cmd: string, args: string[], options?: { input?: string; env?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const env = childEnv(process.env, options?.env);
    let child;
    try {
      child = windows ? spawn(cmd, args.map(quoteWindowsArg), { shell: true, env }) : spawn(cmd, args, { env });
    } catch (err) {
      reject(err);
      return;
    }

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    // A child that exits before reading its stdin (an early-rejecting
    // `gcloud` invocation, for instance) makes the write below emit
    // EPIPE/EOF on the stdin stream — with no listener, that is an
    // uncaught exception that crashes the whole process, not merely a
    // rejected promise.
    child.stdin.on("error", () => {});

    child.once("error", (err) => reject(err));
    child.once("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} failed:\n${output}`));
      }
    });

    if (options?.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}
