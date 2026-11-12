// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _internals, kubectlArgs, redact, withDockerLogin, withGoogleCredentials, withKubeconfig, type ToolContext } from "../credentials.js";

const posix = process.platform !== "win32";

function fakeRunner() {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const run = async (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts?.env });
    return "";
  };
  return { calls, run };
}

describe("withGoogleCredentials", () => {
  it("activates the key and configures docker under a private temp dir, then removes it", async () => {
    const { calls, run } = fakeRunner();
    let seen: ToolContext | undefined;
    let keyPath = "";
    await withGoogleCredentials('{"k":1}', "europe-west1", run, async (ctx) => {
      seen = ctx;
      const cfg = ctx.env!.CLOUDSDK_CONFIG!;
      keyPath = calls[0]!.args[calls[0]!.args.indexOf("--key-file") + 1]!;
      expect(readFileSync(keyPath, "utf8")).toBe('{"k":1}');
      if (posix) {
        expect(statSync(dirname(keyPath)).mode & 0o777).toBe(0o700);
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      }
      expect(existsSync(dirname(keyPath))).toBe(true);
      expect(cfg.startsWith(dirname(keyPath))).toBe(true);
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe("gcloud");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["auth", "activate-service-account", "--key-file"]);
    expect(calls[1]!.args).toEqual(["auth", "configure-docker", "europe-west1-docker.pkg.dev", "--quiet"]);
    for (const c of calls) {
      expect(c.env!.CLOUDSDK_CONFIG).toBe(seen!.env!.CLOUDSDK_CONFIG);
      expect(c.env!.DOCKER_CONFIG).toBe(seen!.env!.DOCKER_CONFIG);
    }
    expect(existsSync(dirname(keyPath))).toBe(false);
  });

  it("removes the dir and propagates the error when fn throws", async () => {
    const { calls, run } = fakeRunner();
    await expect(
      withGoogleCredentials("{}", "us-central1", run, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const keyPath = calls[0]!.args[calls[0]!.args.indexOf("--key-file") + 1]!;
    expect(existsSync(dirname(keyPath))).toBe(false);
  });

  it("removes the dir when gcloud fails", async () => {
    let dir = "";
    const run = async (_c: string, args: string[]) => {
      dir = dirname(args[args.indexOf("--key-file") + 1]!);
      throw new Error("gcloud failed");
    };
    await expect(withGoogleCredentials("{}", "r", run, async () => 1)).rejects.toThrow("gcloud failed");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("withKubeconfig", () => {
  it("writes the kubeconfig privately and removes it afterwards", async () => {
    let path = "";
    const out = await withKubeconfig("apiVersion: v1\n", "ns", async (ctx) => {
      path = ctx.kubeconfig!;
      expect(ctx.namespace).toBe("ns");
      expect(readFileSync(path, "utf8")).toBe("apiVersion: v1\n");
      if (posix) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      }
      return 42;
    });
    expect(out).toBe(42);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("removes the file when fn throws", async () => {
    let path = "";
    await expect(
      withKubeconfig("x", undefined, async (ctx) => {
        path = ctx.kubeconfig!;
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(existsSync(path)).toBe(false);
  });
});

describe("kubectlArgs", () => {
  it("prepends kubeconfig and namespace", () => {
    expect(kubectlArgs({ kubeconfig: "/k", namespace: "n" }, ["get", "pods"])).toEqual(["--kubeconfig", "/k", "-n", "n", "get", "pods"]);
  });
  it("passes args through without a context", () => {
    expect(kubectlArgs(undefined, ["get", "pods"])).toEqual(["get", "pods"]);
    expect(kubectlArgs({}, ["get"])).toEqual(["get"]);
  });
});

describe("redact", () => {
  it("replaces secrets and their base64 form", () => {
    expect(redact("token abc and YWJj", ["abc"])).toBe("token [redacted] and [redacted]");
  });
  it("ignores empty secrets", () => {
    expect(redact("hello", [""])).toBe("hello");
  });
});

describe("cleanup failures and redaction", () => {
  const realRm = _internals.rm;
  afterEach(() => {
    _internals.rm = realRm;
    vi.restoreAllMocks();
  });

  it("does not mask fn's error when removal fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _internals.rm = async () => {
      throw new Error("EBUSY");
    };
    await expect(
      withKubeconfig("secret-config", undefined, async () => {
        throw new Error("original");
      }),
    ).rejects.toThrow("original");
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).not.toContain("secret-config");
  });

  it("still returns fn's result when removal fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    _internals.rm = async () => {
      throw new Error("EPERM");
    };
    const { run } = fakeRunner();
    await expect(withGoogleCredentials("{}", "r", run, async () => 7)).resolves.toBe(7);
  });

  it("redacts key material from gcloud errors", async () => {
    const key = JSON.stringify({ private_key: "-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----\n" });
    const run = async () => {
      throw new Error("failed: -----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----\n");
    };
    const err = await withGoogleCredentials(key, "r", run, async () => 1).catch((e: Error) => e);
    expect((err as Error).message).toContain("[redacted]");
    expect((err as Error).message).not.toContain("ABCDEF");
  });
});

describe("withDockerLogin", () => {
  it("logs in with the password on stdin under a private DOCKER_CONFIG, then removes it", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string>; input?: string }[] = [];
    const run = async (cmd: string, args: string[], opts?: { env?: Record<string, string>; input?: string }) => {
      calls.push({ cmd, args, env: opts?.env, input: opts?.input });
      return "";
    };
    let dockerConfig = "";
    await withDockerLogin("ghcr.io", "bot", "hunter2", run, async (ctx) => {
      dockerConfig = ctx.env!.DOCKER_CONFIG!;
      expect(existsSync(dockerConfig)).toBe(true);
      if (posix) expect(statSync(dockerConfig).mode & 0o777).toBe(0o700);
    });
    expect(calls).toEqual([{ cmd: "docker", args: ["login", "ghcr.io", "--username", "bot", "--password-stdin"], env: { DOCKER_CONFIG: dockerConfig }, input: "hunter2" }]);
    expect(existsSync(dockerConfig)).toBe(false);
  });

  it("redacts the password from a failed login and still removes the dir", async () => {
    let dir = "";
    const run = async (_c: string, _a: string[], opts?: { env?: Record<string, string> }) => {
      dir = opts!.env!.DOCKER_CONFIG!;
      throw new Error("login failed for hunter2");
    };
    const err = await withDockerLogin("ghcr.io", "bot", "hunter2", run, async () => 1).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("hunter2");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("redact with overlapping secrets", () => {
  it("never leaks the suffix of a longer secret that starts with a shorter one", () => {
    expect(redact("x abcdef y", ["abc", "abcdef"])).toBe("x [redacted] y");
    expect(redact("x abcdef y", ["abcdef", "abc"])).toBe("x [redacted] y");
  });
  it("redacts overlapping secrets as one span", () => {
    expect(redact("--abcdefgh--", ["abcdef", "defgh"])).toBe("--[redacted]--");
    expect(redact("--abcdefgh--", ["defgh", "abcdef"])).toBe("--[redacted]--");
  });
  it("treats regex metacharacters literally and still covers base64 forms", () => {
    expect(redact("p a.b*c q", ["a.b*c"])).toBe("p [redacted] q");
    expect(redact("axbxc", ["a.b"])).toBe("axbxc");
    expect(redact(`k ${Buffer.from("s3cr3t").toString("base64")}`, ["s3cr3t"])).toBe("k [redacted]");
  });
});
