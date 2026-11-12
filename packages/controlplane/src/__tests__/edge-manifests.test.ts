// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";
import {
  certSecretName,
  parseServiceAnnotations,
  renderCertSecret,
  renderEdge,
  renderEdgeAdminSecret,
  renderRelay,
  renderRelaySecrets,
  renderRouteTableConfigMap,
  type RouteTable,
} from "../edge-manifests.js";

type Obj = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string> }; [k: string]: unknown };
type Container = {
  name: string;
  image: string;
  env: { name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string } } }[];
  ports: { containerPort: number }[];
  readinessProbe?: { tcpSocket?: { port: number } };
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
  securityContext: Record<string, unknown>;
};
type PodSpec = {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  imagePullSecrets?: { name: string }[];
  securityContext: Record<string, unknown>;
  containers: Container[];
  volumes?: { name: string; secret?: { secretName: string } }[];
};
type Deployment = Obj & {
  spec: { replicas: number; selector: { matchLabels: Record<string, string> }; template: { metadata: { labels: Record<string, string> }; spec: PodSpec } };
};
type Service = Obj & {
  spec: { type: string; externalTrafficPolicy?: string; selector: Record<string, string>; ports: { port: number; targetPort: number }[]; externalIPs?: unknown };
};
type NetPol = Obj & {
  spec: { podSelector: { matchLabels: Record<string, string> }; policyTypes: string[]; ingress: { from?: unknown; ports: { port: number; protocol: string }[] }[] };
};
type Secret = Obj & { type: string; data: Record<string, string> };

function docs(text: string): Obj[] {
  return parseAllDocuments(text).map((d) => {
    expect(d.errors).toEqual([]);
    return d.toJSON() as Obj;
  });
}
function find<T extends Obj>(objs: Obj[], kind: string, name: string): T {
  const o = objs.find((x) => x.kind === kind && x.metadata.name === name);
  if (!o) throw new Error(`missing ${kind}/${name}`);
  return o as T;
}
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

function expectHardenedPod(pod: PodSpec): void {
  expect(pod.hostNetwork).toBeUndefined();
  expect(pod.hostPID).toBeUndefined();
  expect(pod.hostIPC).toBeUndefined();
  expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: "RuntimeDefault" } });
  for (const c of pod.containers) {
    expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
    expect(c.securityContext.privileged).toBeUndefined();
    for (const p of c.ports) expect(p.containerPort).toBeGreaterThan(1024);
  }
}

