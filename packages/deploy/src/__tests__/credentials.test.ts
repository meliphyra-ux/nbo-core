// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _internals,
  kubectlArgs,
  redact,
  withDockerLogin,
  withGoogleCredentials,
  withKubeconfig,
  type ToolContext,
} from "../credentials.js";

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
    await withGoogleCredentials({ kind: "key", keyJson: '{"k":1}' }, "europe-west1", run, async (ctx) => {
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
      withGoogleCredentials({ kind: "key", keyJson: "{}" }, "us-central1", run, async () => {
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
    await expect(withGoogleCredentials({ kind: "key", keyJson: "{}" }, "r", run, async () => 1)).rejects.toThrow(
      "gcloud failed",
    );
    expect(existsSync(dir)).toBe(false);
  });
});

describe("withGoogleCredentials wif", () => {
  const sa = "nbo-id@proj.iam.gserviceaccount.com";
  const aud = "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q";
  const wif = (signToken: () => string) => ({ kind: "wif" as const, audience: aud, serviceAccount: sa, signToken });

  it("writes an external_account config and a token file, then logs in and configures docker", async () => {
    const { calls, run } = fakeRunner();
    let tokenFile = "";
    let dir = "";
    await withGoogleCredentials(
      wif(() => "TOKEN-1"),
      "europe-west1",
      run,
      async (ctx) => {
        const login = calls[0]!;
        expect(login.cmd).toBe("gcloud");
        expect(login.args.slice(0, 2)).toEqual(["auth", "login"]);
        const cfgPath = login.args.find((a) => a.startsWith("--cred-file="))!.slice("--cred-file=".length);
        dir = dirname(cfgPath);
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        tokenFile = cfg.credential_source.file;
        expect(cfg).toEqual({
          type: "external_account",
          audience: aud,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          token_url: "https://sts.googleapis.com/v1/token",
          credential_source: { file: tokenFile },
          service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`,
        });
        expect(readFileSync(tokenFile, "utf8")).toBe("TOKEN-1");
        expect(login.args).toContain("--quiet");
        expect(calls[1]!.args).toEqual(["auth", "configure-docker", "europe-west1-docker.pkg.dev", "--quiet"]);
        expect(ctx.env!.CLOUDSDK_CONFIG).toBeTruthy();
        expect(JSON.stringify(calls)).not.toContain("TOKEN-1");
      },
    );
    expect(existsSync(dir)).toBe(false);
  });

  it("rewrites the token file every refreshMs while fn runs and stops after", async () => {
    const { run } = fakeRunner();
    let tokenPath = "";
    let n = 0;
    const signToken = () => `T${++n}`;
    let tick: (() => void) | undefined;
    let cleared = false;
    const fakeSet = ((f: () => void) => {
      tick = f;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const fakeClear = (() => {
      cleared = true;
    }) as unknown as typeof clearInterval;
    await withGoogleCredentials(
      wif(signToken),
      "r",
      async (c, a, o) => {
        if (a[1] === "login") {
          const cfg = JSON.parse(readFileSync(a.find((x) => x.startsWith("--cred-file="))!.slice(12), "utf8"));
          tokenPath = cfg.credential_source.file;
        }
        return run(c, a, o);
      },
      async () => {
        for (let i = 0; i < 3; i++) tick!();
        await new Promise((r) => setTimeout(r, 50));
        expect(readFileSync(tokenPath, "utf8")).toBe("T4");
      },
      { refreshMs: 5, setInterval: fakeSet, clearInterval: fakeClear },
    );
    expect(n).toBe(4);
    expect(cleared).toBe(true);
  });

  it("removes the temp dir when fn throws", async () => {
    const { calls, run } = fakeRunner();
    await expect(
      withGoogleCredentials(
        wif(() => "T"),
        "r",
        run,
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    const cfgPath = calls[0]!.args.find((a) => a.startsWith("--cred-file="))!.slice(12);
    expect(existsSync(dirname(cfgPath))).toBe(false);
  });

  it("redacts every subject token written, the current one too, from errors thrown inside fn", async () => {
    const { run } = fakeRunner();
    let n = 0;
    let tick: (() => void) | undefined;
    const fakeSet = ((f: () => void) => {
      tick = f;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    class Marked extends Error {}
    const err = await withGoogleCredentials(
      wif(() => `SUBJECT-TOKEN-${++n}`),
      "r",
      run,
      async () => {
        tick!();
        await new Promise((r) => setTimeout(r, 20));
        throw new Marked("gcloud said: SUBJECT-TOKEN-1 and SUBJECT-TOKEN-2 were refused");
      },
      { setInterval: fakeSet, clearInterval: (() => undefined) as unknown as typeof clearInterval },
    ).catch((e: unknown) => e);
    expect(n).toBe(2);
    expect(err).toBeInstanceOf(Marked);
    expect((err as Error).message).toBe("gcloud said: [redacted] and [redacted] were refused");
    expect((err as Error).stack ?? "").not.toContain("SUBJECT-TOKEN");
  });

  it("reports a signer error without token material", async () => {
    const { run } = fakeRunner();
    const err = await withGoogleCredentials(
      wif(() => {
        throw new Error("sign failed for SECRETKEYBITS");
      }),
      "r",
      run,
      async () => 1,
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/sign/i);
    expect((err as Error).message).not.toContain("SECRETKEYBITS");
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
    expect(kubectlArgs({ kubeconfig: "/k", namespace: "n" }, ["get", "pods"])).toEqual([
      "--kubeconfig",
      "/k",
      "-n",
      "n",
      "get",
      "pods",
    ]);
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
    await expect(withGoogleCredentials({ kind: "key", keyJson: "{}" }, "r", run, async () => 7)).resolves.toBe(7);
  });

  it("redacts key material from gcloud errors", async () => {
    const key = JSON.stringify({ private_key: "-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----\n" });
    const run = async () => {
      throw new Error("failed: -----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----\n");
    };
    const err = await withGoogleCredentials({ kind: "key", keyJson: key }, "r", run, async () => 1).catch(
      (e: Error) => e,
    );
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
    expect(calls).toEqual([
      {
        cmd: "docker",
        args: ["login", "ghcr.io", "--username", "bot", "--password-stdin"],
        env: { DOCKER_CONFIG: dockerConfig },
        input: "hunter2",
      },
    ]);
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
