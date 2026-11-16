// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildDeployArgs,
  deploy,
  functionDeployConfigHash,
  liveServiceState,
  removeSecretEnv,
  renderEnvVarsFile,
  type DeploySpec,
} from "../deploy.js";
import {
  secretId,
  ensureSecretVersion,
  grantSecretAccessor,
  secretManagerAccessError,
  destroySupersededVersions,
  deleteAppSecrets,
} from "../secrets.js";
import type { ToolContext } from "../run.js";

type Call = { cmd: string; args: string[]; env?: Record<string, string>; input?: string };

function fake(answer: (cmd: string, args: string[], n: number) => string | Error = () => "") {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const ctx: ToolContext = {
    env: { CLOUDSDK_CONFIG: "/tmp/g" },
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env, input: opts?.input });
      const r = answer(cmd, args, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { calls, sleeps, ctx };
}

// Decodes the env-vars file: every line is `"KEY": "VALUE"`, both sides
// JSON-compatible double-quoted scalars (also valid YAML double-quoted).
function decode(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of file.split("\n").filter((l) => l !== "")) {
    const m = /^("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*")$/.exec(line);
    expect(m, line).not.toBeNull();
    out[JSON.parse(m![1]!) as string] = JSON.parse(m![2]!) as string;
  }
  return out;
}

const tricky: Record<string, string> = {
  YES: "NO",
  ON: "off",
  NULL: "null",
  N: "~",
  NUM: "0123",
  FLOAT: "1e3",
  EMPTY: "",
  QUOTES: `say "hi" and 'bye'`,
  BACKSLASH: "C:\\path\\to\\",
  MULTI: "line1\nline2\r\n\tindented",
  YAML_SYNTAX: "key: value # not a comment - [a, b] {c: d} &anchor *ref !tag | >",
  LEADING: "  spaced  ",
  UNICODE: "héllo ✓ 日本 😀",
  SEPARATORS: "a\u2028b\u2029c\u0085d\u007fe\u009ff\ufeffg",
  CONTROL: "\u0000\u0001\u001b",
};

describe("renderEnvVarsFile", () => {
  it("quotes every key and value and round-trips tricky values byte-exactly", () => {
    const file = renderEnvVarsFile(tricky);
    expect(decode(file)).toEqual(tricky);
    // YAML 1.1 line breaks and non-printables never appear raw.
    for (const ch of ["\u2028", "\u2029", "\u0085", "\u007f", "\u009f", "\ufeff", "\u0000", "\r", "\t"])
      expect(file).not.toContain(ch);
    expect(file).toContain('"YES": "NO"\n');
    expect(file).toContain('"EMPTY": ""\n');
    expect(file).toContain("😀");
  });
});

const spec: DeploySpec = {
  serviceName: "svc",
  imageTag: "img",
  project: "acme",
  region: "r",
  contentID: "sha256:" + "a".repeat(64),
  allowUnauthenticated: true,
};

describe("buildDeployArgs with variables", () => {
  it("adds nothing when there are no variables and nothing to clear", () => {
    expect(buildDeployArgs({ ...spec, plainEnv: {}, secretEnv: {} })).toEqual(buildDeployArgs(spec));
  });

  it("uses --env-vars-file for plain values (never the values) and clears secrets", () => {
    const args = buildDeployArgs({ ...spec, plainEnv: { A: "plain-value" } }, "/tmp/x/env.yaml");
    const base = buildDeployArgs(spec);
    expect(args.slice(0, base.length)).toEqual(base);
    expect(args.slice(base.length)).toEqual(["--env-vars-file", "/tmp/x/env.yaml", "--clear-secrets"]);
    expect(args.join(" ")).not.toContain("plain-value");
  });

  it("maps secrets with --set-secrets NAME=<id>:latest, sorted, and clears plain env when there is none", () => {
    const args = buildDeployArgs({ ...spec, secretEnv: { ZED: "nbo-svc-2", ALPHA: "nbo-svc-1" } });
    const base = buildDeployArgs(spec);
    expect(args.slice(base.length)).toEqual([
      "--clear-env-vars",
      "--set-secrets",
      "ALPHA=nbo-svc-1:latest,ZED=nbo-svc-2:latest",
    ]);
  });

  it("sets both when both kinds exist", () => {
    const args = buildDeployArgs({ ...spec, plainEnv: { A: "1" }, secretEnv: { S: "nbo-svc-s" } }, "/f");
    expect(args.slice(buildDeployArgs(spec).length)).toEqual([
      "--env-vars-file",
      "/f",
      "--set-secrets",
      "S=nbo-svc-s:latest",
    ]);
  });

  it("clearEnv with no variables clears both kinds", () => {
    expect(buildDeployArgs({ ...spec, clearEnv: true }).slice(buildDeployArgs(spec).length)).toEqual([
      "--clear-env-vars",
      "--clear-secrets",
    ]);
  });
});

