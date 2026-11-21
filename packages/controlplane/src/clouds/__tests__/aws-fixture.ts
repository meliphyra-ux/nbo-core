// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// A fake aws CLI for the AWS connection's tests (like the fake gcloud runners).
import type { CommandRunner } from "@nbo/deploy";

export const KEY_ID = "AKIAABCDEFGHIJKLMNOP";
export const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYzEXAMPLEKEY";
const notFound =
  "An error occurred (RepositoryNotFoundException) when calling the DescribeRepositories operation: The repository with name 'nbo' does not exist";

export type Call = { cmd: string; args: string[]; env?: Record<string, string> };

// fakeAws: the aws CLI as NBO calls it. handler answers a call by its
// arguments (a string, an Error to fail, undefined for the default answer).
export function fakeAws(
  handler: (line: string) => string | Error | undefined = () => undefined,
  account = "123456789012",
) {
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const line = args.join(" ");
    const custom = handler(line);
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return custom;
    if (line.startsWith("sts get-caller-identity"))
      return JSON.stringify({ Account: account, Arn: `arn:aws:iam::${account}:user/nbo` });
    if (line.startsWith("ecr describe-repositories")) throw new Error(`aws ${line} failed:\n${notFound}`);
    if (line.startsWith("ecr create-repository")) return JSON.stringify({ repository: { repositoryName: "nbo" } });
    return "{}";
  };
  return { run, calls, lines: () => calls.map((c) => c.args.join(" ")) };
}
