// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The build sandbox: where a repository's own commands (the ignored build step and the build command) run and,
// in a container, where its output becomes .nbo/.
// `none` runs them on this host as before; `container` runs them in a throwaway sibling container.
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, statfs } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import spawn from "cross-spawn";
import { childEnv } from "@nbo/deploy";
import type { Mode } from "../mode.js";
import { run } from "./run.js";
import { errMessage, firstLine } from "./runner-helpers.js";

// What produces .nbo/ once the build command is done (@nbo/next-adapter's produce-output.js).
export interface ProduceJob {
  framework: string;
  appDir: string;
  root: string;
  outputDir?: string;
  spa?: boolean;
  rootDirectory?: string;
  env: Record<string, string>;
}

export interface ProduceTools {
  log: (text: string) => void;
  // timed runs the producing as the build's "produce .nbo" phase.
  timed: <T>(fn: () => Promise<T>) => Promise<T>;
  // step runs a command as the build's own step (logged, redacted) through this sandbox's run.
  step: (cmd: string, args: string[], env: Record<string, string>) => Promise<string>;
}

export interface BuildSandbox {
  // prepare copies the clone in; returns the NEXT_ADAPTER_PATH the build sees there (undefined: NBO's own).
  prepare(cloneDir: string): Promise<string | undefined>;
  // run runs a repository command (a shell string in cmd), with run.ts's contract.
  run: typeof run;
  // produce leaves <appDir>/.nbo on this host after the build command; returns why it couldn't, or undefined.
  produce(job: ProduceJob, tools: ProduceTools): Promise<string | undefined>;
  dispose(): Promise<void>;
}

// One sandbox per build; log writes to that build's log.
export type SandboxFactory = (buildId: string, log: (text: string) => void) => BuildSandbox;

type ProduceOutput = (job: ProduceJob & Omit<ProduceTools, "step">) => Promise<string | undefined>;

export const noSandbox: SandboxFactory = () => ({
  prepare: async () => undefined,
  run,
  // On this host, as before the sandbox existed.
  async produce(job, { log, timed }) {
    const path = createRequire(import.meta.url).resolve("@nbo/next-adapter/src/produce-output.js");
    const mod = (await import(pathToFileURL(path).href)) as { produceOutput: ProduceOutput };
    return mod.produceOutput({ ...job, log, timed });
  },
  dispose: async () => {},
});

export interface ContainerSettings {
  image: string;
  cpus: string;
  memory: string;
  // NBO_BUILD_MIN_FREE as written ("0": the disk guard is off).
  minFree: string;
}

export interface SandboxSettings extends ContainerSettings {
  isolation: "container" | "none";
}

// node:24-bookworm (git, python3, make and g++ for native modules), pinned: 24.22.2, built 2026-11-05.
export const defaultBuildImage =
  "node:24.22.2-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40";

// parseBuildSandbox reads NBO_BUILD_ISOLATION, NBO_BUILD_IMAGE, NBO_BUILD_CPUS, NBO_BUILD_MEMORY and
// NBO_BUILD_MIN_FREE once at startup.
// shortcut: production on a Windows host would default to `container`, which only works with Linux containers; set none there.
export function parseBuildSandbox(env: Record<string, string | undefined>, mode: Mode): SandboxSettings {
  const isolation = env.NBO_BUILD_ISOLATION || (mode === "production" ? "container" : "none");
  if (isolation !== "container" && isolation !== "none") {
    throw new Error('NBO_BUILD_ISOLATION must be "container" or "none"');
  }
  const image = env.NBO_BUILD_IMAGE || defaultBuildImage;
  if (!/^[A-Za-z0-9][\w.\-/:@]*$/.test(image)) {
    throw new Error("NBO_BUILD_IMAGE must be an image reference, such as node:24-bookworm");
  }
  const cpus = env.NBO_BUILD_CPUS || "2";
  if (!/^\d+(\.\d+)?$/.test(cpus) || Number(cpus) <= 0) {
    throw new Error("NBO_BUILD_CPUS must be a positive number, such as 2 or 1.5");
  }
  const memory = env.NBO_BUILD_MEMORY || "4g";
  if (!/^[1-9]\d*[bkmg]?$/i.test(memory)) throw new Error("NBO_BUILD_MEMORY must be a size, such as 4g or 512m");
  const minFree = env.NBO_BUILD_MIN_FREE || "10g";
  if (minFree !== "0" && !/^[1-9]\d*[bkmg]?$/i.test(minFree)) {
    throw new Error("NBO_BUILD_MIN_FREE must be a size, such as 10g or 500m, or 0 to turn the disk guard off");
  }
  return { isolation, image, cpus, memory, minFree };
}

