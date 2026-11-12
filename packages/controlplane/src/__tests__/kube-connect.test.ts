// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import type { CommandRunner } from "@nbo/deploy";
import { createStore, type Store } from "../store.js";
import { createKubeConnect } from "../kube-connect.js";
import { renderAccess, renderGuard } from "../kube-bootstrap.js";

const noSleep = async (): Promise<void> => {};
const openStores: Store[] = [];
afterEach(() => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
});

const only = (store: Store) => store.listKubernetesConnections()[0] ?? null;

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-kc-"));
  const s = createStore(join(dir, "t.db"), { secretKey: randomBytes(32) });
  openStores.push(s);
  return s;
}

const SA_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW06c2VydmljZWFjY291bnQ6bmJvLXN5c3RlbTpuYm8tY29udHJvbGxlciJ9.c2lnbmF0dXJl";
const ADMIN_KEY = "QURNSU4tQ0xJRU5ULUtFWS1kYXRh";
const CA = "Q0EtREFUQS1mb3ItdGhlLWNsdXN0ZXI=";

type Call = { cmd: string; args: string[]; input?: string; kubeconfig?: string; timeoutMs?: number };
type Handler = (call: Call, line: string) => string | Error | undefined;

function kubeconfigArg(args: string[]): string | undefined {
  const i = args.indexOf("--kubeconfig");
  return i >= 0 ? readFileSync(args[i + 1]!, "utf8") : undefined;
}

function versionJson(minor: string): string {
  return `Warning: version difference between client (1.32) and server exceeds the supported minor version skew of +/-1\n${JSON.stringify({
    clientVersion: { major: "1", minor: "32" },
    serverVersion: { major: "1", minor },
  })}\n`;
}

const minifiedConfig = JSON.stringify({
  clusters: [{ name: "prod", cluster: { server: "https://prod.example.com:6443", "certificate-authority-data": CA } }],
  users: [{ name: "admin", user: { "client-key-data": ADMIN_KEY, "client-certificate-data": "Q0VSVA==" } }],
  contexts: [{ name: "admin-ctx", context: { cluster: "prod", user: "admin" } }],
  "current-context": "admin-ctx",
});

const GUARD_DENIAL =
  "error: failed to create rolebinding: rolebindings.rbac.authorization.k8s.io \"nbo-probe\" is forbidden: ValidatingAdmissionPolicy 'nbo-namespace-guard' with binding 'nbo-namespace-guard' denied request: nbo-controller may only change objects in nbo-system and nbo-p-* namespaces";
const RBAC_DENIAL =
  'error: failed to create rolebinding: rolebindings.rbac.authorization.k8s.io is forbidden: User "system:serviceaccount:nbo-system:nbo-controller" cannot create resource "rolebindings" in API group "rbac.authorization.k8s.io" in the namespace "default"';

function fakeRunner(
  handler: Handler = () => undefined,
  opts: { minor?: string; tokenAfter?: number; secretsInDefault?: "yes" | "no"; guard?: "present" | "missing" | "rbac"; setupVersion?: string | Error } = {},
) {
  const calls: Call[] = [];
  let polls = 0;
  const run: CommandRunner = async (cmd, args, o) => {
    const call: Call = { cmd, args, input: o?.input, kubeconfig: kubeconfigArg(args), timeoutMs: o?.timeoutMs };
    calls.push(call);
    const line = args.join(" ");
    const custom = handler(call, line);
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return custom;
    if (line.endsWith("version -o json")) return versionJson(opts.minor ?? "31");
    if (line.includes("config view --raw --minify --flatten -o json")) return minifiedConfig;
    if (line.endsWith("apply -f -")) return "namespace/nbo-system created\nserviceaccount/nbo-controller created\n";
    if (line.includes("get secret nbo-controller-token")) {
      polls++;
      return polls > (opts.tokenAfter ?? 1) ? Buffer.from(SA_TOKEN).toString("base64") : "";
    }
    if (line.includes("auth can-i get secrets -n default")) {
      if ((opts.secretsInDefault ?? "no") === "yes") return "yes\n";
      throw new Error(`kubectl ${line} failed with exit code 1:\nno\n`);
    }
    if (line.includes("auth can-i")) return "yes\n";
    if (line.includes("get validatingadmissionpolicy nbo-namespace-guard")) {
      const v = opts.setupVersion ?? "2";
      if (v instanceof Error) throw v;
      return v;
    }
    if (line.includes("create rolebinding nbo-probe")) {
      const guard = opts.guard ?? "present";
      if (guard === "missing") return "rolebinding.rbac.authorization.k8s.io/nbo-probe created (server dry run)\n";
      throw new Error(`kubectl ${line} failed with exit code 1:\n${guard === "rbac" ? RBAC_DENIAL : GUARD_DENIAL}\n`);
    }
    return "";
  };
  return { run, calls, lines: () => calls.map((c) => `${c.cmd} ${c.args.join(" ")}`) };
}

