// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The objects of the public edge (in the edge cluster) and of a relay (in
// every other cluster that runs projects), all in nbo-edge — a namespace of
// their own, because the edge reads every Secret where it runs and must never
// reach nbo-system (nbo-controller's token). The edge's
// ServiceAccount, Role and RoleBinding come from renderAccess() (they need the
// admin credentials); everything here can be applied with nbo-controller's
// scoped token, which the widened nbo-namespace-guard allows for exactly the
// two LoadBalancer Services nbo-edge and nbo-relay.
import { createHash } from "node:crypto";
import { edgeNamespace, managedByLabels, toYaml, type Y } from "./kube-bootstrap.js";

// RouteTable mirrors packages/edge/src/route-table.ts field for field (the
// edge validates it; re-declared so the control-plane does not import the edge).
export interface RouteTableBackend {
  id?: string;
  url: string;
  weight: number;
  insecureSkipVerify: boolean;
  via?: { url: string; caPem: string; token: string };
}
export interface RouteTable {
  version: 1;
  targets: Record<
    string,
    {
      backends: RouteTableBackend[];
      insights?: { enabled: boolean; inject: boolean; sampleRate: 100 | 50 | 25 | 10 };
      tls?: string;
      redirectHttps?: boolean;
      cloudflare?: boolean;
    }
  >;
  challenges: Record<string, string>;
  // Only present when a host is behind Cloudflare: an older edge rejects the key.
  cloudflareRanges?: string[];
}

// EDGE_VERSION changes when the edge image needs a reinstall to use a new
// control-plane feature (2: Cloudflare hosts and ranges in the route table).
export const EDGE_VERSION = "2";

export const edgeName = "nbo-edge";
export const relayName = "nbo-relay";
export const routesConfigMap = "nbo-edge-routes";
export const routesKey = "routes.json";
export const edgeAdminSecret = "nbo-edge-admin";
export const relayTokenSecret = "nbo-relay";
export const relayTlsSecret = "nbo-relay-tls";
export const edgeCertLabel = "nbo.dev/edge-cert";

const relayTlsDir = "/etc/nbo-relay-tls";
// The edge image runs as USER node.
const nodeUid = 1000;

const meta = (name: string, labels: Record<string, string> = {}): { [k: string]: Y } => ({
  name,
  namespace: edgeNamespace,
  labels: { ...managedByLabels, ...labels },
});

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

function checkImage(image: string): void {
  if (typeof image !== "string" || !/^[^\s]+$/.test(image)) throw new Error("the edge image must be a single non-empty image reference");
}

const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

type Env = { [k: string]: Y };
const envValue = (name: string, value: string): Env => ({ name, value });
const envSecret = (name: string, secret: string, key: string): Env => ({ name, valueFrom: { secretKeyRef: { name: secret, key } } });

// A Deployment that passes Pod Security restricted: non-root, no privilege
// escalation, no capabilities, RuntimeDefault seccomp, no host namespaces.
function deployment(o: {
  name: string;
  image: string;
  pullSecret?: string;
  replicas: number;
  serviceAccount?: string;
  env: Env[];
  ports: { name: string; port: number }[];
  readyPort: number;
  volumes?: { [k: string]: Y }[];
  mounts?: { [k: string]: Y }[];
}): { [k: string]: Y } {
  if (!Number.isInteger(o.replicas) || o.replicas < 1) throw new Error("replicas must be a positive integer");
  const container: { [k: string]: Y } = {
    name: o.name,
    image: o.image,
    env: o.env,
    ports: o.ports.map((p) => ({ name: p.name, containerPort: p.port, protocol: "TCP" })),
    readinessProbe: { tcpSocket: { port: o.readyPort }, periodSeconds: 5 },
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
  };
  if (o.mounts) container.volumeMounts = o.mounts;
  const pod: { [k: string]: Y } = {};
  if (o.serviceAccount) pod.serviceAccountName = o.serviceAccount;
  else pod.automountServiceAccountToken = false;
  pod.securityContext = { runAsNonRoot: true, runAsUser: nodeUid, runAsGroup: nodeUid, seccompProfile: { type: "RuntimeDefault" } };
  if (o.pullSecret) pod.imagePullSecrets = [{ name: o.pullSecret }];
  pod.containers = [container];
  if (o.volumes) pod.volumes = o.volumes;
  const app = { app: o.name };
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: meta(o.name, app),
    spec: { replicas: o.replicas, selector: { matchLabels: app }, template: { metadata: { labels: app }, spec: pod } },
  };
}

// Ingress to the named pods on the given ports from anywhere; any port not
// listed is closed by this policy.
function publicPolicy(name: string, app: string, ports: number[]): { [k: string]: Y } {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(name),
    spec: {
      podSelector: { matchLabels: { app } },
      policyTypes: ["Ingress"],
      ingress: [{ ports: ports.map((port) => ({ protocol: "TCP", port })) }],
    },
  };
}