// sizeBytes reads a size as Docker does: a number of bytes, or with b, k, m or g.
function sizeBytes(size: string): number {
  const [, n, unit = ""] = /^(\d+)([bkmg]?)$/i.exec(size)!;
  return Number(n) * 1024 ** "bkmg".indexOf(unit.toLowerCase() || "b");
}

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

// buildInstallId is this NBO's own random id, kept in dir: build containers carry it, so the startup sweep
// removes only this install's leftovers when several NBOs share one Docker daemon.
export function buildInstallId(dir: string): string {
  const file = join(dir, "build-install-id");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const id = randomBytes(8).toString("hex");
    writeFileSync(file, id, { mode: 0o600 });
    return id;
  }
}

const stepLimitMs = 10 * 60_000;
const buildLimitMs = 30 * 60_000;
const label = "nbo.build";
const installLabel = "nbo.install";
const pullLimitMs = 30 * 60_000;
const adapterInside = "/work/.nbo-adapter/node_modules/@nbo/next-adapter";
const binInside = "/work/.home/bin";
const cleanupMs = 30_000;
// shortcut: a fixed cap on what copy-out brings back (the .nbo/ tar stream); make it a setting if real sites need more.
const outputLimitBytes = 5 * 2 ** 30;

// containerSandboxes: each build in its own container and volume `nbo-build-<id>`, fed with `docker cp`, so no
// host path is shared and it works the same with NBO on the host or in Compose. The first build waits for a
// sweep of this install's leftovers (labelled nbo.install=<install>) from a stopped NBO; the build image is
// pulled once in the background after it.
// The disk guard (minFree above 0): before the build, NBO's dataDirs (statfs) and Docker's data folder (`df` of
// the volume, from inside the build's own container, so it works in Compose too) need minFree free; while it
// runs, a check every 5 s stops it when either falls under half of that.
// shortcut: builds reach the network (installs need it); private ranges and metadata addresses need host
// firewall rules, the next step.
export function containerSandboxes(
  settings: ContainerSettings & { install: string; dataDirs: string[] },
  opts: {
    docker?: typeof run;
    copyOut?: (args: string[]) => Readable;
    now?: () => number;
    outputLimit?: number;
    freeBytes?: (dir: string) => Promise<number>;
    watchEveryMs?: number;
  } = {},
): SandboxFactory {
  const docker = opts.docker ?? run;
  const copyOut = opts.copyOut ?? dockerStream;
  const now = opts.now ?? Date.now;
  const freeBytes = opts.freeBytes ?? (async (dir: string) => ((s) => s.bavail * s.bsize)(await statfs(dir)));
  const minFree = sizeBytes(settings.minFree);
  const labels = (buildId: string) => [
    "--label",
    `${label}=${buildId}`,
    "--label",
    `${installLabel}=${settings.install}`,
  ];
  const swept = sweep(docker, settings.install);
  void swept.then(() => pullImage(docker, settings.image));
  return (buildId, log) => {
    const volume = `nbo-build-${buildId}`;
    const container = volume;
    const helper = `${volume}-copy`;
    const deadline = now() + buildLimitMs;
    let cloneDir = "";
    // What every exec sets last; prepare puts corepack's pnpm and yarn first on the image's PATH.
    let base: Record<string, string> = { HOME: "/work/.home" };
    // Why the disk guard stopped the build; every later call fails with it.
    let stopped = "";
    let watch: ReturnType<typeof setInterval> | undefined;
    const stoppedOr = (err: unknown) => (stopped ? new Error(stopped, { cause: err }) : err);
    // Every call for the build gets what is left of its 30 minutes (10 at most); cleanup calls don't.
    const call = (args: string[], o: Parameters<typeof run>[2] = {}) => {
      if (stopped) throw new Error(stopped);
      const left = deadline - now();
      if (left <= 0) throw Object.assign(new Error("the build ran past its 30-minute limit"), { timedOut: true });
      return docker("docker", args, { ...o, timeoutMs: Math.min(stepLimitMs, left) });
    };
    const inside = (path: string) => {
      const rel = relative(cloneDir, path);
      if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
        throw new Error(`${path} is outside the cloned repository`);
      }
      return posix.join("/work/src", ...rel.split(sep));
    };
    const removeContainers = (...names: string[]) =>
      docker("docker", ["rm", "-f", ...names], { timeoutMs: cleanupMs }).catch(() => "");
    const execFlags = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // lowOn names the first place with less than `under` bytes free and what it has; one docker exec at most.
    const lowOn = async (under: number, exec: (args: string[]) => Promise<string>): Promise<string | undefined> => {
      for (const dir of settings.dataDirs) {
        const free = await freeBytes(dir);
        if (free < under) return `${dir} has ${gib(free)} free`;
      }
      // The volume lives in Docker's data folder, so its filesystem is that folder's.
      const out = await exec(["exec", container, "df", "-Pk", "/work"]);
      const free = Number(out.trim().split("\n").at(-1)?.split(/\s+/)[3]) * 1024;
      if (Number.isNaN(free)) throw new Error(`can't read the free disk from df: ${firstLine(out)}`);
      if (free >= under) return undefined;
      const root = await docker("docker", ["info", "--format", "{{.DockerRootDir}}"], { timeoutMs: cleanupMs })
        .then((o) => o.trim())
        .catch(() => "");
      return `${root || "Docker's data folder"} has ${gib(free)} free`;
    };
    const stopWatch = () => clearInterval(watch);
    const watchDisk = () => {
      let busy = false;
      watch = setInterval(() => {
        if (busy || stopped) return;
        busy = true;
        void lowOn(minFree / 2, (args) => docker("docker", args, { timeoutMs: cleanupMs }))
          .then(async (low) => {
            if (!low) return;
            stopped = `stopped: the disk is almost full (${low})`;
            stopWatch();
            log(`${stopped}\n`);
            await removeContainers(container);
            await docker("docker", ["volume", "rm", "-f", volume], { timeoutMs: cleanupMs }).catch(() => "");
          })
          // A tick that can't measure (the container is stopped for copy-out) waits for the next.
          .catch(() => {})
          .finally(() => (busy = false));
      }, opts.watchEveryMs ?? 5_000);
      watch.unref();
    };
    return {
      async prepare(dir) {
        await swept;
        cloneDir = dir;
        try {
          await call(["volume", "create", ...labels(buildId), volume]);
        } catch (err) {
          const lines = errMessage(err)
            .split("\n")
            .filter((l) => l.trim());
          throw new Error(`the build sandbox needs Docker: ${lines.at(-1)}`, { cause: err });
        }
        log(`Build sandbox: a container from ${settings.image}\n`);
        const staged = await mkdtemp(join(tmpdir(), "nbo-adapter-"));
        try {
          await stageNextAdapter(staged);
          // A root helper with no network copies the files in and hands them to the build's user.
          await call([
            "create",
            "--name",
            helper,
            ...labels(buildId),
            "--network",
            "none",
            "-v",
            `${volume}:/work`,
            settings.image,
            "sh",
            "-c",
            `mkdir -p ${binInside} && chown -R 1000:1000 /work`,
          ]);
          await call(["cp", `${dir}${sep}.`, `${helper}:/work/src`]);
          // From here on NBO reads nothing of the repository on this host: its links could point anywhere here.
          await rm(dir, { recursive: true, force: true });
          await mkdir(dir, { mode: 0o700 });
          await call(["cp", `${staged}${sep}.`, `${helper}:/work/.nbo-adapter`]);
          await call(["start", "-a", helper]);
          await call(["rm", "-f", helper]);
        } finally {
          await rm(staged, { recursive: true, force: true });
        }
        await call([
          "run",
          "-d",
          "--init",
          "--name",
          container,
          "--user",
          "1000:1000",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--tmpfs",
          "/tmp",
          "--pids-limit",
          "4096",
          "--cpus",
          settings.cpus,
          "--memory",
          settings.memory,
          "--memory-swap",
          settings.memory,
          ...labels(buildId),
          "-v",
          `${volume}:/work`,
          settings.image,
          "sleep",
          "infinity",
        ]);
        if (minFree > 0) {
          const low = await lowOn(minFree, call);
          if (low)
            throw new Error(`not enough free disk: ${low}, builds need ${settings.minFree} (NBO_BUILD_MIN_FREE)`);
          watchDisk();
        }
        const imagePath = (await call(["exec", container, "printenv", "PATH"])).trim();
        base = { ...base, PATH: `${binInside}:${imagePath}`, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
        try {
          await call(["exec", ...execFlags(base), container, "corepack", "enable", "--install-directory", binInside]);
        } catch (err) {
          log(`corepack enable failed, so pnpm and yarn are only what the image has: ${firstLine(errMessage(err))}\n`);
        }
        return `${adapterInside}/src/adapter.js`;
      },
      // Values go to the step's shell on stdin as `export` lines, never on a command line (`ps` and /proc show
      // those to every local user) nor through the docker CLI's own environment (a variable named DOCKER_HOST
      // would redirect it). Inside: only these, with corepack's bin first on the image's PATH.
      async run(cmd, args, o) {
        const pinned: Record<string, string> =
          process.env.NBO_BUILD_ID === undefined ? {} : { NBO_BUILD_ID: process.env.NBO_BUILD_ID };
        const env = { CI: "1", ...pinned, ...o?.env, ...base };
        const exports = Object.entries(env).map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'`);
        const command = [cmd, ...args].join(" ");
        const script = `eval "$(cat)"\n${command}`;
        try {
          return await call(["exec", "-i", "-w", inside(o?.cwd ?? cloneDir), container, "sh", "-c", script], {
            input: exports.join("\n"),
            onOutput: o?.onOutput,
            redactSecrets: o?.redactSecrets,
            name: command,
          });
        } catch (err) {
          // Killing the docker CLI leaves the command running in the container.
          if ((err as { timedOut?: boolean }).timedOut) await removeContainers(container);
          throw stoppedOr(err);
        }
      },
      async produce(job, { timed, step }) {
        const { env, ...where } = job;
        const spec = { ...where, appDir: inside(job.appDir), root: inside(job.root) };
        // A fresh start ends whatever the build left running: nothing else touches .nbo/ while it is made.
        await call(["stop", "-t", "0", container]);
        await call(["start", container]);
        try {
          await timed(() =>
            step("node", [`${adapterInside}/src/produce-cli.js`], { ...env, NBO_PRODUCE: JSON.stringify(spec) }),
          );
        } catch (err) {
          const failed = /^nbo-produce-failed: (.*)$/m.exec(errMessage(err));
          if (failed && !stopped) return failed[1];
          throw stoppedOr(err);
        }
        await call(["stop", "-t", "0", container]);
        // Only .nbo/ comes out, into folders NBO makes (prepare emptied the clone here).
        const nbo = join(job.appDir, ".nbo");
        await mkdir(job.appDir, { recursive: true });
        try {
          const limit = opts.outputLimit ?? outputLimitBytes;
          await untar(copyOut(["cp", `${container}:${inside(nbo)}`, "-"]), job.appDir, limit, deadline - now());
          await refuseLinks(nbo);
        } catch (err) {
          await rm(nbo, { recursive: true, force: true });
          throw stoppedOr(err);
        } finally {
          stopWatch();
        }
        return undefined;
      },
      async dispose() {
        stopWatch();
        if (!cloneDir) return;
        await removeContainers(container, helper);
        await docker("docker", ["volume", "rm", "-f", volume], { timeoutMs: cleanupMs }).catch(() => "");
      },
    };
  };
}

