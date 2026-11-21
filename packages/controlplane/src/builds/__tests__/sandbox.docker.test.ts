// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The container sandbox against a real Docker daemon: opt in with NBO_TEST_DOCKER=1 (pulls the build image once).
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createStore, type Store } from "../../store/store.js";
import { createRunner } from "../runner.js";
import { run } from "../run.js";
import { containerSandboxes, defaultBuildImage, egressHelperImage, egressScript } from "../sandbox.js";

const scratchDirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of stores.splice(0)) s.close();
  for (const d of scratchDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(d);
  return d;
}

// The sweep would remove every nbo.build container on this daemon; here only the test's own go.
const docker: typeof run = (cmd, args, o) =>
  args[0] === "ps" || (args[0] === "volume" && args[1] === "ls") ? Promise.resolve("") : run(cmd, args, o);

async function build(
  buildCommand: string,
  framework = "static",
  guard: { freeBytes?: (dir: string) => Promise<number>; watchEveryMs?: number } = {},
) {
  const repo = await scratch("nbo-docker-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await writeFile(join(repo, "package.json"), "{}");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  const store = createStore(join(await scratch("nbo-docker-db-"), "test.db"), { secretKey: randomBytes(32) });
  stores.push(store);
  const proj = store.createProject("acme");
  store.setGitConfig(proj.id, { repo, productionBranch: "main", framework, buildCommand, outputDir: "dist" });
  store.createEnvironment(proj.id, "k8s", "kubernetes");
  store.setEnv({ projectId: proj.id }, "API_URL", "https://api.example.com", false);
  store.setEnv({ projectId: proj.id }, "QUOTED", "it's\nmulti $HOME `x`", false);
  let manifest = "";
  const trigger = {
    triggerDeploy: vi.fn(async (_env: string, nboDir: string) => {
      manifest = await readFile(join(nboDir, "manifest.json"), "utf8");
      return { id: "d", environmentId: "e", contentId: "c", status: "succeeded", url: "u", error: "", createdAt: "" };
    }),
  };
  const queued = store.createQueuedBuild(proj.id, git("rev-parse", "HEAD").toString().trim());
  // The disk guard on, with a minimum any working disk has, so the real `df` is read.
  const settings = {
    image: defaultBuildImage,
    cpus: "1",
    memory: "1g",
    minFree: "1m",
    egress: "open" as const,
    install: "nbo-test",
    dataDirs: [tmpdir()],
  };
  const sandbox = containerSandboxes(settings, { docker, ...guard });
  await createRunner(store, trigger, { sandbox }).runBuild(queued.id);
  const left = execFileSync("docker", ["ps", "-aq", "--filter", `label=nbo.build=${queued.id}`])
    .toString()
    .trim();
  const volumes = execFileSync("docker", ["volume", "ls", "-q", "--filter", `label=nbo.build=${queued.id}`]);
  return { done: store.getBuild(queued.id), manifest, left, volumes: volumes.toString().trim() };
}

describe.skipIf(process.env.NBO_TEST_DOCKER !== "1")("container sandbox on a real Docker daemon", () => {
  it("the build sees none of NBO's secrets, files or socket, and its static output deploys", async () => {
    const keyFile = join(await scratch("nbo-docker-keys-"), "nbo-secret.key");
    await writeFile(keyFile, "TOPSECRET-KEY-BYTES");
    vi.stubEnv("NBO_SECRET_KEY_FILE", keyFile);
    vi.stubEnv("NBO_TEST_LEAK", "leaky-value-123");
    const adapter = `node -e "import(process.env.NEXT_ADAPTER_PATH).then((m) => console.log('adapter-loaded', typeof m.default.onBuildComplete))"`;
    const { done, manifest, left, volumes } = await build(
      [
        `cat '${keyFile}'`,
        "cat /keys/nbo-secret.key /data/nbo.db",
        "ls -l /var/run/docker.sock",
        "echo uid=$(id -u)",
        "touch /etc/x",
        "env | sort",
        "echo pnpm=$(pnpm --version)",
        'echo "q=[$QUOTED]"',
        `${adapter} && mkdir dist && echo hi > dist/index.html`,
      ].join("; "),
    );
    expect(done.status, done.error).toBe("succeeded");
    expect(done.log).not.toContain("TOPSECRET");
    expect(done.log).not.toContain("leaky-value-123");
    expect(done.log).not.toContain("NBO_SECRET_KEY_FILE");
    expect(done.log).toMatch(/docker\.sock'?: No such file/);
    expect(done.log).toMatch(/^uid=1000$/m);
    expect(done.log).toMatch(/touch: cannot touch '\/etc\/x': Read-only file system/);
    expect(done.log).toMatch(/^HOME=\/work\/\.home$/m);
    expect(done.log).toMatch(/^API_URL=https:\/\/api\.example\.com$/m);
    expect(done.log).toMatch(/^NBO_ENV=production$/m);
    // Values reach the build exactly, quotes, newlines and $ included (they travel on stdin).
    expect(done.log).toContain("q=[it's\nmulti $HOME `x`]");
    expect(done.log).toContain("adapter-loaded function");
    // pnpm through corepack, downloaded on first use.
    expect(done.log).toMatch(/^pnpm=\d+\.\d+\.\d+$/m);
    expect(JSON.parse(manifest)).toHaveProperty("specVersion");
    expect(left).toBe("");
    expect(volumes).toBe("");
  }, 600_000);

  it("the disk guard stops a running build: container and volume gone, the build failed", async () => {
    // The check before the build passes; a few ticks into "sleep 120" the disk reads full.
    let measured = 0;
    const { done, left, volumes } = await build("sleep 120", "static", {
      freeBytes: async () => (++measured > 5 ? 0 : 50 * 2 ** 30),
      watchEveryMs: 200,
    });
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/^stopped: the disk is almost full \(.+ has 0\.0 GiB free\)$/);
    expect(left).toBe("");
    expect(volumes).toBe("");
  }, 600_000);

  it("static output with a symlink is refused by the producer inside the container", async () => {
    const { done, left, volumes } = await build(
      "mkdir dist && echo hi > dist/index.html && ln -s /etc/passwd dist/leak",
    );
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/symlinks are not allowed in a build directory: .*leak/);
    expect(left).toBe("");
    expect(volumes).toBe("");
  }, 600_000);

  it("a .nbo/ holding the chained links that get past a lexical check is refused at copy-out", async () => {
    const chain = [
      "mkdir -p .nbo/c .nbo/a1/a2/a3/a4/a5/a6",
      "ln -s ../../../../../../c .nbo/a1/a2/a3/a4/a5/a6/L1",
      "ln -s a1/a2/a3/a4/a5/a6/L1/../../../../../../../ .nbo/L2",
      "ln -s L2/etc/passwd .nbo/leak",
      "cat .nbo/leak | head -1",
    ].join(" && ");
    const { done, left, volumes } = await build(chain, "nextjs");
    expect(done.status).toBe("failed");
    // Windows: this host's tar can't make the links at all, which fails the build too.
    expect(done.error).toMatch(
      process.platform === "win32"
        ? /has a link or special file|unpacking the build output failed/
        : /has a link or special file: \.nbo\//,
    );
    expect(left).toBe("");
    expect(volumes).toBe("");
  }, 600_000);
});

