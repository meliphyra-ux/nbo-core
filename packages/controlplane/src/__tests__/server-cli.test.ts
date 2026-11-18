// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { runServerCli, baseUrl, type ServerCliIO } from "../server-cli.js";

// nbo-server: the headless operator's tool for what the dashboard used to
// do. Each command sends one request (or a few) to the local control-plane
// over loopback, with no token. Secrets come from files or stdin, never
// from a flag's value.

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
}

type Answer = { status: number; body?: unknown };

const KUBECONFIG = "apiVersion: v1\nkind: Config\nusers:\n- name: admin\n  user:\n    token: kube-SECRET-0123456789\n";
const ADMIN_KUBECONFIG =
  "apiVersion: v1\nkind: Config\nusers:\n- name: root\n  user:\n    token: admin-SECRET-9876543210\n";
const GOOGLE_KEY =
  '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nGOOGLE-SECRET\\n-----END PRIVATE KEY-----\\n"}';
const REGISTRY = JSON.stringify({
  registry: { kind: "custom", server: "registry.example.com", username: "nbo" },
  registryPassword: "reg-SECRET-42",
});

interface Run {
  code: number;
  sent: Sent[];
  out: string[];
  err: string[];
}

// run: the CLI against a fake fetch that answers from `answers` in order
// (the last one repeats), with files and stdin from the maps given.
async function run(
  argv: string[],
  opts: {
    answers?: Answer[];
    files?: Record<string, string>;
    stdin?: string;
    env?: Record<string, string | undefined>;
    onRead?: () => void;
    onSleep?: (ms: number) => void;
  } = {},
): Promise<Run> {
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const answers = opts.answers ?? [{ status: 200, body: { ok: true } }];
  let i = 0;
  const io: ServerCliIO = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      sent.push({
        method: init?.method ?? "GET",
        url: String(input),
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
        redirect: init?.redirect,
      });
      const a = answers[Math.min(i, answers.length - 1)]!;
      i++;
      if (a.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(a.body ?? {}), {
        status: a.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
    readFile: async (path: string) => {
      opts.onRead?.();
      const f = opts.files?.[path];
      if (f === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return f;
    },
    stdin: async () => {
      if (opts.stdin === undefined) throw new Error("no stdin");
      return opts.stdin;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: opts.env ?? {},
    sleep: async (ms: number) => {
      opts.onSleep?.(ms);
    },
  };
  const code = await runServerCli(argv, io);
  return { code, sent, out, err };
}

const B = "http://127.0.0.1:8081";
const body = (s: Sent): unknown => (s.body === undefined ? undefined : JSON.parse(s.body));
const req = (s: Sent): [string, string, unknown] => [s.method, s.url, body(s)];

describe("nbo-server base URL", () => {
  it("defaults to loopback port 8081", () => {
    expect(baseUrl({})).toBe(B);
  });

  it("takes the port of NBO_CONTROL_PLANE_ADDR and always talks to loopback", async () => {
    expect(baseUrl({ NBO_CONTROL_PLANE_ADDR: "0.0.0.0:9000" })).toBe("http://127.0.0.1:9000");
    const r = await run(["token", "list"], {
      env: { NBO_CONTROL_PLANE_ADDR: "0.0.0.0:9000" },
      answers: [{ status: 200, body: [] }],
    });
    expect(r.sent[0]!.url).toBe("http://127.0.0.1:9000/system/api-tokens");
  });

  it("NBO_SERVER_URL wins, for another loopback address or port", () => {
    expect(baseUrl({ NBO_SERVER_URL: "http://127.0.0.1:7000/", NBO_CONTROL_PLANE_ADDR: "0.0.0.0:9000" })).toBe(
      "http://127.0.0.1:7000",
    );
    expect(baseUrl({ NBO_SERVER_URL: "http://localhost:7000" })).toBe("http://localhost:7000");
    expect(baseUrl({ NBO_SERVER_URL: "http://[::1]:7000" })).toBe("http://[::1]:7000");
    expect(baseUrl({ NBO_SERVER_URL: "http://127.0.0.2:7000" })).toBe("http://127.0.0.2:7000");
  });

  it.each([
    ["http://10.0.0.5:7000"],
    ["https://nbo.example.com"],
    ["http://127.0.0.1.example.com:8081"],
    ["http://localhost.evil.example:8081"],
    ["ftp://127.0.0.1:8081"],
    ["not a url"],
    ["http://user:pw@127.0.0.1:8081"],
    ["http://127.0.0.1:8081/api"],
  ])("NBO_SERVER_URL %s is refused (exit 2) before any secret is read or sent", async (url) => {
    let read = false;
    const r = await run(
      ["connect", "kubernetes", "--name", "x", "--kubeconfig-file", "/kc", "--registry-file", "/reg.json"],
      {
        env: { NBO_SERVER_URL: url },
        files: { "/kc": KUBECONFIG, "/reg.json": REGISTRY },
        onRead: () => {
          read = true;
        },
      },
    );
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
    expect(read).toBe(false);
    expect(r.err.join("\n")).toContain("this computer");
  });

  it("never follows a redirect", async () => {
    const r = await run(["token", "list"], { answers: [{ status: 200, body: [] }] });
    expect(r.sent[0]!.redirect).toBe("error");
  });

  it("requests carry no token", async () => {
    const r = await run(["token", "list"], { env: { NBO_API_TOKEN: "nbo_x" } });
    expect(r.sent[0]!.headers.authorization).toBeUndefined();
  });
});

describe("nbo-server status", () => {
  it("reads preflight, connections and the edge", async () => {
    const r = await run(["status"]);
    expect(r.code).toBe(0);
    expect(r.sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${B}/system/preflight`,
      `GET ${B}/system/connections`,
      `GET ${B}/system/edge`,
    ]);
    const printed = JSON.parse(r.out.join("\n"));
    expect(Object.keys(printed)).toEqual(["preflight", "connections", "edge"]);
  });
});

describe("nbo-server token", () => {
  it("create sends the name and prints the secret once with the warning", async () => {
    const secret = "nbo_tok_SECRET_abcdef";
    const r = await run(["token", "create", "ci"], {
      answers: [{ status: 201, body: { id: "tok_1", name: "ci", token: secret } }],
    });
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual(["POST", `${B}/system/api-tokens`, { name: "ci" }]);
    const all = [...r.out, ...r.err].join("\n");
    expect(all.split(secret).length - 1).toBe(1);
    expect(all).toContain("store it now, it is not shown again");
  });

  it("list and revoke", async () => {
    const list = await run(["token", "list"], { answers: [{ status: 200, body: [] }] });
    expect(req(list.sent[0]!)).toEqual(["GET", `${B}/system/api-tokens`, undefined]);
    const revoke = await run(["token", "revoke", "tok_1"], { answers: [{ status: 204 }] });
    expect(revoke.code).toBe(0);
    expect(req(revoke.sent[0]!)).toEqual(["DELETE", `${B}/system/api-tokens/tok_1`, undefined]);
  });
});

describe("nbo-server connect and disconnect", () => {
  it("connect google with a key file", async () => {
    const r = await run(["connect", "google", "--key-file", "/k.json", "--region", "europe-west1"], {
      files: { "/k.json": GOOGLE_KEY },
      answers: [{ status: 201, body: {} }],
    });
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual([
      "POST",
      `${B}/system/connections/google`,
      { source: "key", keyJson: GOOGLE_KEY, region: "europe-west1" },
    ]);
  });

  it("connect google with the key on stdin", async () => {
    const r = await run(["connect", "google", "--key-file", "-", "--region", "europe-west1"], {
      stdin: GOOGLE_KEY,
      answers: [{ status: 201, body: {} }],
    });
    expect(body(r.sent[0]!)).toEqual({ source: "key", keyJson: GOOGLE_KEY, region: "europe-west1" });
  });

  it("connect google with a connection code sends the body and prints the connection", async () => {
    const r = await run(["connect", "google", "--code", "nbo-gcp1.abc", "--region", "europe-west1"], {
      answers: [{ status: 201, body: { kind: "google", auth: "wif", project: "acme" } }],
    });
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual([
      "POST",
      `${B}/system/connections/google`,
      { source: "wif", code: "nbo-gcp1.abc", region: "europe-west1" },
    ]);
    expect(r.out.join("\n")).toContain('"auth": "wif"');
  });

  it("connect google refuses --code with a key file or --from-machine", async () => {
    for (const extra of [["--key-file", "/k.json"], ["--from-machine"]]) {
      const r = await run(["connect", "google", "--code", "nbo-gcp1.abc", "--region", "r", ...extra], {
        files: { "/k.json": GOOGLE_KEY },
      });
      expect(r.code).not.toBe(0);
      expect(r.sent).toEqual([]);
    }
  });

  it("connect google from this machine", async () => {
    const r = await run(["connect", "google", "--from-machine", "--project", "my-proj", "--region", "us-central1"], {
      answers: [{ status: 201, body: {} }],
    });
    expect(req(r.sent[0]!)).toEqual([
      "POST",
      `${B}/system/connections/google`,
      { source: "machine", project: "my-proj", region: "us-central1" },
    ]);
  });

  it("connect kubernetes with a kubeconfig file, context and registry file", async () => {
    const r = await run(
      [
        "connect",
        "kubernetes",
        "--name",
        "hetzner",
        "--kubeconfig-file",
        "/kc",
        "--context",
        "prod",
        "--registry-file",
        "/reg.json",
      ],
      {
        files: { "/kc": KUBECONFIG, "/reg.json": REGISTRY },
        answers: [{ status: 201, body: { id: "kc_abc" } }],
      },
    );
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual([
      "POST",
      `${B}/system/connections/kubernetes`,
      {
        name: "hetzner",
        source: { kind: "kubeconfig", kubeconfig: KUBECONFIG, context: "prod" },
        registry: { kind: "custom", server: "registry.example.com", username: "nbo" },
        registryPassword: "reg-SECRET-42",
      },
    ]);
  });

  it("connect kubernetes needs --registry-file", async () => {
    const r = await run(["connect", "kubernetes", "--name", "hetzner", "--kubeconfig-file", "/kc"], {
      files: { "/kc": KUBECONFIG },
    });
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
    expect(r.err.join("\n")).toContain("--registry-file");
  });

  it("disconnect google and a cluster", async () => {
    const g = await run(["disconnect", "google"], { answers: [{ status: 204 }] });
    expect(req(g.sent[0]!)).toEqual(["DELETE", `${B}/system/connections/google`, undefined]);
    const k = await run(["disconnect", "kubernetes", "kc_abc"], { answers: [{ status: 204 }] });
    expect(req(k.sent[0]!)).toEqual(["DELETE", `${B}/system/connections/kubernetes/kc_abc`, undefined]);
  });
});

describe("nbo-server cluster", () => {
  it("test, update-setup and relay", async () => {
    const t = await run(["cluster", "test", "kc_abc"]);
    expect(req(t.sent[0]!)).toEqual(["POST", `${B}/system/connections/kubernetes/kc_abc/test`, undefined]);

    const u = await run(["cluster", "update-setup", "kc_abc", "--admin-kubeconfig-file", "/admin"], {
      files: { "/admin": ADMIN_KUBECONFIG },
    });
    expect(req(u.sent[0]!)).toEqual([
      "POST",
      `${B}/system/clusters/kc_abc/update-setup`,
      { admin: { kind: "kubeconfig", kubeconfig: ADMIN_KUBECONFIG } },
    ]);

    const relay = await run(["cluster", "relay", "kc_abc", "--confirm-billing"], {
      answers: [{ status: 202, body: { job: { status: "running" } } }],
    });
    expect(relay.code).toBe(0);
    expect(req(relay.sent[0]!)).toEqual(["POST", `${B}/system/clusters/kc_abc/relay`, { confirmBilling: true }]);
  });

  it("relay refuses without --confirm-billing and takes no admin kubeconfig", async () => {
    const r = await run(["cluster", "relay", "kc_abc"]);
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
    const k = await run(["cluster", "relay", "kc_abc", "--confirm-billing", "--admin-kubeconfig-file", "/admin"], {
      files: { "/admin": ADMIN_KUBECONFIG },
    });
    expect(k.code).toBe(2);
    expect(k.sent).toHaveLength(0);
  });
});

describe("nbo-server edge", () => {
  it("install sends the cluster, admin kubeconfig and billing confirmation", async () => {
    const r = await run(
      ["edge", "install", "--cluster", "kc_abc", "--admin-kubeconfig-file", "/admin", "--confirm-billing"],
      {
        files: { "/admin": ADMIN_KUBECONFIG },
        answers: [{ status: 202, body: { job: { status: "running" } } }],
      },
    );
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual([
      "POST",
      `${B}/system/edge/install`,
      { clusterId: "kc_abc", admin: { kind: "kubeconfig", kubeconfig: ADMIN_KUBECONFIG }, confirmBilling: true },
    ]);
  });

  it("install refuses without --confirm-billing", async () => {
    const r = await run(["edge", "install", "--cluster", "kc_abc", "--admin-kubeconfig-file", "/admin"], {
      files: { "/admin": ADMIN_KUBECONFIG },
    });
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
  });

  it("reinstall and status", async () => {
    const re = await run(["edge", "reinstall"], { answers: [{ status: 202, body: { job: {} } }] });
    expect(req(re.sent[0]!)).toEqual(["POST", `${B}/system/edge/reinstall`, {}]);
    const st = await run(["edge", "status"]);
    expect(req(st.sent[0]!)).toEqual(["GET", `${B}/system/edge`, undefined]);
    expect(st.sent).toHaveLength(1);
  });

  it("status --wait polls until the job is no longer running", async () => {
    const r = await run(["edge", "status", "--wait"], {
      answers: [
        { status: 200, body: { job: { status: "running" } } },
        { status: 200, body: { job: { status: "running" } } },
        { status: 200, body: { installed: true, job: { status: "succeeded" } } },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.sent).toHaveLength(3);
    expect(r.out.join("\n")).toContain('"succeeded"');
  });

  it("status --wait gives up after 30 minutes of 2-second checks", async () => {
    let slept = 0;
    const r = await run(["edge", "status", "--wait"], {
      answers: [{ status: 200, body: { job: { status: "running" } } }],
      onSleep: (ms) => {
        slept += ms;
      },
    });
    expect(r.code).toBe(1);
    expect(slept).toBe(30 * 60_000);
    expect(r.sent).toHaveLength(30 * 30 + 1);
    expect(r.err.join("\n")).toContain("still running after 30 minutes");
  });

  it("status --wait exits 1 when the job failed", async () => {
    const r = await run(["edge", "status", "--wait"], {
      answers: [{ status: 200, body: { job: { status: "failed", error: "no load balancer" } } }],
    });
    expect(r.code).toBe(1);
  });
});

describe("nbo-server domains settings", () => {
  it("patches only the fields given", async () => {
    const r = await run([
      "domains",
      "settings",
      "--base-domain",
      "sites.example.com",
      "--acme-email",
      "ops@example.com",
      "--move-existing",
    ]);
    expect(req(r.sent[0]!)).toEqual([
      "PATCH",
      `${B}/system/domains`,
      { baseDomain: "sites.example.com", acmeEmail: "ops@example.com", moveExisting: true },
    ]);
    const one = await run(["domains", "settings", "--acme-email", "ops@example.com"]);
    expect(body(one.sent[0]!)).toEqual({ acmeEmail: "ops@example.com" });
  });
});

describe("nbo-server transfer and revalidate", () => {
  it("transfer to Cloud Run, to a cluster, and cancel", async () => {
    const cr = await run(["transfer", "prj_1", "--to", "cloudrun"], { answers: [{ status: 202, body: {} }] });
    expect(req(cr.sent[0]!)).toEqual(["POST", `${B}/projects/prj_1/transfer`, { target: "cloudrun", mode: "auto" }]);
    const kc = await run(["transfer", "prj_1", "--to", "kc_abc"], { answers: [{ status: 202, body: {} }] });
    expect(body(kc.sent[0]!)).toEqual({ target: "kubernetes", clusterId: "kc_abc" });
    const k = await run(["transfer", "prj_1", "--to", "kubernetes"], { answers: [{ status: 202, body: {} }] });
    expect(body(k.sent[0]!)).toEqual({ target: "kubernetes" });
    const cancel = await run(["transfer", "cancel", "prj_1"]);
    expect(req(cancel.sent[0]!)).toEqual(["POST", `${B}/projects/prj_1/transfer/cancel`, undefined]);
  });

  it("revalidate tags and paths of one environment", async () => {
    const r = await run([
      "revalidate",
      "prj_1",
      "--stage",
      "stg_prod",
      "--tag",
      "posts",
      "--tag",
      "home",
      "--path",
      "/blog",
    ]);
    expect(req(r.sent[0]!)).toEqual([
      "POST",
      `${B}/projects/prj_1/stages/stg_prod/revalidate`,
      { tags: ["posts", "home"], paths: ["/blog"] },
    ]);
  });
});

describe("nbo-server project", () => {
  it("setup with a deploy key prints the public key and the next step", async () => {
    const setup = JSON.stringify({
      name: "site",
      repo: "git@example.com:me/site.git",
      productionBranch: "main",
      framework: "static",
      buildCommand: "npm ci && npm run build",
      clouds: [{ target: "kubernetes" }],
      credential: { kind: "deploy-key" },
    });
    const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKE nbo-site";
    const r = await run(["project", "setup", "--body-file", "/setup.json"], {
      files: { "/setup.json": setup },
      answers: [
        { status: 201, body: { project: { id: "prj_9", name: "site" } } },
        {
          status: 200,
          body: { repo: "git@example.com:me/site.git", credential: { kind: "deploy-key", publicKey: pub } },
        },
      ],
    });
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual(["POST", `${B}/projects/setup`, JSON.parse(setup)]);
    expect(req(r.sent[1]!)).toEqual(["GET", `${B}/projects/prj_9/git`, undefined]);
    const text = r.out.join("\n");
    expect(text).toContain(pub);
    expect(text).toContain("nbo-server project retry prj_9");
  });

  it("retry", async () => {
    const r = await run(["project", "retry", "prj_9"], { answers: [{ status: 202, body: {} }] });
    expect(req(r.sent[0]!)).toEqual(["POST", `${B}/projects/prj_9/setup/retry`, {}]);
  });
});

describe("nbo-server api", () => {
  it("sends any route, with a body from a file or stdin", async () => {
    const g = await run(["api", "GET", "/projects"], { answers: [{ status: 200, body: [] }] });
    expect(req(g.sent[0]!)).toEqual(["GET", `${B}/projects`, undefined]);
    const f = await run(["api", "PUT", "/projects/prj_1/env/API_KEY", "--body-file", "/b.json"], {
      files: { "/b.json": '{"value":"v","secret":true}' },
    });
    expect(req(f.sent[0]!)).toEqual(["PUT", `${B}/projects/prj_1/env/API_KEY`, { value: "v", secret: true }]);
    const s = await run(["api", "post", "/projects/prj_1/builds", "--body-stdin"], { stdin: "{}" });
    expect(req(s.sent[0]!)).toEqual(["POST", `${B}/projects/prj_1/builds`, {}]);
  });

  it("refuses a path that is not a route", async () => {
    const r = await run(["api", "GET", "http://evil.example.com/x"]);
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
  });
});

describe("nbo-server ids stay inside their route", () => {
  it.each([
    [["token", "revoke", ".."]],
    [["token", "revoke", "."]],
    [["project", "retry", ".."]],
    [["revalidate", "..", "--stage", "x", "--tag", "t"]],
    [["revalidate", "prj_1", "--stage", ".", "--tag", "t"]],
    [["disconnect", "kubernetes", "a/b"]],
    [["cluster", "test", "a\\b"]],
    [["transfer", "cancel", ""]],
  ])("ids form %# are refused (exit 2) and send nothing", async (argv) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
  });
});

describe("nbo-server errors", () => {
  it("a stray argument is refused without echoing it", async () => {
    const r = await run(["status", "nbo_tok_SECRET_pasted"]);
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
    expect([...r.out, ...r.err].join("\n")).not.toContain("SECRET");
  });

  it("help says api has the server's full power", async () => {
    const r = await run(["help"]);
    expect(r.out.join("\n")).toMatch(/api .*\n.*full power/i);
  });

  it("a 409 answer exits 1 with the status and error", async () => {
    const r = await run(["disconnect", "google"], {
      answers: [{ status: 409, body: { error: "projects still run on Cloud Run: site" } }],
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("nbo-server: 409 projects still run on Cloud Run: site");
  });

  it("an unreachable control-plane exits 1 and names the address", async () => {
    const io: ServerCliIO = {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      readFile: async () => "",
      stdin: async () => "",
      out: () => {},
      err: (l) => errs.push(l),
      env: {},
    };
    const errs: string[] = [];
    expect(await runServerCli(["status"], io)).toBe(1);
    expect(errs.join("\n")).toContain("127.0.0.1:8081");
  });

  it("an unknown command exits 2", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
  });
});

describe("nbo-server never takes a secret on the command line (Review Focus 4)", () => {
  it("the kubeconfig text from the file appears in the request body only", async () => {
    const r = await run(
      ["connect", "kubernetes", "--name", "hetzner", "--kubeconfig-file", "/kc", "--registry-file", "/reg.json"],
      {
        files: { "/kc": KUBECONFIG, "/reg.json": REGISTRY },
        answers: [{ status: 400, body: { error: "the cluster refused the credentials" } }],
      },
    );
    const s = r.sent[0]!;
    expect(s.body).toContain("kube-SECRET-0123456789");
    expect(s.url).not.toContain("SECRET");
    expect(JSON.stringify(s.headers)).not.toContain("SECRET");
    expect([...r.out, ...r.err].join("\n")).not.toContain("SECRET");
  });

  it("the admin kubeconfig and Google key appear in the request body only", async () => {
    const e = await run(
      ["edge", "install", "--cluster", "kc_abc", "--admin-kubeconfig-file", "-", "--confirm-billing"],
      { stdin: ADMIN_KUBECONFIG, answers: [{ status: 202, body: { job: {} } }] },
    );
    expect(e.sent[0]!.body).toContain("admin-SECRET");
    expect(e.sent[0]!.url + JSON.stringify(e.sent[0]!.headers) + [...e.out, ...e.err].join("\n")).not.toContain(
      "SECRET",
    );
    const g = await run(["connect", "google", "--key-file", "/k.json", "--region", "europe-west1"], {
      files: { "/k.json": GOOGLE_KEY },
    });
    expect(g.sent[0]!.url + JSON.stringify(g.sent[0]!.headers) + [...g.out, ...g.err].join("\n")).not.toContain(
      "SECRET",
    );
  });

  it.each([
    [["connect", "kubernetes", "--name", "x", "--kubeconfig", KUBECONFIG, "--registry-file", "/reg.json"]],
    [["edge", "install", "--cluster", "kc_abc", "--admin-kubeconfig", ADMIN_KUBECONFIG, "--confirm-billing"]],
    [["token", "list", "--token", "nbo_tok_SECRET"]],
    [["connect", "google", "--key", GOOGLE_KEY, "--region", "europe-west1"]],
    [["cluster", "update-setup", "kc_abc", "--kubeconfig", ADMIN_KUBECONFIG]],
    [["api", "GET", "/projects", "--token", "nbo_tok_SECRET"]],
    [["connect", "kubernetes", "--name", "x", `--kubeconfig=${KUBECONFIG}`, "--registry-file", "/reg.json"]],
  ])("flag form %# is an unknown flag (exit 2) and sends nothing", async (argv) => {
    const r = await run(argv, { files: { "/reg.json": REGISTRY } });
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
    expect([...r.out, ...r.err].join("\n")).not.toContain("SECRET");
  });

  it("two flags can't both read stdin", async () => {
    const r = await run(["connect", "kubernetes", "--name", "x", "--kubeconfig-file", "-", "--registry-file", "-"], {
      stdin: KUBECONFIG,
    });
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
  });
});

describe("nbo-server link, unlink and keys", () => {
  const CODE = "enr_cli_Wq83LxPz5Tb";
  const URL_ = "https://link.example.com";
  const FP = "sha256:" + "A".repeat(43);
  const linked = { status: 201, body: { linked: true, coreId: "core_1", teamId: "team_1", linkUrl: URL_ } };

  it("link reads the code from stdin with -", async () => {
    const r = await run(["link", "-", "--url", URL_, "--owner-key", FP], { stdin: `${CODE}\n`, answers: [linked] });
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual([
      "POST",
      `${B}/system/link/enroll`,
      { url: URL_, code: CODE, ownerKeyFingerprint: FP },
    ]);
    expect([...r.out, ...r.err].join("\n")).not.toContain(CODE);
  });

  it("link sends url, code and owner key fingerprint to /system/link/enroll and never prints the code", async () => {
    const r = await run(["link", CODE, "--url", URL_, "--owner-key", FP], { answers: [linked] });
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual([
      "POST",
      `${B}/system/link/enroll`,
      { url: URL_, code: CODE, ownerKeyFingerprint: FP },
    ]);
    expect(r.out.join("\n")).toContain("core_1");
    expect([...r.out, ...r.err].join("\n")).not.toContain(CODE);
    // A refusal names no code either.
    const refused = await run(["link", CODE, "--url", URL_, "--owner-key", FP], {
      answers: [{ status: 400, body: { error: "the platform says the code is used, expired or unknown" } }],
    });
    expect(refused.code).toBe(1);
    expect([...refused.out, ...refused.err].join("\n")).not.toContain(CODE);
    // Both flags are required, and nothing is sent without them.
    const missing = await run(["link", CODE, "--url", URL_]);
    expect(missing.code).toBe(2);
    expect(missing.sent).toHaveLength(0);
    expect([...missing.out, ...missing.err].join("\n")).not.toContain(CODE);
  });

  it("link status and link journal read the link routes", async () => {
    const s = await run(["link", "status"], { answers: [{ status: 200, body: { linked: false } }] });
    expect(req(s.sent[0]!)).toEqual(["GET", `${B}/link/status`, undefined]);
    const j = await run(["link", "journal", "--limit", "20"], { answers: [{ status: 200, body: [] }] });
    expect(req(j.sent[0]!)).toEqual(["GET", `${B}/link/journal?limit=20`, undefined]);
    const d = await run(["link", "journal"], { answers: [{ status: 200, body: [] }] });
    expect(req(d.sent[0]!)).toEqual(["GET", `${B}/link/journal`, undefined]);
    const bad = await run(["link", "journal", "--limit", "lots"]);
    expect(bad.code).toBe(2);
    expect(bad.sent).toHaveLength(0);
  });

  it("unlink calls /system/link/unlink", async () => {
    const r = await run(["unlink"], { answers: [{ status: 204 }] });
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual(["POST", `${B}/system/link/unlink`, {}]);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toMatch(/^Unlinked/);
  });

  it("keys reset --key sends the fingerprint and prints the code, its expiry and the key", async () => {
    const fp = "sha256:AAAAAAAAAAAAAAAAAAAAA_-bbbbbbbbbbbbbbbbbbbb";
    const answer = {
      code: "abcd-efgh-ijkl-mnop-qrst-uvwx-yz",
      expiresAt: "2026-11-13T13:00:00.000Z",
      keyFingerprint: fp,
    };
    const r = await run(["keys", "reset", "--key", fp], { answers: [{ status: 200, body: answer }] });
    expect(r.code).toBe(0);
    expect(req(r.sent[0]!)).toEqual(["POST", `${B}/system/link/keys-reset`, { keyFingerprint: fp }]);
    const text = r.out.join("\n");
    expect(text).toContain(answer.code);
    expect(text).toContain(answer.expiresAt);
    expect(text).toContain(fp);
    expect(text).toMatch(/any other key .* uses the code up/);
  });

  it("keys reset without a valid --key exits 2 with usage and sends nothing", async () => {
    for (const args of [
      ["keys", "reset"],
      ["keys", "reset", "--key", ""],
      ["keys", "reset", "--key", "abc"],
    ]) {
      const r = await run(args, { answers: [] });
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.sent).toHaveLength(0);
      const err = r.err.join("\n");
      expect(err).toContain("nbo-server keys reset --key sha256:<fingerprint>");
      expect(err).toContain('Run "nbo-server help" for the commands.');
    }
  });

  it("keys reset exits 1 with a clear message when the answer has no code", async () => {
    for (const body of [
      { expiresAt: "2026-11-13T13:00:00.000Z" },
      { code: "", expiresAt: "2026-11-13T13:00:00.000Z" },
      "nope",
    ]) {
      const r = await run(["keys", "reset", "--key", "sha256:AAAAAAAAAAAAAAAAAAAAA_-bbbbbbbbbbbbbbbbbbbb"], {
        answers: [{ status: 200, body }],
      });
      expect(r.code, JSON.stringify(body)).toBe(1);
      expect(r.out.join("\n")).not.toMatch(/Reset code/);
      expect(r.err.join("\n")).toContain("nbo-server: the control-plane's answer has no reset code");
    }
  });

  it("keys list reads the member keys", async () => {
    const r = await run(["keys", "list"], { answers: [{ status: 200, body: [] }] });
    expect(req(r.sent[0]!)).toEqual(["GET", `${B}/link/member-keys`, undefined]);
  });
});