async function sweep(docker: typeof run, install: string): Promise<void> {
  const ids = (out: string) => out.split(/\s+/).filter(Boolean);
  const quick = { timeoutMs: cleanupMs };
  const mine = `label=${installLabel}=${install}`;
  try {
    const containers = ids(await docker("docker", ["ps", "-aq", "--filter", mine], quick));
    if (containers.length) await docker("docker", ["rm", "-f", ...containers], quick);
    const volumes = ids(await docker("docker", ["volume", "ls", "-q", "--filter", mine], quick));
    if (volumes.length) await docker("docker", ["volume", "rm", "-f", ...volumes], quick);
  } catch (err) {
    console.error(`control-plane: removing leftover build containers failed: ${firstLine(errMessage(err))}`);
  }
}

// pullImage fetches the build image if Docker doesn't have it, so the first build doesn't spend its own step
// limit downloading it. Builds don't wait: one that starts meanwhile shares Docker's download.
async function pullImage(docker: typeof run, image: string): Promise<void> {
  const quick = { timeoutMs: cleanupMs };
  const have = await docker("docker", ["image", "inspect", "--format", "{{.Id}}", image], quick).then(
    () => true,
    () => false,
  );
  if (have) return;
  try {
    await docker("docker", ["pull", image], { timeoutMs: pullLimitMs });
    console.log(`control-plane: build image ${image} pulled`);
  } catch (err) {
    console.error(`control-plane: pulling the build image ${image} failed: ${firstLine(errMessage(err))}`);
  }
}