// The firewall helper, as NBO runs it, for the test's own looks at the host's chain.
const onHost = (pid: string, script: string) =>
  execFileSync("docker", [
    ...["run", "--rm", "--privileged", "--pid=host", "--network=host", egressHelperImage],
    ...["nsenter", "-t", pid, "-m", "-n", "sh", "-c", script],
  ]).toString();

describe.skipIf(process.env.NBO_TEST_DOCKER !== "1")("restricted egress on a real Docker daemon", () => {
  it("a build on nbo-builds can't reach link-local or private addresses, but resolves and reaches the internet", async () => {
    // Docker Desktop keeps iptables in dockerd's mount namespace, not in pid 1's as a Linux server does.
    const pid = execFileSync("docker", [
      ...["run", "--rm", "--privileged", "--pid=host", egressHelperImage, "sh", "-c"],
      "nsenter -t 1 -m sh -c 'command -v iptables' >/dev/null && echo 1 || pidof dockerd",
    ])
      .toString()
      .trim()
      .split(" ")[0]!;
    const ours = () =>
      onHost(pid, "iptables -S DOCKER-USER")
        .split("\n")
        .filter((l) => l.includes("nbo-builds0"));
    const removeRules = egressScript
      .split("\n")
      .filter((l) => l.startsWith("while"))
      .join("\n");
    const settings = {
      image: defaultBuildImage,
      cpus: "1",
      memory: "1g",
      minFree: "0",
      egress: "restricted" as const,
      install: "nbo-test",
      dataDirs: [],
    };
    const sandboxes = containerSandboxes(settings, { docker, hostPid: pid });
    const sb = sandboxes("egress1", () => {});
    const sb2 = sandboxes("egress2", () => {});
    const clone = await scratch("nbo-docker-egress-");
    try {
      await sb.prepare(clone);
      // Another build's container on the same network: a private (172.16.0.0/12) address with a server on it.
      execFileSync("docker", [
        ...["run", "-d", "--name", "nbo-egress-peer", "--network", "nbo-builds", defaultBuildImage],
        ...["node", "-e", 'require("http").createServer((q, s) => s.end("ok")).listen(8080)'],
      ]);
      const peer = execFileSync("docker", [
        ...["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "nbo-egress-peer"],
      ])
        .toString()
        .trim();
      const js = [
        'const t = (u) => fetch(u, { signal: AbortSignal.timeout(5000) }).then((r) => "ok", () => "blocked");',
        `Promise.all(["http://${peer}:8080", "http://169.254.169.254/", "https://registry.npmjs.org/"].map(t))`,
        '.then((r) => console.log("egress=" + r.join(",")));',
      ].join(" ");
      const probe = async () =>
        /egress=(\S+)/.exec(await sb.run(`node -e '${js}'`, [], { cwd: clone, env: {} }))![1]!.split(",");
      // The registry is looked up by name, so DNS works too.
      expect(await probe()).toEqual(["blocked", "blocked", "ok"]);
      // The next build checks again (-C) and adds nothing.
      await sb2.prepare(await scratch("nbo-docker-egress-"));
      expect(ours()).toEqual([
        "-A DOCKER-USER -i nbo-builds0 -p tcp -m tcp --dport 53 -j ACCEPT",
        "-A DOCKER-USER -i nbo-builds0 -p udp -m udp --dport 53 -j ACCEPT",
        "-A DOCKER-USER -d 100.64.0.0/10 -i nbo-builds0 -j DROP",
        "-A DOCKER-USER -d 192.168.0.0/16 -i nbo-builds0 -j DROP",
        "-A DOCKER-USER -d 172.16.0.0/12 -i nbo-builds0 -j DROP",
        "-A DOCKER-USER -d 10.0.0.0/8 -i nbo-builds0 -j DROP",
        "-A DOCKER-USER -d 169.254.0.0/16 -i nbo-builds0 -j DROP",
      ]);
      // Without the rules the same peer answers: they did the blocking.
      onHost(pid, removeRules);
      expect((await probe())[0]).toBe("ok");
    } finally {
      await sb.dispose();
      await sb2.dispose();
      execFileSync("docker", ["rm", "-f", "nbo-egress-peer"], { stdio: "ignore" });
      onHost(pid, removeRules);
      execFileSync("docker", ["network", "rm", "nbo-builds"], { stdio: "ignore" });
    }
    expect(ours()).toEqual([]);
  }, 600_000);
});
