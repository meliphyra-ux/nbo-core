// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The objects NBO installs in a connected cluster, and the kubeconfig it keeps.
//
// Confinement has two layers. RBAC: nbo-controller may create/delete
// namespaces and create RoleBindings anywhere, but may only bind the
// nbo-project-deployer ClusterRole, which it holds only through RoleBindings
// in nbo-system, nbo-edge and nbo-p-* namespaces. Admission: the
// nbo-namespace-guard ValidatingAdmissionPolicy denies every
// CREATE/UPDATE/DELETE by nbo-controller whose target namespace is not
// nbo-system, nbo-edge or nbo-p-* (cluster-scoped objects other than those Namespaces have no namespace and
// are denied too), so the cluster-wide namespace/rolebinding grants cannot be
// turned on kube-system, default or anything else. It also pins what those
// writes may contain: namespaces must enforce Pod Security baseline, Services
// are ClusterIP without externalIPs (the one exception: the edge's and relay's
// own LoadBalancer Services, nbo-edge and nbo-relay in nbo-edge), and
// RoleBindings may only bind nbo-project-deployer to nbo-controller.

export const managedByLabels: Readonly<Record<string, string>> = { "app.kubernetes.io/managed-by": "nbo" };
export const systemNamespace = "nbo-system";
// The public edge and relay run here, apart from nbo-system (which holds
// nbo-controller's token).
export const edgeNamespace = "nbo-edge";
export const projectNamespacePrefix = "nbo-p-";

// SETUP_VERSION is what renderGuard()/renderAccess() install, recorded on the
// guard as nbo.dev/setup-version. A connection whose cluster reports less
// (or nothing) needs updateSetup with admin credentials. 2: public edge
// (LoadBalancer exception, edge RBAC, pod proxy, guard read).
export const SETUP_VERSION = 2;
export const setupVersionAnnotation = "nbo.dev/setup-version";

const controller = "nbo-controller";
const tokenSecret = "nbo-controller-token";
const deployerRole = "nbo-project-deployer";
const guard = "nbo-namespace-guard";
const controllerUser = `system:serviceaccount:${systemNamespace}:${controller}`;
const rbacGroup = "rbac.authorization.k8s.io";
const managedBy = { ...managedByLabels };
const edgeAccount = "nbo-edge";
const edgeReader = "nbo-edge-reader";
const controllerProxy = "nbo-controller-proxy";
const loadBalancerNames = ["nbo-edge", "nbo-relay"];

const fullVerbs = ["get", "list", "watch", "create", "update", "patch", "delete"];

export type Y = string | number | boolean | Y[] | { [k: string]: Y };

// A deliberately small YAML emitter: block mappings and sequences, flow lists
// for lists of scalars. A string is left plain only when it is an identifier-
// like word YAML (1.1 or 1.2) cannot read as anything but a string; all else
// is double-quoted with JSON escaping (valid YAML), so no value can change
// the document's structure.
const yamlWords = /^(y|n|yes|no|true|false|on|off|null)$/i;
function plain(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9./_-]*$/.test(s) && !yamlWords.test(s);
}
function key(k: string): string {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(k) && !yamlWords.test(k) ? k : JSON.stringify(k);
}
function scalar(v: string | number | boolean): string {
  if (typeof v !== "string") return String(v);
  return plain(v) ? v : JSON.stringify(v);
}
const flowItem = (v: string | number | boolean): string => (typeof v === "string" ? JSON.stringify(v) : String(v));
const isScalar = (v: Y): v is string | number | boolean => typeof v !== "object";

