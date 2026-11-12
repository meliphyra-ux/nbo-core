// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createStore } from "../store.js";
import { createCloudTeardown } from "../cloud-teardown.js";
import type { CommandRunner } from "../cloud-setup.js";
import { serviceIdentityId } from "@nbo/deploy";

function recorder(answers: Record<string, string | Error> = {}): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    for (const [prefix, answer] of Object.entries(answers)) {
      if (key.startsWith(prefix)) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    return "";
  }) as CommandRunner & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("cloud teardown", () => {
  it("kubernetes: deletes the app's deployment, service and ingress, then its function deployments", async () => {
    const run = recorder({
      "kubectl --context kind-nbo-local get deployments -o name": "deployment.apps/pabc-k8s\ndeployment.apps/pabc-k8s-fn-ssr\ndeployment.apps/pother-k8s\n",
    });
    await createCloudTeardown(run).remove({ target: "kubernetes", appName: "pabc-k8s", config: {} });
    expect(run.calls).toEqual([
      "kubectl --context kind-nbo-local delete deployment,service,ingress pabc-k8s --ignore-not-found",
      "kubectl --context kind-nbo-local delete deployment,service -l nbo.dev/role=isrcache,nbo.dev/app=pabc-k8s --field-selector metadata.name=pabc-k8s-isr --ignore-not-found",
      "kubectl --context kind-nbo-local get deployments -o name",
      "kubectl --context kind-nbo-local delete deployment,service pabc-k8s-fn-ssr --ignore-not-found",
    ]);
  });

  it("cloudrun: deletes the app service and its function services in that project/region only", async () => {
    const run = recorder({
      "gcloud run services list": "pabc-cloudrun\npabc-cloudrun-fn-ssr\npabc-cloudrun-isr\npother-cloudrun\npother-cloudrun-isr\n",
      "gcloud run services describe pabc-cloudrun-isr": JSON.stringify({ metadata: { labels: { "nbo-role": "isrcache", "nbo-app": "pabc-cloudrun" } } }),
      "gcloud secrets list": "projects/1/secrets/nbo-pabc-cloudrun-0123456789abcdef\nprojects/1/secrets/nbo-pother-cloudrun-0123456789abcdef\n",
    });
    await createCloudTeardown(run).remove({ target: "cloudrun", appName: "pabc-cloudrun", config: { project: "my-proj-1", region: "us-east1" } });
    expect(run.calls).toEqual([
      "gcloud run services list --project my-proj-1 --region us-east1 --format=value(metadata.name)",
      "gcloud run services delete pabc-cloudrun --project my-proj-1 --region us-east1 --quiet",
      "gcloud run services delete pabc-cloudrun-fn-ssr --project my-proj-1 --region us-east1 --quiet",
      "gcloud run services describe pabc-cloudrun-isr --project my-proj-1 --region us-east1 --format=json",
      "gcloud run services delete pabc-cloudrun-isr --project my-proj-1 --region us-east1 --quiet",
      "gcloud secrets list --filter=name~nbo-pabc-cloudrun- --format=value(name) --project my-proj-1",
      "gcloud secrets delete nbo-pabc-cloudrun-0123456789abcdef --project my-proj-1 --quiet",
    ]);
  });

  describe("Cloud Run in production removes domain mappings first", () => {
    const KEY = JSON.stringify({ type: "service_account", client_email: "d@p.iam.gserviceaccount.com", private_key: "PRIVKEY-SECRET-BODY" });
    async function prod() {
      const dir = await mkdtemp(join(tmpdir(), "teardown-dm-"));
      const store = createStore(join(dir, "t.db"), { secretKey: randomBytes(32) });
      store.saveGoogleConnection({ project: "p", region: "us-east1", arRepo: "r", deployer: "d@p.iam.gserviceaccount.com", puller: "u@p.iam.gserviceaccount.com" }, { deployerKey: KEY, pullerKey: "{}" });
      const project = store.createProject("shop");
      const mapped = store.addDomain(project.id, "shop.example.com", "custom", "cloudrun");
      const kept = store.addDomain(project.id, "kept.example.com", "custom");
      store.updateDomain(kept.id, { mappingKept: true, mappingRemoveAfter: "2026-11-07T10:00:00.000Z", mappingRecords: [{ type: "CNAME", name: "kept", value: "ghs.googlehosted.com." }] });
      const plain = store.addDomain(project.id, "plain.example.com", "custom");
      const target = { target: "cloudrun", appName: "pabc-cloudrun", projectId: project.id, config: { project: "my-proj-1", region: "us-east1" } };
      return { store, project, mapped, kept, plain, target, close: () => { store.close(); return rm(dir, { recursive: true, force: true }); } };
    }
    const dm = (run: ReturnType<typeof recorder>) => run.calls.filter((c) => c.includes("domain-mappings"));

    it("deletes each mapping before the services, drops Cloud Run rows and clears kept flags", async () => {
      const t = await prod();
      try {
        const run = recorder({ "gcloud run services list": "pabc-cloudrun\n" });
        await createCloudTeardown(run, { mode: "production", store: t.store }).remove(t.target);
        expect(dm(run)).toEqual([
          "gcloud beta run domain-mappings delete --domain shop.example.com --project my-proj-1 --region us-east1 --quiet",
          "gcloud beta run domain-mappings delete --domain kept.example.com --project my-proj-1 --region us-east1 --quiet",
        ]);
        const firstDelete = run.calls.findIndex((c) => c.startsWith("gcloud run services delete"));
        expect(run.calls.findIndex((c) => c.includes("domain-mappings"))).toBeLessThan(firstDelete);
        expect(t.store.listDomains(t.project.id).map((d) => d.host)).toEqual(["kept.example.com", "plain.example.com"]);
        expect(t.store.getDomain(t.kept.id)).toMatchObject({ mappingKept: false, mappingRemoveAfter: "", mappingRecords: [] });
      } finally {
        await t.close();
      }
    });

    it("treats a mapping that is already gone as removed", async () => {
      const t = await prod();
      try {
        const run = recorder({ "gcloud beta run domain-mappings delete": new Error("ERROR: (gcloud.beta.run.domain-mappings.delete) Domain mapping shop.example.com not found.") });
        await createCloudTeardown(run, { mode: "production", store: t.store }).remove(t.target);
        expect(t.store.listDomains(t.project.id).map((d) => d.host)).toEqual(["kept.example.com", "plain.example.com"]);
      } finally {
        await t.close();
      }
    });

    it("treats unknown wording as removed when the list doesn't name the host", async () => {
      const t = await prod();
      try {
        const run = recorder({ "gcloud beta run domain-mappings delete": new Error("ERROR: (gcloud.beta.run.domain-mappings.delete) HTTPError 404"), "gcloud beta run domain-mappings list": "other.example.com\n" });
        await createCloudTeardown(run, { mode: "production", store: t.store }).remove(t.target);
        expect(dm(run)).toContain("gcloud beta run domain-mappings list --project my-proj-1 --region us-east1 --format=value(metadata.name)");
        expect(t.store.listDomains(t.project.id).map((d) => d.host)).toEqual(["kept.example.com", "plain.example.com"]);
      } finally {
        await t.close();
      }
    });

    // The step's wrapper says "domain mapping" itself, so "not found" from
    // anywhere in the text used to read as a missing mapping.
    it.each([
      ["the list names the host", "shop.example.com\n"],
      ["the list fails", new Error("list exploded")],
    ])("stops on a project that isn't found when %s", async (_name, listed) => {
      const t = await prod();
      try {
        const run = recorder({ "gcloud beta run domain-mappings delete": new Error("ERROR: (gcloud.beta.run.domain-mappings.delete) Project my-proj-1 not found"), "gcloud beta run domain-mappings list": listed });
        const err = await createCloudTeardown(run, { mode: "production", store: t.store }).remove(t.target).then(
          () => null,
          (e: Error) => e,
        );
        expect(err?.message).toContain("Cloud Run: removing the domain mapping of shop.example.com failed");
        expect(err?.message).toContain("Project my-proj-1 not found");
        expect(run.calls.some((c) => c.startsWith("gcloud run services delete"))).toBe(false);
        expect(t.store.getDomain(t.mapped.id).host).toBe("shop.example.com");
      } finally {
        await t.close();
      }
    });

    it("throws, redacted, on another failure and leaves the rows and the services", async () => {
      const t = await prod();
      try {
        const run = recorder({ "gcloud beta run domain-mappings delete": new Error("boom PRIVKEY-SECRET-BODY"), "gcloud beta run domain-mappings list": "shop.example.com\nkept.example.com\n" });
        const err = await createCloudTeardown(run, { mode: "production", store: t.store }).remove(t.target).then(
          () => null,
          (e: Error) => e,
        );
        expect(err).not.toBeNull();
        expect(err!.message).toContain("domain mapping");
        expect(err!.message).not.toContain("PRIVKEY-SECRET-BODY");
        expect(run.calls.some((c) => c.startsWith("gcloud run services delete"))).toBe(false);
        expect(t.store.getDomain(t.mapped.id).host).toBe("shop.example.com");
        expect(t.store.getDomain(t.kept.id).mappingKept).toBe(true);
      } finally {
        await t.close();
      }
    });
  });

  describe("scope app (one environment of a project)", () => {
    const KEY = JSON.stringify({ type: "service_account", client_email: "d@p.iam.gserviceaccount.com", private_key: "PRIVKEY-SECRET-BODY" });
    async function prodStore() {
      const dir = await mkdtemp(join(tmpdir(), "teardown-app-"));
      const store = createStore(join(dir, "t.db"), { secretKey: randomBytes(32) });
      return { store, close: () => { store.close(); return rm(dir, { recursive: true, force: true }); } };
    }
    // kubectl calls without the temporary kubeconfig path.
    function kubeRecorder(deploymentsJson: string): CommandRunner & { calls: string[] } {
      const calls: string[] = [];
      const fn = (async (cmd: string, args: string[]) => {
        const i = args.indexOf("--kubeconfig");
        const rest = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
        const key = [cmd, ...rest].join(" ");
        calls.push(key);
        if (key.includes(" get deployments")) return deploymentsJson;
        return "";
      }) as CommandRunner & { calls: string[] };
      fn.calls = calls;
      return fn;
    }
    const dep = (name: string, labels: Record<string, string>) => ({ metadata: { name }, spec: { template: { metadata: { labels } } } });

    it("production Kubernetes deletes only the app's objects, never the namespace or shared ones", async () => {
      const t = await prodStore();
      try {
        const cid = t.store.saveKubernetesConnection({ name: "prod", server: "https://k8s.example:6443", registry: { kind: "custom", server: "ghcr.io", username: "bot" } }, { kubeconfig: "KUBECONFIG", registryPassword: "pw" }).id;
        const app = "pabc12345-s-staging-k8s";
        const listed = JSON.stringify({
          items: [
            dep(app, { app }),
            dep(`${app}-fn-ssr`, { app: `${app}-fn-ssr`, "nbo.dev/role": "function", "nbo.dev/app": app }),
            dep("pabc12345-k8s", { app: "pabc12345-k8s" }),
            dep("pabc12345-k8s-fn-ssr", { app: "pabc12345-k8s-fn-ssr", "nbo.dev/role": "function", "nbo.dev/app": "pabc12345-k8s" }),
            // Another environment's app whose name starts like a function of this one.
            dep(`${app}-fn-x-k8s`, { app: `${app}-fn-x-k8s` }),
          ],
        });
        const run = kubeRecorder(listed);
        await createCloudTeardown(run, { mode: "production", store: t.store }).remove({ target: "kubernetes", appName: app, projectId: "proj_abc12345ffff", config: { clusterId: cid }, scope: "app" });
        expect(run.calls.some((c) => c.includes("namespace"))).toBe(false);
        const deletes = run.calls.filter((c) => c.includes(" delete "));
        expect(deletes).toEqual([
          `kubectl -n nbo-p-abc12345 delete deployment,service ${app} --ignore-not-found`,
          `kubectl -n nbo-p-abc12345 delete deployment,service -l nbo.dev/role=isrcache,nbo.dev/app=${app} --field-selector metadata.name=${app}-isr --ignore-not-found`,
          `kubectl -n nbo-p-abc12345 delete secret ${app}-env --ignore-not-found`,
          `kubectl -n nbo-p-abc12345 delete networkpolicy ${app}-from-edge ${app}-to-functions ${app}-to-isrcache --ignore-not-found`,
          `kubectl -n nbo-p-abc12345 delete deployment,service ${app}-fn-ssr --ignore-not-found`,
        ]);
        for (const c of deletes) {
          // The cache delete selects by labels and name: its positional names are none.
          const names = c.replace(/ --ignore-not-found$/, "").replace(/ -l \S+ --field-selector metadata\.name=/, " ").split(" ").slice(5);
          for (const n of names) expect(n.startsWith(app)).toBe(true);
        }
        expect(run.calls.join("\n")).not.toContain("nbo-default-deny-ingress");
      } finally {
        await t.close();
      }
    });

    it("scope project (the default) still deletes the namespace", async () => {
      const t = await prodStore();
      try {
        const cid = t.store.saveKubernetesConnection({ name: "prod", server: "https://k8s.example:6443", registry: { kind: "custom", server: "ghcr.io", username: "bot" } }, { kubeconfig: "KUBECONFIG", registryPassword: "pw" }).id;
        const run = kubeRecorder("{}");
        await createCloudTeardown(run, { mode: "production", store: t.store }).remove({ target: "kubernetes", appName: "pabc12345-k8s", projectId: "proj_abc12345ffff", config: { clusterId: cid } });
        expect(run.calls).toEqual(["kubectl delete namespace nbo-p-abc12345 --ignore-not-found --wait=false"]);
      } finally {
        await t.close();
      }
    });

    it("production Cloud Run leaves the project's domain mappings alone", async () => {
      const t = await prodStore();
      try {
        t.store.saveGoogleConnection({ project: "p", region: "us-east1", arRepo: "r", deployer: "d@p.iam.gserviceaccount.com", puller: "u@p.iam.gserviceaccount.com" }, { deployerKey: KEY, pullerKey: "{}" });
        const project = t.store.createProject("shop");
        const mapped = t.store.addDomain(project.id, "shop.example.com", "custom", "cloudrun");
        const run = recorder({
          "gcloud run services list": "pabc-cloudrun\npabc-cloudrun-isr\npabc-s-staging-cr\npabc-s-staging-cr-fn-ssr\npabc-s-staging-cr-isr\n",
          "gcloud run services describe pabc-s-staging-cr-isr": JSON.stringify({ metadata: { labels: { "nbo-role": "isrcache", "nbo-app": "pabc-s-staging-cr" } } }),
        });
        await createCloudTeardown(run, { mode: "production", store: t.store }).remove({
          target: "cloudrun",
          appName: "pabc-s-staging-cr",
          projectId: project.id,
          config: { project: "my-proj-1", region: "us-east1" },
          scope: "app",
        });
        expect(run.calls.some((c) => c.includes("domain-mappings"))).toBe(false);
        expect(t.store.getDomain(mapped.id).host).toBe("shop.example.com");
        expect(run.calls.filter((c) => c.startsWith("gcloud run services delete"))).toEqual([
          "gcloud run services delete pabc-s-staging-cr --project my-proj-1 --region us-east1 --quiet",
          "gcloud run services delete pabc-s-staging-cr-fn-ssr --project my-proj-1 --region us-east1 --quiet",
          "gcloud run services delete pabc-s-staging-cr-isr --project my-proj-1 --region us-east1 --quiet",
        ]);
        // Each deleted service's own account goes too, the cache's included; never Production's cache.
        const accounts = run.calls.filter((c) => c.startsWith("gcloud iam service-accounts delete"));
        expect(accounts).toHaveLength(3);
        expect(accounts[2]).toContain(`${serviceIdentityId("pabc-s-staging-cr-isr")}@my-proj-1.iam.gserviceaccount.com`);
        expect(run.calls.some((c) => c.includes("pabc-cloudrun-isr ") || c.includes(serviceIdentityId("pabc-cloudrun-isr")))).toBe(false);
      } finally {
        await t.close();
      }
    });
  });

  describe("another app of the project whose name starts like this app's functions", () => {
    // Stage "a" and a (no longer allowed, but older or crafted) stage "a-cr-fn-x":
    // the second's app starts with the first's function prefix.
    const app = "pabc-s-a-cr";
    const sibling = "pabc-s-a-cr-fn-x-cr";

    it("Cloud Run keeps the sibling's services", async () => {
      const run = recorder({ "gcloud run services list": `${app}\n${app}-fn-ssr\n${sibling}\n${sibling}-fn-ssr\n` });
      await createCloudTeardown(run).remove({ target: "cloudrun", appName: app, config: { project: "my-proj-1", region: "us-east1" }, scope: "app", keep: [sibling] });
      expect(run.calls.filter((c) => c.startsWith("gcloud run services delete"))).toEqual([
        `gcloud run services delete ${app} --project my-proj-1 --region us-east1 --quiet`,
        `gcloud run services delete ${app}-fn-ssr --project my-proj-1 --region us-east1 --quiet`,
      ]);
    });

    it("dev Kubernetes keeps the sibling's function deployments", async () => {
      const k = "pabc-s-a-k8s";
      const sib = "pabc-s-a-k8s-fn-x-k8s";
      const run = recorder({ "kubectl --context kind-nbo-local get deployments -o name": `deployment.apps/${k}\ndeployment.apps/${k}-fn-ssr\ndeployment.apps/${sib}\ndeployment.apps/${sib}-fn-ssr\n` });
      await createCloudTeardown(run).remove({ target: "kubernetes", appName: k, config: {}, scope: "app", keep: [sib] });
      expect(run.calls.filter((c) => c.includes(" delete "))).toEqual([
        `kubectl --context kind-nbo-local delete deployment,service,ingress ${k} --ignore-not-found`,
        `kubectl --context kind-nbo-local delete deployment,service -l nbo.dev/role=isrcache,nbo.dev/app=${k} --field-selector metadata.name=${k}-isr --ignore-not-found`,
        `kubectl --context kind-nbo-local delete deployment,service ${k}-fn-ssr --ignore-not-found`,
      ]);
    });
  });

  describe("the ISR cache <app>-isr", () => {
    it("Cloud Run keeps a service of that name that isn't this app's cache", async () => {
      for (const labels of [{}, { "nbo-role": "function" }, { "nbo-role": "isrcache", "nbo-app": "pother-cr" }, { "nbo-app": "pabc-cr" }]) {
        const run = recorder({
          "gcloud run services list": "pabc-cr\npabc-cr-isr\n",
          "gcloud run services describe pabc-cr-isr": `WARNING: x\n${JSON.stringify({ metadata: { labels } })}`,
        });
        await createCloudTeardown(run).remove({ target: "cloudrun", appName: "pabc-cr", config: { project: "my-proj-1", region: "us-east1" }, scope: "app" });
        expect(run.calls.filter((c) => c.startsWith("gcloud run services delete")), JSON.stringify(labels)).toEqual(["gcloud run services delete pabc-cr --project my-proj-1 --region us-east1 --quiet"]);
      }
    });

    it("production Cloud Run keeps another app's service of that name and its account", async () => {
      const KEY = JSON.stringify({ type: "service_account", client_email: "d@p.iam.gserviceaccount.com", private_key: "PRIVKEY-SECRET-BODY" });
      const dir = await mkdtemp(join(tmpdir(), "teardown-isr-"));
      const store = createStore(join(dir, "t.db"), { secretKey: randomBytes(32) });
      try {
        store.saveGoogleConnection({ project: "p", region: "us-east1", arRepo: "r", deployer: "d@p.iam.gserviceaccount.com", puller: "u@p.iam.gserviceaccount.com" }, { deployerKey: KEY, pullerKey: "{}" });
        const project = store.createProject("shop");
        const run = recorder({
          "gcloud run services list": "pabc-cr\npabc-cr-isr\n",
          "gcloud run services describe pabc-cr-isr": JSON.stringify({ metadata: { labels: { "nbo-role": "function" } } }),
        });
        await createCloudTeardown(run, { mode: "production", store }).remove({ target: "cloudrun", appName: "pabc-cr", projectId: project.id, config: { project: "my-proj-1", region: "us-east1" }, scope: "app" });
        expect(run.calls.some((c) => c.includes(" delete pabc-cr-isr ") || c.includes(serviceIdentityId("pabc-cr-isr")))).toBe(false);
        expect(run.calls).toContain("gcloud run services delete pabc-cr --project my-proj-1 --region us-east1 --quiet");
      } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("dev Kubernetes never deletes an object by the cache's name alone: it must carry this app's cache labels", async () => {
      const run = recorder({ "kubectl --context kind-nbo-local get deployments -o name": "" });
      await createCloudTeardown(run).remove({ target: "kubernetes", appName: "pabc-k8s", config: {}, scope: "app", keep: ["pabc-k8s-isr"] });
      const named = run.calls.filter((c) => c.includes("pabc-k8s-isr"));
      expect(named).toEqual(["kubectl --context kind-nbo-local delete deployment,service -l nbo.dev/role=isrcache,nbo.dev/app=pabc-k8s --field-selector metadata.name=pabc-k8s-isr --ignore-not-found"]);
    });

    // Stage a (app pabc-s-a-k8s) has a function x-k8s-isr, Deployment pabc-s-a-k8s-fn-x-k8s-isr;
    // stage a-k8s-fn-x (app pabc-s-a-k8s-fn-x-k8s) has a cache with that same name.
    it("production: removing stage a-k8s-fn-x leaves stage a's function x-k8s-isr alone", async () => {
      const dir = await mkdtemp(join(tmpdir(), "teardown-isr-"));
      const store = createStore(join(dir, "t.db"), { secretKey: randomBytes(32) });
      try {
        const cid = store.saveKubernetesConnection({ name: "prod", server: "https://k8s.example:6443", registry: { kind: "custom", server: "ghcr.io", username: "bot" } }, { kubeconfig: "KUBECONFIG", registryPassword: "pw" }).id;
        const app = "pabc-s-a-k8s-fn-x-k8s";
        const fn = "pabc-s-a-k8s-fn-x-k8s-isr";
        const calls: string[] = [];
        const run = (async (cmd: string, args: string[]) => {
          const i = args.indexOf("--kubeconfig");
          const key = [cmd, ...args.slice(0, i), ...args.slice(i + 2)].join(" ");
          calls.push(key);
          if (key.includes(" get deployments")) {
            return JSON.stringify({ items: [{ metadata: { name: fn }, spec: { template: { metadata: { labels: { app: fn, "nbo.dev/role": "function", "nbo.dev/app": "pabc-s-a-k8s" } } } } }] });
          }
          return "";
        }) as CommandRunner;
        await createCloudTeardown(run, { mode: "production", store }).remove({ target: "kubernetes", appName: app, projectId: "proj_abc12345ffff", config: { clusterId: cid }, scope: "app", keep: ["pabc-s-a-k8s"] });
        const touching = calls.filter((c) => c.includes(" delete ") && c.includes(fn));
        expect(touching).toEqual([`kubectl -n nbo-p-abc12345 delete deployment,service -l nbo.dev/role=isrcache,nbo.dev/app=${app} --field-selector metadata.name=${fn} --ignore-not-found`]);
      } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("dev Kubernetes deletes a long app's cache by its shortened name", async () => {
      const app = "p0123abcd-" + "x".repeat(50);
      const run = recorder({ "kubectl --context kind-nbo-local get deployments -o name": "" });
      await createCloudTeardown(run).remove({ target: "kubernetes", appName: app, config: {} });
      const isr = run.calls.filter((c) => c.includes(" delete deployment,service "));
      expect(isr).toHaveLength(1);
      const name = /metadata\.name=(\S+)/.exec(isr[0]!)![1]!;
      expect(isr[0]).toContain(`-l nbo.dev/role=isrcache,nbo.dev/app=${app} `);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/-[0-9a-f]{8}$/);
      expect(name.startsWith(app.slice(0, 50))).toBe(true);
    });
  });

  it("names the cloud and step when a delete fails", async () => {
    const run = recorder({ "kubectl --context kind-nbo-local delete": new Error("Unable to connect to the server") });
    await expect(createCloudTeardown(run).remove({ target: "kubernetes", appName: "pabc-k8s", config: {} })).rejects.toThrow(
      /Kubernetes: deleting pabc-k8s failed: Unable to connect/,
    );
  });
});
