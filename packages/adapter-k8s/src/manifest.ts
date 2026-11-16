// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { kubectlArgs, runWith, type ToolContext } from "./run.js";

export type { ToolContext, CommandRunner } from "./run.js";

export interface DeploySpec {
  appName: string;
  imageTag: string;
  host: string;
  contentID: string;
  // namespace, when set, is written into every object's metadata
  // (production: the project's nbo-p-* namespace). Unset keeps the
  // dev output: no namespace line, objects land in kubectl's default.
  namespace?: string;
  // ingress defaults to true (dev: kind + ingress-nginx + the
  // selfsigned issuer). false drops the Ingress and serves the app's
  // Service on 8080 — production reaches it in-cluster from the edge in
  // nbo-edge (or nbo-system), never through an Ingress NBO does not own.
  ingress?: boolean;
  // pullSecret names a dockerconfigjson Secret in the namespace.
  pullSecret?: string;
  // envFingerprint, when set, is the project's variable-set fingerprint,
  // written as nbo.dev/env-fingerprint on the Deployment (read back by
  // liveContentID) and on its pods (so a variable change rolls them).
  envFingerprint?: string;
  // envSecret, when set, names the Secret (renderEnvSecret) whose keys
  // become the container's environment variables, via envFrom. The
  // reference is optional: an old pod restarting after a failed rollout
  // that deleted or replaced the Secret must not stick in
  // CreateContainerConfigError.
  envSecret?: string;
}

export interface FunctionDeploySpec {
  appName: string;
  functionName: string;
  imageTag: string;
  namespace?: string;
  pullSecret?: string;
  // configHash, when set, is written as the Deployment's
  // nbo.dev/fn-config annotation (functionConfigHash of this same spec),
  // so a later deploy can tell the live objects match what it would
  // apply.
  configHash?: string;
  // envFingerprint: as DeploySpec's. It is part of the rendered
  // manifests, so part of functionConfigHash (absent: hash unchanged).
  envFingerprint?: string;
  // envSecret: as DeploySpec's.
  envSecret?: string;
}

// kubeName keeps a generated object name (and the label value that
// repeats it) within Kubernetes' 63-character limit: a name of 63 or
// fewer is returned unchanged (existing objects are never renamed); a
// longer one becomes its first 54 characters, trailing dashes dropped,
// a dash and the first 8 hex digits of the sha256 of the full name —
// stable across deploys and distinct for distinct long names. App names
// themselves stay well under the limit (controlplane deployAppName: at
// most 50); the suffixed names built from them can pass it.
export function kubeName(name: string): string {
  if (name.length <= 63) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, 54).replace(/-+$/, "")}-${hash}`;
}

// functionObjectName is the name of a function's Deployment and Service
// (and its pods' app label): "<app>-fn-<function>", shortened by
// kubeName. The function's in-cluster URL is built from it too.
export function functionObjectName(appName: string, functionName: string): string {
  return kubeName(`${appName}-fn-${functionName}`);
}

// isrcacheObjectName is the name of an app's ISR cache Deployment and
// Service (and its pods' app label): "<app>-isr", shortened by kubeName.
// The cache's in-cluster URL is built from it too.
export function isrcacheObjectName(appName: string): string {
  return kubeName(`${appName}-isr`);
}

export interface IsrcacheDeploySpec {
  appName: string;
  imageTag: string;
  namespace?: string;
  pullSecret?: string;
}

// isrcacheMaxBytes caps the cache's memory use (NBO_ISRCACHE_MAX_BYTES),
// below the container's 256 MiB limit.
const isrcacheMaxBytes = 100663296;

// renderIsrcacheManifests renders an app's ISR cache: one replica of
// `nbo isrcache` on 8080, no service-account token, no user variables
// (the cache never runs user code), small requests and a 256 MiB memory
// limit, ready once GET /healthz answers. Pods carry nbo.dev/role:
// isrcache and nbo.dev/app, which the app's <app>-to-isrcache
// NetworkPolicy selects.
export function renderIsrcacheManifests(spec: IsrcacheDeploySpec): string {
  const name = isrcacheObjectName(spec.appName);
  const ns = namespaceLine(spec.namespace);
  const labels = (indent: string) =>
    `${indent}app: ${name}\n${indent}nbo.dev/role: isrcache\n${indent}nbo.dev/app: ${spec.appName}`;
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}${ns}
  labels:
${labels("    ")}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
${labels("        ")}
    spec:
      automountServiceAccountToken: false${pullSecretLines(spec.pullSecret)}
      containers:
      - name: nbo-isrcache
        image: ${spec.imageTag}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 8080
        env:
        - name: NBO_ISRCACHE_MAX_BYTES
          value: "${isrcacheMaxBytes}"
        resources:
          requests:
            cpu: 10m
            memory: 64Mi
          limits:
            memory: 256Mi
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          periodSeconds: 2
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
          failureThreshold: 3
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          runAsGroup: 1000
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: [ALL]
          seccompProfile:
            type: RuntimeDefault
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}${ns}
  labels:
${labels("    ")}
spec:
  selector:
    app: ${name}
  ports:
  - port: 8080
    targetPort: 8080
`;
}

