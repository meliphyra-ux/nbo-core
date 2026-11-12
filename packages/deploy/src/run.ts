// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import spawn from "cross-spawn";

// cross-spawn, not node:child_process's own spawn directly: confirmed
// directly that plain spawn("pnpm", ...) fails with ENOENT on Windows
// (pnpm's own Windows install is a .cmd shim, and Node's spawn cannot
// invoke a .bat/.cmd file at all without shell: true — a deliberate
// Node security restriction). cross-spawn is a drop-in replacement
// (same signature) used by nearly every major Node CLI tool for
// exactly this — docker/kubectl/kind/go are all real .exe binaries on
// every platform and never hit this, so this swap changes nothing for
// them; prepareCliDeployDir's own pnpm call (kubernetes-target.ts) is
// the first caller in this whole rewrite that needs it.

// run shells out to cmd with args, rejecting with the combined
// stdout+stderr on a non-zero exit — matching Go's own
// `fmt.Errorf("... failed: %w\n%s", err, out)` shape wherever this
// package's Go source calls exec.Command(...).CombinedOutput(). This
// package's own copy of @nbo/adapter-k8s's identical helper — not a
// shared import, per this plan's own Architecture (each is ~15 lines,
// not worth a third package just to avoid two small copies).
//
// Ruling: options also takes an optional `env`, which
// @nbo/adapter-k8s's own copy doesn't need — crossCompileLinuxBinary
// must set GOOS/GOARCH/CGO_ENABLED for one `go build` call only
// (Go's own buildCmd.Env = append(os.Environ(), ...)), not globally
// via process.env, which would leak into unrelated concurrent work.
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
    const env = childEnv(process.env, options?.env);
    const child = spawn(cmd, args, env ? { env } : undefined);
    let output = "";
    // cross-spawn's own types declare stdout/stderr/stdin as nullable
    // (the generic ChildProcess shape), unlike node:child_process's
    // own spawn, which narrows them to non-null when called with no
    // stdio option (as here) — cross-spawn delegates to that same
    // spawn internally under these exact conditions, so the streams
    // are non-null at runtime regardless; the `!`s below reconcile
    // the type gap, not a real nullability risk.
    child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    // A child that exits before reading its stdin makes the write
    // below emit EPIPE/EOF on the stdin stream — with no listener,
    // that is an uncaught exception that crashes the whole process.
    // See @nbo/adapter-k8s's own run.ts for the real repro.
    child.stdin!.on("error", () => {});

    child.once("error", (err) => reject(err));
    child.once("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} failed:\n${output}`));
      }
    });

    if (options?.input !== undefined) {
      child.stdin!.write(options.input);
    }
    child.stdin!.end();
  });
}
