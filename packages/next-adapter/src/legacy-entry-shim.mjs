// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The "ssr" function of a Next.js 14 or 15 app (legacy.js): runs Next's own server, the one
// `next start` runs, on a loopback port, and forwards each request to it.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, JSON.parse(readFileSync(join(here, "next-server.json"), "utf8")).appDir);

// Started once, on the first request; concurrent first requests share the promise.
let portPromise;
function ensureServer() {
  portPromise ??= (async () => {
    const { config } = JSON.parse(readFileSync(join(dir, ".next", "required-server-files.json"), "utf8"));
    // The bundle is never written to (ISR stays in this instance's memory), and compressing is the
    // edge's job: fetch() below would decode a gzip body and keep its stale content-length.
    config.experimental = { ...config.experimental, isrFlushToDisk: false };
    config.compress = false;
    // As Next's standalone server.js does: the config the build resolved (next.config.* is not bundled).
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
    process.env.NODE_ENV = "production";
    // Next wants its port up front, so listen first; nothing connects before this promise resolves.
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const next = createRequire(join(dir, "package.json"))("next");
    const app = next({ dir, dev: false, conf: config, hostname: "127.0.0.1", port });
    await app.prepare();
    const handle = app.getRequestHandler();
    server.on("request", (req, res) =>
      Promise.resolve(handle(req, res)).catch((err) => {
        console.error(JSON.stringify({ level: "error", msg: "next handler threw", url: req.url, error: String(err) }));
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      }),
    );
    return port;
  })();
  return portPromise;
}

export default {
  async fetch(request) {
    const port = await ensureServer();
    const url = new URL(request.url);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      duplex: hasBody ? "half" : undefined,
      // A redirect is the app's answer to the visitor, not this hop's to follow.
      redirect: "manual",
      // A caller who hangs up closes the loopback connection, which stops Next's render.
      signal: request.signal,
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  },
};
