// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { parseAllDocuments, parse } from "yaml";
import * as bootstrap from "../kube-bootstrap.js";
import { renderAccess, renderGuard, renderProjectNamespace, scopedKubeconfig, systemNamespace, projectNamespacePrefix, SETUP_VERSION, edgeNamespace } from "../kube-bootstrap.js";

type Obj = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; annotations?: Record<string, string> }; [k: string]: unknown };
type Rule = { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] };

function docs(text: string): Obj[] {
  return parseAllDocuments(text).map((d) => {
    expect(d.errors).toEqual([]);
    return d.toJSON() as Obj;
  });
}
// Everything connect applies, in order: the guard, then the access it guards.
const allDocs = (): Obj[] => [...docs(renderGuard()), ...docs(renderAccess())];
const find = (objs: Obj[], kind: string, name: string): Obj => {
  const o = objs.find((x) => x.kind === kind && x.metadata.name === name);
  if (!o) throw new Error(`missing ${kind}/${name}`);
  return o;
};

describe("kube bootstrap", () => {
  it("exports the namespace names", () => {
    expect(systemNamespace).toBe("nbo-system");
    expect(projectNamespacePrefix).toBe("nbo-p-");
  });

  it("renders the bootstrap with the guard policy and a bind-only grant", () => {
    const text = renderGuard() + renderAccess();
    expect(text).toContain("kind: ValidatingAdmissionPolicy");
    expect(text).toContain("system:serviceaccount:nbo-system:nbo-controller");
    expect(text).toContain("nbo-p-");
    expect(text).toContain('resourceNames: ["nbo-project-deployer"]');
  });

  it("installs the guard before anything it guards, then the namespace before namespaced objects", () => {
    const kinds = allDocs().map((o) => o.kind);
    expect(kinds.slice(0, 3)).toEqual(["ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding", "Namespace"]);
    expect(kinds.indexOf("ServiceAccount")).toBeLessThan(kinds.indexOf("Secret"));
  });

  it("splits the bootstrap into the guard and the access it guards", () => {
    expect(docs(renderGuard()).map((o) => o.kind)).toEqual(["ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"]);
    const access = docs(renderAccess()).map((o) => o.kind);
    expect(access[0]).toBe("Namespace");
    expect(access).not.toContain("ValidatingAdmissionPolicy");
  });

  it("offers no single-apply bootstrap (kubectl apply carries on past a refused guard)", () => {
    expect(Object.keys(bootstrap)).not.toContain("renderBootstrap");
  });

  const podSecurity = {
    "pod-security.kubernetes.io/enforce": "baseline",
    "pod-security.kubernetes.io/enforce-version": "latest",
    "pod-security.kubernetes.io/warn": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
  };

  it("enforces Pod Security baseline on nbo-system", () => {
    const ns = find(allDocs(), "Namespace", "nbo-system") as Obj & { metadata: { labels: Record<string, string> } };
    expect(ns.metadata.labels).toMatchObject(podSecurity);
  });

  it("enforces Pod Security baseline on project namespaces", () => {
    const ns = docs(renderProjectNamespace("nbo-p-4715bebb"))[0] as Obj & { metadata: { labels: Record<string, string> } };
    expect(ns.metadata.labels).toMatchObject(podSecurity);
  });

  it("creates the service account and its token secret in nbo-system", () => {
    const objs = allDocs();
    expect(find(objs, "Namespace", "nbo-system")).toBeTruthy();
    expect(find(objs, "ServiceAccount", "nbo-controller").metadata.namespace).toBe("nbo-system");
    const secret = find(objs, "Secret", "nbo-controller-token");
    expect(secret.metadata.namespace).toBe("nbo-system");
    expect(secret.type).toBe("kubernetes.io/service-account-token");
    expect(secret.metadata.annotations?.["kubernetes.io/service-account.name"]).toBe("nbo-controller");
  });

  it("never grants '*' in any RBAC rule", () => {
    const objs = allDocs();
    const roles = objs.filter((o) => o.kind === "ClusterRole" || o.kind === "Role");
    expect(roles.length).toBe(4);
    for (const r of roles) {
      for (const rule of r.rules as Rule[]) {
        expect(rule.verbs).not.toContain("*");
        expect(rule.resources).not.toContain("*");
        expect(rule.apiGroups).not.toContain("*");
        for (const v of rule.verbs) expect(v).not.toContain("*");
        for (const res of rule.resources) expect(res).not.toContain("*");
      }
    }
  });

  it("limits the controller role to namespaces, rolebindings and binding nbo-project-deployer", () => {
    const rules = find(allDocs(), "ClusterRole", "nbo-controller").rules as Rule[];
    expect(rules).toEqual([
      { apiGroups: [""], resources: ["namespaces"], verbs: ["get", "list", "create", "delete"] },
      { apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings"], verbs: ["create", "get"] },
      { apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"], verbs: ["bind"], resourceNames: ["nbo-project-deployer"] },
      { apiGroups: ["admissionregistration.k8s.io"], resources: ["validatingadmissionpolicies"], verbs: ["get"], resourceNames: ["nbo-namespace-guard"] },
    ]);
  });

  it("gives the project deployer read-only pods and get on pods/log", () => {
    const rules = find(allDocs(), "ClusterRole", "nbo-project-deployer").rules as Rule[];
    const full = ["get", "list", "watch", "create", "update", "patch", "delete"];
    const verbsFor = (res: string): string[] => rules.find((r) => r.resources.includes(res))!.verbs;
    for (const res of ["deployments", "services", "secrets", "configmaps", "serviceaccounts", "networkpolicies"]) expect(verbsFor(res)).toEqual(full);
    expect(verbsFor("pods")).toEqual(["get", "list", "watch"]);
    expect(verbsFor("pods/log")).toEqual(["get"]);
  });

  it("binds the controller cluster-wide and the deployer only in nbo-system and nbo-edge", () => {
    const objs = allDocs();
    const subject = { kind: "ServiceAccount", name: "nbo-controller", namespace: "nbo-system" };
    const crb = find(objs, "ClusterRoleBinding", "nbo-controller");
    expect(crb.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "nbo-controller" });
    expect(crb.subjects).toEqual([subject]);
    const rb = find(objs, "RoleBinding", "nbo-project-deployer");
    expect(rb.metadata.namespace).toBe("nbo-system");
    expect(rb.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "nbo-project-deployer" });
    expect(rb.subjects).toEqual([subject]);
    // No other binding hands out the deployer role cluster-wide.
    expect(objs.filter((o) => o.kind === "ClusterRoleBinding").length).toBe(1);
  });

  it("guards every write by the controller with a v1 policy and a Deny binding", () => {
    const objs = allDocs();
    const vap = find(objs, "ValidatingAdmissionPolicy", "nbo-namespace-guard");
    expect(vap.apiVersion).toBe("admissionregistration.k8s.io/v1");
    const spec = vap.spec as {
      failurePolicy: string;
      matchConstraints: { resourceRules: unknown[]; excludeResourceRules: unknown[] };
      matchConditions: { name: string; expression: string }[];
      variables: { name: string; expression: string }[];
      validations: { expression: string; message: string }[];
    };
    expect(spec.failurePolicy).toBe("Fail");
    // "*/*" = every resource and every subresource; the API rejects "*" alongside it.
    expect(spec.matchConstraints.resourceRules).toEqual([{ apiGroups: ["*"], apiVersions: ["*"], operations: ["CREATE", "UPDATE", "DELETE"], resources: ["*/*"] }]);
    // kubectl auth can-i / whoami create these cluster-scoped review objects; denying them would break test().
    expect(spec.matchConstraints.excludeResourceRules).toEqual([
      { apiGroups: ["authorization.k8s.io"], apiVersions: ["*"], operations: ["*"], resources: ["selfsubjectaccessreviews", "selfsubjectrulesreviews"] },
      { apiGroups: ["authentication.k8s.io"], apiVersions: ["*"], operations: ["*"], resources: ["selfsubjectreviews"] },
    ]);
    expect(spec.matchConditions).toEqual([{ name: "nbo-controller-only", expression: "request.userInfo.username == 'system:serviceaccount:nbo-system:nbo-controller'" }]);
    const target = spec.variables.find((v) => v.name === "target")!.expression;
    expect(target).toContain("object.metadata.name");
    expect(target).toContain("oldObject.metadata.name");
    expect(target).toContain("request.namespace");
    const v = spec.validations.map((x) => x.expression);
    expect(v[0]).toBe("variables.target == 'nbo-system' || variables.target == 'nbo-edge' || variables.target.startsWith('nbo-p-')");
    // Namespaces must carry Pod Security enforce=baseline or restricted.
    const nsRule = v.find((e) => e.includes("pod-security.kubernetes.io/enforce"))!;
    expect(nsRule).toContain("['baseline', 'restricted']");
    expect(nsRule).toContain("pod-security.kubernetes.io/enforce-version");
    // Services: ClusterIP only, no externalIPs (CVE-2020-8554).
    const svcRule = v.find((e) => e.includes("'Service'"))!;
    expect(svcRule).toContain("externalIPs");
    expect(svcRule).toContain("object.spec.type == 'ClusterIP'");
    // RoleBindings: pinned roleRef and a single nbo-controller subject.
    const rbRule = v.find((e) => e.includes("'RoleBinding'"))!;
    expect(rbRule).toContain("object.roleRef.kind == 'ClusterRole'");
    expect(rbRule).toContain("object.roleRef.name == 'nbo-project-deployer'");
    expect(rbRule).toContain("size(object.subjects) == 1");
    expect(rbRule).toContain("object.subjects[0].name == 'nbo-controller'");
    expect(rbRule).toContain("object.subjects[0].namespace == 'nbo-system'");
    for (const x of spec.validations) expect(x.message).toBeTruthy();

    const binding = find(objs, "ValidatingAdmissionPolicyBinding", "nbo-namespace-guard");
    expect(binding.apiVersion).toBe("admissionregistration.k8s.io/v1");
    expect(binding.spec).toEqual({ policyName: "nbo-namespace-guard", validationActions: ["Deny"] });
  });

  it("renders a project namespace with its deployer binding", () => {
    const objs = docs(renderProjectNamespace("nbo-p-4715bebb"));
    expect(objs.map((o) => o.kind)).toEqual(["Namespace", "RoleBinding"]);
    expect(objs[0]!.metadata.name).toBe("nbo-p-4715bebb");
    const rb = objs[1]!;
    expect(rb.metadata.namespace).toBe("nbo-p-4715bebb");
    expect(rb.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "nbo-project-deployer" });
    expect(rb.subjects).toEqual([{ kind: "ServiceAccount", name: "nbo-controller", namespace: "nbo-system" }]);
  });

  it("refuses project namespaces outside the nbo-p- prefix or not DNS labels", () => {
    for (const bad of ["default", "kube-system", "nbo-system", "nbo-p-", "nbo-p-UPPER", "nbo-p-a\nkind: x", `nbo-p-${"a".repeat(60)}`]) {
      expect(() => renderProjectNamespace(bad)).toThrow();
    }
  });

  it("builds a scoped kubeconfig with the token and nbo-system as its namespace", () => {
    const kc = parse(scopedKubeconfig("https://10.0.0.1:6443", "Q0FEQVRB", "tok.en-1")) as {
      clusters: { cluster: { server: string; "certificate-authority-data": string } }[];
      users: { user: { token: string } }[];
      contexts: { name: string; context: { namespace: string } }[];
      "current-context": string;
    };
    expect(kc.clusters[0]!.cluster).toEqual({ server: "https://10.0.0.1:6443", "certificate-authority-data": "Q0FEQVRB" });
    expect(kc.users[0]!.user).toEqual({ token: "tok.en-1" });
    expect(kc.contexts[0]!.context.namespace).toBe("nbo-system");
    expect(kc["current-context"]).toBe(kc.contexts[0]!.name);
  });

  it("requires an https server", () => {
    expect(() => scopedKubeconfig("http://10.0.0.1:8080", "", "t")).toThrow(/https/);
  });

  it("omits the CA when none is given and quotes awkward values safely", () => {
    const kc = parse(scopedKubeconfig("https://k.example.com", "", 'a"b\nc')) as { clusters: { cluster: Record<string, string> }[]; users: { user: { token: string } }[] };
    expect(kc.clusters[0]!.cluster).toEqual({ server: "https://k.example.com" });
    expect(kc.users[0]!.user.token).toBe('a"b\nc');
  });
  it("marks the guard with the setup version", () => {
    expect(SETUP_VERSION).toBe(2);
    const vap = find(docs(renderGuard()), "ValidatingAdmissionPolicy", "nbo-namespace-guard");
    expect(vap.metadata.annotations).toEqual({ "nbo.dev/setup-version": "2" });
  });

  it("allows a LoadBalancer Service only for nbo-edge and nbo-relay in nbo-edge, and never externalIPs", () => {
    const vap = find(docs(renderGuard()), "ValidatingAdmissionPolicy", "nbo-namespace-guard");
    const svcRule = (vap.spec as { validations: { expression: string }[] }).validations.map((x) => x.expression).find((e) => e.includes("'Service'"))!;
    expect(svcRule).toContain("(!has(object.spec.externalIPs) || size(object.spec.externalIPs) == 0) && ");
    expect(svcRule).toContain(
      "(!has(object.spec.type) || object.spec.type == 'ClusterIP' || (object.spec.type == 'LoadBalancer' && request.namespace == 'nbo-edge' && object.metadata.name in ['nbo-edge', 'nbo-relay']))",
    );
  });

  // No CEL evaluator in the repo: a static check that every guard expression
  // is balanced and names only the CEL roots admission policies provide.
  it("keeps every guard CEL expression balanced and limited to known roots", () => {
    const vap = find(docs(renderGuard()), "ValidatingAdmissionPolicy", "nbo-namespace-guard");
    const spec = vap.spec as { matchConditions: { expression: string }[]; variables: { expression: string }[]; validations: { expression: string }[] };
    const exprs = [...spec.matchConditions, ...spec.variables, ...spec.validations].map((x) => x.expression);
    const roots = new Set(["object", "oldObject", "request", "variables", "has", "size", "in", "true", "false", "null"]);
    for (const e of exprs) {
      // Strip single-quoted string literals (no escapes are used in the guard).
      expect((e.match(/'/g) ?? []).length % 2, e).toBe(0);
      const code = e.replace(/'[^']*'/g, "''");
      const stack: string[] = [];
      const pairs: Record<string, string> = { ")": "(", "]": "[" };
      for (const ch of code) {
        if (ch === "(" || ch === "[") stack.push(ch);
        else if (ch === ")" || ch === "]") expect(stack.pop(), e).toBe(pairs[ch]);
      }
      expect(stack, e).toEqual([]);
      // Identifiers not following a "." are roots or functions.
      for (const m of code.matchAll(/(^|[^.\w])([A-Za-z_]\w*)/g)) expect(roots.has(m[2]!), `${m[2]} in ${e}`).toBe(true);
      expect(code).not.toMatch(/&&\s*$|\|\|\s*$|^\s*(&&|\|\|)/);
    }
  });

  it("creates the nbo-edge namespace with Pod Security baseline, after nbo-system and before anything in it", () => {
    const objs = docs(renderAccess());
    expect(edgeNamespace).toBe("nbo-edge");
    const ns = find(objs, "Namespace", "nbo-edge") as Obj & { metadata: { labels: Record<string, string> } };
    expect(ns.metadata.labels).toMatchObject({ ...podSecurity, "app.kubernetes.io/managed-by": "nbo" });
    const at = objs.indexOf(ns);
    for (const [i, o] of objs.entries()) if (o.metadata.namespace === "nbo-edge") expect(i).toBeGreaterThan(at);
  });

  it("gives the edge a read-only role in nbo-edge only, and the controller deploy and pod proxy there", () => {
    const objs = docs(renderAccess());
    const sa = find(objs, "ServiceAccount", "nbo-edge");
    expect(sa.metadata.namespace).toBe("nbo-edge");
    const reader = find(objs, "Role", "nbo-edge-reader");
    expect(reader.metadata.namespace).toBe("nbo-edge");
    expect(reader.rules).toEqual([{ apiGroups: [""], resources: ["configmaps", "secrets"], verbs: ["get", "list", "watch"] }]);
    const rb = find(objs, "RoleBinding", "nbo-edge-reader");
    expect(rb.metadata.namespace).toBe("nbo-edge");
    expect(rb.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "nbo-edge-reader" });
    expect(rb.subjects).toEqual([{ kind: "ServiceAccount", name: "nbo-edge", namespace: "nbo-edge" }]);
    const proxy = find(objs, "Role", "nbo-controller-proxy");
    expect(proxy.metadata.namespace).toBe("nbo-edge");
    expect(proxy.rules).toEqual([{ apiGroups: [""], resources: ["pods/proxy"], verbs: ["get"] }]);
    const prb = find(objs, "RoleBinding", "nbo-controller-proxy");
    expect(prb.metadata.namespace).toBe("nbo-edge");
    expect(prb.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "nbo-controller-proxy" });
    expect(prb.subjects).toEqual([{ kind: "ServiceAccount", name: "nbo-controller", namespace: "nbo-system" }]);
    const deployer = objs.filter((o) => o.kind === "RoleBinding" && o.metadata.name === "nbo-project-deployer").map((o) => o.metadata.namespace);
    expect(deployer).toEqual(["nbo-system", "nbo-edge"]);
  });

  // nbo-system holds nbo-controller's token: the internet-facing edge must not read it.
  it("grants the edge nothing in nbo-system", () => {
    const objs = allDocs();
    const inSystem = objs.filter((o) => (o.kind === "Role" || o.kind === "RoleBinding") && o.metadata.namespace === "nbo-system");
    for (const o of inSystem) {
      expect(o.metadata.name).not.toMatch(/edge/);
      for (const s of (o.subjects ?? []) as { name: string; namespace?: string }[]) {
        expect(s.name).not.toBe("nbo-edge");
        expect(s.namespace).not.toBe("nbo-edge");
      }
    }
    expect(objs.filter((o) => o.kind === "Role" && o.metadata.name === "nbo-edge-reader").map((o) => o.metadata.namespace)).toEqual(["nbo-edge"]);
    expect(objs.filter((o) => o.kind === "ServiceAccount" && o.metadata.name === "nbo-edge").map((o) => o.metadata.namespace)).toEqual(["nbo-edge"]);
    // And no cluster-wide grant reaches it.
    for (const o of objs.filter((x) => x.kind === "ClusterRoleBinding")) expect(JSON.stringify(o.subjects)).not.toContain("nbo-edge");
  });
});
