// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The boundary to the aws CLI, shared by the control-plane's AWS connection
// and the Lambda adapter. Credentials travel only in the child's environment.

// CommandRunner matches @nbo/deploy's (this package sits below it):
// resolves stdout+stderr, rejects on a non-zero exit.
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string>; input?: string; timeoutMs?: number },
) => Promise<string>;

// An IAM user's access key pair and the one region NBO uses.
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface ToolContext {
  env: Record<string, string>;
  run: CommandRunner;
  // Tests fake the waits between retries.
  sleep?: (ms: number) => Promise<void>;
}

// NO_AWS_FILE: a path that doesn't exist, for the CLI's config and
// credentials files, so the host's ~/.aws (a default profile's endpoint_url,
// ca_bundle or keys) never applies to NBO's calls.
export const NO_AWS_FILE = "/nonexistent/nbo-no-aws-file";

// awsContext: the env every aws call gets. AWS_PAGER="" keeps the CLI from
// waiting on a pager; the runner's childEnv drops the host's own AWS_* values.
export function awsContext(c: AwsCredentials, run: CommandRunner): ToolContext {
  return {
    run,
    env: {
      AWS_ACCESS_KEY_ID: c.accessKeyId,
      AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
      AWS_REGION: c.region,
      AWS_PAGER: "",
      AWS_CONFIG_FILE: NO_AWS_FILE,
      AWS_SHARED_CREDENTIALS_FILE: NO_AWS_FILE,
    },
  };
}

// aws runs one aws CLI call with JSON output. A failure's text never carries
// the key pair (the CLI should not echo it; this makes sure); its code
// (ENOENT for a missing CLI) is kept.
export async function aws(ctx: ToolContext, args: string[]): Promise<string> {
  try {
    return await ctx.run("aws", [...args, "--output", "json"], { env: ctx.env });
  } catch (err) {
    let text = err instanceof Error ? err.message : String(err);
    for (const s of [ctx.env.AWS_SECRET_ACCESS_KEY, ctx.env.AWS_ACCESS_KEY_ID])
      if (s) text = text.split(s).join("[redacted]");
    // Lambda's 4 KB refusal quotes every variable after "String measured:".
    text = text.replace(/String measured:[\s\S]*/, "String measured: [not shown]");
    const out = new Error(text);
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== undefined) Object.assign(out, { code });
    // No cause: the original error may carry the key pair.
    throw out;
  }
}

// awsJson parses a call's JSON answer; the runner merges stderr, so the
// object is taken from between any warning lines.
export async function awsJson<T>(ctx: ToolContext, args: string[]): Promise<T> {
  const out = await aws(ctx, args);
  const a = out.indexOf("{");
  const b = out.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`aws ${args.join(" ")} returned no JSON`);
  return JSON.parse(out.slice(a, b + 1)) as T;
}