function envFromLines(secret: string | undefined): string {
  return secret
    ? `
        envFrom:
        - secretRef:
            name: ${secret}
            optional: true`
    : "";
}

function fingerprintLine(fp: string | undefined, indent: string): string {
  return fp ? `\n${indent}nbo.dev/env-fingerprint: "${fp}"` : "";
}

function namespaceLine(namespace: string | undefined): string {
  return namespace ? `\n  namespace: ${namespace}` : "";
}

function pullSecretLines(pullSecret: string | undefined): string {
  return pullSecret ? `\n      imagePullSecrets:\n      - name: ${pullSecret}` : "";
}

// renderManifests — port of RenderManifests, now a plain template
// literal built from deployment.yaml.tmpl's own exact text (no
// templating library). Pods never automount a service-account token:
// NBO's workloads never talk to the Kubernetes API.
export function renderManifests(spec: DeploySpec): string {
  const ingress = spec.ingress ?? true;
  const servicePort = ingress ? 80 : 8080;
  const ns = namespaceLine(spec.namespace);
  const base = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${spec.appName}${ns}
  annotations:
    nbo.dev/content-id: "${spec.contentID}"${fingerprintLine(spec.envFingerprint, "    ")}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${spec.appName}
  template:
    metadata:
      labels:
        app: ${spec.appName}
      annotations:
        nbo.dev/content-id: "${spec.contentID}"${fingerprintLine(spec.envFingerprint, "        ")}
    spec:
      automountServiceAccountToken: false${pullSecretLines(spec.pullSecret)}
      containers:
      - name: nbo-server
        image: ${spec.imageTag}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 8080
        readinessProbe:
          tcpSocket:
            port: 8080
          periodSeconds: 2
        lifecycle:
          preStop:
            sleep:
              seconds: 5${envFromLines(spec.envSecret)}
---
apiVersion: v1
kind: Service
metadata:
  name: ${spec.appName}${ns}
spec:
  selector:
    app: ${spec.appName}
  ports:
  - port: ${servicePort}
    targetPort: 8080
`;
  if (!ingress) return base;
  return `${base}---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${spec.appName}${ns}
  annotations:
    cert-manager.io/cluster-issuer: selfsigned-issuer
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - ${spec.host}
    secretName: ${kubeName(`${spec.appName}-tls`)}
  rules:
  - host: ${spec.host}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${spec.appName}
            port:
              number: 80
`;
}

// renderFunctionManifests renders only a Deployment and Service for a
// function — no Ingress, since a function is reached only from the
// app's own router, in-cluster, over its Service DNS name (never
// directly internet-facing, per docs/context.md's "own the edge"
// principle), and no TLS annotation for the same reason — port of
// RenderFunctionManifests, built from function-deployment.yaml.tmpl's
// own exact text. Function pods carry nbo.dev/role: function (what
// renderNetworkPolicies admits the app to) and nbo.dev/app, so one
// app's policy never opens another app's functions in the same
// namespace.
export function renderFunctionManifests(spec: FunctionDeploySpec): string {
  const name = functionObjectName(spec.appName, spec.functionName);
  const ns = namespaceLine(spec.namespace);
  const annotations =
    (spec.configHash ? `\n    nbo.dev/fn-config: "${spec.configHash}"` : "") +
    fingerprintLine(spec.envFingerprint, "    ");
  const annotation = annotations ? `\n  annotations:${annotations}` : "";
  const podAnnotation = spec.envFingerprint
    ? `\n      annotations:${fingerprintLine(spec.envFingerprint, "        ")}`
    : "";
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}${annotation}${ns}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
        nbo.dev/role: function
        nbo.dev/app: ${spec.appName}${podAnnotation}
    spec:
      automountServiceAccountToken: false${pullSecretLines(spec.pullSecret)}
      containers:
      - name: nbo-function
        image: ${spec.imageTag}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 8080${envFromLines(spec.envSecret)}
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}${ns}
spec:
  selector:
    app: ${name}
  ports:
  - port: 8080
    targetPort: 8080
`;
}

