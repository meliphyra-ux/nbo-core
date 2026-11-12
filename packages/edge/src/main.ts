// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { serveFetch } from "@nbo/nodehost";
import { proxyRequest } from "@nbo/funcproxy";
import { createRegistry } from "./registry.js";
import { createProxyHandler } from "./proxy.js";
import { createAdminMux } from "./admin.js";
import { createAggregator } from "./insights/aggregator.js";
import { createCertStore, createChallengeStore } from "./cert-store.js";
import { startClusterListeners } from "./cluster-listeners.js";
import { createCloudflareTrust } from "./cloudflare-trust.js";
import { startKubeSource } from "./kube-source.js";
import { createRelayServer } from "./relay-server.js";

export type EdgeMode =
  | { mode: "dev" }
  | { mode: "cluster"; namespace: string; drainToken: string }
  | { mode: "relay"; token: string };

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new Error(`edge: ${name} is required`);
  return v;
}

export function resolveEdgeMode(env: Record<string, string | undefined>): EdgeMode {
  if (env.NBO_EDGE_SOURCE === "kubernetes") {
    const drainToken = required(env, "NBO_EDGE_DRAIN_TOKEN");
    const namespace = env.NBO_EDGE_NAMESPACE?.trim() || "nbo-system";
    return { mode: "cluster", namespace, drainToken };
  }
  if (env.NBO_EDGE_MODE === "relay") return { mode: "relay", token: required(env, "NBO_RELAY_TOKEN") };
  return { mode: "dev" };
}

function splitHostPort(addr: string): { host?: string; port: number } {
  const idx = addr.lastIndexOf(":");
  if (idx === -1) return { port: Number(addr) };
  const host = addr.slice(0, idx);
  return host ? { host, port: Number(addr.slice(idx + 1)) } : { port: Number(addr.slice(idx + 1)) };
}