const customRegistry = { kind: "custom" as const, server: "registry.example.com", username: "nbo" };

describe("kube connect", () => {
  it("detect lists the machine's contexts with their servers", async () => {
    const f = fakeRunner((_c, line) =>
      line === "config view -o json"
        ? `W1102 warning on stderr\n${JSON.stringify({
            clusters: [
              { name: "kind-nbo", cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": "DATA+OMITTED" } },
              { name: "gke", cluster: { server: "https://34.1.2.3" } },
            ],
            contexts: [
              { name: "kind-nbo-local", context: { cluster: "kind-nbo", user: "u" } },
              { name: "gke-prod", context: { cluster: "gke", user: "g" } },
              { name: "dangling", context: { cluster: "missing", user: "g" } },
            ],
          })}`
        : undefined,
    );
    const k = createKubeConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    expect(await k.detect()).toEqual({
      contexts: [
        { name: "kind-nbo-local", server: "https://127.0.0.1:6443" },
        { name: "gke-prod", server: "https://34.1.2.3" },
        { name: "dangling", server: "" },
      ],
      reason: null,
    });
    expect(f.calls[0]!.args).toEqual(["config", "view", "-o", "json"]);
  });

  it("detect reports a missing kubectl and an empty kubeconfig", async () => {
    const missing = fakeRunner(() => Object.assign(new Error("spawn kubectl ENOENT"), { code: "ENOENT" }));
    const k1 = createKubeConnect({ store: await openStore(), run: missing.run, sleep: noSleep });
    expect(await k1.detect()).toEqual({ contexts: [], reason: "kubectl is not installed in the NBO container" });

    const empty = fakeRunner(() => JSON.stringify({ clusters: null, contexts: null }));
    const k2 = createKubeConnect({ store: await openStore(), run: empty.run, sleep: noSleep });
    expect((await k2.detect()).reason).toMatch(/no contexts/i);
  });

  it("connect with a machine context bootstraps with --context and saves only the scoped token", async () => {
    const store = await openStore();
    const f = fakeRunner(undefined, { tokenAfter: 2 });
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    const conn = await k.connect({
      source: { kind: "machine", context: "admin-ctx" },
      name: "prod",
      registry: { ...customRegistry, password: "leak" } as unknown as typeof customRegistry,
      registryPassword: "reg-pass",
    });
    expect(conn.status).toBe("connected");
    expect(conn.name).toBe("prod");
    expect(conn.server).toBe("https://prod.example.com:6443");
    expect(conn.registry).toEqual(customRegistry);

    const isCheck = (c: Call): boolean => c.args.includes("auth") || c.args.includes("nbo-probe") || c.args.includes("validatingadmissionpolicy");
    const admin = f.calls.filter((c) => !isCheck(c));
    expect(admin.length).toBeGreaterThan(0);
    for (const c of admin) {
      expect(c.cmd).toBe("kubectl");
      expect(c.args.slice(0, 2)).toEqual(["--context", "admin-ctx"]);
      expect(c.args).not.toContain("--kubeconfig");
    }
    // kubectl apply keeps going past a failed document, so the guard is a separate, earlier apply.
    const applies = f.calls.filter((c) => c.args.join(" ").endsWith("apply -f -"));
    expect(applies.map((c) => c.input)).toEqual([renderGuard(), renderAccess()]);
    const lines = f.lines();
    const idx = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    expect(idx("version -o json")).toBeLessThan(idx("apply -f -"));
    expect(idx("apply -f -")).toBeLessThan(idx("get secret nbo-controller-token"));
    expect(lines.filter((l) => l.includes("get secret nbo-controller-token")).length).toBe(3);

    const secrets = store.getKubernetesSecrets(only(store)!.id);
    expect(secrets.registryPassword).toBe("reg-pass");
    expect(secrets.kubeconfig).toContain(SA_TOKEN);
    expect(secrets.kubeconfig).not.toContain("admin-ctx");
    expect(secrets.kubeconfig).not.toContain(ADMIN_KEY);
    const kc = parse(secrets.kubeconfig) as { clusters: { cluster: Record<string, string> }[] };
    expect(kc.clusters[0]!.cluster).toEqual({ server: "https://prod.example.com:6443", "certificate-authority-data": CA });

    // The check runs with the scoped kubeconfig, never the admin context.
    const checks = f.calls.filter(isCheck);
    expect(checks.map((c) => c.args.slice(2).join(" "))).toEqual([
      "auth can-i create deployments -n nbo-system",
      "auth can-i create namespaces",
      "auth can-i get secrets -n default",
      "create rolebinding nbo-probe -n default --clusterrole=nbo-project-deployer --serviceaccount=nbo-system:nbo-controller --dry-run=server",
      "get validatingadmissionpolicy nbo-namespace-guard -o jsonpath={.metadata.annotations.nbo\\.dev/setup-version}",
    ]);
    for (const c of checks) {
      expect(c.args).not.toContain("--context");
      expect(c.kubeconfig).toContain(SA_TOKEN);
    }
    // Nothing secret lands in the plaintext connection.
    expect(JSON.stringify(only(store))).not.toMatch(/leak|reg-pass|eyJ/);
  });

  it("refuses a new cluster named isr or *-isr before touching the cluster", async () => {
    const store = await openStore();
    const f = fakeRunner();
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    for (const name of ["isr", "eu-isr"]) {
      await expect(k.connect({ source: { kind: "machine", context: "admin-ctx" }, name, registry: customRegistry, registryPassword: "p" })).rejects.toThrow(/isr/);
    }
    expect(f.lines()).toEqual([]);
    expect(only(store)).toBeNull();
  });

  it("rejects clusters older than 1.30 before changing anything", async () => {
    const store = await openStore();
    const f = fakeRunner(undefined, { minor: "29" });
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    await expect(k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "old", registry: customRegistry, registryPassword: "p" })).rejects.toThrow(
      "NBO needs Kubernetes 1.30 or newer (this cluster runs 1.29)",
    );
    expect(f.lines().some((l) => l.includes("apply"))).toBe(false);
    expect(only(store)).toBeNull();
  });

  it("accepts a provider minor with a + suffix", async () => {
    const f = fakeRunner(undefined, { minor: "30+" });
    const k = createKubeConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    const conn = await k.connect({ source: { kind: "machine", context: "gke" }, name: "gke", registry: customRegistry, registryPassword: "p" });
    expect(conn.status).toBe("connected");
  });

  it("test() marks the connection failing when the token can read secrets in default", async () => {
    const store = await openStore();
    const good = fakeRunner();
    await createKubeConnect({ store, run: good.run, sleep: noSleep }).connect({
      source: { kind: "machine", context: "admin-ctx" },
      name: "prod",
      registry: customRegistry,
      registryPassword: "p",
    });
    const bad = fakeRunner(undefined, { secretsInDefault: "yes" });
    const k = createKubeConnect({ store, run: bad.run, sleep: noSleep });
    await expect(k.test(only(store)!.id)).rejects.toThrow("NBO's token can read other namespaces — re-run setup");
    const conn = only(store)!;
    expect(conn.status).toBe("failing");
    expect(conn.lastError).toBe("NBO's token can read other namespaces — re-run setup");
  });

  it("connect resolves with a failing connection when the post-save check finds over-broad access", async () => {
    const store = await openStore();
    const f = fakeRunner(undefined, { secretsInDefault: "yes" });
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    const conn = await k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: customRegistry, registryPassword: "p" });
    expect(conn.status).toBe("failing");
    expect(conn.lastError).toBe("NBO's token can read other namespaces — re-run setup");
    // Not a transient failure: checked once, not retried.
    expect(f.lines().filter((l) => l.includes("get secrets -n default")).length).toBe(1);
  });

  it("test() does not mistake a kubectl error starting with 'no' for a denial", async () => {
    const store = await openStore();
    await createKubeConnect({ store, run: fakeRunner().run, sleep: noSleep }).connect({
      source: { kind: "machine", context: "admin-ctx" },
      name: "prod",
      registry: customRegistry,
      registryPassword: "p",
    });
    const f = fakeRunner((_c, line) =>
      line.includes("get secrets -n default")
        ? new Error(`kubectl ${line} failed with exit code 1:\nno configuration has been provided, try setting KUBERNETES_MASTER`)
        : undefined,
    );
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    await expect(k.test(only(store)!.id)).rejects.toThrow(/cannot read other namespaces/);
    expect(only(store)!.status).toBe("failing");
  });

  it("test() retries briefly while the new token is not yet accepted", async () => {
    const store = await openStore();
    let unauthorized = 2;
    const f = fakeRunner((c, line) => {
      if (line.includes("auth can-i create deployments") && unauthorized-- > 0)
        return new Error(`kubectl ${line} failed with exit code 1:\nerror: You must be logged in to the server (Unauthorized)`);
      return undefined;
    });
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    const conn = await k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: customRegistry, registryPassword: "p" });
    expect(conn.status).toBe("connected");
  });

  it("artifact-registry without a Google connection is rejected before touching the cluster", async () => {
    const store = await openStore();
    const f = fakeRunner();
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    await expect(k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: { kind: "artifact-registry" } })).rejects.toThrow(
      "connect Google Cloud first or name a registry",
    );
    expect(f.calls).toEqual([]);
    expect(only(store)).toBeNull();
  });

  it("artifact-registry with a Google connection saves no registry password", async () => {
    const store = await openStore();
    store.saveGoogleConnection(
      {
        project: "acme",
        region: "europe-west1",
        arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
        deployer: "d@acme.iam.gserviceaccount.com",
        puller: "p@acme.iam.gserviceaccount.com",
      },
      { deployerKey: "{}", pullerKey: "{}" },
    );
    const f = fakeRunner();
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    const conn = await k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: { kind: "artifact-registry" }, registryPassword: "ignored" });
    expect(conn.registry).toEqual({ kind: "artifact-registry" });
    expect(store.getKubernetesSecrets(only(store)!.id).registryPassword).toBeUndefined();
  });

  it("a custom registry needs a server, a username and a password", async () => {
    const f = fakeRunner();
    const k = createKubeConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    const source = { kind: "machine" as const, context: "admin-ctx" };
    await expect(k.connect({ source, name: "prod", registry: customRegistry })).rejects.toThrow(/password/i);
    await expect(k.connect({ source, name: "prod", registry: { ...customRegistry, server: "" }, registryPassword: "p" })).rejects.toThrow(/server/i);
    await expect(k.connect({ source, name: "prod", registry: { ...customRegistry, username: " " }, registryPassword: "p" })).rejects.toThrow(/username/i);
    expect(f.calls).toEqual([]);
  });

  it("a pasted kubeconfig runs via --kubeconfig with the chosen context and is redacted from errors", async () => {
    const store = await openStore();
    const pasted = `apiVersion: v1\nkind: Config\nusers:\n- name: admin\n  user:\n    token: PASTED-ADMIN-TOKEN-123\n`;
    const f = fakeRunner((c, line) => (line.endsWith("apply -f -") ? new Error(`kubectl failed: Unauthorized for token PASTED-ADMIN-TOKEN-123 in\n${pasted}`) : undefined));
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    const err = (await k
      .connect({ source: { kind: "kubeconfig", kubeconfig: pasted, context: "ctx-a" }, name: "prod", registry: customRegistry, registryPassword: "p" })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/installing the nbo-namespace-guard admission policy/);
    expect(err.message).not.toContain("PASTED-ADMIN-TOKEN-123");
    expect(err.message).not.toContain("kind: Config");
    for (const c of f.calls) {
      expect(c.args[0]).toBe("--kubeconfig");
      expect(c.kubeconfig).toBe(pasted);
      expect(c.args.slice(2, 4)).toEqual(["--context", "ctx-a"]);
    }
    expect(only(store)).toBeNull();
  });

  it("a server/CA/token source builds an admin kubeconfig and uses its server for the scoped one", async () => {
    const store = await openStore();
    const f = fakeRunner();
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    const conn = await k.connect({
      source: { kind: "token", server: "https://tok.example.com", caData: CA, token: "ADMIN-BEARER-xyz" },
      name: "tok",
      registry: customRegistry,
      registryPassword: "p",
    });
    expect(conn.server).toBe("https://tok.example.com");
    const admin = f.calls.filter((c) => !c.args.includes("auth") && !c.args.includes("nbo-probe") && !c.args.includes("validatingadmissionpolicy"));
    expect(f.lines().some((l) => l.includes("config view"))).toBe(false);
    for (const c of admin) {
      expect(c.kubeconfig).toContain("ADMIN-BEARER-xyz");
      expect(c.args).not.toContain("--context");
    }
    const saved = store.getKubernetesSecrets(only(store)!.id).kubeconfig;
    expect(saved).not.toContain("ADMIN-BEARER-xyz");
    const kc = parse(saved) as { clusters: { cluster: Record<string, string> }[] };
    expect(kc.clusters[0]!.cluster).toEqual({ server: "https://tok.example.com", "certificate-authority-data": CA });
  });

  it("redacts the admin token and CA from token-source errors", async () => {
    const f = fakeRunner((c, line) => (line.endsWith("version -o json") ? new Error(`bad token ADMIN-BEARER-xyz with ca ${CA}`) : undefined));
    const k = createKubeConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    const err = (await k
      .connect({
        source: { kind: "token", server: "https://tok.example.com", caData: CA, token: "ADMIN-BEARER-xyz" },
        name: "tok",
        registry: customRegistry,
        registryPassword: "p",
      })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Kubernetes version/);
    expect(err.message).not.toContain("ADMIN-BEARER-xyz");
    expect(err.message).not.toContain(CA);
  });

  it("gives up waiting for the token after about 20 seconds without saving", async () => {
    const store = await openStore();
    const f = fakeRunner(undefined, { tokenAfter: 1000 });
    let slept = 0;
    const k = createKubeConnect({ store, run: f.run, sleep: async (ms) => void (slept += ms) });
    await expect(k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: customRegistry, registryPassword: "p" })).rejects.toThrow(
      /nbo-controller token/,
    );
    expect(slept).toBeLessThanOrEqual(20_000);
    expect(slept).toBeGreaterThanOrEqual(15_000);
    expect(only(store)).toBeNull();
  });

  it("reads the token out of output mixed with stderr warnings", async () => {
    const store = await openStore();
    const b64 = Buffer.from(SA_TOKEN).toString("base64");
    const f = fakeRunner((c, line) => (line.includes("get secret nbo-controller-token") ? `Warning: something deprecated\n${b64}` : undefined));
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    await k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: customRegistry, registryPassword: "p" });
    expect(parse(store.getKubernetesSecrets(only(store)!.id).kubeconfig).users[0].user.token).toBe(SA_TOKEN);
  });

  async function connected(store: Store): Promise<void> {
    await createKubeConnect({ store, run: fakeRunner().run, sleep: noSleep }).connect({
      source: { kind: "machine", context: "admin-ctx" },
      name: "prod",
      registry: customRegistry,
      registryPassword: "p",
    });
  }

  it("test() fails when the guard probe is not denied by nbo-namespace-guard", async () => {
    const store = await openStore();
    await connected(store);
    const f = fakeRunner(undefined, { guard: "missing" });
    await expect(createKubeConnect({ store, run: f.run, sleep: noSleep }).test(only(store)!.id)).rejects.toThrow("NBO's namespace guard is missing — re-run setup");
    expect(only(store)!.status).toBe("failing");
    expect(only(store)!.lastError).toBe("NBO's namespace guard is missing — re-run setup");
  });

  it("test() accepts only the guard's denial, not an RBAC one", async () => {
    const store = await openStore();
    await connected(store);
    const f = fakeRunner(undefined, { guard: "rbac" });
    await expect(createKubeConnect({ store, run: f.run, sleep: noSleep }).test(only(store)!.id)).rejects.toThrow(/namespace guard/);
    expect(only(store)!.status).toBe("failing");
  });

  it("never grants access when the guard fails to apply", async () => {
    const store = await openStore();
    const f = fakeRunner((c, line) =>
      line.endsWith("apply -f -") && c.input?.includes("ValidatingAdmissionPolicy") ? new Error('The ValidatingAdmissionPolicy "nbo-namespace-guard" is invalid') : undefined,
    );
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    await expect(k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "p", registry: customRegistry, registryPassword: "p" })).rejects.toThrow(/admission policy/);
    expect(f.calls.filter((c) => c.args.join(" ").endsWith("apply -f -")).length).toBe(1);
    expect(only(store)).toBeNull();
  });

  it("refuses a non-https token-source server without running kubectl", async () => {
    const f = fakeRunner();
    const k = createKubeConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await expect(
      k.connect({ source: { kind: "token", server: "http://tok.example.com", caData: CA, token: "ADMIN-BEARER-xyz" }, name: "t", registry: customRegistry, registryPassword: "p" }),
    ).rejects.toThrow(/https/);
    expect(f.calls).toEqual([]);
  });

  it("refuses a non-https machine cluster before applying anything", async () => {
    const store = await openStore();
    const f = fakeRunner((_c, line) =>
      line.includes("config view --raw") ? JSON.stringify({ clusters: [{ name: "p", cluster: { server: "http://insecure.example.com:8080" } }] }) : undefined,
    );
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    await expect(k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "p", registry: customRegistry, registryPassword: "p" })).rejects.toThrow(/https/);
    expect(f.lines().some((l) => l.includes("apply"))).toBe(false);
    expect(only(store)).toBeNull();
  });

  it("redacts client-secret values from a pasted kubeconfig", async () => {
    const pasted = `apiVersion: v1\nkind: Config\nusers:\n- name: oidc\n  user:\n    auth-provider:\n      config:\n        client-secret: OIDC-CLIENT-SECRET-42\n`;
    const f = fakeRunner((_c, line) => (line.endsWith("version -o json") ? new Error("oidc refresh failed: client-secret OIDC-CLIENT-SECRET-42 rejected") : undefined));
    const k = createKubeConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    const err = (await k
      .connect({ source: { kind: "kubeconfig", kubeconfig: pasted }, name: "p", registry: customRegistry, registryPassword: "p" })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Kubernetes version/);
    expect(err.message).not.toContain("OIDC-CLIENT-SECRET-42");
  });

  it("treats a missing guard right after a fresh install as transient and retries", async () => {
    const store = await openStore();
    let probes = 0;
    const f = fakeRunner((_c, line) => {
      if (line.includes("create rolebinding nbo-probe") && probes++ === 0) return "rolebinding.rbac.authorization.k8s.io/nbo-probe created (server dry run)\n";
      return undefined;
    });
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    const conn = await k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: customRegistry, registryPassword: "p" });
    expect(conn.status).toBe("connected");
    expect(probes).toBe(2);
  });

  it("says a failed connect may have created resources and is safe to re-run", async () => {
    const f = fakeRunner((_c, line) => (line.includes("get secret nbo-controller-token") ? new Error("forbidden") : undefined), { tokenAfter: 1000 });
    const k = createKubeConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await expect(k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: customRegistry, registryPassword: "p" })).rejects.toThrow(
      /nbo-controller token[\s\S]*Steps before this one may have created resources; running Connect again is safe and reuses them\.$/,
    );
  });

  it("runs connect's admin commands with the long connect timeout", async () => {
    const f = fakeRunner();
    const k = createKubeConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await k.connect({ source: { kind: "machine", context: "admin-ctx" }, name: "prod", registry: customRegistry, registryPassword: "p" });
    const admin = f.calls.filter((c) => c.args[0] === "--context");
    expect(admin.length).toBeGreaterThan(0);
    for (const c of admin) expect(c.timeoutMs).toBe(5 * 60_000);
  });

  it("plan describes what setup creates", async () => {
    const k = createKubeConnect({ store: await openStore(), run: fakeRunner().run, sleep: noSleep });
    const plan = k.plan().join("\n");
    expect(plan).toContain("1.30");
    expect(plan).toContain("nbo-system");
    expect(plan).toContain("nbo-controller");
    expect(plan).toContain("nbo-namespace-guard");
    expect(plan).toMatch(/not stored/);
  });
});