// renderNetworkPolicies isolates one app in a project namespace:
// ingress is denied by default; the edge may reach the app's pods (the
// public edge and relay from namespace nbo-edge, nbo-system for what ran
// there before; projects deployed earlier get this on edge install and relay
// enable, see refreshNetworkPolicies in the control-plane);
// the app's pods may reach its own functions and its own ISR cache
// (never the functions: they run the user's code).
// Egress stays open (apps fetch remote images, call APIs).
export function renderNetworkPolicies(namespace: string, appName: string): string {
  return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: nbo-default-deny-ingress
  namespace: ${namespace}
spec:
  podSelector: {}
  policyTypes: [Ingress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${kubeName(`${appName}-from-edge`)}
  namespace: ${namespace}
spec:
  podSelector:
    matchLabels:
      app: ${appName}
  policyTypes: [Ingress]
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: nbo-system
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: nbo-edge
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${kubeName(`${appName}-to-functions`)}
  namespace: ${namespace}
spec:
  podSelector:
    matchLabels:
      nbo.dev/role: function
      nbo.dev/app: ${appName}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: ${appName}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${kubeName(`${appName}-to-isrcache`)}
  namespace: ${namespace}
spec:
  podSelector:
    matchLabels:
      nbo.dev/role: isrcache
      nbo.dev/app: ${appName}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: ${appName}
`;
}

// renderPullSecret renders a kubernetes.io/dockerconfigjson Secret.
// The credential only ever travels inside this YAML, which callers
// apply over stdin — never as a command-line argument.
export function renderPullSecret(
  namespace: string,
  name: string,
  server: string,
  username: string,
  password: string,
): string {
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const config = JSON.stringify({ auths: { [server]: { username, password, auth } } });
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: ${Buffer.from(config).toString("base64")}
`;
}

// renderEnvSecret renders the Opaque Secret holding every one of an
// app's user variables (plain and secret alike), base64 so any byte
// survives. It is the complete set: applying it removes keys it lacks.
// Callers apply it over stdin, never as an argument.
export function renderEnvSecret(name: string, vars: Record<string, string>, namespace?: string): string {
  // Keys are quoted: YAML 1.1 reads bare YES/NO/ON/OFF/NULL/Y/N as
  // booleans or null, not as the variable's name.
  const entries = Object.entries(vars).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${Buffer.from(v, "utf8").toString("base64")}\n`,
  );
  const data = entries.length > 0 ? `data:\n${entries.join("")}` : "data: {}\n";
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}${namespaceLine(namespace)}
type: Opaque
${data}`;
}

// deleteEnvSecret removes the environment Secret, if there is one.
export async function deleteEnvSecret(name: string, ctx?: ToolContext): Promise<void> {
  await runWith(ctx, "kubectl", kubectlArgs(ctx, ["delete", "secret", name, "--ignore-not-found"]));
}

// isrcacheDeleteArgs: the kubectl arguments deleting an app's ISR cache
// Deployment and Service. They match by the cache's exact name AND its
// labels (nbo.dev/role=isrcache, nbo.dev/app=<app>), so an object of
// another app that happens to share the name (a function
// "<other>-fn-x-isr", another environment's app) is never touched. Only
// the cache's own metadata carries these labels.
export function isrcacheDeleteArgs(appName: string): string[] {
  return [
    "delete",
    "deployment,service",
    "-l",
    `nbo.dev/role=isrcache,nbo.dev/app=${appName}`,
    "--field-selector",
    `metadata.name=${isrcacheObjectName(appName)}`,
    "--ignore-not-found",
  ];
}

// deleteIsrcache removes an app's ISR cache Deployment and Service, if
// there are any (its NetworkPolicy stays with the app's others).
export async function deleteIsrcache(appName: string, ctx?: ToolContext): Promise<void> {
  await runWith(ctx, "kubectl", kubectlArgs(ctx, isrcacheDeleteArgs(appName)));
}

const isrcacheOwnerJSONPath =
  'jsonpath={range .items[*]}{.kind}{"\\t"}{.metadata.name}{"\\t"}{.metadata.labels.nbo\\.dev/role}{"\\t"}{.metadata.labels.nbo\\.dev/app}{"\\n"}{end}';

// isrcacheNameTaken reads the live Deployment and Service named like the
// app's ISR cache and returns "<Kind> <name>" for the first one that is
// not this app's cache (no nbo.dev/role=isrcache and nbo.dev/app=<app>
// on its metadata), or undefined when the name is free or already this
// app's cache. A cache deploy refuses to apply over such an object.
// Runners merge stderr into the output: only lines naming the cache's
// exact name count. A failing read throws.
export async function isrcacheNameTaken(appName: string, ctx?: ToolContext): Promise<string | undefined> {
  const name = isrcacheObjectName(appName);
  const out = await runWith(
    ctx,
    "kubectl",
    kubectlArgs(ctx, ["get", "deployment,service", name, "--ignore-not-found", "-o", isrcacheOwnerJSONPath]),
  );
  for (const raw of out.split("\n")) {
    const [kind, objName, role = "", app = ""] = raw.replace(/\r$/, "").split("\t");
    if (!kind || objName !== name) continue;
    if (role !== "isrcache" || app !== appName) return `${kind} ${name}`;
  }
  return undefined;
}

export async function apply(manifestYAML: string, ctx?: ToolContext): Promise<void> {
  await runWith(ctx, "kubectl", kubectlArgs(ctx, ["apply", "-f", "-"]), manifestYAML);
}

export async function waitForRollout(appName: string, ctx?: ToolContext): Promise<void> {
  await runWith(ctx, "kubectl", kubectlArgs(ctx, ["rollout", "status", `deployment/${appName}`, "--timeout=120s"]));
}

// functionConfigHash fingerprints everything a function deploy applies
// besides the image's content: the rendered Deployment + Service (image
// reference, labels, token automount, pull secret, namespace, ports).
// Any configHash already on spec is ignored, so the hash can be written
// into the very manifest it describes.
export function functionConfigHash(spec: FunctionDeploySpec): string {
  return createHash("sha256")
    .update(renderFunctionManifests({ ...spec, configHash: undefined }))
    .digest("hex")
    .slice(0, 24);
}

export interface LiveFunctionState {
  image: string;
  // The nbo.dev/fn-config annotation ("" when absent).
  config: string;
  // The latest generation is observed and fully rolled out: every
  // desired replica is updated and available. False while a rollout is
  // in progress or after one timed out with the old ReplicaSet serving.
  healthy: boolean;
}

const fnStateJSONPath = [
  "{.spec.template.spec.containers[0].image}",
  "{.metadata.annotations.nbo\\.dev/fn-config}",
  "{.metadata.generation}",
  "{.status.observedGeneration}",
  "{.spec.replicas}",
  "{.status.updatedReplicas}",
  "{.status.availableReplicas}",
].join('{"\\t"}');

// liveFunctionState reads a function Deployment's image, deploy-config
// annotation and rollout health in one kubectl call, or undefined when
// it can't be read (no such Deployment yet, an unreachable cluster,
// output without a state line). Callers use it only to skip work, so
// any failure means "not known to be live" — the normal deploy then
// runs and reports real errors itself. Runners merge stderr into the
// output: only a line of exactly seven tab-separated fields counts.
export async function liveFunctionState(
  deploymentName: string,
  ctx?: ToolContext,
): Promise<LiveFunctionState | undefined> {
  let out: string;
  try {
    out = await runWith(
      ctx,
      "kubectl",
      kubectlArgs(ctx, ["get", "deployment", deploymentName, "-o", `jsonpath=${fnStateJSONPath}`]),
    );
  } catch {
    return undefined;
  }
  for (const raw of out.split("\n").reverse()) {
    const f = raw.replace(/\r$/, "").split("\t");
    if (f.length !== 7 || !/^\S+$/.test(f[0]!)) continue;
    const [image, config, generation, observed, replicas, updated, available] = f as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const n = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);
    const want = n(replicas);
    const healthy = n(observed) >= n(generation) && want > 0 && n(updated) === want && n(available) === want;
    return { image, config, healthy };
  }
  return undefined;
}

