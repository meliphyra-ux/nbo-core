// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Black-box harness: starts the edge binary named by NBO_EDGE_BIN (default:
// this package's own `node dist/main.js`) on free ports, plus the fakes it
// talks to: a recording HTTP backend, a fake Kubernetes API over TLS with a
// test CA, and TLS material made at test time (no key is ever committed).
//
// The same suite runs against the TypeScript edge and the Rust edge; it is
// the parity proof (see docs/adr/0005-edge-in-rust.md).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttp,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttps, request as httpsRequest } from "node:https";
import { connect as netConnect, createServer as createNet, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_EDGE_MAIN = join(PACKAGE_DIR, "dist", "main.js");

// edgeBin is the binary under test. A path ending in .js/.mjs runs under
// this Node; anything else is executed directly (the Rust binary).
export function edgeBin(): string {
  return process.env.NBO_EDGE_BIN?.trim() || DEFAULT_EDGE_MAIN;
}

// edgeImpl: "rust" when NBO_EDGE_IMPL=rust, else "ts". Lets a test that
// only holds for one edge (an intended difference) say so.
export function edgeImpl(): "ts" | "rust" {
  return process.env.NBO_EDGE_IMPL === "rust" ? "rust" : "ts";
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nbo-edge-bb-"));
}

export async function freePort(): Promise<number> {
  const server = createNet();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("error", () => resolveConnect(false));
  });
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface EdgeOptions {
  mode: "dev" | "cluster" | "relay";
  env?: Record<string, string>;
}

export interface RunningEdge {
  dataUrl: string;
  httpsUrl?: string;
  adminUrl: string;
  ports: { data: number; https?: number; admin?: number };
  // logs is everything the binary wrote to stdout and stderr so far.
  logs(): string;
  stop(): Promise<void>;
}

// startEdge runs the binary in one mode on free ports and resolves once every
// listener accepts connections. Cluster mode needs NBO_EDGE_KUBE_API,
// NBO_EDGE_KUBE_TOKEN_FILE and NBO_EDGE_KUBE_CA_FILE in env (see
// startFakeKube); relay mode needs NBO_RELAY_TOKEN, NBO_RELAY_TLS_CERT and
// NBO_RELAY_TLS_KEY. Inherited NBO_* variables are dropped so the parent's
// environment never leaks into the edge under test.
export async function startEdge(opts: EdgeOptions): Promise<RunningEdge> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("NBO_")) env[k] = v;
  let ports: RunningEdge["ports"];
  let dataUrl: string;
  let httpsUrl: string | undefined;
  let adminUrl = "";
  if (opts.mode === "dev") {
    const [data, admin] = [await freePort(), await freePort()];
    env.NBO_EDGE_ADDR = `:${data}`;
    env.NBO_EDGE_ADMIN_ADDR = `127.0.0.1:${admin}`;
    ports = { data, admin };
    dataUrl = `http://127.0.0.1:${data}`;
    adminUrl = `http://127.0.0.1:${admin}`;
  } else if (opts.mode === "cluster") {
    const [data, https, admin] = [await freePort(), await freePort(), await freePort()];
    env.NBO_EDGE_SOURCE = "kubernetes";
    env.NBO_EDGE_CLUSTER_PORTS = `${data},${https},${admin}`;
    ports = { data, https, admin };
    dataUrl = `http://127.0.0.1:${data}`;
    httpsUrl = `https://127.0.0.1:${https}`;
    adminUrl = `http://127.0.0.1:${admin}`;
  } else {
    const data = await freePort();
    env.NBO_EDGE_MODE = "relay";
    env.NBO_EDGE_RELAY_PORT = String(data);
    ports = { data };
    dataUrl = `https://127.0.0.1:${data}`;
  }
  Object.assign(env, opts.env ?? {});

  const bin = edgeBin();
  // A missing binary fails the suite: the parity proof must never pass
  // green having run nothing.
  if (!existsSync(bin))
    throw new Error(
      `edge binary ${bin} does not exist (build with \`pnpm --filter @nbo/edge... build\` or set NBO_EDGE_BIN)`,
    );
  const child: ChildProcess = /\.(m?js)$/.test(bin)
    ? spawn(process.execPath, [bin], { env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(bin, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (c: Buffer) => (output += c.toString("utf8")));
  child.stderr!.on("data", (c: Buffer) => (output += c.toString("utf8")));
  let exited = false;
  const exit = new Promise<void>((r) =>
    child.once("exit", () => {
      exited = true;
      r();
    }),
  );

  const stop = async () => {
    if (!exited) child.kill();
    await exit;
  };
  try {
    const wanted = [ports.data, ports.https, ports.admin].filter((p): p is number => p !== undefined);
    await until(
      async () => {
        if (exited) throw new Error(`edge exited during startup:\n${output}`);
        for (const p of wanted) if (!(await canConnect(p))) return false;
        return true;
      },
      15_000,
      `the edge to listen (${bin})`,
    );
  } catch (err) {
    await stop();
    throw err;
  }
  return { dataUrl, httpsUrl, adminUrl, ports, logs: () => output, stop };
}

// ---------- plain HTTP(S) client: raw bytes, no decompression, no redirects

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  raw: Buffer;
  body: string;
}

