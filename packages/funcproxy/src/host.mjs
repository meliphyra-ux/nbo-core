// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";

const bundleDir = process.argv[2] ?? process.cwd();
const fnJson = JSON.parse(readFileSync(join(bundleDir, "..", "function.json"), "utf8"));

// env.json sits beside function.json (the same join(bundleDir, "..",
// x.json) convention) — @nbo/adapter-k8s's own buildFunctionImage
// bakes it in at image-build time, mirroring the main app image's
// own /env.json. Best-effort: a function with no env.json (every
// local-dev run; a real deploy with no env/secrets/bindings/crons at
// all) must keep working exactly as before. Applied before importing
// the handler module, so module-level initialization sees these vars
// too, not just the per-request fetch() call.
try {
  const envJson = JSON.parse(readFileSync(join(bundleDir, "..", "env.json"), "utf8"));
  for (const [k, v] of Object.entries(envJson)) process.env[k] = v;
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

// Dynamic import() requires a file:// URL for an absolute path on Windows
// (a raw "C:\..." path throws ERR_UNSUPPORTED_ESM_URL_SCHEME); pathToFileURL
// handles that platform difference and is a no-op on POSIX paths.
const mod = await import(pathToFileURL(join(bundleDir, fnJson.handler.entry)).href);
const fetchFn = mod[fnJson.handler.export].fetch;

// hopByHopHeaders matches proxy.ts's own HOP_BY_HOP_HEADERS exactly
// (duplicated, not imported: host.mjs is deliberately a single
// standalone file, copied and run on its own — into a temp dir for
// local serve, baked whole into a Docker image for Kubernetes — with
// no sibling modules available at runtime). Real bug found running
// Slice 5's PPR verify script for real: a streamed request body (the
// first time any request through this host ever carried one) makes
// Node's own http layer set a real wire-level "transfer-encoding:
// chunked" on the incoming request — forwarding that header value
// into this function's own outgoing fetch() call fails outright
// (`InvalidArgumentError: invalid transfer-encoding header`), since
// fetch() manages that header itself from the body it's given and
// refuses to let a caller set it manually.
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

const requestedPort = Number(process.env.PORT ?? 8080);
const server = createServer(async (req, res) => {
  // A caller who hangs up aborts the function's Request, so a render
  // nobody will read stops.
  const disconnected = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) disconnected.abort();
  });
  const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const headers = new Headers(
    Object.entries(req.headers).filter(([k, v]) => v !== undefined && !hopByHopHeaders.has(k.toLowerCase())),
  );
  // createCloudRunURLs (funcproxy/cloudrun.ts) overwrites the client's
  // own Authorization header with a Google identity token Cloud Run's
  // IAM layer requires to let the request through at all, and stashes
  // the original under this reserved header so it isn't lost — restore
  // it here, the one place both clouds' requests pass through on their
  // way to the function's own code, so the function stays cloud-neutral
  // (on every other path, including every K8s request, this header is
  // simply absent and this is a no-op).
  const forwardedAuth = headers.get("x-nbo-forwarded-authorization");
  if (forwardedAuth !== null) {
    headers.set("authorization", forwardedAuth);
    headers.delete("x-nbo-forwarded-authorization");
  }
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
    signal: disconnected.signal,
  });
  let response;
  try {
    response = await fetchFn(request);
  } catch (err) {
    // A caller hanging up is the abort doing its job, not a fault.
    if (!disconnected.signal.aborted)
      console.error(JSON.stringify({ level: "error", msg: "function threw", error: String(err) }));
    res.writeHead(500).end();
    return;
  }
  // Object.fromEntries(response.headers) alone would keep only the last
  // Set-Cookie, the one header Fetch never comma-folds.
  const responseHeaders = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) responseHeaders["set-cookie"] = cookies;
  try {
    res.writeHead(response.status, responseHeaders);
    if (response.body) {
      for await (const chunk of response.body) {
        if (disconnected.signal.aborted) break;
        // A slow reader holds the function back here, instead of the
        // response piling up in this process's memory.
        if (!res.write(chunk)) await once(res, "drain", { signal: disconnected.signal });
      }
    }
    res.end();
  } catch (err) {
    // The status is already sent, so all that's left is to reset the
    // connection. Uncaught, this rejection would end the whole host.
    if (!disconnected.signal.aborted)
      console.error(JSON.stringify({ level: "error", msg: "function body failed", error: String(err) }));
    res.destroy();
  }
});
server.listen(requestedPort, () => {
  console.log(`NBO_FUNCTION_LISTENING ${server.address().port}`);
});