const contentIDLine = /^sha256:[0-9a-f]+$/;

// liveContentID reads the nbo.dev/content-id annotation off the named
// Deployment. ok is false if the Deployment does not exist yet (a
// brand new app being deployed for the first time), which the caller
// must treat as "not live", not as an error — port of LiveContentID
// (manifest.go lines 89-101). Runners merge stderr into the output, so
// a kubectl warning line can precede the value: only a line in the
// sha256 form counts as the id. The same call reads the
// nbo.dev/env-fingerprint annotation, tab-separated after the id;
// fingerprint is omitted when that annotation is absent.
export async function liveContentID(
  appName: string,
  ctx?: ToolContext,
): Promise<{ id: string; ok: boolean; fingerprint?: string }> {
  try {
    const jsonpath =
      'jsonpath={.metadata.annotations.nbo\\.dev/content-id}{"\\t"}{.metadata.annotations.nbo\\.dev/env-fingerprint}';
    const out = await runWith(ctx, "kubectl", kubectlArgs(ctx, ["get", "deployment", appName, "-o", jsonpath]));
    const line = out
      .split(/\r?\n/)
      .map((l) => l.split("\t").map((f) => f.trim()))
      .filter((f) => contentIDLine.test(f[0]!))
      .at(-1);
    if (!line) return { id: "", ok: false };
    const fingerprint = line[1];
    return fingerprint ? { id: line[0]!, ok: true, fingerprint } : { id: line[0]!, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("NotFound")) {
      return { id: "", ok: false };
    }
    throw err;
  }
}