// resolveEdgeAddrs reads the data-plane and admin-API listen addresses
// — the admin API defaults to loopback-only (the same mitigation
// cmd/control-plane's own final review landed on, applied here from the
// start) — port of main's own addr/adminAddr resolution (main.go lines
// 11-23).
export function resolveEdgeAddrs(env: Record<string, string | undefined>): { dataPort: number; adminHost: string; adminPort: number } {
  const dataAddr = env.NBO_EDGE_ADDR;
  const dataPort = dataAddr ? splitHostPort(dataAddr).port : 9443;

  const adminAddr = env.NBO_EDGE_ADMIN_ADDR;
  const parsedAdmin = adminAddr ? splitHostPort(adminAddr) : undefined;
  const adminHost = parsedAdmin?.host ?? "127.0.0.1";
  const adminPort = parsedAdmin?.port ?? 9444;

  return { dataPort, adminHost, adminPort };
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

// Test-only overrides (the black-box suite in src/__tests__/blackbox runs the
// binary on free ports against a fake Kubernetes API). Unset, every value is
// the production default. The Rust edge honours the same names.
export interface ClusterConfig {
  apiBase: string;
  tokenFile: string;
  caFile: string;
  httpPort: number;
  httpsPort: number;
  adminPort: number;
  intervalMs?: number;
}

function portList(raw: string | undefined, name: string, count: number): number[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const ports = raw.split(",").map((p) => Number(p.trim()));
  if (ports.length !== count || ports.some((p) => !Number.isInteger(p) || p < 0 || p > 65535)) {
    throw new Error(`edge: ${name} must be ${count} comma-separated ports`);
  }
  return ports;
}

export function resolveClusterConfig(env: Record<string, string | undefined>): ClusterConfig {
  const [httpPort, httpsPort, adminPort] = portList(env.NBO_EDGE_CLUSTER_PORTS, "NBO_EDGE_CLUSTER_PORTS", 3) ?? [8080, 8443, 9444];
  const poll = env.NBO_EDGE_KUBE_POLL_MS?.trim();
  return {
    apiBase: env.NBO_EDGE_KUBE_API?.trim() || "https://kubernetes.default.svc",
    tokenFile: env.NBO_EDGE_KUBE_TOKEN_FILE?.trim() || `${SA_DIR}/token`,
    caFile: env.NBO_EDGE_KUBE_CA_FILE?.trim() || `${SA_DIR}/ca.crt`,
    httpPort: httpPort!,
    httpsPort: httpsPort!,
    adminPort: adminPort!,
    ...(poll ? { intervalMs: Number(poll) } : {}),
  };
}

export function resolveRelayPort(env: Record<string, string | undefined>): number {
  return portList(env.NBO_EDGE_RELAY_PORT, "NBO_EDGE_RELAY_PORT", 1)?.[0] ?? 8443;
}

export interface ClusterEdgeDeps {
  apiBase: string;
  token: () => string;
  ca?: string;
  namespace: string;
  drainToken: string;
  httpPort: number;
  httpsPort: number;
  adminPort: number;
  intervalMs?: number;
}

// startClusterEdge waits for the first poll of the cluster API before opening
// any listener, so a new pod never answers 404 or fails a handshake for hosts
// it simply has not loaded yet. `ready` resolves after the first attempt,
// success or not, so an unreachable API cannot hang startup.
export async function startClusterEdge(deps: ClusterEdgeDeps) {
  const registry = createRegistry();
  const certs = createCertStore();
  const challenges = createChallengeStore();
  const insights = createAggregator();
  const cloudflareTrust = createCloudflareTrust();
  const source = startKubeSource({
    apiBase: deps.apiBase,
    token: deps.token,
    ca: deps.ca,
    namespace: deps.namespace,
    intervalMs: deps.intervalMs,
    registry,
    certs,
    challenges,
    cloudflareTrust,
  });
  await source.ready;
  try {
    const listeners = await startClusterListeners({
      registry,
      certs,
      challenges,
      insights,
      httpPort: deps.httpPort,
      httpsPort: deps.httpsPort,
      adminPort: deps.adminPort,
      drainToken: deps.drainToken,
      cloudflareTrust,
    });
    return { ...listeners, stop: () => source.stop() };
  } catch (err) {
    source.stop();
    throw err;
  }
}

async function mainCluster(mode: { namespace: string; drainToken: string }): Promise<void> {
  const config = resolveClusterConfig(process.env);
  const { ports } = await startClusterEdge({
    apiBase: config.apiBase,
    token: () => readFileSync(config.tokenFile, "utf8").trim(),
    ca: readFileSync(config.caFile, "utf8"),
    namespace: mode.namespace,
    drainToken: mode.drainToken,
    httpPort: config.httpPort,
    httpsPort: config.httpsPort,
    adminPort: config.adminPort,
    intervalMs: config.intervalMs,
  });
  console.log(`edge: cluster mode listening on :${ports.http} (http), :${ports.https} (https), :${ports.admin} (admin)`);
}

// resolveRelayUpstreamOverride reads NBO_EDGE_RELAY_UPSTREAM_OVERRIDE
// (host:port), test-only: the relay still validates x-nbo-upstream against
// its pattern, then connects to this address instead of the Service name
// (which does not resolve outside a cluster). Unset in production.
export function resolveRelayUpstreamOverride(env: Record<string, string | undefined>): string | undefined {
  const v = env.NBO_EDGE_RELAY_UPSTREAM_OVERRIDE?.trim();
  if (!v) return undefined;
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(v)) throw new Error("edge: NBO_EDGE_RELAY_UPSTREAM_OVERRIDE must be host:port");
  return v;
}

function mainRelay(mode: { token: string }): void {
  const override = resolveRelayUpstreamOverride(process.env);
  const server = createRelayServer({
    token: mode.token,
    ...(override ? { fetchUpstream: (_url: URL, req: Request) => proxyRequest(req, new URL(`http://${override}`)) } : {}),
    cert: readFileSync(required(process.env, "NBO_RELAY_TLS_CERT")),
    key: readFileSync(required(process.env, "NBO_RELAY_TLS_KEY")),
  });
  const port = resolveRelayPort(process.env);
  server.listen(port, () => console.log(`edge: relay listening on :${port}`));
}

function mainDev(): void {
  const registry = createRegistry();
  const insights = createAggregator();
  const { dataPort, adminHost, adminPort } = resolveEdgeAddrs(process.env);

  serveFetch(createProxyHandler(registry, { insights }), { port: dataPort }, (p) => {
    console.log(`edge: data-plane listening on :${p}`);
  });
  serveFetch(createAdminMux(registry, { insights }), { port: adminPort, host: adminHost }, (p) => {
    console.log(`edge: admin API listening on ${adminHost}:${p}`);
  });
}

async function main(): Promise<void> {
  const mode = resolveEdgeMode(process.env);
  if (mode.mode === "cluster") await mainCluster(mode);
  else if (mode.mode === "relay") mainRelay(mode);
  else mainDev();
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