describe("functionDeployConfigHash with variables", () => {
  it("ignores clearEnv and the env file path, changes with the secret mapping and plain values", () => {
    const h = functionDeployConfigHash(spec, "m");
    expect(functionDeployConfigHash({ ...spec, clearEnv: true }, "m")).toBe(h);
    const withPlain = functionDeployConfigHash({ ...spec, plainEnv: { A: "1" } }, "m");
    expect(withPlain).not.toBe(h);
    expect(functionDeployConfigHash({ ...spec, plainEnv: { A: "1" } }, "m")).toBe(withPlain);
    expect(functionDeployConfigHash({ ...spec, plainEnv: { A: "2" } }, "m")).not.toBe(withPlain);
    expect(functionDeployConfigHash({ ...spec, secretEnv: { S: "id" } }, "m")).not.toBe(h);
  });
});

describe("deploy with plain variables", () => {
  const describeOut = JSON.stringify({ status: { url: "https://u" }, metadata: {} });

  it("writes a private env-vars file for the call and removes it afterwards", async () => {
    let seen = "";
    let path = "";
    const { calls, ctx } = fake((_c, args) => {
      if (args.includes("describe")) return describeOut;
      path = args[args.indexOf("--env-vars-file") + 1]!;
      seen = readFileSync(path, "utf8");
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      }
      return "";
    });
    await deploy({ ...spec, plainEnv: tricky }, ctx);
    expect(decode(seen)).toEqual(tricky);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
    for (const c of calls) for (const v of ["plain-value", "héllo"]) expect(c.args.join(" ")).not.toContain(v);
  });

  it("removes the file when the deploy fails", async () => {
    let path = "";
    const { ctx } = fake((_c, args) => {
      path = args[args.indexOf("--env-vars-file") + 1]!;
      return new Error("deploy failed");
    });
    await expect(deploy({ ...spec, plainEnv: { A: "1" } }, ctx)).rejects.toThrow(/deploy failed/);
    expect(path).not.toBe("");
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("retries while a just-granted secret accessor role propagates", async () => {
    const { calls, sleeps, ctx } = fake((_c, args, n) => {
      if (args.includes("describe")) return describeOut;
      return n === 1
        ? new Error(
            "Permission denied on secret: projects/1/secrets/nbo-svc-x/versions/latest for Revision service account 1-compute@developer.gserviceaccount.com.",
          )
        : "";
    });
    await deploy({ ...spec, secretEnv: { S: "nbo-svc-x" } }, ctx);
    expect(sleeps).toEqual([2000]);
    expect(calls.filter((c) => c.args[1] === "deploy")).toHaveLength(2);
  });
});

describe("liveServiceState fingerprint", () => {
  it("returns the nbo-env label ('' when absent)", async () => {
    const out = (labels: Record<string, string>) =>
      JSON.stringify({
        metadata: { labels },
        spec: { template: { spec: { containers: [{ image: "img" }] } } },
        status: {
          url: "https://u",
          latestReadyRevisionName: "a",
          latestCreatedRevisionName: "a",
          conditions: [{ type: "Ready", status: "True" }],
        },
      });
    await expect(liveServiceState("s", "p", "r", fake(() => out({ "nbo-env": "f00d" })).ctx)).resolves.toMatchObject({
      fingerprint: "f00d",
    });
    await expect(liveServiceState("s", "p", "r", fake(() => out({})).ctx)).resolves.toMatchObject({ fingerprint: "" });
  });
});

describe("secretId", () => {
  it("is nbo-<app>-<16 hex of sha256(name)>: deterministic, valueless, valid", () => {
    const id = secretId("pabc-cloudrun", "API_TOKEN");
    expect(id).toMatch(/^nbo-pabc-cloudrun-[0-9a-f]{16}$/);
    expect(secretId("pabc-cloudrun", "API_TOKEN")).toBe(id);
    expect(secretId("pabc-cloudrun", "OTHER")).not.toBe(id);
    expect(secretId("other", "API_TOKEN")).not.toBe(id);
    expect(id.length).toBeLessThanOrEqual(255);
  });
});

const HASH = "0123456789abcdef0123456789abcdef";

describe("ensureSecretVersion", () => {
  it("never reads a value back: compares the nbo-value-hash label, skips when it matches", async () => {
    const { calls, ctx } = fake((_c, args) => (args[1] === "describe" ? `WARNING: something\n${HASH}\n` : ""));
    const added = await ensureSecretVersion("acme", "x", "same-value", HASH, ctx);
    expect(added).toBe(false);
    expect(calls.map((c) => c.args)).toEqual([
      ["secrets", "create", "x", "--replication-policy=automatic", "--project", "acme"],
      ["secrets", "describe", "x", "--format=value(labels.nbo-value-hash)", "--project", "acme"],
    ]);
  });

  it("adds the value over stdin, then labels the secret with its hash", async () => {
    const other = "f".repeat(32);
    const { calls, ctx } = fake((_c, args) => {
      if (args[1] === "create") return new Error("ALREADY_EXISTS: Secret [projects/1/secrets/x] already exists.");
      if (args[1] === "describe") return `${other}\n`;
      return "";
    });
    const added = await ensureSecretVersion("acme", "x", "s3cret\nvalue", HASH, ctx);
    expect(added).toBe(true);
    expect(calls.slice(2).map((c) => c.args)).toEqual([
      ["secrets", "versions", "add", "x", "--data-file=-", "--project", "acme"],
      ["secrets", "update", "x", `--update-labels=nbo-value-hash=${HASH}`, "--project", "acme"],
    ]);
    expect(calls[2]!.input).toBe("s3cret\nvalue");
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain("s3cret");
      expect(c.args).not.toContain("access");
      expect(c.env).toEqual({ CLOUDSDK_CONFIG: "/tmp/g" });
    }
  });

  it("an unlabelled or unreadable secret gets a version", async () => {
    for (const answer of ["", "WARNING: only noise\n", new Error("NOT_FOUND")]) {
      const { calls, ctx } = fake((_c, args) => (args[1] === "describe" ? answer : ""));
      expect(await ensureSecretVersion("acme", "x", "v", HASH, ctx)).toBe(true);
      expect(calls.filter((c) => c.args[2] === "add")).toHaveLength(1);
    }
  });

  it("without a hash always adds a version and labels nothing", async () => {
    const { calls, ctx } = fake();
    expect(await ensureSecretVersion("acme", "x", "v", undefined, ctx)).toBe(true);
    expect(calls.map((c) => c.args.slice(0, 3).join(" "))).toEqual(["secrets create x", "secrets versions add"]);
  });

  it("surfaces other create errors", async () => {
    const { ctx } = fake(() => new Error("PERMISSION_DENIED: secretmanager.secrets.create"));
    await expect(ensureSecretVersion("acme", "x", "v", HASH, ctx)).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe("grantSecretAccessor", () => {
  it("binds secretAccessor on the one secret and retries a not-yet-visible account", async () => {
    const { calls, sleeps, ctx } = fake((_c, _a, n) =>
      n === 1 ? new Error("Service account nbo-x@acme.iam.gserviceaccount.com does not exist.") : "",
    );
    await grantSecretAccessor("acme", "nbo-a-0123456789abcdef", "nbo-x@acme.iam.gserviceaccount.com", ctx);
    expect(sleeps).toEqual([2000]);
    expect(calls[1]!.args).toEqual([
      "secrets",
      "add-iam-policy-binding",
      "nbo-a-0123456789abcdef",
      "--member",
      "serviceAccount:nbo-x@acme.iam.gserviceaccount.com",
      "--role",
      "roles/secretmanager.secretAccessor",
      "--project",
      "acme",
      "--quiet",
    ]);
  });

  it("does not retry a plain permission denial that says '(or it may not exist)'", async () => {
    const { calls, sleeps, ctx } = fake(
      () =>
        new Error(
          "PERMISSION_DENIED: Permission 'secretmanager.secrets.setIamPolicy' denied for resource 'projects/acme/secrets/x' (or it may not exist).",
        ),
    );
    await expect(grantSecretAccessor("acme", "x", "a@b", ctx)).rejects.toThrow(/setIamPolicy/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("secretManagerAccessError", () => {
  it("tells a disabled API from a denied permission", () => {
    expect(
      secretManagerAccessError(
        "ERROR: (gcloud.secrets.create) PERMISSION_DENIED: Secret Manager API has not been used in project 1 before or it is disabled. reason: SERVICE_DISABLED",
      ),
    ).toBe("disabled");
    expect(
      secretManagerAccessError(
        "API [secretmanager.googleapis.com] not enabled on project [acme]. Would you like to enable and retry?",
      ),
    ).toBe("disabled");
    expect(
      secretManagerAccessError(
        "ERROR: (gcloud.secrets.create) PERMISSION_DENIED: Permission 'secretmanager.secrets.create' denied",
      ),
    ).toBe("denied");
    expect(secretManagerAccessError("ERROR: something else broke")).toBeUndefined();
  });
});

describe("destroySupersededVersions", () => {
  it("destroys every enabled version but the newest", async () => {
    const { calls, ctx } = fake((_c, args) =>
      args[2] === "list" ? "WARNING: x\nprojects/1/secrets/x/versions/3\nprojects/1/secrets/x/versions/1\n2\n" : "",
    );
    await destroySupersededVersions("acme", "x", ctx);
    expect(calls[0]!.args).toEqual([
      "secrets",
      "versions",
      "list",
      "x",
      "--filter=state:ENABLED",
      "--format=value(name)",
      "--project",
      "acme",
    ]);
    expect(calls.slice(1).map((c) => c.args)).toEqual([
      ["secrets", "versions", "destroy", "2", "--secret", "x", "--project", "acme", "--quiet"],
      ["secrets", "versions", "destroy", "1", "--secret", "x", "--project", "acme", "--quiet"],
    ]);
  });

  it("does nothing with a single version", async () => {
    const { calls, ctx } = fake((_c, args) => (args[2] === "list" ? "projects/1/secrets/x/versions/7\n" : ""));
    await destroySupersededVersions("acme", "x", ctx);
    expect(calls).toHaveLength(1);
  });
});

describe("deleteAppSecrets", () => {
  it("deletes only this app's nbo-<app>-<16 hex> secrets, tolerating not-found", async () => {
    const mine = secretId("pabc-cloudrun", "A");
    const mine2 = secretId("pabc-cloudrun", "B");
    const theirs = secretId("pabc-cloudrun-x", "A");
    const { calls, ctx } = fake((_c, args) => {
      if (args[1] === "list") return `WARNING: x\nprojects/1/secrets/${mine}\n${mine2}\nprojects/1/secrets/${theirs}\n`;
      if (args[2] === mine2) return new Error("NOT_FOUND: Secret not found");
      return "";
    });
    await deleteAppSecrets("acme", "pabc-cloudrun", ctx);
    expect(calls[0]!.args).toEqual([
      "secrets",
      "list",
      "--filter=name~nbo-pabc-cloudrun-",
      "--format=value(name)",
      "--project",
      "acme",
    ]);
    expect(calls.slice(1).map((c) => c.args)).toEqual([
      ["secrets", "delete", mine, "--project", "acme", "--quiet"],
      ["secrets", "delete", mine2, "--project", "acme", "--quiet"],
    ]);
  });

  it("a project that never used Secret Manager has nothing to delete", async () => {
    for (const msg of [
      "PERMISSION_DENIED: Secret Manager API has not been used in project 1 before or it is disabled. SERVICE_DISABLED",
      "PERMISSION_DENIED: denied",
    ]) {
      const { calls, ctx } = fake(() => new Error(msg));
      await expect(deleteAppSecrets("acme", "a", ctx)).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    }
  });

  it("surfaces other failures", async () => {
    const { ctx } = fake(() => new Error("boom"));
    await expect(deleteAppSecrets("acme", "a", ctx)).rejects.toThrow(/boom/);
  });
});

describe("live secret env and removing it", () => {
  it("liveServiceState lists env names mounted from secrets", async () => {
    const out = JSON.stringify({
      metadata: { labels: {} },
      spec: {
        template: {
          spec: {
            containers: [
              {
                image: "img",
                env: [
                  { name: "PLAIN", value: "p" },
                  { name: "TOKEN", valueFrom: { secretKeyRef: { name: "nbo-a-1", key: "latest" } } },
                ],
              },
            ],
          },
        },
      },
      status: {
        url: "https://u",
        latestReadyRevisionName: "a",
        latestCreatedRevisionName: "a",
        conditions: [{ type: "Ready", status: "True" }],
      },
    });
    await expect(liveServiceState("s", "p", "r", fake(() => out).ctx)).resolves.toMatchObject({
      secretEnvNames: ["TOKEN"],
    });
  });

  it("removeSecretEnv drops the named secret env vars in one update", async () => {
    const { calls, ctx } = fake();
    await removeSecretEnv("svc", "acme", "r", ["A", "B"], ctx);
    expect(calls.map((c) => c.args)).toEqual([
      ["run", "services", "update", "svc", "--region", "r", "--project", "acme", "--remove-secrets", "A,B", "--quiet"],
    ]);
  });
});
