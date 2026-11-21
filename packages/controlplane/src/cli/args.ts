// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// nbo-server's command line: flag parsing, the usage text, errors and the control-plane address.
import { parseArgs, type ParseArgsConfig } from "node:util";

export interface ServerCliIO {
  fetch: typeof fetch;
  readFile(path: string): Promise<string>;
  stdin(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
  // sleep: between edge status polls (tests pass one that returns at once).
  sleep?(ms: number): Promise<void>;
}

export const usage = `Usage: nbo-server <command>

  status                                   preflight, connections and the edge
  token create <name> | list | revoke <id> API tokens
  connect google --key-file <path|-> --region <r>
  connect google --from-machine --project <p> --region <r>
  connect google --code <code> --region <r> keyless, with the setup command's code
  connect aws --access-key-id <id> --secret-key-file <path|-> --region <r>
  connect kubernetes --name <n> --kubeconfig-file <path|-> --registry-file <path|-> [--context <c>]
  google identity                          the core's Google identity (for the keyless setup command)
  google check                             the core's own check of its keyless Google connection
  disconnect google | disconnect aws | disconnect kubernetes <id>
  cluster test <id>
  cluster update-setup <id> --admin-kubeconfig-file <path|->
  cluster relay <id> --confirm-billing
  edge install --cluster <id> --admin-kubeconfig-file <path|-> --confirm-billing
  edge reinstall
  edge status [--wait]
  domains settings [--base-domain <d>] [--acme-email <e>] [--move-existing]
  project setup --body-file <path|-> | --body-stdin
  project retry <id>
  transfer <projectId> --to <cloudrun|lambda|kubernetes|kc_id> | transfer cancel <projectId>
  revalidate <projectId> --stage <stageId> [--tag <t>]... [--path <p>]...
  link <code|-> --url <url> --owner-key <fingerprint>
                                           link this server to a hosted dashboard
  link status | link journal [--limit <n>] the link's state, and what the platform did
  unlink                                   drop the link; the journal is kept
  keys reset --key sha256:<fingerprint>    a one-time code that registers that one Owner key
  keys list                                the member keys
  api <METHOD> <path> [--body-file <path|-> | --body-stdin]
      any route, with no token from this computer: it has the server's full power

A path of "-" reads stdin. The control-plane is at NBO_SERVER_URL (an address on
this computer only), else http://127.0.0.1:<port of NBO_CONTROL_PLANE_ADDR, or 8081>.`;

// UsageError: a mistake on the command line (exit 2, nothing sent).
export class UsageError extends Error {}
// Failed: the control-plane said no, or couldn't be reached (exit 1).
export class Failed extends Error {}

export const pollMs = 2_000;
export const maxWaitMs = 30 * 60_000;

export const onlyHere =
  "NBO_SERVER_URL must be an address on this computer, such as http://127.0.0.1:8081 or http://localhost:8091 (nbo-server sends credentials, and NBO takes requests without a token only from this computer)";

// loopbackHost: 127.0.0.0/8, ::1 or localhost, as URL parsing spells them.
export function loopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return m !== null && m.slice(1).every((n) => Number(n) <= 255);
}

// baseUrl: where the control-plane listens, always on this computer.
// NBO_SERVER_URL may name another loopback address or port, never another
// host: the commands carry kubeconfigs and keys, and a remote NBO refuses
// /system/* without a token anyway.
export function baseUrl(env: Record<string, string | undefined>): string {
  const explicit = env.NBO_SERVER_URL?.trim();
  if (explicit) {
    let u: URL;
    try {
      u = new URL(explicit);
    } catch {
      throw new UsageError(onlyHere);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(onlyHere);
    if (
      !loopbackHost(u.hostname) ||
      u.username !== "" ||
      u.password !== "" ||
      u.search !== "" ||
      u.hash !== "" ||
      (u.pathname !== "/" && u.pathname !== "")
    ) {
      throw new UsageError(onlyHere);
    }
    return `${u.protocol}//${u.host}`;
  }
  const addr = env.NBO_CONTROL_PLANE_ADDR?.trim();
  const port = addr ? addr.slice(addr.lastIndexOf(":") + 1) : "8081";
  if (!/^\d{1,5}$/.test(port)) throw new UsageError(`NBO_CONTROL_PLANE_ADDR has no port: ${addr}`);
  return `http://127.0.0.1:${port}`;
}

export type Options = NonNullable<ParseArgsConfig["options"]>;

// Flag forms that would put a secret on the command line. None exists.
export const secretFlags = new Set([
  "--kubeconfig",
  "--admin-kubeconfig",
  "--key",
  "--token",
  "--registry-password",
  "--body",
]);
export type Values = Record<string, string | boolean | string[] | undefined>;

// parse: strict parsing, so an unknown flag (such as --kubeconfig <text>)
// is an error before anything is read or sent.
export function parse(args: string[], options: Options, positionals: number): { values: Values; pos: string[] } {
  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (err) {
    // Name the flag only, never a value (--kubeconfig=<text> included).
    const message = err instanceof Error ? err.message : String(err);
    const unknown = /^Unknown option '(-{1,2}[A-Za-z0-9-]+)/.exec(message);
    if (unknown)
      throw new UsageError(
        `unknown flag ${unknown[1]}${secretFlags.has(unknown[1]!) ? ": secrets are read from a file or stdin, see the -file flags" : ""}`,
      );
    throw new UsageError(message.split("\n")[0]!);
  }
  if (parsed.positionals.length !== positionals) {
    // The stray value is not echoed: it may be a pasted secret.
    throw new UsageError(positionals === 0 ? "unexpected argument" : "missing or extra arguments");
  }
  return { values: parsed.values as Values, pos: parsed.positionals };
}

export const str = (v: Values, key: string): string | undefined =>
  typeof v[key] === "string" ? (v[key] as string) : undefined;

export function need(v: Values, key: string): string {
  const s = str(v, key);
  if (s === undefined || s === "") throw new UsageError(`--${key} is required`);
  return s;
}

// segment: an id or name going into a URL path, kept to one segment
// ("." and ".." would be collapsed by URL parsing into another route).
export function segment(s: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..")
    throw new UsageError(`${what} must be letters, digits, ".", "_" or "-", and not "." or ".."`);
  return s;
}

export const fileFlag = { type: "string" } as const;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function jobStatus(edge: unknown): string {
  return isRecord(edge) && isRecord(edge.job) && typeof edge.job.status === "string" ? edge.job.status : "";
}