describe("edge manifests", () => {
  it("renders the edge Deployment, its LoadBalancer Service and a public-ports NetworkPolicy in nbo-edge", () => {
    const objs = docs(renderEdge({ image: "registry.example.com/nbo/edge:1.0.0-abc" }));
    for (const o of objs) expect(o.metadata.namespace).toBe("nbo-edge");
    const dep = find<Deployment>(objs, "Deployment", "nbo-edge");
    expect(dep.spec.replicas).toBe(2);
    expect(dep.spec.selector.matchLabels).toEqual({ app: "nbo-edge" });
    expect(dep.spec.template.metadata.labels.app).toBe("nbo-edge");
    const pod = dep.spec.template.spec;
    expect(pod.serviceAccountName).toBe("nbo-edge");
    expect(pod.imagePullSecrets).toBeUndefined();
    expectHardenedPod(pod);
    const c = pod.containers[0]!;
    expect(c.image).toBe("registry.example.com/nbo/edge:1.0.0-abc");
    expect(c.env).toEqual([
      { name: "NBO_EDGE_SOURCE", value: "kubernetes" },
      { name: "NBO_EDGE_NAMESPACE", value: "nbo-edge" },
      { name: "NBO_EDGE_DRAIN_TOKEN", valueFrom: { secretKeyRef: { name: "nbo-edge-admin", key: "token" } } },
    ]);
    expect(c.ports.map((p) => p.containerPort)).toEqual([8080, 8443, 9444]);
    expect(c.readinessProbe?.tcpSocket?.port).toBe(8080);

    const svc = find<Service>(objs, "Service", "nbo-edge");
    expect(svc.spec.type).toBe("LoadBalancer");
    expect(svc.spec.externalTrafficPolicy).toBe("Local");
    expect(svc.spec.externalIPs).toBeUndefined();
    expect(svc.spec.selector).toEqual({ app: "nbo-edge" });
    expect(svc.spec.ports.map((p) => [p.port, p.targetPort])).toEqual([
      [80, 8080],
      [443, 8443],
    ]);

    const np = find<NetPol>(objs, "NetworkPolicy", "nbo-edge-public");
    expect(np.spec.podSelector).toEqual({ matchLabels: { app: "nbo-edge" } });
    expect(np.spec.policyTypes).toEqual(["Ingress"]);
    expect(np.spec.ingress).toEqual([
      {
        ports: [
          { protocol: "TCP", port: 8080 },
          { protocol: "TCP", port: 8443 },
          // The API server's pod proxy, for the Speed Insights drain.
          { protocol: "TCP", port: 9444 },
        ],
      },
    ]);
  });

  it("passes the pull secret and replica count through", () => {
    const dep = find<Deployment>(docs(renderEdge({ image: "img:1", pullSecret: "nbo-pull", replicas: 3 })), "Deployment", "nbo-edge");
    expect(dep.spec.replicas).toBe(3);
    expect(dep.spec.template.spec.imagePullSecrets).toEqual([{ name: "nbo-pull" }]);
  });

  it("refuses an empty or multi-word image", () => {
    expect(() => renderEdge({ image: "" })).toThrow(/image/);
    expect(() => renderEdge({ image: "a b" })).toThrow(/image/);
    expect(() => renderRelay({ image: "x\ny: 1" })).toThrow(/image/);
  });

  it("renders the relay Deployment with its token and mounted TLS, a 443 LoadBalancer and a 8443 NetworkPolicy", () => {
    const objs = docs(renderRelay({ image: "img:2", pullSecret: "nbo-pull" }));
    for (const o of objs) expect(o.metadata.namespace).toBe("nbo-edge");
    const dep = find<Deployment>(objs, "Deployment", "nbo-relay");
    expect(dep.spec.replicas).toBe(2);
    expect(dep.spec.selector.matchLabels).toEqual({ app: "nbo-relay" });
    const pod = dep.spec.template.spec;
    expectHardenedPod(pod);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.imagePullSecrets).toEqual([{ name: "nbo-pull" }]);
    const c = pod.containers[0]!;
    expect(c.env).toEqual([
      { name: "NBO_EDGE_MODE", value: "relay" },
      { name: "NBO_RELAY_TOKEN", valueFrom: { secretKeyRef: { name: "nbo-relay", key: "token" } } },
      { name: "NBO_RELAY_TLS_CERT", value: "/etc/nbo-relay-tls/tls.crt" },
      { name: "NBO_RELAY_TLS_KEY", value: "/etc/nbo-relay-tls/tls.key" },
    ]);
    expect(c.ports.map((p) => p.containerPort)).toEqual([8443]);
    expect(c.volumeMounts).toEqual([{ name: "tls", mountPath: "/etc/nbo-relay-tls", readOnly: true }]);
    expect(pod.volumes).toEqual([{ name: "tls", secret: { secretName: "nbo-relay-tls" } }]);

    const svc = find<Service>(objs, "Service", "nbo-relay");
    expect(svc.spec.type).toBe("LoadBalancer");
    expect(svc.spec.selector).toEqual({ app: "nbo-relay" });
    expect(svc.spec.ports.map((p) => [p.port, p.targetPort])).toEqual([[443, 8443]]);

    const np = find<NetPol>(objs, "NetworkPolicy", "nbo-relay-public");
    expect(np.spec.podSelector).toEqual({ matchLabels: { app: "nbo-relay" } });
    expect(np.spec.ingress).toEqual([{ ports: [{ protocol: "TCP", port: 8443 }] }]);
  });

  it("renders the drain-token Secret", () => {
    const s = find<Secret>(docs(renderEdgeAdminSecret("drain-tok")), "Secret", "nbo-edge-admin");
    expect(s.metadata.namespace).toBe("nbo-edge");
    expect(s.type).toBe("Opaque");
    expect(s.data).toEqual({ token: b64("drain-tok") });
  });

  it("renders the relay's token and TLS Secrets", () => {
    const objs = docs(renderRelaySecrets("relay-tok", "CERT PEM\n", "KEY PEM\n"));
    const tok = find<Secret>(objs, "Secret", "nbo-relay");
    expect(tok.metadata.namespace).toBe("nbo-edge");
    expect(tok.data).toEqual({ token: b64("relay-tok") });
    const tls = find<Secret>(objs, "Secret", "nbo-relay-tls");
    expect(tls.type).toBe("kubernetes.io/tls");
    expect(tls.data).toEqual({ "tls.crt": b64("CERT PEM\n"), "tls.key": b64("KEY PEM\n") });
  });

  it("names certificate Secrets by the host's hash and labels them for the edge", () => {
    const hex = createHash("sha256").update("shop.example.com").digest("hex");
    expect(certSecretName("shop.example.com")).toBe(`nbo-tls-${hex.slice(0, 16)}`);
    const name = certSecretName("shop.example.com");
    const s = find<Secret>(docs(renderCertSecret(name, "C", "K")), "Secret", name);
    expect(s.metadata.namespace).toBe("nbo-edge");
    expect(s.metadata.labels).toMatchObject({ "nbo.dev/edge-cert": "true" });
    expect(s.type).toBe("kubernetes.io/tls");
    expect(s.data).toEqual({ "tls.crt": b64("C"), "tls.key": b64("K") });
    expect(() => renderCertSecret("Bad Name", "C", "K")).toThrow(/name/);
  });

  it("renders the route table into ConfigMap nbo-edge-routes under routes.json", () => {
    const table: RouteTable = {
      version: 1,
      targets: {
        "shop.example.com": {
          backends: [
            { id: "env_a", url: "http://web.nbo-p-1.svc.cluster.local:8080", weight: 90, insecureSkipVerify: false },
            {
              id: "env_b",
              url: "http://web.nbo-p-1.svc.cluster.local:8080",
              weight: 10,
              insecureSkipVerify: false,
              via: { url: "https://203.0.113.7", caPem: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n", token: "t'\"ok" },
            },
          ],
          insights: { enabled: true, inject: true, sampleRate: 50 },
          tls: certSecretName("shop.example.com"),
          redirectHttps: true,
        },
      },
      challenges: { abc: "abc.key" },
    };
    const cm = find<Obj & { data: Record<string, string> }>(docs(renderRouteTableConfigMap(table)), "ConfigMap", "nbo-edge-routes");
    expect(cm.metadata.namespace).toBe("nbo-edge");
    expect(Object.keys(cm.data)).toEqual(["routes.json"]);
    expect(JSON.parse(cm.data["routes.json"]!)).toEqual(table);
  });
});