function emitMap(obj: { [k: string]: Y }, indent: number): string {
  const pad = " ".repeat(indent);
  let out = "";
  for (const [k, v] of Object.entries(obj)) {
    if (isScalar(v)) out += `${pad}${key(k)}: ${scalar(v)}\n`;
    else if (Array.isArray(v) && v.every(isScalar)) out += `${pad}${key(k)}: [${v.map(flowItem).join(", ")}]\n`;
    else if (Array.isArray(v)) out += `${pad}${key(k)}:\n${emitSeq(v, indent)}`;
    else if (Object.keys(v).length === 0) out += `${pad}${key(k)}: {}\n`;
    else out += `${pad}${key(k)}:\n${emitMap(v, indent + 2)}`;
  }
  return out;
}
function emitSeq(items: Y[], indent: number): string {
  const pad = " ".repeat(indent);
  return items
    .map((item) => {
      if (isScalar(item) || Array.isArray(item)) throw new Error("kube-bootstrap: only mappings may appear in block sequences");
      return pad + "- " + emitMap(item, indent + 2).slice(indent + 2);
    })
    .join("");
}
export const toYaml = (docs: { [k: string]: Y }[]): string => docs.map((d) => emitMap(d, 0)).join("---\n");

const controllerSubject = { kind: "ServiceAccount", name: controller, namespace: systemNamespace };

function deployerBinding(namespace: string): { [k: string]: Y } {
  return {
    apiVersion: `${rbacGroup}/v1`,
    kind: "RoleBinding",
    metadata: { name: deployerRole, namespace, labels: managedBy },
    roleRef: { apiGroup: rbacGroup, kind: "ClusterRole", name: deployerRole },
    subjects: [controllerSubject],
  };
}

// Namespace for a Namespace object (object on CREATE/UPDATE, oldObject on
// DELETE); the request namespace for everything else ("" when cluster-scoped).
const isNamespaceExpr = "request.kind.group == '' && request.kind.kind == 'Namespace'";
const targetExpr = "variables.isNamespace ? (object != null ? object.metadata.name : oldObject.metadata.name) : request.namespace";

// Pod Security: baseline is enforced (not restricted, because NBO's node
// images run as root); restricted only warns and audits. This is what stops
// the token's Deployments from producing privileged / hostPath / hostPID pods,
// which the guard below never sees (the ReplicaSet controller creates them).
const psEnforce = "pod-security.kubernetes.io/enforce";
const psEnforceVersion = "pod-security.kubernetes.io/enforce-version";
const podSecurityLabels = {
  [psEnforce]: "baseline",
  [psEnforceVersion]: "latest",
  "pod-security.kubernetes.io/warn": "restricted",
  "pod-security.kubernetes.io/audit": "restricted",
};
const namespaceLabels = { ...managedBy, ...podSecurityLabels };

const writeOf = (group: string, kind: string): string => `request.kind.group == '${group}' && request.kind.kind == '${kind}' && request.operation != 'DELETE'`;

const guardValidations: { expression: string; message: string }[] = [
  {
    expression: `variables.target == '${systemNamespace}' || variables.target == '${edgeNamespace}' || variables.target.startsWith('${projectNamespacePrefix}')`,
    message: `${controller} may only change objects in ${systemNamespace}, ${edgeNamespace} and ${projectNamespacePrefix}* namespaces`,
  },
  {
    // nbo-controller has no update/patch on namespaces, so labels set at
    // creation cannot be removed later; checked on UPDATE too for safety.
    expression:
      `!variables.isNamespace || request.operation == 'DELETE' || (has(object.metadata.labels) && ` +
      `'${psEnforce}' in object.metadata.labels && object.metadata.labels['${psEnforce}'] in ['baseline', 'restricted'] && ` +
      `(!('${psEnforceVersion}' in object.metadata.labels) || object.metadata.labels['${psEnforceVersion}'] == 'latest'))`,
    message: `namespaces created by ${controller} must enforce Pod Security baseline or restricted (latest)`,
  },
  {
    // No externalIPs anywhere (CVE-2020-8554); ClusterIP only, except the
    // edge's and relay's own LoadBalancer Services in nbo-edge.
    expression:
      `!(${writeOf("", "Service")}) || ((!has(object.spec.externalIPs) || size(object.spec.externalIPs) == 0) && ` +
      `(!has(object.spec.type) || object.spec.type == 'ClusterIP' || (object.spec.type == 'LoadBalancer' && request.namespace == '${edgeNamespace}' && ` +
      `object.metadata.name in [${loadBalancerNames.map((n) => `'${n}'`).join(", ")}])))`,
    message: `${controller} may only create ClusterIP Services without externalIPs (LoadBalancer only for ${loadBalancerNames.join(" and ")} in ${edgeNamespace})`,
  },
  {
    expression:
      `!(${writeOf(rbacGroup, "RoleBinding")}) || (object.roleRef.kind == 'ClusterRole' && object.roleRef.name == '${deployerRole}' && ` +
      `has(object.subjects) && size(object.subjects) == 1 && object.subjects[0].kind == 'ServiceAccount' && ` +
      `object.subjects[0].name == '${controller}' && has(object.subjects[0].namespace) && object.subjects[0].namespace == '${systemNamespace}')`,
    message: `${controller} may only bind ${deployerRole} to itself`,
  },
];