export interface SendOptions {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  // ca/servername for https URLs.
  ca?: string;
  servername?: string;
  // path as written on the request line (an absolute-form target, say).
  rawPath?: string;
  timeoutMs?: number;
}

// send makes one request with exactly the given headers (Host included, so a
// test names the virtual host) on a fresh connection.
export function send(url: string, opts: SendOptions = {}): Promise<Reply> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  return new Promise((resolveReply, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        host: u.hostname,
        port: u.port,
        method: opts.method ?? "GET",
        path: opts.rawPath ?? `${u.pathname}${u.search}`,
        headers: opts.headers,
        agent: false,
        ...(isHttps ? { ca: opts.ca, servername: opts.servername } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolveReply({ status: res.statusCode!, headers: res.headers, raw, body: raw.toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(opts.timeoutMs ?? 20_000, () => req.destroy(new Error("client timeout")));
    req.on("error", reject);
    req.end(opts.body);
  });
}

// sendRaw writes request bytes exactly as given (headers a Node client
// refuses to send, such as Trailer on a bodiless request) and resolves with
// whatever the server answered before closing or timeoutMs.
export function sendRaw(port: number, text: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolveRaw, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    let out = "";
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      // One complete bodiless or content-length response is enough.
      const end = out.indexOf("\r\n\r\n");
      if (end >= 0) {
        const len = /\r\ncontent-length:\s*(\d+)/i.exec(out.slice(0, end));
        if (len && out.length >= end + 4 + Number(len[1])) socket.destroy();
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolveRaw(out);
    });
    socket.on("error", reject);
    socket.write(text);
  });
}

// ---------- recording backend

export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
}

export type BackendHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

export interface FakeBackend {
  url: string;
  seen: Seen[];
  setHandler(handler: BackendHandler): void;
  close(): Promise<void>;
}

// startBackend answers every request with its name (text/plain, plus
// x-backend: <name>) unless a handler is set, and records what it received.
export async function startBackend(
  name: string,
  server?: (listener: (req: IncomingMessage, res: ServerResponse) => void) => Server,
): Promise<FakeBackend> {
  const seen: Seen[] = [];
  let handler: BackendHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-backend": name });
    res.end(name);
  };
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: body.toString("utf8"),
      });
      handler(req, res, body);
    });
  };
  const s = server ? server(listener) : createHttp(listener);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const scheme = server ? "https" : "http";
  return {
    url: `${scheme}://127.0.0.1:${(s.address() as AddressInfo).port}`,
    seen,
    setHandler(h) {
      handler = h;
    },
    close: () => closeServer(s),
  };
}

export function closeServer(s: Server): Promise<void> {
  return new Promise((r) => {
    if (!s.listening) return r();
    s.close(() => r());
    s.closeAllConnections();
  });
}

// ---------- TLS material, made at test time

const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

function pemKey(pkcs8: ArrayBuffer): string {
  const b64 = Buffer.from(pkcs8).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

export interface TestCa {
  cert: string;
  // leaf issues a certificate for DNS names and/or IP addresses.
  leaf(names: { dns?: string[]; ip?: string[] }): Promise<{ cert: string; key: string }>;
}

let serial = 1;

export async function createTestCa(): Promise<TestCa> {
  const caKeys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: String(serial++).padStart(2, "0"),
    name: "CN=nbo edge test CA",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: alg,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });
  return {
    cert: ca.toString("pem"),
    async leaf(names) {
      const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
      const sans = [
        ...(names.dns ?? []).map((value) => ({ type: "dns" as const, value })),
        ...(names.ip ?? []).map((value) => ({ type: "ip" as const, value })),
      ];
      const cert = await x509.X509CertificateGenerator.create({
        serialNumber: String(serial++).padStart(2, "0"),
        subject: `CN=${names.dns?.[0] ?? names.ip?.[0] ?? "leaf"}`,
        issuer: ca.subject,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 3_600_000),
        signingAlgorithm: alg,
        publicKey: keys.publicKey,
        signingKey: caKeys.privateKey,
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
          new x509.SubjectAlternativeNameExtension(sans),
        ],
      });
      return { cert: cert.toString("pem"), key: pemKey(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)) };
    },
  };
}

