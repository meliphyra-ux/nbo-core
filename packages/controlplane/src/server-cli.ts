#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich
// nbo-server: the operator's command for a headless NBO. It does over
// loopback what the dashboard used to do: connect clouds, install the edge,
// set domains, make API tokens. It talks to the control-plane on this
// computer with no token (the loopback rule, access.ts).
//
// Secrets (kubeconfigs, Google keys, registry passwords, request bodies)
// come only from files or stdin ("-"), never from a flag's value, so they
// stay out of the process list and shell history. Nothing here logs them:
// they go in the request body and nowhere else.

import { readFile as fsReadFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Failed, UsageError, baseUrl, usage, type ServerCliIO } from "./cli/args.js";
import { createCliContext } from "./cli/context.js";
import { runSetupCommand } from "./cli/setup-commands.js";
import { runProjectCommand } from "./cli/project-commands.js";
import { runAdminCommand } from "./cli/admin-commands.js";

export { baseUrl, type ServerCliIO };

export async function runServerCli(argv: string[], io: ServerCliIO): Promise<number> {
  const ctx = createCliContext(io);
  try {
    const [cmd, sub, ...rest] = argv;
    if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
      io.out(usage);
      return cmd === undefined ? 2 : 0;
    }
    ctx.setBase(baseUrl(io.env));
    const after = sub === undefined ? [] : [sub, ...rest];

    const code =
      (await runSetupCommand(ctx, cmd, sub, rest, after)) ??
      (await runProjectCommand(ctx, cmd, sub, rest, after)) ??
      (await runAdminCommand(ctx, cmd, sub, rest, after));
    if (code === undefined) throw new UsageError(`unknown command: ${cmd}`);
    return code;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`nbo-server: ${err.message}`);
      io.err('Run "nbo-server help" for the commands.');
      return 2;
    }
    if (err instanceof Failed) {
      io.err(`nbo-server: ${err.message}`);
      return 1;
    }
    io.err(`nbo-server: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(): Promise<void> {
  const code = await runServerCli(process.argv.slice(2), {
    fetch: globalThis.fetch,
    readFile: (path) => fsReadFile(path, "utf8"),
    stdin: readAllStdin,
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
    env: process.env,
  });
  process.exitCode = code;
}

// Run when started directly, including through the /usr/local/bin/nbo-server
// symlink (argv[1] is the link, so compare real paths).
async function startedDirectly(): Promise<boolean> {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(await realpath(entry)).href;
  } catch {
    return false;
  }
}

if (await startedDirectly()) await main();
