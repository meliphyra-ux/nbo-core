// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { redact, withGoogleCredentials } from "@nbo/deploy";
import type { KubeConnectRequest, KubeSource } from "./kube-connect.js";
import { ErrInvalid } from "./errors.js";
import type { Router } from "./router.js";
import type { Store } from "./store.js";
import type { V2 } from "./v2.js";
import { isRecord, writeJSON, writeError, errorMessage } from "./handlers.js";
import { domainMappingRegions, listCloudRunRegions } from "./regions.js";

// An ErrInvalid, so other routes reusing these parsers answer 400 too.
class BadRequest extends ErrInvalid {}

// secretsIn lists the secret-bearing strings of a request or a stored
// credential, including a service-account key's private_key and its
// JSON-escaped form, for the routes' defensive scrub of error text.
export function secretsIn(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  for (const k of ["keyJson", "deployerKey", "pullerKey", "kubeconfig", "token", "caData", "registryPassword"]) add(body[k]);
  for (const k of ["keyJson", "deployerKey", "pullerKey"]) {
    const raw = body[k];
    if (typeof raw !== "string") continue;
    try {
      const pk = (JSON.parse(raw) as { private_key?: unknown }).private_key;
      if (typeof pk === "string" && pk) out.push(pk, JSON.stringify(pk).slice(1, -1));
    } catch {
      // not JSON
    }
  }
  add(JSON.stringify(body.keyJson ?? "").slice(1, -1));
  if (isRecord(body.source)) out.push(...secretsIn(body.source));
  return out;
}

function scrubbed(err: unknown, secrets: string[]): string {
  return redact(errorMessage(err), secrets.filter(Boolean));
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BadRequest("the request body must be JSON");
  }
  if (!isRecord(parsed)) throw new BadRequest("the request body must be a JSON object");
  return parsed;
}

function str(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || v.trim() === "") throw new BadRequest(`${field} is required`);
  return v;
}

// parseKubeSource validates cluster credentials: a connect's source, or the
// admin credentials an edge install or a setup update uses once. field
// names the body field in error messages.
export function parseKubeSource(source: unknown, field: string): KubeSource {
  if (!isRecord(source)) throw new BadRequest(`${field} is required`);
  let parsedSource: KubeSource;
  switch (source.kind) {
    case "machine":
      parsedSource = { kind: "machine", context: str(source, "context") };
      break;
    case "kubeconfig":
      parsedSource = { kind: "kubeconfig", kubeconfig: str(source, "kubeconfig") };
      if (typeof source.context === "string" && source.context) parsedSource.context = source.context;
      break;
    case "token":
      parsedSource = { kind: "token", server: str(source, "server"), caData: str(source, "caData"), token: str(source, "token") };
      break;
    default:
      throw new BadRequest(`${field}.kind must be "machine", "kubeconfig" or "token"`);
  }
  return parsedSource;
}

// parseKubeRequest validates a connect (name required) or a replace of an
// existing connection (name optional; it must not change).
function parseKubeRequest(body: Record<string, unknown>, existing?: { id: string; name: string }): KubeConnectRequest {
  const parsedSource = parseKubeSource(body.source, "source");
  const registry = body.registry;
  if (!isRecord(registry)) throw new BadRequest("registry is required");
  let parsedRegistry: KubeConnectRequest["registry"];
  if (registry.kind === "artifact-registry") parsedRegistry = { kind: "artifact-registry" };
  else if (registry.kind === "custom") parsedRegistry = { kind: "custom", server: str(registry, "server"), username: str(registry, "username") };
  else throw new BadRequest('registry.kind must be "artifact-registry" or "custom"');
  // A cluster keeps the name it was connected with (environment names derive from it).
  if (existing && body.name !== undefined && body.name !== "" && body.name !== existing.name) throw new BadRequest("a cluster's name cannot change after it is connected");
  const name = existing ? existing.name : str(body, "name");
  const req: KubeConnectRequest = { source: parsedSource, name, registry: parsedRegistry };
  if (existing) req.id = existing.id;
  if (typeof body.registryPassword === "string" && body.registryPassword) req.registryPassword = body.registryPassword;
  return req;
}