// dockerStream is `docker <args>`'s stdout, failing with docker's own message if it exits non-zero.
function dockerStream(args: string[]): Readable {
  const child = spawn("docker", args, { env: childEnv(process.env, undefined), stdio: ["ignore", "pipe", "pipe"] });
  const out = new PassThrough();
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
  child.stdout!.pipe(out, { end: false });
  child.on("error", (err) => out.destroy(err));
  child.on("close", (code) =>
    code === 0 ? out.end() : out.destroy(new Error(`docker ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`)),
  );
  out.on("close", () => child.kill());
  return out;
}

// untar unpacks a tar stream into dest with this host's tar, failing once it passes limit bytes or takes
// longer than timeoutMs (what is left of the build's 30 minutes).
async function untar(source: Readable, dest: string, limit: number, timeoutMs: number): Promise<void> {
  // MSYS: Git for Windows' tar would copy a link's target (a host file) in place of the link; this makes it refuse.
  const env = { ...process.env, MSYS: "winsymlinks:nativestrict" };
  const tar = spawn("tar", ["-xf", "-", "--no-same-owner"], { cwd: dest, env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  tar.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((done, fail) => {
    tar.on("error", fail);
    tar.on("close", done);
  });
  let total = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      const over =
        total > limit ? new Error(`the build output is larger than ${limit} bytes, the most NBO copies out`) : null;
      done(over, chunk);
    },
  });
  let late = false;
  const timer = setTimeout(
    () => {
      late = true;
      count.destroy(new Error("the build ran past its 30-minute limit"));
      tar.kill();
    },
    Math.max(0, timeoutMs),
  );
  try {
    await pipeline(source, count, tar.stdin!);
  } catch (err) {
    tar.kill();
    await exited.catch(() => null);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const code = await exited;
  if (late) throw new Error("the build ran past its 30-minute limit");
  if (code !== 0) throw new Error(`unpacking the build output failed: ${firstLine(stderr.trim())}`);
}