// ---------- fake Kubernetes API

export interface FakeKube {
  url: string;
  caFile: string;
  tokenFile: string;
  // configmap is routes.json's text; undefined answers 404.
  configmap: string | undefined;
  secrets: { name: string; crt: string; key: string }[];
  // auth holds every Authorization header received, in order.
  auth: string[];
  // paths holds every request path received, in order.
  paths: string[];
  // namespace is the one the edge is expected to read.
  namespace: string;
  // otherConfigmaps: routes.json served for other namespaces (a decoy the
  // edge must never read).
  otherConfigmaps: Record<string, string>;
  // polls counts ConfigMap reads, so a test can wait for the next poll.
  polls: number;
  setToken(token: string): void;
  // nextPoll resolves after the edge has read the ConfigMap and the Secrets
  // at least once more.
  nextPoll(): Promise<void>;
  close(): Promise<void>;
}

// PRODUCTION_NAMESPACE is what the control-plane sets NBO_EDGE_NAMESPACE to
// for the public edge (edge-manifests.ts), not the binary's own default.
export const PRODUCTION_NAMESPACE = "nbo-edge";

// startFakeKube serves the two GETs the cluster edge makes, over TLS with a
// certificate for 127.0.0.1 from the given CA, and writes the token and CA
// files the edge reads (NBO_EDGE_KUBE_TOKEN_FILE, NBO_EDGE_KUBE_CA_FILE).
export async function startFakeKube(ca: TestCa, dir: string, namespace = PRODUCTION_NAMESPACE): Promise<FakeKube> {
  const leaf = await ca.leaf({ ip: ["127.0.0.1"] });
  const caFile = join(dir, "kube-ca.crt");
  const tokenFile = join(dir, "kube-token");
  writeFileSync(caFile, ca.cert);
  writeFileSync(tokenFile, "token-1\n");
  let secretPolls = 0;
  const state = {
    configmap: undefined as string | undefined,
    secrets: [] as FakeKube["secrets"],
    auth: [] as string[],
    paths: [] as string[],
    otherConfigmaps: {} as Record<string, string>,
    polls: 0,
  };
  const server = createHttps({ cert: leaf.cert, key: leaf.key }, (req, res) => {
    state.auth.push(req.headers.authorization ?? "");
    const url = req.url ?? "";
    state.paths.push(url);
    const other = /^\/api\/v1\/namespaces\/([^/]+)\/configmaps\/nbo-edge-routes$/.exec(url);
    if (other && other[1] !== namespace && state.otherConfigmaps[other[1]!] !== undefined) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          metadata: { name: "nbo-edge-routes" },
          data: { "routes.json": state.otherConfigmaps[other[1]!] },
        }),
      );
    }
    if (url === `/api/v1/namespaces/${namespace}/configmaps/nbo-edge-routes`) {
      state.polls++;
      if (state.configmap === undefined)
        return void res.writeHead(404, { "content-type": "application/json" }).end("{}");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({ metadata: { name: "nbo-edge-routes" }, data: { "routes.json": state.configmap } }),
      );
    }
    if (url === `/api/v1/namespaces/${namespace}/secrets?labelSelector=nbo.dev%2Fedge-cert%3Dtrue`) {
      secretPolls++;
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          items: state.secrets.map((s) => ({
            metadata: { name: s.name },
            data: {
              "tls.crt": Buffer.from(s.crt).toString("base64"),
              "tls.key": Buffer.from(s.key).toString("base64"),
            },
          })),
        }),
      );
    }
    res.writeHead(500).end("unexpected " + url);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const kube: FakeKube = {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    caFile,
    tokenFile,
    get configmap() {
      return state.configmap;
    },
    set configmap(v) {
      state.configmap = v;
    },
    get secrets() {
      return state.secrets;
    },
    set secrets(v) {
      state.secrets = v;
    },
    get auth() {
      return state.auth;
    },
    get paths() {
      return state.paths;
    },
    namespace,
    get otherConfigmaps() {
      return state.otherConfigmaps;
    },
    get polls() {
      return state.polls;
    },
    setToken(token) {
      writeFileSync(tokenFile, `${token}\n`);
    },
    async nextPoll() {
      // Two more full rounds: the first may have started before the change.
      const routes = state.polls + 2;
      const secrets = secretPolls + 2;
      await until(
        () => state.polls >= routes && secretPolls >= secrets,
        10_000,
        "the edge to poll the fake Kubernetes API",
      );
    },
    close: () => closeServer(server),
  };
  return kube;
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// adminPut registers a dev-mode target through the admin API.
export async function adminPut(adminUrl: string, host: string, body: unknown): Promise<Reply> {
  return send(`${adminUrl}/targets/${host}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
