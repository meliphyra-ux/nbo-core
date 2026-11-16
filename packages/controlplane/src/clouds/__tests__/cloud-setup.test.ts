// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createCloudSetup, type CommandRunner } from "../cloud-setup.js";

// A fake CommandRunner at the true external boundary (gcloud, docker,
// kubectl): answers keyed by "cmd arg1 arg2…", recording every call.
function fakeRunner(answers: Record<string, string | Error>): CommandRunner & { calls: string[] } {
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

function enoent(cmd: string): Error {
  return Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
}

const readyMachine = {
  "gcloud config get-value account": "me@example.com\n",
  "gcloud config get-value project": "my-proj\n",
  "gcloud config get-value run/region": "europe-north1\n",
  "docker info": "27.1.0\n",
  "kubectl --context kind-nbo-local get nodes": "node/nbo-local-control-plane\n",
};

describe("preflight", () => {
  it("reports everything ready on a fully set-up machine", async () => {
    const p = await createCloudSetup(fakeRunner(readyMachine)).preflight();
    expect(p.gcloud).toEqual({
      installed: true,
      account: "me@example.com",
      project: "my-proj",
      region: "europe-north1",
      ready: true,
      reason: null,
    });
    expect(p.docker).toEqual({ installed: true, running: true, ready: true, reason: null });
    expect(p.kubernetes).toEqual({ reachable: true, context: "kind-nbo-local", ready: true, reason: null });
  });

  it("reports gcloud with no account as not ready", async () => {
    const p = await createCloudSetup(
      fakeRunner({ ...readyMachine, "gcloud config get-value account": "\n" }),
    ).preflight();
    expect(p.gcloud.ready).toBe(false);
    expect(p.gcloud.reason).toBe("gcloud is not logged in — run gcloud auth login");
  });

  it("reports gcloud with no project as not ready", async () => {
    const p = await createCloudSetup(
      fakeRunner({ ...readyMachine, "gcloud config get-value project": "(unset)\n" }),
    ).preflight();
    expect(p.gcloud.ready).toBe(false);
    expect(p.gcloud.reason).toBe("no default gcloud project — run gcloud config set project <id>");
  });

  it("falls back from run/region to compute/region to null", async () => {
    const r1 = await createCloudSetup(
      fakeRunner({
        ...readyMachine,
        "gcloud config get-value run/region": "",
        "gcloud config get-value compute/region": "us-east1\n",
      }),
    ).preflight();
    expect(r1.gcloud.region).toBe("us-east1");
    const r2 = await createCloudSetup(
      fakeRunner({
        ...readyMachine,
        "gcloud config get-value run/region": "",
        "gcloud config get-value compute/region": "",
      }),
    ).preflight();
    expect(r2.gcloud.region).toBeNull();
    expect(r2.gcloud.ready).toBe(true);
  });

  it("reports gcloud not installed on ENOENT", async () => {
    const p = await createCloudSetup(fakeRunner({ gcloud: enoent("gcloud"), ...readyMachine })).preflight();
    expect(p.gcloud).toMatchObject({ installed: false, ready: false, reason: "gcloud CLI not found" });
  });

  it("reports docker not running", async () => {
    const p = await createCloudSetup(
      fakeRunner({ ...readyMachine, "docker info": new Error("Cannot connect to the Docker daemon") }),
    ).preflight();
    expect(p.docker).toEqual({ installed: true, running: false, ready: false, reason: "Docker is not running" });
  });

  it("reports docker not installed on ENOENT", async () => {
    const p = await createCloudSetup(fakeRunner({ ...readyMachine, "docker info": enoent("docker") })).preflight();
    expect(p.docker).toMatchObject({ installed: false, ready: false, reason: "Docker is not installed" });
  });

  it("reports the kind cluster unreachable", async () => {
    const p = await createCloudSetup(
      fakeRunner({ kubectl: new Error("context not found"), ...readyMachine }),
    ).preflight();
    expect(p.kubernetes).toEqual({
      reachable: false,
      context: "kind-nbo-local",
      ready: false,
      reason: "local kind cluster nbo-local is not reachable — run scripts/bootstrap-local-k8s.sh",
    });
  });
});

describe("preflight speed", () => {
  it("reads the gcloud settings in parallel, not one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: CommandRunner = async (cmd, args) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return fakeRunner(readyMachine)(cmd, args);
    };
    await createCloudSetup(slow).preflight();
    expect(peak).toBeGreaterThanOrEqual(4);
  });

  it("reuses a fresh result instead of re-running the CLIs on every call", async () => {
    const runner = fakeRunner(readyMachine);
    const setup = createCloudSetup(runner, { cacheMs: 60_000 });
    await setup.preflight();
    const calls = runner.calls.length;
    await setup.preflight();
    expect(runner.calls.length).toBe(calls);
  });
});

describe("preflight kubernetes timeout", () => {
  it("treats a kind cluster that doesn't answer within the limit as unreachable", async () => {
    const hanging: CommandRunner = (cmd, args) =>
      cmd === "kubectl" ? new Promise(() => {}) : fakeRunner(readyMachine)(cmd, args);
    const started = Date.now();
    const p = await createCloudSetup(hanging, { kubeTimeoutMs: 50 }).preflight();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(p.kubernetes).toMatchObject({ reachable: false, ready: false });
  });
});

describe("ensureCloudRun", () => {
  it("runs enable, create and configure-docker in order and returns the arRepo path", async () => {
    const runner = fakeRunner({});
    const got = await createCloudSetup(runner).ensureCloudRun("my-proj", "europe-north1");
    expect(got).toEqual({
      project: "my-proj",
      region: "europe-north1",
      arRepo: "europe-north1-docker.pkg.dev/my-proj/nbo",
    });
    expect(runner.calls).toEqual([
      "gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project my-proj",
      "gcloud artifacts repositories create nbo --repository-format=docker --location europe-north1 --project my-proj --quiet",
      "gcloud auth configure-docker europe-north1-docker.pkg.dev --quiet",
    ]);
  });

  it("treats an existing repository as success", async () => {
    const runner = fakeRunner({
      "gcloud artifacts repositories create": new Error(
        "ERROR: (gcloud.artifacts.repositories.create) ALREADY_EXISTS: the repository already exists",
      ),
    });
    const got = await createCloudSetup(runner).ensureCloudRun("my-proj", "us-central1");
    expect(got.arRepo).toBe("us-central1-docker.pkg.dev/my-proj/nbo");
    expect(runner.calls).toHaveLength(3);
  });

  it("rejects naming the failed step", async () => {
    const runner = fakeRunner({ "gcloud services enable": new Error("PERMISSION_DENIED: billing is not enabled") });
    await expect(createCloudSetup(runner).ensureCloudRun("my-proj", "us-central1")).rejects.toThrow(
      /enabling the Cloud Run, Artifact Registry and Secret Manager APIs failed: PERMISSION_DENIED: billing is not enabled/,
    );
    expect(runner.calls).toHaveLength(1);
  });
});