// refuseLinks throws on anything in the output but plain files and folders. Producers never write links, and a
// symlink (chained ones get past any lexical check) or a hard link's second name could make NBO read a host file.
async function refuseLinks(root: string): Promise<void> {
  const walk = async (path: string): Promise<void> => {
    const st = await lstat(path);
    // tar runs as root here and keeps setuid/setgid/sticky bits; NBO's own files never need them.
    if (st.mode & 0o7000) await chmod(path, st.mode & 0o777);
    if (st.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name));
    } else if (!st.isFile() || st.nlink > 1) {
      const rel = relative(dirname(root), path).split(sep).join("/");
      throw new Error(`the build output has a link or special file: ${rel}`);
    }
  };
  await walk(root);
}

// stageNextAdapter lays @nbo/next-adapter and what it imports out as plain files in dest/node_modules, so
// NEXT_ADAPTER_PATH loads inside the container (pnpm's links point at this host's store).
// shortcut: one copy per package name (flat); fine while the adapter's few dependencies don't conflict.
async function stageNextAdapter(dest: string): Promise<void> {
  const done = new Set<string>();
  const copy = async (name: string, dir: string): Promise<void> => {
    if (done.has(name)) return;
    done.add(name);
    await cp(dir, join(dest, "node_modules", ...name.split("/")), {
      recursive: true,
      dereference: true,
      filter: (src) => !relative(dir, src).split(sep).includes("node_modules"),
    });
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // The app brings its own Next.js; the adapter only names it for types.
    for (const dep of Object.keys(pkg.dependencies ?? {})) if (dep !== "next") await copy(dep, packageDir(dep, dir));
  };
  const adapterPkg = createRequire(import.meta.url).resolve("@nbo/next-adapter/package.json");
  await copy("@nbo/next-adapter", realpathSync(dirname(adapterPkg)));
}

// packageDir finds name as Node would from inside dir: the nearest node_modules/<name> going up.
function packageDir(name: string, dir: string): string {
  for (let d = dir; ; d = dirname(d)) {
    const p = join(d, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return realpathSync(p);
    if (dirname(d) === d) throw new Error(`can't find ${name}, which the Next.js adapter needs`);
  }
}
