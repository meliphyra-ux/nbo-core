// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nodeToFetch } from "@nbo/nodehost";
import { createRelayHandler, type RelayOptions } from "./relay.js";

// A relay never follows an absolute-form request target
// (`GET http://evil.com/ HTTP/1.1`): only the path and query are used, and
// the upstream comes solely from x-nbo-upstream.
export function pathOnly(target: string | undefined): string {
  const t = target ?? "/";
  if (t.startsWith("/")) return t;
  try {
    const u = new URL(t);
    return `${u.pathname}${u.search}`;
  } catch {
    return "/";
  }
}

export function createRelayServer(opts: RelayOptions & { cert: string | Buffer; key: string | Buffer }): Server {
  const listener = nodeToFetch(createRelayHandler(opts), { scheme: "https" });
  return createServer({ cert: opts.cert, key: opts.key }, (req: IncomingMessage, res: ServerResponse) => {
    req.url = pathOnly(req.url);
    return listener(req, res);
  });
}