// parseServiceAnnotations reads NBO_LB_ANNOTATIONS: comma-separated key=value
// annotations for the edge's and relays' load balancers, for clouds that need
// them, such as load-balancer.hetzner.cloud/location=nbg1 on Hetzner.
export function parseServiceAnnotations(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const pair = part.trim();
    if (pair === "") continue;
    const at = pair.indexOf("=");
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (at < 1 || !annotationKey.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`NBO_LB_ANNOTATIONS: ${JSON.stringify(pair)} is not a key=value annotation`);
    }
    out[key] = value;
  }
  return out;
}

const annotationKey = /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?\/)?[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

// serviceMeta is a load balancer's metadata: no annotations key without any.
const serviceMeta = (name: string, annotations: Record<string, string> = {}): { [k: string]: Y } =>
  Object.keys(annotations).length > 0 ? { ...meta(name), annotations } : meta(name);

export function renderEdge(o: { image: string; pullSecret?: string; replicas?: number; serviceAnnotations?: Record<string, string> }): string {
  checkImage(o.image);
  return toYaml([
    deployment({
      name: edgeName,
      image: o.image,
      pullSecret: o.pullSecret,
      replicas: o.replicas ?? 2,
      serviceAccount: edgeName,
      env: [envValue("NBO_EDGE_SOURCE", "kubernetes"), envValue("NBO_EDGE_NAMESPACE", edgeNamespace), envSecret("NBO_EDGE_DRAIN_TOKEN", edgeAdminSecret, "token")],
      ports: [
        { name: "http", port: 8080 },
        { name: "https", port: 8443 },
        { name: "admin", port: 9444 },
      ],
      // The edge answers / with any status (404 for unknown hosts), so readiness is a TCP check.
      readyPort: 8080,
    }),
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: serviceMeta(edgeName, o.serviceAnnotations),
      spec: {
        type: "LoadBalancer",
        // Keeps visitors' addresses visible to the edge.
        externalTrafficPolicy: "Local",
        selector: { app: edgeName },
        ports: [
          { name: "http", port: 80, targetPort: 8080, protocol: "TCP" },
          { name: "https", port: 443, targetPort: 8443, protocol: "TCP" },
        ],
      },
    },
    // 9444 is for the API server's pod proxy (the Speed Insights drain), whose
    // address no policy can name portably. It is not on the Service, and the
    // admin API there is drain-only and token-checked.
    publicPolicy("nbo-edge-public", edgeName, [8080, 8443, 9444]),
  ]);
}

export function renderRelay(o: { image: string; pullSecret?: string; serviceAnnotations?: Record<string, string> }): string {
  checkImage(o.image);
  return toYaml([
    deployment({
      name: relayName,
      image: o.image,
      pullSecret: o.pullSecret,
      replicas: 2,
      env: [
        envValue("NBO_EDGE_MODE", "relay"),
        envSecret("NBO_RELAY_TOKEN", relayTokenSecret, "token"),
        envValue("NBO_RELAY_TLS_CERT", `${relayTlsDir}/tls.crt`),
        envValue("NBO_RELAY_TLS_KEY", `${relayTlsDir}/tls.key`),
      ],
      ports: [{ name: "https", port: 8443 }],
      readyPort: 8443,
      volumes: [{ name: "tls", secret: { secretName: relayTlsSecret } }],
      mounts: [{ name: "tls", mountPath: relayTlsDir, readOnly: true }],
    }),
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: serviceMeta(relayName, o.serviceAnnotations),
      spec: { type: "LoadBalancer", selector: { app: relayName }, ports: [{ name: "https", port: 443, targetPort: 8443, protocol: "TCP" }] },
    },
    publicPolicy("nbo-relay-public", relayName, [8443]),
  ]);
}

function opaqueSecret(name: string, data: Record<string, string>): { [k: string]: Y } {
  return { apiVersion: "v1", kind: "Secret", metadata: meta(name), type: "Opaque", data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) };
}
function tlsSecret(name: string, certPem: string, keyPem: string, labels: Record<string, string> = {}): { [k: string]: Y } {
  return { apiVersion: "v1", kind: "Secret", metadata: meta(name, labels), type: "kubernetes.io/tls", data: { "tls.crt": b64(certPem), "tls.key": b64(keyPem) } };
}

export function renderEdgeAdminSecret(token: string): string {
  if (!token) throw new Error("missing drain token");
  return toYaml([opaqueSecret(edgeAdminSecret, { token })]);
}

export function renderRelaySecrets(token: string, certPem: string, keyPem: string): string {
  if (!token) throw new Error("missing relay token");
  return toYaml([opaqueSecret(relayTokenSecret, { token }), tlsSecret(relayTlsSecret, certPem, keyPem)]);
}

export function certSecretName(host: string): string {
  return "nbo-tls-" + createHash("sha256").update(host).digest("hex").slice(0, 16);
}

export function renderCertSecret(name: string, certPem: string, keyPem: string): string {
  if (name.length > 63 || !dnsLabel.test(name)) throw new Error(`invalid certificate secret name ${JSON.stringify(name)}`);
  return toYaml([tlsSecret(name, certPem, keyPem, { [edgeCertLabel]: "true" })]);
}

export function renderRouteTableConfigMap(table: RouteTable): string {
  return toYaml([{ apiVersion: "v1", kind: "ConfigMap", metadata: meta(routesConfigMap), data: { [routesKey]: JSON.stringify(table) } }]);
}
