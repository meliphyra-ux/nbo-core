// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export type FetchHandler = (request: Request) => Promise<Response>;

// CLIENT_IP_HEADER carries the socket's address into a Fetch handler, which
// has no socket of its own. Internal: the handler must strip it before
// forwarding anything.
export const CLIENT_IP_HEADER = "x-nbo-client-ip";

// nodeToFetch turns a Fetch-style handler into a (req, res) listener for any
// node:http or node:https server. The Request URL carries opts.scheme.
//
// A visitor who disconnects before the response is complete aborts the
// Request's signal, so a proxying handler drops its upstream connection, and
// the body loop stops. Writes honour backpressure: a slow reader never makes
// the host buffer the whole response.
//
// opts.clientIp sets CLIENT_IP_HEADER from the socket, replacing anything the
// visitor sent under that name.
export function nodeToFetch(handler: FetchHandler, opts: { scheme?: "http" | "https"; clientIp?: boolean } = {}) {
  const scheme = opts.scheme ?? "http";
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let response: Response;
    try {
      const headers = new Headers(Object.entries(req.headers).filter(([, v]) => v !== undefined) as [string, string][]);
      if (opts.clientIp) {
        headers.delete(CLIENT_IP_HEADER);
        // A dual-stack listener reports an IPv4 visitor as ::ffff:a.b.c.d.
        const address = req.socket.remoteAddress?.replace(/^::ffff:/i, "");
        if (address) headers.set(CLIENT_IP_HEADER, address);
      }
      const request = new Request(`${scheme}://${req.headers.host ?? "localhost"}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
        duplex: hasBody ? "half" : undefined,
        signal: controller.signal,
      } as RequestInit);
      response = await handler(request);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(err instanceof Error ? err.message : String(err));
      else res.destroy();
      return;
    }

    try {
      // Object.fromEntries(response.headers) would collapse repeated headers
      // to their last value; Set-Cookie is the one Fetch never comma-folds.
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of response.headers) {
        if (k === "set-cookie") continue;
        headers[k] = v;
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) headers["set-cookie"] = cookies;

      res.writeHead(response.status, headers);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            if (controller.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) {
              await new Promise<void>((resolve) => {
                const finish = () => {
                  res.off("drain", finish);
                  res.off("close", finish);
                  resolve();
                };
                res.on("drain", finish);
                res.on("close", finish);
              });
            }
          }
          if (controller.signal.aborted) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
    } catch (err) {
      // The error can surface after headers were sent (an upstream dying
      // mid-stream); a clean 500 is no longer possible, so reset the
      // connection rather than crash the process.
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  };
}