// The bootstrap is two document sets, never one: kubectl apply carries on
// past a document the API rejects, so connect applies renderGuard() and then
// renderAccess() separately — if the guard is refused, no access is granted.
export function renderGuard(): string {
  return toYaml([
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      metadata: { name: guard, labels: managedBy, annotations: { [setupVersionAnnotation]: String(SETUP_VERSION) } },
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          // "*/*" is every resource and every subresource (the API refuses "*" next to it).
          resourceRules: [{ apiGroups: ["*"], apiVersions: ["*"], operations: ["CREATE", "UPDATE", "DELETE"], resources: ["*/*"] }],
          // kubectl auth can-i / auth whoami create these cluster-scoped,
          // never-persisted review objects; test() needs them.
          excludeResourceRules: [
            { apiGroups: ["authorization.k8s.io"], apiVersions: ["*"], operations: ["*"], resources: ["selfsubjectaccessreviews", "selfsubjectrulesreviews"] },
            { apiGroups: ["authentication.k8s.io"], apiVersions: ["*"], operations: ["*"], resources: ["selfsubjectreviews"] },
          ],
        },
        matchConditions: [{ name: "nbo-controller-only", expression: `request.userInfo.username == '${controllerUser}'` }],
        variables: [
          { name: "isNamespace", expression: isNamespaceExpr },
          { name: "target", expression: targetExpr },
        ],
        validations: guardValidations,
      },
    },
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      metadata: { name: guard, labels: managedBy },
      spec: { policyName: guard, validationActions: ["Deny"] },
    },
  ]);
}

