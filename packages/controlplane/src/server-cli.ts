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

const usage = `Usage: nbo-server <command>

  status                                   preflight, connections and the edge
  token create <name> | list | revoke <id> API tokens
  connect google --key-file <path|-> --region <r>
  connect google --from-machine --project <p> --region <r>
  connect kubernetes --name <n> --kubeconfig-file <path|-> --registry-file <path|-> [--context <c>]
  disconnect google | disconnect kubernetes <id>
  cluster test <id>
  cluster update-setup <id> --admin-kubeconfig-file <path|->
  cluster relay <id> --confirm-billing
  edge install --cluster <id> --admin-kubeconfig-file <path|-> --confirm-billing
  edge reinstall
  edge status [--wait]
  domains settings [--base-domain <d>] [--acme-email <e>] [--move-existing]
  project setup --body-file <path|-> | --body-stdin
  project retry <id>
  transfer <projectId> --to <cloudrun|kubernetes|kc_id> | transfer cancel <projectId>
  revalidate <projectId> --stage <stageId> [--tag <t>]... [--path <p>]...
  api <METHOD> <path> [--body-file <path|-> | --body-stdin]
      any route, with no token from this computer: it has the server's full power

A path of "-" reads stdin. The control-plane is at NBO_SERVER_URL (an address on
this computer only), else http://127.0.0.1:<port of NBO_CONTROL_PLANE_ADDR, or 8081>.`;

// UsageError: a mistake on the command line (exit 2, nothing sent).
class UsageError extends Error {}
// Failed: the control-plane said no, or couldn't be reached (exit 1).
class Failed extends Error {}

const pollMs = 2_000;
const maxWaitMs = 30 * 60_000;

const onlyHere =
  "NBO_SERVER_URL must be an address on this computer, such as http://127.0.0.1:8081 or http://localhost:8091 (nbo-server sends credentials, and NBO takes requests without a token only from this computer)";

// loopbackHost: 127.0.0.0/8, ::1 or localhost, as URL parsing spells them.
function loopbackHost(hostname: string): boolean {
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
    if (!loopbackHost(u.hostname) || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || (u.pathname !== "/" && u.pathname !== "")) {
      throw new UsageError(onlyHere);
    }
    return `${u.protocol}//${u.host}`;
  }
  const addr = env.NBO_CONTROL_PLANE_ADDR?.trim();
  const port = addr ? addr.slice(addr.lastIndexOf(":") + 1) : "8081";
  if (!/^\d{1,5}$/.test(port)) throw new UsageError(`NBO_CONTROL_PLANE_ADDR has no port: ${addr}`);
  return `http://127.0.0.1:${port}`;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

// Flag forms that would put a secret on the command line. None exists.
const secretFlags = new Set(["--kubeconfig", "--admin-kubeconfig", "--key", "--token", "--registry-password", "--body"]);
type Values = Record<string, string | boolean | string[] | undefined>;

// parse: strict parsing, so an unknown flag (such as --kubeconfig <text>)
// is an error before anything is read or sent.
function parse(args: string[], options: Options, positionals: number): { values: Values; pos: string[] } {
  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (err) {
    // Name the flag only, never a value (--kubeconfig=<text> included).
    const message = err instanceof Error ? err.message : String(err);
    const unknown = /^Unknown option '(-{1,2}[A-Za-z0-9-]+)/.exec(message);
    if (unknown) throw new UsageError(`unknown flag ${unknown[1]}${secretFlags.has(unknown[1]!) ? ": secrets are read from a file or stdin, see the -file flags" : ""}`);
    throw new UsageError(message.split("\n")[0]!);
  }
  if (parsed.positionals.length !== positionals) {
    // The stray value is not echoed: it may be a pasted secret.
    throw new UsageError(positionals === 0 ? "unexpected argument" : "missing or extra arguments");
  }
  return { values: parsed.values as Values, pos: parsed.positionals };
}

const str = (v: Values, key: string): string | undefined => (typeof v[key] === "string" ? (v[key] as string) : undefined);

function need(v: Values, key: string): string {
  const s = str(v, key);
  if (s === undefined || s === "") throw new UsageError(`--${key} is required`);
  return s;
}

// segment: an id or name going into a URL path, kept to one segment
// ("." and ".." would be collapsed by URL parsing into another route).
function segment(s: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") throw new UsageError(`${what} must be letters, digits, ".", "_" or "-", and not "." or ".."`);
  return s;
}

const fileFlag = { type: "string" } as const;

