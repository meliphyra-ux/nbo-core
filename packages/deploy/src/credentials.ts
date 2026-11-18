// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { kubectlArgs } from "@nbo/adapter-k8s";

export interface ToolContext {
  env?: Record<string, string>;
  kubeconfig?: string;
  namespace?: string;
}

// timeoutMs asks the runner for a longer (or shorter) per-command timeout
// than its default; runners without one ignore it.
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string>; input?: string; timeoutMs?: number },
) => Promise<string>;

// Test seam for simulating cleanup failures.
export const _internals = { rm };

async function removeDir(dir: string): Promise<void> {
  try {
    await _internals.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Never let a cleanup failure mask fn's own error or result.
    console.warn(`nbo: could not remove temporary credentials directory ${dir}`);
  }
}

async function privateDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return dir;
}

export type GoogleCredential =
  { kind: "key"; keyJson: string } | { kind: "wif"; audience: string; serviceAccount: string; signToken: () => string };

export interface GoogleCredentialOptions {
  refreshMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

const DEFAULT_REFRESH_MS = 30 * 60 * 1000;

// Materialises Google credentials in a private temp dir, points gcloud/docker
// at them for the duration of fn, and always removes them. A "key" credential
// is a service-account key file; a "wif" credential is an external_account
// config whose subject token file is rewritten while fn runs.
export async function withGoogleCredentials<T>(
  cred: GoogleCredential,
  region: string,
  run: CommandRunner,
  fn: (ctx: ToolContext) => Promise<T>,
  opts: GoogleCredentialOptions = {},
): Promise<T> {
  const dir = await privateDir("nbo-gcp-");
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let warned = false;
  const clear = opts.clearInterval ?? clearInterval;
  try {
    const env = { CLOUDSDK_CONFIG: join(dir, "gcloud"), DOCKER_CONFIG: join(dir, "docker") };
    const secrets: string[] = [];
    try {
      if (cred.kind === "key") {
        secrets.push(cred.keyJson, privateKeyOf(cred.keyJson));
        const keyFile = join(dir, "key.json");
        await writeFile(keyFile, cred.keyJson, { mode: 0o600 });
        await run("gcloud", ["auth", "activate-service-account", "--key-file", keyFile], { env });
      } else {
        const tokenFile = join(dir, "subject-token");
        // Written beside the token file and renamed over it, so gcloud never
        // reads an empty or partial token while it re-exchanges.
        const writeToken = async () => {
          if (stopped) return;
          let token: string;
          try {
            token = cred.signToken();
          } catch {
            // The signer's own message is dropped: it could carry key material.
            throw new Error("could not sign the Google subject token");
          }
          // Every token written is redacted, not only the first: an error
          // from fn may quote the one gcloud read last.
          secrets.push(token);
          const tmp = `${tokenFile}.tmp`;
          await writeFile(tmp, token, { mode: 0o600 });
          if (stopped) return;
          await rename(tmp, tokenFile);
        };
        await writeToken();
        const configFile = join(dir, "external-account.json");
        const config = {
          type: "external_account",
          audience: cred.audience,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          token_url: "https://sts.googleapis.com/v1/token",
          credential_source: { file: tokenFile },
          service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${cred.serviceAccount}:generateAccessToken`,
        };
        await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
        await run("gcloud", ["auth", "login", `--cred-file=${configFile}`, "--quiet"], { env });
        timer = (opts.setInterval ?? setInterval)(() => {
          // A failed refresh leaves the previous token; the next tick tries again.
          void writeToken().catch(() => {
            if (warned) return;
            warned = true;
            console.warn("nbo: could not refresh the Google subject token");
          });
        }, opts.refreshMs ?? DEFAULT_REFRESH_MS);
        (timer as { unref?: () => void }).unref?.();
      }
      await run("gcloud", ["auth", "configure-docker", `${region}-docker.pkg.dev`, "--quiet"], { env });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line preserve-caught-error -- the original error may carry key or token material
      throw new Error(redact(msg, secrets));
    }
    if (cred.kind === "key") return await fn({ env });
    try {
      return await fn({ env });
    } catch (err) {
      // The error keeps its class (callers tell errors apart by it); only its
      // text loses any subject token.
      if (err instanceof Error) {
        err.message = redact(err.message, secrets);
        if (err.stack) err.stack = redact(err.stack, secrets);
      }
      throw err;
    }
  } finally {
    stopped = true;
    if (timer !== undefined) clear(timer);
    await removeDir(dir);
  }
}

export async function withKubeconfig<T>(
  kubeconfig: string,
  namespace: string | undefined,
  fn: (ctx: ToolContext) => Promise<T>,
): Promise<T> {
  const dir = await privateDir("nbo-kube-");
  try {
    const path = join(dir, "kubeconfig");
    await writeFile(path, kubeconfig, { mode: 0o600 });
    return await fn({ kubeconfig: path, namespace });
  } finally {
    await removeDir(dir);
  }
}

// Logs docker in to a registry under a private, temporary DOCKER_CONFIG
// (the password goes over stdin, never argv) for the duration of fn, and
// always removes it. ctx.env carries that DOCKER_CONFIG for pushes.
export async function withDockerLogin<T>(
  server: string,
  username: string,
  password: string,
  run: CommandRunner,
  fn: (ctx: ToolContext) => Promise<T>,
): Promise<T> {
  const dir = await privateDir("nbo-docker-");
  try {
    const env = { DOCKER_CONFIG: dir };
    try {
      await run("docker", ["login", server, "--username", username, "--password-stdin"], { env, input: password });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line preserve-caught-error -- the original error may carry the password
      throw new Error(redact(msg, [password]));
    }
    return await fn({ env });
  } finally {
    await removeDir(dir);
  }
}

// redact replaces every occurrence of each secret (raw and base64) in
// text with "[redacted]". All occurrences are found in the original
// text first and overlapping or adjacent ones are merged into one span,
// so a shorter secret that prefixes (or overlaps) a longer one can never
// leave part of the longer one behind, whatever the list order.
export function redact(text: string, secrets: string[]): string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    forms.add(secret);
    forms.add(Buffer.from(secret).toString("base64"));
  }
  const spans: [number, number][] = [];
  for (const form of forms) {
    for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) spans.push([i, i + form.length]);
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let pos = 0;
  let [start, end] = spans[0]!;
  for (const [s, e] of spans.slice(1)) {
    if (s <= end) {
      end = Math.max(end, e);
      continue;
    }
    out += text.slice(pos, start) + "[redacted]";
    pos = end;
    [start, end] = [s, e];
  }
  return out + text.slice(pos, start) + "[redacted]" + text.slice(end);
}

function privateKeyOf(keyJson: string): string {
  try {
    const key = (JSON.parse(keyJson) as { private_key?: unknown }).private_key;
    return typeof key === "string" ? key : "";
  } catch {
    return "";
  }
}
