// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { link, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createStore, type Store } from "../../store/store.js";
import { createRunner } from "../runner.js";
import type { run } from "../run.js";
import { containerSandboxes, parseBuildSandbox, type ProduceTools } from "../sandbox.js";

type Exec = typeof run;
type Opts = Parameters<Exec>[2];

const scratchDirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  for (const d of scratchDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scratch(prefix = "nbo-sandbox-test-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(d);
  return d;
}

// fakeDocker records every docker call; handlers answer by subcommand ("exec" is a step; prepare's own execs
// are "printenv" and "corepack").
function fakeDocker(handlers: Record<string, (args: string[], opts: Opts) => Promise<string> | string> = {}) {
  const calls: { args: string[]; opts: Opts }[] = [];
  const answers = {
    printenv: () => "/usr/local/bin:/usr/bin\n",
    df: () => dfOut(100 * gib),
    info: () => "/var/lib/docker\n",
    ...handlers,
  };
  const exec: Exec = async (cmd, args, opts) => {
    expect(cmd).toBe("docker");
    calls.push({ args, opts });
    const own =
      args[0] === "exec" &&
      !args.includes("sh") &&
      args.find((a) => a === "printenv" || a === "corepack" || a === "df");
    const h = answers[own || (args[0] === "volume" || args[0] === "network" ? `${args[0]} ${args[1]}` : args[0]!)];
    return h ? h(args, opts) : "";
  };
  const lines = () => calls.map((c) => c.args.join(" "));
  return { calls, exec, lines };
}

// containerOutput: a fake `docker cp <container>:<path> -`, the tar of what make() leaves in a folder named .nbo.
function containerOutput(make: (nbo: string) => Promise<void> = async () => {}) {
  const calls: string[][] = [];
  const copyOut = (args: string[]) => {
    calls.push(args);
    return Readable.from(
      (async function* () {
        const dir = await scratch("nbo-sandbox-ctr-");
        await mkdir(join(dir, ".nbo"));
        await make(join(dir, ".nbo"));
        yield execFileSync("tar", ["-cf", "-", ".nbo"], { cwd: dir, maxBuffer: 1 << 26 });
      })(),
    );
  };
  return { calls, copyOut };
}

const pathInside = "/work/.home/bin:/usr/local/bin:/usr/bin";
// What each step's shell runs before the command: the exports NBO sends on stdin.
const stdinScript = 'eval "$(cat)"\n';
// script and envOf read a step's command and the variables it was given.
const script = (args: string[]) => args.at(-1)!.replace(stdinScript, "");
const envOf = (opts: Opts) =>
  Object.fromEntries(
    (opts?.input ?? "").split("\n").map((l) => {
      const m = /^export ([A-Z_][A-Z0-9_]*)='(.*)'$/s.exec(l)!;
      return [m[1], m[2]!.replaceAll(`'\\''`, "'")];
    }),
  );
const producer = "node /work/.nbo-adapter/node_modules/@nbo/next-adapter/src/produce-cli.js";

// File symlinks need a privilege Windows rarely grants; CI and the Linux container run these.
const canSymlink = (() => {
  const dir = join(tmpdir(), `nbo-symlink-probe-${process.pid}`);
  try {
    execFileSync(process.execPath, ["-e", `require("fs").symlinkSync("x", ${JSON.stringify(dir)})`], {
      stdio: "ignore",
    });
    execFileSync(process.execPath, ["-e", `require("fs").unlinkSync(${JSON.stringify(dir)})`]);
    return true;
  } catch {
    return false;
  }
})();

const gib = 2 ** 30;
// The disk guard is off here ("0"); its own tests turn it on.
// Egress "open" here (Docker's default bridge, no firewall helper); its own tests restrict it.
const settings = {
  image: "node:test",
  cpus: "2",
  memory: "4g",
  minFree: "0",
  egress: "open" as "open" | "restricted",
  install: "i1",
  dataDirs: [] as string[],
};
// dfOut is `df -Pk /work` saying `free` bytes are available.
const dfOut = (free: number) =>
  `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 104857600 1 ${free / 1024} 1% /work\n`;
const timedOut = () => Object.assign(new Error("npm run build timed out after 600000ms"), { timedOut: true });

describe("parseBuildSandbox", () => {
  it("defaults to a container in production and to none in dev", () => {
    expect(parseBuildSandbox({}, "production")).toMatchObject({ isolation: "container", cpus: "2", memory: "4g" });
    expect(parseBuildSandbox({}, "production").image).toMatch(/^node:24[\w.-]*-bookworm@sha256:[0-9a-f]{64}$/);
    expect(parseBuildSandbox({}, "dev").isolation).toBe("none");
    expect(
      parseBuildSandbox(
        {
          NBO_BUILD_ISOLATION: "container",
          NBO_BUILD_IMAGE: "node:22",
          NBO_BUILD_CPUS: "1.5",
          NBO_BUILD_MEMORY: "512m",
        },
        "dev",
      ),
    ).toEqual({
      isolation: "container",
      image: "node:22",
      cpus: "1.5",
      memory: "512m",
      minFree: "10g",
      egress: "restricted",
    });
  });

  it("NBO_BUILD_MIN_FREE: 10g by default, a size like NBO_BUILD_MEMORY, or 0 for off", () => {
    expect(parseBuildSandbox({}, "production").minFree).toBe("10g");
    expect(parseBuildSandbox({ NBO_BUILD_MIN_FREE: "500m" }, "production").minFree).toBe("500m");
    expect(parseBuildSandbox({ NBO_BUILD_MIN_FREE: "0" }, "production").minFree).toBe("0");
    expect(() => parseBuildSandbox({ NBO_BUILD_MIN_FREE: "10 GB" }, "dev")).toThrow(/NBO_BUILD_MIN_FREE/);
  });

  it("NBO_BUILD_EGRESS: restricted by default, or open", () => {
    expect(parseBuildSandbox({}, "production").egress).toBe("restricted");
    expect(parseBuildSandbox({ NBO_BUILD_EGRESS: "open" }, "production").egress).toBe("open");
    expect(() => parseBuildSandbox({ NBO_BUILD_EGRESS: "closed" }, "production")).toThrow(
      'NBO_BUILD_EGRESS must be "restricted" or "open"',
    );
  });

  it("refuses bad values, naming the setting", () => {
    expect(() => parseBuildSandbox({ NBO_BUILD_ISOLATION: "chroot" }, "dev")).toThrow(/NBO_BUILD_ISOLATION/);
    expect(() => parseBuildSandbox({ NBO_BUILD_IMAGE: "--privileged" }, "dev")).toThrow(/NBO_BUILD_IMAGE/);
    expect(() => parseBuildSandbox({ NBO_BUILD_CPUS: "0" }, "dev")).toThrow(/NBO_BUILD_CPUS/);
    expect(() => parseBuildSandbox({ NBO_BUILD_CPUS: "two" }, "dev")).toThrow(/NBO_BUILD_CPUS/);
    expect(() => parseBuildSandbox({ NBO_BUILD_MEMORY: "4 GB" }, "dev")).toThrow(/NBO_BUILD_MEMORY/);
  });
});

describe("container sandbox", () => {
  it("runs a step with exactly the isolation flags, its own volume and only the build's environment", async () => {
    vi.stubEnv("NBO_SECRET_KEY_FILE", "/keys/nbo-secret.key");
    vi.stubEnv("NBO_BUILD_ID", "pinned-id");
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    const d = fakeDocker();
    const clone = await scratch();
    await mkdir(join(clone, "app"));
    const sb = containerSandboxes(settings, { docker: d.exec })("b1", () => {});
    const adapter = await sb.prepare(clone);
    expect(adapter).toBe("/work/.nbo-adapter/node_modules/@nbo/next-adapter/src/adapter.js");
    const onOutput = () => {};
    await sb.run("npm run build", [], {
      cwd: join(clone, "app"),
      shell: true,
      env: { API_URL: "https://api", NBO_ENV: "production", NEXT_ADAPTER_PATH: adapter },
      buildStep: true,
      onOutput,
      redactSecrets: ["s3cret"],
    });

    // (The first three calls are the startup sweep and the image check.)
    expect(d.lines().slice(3, 12)).toEqual([
      "volume create --label nbo.build=b1 --label nbo.install=i1 nbo-build-b1",
      "create --name nbo-build-b1-copy --label nbo.build=b1 --label nbo.install=i1 --network none -v nbo-build-b1:/work node:test sh -c mkdir -p /work/.home/bin && chown -R 1000:1000 /work",
      `cp ${clone}${sep}. nbo-build-b1-copy:/work/src`,
      expect.stringMatching(/^cp .+nbo-adapter-[^ ]+ nbo-build-b1-copy:\/work\/\.nbo-adapter$/),
      "start -a nbo-build-b1-copy",
      "rm -f nbo-build-b1-copy",
      "run -d --init --name nbo-build-b1 --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --pids-limit 4096 --cpus 2 --memory 4g --memory-swap 4g --label nbo.build=b1 --label nbo.install=i1 -v nbo-build-b1:/work node:test sleep infinity",
      "exec nbo-build-b1 printenv PATH",
      `exec -e HOME=/work/.home -e PATH=${pathInside} -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 nbo-build-b1 corepack enable --install-directory /work/.home/bin`,
    ]);
    const exec = d.calls.find((c) => c.args[0] === "exec" && c.args.includes("sh"))!;
    // Values travel on stdin, never on the docker command line (M2).
    expect(exec.args).toEqual([
      "exec",
      "-i",
      "-w",
      "/work/src/app",
      "nbo-build-b1",
      "sh",
      "-c",
      stdinScript + "npm run build",
    ]);
    expect(exec.opts?.input).toBe(
      [
        "export CI='1'",
        "export NBO_BUILD_ID='pinned-id'",
        "export API_URL='https://api'",
        "export NBO_ENV='production'",
        `export NEXT_ADAPTER_PATH='${adapter}'`,
        "export HOME='/work/.home'",
        `export PATH='${pathInside}'`,
        "export COREPACK_ENABLE_DOWNLOAD_PROMPT='0'",
      ].join("\n"),
    );
    // The docker CLI itself keeps NBO's environment; nothing of it is forwarded but NBO_BUILD_ID.
    expect(exec.opts?.env).toBeUndefined();
    expect(exec.opts?.onOutput).toBe(onOutput);
    expect(exec.opts?.redactSecrets).toEqual(["s3cret"]);
    // Errors name the command, never the docker arguments (they carry values).
    expect(exec.opts?.name).toBe("npm run build");
    for (const line of d.lines()) {
      expect(line).not.toMatch(/docker\.sock|nbo-secret\.key|--privileged| -p \d|--publish|--mount/);
    }
    // The only mount anywhere is the build's own volume.
    const mounts = d.calls.flatMap((c) => c.args.filter((_, i) => c.args[i - 1] === "-v"));
    expect(mounts).toEqual(["nbo-build-b1:/work", "nbo-build-b1:/work"]);
  });

  it("empties the clone on this host once it is copied in", async () => {
    const clone = await scratch();
    await writeFile(join(clone, "package.json"), "{}");
    const sb = containerSandboxes(settings, { docker: fakeDocker().exec })("b1", () => {});
    await sb.prepare(clone);
    expect(await readdir(clone)).toEqual([]);
  });

  it("an image without corepack still builds, with a note in the log", async () => {
    const d = fakeDocker({ corepack: () => Promise.reject(new Error("corepack: not found")) });
    let logged = "";
    const sb = containerSandboxes(settings, { docker: d.exec })("b1", (t) => (logged += t));
    await sb.prepare(await scratch());
    expect(logged).toContain("corepack enable failed");
  });

  it("ships the Next.js adapter and the producers with what they import, so they load inside the container", async () => {
    // The staging folder is gone after prepare; list it while docker copies it.
    let listing: string[] = [];
    const d = fakeDocker({
      cp: async (args) => {
        if (args[2]!.endsWith(":/work/.nbo-adapter")) {
          listing = await readdir(join(args[1]!.slice(0, -2), "node_modules", "@nbo"));
        }
        return "";
      },
    });
    const sb = containerSandboxes(settings, { docker: d.exec })("b1", () => {});
    await sb.prepare(await scratch());
    expect(listing).toEqual(expect.arrayContaining(["next-adapter", "producer-static", "writer", "digest", "spec"]));
  });

  it("a step past its limit removes the container at once; dispose removes the rest", async () => {
    const d = fakeDocker({ exec: () => Promise.reject(timedOut()) });
    const clone = await scratch();
    const sb = containerSandboxes(settings, { docker: d.exec })("b1", () => {});
    await sb.prepare(clone);
    await expect(sb.run("npm run build", [], { cwd: clone, env: {} })).rejects.toThrow(/timed out/);
    expect(d.lines().at(-1)).toBe("rm -f nbo-build-b1");
    await sb.dispose();
    expect(d.lines().slice(-2)).toEqual(["rm -f nbo-build-b1 nbo-build-b1-copy", "volume rm -f nbo-build-b1"]);
  });

  it("a failing step (the ignored build step's normal answer) keeps the container", async () => {
    const d = fakeDocker({ exec: () => Promise.reject(new Error("exit 1")) });
    const clone = await scratch();
    const sb = containerSandboxes(settings, { docker: d.exec })("b1", () => {});
    await sb.prepare(clone);
    await expect(sb.run("git diff --quiet", [], { cwd: clone, env: {} })).rejects.toThrow("exit 1");
    expect(d.lines()).not.toContain("rm -f nbo-build-b1");
  });

  it("a build gets 30 minutes in all: each step gets what is left, and none starts after", async () => {
    let t = 0;
    const d = fakeDocker();
    const clone = await scratch();
    const sb = containerSandboxes(settings, { docker: d.exec, now: () => t })("b1", () => {});
    await sb.prepare(clone);
    await sb.run("a", [], { cwd: clone, env: {} });
    expect(d.calls.at(-1)!.opts?.timeoutMs).toBe(10 * 60_000);
    t = 25 * 60_000;
    await sb.run("b", [], { cwd: clone, env: {} });
    expect(d.calls.at(-1)!.opts?.timeoutMs).toBe(5 * 60_000);
    t = 30 * 60_000;
    const execs = d.calls.filter((c) => c.args[0] === "exec").length;
    await expect(sb.run("c", [], { cwd: clone, env: {} })).rejects.toThrow("the build ran past its 30-minute limit");
    expect(d.calls.filter((c) => c.args[0] === "exec").length).toBe(execs);
    expect(d.lines().at(-1)).toBe("rm -f nbo-build-b1");
    // Cleanup is never cut short by the build's limit.
    await sb.dispose();
    expect(d.lines().at(-1)).toBe("volume rm -f nbo-build-b1");
  });

  it("dispose still removes the volume when removing the containers fails", async () => {
    const d = fakeDocker({
      create: () => Promise.reject(new Error("no space left")),
      rm: () => Promise.reject(new Error("daemon gone")),
    });
    const sb = containerSandboxes(settings, { docker: d.exec })("b1", () => {});
    await expect(sb.prepare(await scratch())).rejects.toThrow("no space left");
    await sb.dispose();
    expect(d.lines().at(-1)).toBe("volume rm -f nbo-build-b1");
  });

  it("the startup sweep removes only this install's leftovers, before the first build prepares", async () => {
    const d = fakeDocker({
      ps: () => "c1\nc2\n",
      "volume ls": () => "nbo-build-old\n",
    });
    const sandboxes = containerSandboxes(settings, { docker: d.exec });
    await sandboxes("b1", () => {}).prepare(await scratch());
    expect(d.lines().slice(0, 6)).toEqual([
      "ps -aq --filter label=nbo.install=i1",
      "rm -f c1 c2",
      "volume ls -q --filter label=nbo.install=i1",
      "volume rm -f nbo-build-old",
      "image inspect --format {{.Id}} node:test",
      "volume create --label nbo.build=b1 --label nbo.install=i1 nbo-build-b1",
    ]);
  });

  it("pulls a missing build image once at startup, in the background, and logs it", async () => {
    let release!: () => void;
    const pulling = new Promise<string>((r) => (release = () => r("")));
    const d = fakeDocker({ image: () => Promise.reject(new Error("No such image")), pull: () => pulling });
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const sandboxes = containerSandboxes(settings, { docker: d.exec });
    // A build doesn't wait for the pull (docker shares the download with it).
    await sandboxes("b1", () => {}).prepare(await scratch());
    expect(d.lines()).toContain("pull node:test");
    expect(d.calls.find((c) => c.args[0] === "pull")!.opts?.timeoutMs).toBe(30 * 60_000);
    release();
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith("control-plane: build image node:test pulled"));
    await sandboxes("b2", () => {}).prepare(await scratch());
    expect(d.lines().filter((l) => l.startsWith("pull")).length).toBe(1);
  });

  it.skipIf(process.platform === "win32")("the emptied clone folder stays private to NBO's user (0700)", async () => {
    const clone = await scratch();
    await containerSandboxes(settings, { docker: fakeDocker().exec })("b1", () => {}).prepare(clone);
    expect((await stat(clone)).mode & 0o777).toBe(0o700);
  });

  it("Docker unreachable: prepare fails naming the sandbox and no container is made", async () => {
    const d = fakeDocker({
      "volume create": () =>
        Promise.reject(
          new Error(
            "docker volume create --label nbo.build=b1 nbo-build-b1 failed with exit code 1:\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
          ),
        ),
    });
    const sb = containerSandboxes(settings, { docker: d.exec })("b1", () => {});
    await expect(sb.prepare(await scratch())).rejects.toThrow(
      "the build sandbox needs Docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
    expect(d.lines().some((l) => /^(create|run|exec)/.test(l))).toBe(false);
  });
});

describe("container sandbox: restricted egress", () => {
  const restricted = { ...settings, egress: "restricted" as const };
  const helper =
    "run --rm --privileged --pid=host --network=host alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412 nsenter -t 1 -m -u -n -i sh -c";
  const rules = [
    "-i nbo-builds0 -d 169.254.0.0/16 -j DROP",
    "-i nbo-builds0 -d 10.0.0.0/8 -j DROP",
    "-i nbo-builds0 -d 172.16.0.0/12 -j DROP",
    "-i nbo-builds0 -d 192.168.0.0/16 -j DROP",
    "-i nbo-builds0 -d 100.64.0.0/10 -j DROP",
    "-i nbo-builds0 -p udp --dport 53 -j ACCEPT",
    "-i nbo-builds0 -p tcp --dport 53 -j ACCEPT",
  ];
  // -C first: when every rule is there nothing changes; else ours come out and go in again with -I, DNS on top.
  const script = [
    "set -e",
    rules.map((r) => `iptables -C DOCKER-USER ${r} 2>/dev/null`).join(" && ") + " && exit 0",
    ...rules.map((r) => `while iptables -D DOCKER-USER ${r} 2>/dev/null; do :; done`),
    ...rules.map((r) => `iptables -I DOCKER-USER ${r}`),
  ].join("\n");
  const inspect = 'network inspect --format {{index .Options "com.docker.network.bridge.name"}} nbo-builds';
  let made = false;
  const noNetwork = () => ({
    "network inspect": () => (made ? "nbo-builds0\n" : Promise.reject(new Error("Error: No such network: nbo-builds"))),
    "network create": () => ((made = true), ""),
  });
  afterEach(() => (made = false));

  it("creates nbo-builds, applies the rules on the host, then starts the build on that network", async () => {
    const d = fakeDocker(noNetwork());
    const sb = containerSandboxes(restricted, { docker: d.exec })("b1", () => {});
    await sb.prepare(await scratch());
    expect(d.lines().slice(3, 8)).toEqual([
      "volume create --label nbo.build=b1 --label nbo.install=i1 nbo-build-b1",
      inspect,
      "network create --driver bridge -o com.docker.network.bridge.name=nbo-builds0 nbo-builds",
      inspect,
      `${helper} ${script}`,
    ]);
    const helperCall = d.calls.find((c) => c.args.includes("nsenter"))!;
    expect(helperCall.args.at(-1)).toBe(script);
    expect(d.lines().find((l) => l.startsWith("run -d"))).toContain(" --memory-swap 4g --network nbo-builds --label");
  });

  it("an existing nbo-builds is used as is, and the rules are checked again before every build", async () => {
    const d = fakeDocker({ "network inspect": () => "nbo-builds0\n" });
    const sandboxes = containerSandboxes(restricted, { docker: d.exec });
    await sandboxes("b1", () => {}).prepare(await scratch());
    await sandboxes("b2", () => {}).prepare(await scratch());
    expect(d.lines().filter((l) => l.startsWith("network create"))).toEqual([]);
    expect(d.lines().filter((l) => l.includes("nsenter"))).toEqual([`${helper} ${script}`, `${helper} ${script}`]);
  });

  it("rules that can't be applied fail the build, naming the setting, and start no build container", async () => {
    const d = fakeDocker({
      "network inspect": () => "nbo-builds0\n",
      run: (args) =>
        args.includes("nsenter")
          ? Promise.reject(new Error("the firewall helper failed with exit code 127:\nsh: iptables: not found\n"))
          : "",
    });
    const sb = containerSandboxes(restricted, { docker: d.exec })("b1", () => {});
    await expect(sb.prepare(await scratch())).rejects.toThrow(
      "the build network's firewall rules couldn't be applied (NBO_BUILD_EGRESS=restricted): sh: iptables: not found. Set NBO_BUILD_EGRESS=open to build without them.",
    );
    expect(d.lines().some((l) => l.startsWith("run -d") || l.startsWith("create"))).toBe(false);
    await sb.dispose();
    expect(d.lines().at(-1)).toBe("volume rm -f nbo-build-b1");
  });

  it("a network named nbo-builds with another bridge is refused, not used", async () => {
    const d = fakeDocker({ "network inspect": () => "br-123\n" });
    const sb = containerSandboxes(restricted, { docker: d.exec })("b1", () => {});
    await expect(sb.prepare(await scratch())).rejects.toThrow(
      `the build network's firewall rules couldn't be applied (NBO_BUILD_EGRESS=restricted): the Docker network nbo-builds has the bridge "br-123", not nbo-builds0; remove it. Set NBO_BUILD_EGRESS=open to build without them.`,
    );
    expect(d.lines().some((l) => l.includes("nsenter") || l.startsWith("run -d"))).toBe(false);
  });

  it("open egress: no network, no helper, Docker's default bridge as before", async () => {
    const d = fakeDocker();
    await containerSandboxes(settings, { docker: d.exec })("b1", () => {}).prepare(await scratch());
    expect(d.lines().some((l) => l.startsWith("network") || l.includes("nsenter") || l.includes("--network nbo"))).toBe(
      false,
    );
  });
});

describe("container sandbox: the disk guard", () => {
  const guarded = { ...settings, minFree: "10g", dataDirs: ["/nbo-data"] };
  const steps = (d: ReturnType<typeof fakeDocker>) =>
    d.calls.filter((c) => c.args[0] === "exec" && c.args.includes("sh"));

  it("before the build, measures NBO's folders and Docker's (in the build's own container) and goes on", async () => {
    const d = fakeDocker();
    const freeBytes = vi.fn(async () => 50 * gib);
    const sb = containerSandboxes(guarded, { docker: d.exec, freeBytes })("b1", () => {});
    await sb.prepare(await scratch());
    expect(freeBytes).toHaveBeenCalledWith("/nbo-data");
    expect(d.lines()).toContain("exec nbo-build-b1 df -Pk /work");
    await sb.dispose();
  });

  it("too little free on NBO's data folder: the build fails before any command", async () => {
    const d = fakeDocker();
    const sb = containerSandboxes(guarded, { docker: d.exec, freeBytes: async () => 2 * gib })("b1", () => {});
    await expect(sb.prepare(await scratch())).rejects.toThrow(
      "not enough free disk: /nbo-data has 2.0 GiB free, builds need 10g (NBO_BUILD_MIN_FREE)",
    );
    await sb.dispose();
    expect(steps(d)).toEqual([]);
  });

  it("too little free on Docker's data folder: the build fails naming it", async () => {
    const d = fakeDocker({ df: () => dfOut(3 * gib) });
    const sb = containerSandboxes(guarded, { docker: d.exec, freeBytes: async () => 50 * gib })("b1", () => {});
    await expect(sb.prepare(await scratch())).rejects.toThrow(
      "not enough free disk: /var/lib/docker has 3.0 GiB free, builds need 10g (NBO_BUILD_MIN_FREE)",
    );
    await sb.dispose();
  });

  it("NBO_BUILD_MIN_FREE=0 measures nothing", async () => {
    const d = fakeDocker();
    const freeBytes = vi.fn(async () => 0);
    const sb = containerSandboxes({ ...guarded, minFree: "0" }, { docker: d.exec, freeBytes })("b1", () => {});
    await sb.prepare(await scratch());
    expect(freeBytes).not.toHaveBeenCalled();
    expect(d.lines()).not.toContain("exec nbo-build-b1 df -Pk /work");
  });

  it("during the build: under half the minimum, it removes the container and volume and fails the build", async () => {
    let free = 50 * gib;
    let logged = "";
    const d = fakeDocker({
      // The step runs until its container is removed, as `docker exec` does.
      exec: () =>
        new Promise((_, fail) => {
          const t = setInterval(() => {
            if (d.lines().includes("rm -f nbo-build-b1")) {
              clearInterval(t);
              fail(new Error("npm run build failed with exit code 137:\n"));
            }
          }, 2);
        }),
    });
    const sb = containerSandboxes(guarded, { docker: d.exec, freeBytes: async () => free, watchEveryMs: 5 })(
      "b1",
      (t) => (logged += t),
    );
    const clone = await scratch();
    await sb.prepare(clone);
    const running = sb.run("npm run build", [], { cwd: clone, env: {} });
    free = 4 * gib;
    await expect(running).rejects.toThrow("stopped: the disk is almost full (/nbo-data has 4.0 GiB free)");
    expect(d.lines()).toEqual(expect.arrayContaining(["rm -f nbo-build-b1", "volume rm -f nbo-build-b1"]));
    expect(logged).toContain("stopped: the disk is almost full");
    // Later steps fail the same way and start nothing.
    const execs = steps(d).length;
    await expect(sb.run("next", [], { cwd: clone, env: {} })).rejects.toThrow("stopped: the disk is almost full");
    expect(steps(d).length).toBe(execs);
    await sb.dispose();
  });

  it("between half and the minimum during the build, it lets the build go on", async () => {
    let free = 50 * gib;
    const d = fakeDocker();
    const sb = containerSandboxes(guarded, { docker: d.exec, freeBytes: async () => free, watchEveryMs: 5 })(
      "b1",
      () => {},
    );
    const clone = await scratch();
    await sb.prepare(clone);
    free = 6 * gib;
    await new Promise((r) => setTimeout(r, 40));
    await sb.run("npm run build", [], { cwd: clone, env: {} });
    expect(d.lines()).not.toContain("rm -f nbo-build-b1");
    await sb.dispose();
  });
});

describe("container sandbox: making .nbo/ inside and copying only it out", () => {
  const tools = (step: ProduceTools["step"] = async () => "") =>
    ({ log: () => {}, timed: (fn) => fn(), step }) as ProduceTools;
  const job = (clone: string) => ({
    framework: "static",
    appDir: join(clone, "app"),
    root: clone,
    outputDir: "dist",
    env: { API_URL: "https://api" },
  });

  async function prepared(o: { make?: (nbo: string) => Promise<void>; outputLimit?: number } = {}) {
    const d = fakeDocker();
    const out = containerOutput(o.make);
    const clone = await scratch();
    const sb = containerSandboxes(settings, { docker: d.exec, copyOut: out.copyOut, outputLimit: o.outputLimit })(
      "b1",
      () => {},
    );
    await sb.prepare(clone);
    return { d, out, clone, sb };
  }

  it("restarts the container, runs the producer inside it, stops it, and copies .nbo/ out", async () => {
    const { d, out, clone, sb } = await prepared({ make: (nbo) => writeFile(join(nbo, "manifest.json"), "{}") });
    const step = vi.fn(async () => "");
    expect(await sb.produce(job(clone), tools(step))).toBeUndefined();
    expect(step).toHaveBeenCalledOnce();
    const [cmd, args, env] = step.mock.calls[0] as unknown as [string, string[], Record<string, string>];
    expect([cmd, ...args].join(" ")).toBe(producer);
    expect(env.API_URL).toBe("https://api");
    expect(JSON.parse(env.NBO_PRODUCE!)).toEqual({
      framework: "static",
      appDir: "/work/src/app",
      root: "/work/src",
      outputDir: "dist",
    });
    expect(d.lines().slice(-3)).toEqual(["stop -t 0 nbo-build-b1", "start nbo-build-b1", "stop -t 0 nbo-build-b1"]);
    expect(out.calls).toEqual([["cp", "nbo-build-b1:/work/src/app/.nbo", "-"]]);
    expect(await readdir(join(clone, "app", ".nbo"))).toEqual(["manifest.json"]);
  });

  it("the producer's failure is the build's error, and nothing is copied out", async () => {
    const { out, clone, sb } = await prepared();
    const failure = `${producer} failed with exit code 3:\nProducing...\nnbo-produce-failed: expected the build command to create "dist", but it does not exist\n`;
    const step = async () => Promise.reject(new Error(failure));
    expect(await sb.produce(job(clone), tools(step))).toBe(
      'expected the build command to create "dist", but it does not exist',
    );
    expect(out.calls).toEqual([]);
  });

  it("refuses output over the copy-out limit", async () => {
    const { clone, sb } = await prepared({
      outputLimit: 4096,
      make: (nbo) => writeFile(join(nbo, "big"), Buffer.alloc(20_000)),
    });
    await expect(sb.produce(job(clone), tools())).rejects.toThrow(/larger than 4096 bytes/);
    expect(existsSync(join(clone, "app", ".nbo"))).toBe(false);
  });

  it("a copy-out that stalls ends at the build's 30-minute limit", async () => {
    let t = 0;
    const clone = await scratch();
    // A docker cp that never sends anything.
    const copyOut = () => new Readable({ read() {} });
    const sb = containerSandboxes(settings, { docker: fakeDocker().exec, copyOut, now: () => t })("b1", () => {});
    await sb.prepare(clone);
    t = 30 * 60_000 - 50;
    await expect(sb.produce(job(clone), tools())).rejects.toThrow("the build ran past its 30-minute limit");
    expect(existsSync(join(clone, "app", ".nbo"))).toBe(false);
  });

  it("refuses a hard link in the output", async () => {
    const { clone, sb } = await prepared({
      make: async (nbo) => {
        await writeFile(join(nbo, "a"), "x");
        await link(join(nbo, "a"), join(nbo, "b"));
      },
    });
    await expect(sb.produce(job(clone), tools())).rejects.toThrow(/has a link or special file: \.nbo\/[ab]/);
    expect(existsSync(join(clone, "app", ".nbo"))).toBe(false);
  });

  it("refuses an app folder outside the clone", async () => {
    const { out, clone, sb } = await prepared();
    await expect(sb.produce({ ...job(clone), appDir: join(clone, "..") }, tools())).rejects.toThrow(/outside/);
    expect(out.calls).toEqual([]);
  });

  it.skipIf(!canSymlink).each(["/etc/passwd", "../../keys", "../functions/f", "f"])(
    "refuses .nbo/ with any symlink, even %s",
    async (target) => {
      const { clone, sb } = await prepared({
        make: async (nbo) => {
          await mkdir(join(nbo, "functions"));
          await writeFile(join(nbo, "functions", "f"), "x");
          await symlink(target, join(nbo, "functions", "leak"));
        },
      });
      await expect(sb.produce(job(clone), tools())).rejects.toThrow(
        /has a link or special file: \.nbo\/functions\/leak/,
      );
      expect(existsSync(join(clone, "app", ".nbo"))).toBe(false);
    },
  );

  // The review's chain: each link looks inside lexically, the kernel opens /etc/passwd.
  it.skipIf(!canSymlink)("refuses the chained links that get past a lexical check", async () => {
    const { clone, sb } = await prepared({
      make: async (nbo) => {
        const deep = join(nbo, "a1", "a2", "a3", "a4", "a5", "a6");
        await mkdir(deep, { recursive: true });
        await mkdir(join(nbo, "c"));
        await symlink("../../../../../../c", join(deep, "L1"));
        await symlink("a1/a2/a3/a4/a5/a6/L1/../../../../../../../", join(nbo, "L2"));
        await symlink("L2/etc/passwd", join(nbo, "leak"));
      },
    });
    await expect(sb.produce(job(clone), tools())).rejects.toThrow(/has a link or special file/);
  });

  it.skipIf(!canSymlink)("refuses .nbo/ that is itself a link", async () => {
    const d = fakeDocker();
    const clone = await scratch();
    const copyOut = () =>
      Readable.from(
        (async function* () {
          const dir = await scratch("nbo-sandbox-ctr-");
          await symlink("/", join(dir, ".nbo"));
          yield execFileSync("tar", ["-cf", "-", ".nbo"], { cwd: dir });
        })(),
      );
    const sb = containerSandboxes(settings, { docker: d.exec, copyOut })("b1", () => {});
    await sb.prepare(clone);
    await expect(sb.produce(job(clone), tools())).rejects.toThrow(/has a link or special file: \.nbo$/);
  });
});

describe("runner with the container sandbox", () => {
  async function project(
    buildCommand: string,
    o: { framework?: string; rootDirectory?: string; files?: (repo: string) => Promise<void> } = {},
  ) {
    const repo = await scratch("nbo-sandbox-repo-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    await writeFile(join(repo, "package.json"), "{}");
    await o.files?.(repo);
    git("add", ".");
    git("commit", "-q", "-m", "initial");
    const revision = git("rev-parse", "HEAD").toString().trim();
    const store = createStore(join(await scratch(), "test.db"), { secretKey: randomBytes(32) });
    stores.push(store);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, {
      repo,
      productionBranch: "main",
      framework: o.framework ?? "static",
      buildCommand,
      outputDir: "dist",
      rootDirectory: o.rootDirectory,
    });
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    store.setEnv({ projectId: proj.id }, "API_URL", "https://api.example.com", false);
    return { store, build: store.createQueuedBuild(proj.id, revision) };
  }
  // trigger deploys by reading every file of the .nbo/ it is given.
  const trigger = () => {
    const deployed: string[] = [];
    const read = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await read(join(dir, e.name));
        else deployed.push(await readFile(join(dir, e.name), "utf8"));
      }
    };
    const triggerDeploy = vi.fn(async (_env: string, nboDir: string) => {
      await read(nboDir);
      return { id: "d", environmentId: "e", contentId: "c", status: "succeeded", url: "u", error: "", createdAt: "" };
    });
    return { deployed, triggerDeploy };
  };
  const container = () => {
    // A copy from the container to a host path answers as docker does for a path the build removed.
    const d = fakeDocker({
      cp: (args) =>
        /^nbo-build-[^:]+:/.test(args[1]!) ? Promise.reject(new Error("Could not find the file in container")) : "",
    });
    const out = containerOutput((nbo) => writeFile(join(nbo, "manifest.json"), "from the container"));
    return { d, out, sandbox: containerSandboxes(settings, { docker: d.exec, copyOut: out.copyOut }) };
  };
  const steps = (d: ReturnType<typeof fakeDocker>) =>
    d.calls.filter((c) => c.args[0] === "exec" && c.args.includes("sh")).map((c) => script(c.args));

  it("runs the build command and the producer only through docker, deploys what came out, and removes everything", async () => {
    const { d, out, sandbox } = container();
    // On the host this would write the output itself; through the fake it never runs.
    const { store, build } = await project("mkdir dist && echo host > dist/index.html");
    const t = trigger();
    await createRunner(store, t, { sandbox }).runBuild(build.id);
    const done = store.getBuild(build.id);
    expect(done.status, done.error).toBe("succeeded");
    expect(t.deployed).toEqual(["from the container"]);
    const id = build.id;
    expect(steps(d)).toEqual(["mkdir dist && echo host > dist/index.html", producer]);
    const exec = d.calls.find((c) => c.args[0] === "exec" && c.args.includes("sh"))!;
    expect(exec.args.slice(-4)).toEqual([
      `nbo-build-${id}`,
      "sh",
      "-c",
      stdinScript + "mkdir dist && echo host > dist/index.html",
    ]);
    expect(exec.args.join(" ")).not.toContain("api.example.com");
    expect(envOf(exec.opts)).toMatchObject({
      API_URL: "https://api.example.com",
      NBO_ENV: "production",
      NBO_GIT_COMMIT_REF: "main",
      NEXT_ADAPTER_PATH: "/work/.nbo-adapter/node_modules/@nbo/next-adapter/src/adapter.js",
      CI: "1",
      HOME: "/work/.home",
    });
    expect(out.calls).toEqual([["cp", `nbo-build-${id}:/work/src/.nbo`, "-"]]);
    expect(d.lines().slice(-2)).toEqual([`rm -f nbo-build-${id} nbo-build-${id}-copy`, `volume rm -f nbo-build-${id}`]);
    expect(done.log).toContain("$ mkdir dist && echo host > dist/index.html");
  });

  it("Next.js 14/15: the legacy producer runs inside the container, never in NBO's process", async () => {
    const marker = join(await scratch("nbo-sandbox-marker-"), "loaded");
    const { d, sandbox } = container();
    const { store, build } = await project("next build", {
      framework: "nextjs",
      // What a hostile build leaves for the legacy producer: a tracer that runs wherever it is loaded.
      files: async (repo) => {
        const nft = join(repo, "node_modules", "next", "dist", "compiled", "@vercel", "nft");
        await mkdir(nft, { recursive: true });
        await mkdir(join(repo, ".next"));
        await writeFile(join(repo, ".next", "required-server-files.json"), '{"config":{},"files":[]}');
        await writeFile(join(repo, "node_modules", "next", "package.json"), '{"name":"next","version":"15.0.0"}');
        await writeFile(
          join(nft, "index.js"),
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran"); exports.nodeFileTrace = async () => ({ fileList: [] });`,
        );
      },
    });
    await createRunner(store, trigger(), { sandbox }).runBuild(build.id);
    expect(store.getBuild(build.id).status).toBe("succeeded");
    expect(steps(d)).toEqual(["next build", producer]);
    const produced = d.calls.find((c) => c.args.at(-1) === stdinScript + producer)!;
    const spec = envOf(produced.opts).NBO_PRODUCE!;
    expect(JSON.parse(spec)).toMatchObject({ framework: "nextjs", appDir: "/work/src", root: "/work/src" });
    expect(existsSync(marker)).toBe(false);
  });

  // C2: git checks the repository's own links out on this host.
  it.skipIf(!canSymlink)("a committed dist -> host folder link (and `rm dist`) can't publish a host file", async () => {
    const keys = await scratch("nbo-sandbox-keys-");
    await writeFile(join(keys, "nbo-secret.key"), "TOPSECRET");
    const { sandbox } = container();
    const { store, build } = await project("rm dist", { files: (repo) => symlink(keys, join(repo, "dist")) });
    const t = trigger();
    await createRunner(store, t, { sandbox }).runBuild(build.id);
    expect(t.deployed.join()).not.toContain("TOPSECRET");
    expect(await readFile(join(keys, "nbo-secret.key"), "utf8")).toBe("TOPSECRET");
  });

  it.skipIf(!canSymlink)("a Root Directory linked to a host folder can't make NBO delete or write there", async () => {
    const host = await scratch("nbo-sandbox-host-");
    await mkdir(join(host, "dist"));
    await writeFile(join(host, "dist", "keep.txt"), "keep");
    const { sandbox } = container();
    const { store, build } = await project("true", {
      rootDirectory: "app",
      files: (repo) => symlink(host, join(repo, "app")),
    });
    await createRunner(store, trigger(), { sandbox }).runBuild(build.id);
    expect((await readdir(host)).sort()).toEqual(["dist"]);
    expect(await readdir(join(host, "dist"))).toEqual(["keep.txt"]);
    expect(await readFile(join(host, "dist", "keep.txt"), "utf8")).toBe("keep");
  });

  // R-M4: whether a linked Root Directory's target exists on this host is not told apart.
  it.skipIf(!canSymlink).each(["exists", "missing"])(
    "a Root Directory linked outside the repository (host path %s) reads as missing",
    async (which) => {
      const host = await scratch("nbo-sandbox-host-");
      const target = which === "exists" ? host : join(host, "nope");
      const { d, sandbox } = container();
      const { store, build } = await project("true", {
        rootDirectory: "app",
        files: (repo) => symlink(target, join(repo, "app")),
      });
      await createRunner(store, trigger(), { sandbox }).runBuild(build.id);
      expect(store.getBuild(build.id)).toMatchObject({
        status: "failed",
        error: 'Root Directory "app" does not exist in the repository',
      });
      expect(steps(d)).toEqual([]);
    },
  );

  it("a failed build command still removes the container and the volume", async () => {
    const d = fakeDocker({ exec: () => Promise.reject(new Error("npm run build failed with exit code 2:\n")) });
    const { store, build } = await project("npm run build");
    await createRunner(store, trigger(), { sandbox: containerSandboxes(settings, { docker: d.exec }) }).runBuild(
      build.id,
    );
    expect(store.getBuild(build.id)).toMatchObject({
      status: "failed",
      error: "npm run build failed with exit code 2",
    });
    expect(d.lines().slice(-2)).toEqual([
      `rm -f nbo-build-${build.id} nbo-build-${build.id}-copy`,
      `volume rm -f nbo-build-${build.id}`,
    ]);
  });

  it("Docker unreachable: the build fails naming the sandbox and the command never runs", async () => {
    const d = fakeDocker({
      "volume create": () => Promise.reject(new Error("spawn docker ENOENT")),
    });
    const { store, build } = await project("echo ran > ran.txt");
    await createRunner(store, trigger(), { sandbox: containerSandboxes(settings, { docker: d.exec }) }).runBuild(
      build.id,
    );
    expect(store.getBuild(build.id)).toMatchObject({
      status: "failed",
      error: "the build sandbox needs Docker: spawn docker ENOENT",
    });
    expect(d.calls.some((c) => c.args[0] === "exec")).toBe(false);
  });
});