describe("kube connect with several clusters", () => {
  const source = { kind: "machine" as const, context: "admin-ctx" };

  it("connects a second cluster alongside the first, and tests each with its own kubeconfig", async () => {
    const store = await openStore();
    const k = createKubeConnect({ store, run: fakeRunner().run, sleep: noSleep });
    const a = await k.connect({ source, name: "hetzner-eu", registry: customRegistry, registryPassword: "p" });
    const b = await k.connect({ source, name: "gke-us", registry: customRegistry, registryPassword: "p" });
    expect(a.id).not.toBe(b.id);
    expect(store.listKubernetesConnections().map((c) => c.name)).toEqual(["hetzner-eu", "gke-us"]);

    const f = fakeRunner(undefined, { guard: "missing" });
    await expect(createKubeConnect({ store, run: f.run, sleep: noSleep }).test(b.id)).rejects.toThrow(/namespace guard is missing/);
    for (const c of f.calls) expect(c.kubeconfig).toBe(store.getKubernetesSecrets(b.id).kubeconfig);
    expect(store.getKubernetesConnection(a.id)!.status).toBe("connected");
    expect(store.getKubernetesConnection(b.id)!.status).toBe("failing");
  });

  it("refuses a name already in use before touching the cluster", async () => {
    const store = await openStore();
    await createKubeConnect({ store, run: fakeRunner().run, sleep: noSleep }).connect({ source, name: "prod", registry: customRegistry, registryPassword: "p" });
    const f = fakeRunner();
    await expect(createKubeConnect({ store, run: f.run, sleep: noSleep }).connect({ source, name: "prod", registry: customRegistry, registryPassword: "p" })).rejects.toThrow(
      /already/,
    );
    await expect(createKubeConnect({ store, run: f.run, sleep: noSleep }).connect({ source, name: "Bad Name", registry: customRegistry, registryPassword: "p" })).rejects.toThrow(
      /name/,
    );
    expect(f.calls).toEqual([]);
  });

  it("connect with an id replaces that cluster in place", async () => {
    const store = await openStore();
    const k = createKubeConnect({ store, run: fakeRunner().run, sleep: noSleep });
    const a = await k.connect({ source, name: "prod", registry: customRegistry, registryPassword: "old" });
    const again = await k.connect({ id: a.id, source, name: "prod", registry: customRegistry, registryPassword: "new" });
    expect(again.id).toBe(a.id);
    expect(store.listKubernetesConnections()).toHaveLength(1);
    expect(store.getKubernetesSecrets(a.id).registryPassword).toBe("new");
    await expect(k.connect({ id: "kc_missing", source, name: "x", registry: customRegistry, registryPassword: "p" })).rejects.toThrow(/not connected|not found/i);
  });
});

