// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// childEnv lives in @nbo/adapter-cloudrun, re-exported through @nbo/deploy.
import spawn from "cross-spawn";
import { StringDecoder } from "node:string_decoder";
import { childEnv, redact } from "@nbo/deploy";

// defaultRunTimeoutMs is a mutable settings value, not a plain
// constant — matching @nbo/funcproxy's own cloudRunConfig pattern for
// a value a test needs to shrink instead of waiting out a real
// timeout. 10 minutes is generous for a real install+build, but still
// bounded: a build command (or `git clone` of a private repo
// prompting for credentials) that hangs must not leave a Build
// stuck in "running" forever.
const defaultRunTimeoutMs = 10 * 60_000;

// run's own copy of @nbo/deploy's identical helper — not a shared
// import, matching that same package's own "~15 lines, not worth a
// third package just to avoid two small copies" precedent. Takes
// `cwd`/`shell`/`env`/`timeoutMs` instead of `input`: this package's
// own callers (git clone/checkout, a user-supplied build command
// string with shell operators like `&&`) need those, not stdin
// writes — stdin is closed immediately (`stdio: ["ignore", ...]`),
// so a command that waits to read it (an interactive credential
// prompt, a prompt-on-stdin build tool) sees EOF and fails fast
// instead of hanging — final-review finding: the first version of
// this file dropped @nbo/deploy's own stdin handling entirely
// without replacing it with anything, leaving the child's stdin open
// and unclosed forever.
export function run(
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    shell?: boolean;
    env?: Record<string, string>;
    timeoutMs?: number;
    input?: string;
    onOutput?: (chunk: string) => void;
    redactSecrets?: string[];
    // buildStep: a repository's own command (build, ignored build step),
    // which gets buildStepEnv's environment, not NBO's own settings.
    buildStep?: boolean;
    // name: what errors call the command instead of `cmd args` (the build sandbox's docker arguments carry values).
    name?: string;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options?.cwd,
      shell: options?.shell,
      env: options?.buildStep ? { ...buildStepEnv(process.env), ...options.env } : childEnv(process.env, options?.env),
      stdio: [options?.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // POSIX: its own process group, so a timeout can kill the whole
      // tree (a shell's grandchildren keep the pipes open otherwise).
      detached: process.platform !== "win32",
    });
    if (options?.input !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(options.input);
    }
    let output = "";
    let timedOut = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = options?.timeoutMs ?? defaultRunTimeoutMs;
    const name = options?.name ?? `${cmd} ${args.join(" ")}`;
    const timeoutError = () =>
      Object.assign(new Error(`${name} timed out after ${timeoutMs}ms:\n${output}`), { timedOut: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // If a stray grandchild still holds stdout/stderr, "close" never
      // fires; settle anyway so a hung build can't block its project.
      grace = setTimeout(() => {
        if (settled) return;
        settled = true;
        flushOutput();
        reject(timeoutError());
      }, 3000);
    }, timeoutMs);

    // onOutput streams each chunk as it arrives (a running build's log
    // is readable before the command exits); the resolved/rejected
    // output stays the full accumulated text, as before. With
    // redactSecrets, each stream is redacted in a way that survives a
    // secret split across chunks (see streamRedactor).
    const secrets = (options?.redactSecrets ?? []).filter((v) => v !== "");
    const redactors = [
      streamRedactor(secrets, (t) => options?.onOutput?.(t)),
      streamRedactor(secrets, (t) => options?.onOutput?.(t)),
    ];
    const flushOutput = () => redactors.forEach((r) => r.flush());
    const onData = (idx: number) => (chunk: Buffer) => {
      output += chunk.toString();
      redactors[idx]!.write(chunk);
    };
    child.stdout!.on("data", onData(0));
    child.stderr!.on("data", onData(1));

    child.on("error", (err) => {
      // cross-spawn turns any shell command that exits 1 into a synthetic
      // ENOENT on Windows. The shell itself was found; let "close" report
      // the real exit code and output.
      if (options?.shell && !timedOut && (err as NodeJS.ErrnoException).code === "ENOENT") return;
      clearTimeout(timer);
      clearTimeout(grace);
      if (settled) return;
      settled = true;
      flushOutput();
      // cross-spawn reports a force-killed shell (exit 1) as ENOENT on
      // Windows; after our own timeout, the timeout is the real cause.
      reject(timedOut ? timeoutError() : err);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(grace);
      if (settled) return;
      settled = true;
      flushOutput();
      if (timedOut) {
        reject(timeoutError());
      } else if (code === 0) {
        resolve(output);
      } else {
        const how = signal ? `was killed by signal ${signal}` : `failed with exit code ${code}`;
        reject(new Error(`${name} ${how}:\n${output}`));
      }
    });
  });
}

// buildStepEnv is NBO's own environment minus its settings: a repository's
// build command and ignored build step run code NBO doesn't control, and
// NBO_* settings name its database, secret key file, link enrolment code and
// cloud accounts. Only the NBO_* names builds are meant to see pass:
// NBO_ENV, NBO_GIT_* and NBO_BUILD_ID (the Next.js producer's pinned build
// id). The runner adds NBO_ENV, NBO_GIT_COMMIT_REF/SHA and the project's
// variables on top. Everything else (PATH, HOME, proxies) is inherited.
export function buildStepEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const upper = k.toUpperCase();
    if (upper.startsWith("NBO_") && upper !== "NBO_ENV" && upper !== "NBO_BUILD_ID" && !upper.startsWith("NBO_GIT_"))
      continue;
    env[k] = v;
  }
  return env;
}

// killTree ends a child and everything it started.
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" }).on("error", () => {});
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

// streamRedactor redacts secrets in a chunked byte stream. Each chunk is
// decoded UTF-8-safely, appended to a pending tail, redacted, and all but
// the last (longest secret form - 1) characters are emitted; the held-back
// tail is where a secret split across chunks would still be incomplete.
// flush() emits the rest. With no secrets it passes text straight through.
// Short secrets over-redact matching substrings elsewhere in the output;
// that is the accepted, safe direction.
export function streamRedactor(
  secrets: string[],
  emit: (text: string) => void,
): { write(chunk: Buffer): void; flush(): void } {
  const decoder = new StringDecoder("utf8");
  if (secrets.length === 0) {
    return {
      write: (chunk) => {
        const t = decoder.write(chunk);
        if (t) emit(t);
      },
      flush: () => {
        const t = decoder.end();
        if (t) emit(t);
      },
    };
  }
  const hold = Math.max(...secrets.map((s) => Math.max(s.length, Buffer.from(s).toString("base64").length))) - 1;
  let pending = "";
  return {
    write(chunk) {
      const buf = redact(pending + decoder.write(chunk), secrets);
      const cut = Math.max(0, buf.length - hold);
      if (cut > 0) emit(buf.slice(0, cut));
      pending = buf.slice(cut);
    },
    flush() {
      const rest = redact(pending + decoder.end(), secrets);
      pending = "";
      if (rest) emit(rest);
    },
  };
}