// storedSecrets: Google's keys, or (given a cluster id) that cluster's.
function storedSecrets(store: Store, clusterId?: string): string[] {
  try {
    return secretsIn(clusterId === undefined ? store.getGoogleSecrets() : store.getKubernetesSecrets(clusterId));
  } catch {
    return [];
  }
}

const stillRunning = (where: string, names: string): string =>
  `projects still run on ${where}: ${names} — archive those environments first. Archiving does not stop running sites: to take them down, delete the project with "also delete what it runs" while ${where} is still connected.`;

// Connection routes never return secrets: they only ever serialise the
// connection objects, and connector errors arrive already redacted.
export function registerConnectionRoutes(router: Router, store: Store, v2: V2): void {
  const fail = (err: unknown, secrets: string[] = []): Response => writeError(400, scrubbed(err, secrets));

  router.handle("GET", "/system/connections", async () => {
    const google = store.getGoogleConnection();
    const kubernetes = store.listKubernetesConnections();
    return writeJSON({ mode: v2.mode, google, kubernetes, setupComplete: v2.mode === "dev" || google !== null || kubernetes.length > 0 }, 200);
  });

  router.handle("GET", "/system/connections/detect", async () => {
    try {
      const [google, kubernetes] = await Promise.all([v2.googleConnect.detect(), v2.kubeConnect.detect()]);
      return writeJSON({ google, kubernetes }, 200);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("GET", "/system/connections/plan", async (request) => {
    try {
      const q = new URL(request.url).searchParams;
      const out: { google: string[]; kubernetes: string[] } = { google: [], kubernetes: [] };
      const g = q.get("google");
      if (g) {
        const [source, project, region] = g.split(",");
        if ((source !== "machine" && source !== "key") || !project || !region) throw new BadRequest("google must be <machine|key>,<project>,<region>");
        out.google = v2.googleConnect.plan({ source, project, region });
      }
      if (q.get("kubernetes")) out.kubernetes = v2.kubeConnect.plan();
      return writeJSON(out, 200);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/system/connections/google", async (request) => {
    let secrets: string[] = [];
    try {
      const body = await readBody(request);
      secrets = secretsIn(body);
      const region = str(body, "region");
      if (body.source === "machine") return writeJSON(await v2.googleConnect.connectFromMachine({ project: str(body, "project"), region }), 201);
      if (body.source === "key") return writeJSON(await v2.googleConnect.connectWithKey({ keyJson: str(body, "keyJson"), region }), 201);
      throw new BadRequest('source must be "machine" or "key"');
    } catch (err) {
      return fail(err, secrets);
    }
  });

  router.handle("POST", "/system/connections/kubernetes", async (request) => {
    let secrets: string[] = [];
    try {
      const body = await readBody(request);
      secrets = secretsIn(body);
      const req = parseKubeRequest(body);
      return writeJSON(await v2.kubeConnect.connect(req), 201);
    } catch (err) {
      return fail(err, secrets);
    }
  });

  router.handle("PUT", "/system/connections/kubernetes/{id}", async (request, params) => {
    const existing = store.getKubernetesConnection(params.id!);
    if (!existing) return writeError(404, "that Kubernetes cluster is not connected");
    let secrets: string[] = [];
    try {
      const body = await readBody(request);
      secrets = secretsIn(body);
      return writeJSON(await v2.kubeConnect.connect(parseKubeRequest(body, existing)), 200);
    } catch (err) {
      return fail(err, [...secrets, ...storedSecrets(store, existing.id)]);
    }
  });

  router.handle("POST", "/system/connections/kubernetes/{id}/test", async (_request, params) => {
    const id = params.id!;
    if (!store.getKubernetesConnection(id)) return writeError(404, "that Kubernetes cluster is not connected");
    try {
      return writeJSON(await v2.kubeConnect.test(id), 200);
    } catch (err) {
      return fail(err, storedSecrets(store, id));
    }
  });

  router.handle("DELETE", "/system/connections/kubernetes/{id}", async (_request, params) => {
    const conn = store.getKubernetesConnection(params.id!);
    if (!conn) return writeError(404, "that Kubernetes cluster is not connected");
    try {
      const using = store.environmentsUsingCluster(conn.id);
      if (using.length > 0) return writeError(409, stillRunning(conn.name, [...new Set(using.map((u) => u.projectName))].join(", ")));
      // The edge runs on this cluster: custom domains it serves would go dark.
      if (store.getServerSettings().edgeClusterId === conn.id) {
        const hosts = store.listDomains().filter((d) => d.kind === "custom" && d.serving === "edge").map((d) => d.host);
        if (hosts.length > 0) return writeError(409, `The public edge runs on ${conn.name} and serves these domains: ${hosts.join(", ")}. Remove them first.`);
      }
      store.deleteKubernetesConnection(conn.id);
      return new Response(null, { status: 204 });
    } catch (err) {
      return writeError(500, scrubbed(err, storedSecrets(store, conn.id)));
    }
  });

  // Google keeps one connection; Kubernetes clusters are tested and
  // removed by id above.
  router.handle("POST", "/system/connections/{kind}/test", async (_request, params) => {
    if (params.kind !== "google") return writeError(404, "unknown connection kind");
    if (store.getGoogleConnection() === null) return writeError(404, "Cloud Run is not connected");
    try {
      return writeJSON(await v2.googleConnect.test(), 200);
    } catch (err) {
      return fail(err, storedSecrets(store));
    }
  });

  router.handle("DELETE", "/system/connections/{kind}", async (_request, params) => {
    if (params.kind !== "google") return writeError(404, "unknown connection kind");
    try {
      const using = store.environmentsUsing("google");
      if (using.length > 0) return writeError(409, stillRunning("Cloud Run", [...new Set(using.map((u) => u.projectName))].join(", ")));
      const ar = store.listKubernetesConnections().filter((c) => c.registry.kind === "artifact-registry");
      if (ar.length === 1) {
        return writeError(409, `Kubernetes cluster ${ar[0]!.name} pushes images to Google Artifact Registry — replace its registry or disconnect it first`);
      }
      if (ar.length > 1) {
        return writeError(409, `Kubernetes clusters ${ar.map((c) => c.name).join(", ")} push images to Google Artifact Registry — replace their registry or disconnect them first`);
      }
      const mapped = store.listDomains().filter((d) => d.serving === "cloudrun" || d.mappingKept).map((d) => d.host);
      if (mapped.length > 0) return writeError(409, `Google serves or still maps these domains: ${mapped.join(", ")}. Remove them (or move them to the edge) first.`);
      store.deleteConnection("google");
      return new Response(null, { status: 204 });
    } catch (err) {
      return writeError(500, scrubbed(err, storedSecrets(store)));
    }
  });

  // No credentials needed: a static list copied from Google's docs.
  router.handle("GET", "/system/regions/domain-mapping", async () => writeJSON(domainMappingRegions, 200));

  router.handle("GET", "/system/regions", async () => {
    const conn = store.getGoogleConnection();
    if (!conn) return writeError(409, "Cloud Run is not connected");
    try {
      const secrets = store.getGoogleSecrets();
      const regions = await withGoogleCredentials(secrets.deployerKey, conn.region, v2.run, (ctx) => listCloudRunRegions(v2.run, ctx, conn.project));
      return writeJSON(regions, 200);
    } catch (err) {
      return writeError(502, scrubbed(err, storedSecrets(store)));
    }
  });
}
