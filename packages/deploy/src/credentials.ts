// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ToolContext {
  env?: Record<string, string>;
  kubeconfig?: string;
  namespace?: string;
}

// timeoutMs asks the runner for a longer (or shorter) per-command timeout
// than its default; runners without one ignore it.
export type CommandRunner = (cmd: string, args: string[], opts?: { env?: Record<string, string>; input?: string; timeoutMs?: number }) => Promise<string>;

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

// Materialises a service-account key in a private temp dir, points
// gcloud/docker at it for the duration of fn, and always removes it.
export async function withGoogleCredentials<T>(keyJson: string, region: string, run: CommandRunner, fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
  const dir = await privateDir("nbo-gcp-");
  try {
    const keyFile = join(dir, "key.json");
    await writeFile(keyFile, keyJson, { mode: 0o600 });
    const env = { CLOUDSDK_CONFIG: join(dir, "gcloud"), DOCKER_CONFIG: join(dir, "docker") };
    try {
      await run("gcloud", ["auth", "activate-service-account", "--key-file", keyFile], { env });
      await run("gcloud", ["auth", "configure-docker", `${region}-docker.pkg.dev`, "--quiet"], { env });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line preserve-caught-error -- the original error may carry key material
      throw new Error(redact(msg, [keyJson, privateKeyOf(keyJson)]));
    }
    return await fn({ env });
  } finally {
    await removeDir(dir);
  }
}

export async function withKubeconfig<T>(kubeconfig: string, namespace: string | undefined, fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
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
export async function withDockerLogin<T>(server: string, username: string, password: string, run: CommandRunner, fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
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

export function kubectlArgs(ctx: ToolContext | undefined, args: string[]): string[] {
  const pre: string[] = [];
  if (ctx?.kubeconfig) pre.push("--kubeconfig", ctx.kubeconfig);
  if (ctx?.namespace) pre.push("-n", ctx.namespace);
  return [...pre, ...args];
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