export function renderAccess(): string {
  return toYaml([
    { apiVersion: "v1", kind: "Namespace", metadata: { name: systemNamespace, labels: namespaceLabels } },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: controller, namespace: systemNamespace, labels: managedBy } },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: tokenSecret, namespace: systemNamespace, labels: managedBy, annotations: { "kubernetes.io/service-account.name": controller } },
      type: "kubernetes.io/service-account-token",
    },
    {
      apiVersion: `${rbacGroup}/v1`,
      kind: "ClusterRole",
      metadata: { name: controller, labels: managedBy },
      rules: [
        { apiGroups: [""], resources: ["namespaces"], verbs: ["get", "list", "create", "delete"] },
        { apiGroups: [rbacGroup], resources: ["rolebindings"], verbs: ["create", "get"] },
        { apiGroups: [rbacGroup], resources: ["clusterroles"], verbs: ["bind"], resourceNames: [deployerRole] },
        // test() reads the guard's setup-version annotation.
        { apiGroups: ["admissionregistration.k8s.io"], resources: ["validatingadmissionpolicies"], verbs: ["get"], resourceNames: [guard] },
      ],
    },
    {
      apiVersion: `${rbacGroup}/v1`,
      kind: "ClusterRoleBinding",
      metadata: { name: controller, labels: managedBy },
      roleRef: { apiGroup: rbacGroup, kind: "ClusterRole", name: controller },
      subjects: [controllerSubject],
    },
    {
      apiVersion: `${rbacGroup}/v1`,
      kind: "ClusterRole",
      metadata: { name: deployerRole, labels: managedBy },
      rules: [
        { apiGroups: ["apps"], resources: ["deployments"], verbs: fullVerbs },
        { apiGroups: [""], resources: ["services", "secrets", "configmaps", "serviceaccounts"], verbs: fullVerbs },
        { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], verbs: fullVerbs },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
        { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
      ],
    },
    deployerBinding(systemNamespace),
    // The public edge and relay live in their own namespace, nbo-edge: the
    // edge reads every Secret where it runs, and nbo-system holds
    // nbo-controller's token, which an internet-facing process must never be
    // able to read. These Roles and RoleBindings are created here, with the
    // admin credentials: the guard lets nbo-controller bind only
    // nbo-project-deployer.
    { apiVersion: "v1", kind: "Namespace", metadata: { name: edgeNamespace, labels: namespaceLabels } },
    deployerBinding(edgeNamespace),
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: edgeAccount, namespace: edgeNamespace, labels: managedBy } },
    {
      apiVersion: `${rbacGroup}/v1`,
      kind: "Role",
      metadata: { name: edgeReader, namespace: edgeNamespace, labels: managedBy },
      rules: [{ apiGroups: [""], resources: ["configmaps", "secrets"], verbs: ["get", "list", "watch"] }],
    },
    {
      apiVersion: `${rbacGroup}/v1`,
      kind: "RoleBinding",
      metadata: { name: edgeReader, namespace: edgeNamespace, labels: managedBy },
      roleRef: { apiGroup: rbacGroup, kind: "Role", name: edgeReader },
      subjects: [{ kind: "ServiceAccount", name: edgeAccount, namespace: edgeNamespace }],
    },
    // The Speed Insights drain reaches edge pods' admin port through the API
    // server's pod proxy, in nbo-edge only.
    {
      apiVersion: `${rbacGroup}/v1`,
      kind: "Role",
      metadata: { name: controllerProxy, namespace: edgeNamespace, labels: managedBy },
      rules: [{ apiGroups: [""], resources: ["pods/proxy"], verbs: ["get"] }],
    },
    {
      apiVersion: `${rbacGroup}/v1`,
      kind: "RoleBinding",
      metadata: { name: controllerProxy, namespace: edgeNamespace, labels: managedBy },
      roleRef: { apiGroup: rbacGroup, kind: "Role", name: controllerProxy },
      subjects: [controllerSubject],
    },
  ]);
}

const projectNamespaceRe = new RegExp(`^${projectNamespacePrefix}[a-z0-9]([-a-z0-9]*[a-z0-9])?$`);

export function renderProjectNamespace(namespace: string): string {
  if (namespace.length > 63 || !projectNamespaceRe.test(namespace)) {
    throw new Error(`invalid project namespace ${JSON.stringify(namespace)}: must be a DNS label starting with ${projectNamespacePrefix}`);
  }
  return toYaml([{ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels: namespaceLabels } }, deployerBinding(namespace)]);
}

// A single-context kubeconfig authenticating with a bearer token. Without
// caData the system trust store verifies the server.
export function bearerKubeconfig(server: string, caData: string, token: string, user: string, namespace?: string): string {
  if (!/^https:\/\/[^\s]+$/.test(server)) throw new Error("the cluster server must be an https:// URL");
  if (!token) throw new Error("missing bearer token");
  const cluster: { [k: string]: Y } = { server };
  if (caData) cluster["certificate-authority-data"] = caData;
  const context: { [k: string]: Y } = { cluster: "nbo", user };
  if (namespace) context.namespace = namespace;
  return toYaml([
    {
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "nbo", cluster }],
      users: [{ name: user, user: { token } }],
      contexts: [{ name: "nbo", context }],
      "current-context": "nbo",
    },
  ]);
}

export function scopedKubeconfig(server: string, caData: string, token: string): string {
  return bearerKubeconfig(server, caData, token, controller, systemNamespace);
}
