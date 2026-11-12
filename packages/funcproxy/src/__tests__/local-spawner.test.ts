// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSpawner } from "../local-spawner.js";

let nodeAvailable = true;
try {
  execSync("node --version");
} catch {
  nodeAvailable = false;
}

async function writeEchoFunction(nboDir: string, name: string): Promise<void> {
  const fnDir = join(nboDir, "functions", name);
  await mkdir(join(fnDir, "bundle"), { recursive: true });
  await writeFile(
    join(fnDir, "function.json"),
    JSON.stringify({ handler: { entry: "index.mjs", export: "handler" } }),
  );
  await writeFile(
    join(fnDir, "bundle", "index.mjs"),
    `export const handler = {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/stream") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 3; i++) {
            controller.enqueue(encoder.encode("chunk" + i));
            await new Promise((r) => setTimeout(r, 50));
          }
          controller.close();
        },
      });
      return new Response(stream);
    }
    if (url.pathname === "/self-destruct") {
      setImmediate(() => process.exit(0));
      return new Response("bye");
    }
    return new Response(url.pathname);
  },
};
`,
  );
}

async function writeEnvReadingFunction(nboDir: string, name: string): Promise<void> {
  const fnDir = join(nboDir, "functions", name);
  await mkdir(join(fnDir, "bundle"), { recursive: true });
  await writeFile(join(fnDir, "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "handler" } }));
  await writeFile(
    join(fnDir, "bundle", "index.mjs"),
    `export const handler = {
  async fetch() {
    return new Response(process.env.NBO_TEST_VAR ?? "unset");
  },
};
`,
  );
}

async function writeAuthEchoFunction(nboDir: string, name: string): Promise<void> {
  const fnDir = join(nboDir, "functions", name);
  await mkdir(join(fnDir, "bundle"), { recursive: true });
  await writeFile(join(fnDir, "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "handler" } }));
  await writeFile(
    join(fnDir, "bundle", "index.mjs"),
    `export const handler = {
  async fetch(request) {
    return new Response(request.headers.get("authorization") ?? "none");
  },
};
`,
  );
}

// writeBundle writes a function whose handler object has the given
// method source; node:fs's writeFileSync is in scope for it.
async function writeBundle(nboDir: string, name: string, handlerSource: string): Promise<void> {
  const fnDir = join(nboDir, "functions", name);
  await mkdir(join(fnDir, "bundle"), { recursive: true });
  await writeFile(join(fnDir, "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "handler" } }));
  await writeFile(join(fnDir, "bundle", "index.mjs"), `import { writeFileSync } from "node:fs";\nexport const handler = {\n  ${handlerSource},\n};\n`);
}

async function writeHeaderEchoFunction(nboDir: string, name: string): Promise<void> {
  const fnDir = join(nboDir, "functions", name);
  await mkdir(join(fnDir, "bundle"), { recursive: true });
  await writeFile(join(fnDir, "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "handler" } }));
  await writeFile(
    join(fnDir, "bundle", "index.mjs"),
    `export const handler = {
  async fetch(request) {
    return new Response(JSON.stringify([...request.headers.keys()]));
  },
};
`,
  );
}

async function writeThrowingFunction(nboDir: string, name: string): Promise<void> {
  const fnDir = join(nboDir, "functions", name);
  await mkdir(join(fnDir, "bundle"), { recursive: true });
  await writeFile(join(fnDir, "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "handler" } }));
  await writeFile(join(fnDir, "bundle", "index.mjs"), `throw new Error("boom");\n`);
}

async function writePidRecordingFunction(nboDir: string, name: string, pidFile: string): Promise<void> {
  const fnDir = join(nboDir, "functions", name);
  await mkdir(join(fnDir, "bundle"), { recursive: true });
  await writeFile(join(fnDir, "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "handler" } }));
  await writeFile(
    join(fnDir, "bundle", "index.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
export const handler = { async fetch() { return new Response("ok"); } };
`,
  );
}

async function writeNoisyStderrFunction(nboDir: string, name: string): Promise<void> {
  const fnDir = join(nboDir, "functions", name);
  await mkdir(join(fnDir, "bundle"), { recursive: true });
  await writeFile(join(fnDir, "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "handler" } }));
  await writeFile(
    join(fnDir, "bundle", "index.mjs"),
    `export const handler = {
  async fetch() {
    // Comfortably past a typical OS pipe buffer (commonly 64KB) —
    // enough to deadlock a spawned child whose stderr pipe nobody
    // drains.
    for (let i = 0; i < 2000; i++) {
      console.error("e".repeat(80));
    }
    return new Response("ok");
  },
};
`,
  );
}

let cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanupFns.splice(0).reverse()) {
    await fn();
  }
});

describe.skipIf(!nodeAvailable)("createLocalSpawner", () => {
  it("proxies to the spawned function, echoing the request path back", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeEchoFunction(nboDir, "echo");

    const { resolve, stop } = await createLocalSpawner(nboDir, ["echo"]);
    cleanupFns.push(stop);

    const handler = resolve("echo");
    const response = await handler(new Request("http://example.com/x"));

    expect(await response.text()).toBe("/x");
  });

  it("streams rather than buffers the response", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeEchoFunction(nboDir, "echo");

    const { resolve, stop } = await createLocalSpawner(nboDir, ["echo"]);
    cleanupFns.push(stop);

    const handler = resolve("echo");
    const start = Date.now();
    const response = await handler(new Request("http://example.com/stream"));
    const reader = response.body!.getReader();

    await reader.read();
    const firstChunkMs = Date.now() - start;

    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
    }
    const totalMs = Date.now() - start;

    expect(firstChunkMs).toBeLessThan(totalMs / 2);
  });

  // Real bug found running Slice 4's crons verify script for real: a
  // deployed function's own container never got /env.json's baked
  // vars at all (only the main app process did), so a cron target's
  // signature check — or any binding/secret a function route reads —
  // silently always failed. env.json lives beside function.json
  // (host.mjs's own established join(bundleDir, "..", "x.json")
  // convention, already used for function.json itself), best-effort:
  // a function with no env.json (every other test in this file) must
  // keep working exactly as before.
  it("applies env.json's own vars to the spawned function's process.env", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeEnvReadingFunction(nboDir, "envfn");
    await writeFile(join(nboDir, "functions", "envfn", "env.json"), JSON.stringify({ NBO_TEST_VAR: "from-env-json" }));

    const { resolve, stop } = await createLocalSpawner(nboDir, ["envfn"]);
    cleanupFns.push(stop);

    const handler = resolve("envfn");
    const response = await handler(new Request("http://example.com/"));

    expect(await response.text()).toBe("from-env-json");
  });

  it("resolves correctly with a relative nboDir", async () => {
    const parent = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(parent, { recursive: true, force: true }));
    const nboDirName = ".nbo";
    await writeEchoFunction(join(parent, nboDirName), "echo");

    const originalCwd = process.cwd();
    process.chdir(parent);
    cleanupFns.push(async () => {
      process.chdir(originalCwd);
    });

    const { resolve, stop } = await createLocalSpawner(nboDirName, ["echo"]);
    cleanupFns.push(stop);

    const handler = resolve("echo");
    const response = await handler(new Request("http://example.com/relative"));

    expect(await response.text()).toBe("/relative");
  });

  it("errors on an unknown function name", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeEchoFunction(nboDir, "echo");

    const { resolve, stop } = await createLocalSpawner(nboDir, ["echo"]);
    cleanupFns.push(stop);

    expect(() => resolve("missing")).toThrow();
  });

  it("kills already-spawned children and removes the temp host script if a later function fails to spawn", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    const pidFile = join(nboDir, "good.pid");
    await writePidRecordingFunction(nboDir, "good", pidFile);
    await writeThrowingFunction(nboDir, "bad");

    const beforeTempDirs = new Set(await readdir(tmpdir()));

    await expect(createLocalSpawner(nboDir, ["good", "bad"])).rejects.toThrow();

    const pid = Number(await readFile(pidFile, "utf8"));
    let stillAlive = true;
    try {
      process.kill(pid, 0);
    } catch {
      stillAlive = false;
    }
    if (stillAlive) {
      process.kill(pid); // safety net for the test itself, regardless of outcome
    }
    expect(stillAlive).toBe(false);

    const afterTempDirs = await readdir(tmpdir());
    const leaked = afterTempDirs.filter((name) => name.startsWith("nbo-funcproxy-host-") && !beforeTempDirs.has(name));
    expect(leaked).toEqual([]);
  });

  it("resolves immediately when stop() is called after a child has already exited on its own", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeEchoFunction(nboDir, "echo");

    const { resolve, stop } = await createLocalSpawner(nboDir, ["echo"]);
    const handler = resolve("echo");
    try {
      await handler(new Request("http://example.com/self-destruct"));
    } catch {
      // the connection drops when the child exits — expected
    }
    await new Promise((r) => setTimeout(r, 200)); // let the child's own exit event fire first

    const start = Date.now();
    await stop();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("returns a failure Response instead of rejecting once the spawned child has exited", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeEchoFunction(nboDir, "echo");

    const { resolve, stop } = await createLocalSpawner(nboDir, ["echo"]);
    cleanupFns.push(stop);

    const handler = resolve("echo");
    try {
      await handler(new Request("http://example.com/self-destruct"));
    } catch {
      // the connection may drop as the child exits — expected either way
    }
    await new Promise((r) => setTimeout(r, 200));

    const response = await handler(new Request("http://example.com/x"));

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  // Real bug found running Slice 4's crons verify script for real on
  // Cloud Run: createCloudRunURLs's own proxyWithAuthRetry (cloudrun.ts)
  // overwrites the client's original Authorization header with its own
  // Google identity token, needed for Cloud Run's IAM layer to let the
  // request through at all — so by the time the function saw it, a
  // cron's HMAC-signed Authorization header was gone, replaced with a
  // JWT the function's own code never asked for. host.mjs is the one
  // place both clouds' requests pass through on their way to the
  // function's own code, so it's the cloud-neutral place to undo the
  // swap: a reserved x-nbo-forwarded-authorization header (set only by
  // cloudrun.ts; absent on every other path, including every other test
  // in this file) is restored to "authorization" before the function
  // ever sees the request.
  it("restores the original Authorization header from x-nbo-forwarded-authorization", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeAuthEchoFunction(nboDir, "authecho");

    const { resolve, stop } = await createLocalSpawner(nboDir, ["authecho"]);
    cleanupFns.push(stop);

    const handler = resolve("authecho");
    const response = await handler(
      new Request("http://example.com/", {
        headers: {
          authorization: "Bearer google-id-token",
          "x-nbo-forwarded-authorization": "Bearer cron-hmac-signature",
        },
      }),
    );

    expect(await response.text()).toBe("Bearer cron-hmac-signature");
  });

  // Real bug found running Slice 5's PPR verify script for real: the
  // first time any request through this host carried a real streamed
  // body, Node's own http layer set a genuine wire-level
  // "transfer-encoding: chunked" on the incoming request — host.mjs's
  // own naive Object.entries(req.headers) copy forwarded that straight
  // into the Request it built for the function, and a function that
  // (like entry-shim.mjs) re-forwards request.headers into its own
  // outgoing fetch() call got a hard InvalidArgumentError, since
  // fetch() manages transfer-encoding itself and refuses to let a
  // caller set it manually. host.mjs must never let a hop-by-hop
  // header (matching proxy.ts's own HOP_BY_HOP_HEADERS) reach the
  // function's own Request object at all.
  it("strips transfer-encoding from a request carrying a real streamed body before the function ever sees it", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeHeaderEchoFunction(nboDir, "headerecho");

    const { resolve, stop } = await createLocalSpawner(nboDir, ["headerecho"]);
    cleanupFns.push(stop);

    const handler = resolve("headerecho");
    const response = await handler(new Request("http://example.com/", { method: "POST", body: "a real streamed body" }));
    const gotHeaders: string[] = JSON.parse(await response.text());

    expect(gotHeaders).not.toContain("transfer-encoding");
  });

  it("delivers every Set-Cookie a function sets, not only the last", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeBundle(
      nboDir,
      "cookies",
      `async fetch() {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response("ok", { headers });
      }`,
    );

    const { resolve, stop } = await createLocalSpawner(nboDir, ["cookies"]);
    cleanupFns.push(stop);

    const response = await resolve("cookies")(new Request("http://example.com/"));
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("aborts the function's Request when the caller disconnects", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    const marker = join(nboDir, "aborted.txt");
    await writeBundle(
      nboDir,
      "slow",
      `async fetch(request) {
        request.signal.addEventListener("abort", () => writeFileSync(${JSON.stringify(marker)}, "aborted"));
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
        }));
      }`,
    );

    const { resolve, stop } = await createLocalSpawner(nboDir, ["slow"]);
    cleanupFns.push(stop);

    const caller = new AbortController();
    const response = await resolve("slow")(new Request("http://example.com/", { signal: caller.signal }));
    await response.body!.getReader().read();
    caller.abort();

    await expect.poll(() => existsSync(marker), { timeout: 3000 }).toBe(true);
  });

  it("doesn't log a caller hanging up before the function answered as an error", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    const marker = join(nboDir, "aborted");
    await writeBundle(
      nboDir,
      "aborting",
      `async fetch(request) {
        const { appendFileSync } = await import("node:fs");
        console.error = (line) => appendFileSync(${JSON.stringify(marker)}, String(line));
        appendFileSync(${JSON.stringify(marker)}, "started|");
        await new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }`,
    );
    const { resolve, stop } = await createLocalSpawner(nboDir, ["aborting"]);
    cleanupFns.push(stop);

    const caller = new AbortController();
    const pending = resolve("aborting")(new Request("http://example.com/", { signal: caller.signal })).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    caller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(marker, "utf8")).toBe("started|");
  });

  it("stops pulling from the function while the caller isn't reading", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    // Reports how many 1 MiB chunks the function has handed over.
    await writeBundle(
      nboDir,
      "firehose",
      `async fetch(request) {
        if (new URL(request.url).pathname === "/pulled") return new Response(String(globalThis.pulled ?? 0));
        globalThis.pulled = 0;
        const chunk = new Uint8Array(1024 * 1024);
        return new Response(new ReadableStream({
          pull(controller) {
            if (globalThis.pulled >= 512) return controller.close();
            globalThis.pulled++;
            controller.enqueue(chunk);
          },
        }, { highWaterMark: 0 }));
      }`,
    );
    const { resolve, stop } = await createLocalSpawner(nboDir, ["firehose"]);
    cleanupFns.push(stop);
    const handler = resolve("firehose");

    const res = await handler(new Request("http://example.com/stream"));
    const reader = res.body!.getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 500));
    const pulled = Number(await (await handler(new Request("http://example.com/pulled"))).text());
    await reader.cancel();
    expect(pulled).toBeLessThan(256);
  });

  it("survives a function whose body fails partway through", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeBundle(
      nboDir,
      "dying",
      `async fetch(request) {
        if (new URL(request.url).pathname === "/ok") return new Response("still up");
        let n = 0;
        return new Response(new ReadableStream({
          pull(controller) {
            if (n++ === 0) controller.enqueue(new TextEncoder().encode("partial"));
            else controller.error(new Error("function died"));
          },
        }));
      }`,
    );

    const { resolve, stop } = await createLocalSpawner(nboDir, ["dying"]);
    cleanupFns.push(stop);

    const handler = resolve("dying");
    await handler(new Request("http://example.com/die")).then((r) => r.text()).catch(() => {});
    const response = await handler(new Request("http://example.com/ok"));
    expect(await response.text()).toBe("still up");
  });

  it("does not deadlock when the spawned function writes heavily to stderr", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "funcproxy-"));
    cleanupFns.push(() => rm(nboDir, { recursive: true, force: true }));
    await writeNoisyStderrFunction(nboDir, "noisy");

    const { resolve, stop } = await createLocalSpawner(nboDir, ["noisy"]);
    cleanupFns.push(stop);

    const handler = resolve("noisy");
    const response = await handler(new Request("http://example.com/x"));

    expect(await response.text()).toBe("ok");
  }, 5000);
});