describe("kube connect setup version", () => {
  const source = { kind: "machine" as const, context: "admin-ctx" };
  const OUT_OF_DATE = "Cluster setup is out of date — update it (needs admin credentials)";

  async function connectedStore(): Promise<{ store: Store; id: string }> {
    const store = await openStore();
    const conn = await createKubeConnect({ store, run: fakeRunner().run, sleep: noSleep }).connect({ source, name: "prod", registry: customRegistry, registryPassword: "p" });
    expect(conn.status).toBe("connected");
    return { store, id: conn.id };
  }

  for (const [what, version] of [
    ["an older setup version", "1"],
    ["a missing setup-version annotation", ""],
    [
      "a forbidden read of the guard",
      new Error('kubectl get failed with exit code 1:\nError from server (Forbidden): validatingadmissionpolicies.admissionregistration.k8s.io "nbo-namespace-guard" is forbidden'),
    ],
  ] as const) {
    it(`test() reports the setup out of date on ${what}`, async () => {
      const { store, id } = await connectedStore();
      const f = fakeRunner(undefined, { setupVersion: version });
      await expect(createKubeConnect({ store, run: f.run, sleep: noSleep }).test(id)).rejects.toThrow(OUT_OF_DATE);
      const conn = store.getKubernetesConnection(id)!;
      expect(conn.status).toBe("failing");
      expect(conn.lastError).toBe(OUT_OF_DATE);
      // Read with the stored, scoped kubeconfig.
      const read = f.calls.find((c) => c.args.includes("validatingadmissionpolicy"))!;
      expect(read.kubeconfig).toBe(store.getKubernetesSecrets(id).kubeconfig);
    });
  }

  it("updateSetup re-applies the guard and then the access with the admin credentials, keeping the stored token", async () => {
    const { store, id } = await connectedStore();
    store.recordConnectionCheck("kubernetes", OUT_OF_DATE, id);
    const before = store.getKubernetesSecrets(id);
    const f = fakeRunner();
    const conn = await createKubeConnect({ store, run: f.run, sleep: noSleep }).updateSetup(id, source);
    expect(conn.status).toBe("connected");
    expect(conn.lastError).toBeFalsy();
    const applies = f.calls.filter((c) => c.args.join(" ").endsWith("apply -f -"));
    expect(applies.map((c) => c.input)).toEqual([renderGuard(), renderAccess()]);
    for (const c of applies) expect(c.args.slice(0, 2)).toEqual(["--context", "admin-ctx"]);
    // No new token is read or saved: the stored kubeconfig is untouched.
    expect(f.lines().some((l) => l.includes("get secret nbo-controller-token"))).toBe(false);
    expect(store.getKubernetesSecrets(id)).toEqual(before);
    expect(store.listKubernetesConnections()).toHaveLength(1);
  });

  describe("Hetzner load balancer location", () => {
    const LOC = "load-balancer.hetzner.cloud/location";
    const nodes = (labels: Record<string, string>, providerID = "hcloud://1"): string => JSON.stringify({ items: [{ metadata: { labels }, spec: { providerID } }] });
    const withNodes = (out: string | Error) => fakeRunner((_c, line) => (line.endsWith("get nodes -o json") ? out : undefined), { tokenAfter: 2 });
    const request = { source: { kind: "machine" as const, context: "admin-ctx" }, name: "prod", registry: customRegistry, registryPassword: "pw" };

    it("connect reads the nodes with the admin credentials and saves the location on the cluster", async () => {
      const store = await openStore();
      const f = withNodes(nodes({ "topology.kubernetes.io/region": "fsn1" }));
      const conn = await createKubeConnect({ store, run: f.run, sleep: noSleep }).connect(request);
      expect(store.getClusterLbAnnotations(conn.id)).toEqual({ [LOC]: "fsn1" });
      const read = f.calls.find((c) => c.args.join(" ").endsWith("get nodes -o json"))!;
      expect(read.args.slice(0, 2)).toEqual(["--context", "admin-ctx"]);
    });
    it("a cluster of another cloud saves an empty set, so it is not asked about again", async () => {
      const store = await openStore();
      const conn = await createKubeConnect({ store, run: withNodes(nodes({}, "aws:///x")).run, sleep: noSleep }).connect(request);
      expect(store.getClusterLbAnnotations(conn.id)).toEqual({});
    });
    it("a failed node read does not fail the connect and saves nothing", async () => {
      const store = await openStore();
      const conn = await createKubeConnect({ store, run: withNodes(new Error("forbidden")).run, sleep: noSleep }).connect(request);
      expect(conn.status).toBe("connected");
      expect(store.getClusterLbAnnotations(conn.id)).toBeNull();
    });
    it("updateSetup detects it for a cluster connected earlier", async () => {
      const { store, id } = await connectedStore();
      const f = withNodes(nodes({ "csi.hetzner.cloud/location": "hel1" }));
      await createKubeConnect({ store, run: f.run, sleep: noSleep }).updateSetup(id, source);
      expect(store.getClusterLbAnnotations(id)).toEqual({ [LOC]: "hel1" });
    });
  });

  it("updateSetup never stores a pasted admin kubeconfig", async () => {
    const { store, id } = await connectedStore();
    const before = store.getKubernetesSecrets(id);
    const pasted = `apiVersion: v1
kind: Config
users:
- name: admin
  user:
    token: PASTED-ADMIN-TOKEN-123
`;
    const f = fakeRunner();
    await createKubeConnect({ store, run: f.run, sleep: noSleep }).updateSetup(id, { kind: "kubeconfig", kubeconfig: pasted });
    expect(store.getKubernetesSecrets(id)).toEqual(before);
    expect(JSON.stringify(store.getKubernetesSecrets(id))).not.toContain("PASTED-ADMIN-TOKEN-123");
    expect(JSON.stringify(store.getKubernetesConnection(id))).not.toContain("PASTED-ADMIN-TOKEN-123");
  });

  it("updateSetup stops before granting access when the guard is refused", async () => {
    const { store, id } = await connectedStore();
    const f = fakeRunner((c, line) =>
      line.endsWith("apply -f -") && c.input?.includes("ValidatingAdmissionPolicy") ? new Error('The ValidatingAdmissionPolicy "nbo-namespace-guard" is invalid') : undefined,
    );
    await expect(createKubeConnect({ store, run: f.run, sleep: noSleep }).updateSetup(id, source)).rejects.toThrow(/admission policy/);
    expect(f.calls.filter((c) => c.args.join(" ").endsWith("apply -f -")).length).toBe(1);
  });

  it("updateSetup refuses an unknown cluster and admin credentials for another cluster", async () => {
    const { store, id } = await connectedStore();
    const f = fakeRunner();
    const k = createKubeConnect({ store, run: f.run, sleep: noSleep });
    await expect(k.updateSetup("kc_missing", source)).rejects.toThrow(/not connected/);
    expect(f.calls).toEqual([]);
    await expect(k.updateSetup(id, { kind: "token", server: "https://other.example.com", caData: CA, token: "ADMIN-BEARER-xyz" })).rejects.toThrow(/another cluster/);
    expect(f.lines().some((l) => l.includes("apply"))).toBe(false);
  });
});
