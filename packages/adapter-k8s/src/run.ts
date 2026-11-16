// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { spawn } from "node:child_process";

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string>; input?: string },
) => Promise<string>;

// ToolContext matches @nbo/deploy's ToolContext structurally (this
// package sits below @nbo/deploy, so it cannot import it), plus an
// optional runner so callers can route every command through their own
// boundary (and tests can fake it). Without a context, commands run
// against the ambient kubeconfig/docker config exactly as before.
export interface ToolContext {
  env?: Record<string, string>;
  kubeconfig?: string;
  namespace?: string;
  run?: CommandRunner;
}

export function kubectlArgs(ctx: ToolContext | undefined, args: string[]): string[] {
  const pre: string[] = [];
  if (ctx?.kubeconfig) pre.push("--kubeconfig", ctx.kubeconfig);
  if (ctx?.namespace) pre.push("-n", ctx.namespace);
  return [...pre, ...args];
}

// runWith runs through ctx.run when given, else this package's own run,
// passing ctx.env either way.
export function runWith(ctx: ToolContext | undefined, cmd: string, args: string[], input?: string): Promise<string> {
  const opts: { env?: Record<string, string>; input?: string } = {};
  if (ctx?.env) opts.env = ctx.env;
  if (input !== undefined) opts.input = input;
  const runner: CommandRunner = ctx?.run ?? run;
  return runner(cmd, args, Object.keys(opts).length ? opts : undefined);
}

// This adapter keeps its own childEnv (the shared one lives in
// @nbo/adapter-cloudrun) so it takes no dependency on that package.
// childEnv builds a child's environment from the host's plus overrides.
// A connected call (one that brings its own CLOUDSDK_CONFIG) must not
// inherit the host's gcloud overrides (CLOUDSDK_* properties or
// GOOGLE_APPLICATION_CREDENTIALS), which would beat the connection's own
// credentials or project. Calls without overrides inherit as before.
export function childEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string> | undefined,
): NodeJS.ProcessEnv | undefined {
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

// run shells out to cmd with args, rejecting with the combined stdout+stderr on a non-zero exit.
// Uses spawn (not execFile) because apply's own `kubectl apply -f -` writes the manifest to stdin.
export function run(
  cmd: string,
  args: string[],
  options?: { input?: string; env?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = childEnv(process.env, options?.env);
    const child = spawn(cmd, args, env ? { env } : undefined);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    // A child that exits before reading its stdin (kubectl rejecting
    // a manifest early, say) makes the write below emit EPIPE/EOF on
    // the stdin stream — with no listener, that is an uncaught
    // exception that crashes the whole process, not merely a
    // rejected promise. Reproduced directly: a 4MB input piped to a
    // child that exits immediately kills the Node process outright
    // (exit code 1) without this listener.
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
