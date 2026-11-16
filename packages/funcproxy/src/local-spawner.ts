// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { proxyRequestOrFail, hostScriptPath, type Resolver } from "./proxy.js";

const listeningRe = /^NBO_FUNCTION_LISTENING (\d+)$/;

async function writeNodeHostScript(): Promise<string> {
  const scriptDir = await mkdtemp(join(tmpdir(), "nbo-funcproxy-host-"));
  const scriptPath = join(scriptDir, "host.mjs");
  await writeFile(scriptPath, await readFile(hostScriptPath(), "utf8"));
  return scriptPath;
}

function spawnFunctionHost(
  scriptPath: string,
  nboDir: string,
  name: string,
): Promise<{ child: ChildProcess; port: number }> {
  // host.mjs joins its own working directory against ".." to find
  // function.json, so bundleDir must be absolute — a relative nboDir
  // (exactly what `nbo serve app/.nbo` passes) would otherwise double
  // up against the spawned process's own cwd-relative resolution.
  const bundleDir = resolvePath(nboDir, "functions", name, "bundle");
  const child = spawn("node", [scriptPath, bundleDir], {
    cwd: bundleDir,
    env: { ...process.env, PORT: "0" },
    // stderr is inherited, not piped: a function that logs enough
    // (console.error, an error stack trace) fills an unread pipe's
    // buffer and blocks the child forever — a real deadlock, not a
    // hypothetical one. Go's own version sets cmd.Stderr = os.Stderr
    // for the same reason.
    stdio: ["ignore", "pipe", "inherit"],
  });

  return new Promise((resolvePromise, rejectPromise) => {
    const rl = createInterface({ input: child.stdout! });
    let settled = false;

    rl.on("line", (line) => {
      const match = listeningRe.exec(line);
      if (match && !settled) {
        settled = true;
        resolvePromise({ child, port: Number(match[1]) });
        return;
      }
      // Go's own version keeps draining stdout after the listening
      // line (so the child never blocks on a full stdout pipe either)
      // and echoes what it reads to os.Stdout — match that here
      // rather than silently dropping every line the function logs.
      process.stdout.write(`${line}\n`);
    });

    child.once("exit", () => {
      if (!settled) {
        settled = true;
        rejectPromise(new Error(`funcproxy: node process for "${name}" exited before printing NBO_FUNCTION_LISTENING`));
      }
    });

    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    });
  });
}

async function killAll(children: ChildProcess[]): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolveExit) => {
          // A child that has already exited will never fire another
          // "exit" event — waiting for one here would hang forever.
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveExit();
            return;
          }
          child.once("exit", () => resolveExit());
          child.kill();
        }),
    ),
  );
}

// createLocalSpawner runs the generic Node host as a child process per
// function — the local `nbo serve` case. Unlike Go's own synchronous
// NewLocalSpawner (which blocks internally on a synchronous stdout
// read), this constructor is itself async: Node has no synchronous way
// to wait on a child process's stdout.
export async function createLocalSpawner(
  nboDir: string,
  functionNames: string[],
): Promise<{ resolve: Resolver; stop: () => Promise<void> }> {
  const scriptPath = await writeNodeHostScript();
  const ports = new Map<string, number>();
  const children: ChildProcess[] = [];

  try {
    for (const name of functionNames) {
      const { child, port } = await spawnFunctionHost(scriptPath, nboDir, name);
      children.push(child);
      ports.set(name, port);
    }
  } catch (err) {
    // A later function failing to spawn must not orphan the ones
    // already running, nor leak the shared host-script temp dir —
    // Go's own NewLocalSpawner calls its cleanup() on every error
    // path for the same reason.
    await killAll(children);
    await rm(join(scriptPath, ".."), { recursive: true, force: true });
    throw err;
  }

  const resolveFn: Resolver = (name: string) => {
    const port = ports.get(name);
    if (port === undefined) {
      throw new Error(`funcproxy: unknown function "${name}"`);
    }
    return (request: Request) => proxyRequestOrFail(request, new URL(`http://127.0.0.1:${port}`));
  };

  const stop = async (): Promise<void> => {
    await killAll(children);
    await rm(join(scriptPath, ".."), { recursive: true, force: true });
  };

  return { resolve: resolveFn, stop };
}
