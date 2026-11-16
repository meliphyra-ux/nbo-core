// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import {
  renderManifests,
  renderFunctionManifests,
  renderNetworkPolicies,
  renderPullSecret,
  renderEnvSecret,
  deleteEnvSecret,
  apply,
  waitForRollout,
  liveContentID,
  liveFunctionState,
  functionConfigHash,
  kubeName,
  functionObjectName,
  isrcacheObjectName,
  renderIsrcacheManifests,
  deleteIsrcache,
  isrcacheDeleteArgs,
  isrcacheNameTaken,
  type CommandRunner,
} from "../manifest.js";
import { pushImage } from "../image.js";

// The yaml package is a controlplane dependency; resolve it from there.
const { parseAllDocuments } = createRequire(new URL("../../../controlplane/package.json", import.meta.url))("yaml") as {
  parseAllDocuments: (s: string) => { toJS(): any }[];
};

function recorder(
  answer: (cmd: string, args: string[]) => string | Error = () => "",
): CommandRunner & { calls: { cmd: string; args: string[]; input?: string; env?: Record<string, string> }[] } {
  const calls: { cmd: string; args: string[]; input?: string; env?: Record<string, string> }[] = [];
  const fn = (async (cmd: string, args: string[], opts?: { input?: string; env?: Record<string, string> }) => {
    calls.push({ cmd, args, input: opts?.input, env: opts?.env });
    const a = answer(cmd, args);
    if (a instanceof Error) throw a;
    return a;
  }) as CommandRunner & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("renderManifests", () => {
  it("includes the content-id annotation and the host in the rendered Ingress", () => {
    const yaml = renderManifests({
      appName: "static-site",
      imageTag: "nbo-app-static-site:abc123",
      host: "static-site.127.0.0.1.sslip.io",
      contentID: "sha256:deadbeef",
    });

    expect(yaml).toContain('nbo.dev/content-id: "sha256:deadbeef"');
    expect(yaml).toContain("static-site.127.0.0.1.sslip.io");
    expect(yaml).toContain("cert-manager.io/cluster-issuer: selfsigned-issuer");
  });

  it("produces 3 YAML documents (Deployment, Service, Ingress)", () => {
    const yaml = renderManifests({
      appName: "x",
      imageTag: "y:z",
      host: "x.127.0.0.1.sslip.io",
      contentID: "sha256:aa",
    });

    const docs = yaml.split("\n---\n");
    expect(docs).toHaveLength(3);
  });

  it("dev (default) keeps the Ingress, the selfsigned issuer and port 80, with no namespace or pull secret", () => {
    const yaml = renderManifests({
      appName: "x",
      imageTag: "y:z",
      host: "x.127.0.0.1.sslip.io",
      contentID: "sha256:aa",
    });
    expect(yaml).toContain("kind: Ingress");
    expect(yaml).toContain("selfsigned-issuer");
    expect(yaml).toContain("  - port: 80\n");
    expect(yaml).not.toContain("namespace:");
    expect(yaml).not.toContain("imagePullSecrets");
    expect(yaml).toContain("automountServiceAccountToken: false");
  });

  it("production: namespaced, no Ingress, pull secret, no token automount, ClusterIP on 8080", () => {
    const yaml = renderManifests({
      appName: "pabc-production",
      imageTag: "us-east1-docker.pkg.dev/p/nbo/nbo-app-pabc-production:1",
      host: "",
      contentID: "sha256:aa",
      namespace: "nbo-p-x",
      ingress: false,
      pullSecret: "nbo-pull",
    });
    expect(yaml).toContain("namespace: nbo-p-x");
    expect(yaml.match(/namespace: nbo-p-x/g)).toHaveLength(2);
    expect(yaml).toContain("automountServiceAccountToken: false");
    expect(yaml).toContain("imagePullSecrets:\n      - name: nbo-pull");
    expect(yaml).not.toContain("kind: Ingress");
    expect(yaml).not.toContain("cert-manager");
    expect(yaml).not.toMatch(/type: (NodePort|LoadBalancer)/);
    expect(yaml).not.toContain("externalIPs");
    expect(yaml).toContain("  - port: 8080\n");
    expect(yaml.split("\n---\n")).toHaveLength(2);
  });

  it("gives the app container a readiness probe and a preStop sleep, in dev and production", () => {
    const variants = [
      renderManifests({ appName: "x", imageTag: "y:z", host: "x.127.0.0.1.sslip.io", contentID: "sha256:aa" }),
      renderManifests({
        appName: "x",
        imageTag: "y:z",
        host: "",
        contentID: "sha256:aa",
        namespace: "nbo-p-x",
        ingress: false,
        pullSecret: "nbo-pull",
        envSecret: "x-env",
      }),
    ];
    for (const yaml of variants) {
      const dep = parseAllDocuments(yaml)
        .map((d) => d.toJS())
        .find((d) => d.kind === "Deployment");
      const c = dep.spec.template.spec.containers[0];
      expect(c.readinessProbe.tcpSocket.port).toBe(8080);
      expect(c.readinessProbe.periodSeconds).toBe(2);
      expect(c.lifecycle.preStop.sleep.seconds).toBe(5);
    }
  });

  it("leaves function manifests without probes or lifecycle", () => {
    const yaml = renderFunctionManifests({ appName: "a", functionName: "ssr", imageTag: "x" });
    const dep = parseAllDocuments(yaml)
      .map((d) => d.toJS())
      .find((d) => d.kind === "Deployment");
    const c = dep.spec.template.spec.containers[0];
    expect(c.readinessProbe).toBeUndefined();
    expect(c.lifecycle).toBeUndefined();
  });

  it("never renders privileged or host-level pod settings", () => {
    const yaml =
      renderManifests({
        appName: "a",
        imageTag: "i",
        host: "",
        contentID: "sha256:aa",
        namespace: "nbo-p-x",
        ingress: false,
        pullSecret: "nbo-pull",
      }) +
      renderFunctionManifests({
        appName: "a",
        functionName: "ssr",
        imageTag: "i",
        namespace: "nbo-p-x",
        pullSecret: "nbo-pull",
      });
    for (const bad of ["privileged", "hostPath", "hostNetwork", "hostPID", "hostIPC", "hostPort", "capabilities"])
      expect(yaml).not.toContain(bad);
  });
});

describe("renderFunctionManifests", () => {
  it("has no Ingress and combines the app/function name", () => {
    const yaml = renderFunctionManifests({
      appName: "next-app",
      functionName: "ssr",
      imageTag: "nbo-fn-next-app-ssr:abc",
    });

    expect(yaml).not.toContain("kind: Ingress");
    expect(yaml).toContain("next-app-fn-ssr");
  });

  it("labels function pods with nbo.dev/role: function and disables token automount", () => {
    const yaml = renderFunctionManifests({ appName: "next-app", functionName: "ssr", imageTag: "x" });
    expect(yaml).toContain("nbo.dev/role: function");
    expect(yaml).toContain("automountServiceAccountToken: false");
    expect(yaml).not.toContain("namespace:");
  });

  it("production: namespaced with a pull secret", () => {
    const yaml = renderFunctionManifests({
      appName: "a",
      functionName: "ssr",
      imageTag: "x",
      namespace: "nbo-p-x",
      pullSecret: "nbo-pull",
    });
    expect(yaml.match(/namespace: nbo-p-x/g)).toHaveLength(2);
    expect(yaml).toContain("imagePullSecrets:\n      - name: nbo-pull");
  });

  it("annotates the Deployment with nbo.dev/fn-config when a config hash is given, and only then", () => {
    const yaml = renderFunctionManifests({ appName: "a", functionName: "ssr", imageTag: "x", configHash: "abc123" });
    expect(yaml).toContain(
      'kind: Deployment\nmetadata:\n  name: a-fn-ssr\n  annotations:\n    nbo.dev/fn-config: "abc123"\n',
    );
    expect(renderFunctionManifests({ appName: "a", functionName: "ssr", imageTag: "x" })).not.toContain("fn-config");
  });
});

describe("functionConfigHash", () => {
  const base = { appName: "a", functionName: "ssr", imageTag: "reg/nbo-fn-a-ssr:0123" };
  it("is hex, stable, and independent of any configHash already on the spec", () => {
    const h = functionConfigHash(base);
    expect(h).toMatch(/^[0-9a-f]{24}$/);
    expect(functionConfigHash({ ...base })).toBe(h);
    expect(functionConfigHash({ ...base, configHash: "zzz" })).toBe(h);
  });
  it("changes with anything in the rendered manifest: image, namespace, pull secret", () => {
    const h = functionConfigHash(base);
    for (const other of [
      { ...base, imageTag: "reg/nbo-fn-a-ssr:9999" },
      { ...base, namespace: "nbo-p-x" },
      { ...base, pullSecret: "nbo-pull" },
    ]) {
      expect(functionConfigHash(other)).not.toBe(h);
    }
  });
});

describe("renderNetworkPolicies", () => {
  it("denies ingress by default and only admits nbo-system and nbo-edge to the app and the app to its functions", () => {
    const yaml = renderNetworkPolicies("nbo-p-x", "pabc-production");
    expect(yaml).toContain("policyTypes: [Ingress]");
    // nbo-system: the edge before the public edge (kept so deployed projects keep working); nbo-edge: the public edge and relay.
    expect(yaml).toContain(
      "  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: nbo-system\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: nbo-edge\n",
    );
    expect(yaml).toContain("podSelector: {}");
    expect(yaml).toContain("nbo.dev/role: function");
    expect(yaml).toContain("app: pabc-production");
    expect(yaml.match(/namespace: nbo-p-x/g)).toHaveLength(4);
    expect(yaml).not.toContain("Egress");
  });
});

describe("renderPullSecret", () => {
  it("renders a dockerconfigjson Secret for the server", () => {
    const yaml = renderPullSecret("nbo-p-x", "nbo-pull", "us-east1-docker.pkg.dev", "_json_key", '{"private_key":"k"}');
    expect(yaml).toContain("type: kubernetes.io/dockerconfigjson");
    expect(yaml).toContain("namespace: nbo-p-x");
    expect(yaml).toContain("name: nbo-pull");
    expect(yaml).not.toContain("private_key");
    const b64 = /\.dockerconfigjson: (\S+)/.exec(yaml)![1]!;
    const cfg = JSON.parse(Buffer.from(b64, "base64").toString()) as {
      auths: Record<string, { username: string; password: string; auth: string }>;
    };
    const entry = cfg.auths["us-east1-docker.pkg.dev"]!;
    expect(entry.username).toBe("_json_key");
    expect(entry.password).toBe('{"private_key":"k"}');
    expect(Buffer.from(entry.auth, "base64").toString()).toBe('_json_key:{"private_key":"k"}');
  });
});

describe("kubectl calls with a tool context", () => {
  it("apply, waitForRollout and liveContentID carry --kubeconfig and -n", async () => {
    const run = recorder(() => "sha256:" + "a".repeat(64));
    const ctx = { kubeconfig: "/tmp/kc", namespace: "nbo-p-x", run };
    await apply("yaml", ctx);
    await waitForRollout("app", ctx);
    await liveContentID("app", ctx);
    expect(run.calls.map((c) => c.args.slice(0, 4))).toEqual([
      ["--kubeconfig", "/tmp/kc", "-n", "nbo-p-x"],
      ["--kubeconfig", "/tmp/kc", "-n", "nbo-p-x"],
      ["--kubeconfig", "/tmp/kc", "-n", "nbo-p-x"],
    ]);
    expect(run.calls[0]!.input).toBe("yaml");
    expect(run.calls.every((c) => c.cmd === "kubectl")).toBe(true);
  });

  it("liveContentID ignores kubectl warning lines merged into the output", async () => {
    const id = "sha256:" + "b".repeat(64);
    const run = recorder(() => `Warning: client version skew\n${id}\n`);
    await expect(liveContentID("app", { run })).resolves.toEqual({ id, ok: true });
  });

  it("liveContentID treats warnings without an annotation as not live", async () => {
    const run = recorder(() => "Warning: something deprecated\n");
    await expect(liveContentID("app", { run })).resolves.toEqual({ id: "", ok: false });
  });

  it("liveContentID treats NotFound as not live", async () => {
    const run = recorder(() => new Error('Error from server (NotFound): deployments.apps "app" not found'));
    await expect(liveContentID("app", { run })).resolves.toEqual({ id: "", ok: false });
  });
});

describe("liveFunctionState", () => {
  // image, fn-config, generation, observedGeneration, replicas, updatedReplicas, availableReplicas
  const line = (...f: string[]) => f.join("\t");

  it("reads image, config and rollout health in one call, scoped by the tool context", async () => {
    const run = recorder(() => line("reg/x/nbo-fn-a-ssr:0123", "cfg1", "3", "3", "1", "1", "1"));
    await expect(liveFunctionState("a-fn-ssr", { kubeconfig: "/tmp/kc", namespace: "nbo-p-x", run })).resolves.toEqual({
      image: "reg/x/nbo-fn-a-ssr:0123",
      config: "cfg1",
      healthy: true,
    });
    const args = run.calls[0]!.args;
    expect(args.slice(0, 7)).toEqual(["--kubeconfig", "/tmp/kc", "-n", "nbo-p-x", "get", "deployment", "a-fn-ssr"]);
    expect(args[8]).toContain("{.spec.template.spec.containers[0].image}");
    expect(args[8]).toContain("{.metadata.annotations.nbo\\.dev/fn-config}");
    expect(args[8]).toContain("{.status.observedGeneration}");
    expect(args[8]).toContain("{.status.availableReplicas}");
  });

  it("ignores kubectl warning lines merged into the output", async () => {
    const run = recorder(() => `Warning: client version skew\n${line("img:1", "c", "1", "1", "1", "1", "1")}\n`);
    await expect(liveFunctionState("a-fn-ssr", { run })).resolves.toEqual({
      image: "img:1",
      config: "c",
      healthy: true,
    });
  });

  it("is unhealthy while the controller has not observed the latest generation", async () => {
    const run = recorder(() => line("img:1", "c", "4", "3", "1", "1", "1"));
    await expect(liveFunctionState("x", { run })).resolves.toMatchObject({ healthy: false });
  });

  it("is unhealthy when a rollout has not finished (timed out: new ReplicaSet not available)", async () => {
    for (const [replicas, updated, available] of [
      ["1", "1", ""],
      ["1", "", "1"],
      ["2", "2", "1"],
      ["1", "0", "1"],
      ["0", "0", "0"],
    ]) {
      const run = recorder(() => line("img:1", "c", "2", "2", replicas!, updated!, available!));
      await expect(liveFunctionState("x", { run }), `${replicas}/${updated}/${available}`).resolves.toMatchObject({
        healthy: false,
      });
    }
  });

  it("reports an empty config for a Deployment without the annotation", async () => {
    const run = recorder(() => line("img:1", "", "1", "1", "1", "1", "1"));
    await expect(liveFunctionState("x", { run })).resolves.toEqual({ image: "img:1", config: "", healthy: true });
  });

  it("is undefined when the Deployment does not exist, kubectl fails, or the output has no state line", async () => {
    await expect(
      liveFunctionState("a-fn-ssr", {
        run: recorder(() => new Error('Error from server (NotFound): deployments.apps "a-fn-ssr" not found')),
      }),
    ).resolves.toBeUndefined();
    await expect(
      liveFunctionState("a-fn-ssr", { run: recorder(() => new Error("Unable to connect to the server")) }),
    ).resolves.toBeUndefined();
    await expect(
      liveFunctionState("a-fn-ssr", { run: recorder(() => "Warning: only a warning\n") }),
    ).resolves.toBeUndefined();
  });
});

describe("pushImage", () => {
  it("tags and pushes with the context's env", async () => {
    const run = recorder();
    await pushImage("local:1", "reg/x/nbo-app-a:1", { env: { DOCKER_CONFIG: "/tmp/d" }, run });
    expect(run.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual([
      "docker tag local:1 reg/x/nbo-app-a:1",
      "docker push reg/x/nbo-app-a:1",
    ]);
    expect(run.calls.every((c) => c.env?.DOCKER_CONFIG === "/tmp/d")).toBe(true);
  });
});

describe("environment fingerprint", () => {
  const app = { appName: "a", imageTag: "i", host: "", contentID: "sha256:aa", namespace: "nbo-p-x", ingress: false };

  it("renderManifests annotates the Deployment and its pods with nbo.dev/env-fingerprint, only when given", () => {
    const yaml = renderManifests({ ...app, envFingerprint: "f00d" });
    expect(yaml.match(/nbo\.dev\/env-fingerprint: "f00d"/g)).toHaveLength(2);
    expect(renderManifests(app)).not.toContain("env-fingerprint");
  });

  it("function manifests carry the fingerprint, so it changes the config hash; absent leaves the hash unchanged", () => {
    const fn = { appName: "a", functionName: "ssr", imageTag: "reg/nbo-fn-a-ssr:0123" };
    const h = functionConfigHash(fn);
    expect(functionConfigHash({ ...fn, envFingerprint: undefined })).toBe(h);
    expect(functionConfigHash({ ...fn, envFingerprint: "f00d" })).not.toBe(h);
    expect(functionConfigHash({ ...fn, envFingerprint: "beef" })).not.toBe(
      functionConfigHash({ ...fn, envFingerprint: "f00d" }),
    );
    expect(renderFunctionManifests({ ...fn, envFingerprint: "f00d" })).toContain('nbo.dev/env-fingerprint: "f00d"');
  });

  it("liveContentID reads the fingerprint next to the content id in one call", async () => {
    const id = "sha256:" + "c".repeat(64);
    const run = recorder(() => `Warning: skew\n${id}\tf00d\n`);
    await expect(liveContentID("app", { run })).resolves.toEqual({ id, ok: true, fingerprint: "f00d" });
    expect(run.calls[0]!.args.join(" ")).toContain("nbo\\.dev/env-fingerprint");
  });

  it("liveContentID reports no fingerprint when the annotation is absent", async () => {
    const id = "sha256:" + "c".repeat(64);
    const run = recorder(() => `${id}\t\n`);
    const got = await liveContentID("app", { run });
    expect(got).toEqual({ id, ok: true });
    expect(got.fingerprint).toBeUndefined();
  });
});

describe("environment Secret", () => {
  const vars = { PLAIN: "a=b,c", MULTI: "line1\nline2 \"q\" 'r'", UTF: "héllo ✓ 日本" };
  const decode = (yaml: string) => {
    const data: Record<string, string> = {};
    for (const m of yaml.matchAll(/^ {2}"([A-Z_]+)": (\S+)$/gm))
      data[m[1]!] = Buffer.from(m[2]!, "base64").toString("utf8");
    return data;
  };

  it("renders an Opaque Secret whose base64 data round-trips every value byte-exactly", () => {
    const yaml = renderEnvSecret("app-env", vars, "nbo-p-x");
    expect(yaml).toContain("kind: Secret");
    expect(yaml).toContain("name: app-env");
    expect(yaml).toContain("namespace: nbo-p-x");
    expect(yaml).toContain("type: Opaque");
    expect(decode(yaml)).toEqual(vars);
    expect(yaml).not.toContain("héllo");
  });

  it("quotes keys so YAML 1.1 booleans/null (YES, ON, NULL, N) stay string names", () => {
    const yaml = renderEnvSecret("app-env", { YES: "1", ON: "2", NULL: "3", N: "4" });
    expect(yaml).toContain('  "YES": ');
    expect(yaml).toContain('  "ON": ');
    expect(yaml).toContain('  "NULL": ');
    expect(yaml).toContain('  "N": ');
    expect(yaml).not.toMatch(/^ {2}(YES|ON|NULL|N):/m);
    expect(decode(yaml)).toEqual({ YES: "1", ON: "2", NULL: "3", N: "4" });
  });

  it("has no namespace line without a namespace, and omits removed names", () => {
    const yaml = renderEnvSecret("app-env", { KEEP: "1" });
    expect(yaml).not.toContain("namespace:");
    expect(Object.keys(decode(yaml))).toEqual(["KEEP"]);
  });

  // optional: an old pod restarting after a failed rollout that deleted or
  // replaced the Secret must not stick in CreateContainerConfigError.
  it("envSecret adds an optional envFrom to the app and function Deployments only when given", () => {
    const app = { appName: "a", imageTag: "i", host: "h", contentID: "sha256:1" };
    expect(renderManifests({ ...app, envSecret: "a-env" })).toContain(
      "envFrom:\n        - secretRef:\n            name: a-env\n            optional: true",
    );
    expect(renderManifests(app)).not.toContain("envFrom");
    const fn = { appName: "a", functionName: "f", imageTag: "i" };
    expect(renderFunctionManifests({ ...fn, envSecret: "a-env" })).toContain(
      "envFrom:\n        - secretRef:\n            name: a-env\n            optional: true",
    );
    expect(renderFunctionManifests(fn)).not.toContain("envFrom");
    expect(functionConfigHash({ ...fn, envSecret: "a-env" })).not.toBe(functionConfigHash(fn));
  });

  it("deleteEnvSecret ignores not-found and carries the kubectl scope", async () => {
    const run = recorder();
    await deleteEnvSecret("a-env", { kubeconfig: "/kc", namespace: "nbo-p-x", run });
    expect(run.calls[0]!.args).toEqual([
      "--kubeconfig",
      "/kc",
      "-n",
      "nbo-p-x",
      "delete",
      "secret",
      "a-env",
      "--ignore-not-found",
    ]);
  });
});

// expectShortNames: every name, app label and nbo.dev/app label in rendered YAML fits 63 characters.
function expectShortNames(yaml: string): void {
  for (const line of yaml.split("\n")) {
    const m = /^\s*(?:name|app|nbo\.dev\/app): (\S+)$/.exec(line);
    if (m) expect(m[1]!.length).toBeLessThanOrEqual(63);
  }
}

describe("object names within 63 characters", () => {
  const app = "p0123abcd-k8s-a-very-long-cluster-name-x"; // 40 chars
  const fn = "app-dashboard-settings-page-route";

  it("leaves a name of 63 characters or fewer unchanged", () => {
    expect(kubeName("pabc-production-fn-ssr")).toBe("pabc-production-fn-ssr");
    const exactly63 = "a".repeat(63);
    expect(kubeName(exactly63)).toBe(exactly63);
    expect(functionObjectName("pabc-production", "ssr")).toBe("pabc-production-fn-ssr");
  });

  it("shortens a longer name to 54 characters, a dash and 8 hex of its hash, stable and distinct", () => {
    const long = `${app}-fn-${fn}`;
    expect(long.length).toBeGreaterThan(63);
    const short = kubeName(long);
    expect(short.length).toBeLessThanOrEqual(63);
    expect(short).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(short).toMatch(/-[0-9a-f]{8}$/);
    expect(short.startsWith(long.slice(0, 50))).toBe(true);
    expect(kubeName(long)).toBe(short);
    expect(kubeName(`${long}x`)).not.toBe(short);
    expect(functionObjectName(app, fn)).toBe(short);
  });

  it("drops dashes left at the cut", () => {
    const name = `${"a".repeat(53)}--${"b".repeat(20)}`;
    expect(kubeName(name)).toMatch(new RegExp(`^${"a".repeat(53)}-[0-9a-f]{8}$`));
  });

  it("function manifests use the short name for the Deployment, Service and selector labels", () => {
    const out = renderFunctionManifests({ appName: app, functionName: fn, imageTag: "img:1" });
    const name = functionObjectName(app, fn);
    expect(out).not.toContain(`${app}-fn-${fn}`);
    expect(out.split("\n").filter((l) => l.trim() === `name: ${name}` || l.trim() === `app: ${name}`)).toHaveLength(5);
    expectShortNames(out);
  });

  it("network policy and secret names stay within 63 characters", () => {
    const longApp = "p0123abcd-" + "x".repeat(50);
    const policies = renderNetworkPolicies("nbo-p-0123abcd", longApp);
    expect(policies).toContain(`name: ${kubeName(`${longApp}-from-edge`)}`);
    expect(policies).toContain(`name: ${kubeName(`${longApp}-to-functions`)}`);
    expect(policies).toContain(`name: ${kubeName(`${longApp}-to-isrcache`)}`);
    expectShortNames(policies);
  });
});

describe("ISR cache objects", () => {
  it("isrcacheObjectName is <app>-isr, shortened by kubeName", () => {
    expect(isrcacheObjectName("pabc-production")).toBe("pabc-production-isr");
    const long = "p0123abcd-" + "x".repeat(50); // 60 characters
    expect(isrcacheObjectName(long)).toBe(kubeName(`${long}-isr`));
    expect(isrcacheObjectName(long).length).toBeLessThanOrEqual(63);
  });

  it("renders the cache Deployment and Service as the spec pins them", () => {
    const yaml = renderIsrcacheManifests({
      appName: "pabc-production",
      imageTag: "reg/nbo-isrcache:0123456789ab",
      namespace: "nbo-p-abc",
      pullSecret: "nbo-pull",
    });
    const docs = parseAllDocuments(yaml).map((d) => d.toJS());
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "Service"]);
    const [dep, svc] = docs;
    expect(dep.metadata).toEqual({
      name: "pabc-production-isr",
      namespace: "nbo-p-abc",
      labels: { app: "pabc-production-isr", "nbo.dev/role": "isrcache", "nbo.dev/app": "pabc-production" },
    });
    expect(dep.spec.replicas).toBe(1);
    expect(dep.spec.selector).toEqual({ matchLabels: { app: "pabc-production-isr" } });
    expect(dep.spec.template.metadata.labels).toEqual({
      app: "pabc-production-isr",
      "nbo.dev/role": "isrcache",
      "nbo.dev/app": "pabc-production",
    });
    const pod = dep.spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.imagePullSecrets).toEqual([{ name: "nbo-pull" }]);
    expect(pod.containers).toHaveLength(1);
    const c = pod.containers[0];
    expect(c.image).toBe("reg/nbo-isrcache:0123456789ab");
    expect(c.ports).toEqual([{ containerPort: 8080 }]);
    expect(c.env).toEqual([{ name: "NBO_ISRCACHE_MAX_BYTES", value: "100663296" }]);
    expect(c.resources).toEqual({ requests: { cpu: "10m", memory: "64Mi" }, limits: { memory: "256Mi" } });
    expect(c.readinessProbe.httpGet).toEqual({ path: "/healthz", port: 8080 });
    expect(c.livenessProbe.httpGet).toEqual({ path: "/healthz", port: 8080 });
    expect(c.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(c.envFrom).toBeUndefined();
    expect(svc.metadata).toEqual({
      name: "pabc-production-isr",
      namespace: "nbo-p-abc",
      labels: { app: "pabc-production-isr", "nbo.dev/role": "isrcache", "nbo.dev/app": "pabc-production" },
    });
    expect(svc.spec).toEqual({ selector: { app: "pabc-production-isr" }, ports: [{ port: 8080, targetPort: 8080 }] });
    expect(yaml).not.toMatch(/privileged|hostNetwork|hostPath|hostPID/);
  });

  it("dev: no namespace line and no pull secret", () => {
    const yaml = renderIsrcacheManifests({ appName: "pabc-k8s", imageTag: "nbo-isrcache:0123456789ab" });
    expect(yaml).not.toContain("namespace:");
    expect(yaml).not.toContain("imagePullSecrets");
  });

  it("a 60-character app name is shortened alike in Deployment, Service, selector and labels", () => {
    const long = "p0123abcd-" + "x".repeat(50);
    const name = isrcacheObjectName(long);
    expect(name).not.toBe(`${long}-isr`);
    const yaml = renderIsrcacheManifests({ appName: long, imageTag: "nbo-isrcache:0123456789ab" });
    expect(yaml).not.toContain(`${long}-isr`);
    const [dep, svc] = parseAllDocuments(yaml).map((d) => d.toJS());
    expect(dep.metadata.name).toBe(name);
    expect(dep.metadata.labels.app).toBe(name);
    expect(dep.spec.selector.matchLabels.app).toBe(name);
    expect(dep.spec.template.metadata.labels.app).toBe(name);
    expect(dep.spec.template.metadata.labels["nbo.dev/app"]).toBe(long);
    expect(svc.metadata.name).toBe(name);
    expect(svc.spec.selector.app).toBe(name);
    expectShortNames(yaml);
  });

  it("deleteIsrcache deletes only objects with the cache name AND this app's cache labels, scoped by the tool context", async () => {
    const run = recorder();
    await deleteIsrcache("pabc-production", { kubeconfig: "/kc", namespace: "nbo-p-abc", run });
    expect(run.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual([
      "kubectl --kubeconfig /kc -n nbo-p-abc delete deployment,service -l nbo.dev/role=isrcache,nbo.dev/app=pabc-production --field-selector metadata.name=pabc-production-isr --ignore-not-found",
    ]);
    expect(isrcacheDeleteArgs("pabc-production")).toEqual([
      "delete",
      "deployment,service",
      "-l",
      "nbo.dev/role=isrcache,nbo.dev/app=pabc-production",
      "--field-selector",
      "metadata.name=pabc-production-isr",
      "--ignore-not-found",
    ]);
  });

  describe("isrcacheNameTaken", () => {
    // Stage a (app pabc-s-a-k8s) has a function x-k8s-isr; stage a-k8s-fn-x's cache has that same name.
    const app = "pabc-s-a-k8s-fn-x-k8s";
    const name = `${app}-isr`;
    it("names a live object with the cache's name that isn't this app's cache", async () => {
      const run = recorder(() => `Warning: skew\nDeployment\t${name}\t\t\nService\t${name}\t\t\n`);
      expect(await isrcacheNameTaken(app, { kubeconfig: "/kc", namespace: "nbo-p-abc", run })).toBe(
        `Deployment ${name}`,
      );
      const args = run.calls[0]!.args;
      expect(args.slice(0, 8)).toEqual([
        "--kubeconfig",
        "/kc",
        "-n",
        "nbo-p-abc",
        "get",
        "deployment,service",
        name,
        "--ignore-not-found",
      ]);
    });
    it("names one labelled as another app's cache", async () => {
      const run = recorder(() => `Deployment\t${name}\tisrcache\tpother\n`);
      expect(await isrcacheNameTaken(app, { run })).toBe(`Deployment ${name}`);
    });
    it("is undefined when nothing has the name, or only this app's cache does", async () => {
      expect(await isrcacheNameTaken(app, { run: recorder(() => "") })).toBeUndefined();
      expect(
        await isrcacheNameTaken(app, {
          run: recorder(() => `Deployment\t${name}\tisrcache\t${app}\nService\t${name}\tisrcache\t${app}\n`),
        }),
      ).toBeUndefined();
    });
    it("throws when the cluster can't be read", async () => {
      await expect(isrcacheNameTaken(app, { run: recorder(() => new Error("Unable to connect")) })).rejects.toThrow(
        /Unable to connect/,
      );
    });
  });

  it("renderNetworkPolicies admits only the app's pods to its cache", () => {
    const docs = parseAllDocuments(renderNetworkPolicies("nbo-p-x", "pabc-production")).map((d) => d.toJS());
    const pol = docs.find((d) => d.metadata.name === "pabc-production-to-isrcache");
    expect(pol).toEqual({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "pabc-production-to-isrcache", namespace: "nbo-p-x" },
      spec: {
        podSelector: { matchLabels: { "nbo.dev/role": "isrcache", "nbo.dev/app": "pabc-production" } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ podSelector: { matchLabels: { app: "pabc-production" } } }] }],
      },
    });
  });
});