describe("load balancer annotations", () => {
  const service = (yaml: string, name: string) => find<Obj>(docs(yaml), "Service", name);
  const hetzner = { "load-balancer.hetzner.cloud/location": "nbg1" };

  it("puts them on the edge's and the relay's Service only", () => {
    const edge = docs(renderEdge({ image: "img:1", serviceAnnotations: hetzner }));
    expect((find<Obj>(edge, "Service", "nbo-edge").metadata as { annotations?: unknown }).annotations).toEqual(hetzner);
    expect((find<Obj>(edge, "Deployment", "nbo-edge").metadata as { annotations?: unknown }).annotations).toBeUndefined();
    expect((service(renderRelay({ image: "img:1", serviceAnnotations: hetzner }), "nbo-relay").metadata as { annotations?: unknown }).annotations).toEqual(hetzner);
  });

  it("adds no annotations key without any", () => {
    expect(service(renderEdge({ image: "img:1" }), "nbo-edge").metadata).not.toHaveProperty("annotations");
    expect(service(renderEdge({ image: "img:1", serviceAnnotations: {} }), "nbo-edge").metadata).not.toHaveProperty("annotations");
  });

  it("parses comma-separated key=value pairs", () => {
    expect(parseServiceAnnotations(undefined)).toEqual({});
    expect(parseServiceAnnotations("  ")).toEqual({});
    expect(parseServiceAnnotations("load-balancer.hetzner.cloud/location=nbg1")).toEqual(hetzner);
    expect(parseServiceAnnotations(" a.example/one=1 , two=true ")).toEqual({ "a.example/one": "1", two: "true" });
    expect(parseServiceAnnotations("a.example/empty=")).toEqual({ "a.example/empty": "" });
  });

  it("refuses anything that isn't an annotation, naming it", () => {
    for (const bad of ["nbg1", "=x", "bad key=1", "a=b\nc: d", "a/b/c=1", "/x=1"]) {
      expect(() => parseServiceAnnotations(bad)).toThrow(/NBO_LB_ANNOTATIONS/);
    }
  });
});