export async function runServerCli(argv: string[], io: ServerCliIO): Promise<number> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stdinUsed = false;

  // readSecret: a file's text, or stdin for "-" (at most once per command).
  const readSecret = async (path: string, flag: string): Promise<string> => {
    if (path === "-") {
      if (stdinUsed) throw new UsageError(`only one flag can read stdin ("-"); give --${flag} a file`);
      stdinUsed = true;
      return io.stdin();
    }
    try {
      return await io.readFile(path);
    } catch (err) {
      throw new UsageError(`--${flag}: can't read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const readJsonFile = async (path: string, flag: string): Promise<unknown> => {
    const text = await readSecret(path, flag);
    try {
      return JSON.parse(text);
    } catch {
      // The text may be secret: say where it came from, not what it was.
      throw new UsageError(`--${flag}: ${path === "-" ? "stdin" : path} is not JSON`);
    }
  };

  let base = "";

  // call: one request; the parsed answer, or Failed with the status and error.
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    // The control-plane never redirects; following one could resend a secret body elsewhere.
    const init: RequestInit = { method, redirect: "error" };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    let res: Response;
    try {
      res = await io.fetch(base + path, init);
    } catch (err) {
      throw new Failed(`can't reach the control-plane at ${base}: ${err instanceof Error ? err.message : String(err)}. Is NBO running? Set NBO_SERVER_URL if it listens on another port of this computer.`);
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const msg = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : typeof parsed === "string" && parsed !== "" ? parsed : res.statusText;
      throw new Failed(`${res.status} ${msg}`);
    }
    return parsed;
  };

  const print = (value: unknown): void => {
    if (value === undefined) io.out("done");
    else io.out(JSON.stringify(value, null, 2));
  };

  const kubeconfigSource = async (v: Values, flag: string): Promise<Record<string, unknown>> => {
    const kubeconfig = await readSecret(need(v, flag), flag);
    const source: Record<string, unknown> = { kind: "kubeconfig", kubeconfig };
    const context = str(v, "context");
    if (context) source.context = context;
    return source;
  };

  const confirmBilling = (v: Values, what: string): void => {
    if (v["confirm-billing"] !== true) {
      throw new UsageError(`${what} makes a load balancer that your cloud provider bills for. Add --confirm-billing to go ahead.`);
    }
  };

  try {
    const [cmd, sub, ...rest] = argv;
    if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
      io.out(usage);
      return cmd === undefined ? 2 : 0;
    }
    base = baseUrl(io.env);
    const after = sub === undefined ? [] : [sub, ...rest];

    switch (cmd) {
      case "status": {
        parse(after, {}, 0);
        const preflight = await call("GET", "/system/preflight");
        const connections = await call("GET", "/system/connections");
        const edge = await call("GET", "/system/edge");
        print({ preflight, connections, edge });
        return 0;
      }

      case "token": {
        if (sub === "create") {
          const { pos } = parse(rest, {}, 1);
          const answer = await call("POST", "/system/api-tokens", { name: pos[0] });
          const { token, ...view } = isRecord(answer) ? answer : { token: undefined };
          print(view);
          if (typeof token === "string") {
            io.out("");
            io.out(`Token (store it now, it is not shown again): ${token}`);
          }
          return 0;
        }
        if (sub === "list") {
          parse(rest, {}, 0);
          print(await call("GET", "/system/api-tokens"));
          return 0;
        }
        if (sub === "revoke") {
          const { pos } = parse(rest, {}, 1);
          print(await call("DELETE", `/system/api-tokens/${segment(pos[0]!, "token id")}`));
          return 0;
        }
        throw new UsageError("token needs create <name>, list or revoke <id>");
      }

      case "connect": {
        if (sub === "google") {
          const { values } = parse(rest, { "key-file": fileFlag, "from-machine": { type: "boolean" }, project: { type: "string" }, region: { type: "string" } }, 0);
          const region = need(values, "region");
          if (values["from-machine"] === true) {
            if (values["key-file"] !== undefined) throw new UsageError("use --key-file or --from-machine, not both");
            print(await call("POST", "/system/connections/google", { source: "machine", project: need(values, "project"), region }));
            return 0;
          }
          if (values.project !== undefined) throw new UsageError("--project goes with --from-machine; a key file names its own project");
          const keyJson = await readSecret(need(values, "key-file"), "key-file");
          print(await call("POST", "/system/connections/google", { source: "key", keyJson, region }));
          return 0;
        }
        if (sub === "kubernetes") {
          const { values } = parse(rest, { name: { type: "string" }, "kubeconfig-file": fileFlag, context: { type: "string" }, "registry-file": fileFlag }, 0);
          const name = need(values, "name");
          const registryPath = need(values, "registry-file");
          const source = await kubeconfigSource(values, "kubeconfig-file");
          const reg = await readJsonFile(registryPath, "registry-file");
          if (!isRecord(reg) || !isRecord(reg.registry)) {
            throw new UsageError('--registry-file must hold {"registry": {"kind": "artifact-registry"} or {"kind": "custom", "server": ..., "username": ...}, "registryPassword": ...}');
          }
          const body: Record<string, unknown> = { name, source, registry: reg.registry };
          if (reg.registryPassword !== undefined) body.registryPassword = reg.registryPassword;
          print(await call("POST", "/system/connections/kubernetes", body));
          return 0;
        }
        throw new UsageError("connect needs google or kubernetes");
      }

      case "disconnect": {
        if (sub === "google") {
          parse(rest, {}, 0);
          print(await call("DELETE", "/system/connections/google"));
          return 0;
        }
        if (sub === "kubernetes") {
          const { pos } = parse(rest, {}, 1);
          print(await call("DELETE", `/system/connections/kubernetes/${segment(pos[0]!, "cluster id")}`));
          return 0;
        }
        throw new UsageError("disconnect needs google or kubernetes <id>");
      }

      case "cluster": {
        if (sub === "test") {
          const { pos } = parse(rest, {}, 1);
          print(await call("POST", `/system/connections/kubernetes/${segment(pos[0]!, "cluster id")}/test`));
          return 0;
        }
        if (sub === "update-setup") {
          const { values, pos } = parse(rest, { "admin-kubeconfig-file": fileFlag, context: { type: "string" } }, 1);
          const id = segment(pos[0]!, "cluster id");
          const admin = await kubeconfigSource(values, "admin-kubeconfig-file");
          print(await call("POST", `/system/clusters/${id}/update-setup`, { admin }));
          return 0;
        }
        if (sub === "relay") {
          // The relay route takes no admin credentials: NBO's own token for
          // that cluster is enough.
          const { values, pos } = parse(rest, { "confirm-billing": { type: "boolean" } }, 1);
          const id = segment(pos[0]!, "cluster id");
          confirmBilling(values, "Enabling public entry");
          print(await call("POST", `/system/clusters/${id}/relay`, { confirmBilling: true }));
          io.out(`The relay is being set up in the background. Check it with: nbo-server api GET /system/clusters/${id}/relay`);
          return 0;
        }
        throw new UsageError("cluster needs test, update-setup or relay");
      }

      case "edge": {
        if (sub === "install") {
          const { values } = parse(rest, { cluster: { type: "string" }, "admin-kubeconfig-file": fileFlag, context: { type: "string" }, "confirm-billing": { type: "boolean" } }, 0);
          const clusterId = need(values, "cluster");
          confirmBilling(values, "Installing the edge");
          const admin = await kubeconfigSource(values, "admin-kubeconfig-file");
          print(await call("POST", "/system/edge/install", { clusterId, admin, confirmBilling: true }));
          io.out("The edge is installing in the background. Follow it with: nbo-server edge status --wait");
          return 0;
        }
        if (sub === "reinstall") {
          parse(rest, {}, 0);
          print(await call("POST", "/system/edge/reinstall", {}));
          io.out("The edge is reinstalling in the background. Follow it with: nbo-server edge status --wait");
          return 0;
        }
        if (sub === "status") {
          const { values } = parse(rest, { wait: { type: "boolean" } }, 0);
          let status = await call("GET", "/system/edge");
          if (values.wait === true) {
            for (let waited = 0; jobStatus(status) === "running"; waited += pollMs) {
              if (waited >= maxWaitMs) {
                print(status);
                throw new Failed("the edge job is still running after 30 minutes; check again with: nbo-server edge status");
              }
              await sleep(pollMs);
              status = await call("GET", "/system/edge");
            }
          }
          print(status);
          return values.wait === true && jobStatus(status) === "failed" ? 1 : 0;
        }
        throw new UsageError("edge needs install, reinstall or status");
      }

      case "domains": {
        if (sub !== "settings") throw new UsageError("domains needs settings");
        const { values } = parse(rest, { "base-domain": { type: "string" }, "acme-email": { type: "string" }, "move-existing": { type: "boolean" } }, 0);
        const body: Record<string, unknown> = {};
        if (values["base-domain"] !== undefined) body.baseDomain = values["base-domain"];
        if (values["acme-email"] !== undefined) body.acmeEmail = values["acme-email"];
        if (values["move-existing"] === true) body.moveExisting = true;
        if (Object.keys(body).length === 0) throw new UsageError("give --base-domain, --acme-email or --move-existing");
        print(await call("PATCH", "/system/domains", body));
        return 0;
      }

      case "project": {
        if (sub === "setup") {
          const { values } = parse(rest, { "body-file": fileFlag, "body-stdin": { type: "boolean" } }, 0);
          const body = await requestBody(values);
          if (body === undefined) throw new UsageError("project setup needs --body-file or --body-stdin");
          const summary = await call("POST", "/projects/setup", body);
          print(summary);
          const project = isRecord(summary) && isRecord(summary.project) ? summary.project : undefined;
          const id = typeof project?.id === "string" ? project.id : "";
          const wantsKey = isRecord(body) && isRecord(body.credential) && body.credential.kind === "deploy-key";
          if (wantsKey && id) {
            const git = await call("GET", `/projects/${segment(id, "project id")}/git`);
            const publicKey = isRecord(git) && isRecord(git.credential) && typeof git.credential.publicKey === "string" ? git.credential.publicKey : "";
            io.out("");
            io.out("Deploy key (public half):");
            io.out(publicKey);
            io.out("");
            io.out("Next: add this key to the repository as a read-only deploy key. NBO's first look at the");
            io.out("repository fails until you do. Once it is added, run:");
            io.out(`  nbo-server project retry ${id}`);
          }
          return 0;
        }
        if (sub === "retry") {
          const { pos } = parse(rest, {}, 1);
          print(await call("POST", `/projects/${segment(pos[0]!, "project id")}/setup/retry`, {}));
          return 0;
        }
        throw new UsageError("project needs setup or retry <id>");
      }

      case "transfer": {
        if (sub === "cancel") {
          const { pos } = parse(rest, {}, 1);
          print(await call("POST", `/projects/${segment(pos[0]!, "project id")}/transfer/cancel`));
          return 0;
        }
        const { values, pos } = parse(after, { to: { type: "string" } }, 1);
        const id = segment(pos[0]!, "project id");
        const to = need(values, "to");
        let body: Record<string, unknown>;
        if (to === "cloudrun") body = { target: "cloudrun", mode: "auto" };
        else if (to === "kubernetes") body = { target: "kubernetes" };
        else if (/^kc_[a-z0-9]{1,32}$/.test(to)) body = { target: "kubernetes", clusterId: to };
        else throw new UsageError("--to must be cloudrun, kubernetes or a cluster id (kc_...)");
        print(await call("POST", `/projects/${id}/transfer`, body));
        return 0;
      }

      case "revalidate": {
        const { values, pos } = parse(after, { stage: { type: "string" }, tag: { type: "string", multiple: true }, path: { type: "string", multiple: true } }, 1);
        const id = segment(pos[0]!, "project id");
        const stage = segment(need(values, "stage"), "stage id");
        const body: Record<string, unknown> = {};
        const tags = values.tag as string[] | undefined;
        const paths = values.path as string[] | undefined;
        if (tags?.length) body.tags = tags;
        if (paths?.length) body.paths = paths;
        if (!body.tags && !body.paths) throw new UsageError("give at least one --tag or --path");
        print(await call("POST", `/projects/${id}/stages/${stage}/revalidate`, body));
        return 0;
      }

      case "api": {
        const { values, pos } = parse(after, { "body-file": fileFlag, "body-stdin": { type: "boolean" } }, 2);
        const method = pos[0]!.toUpperCase();
        const path = pos[1]!;
        if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) throw new UsageError("METHOD must be GET, POST, PUT, PATCH or DELETE");
        if (!/^\/[^\s]*$/.test(path) || path.startsWith("//")) throw new UsageError('the path must start with "/", like /projects');
        print(await call(method, path, await requestBody(values)));
        return 0;
      }

      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
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

  // requestBody: JSON from --body-file or --body-stdin, or none.
  async function requestBody(values: Values): Promise<unknown> {
    const file = str(values, "body-file");
    if (file !== undefined && values["body-stdin"] === true) throw new UsageError("use --body-file or --body-stdin, not both");
    if (file !== undefined) return readJsonFile(file, "body-file");
    if (values["body-stdin"] === true) return readJsonFile("-", "body-stdin");
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jobStatus(edge: unknown): string {
  return isRecord(edge) && isRecord(edge.job) && typeof edge.job.status === "string" ? edge.job.status : "";
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
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
