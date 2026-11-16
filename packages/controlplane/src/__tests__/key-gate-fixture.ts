// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { lsRemoteHead, lsRemoteHeads } from "../git/gitremote.js";
import type { CommandRunner } from "@nbo/deploy";
import { rm, writeFile } from "node:fs/promises";
import { afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V2Options } from "../v2.js";

const scratch = join(tmpdir(), `nbo-keygate-${process.pid}`);
// Whatever the test file made there goes after its tests.
afterAll(() => rm(scratch, { recursive: true, force: true }));

export const sshRepo = "git@github.com:acme/storefront.git";
export const keyRefusal = "git@github.com: Permission denied (publickey).";

// keyGate: the V2 options for a repository that refuses reads until
// gate.open is set (a deploy key not yet added), a fake clock, and a fake
// ssh-keygen. Every refused or accepted read is counted in gate.reads.
export function keyGate(start = Date.parse("2026-11-14T00:00:00Z")) {
  const gate = { open: false, reads: 0, clock: start };
  const check = (): void => {
    gate.reads++;
    if (!gate.open) throw new Error(`${keyRefusal}\nfatal: Could not read from remote repository.`);
  };
  const keygen: CommandRunner = async (_cmd, args) => {
    const file = args[args.indexOf("-f") + 1]!;
    await writeFile(file, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n");
    await writeFile(`${file}.pub`, "ssh-ed25519 AAAAfake nbo-test\n");
    return "";
  };
  const v2: Partial<V2Options> = {
    keygen,
    // deploy-key git steps need a known_hosts location (never read: the url is rewritten to a local path).
    knownHostsFile: join(scratch, "known_hosts"),
    now: () => new Date(gate.clock),
    lsRemote: async (repo, branch, opts) => {
      check();
      return lsRemoteHead(repo, branch, opts);
    },
    lsRemoteHeads: async (repo, opts) => {
      check();
      return lsRemoteHeads(repo, opts);
    },
  };
  return { gate, v2 };
}
