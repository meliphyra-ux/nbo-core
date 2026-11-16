// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createServer, type Server } from "node:http";
import { nodeToFetch, type FetchHandler } from "./node-to-fetch.js";

export type { FetchHandler };

// serveFetch bridges a Fetch-style handler to a real node:http server —
// the same Request/Response construction @nbo/funcproxy's own host.mjs
// already does inline (host.mjs lines 16-38), generalized here for every
// other listener this rewrite's cmd/* binaries need (nbo serve, control
// plane, isrcache, edge's data/admin planes) instead of duplicating it
// five times. host.mjs itself keeps its own private copy — it's a
// zero-dependency file baked into a function image with no node_modules
// install step, and depending on this workspace package there would
// break that.
export function serveFetch(
  handler: FetchHandler,
  listen: { port: number; host?: string },
  onListening?: (port: number) => void,
): Server {
  const server = createServer(nodeToFetch(handler));

  server.listen(listen.port, listen.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : listen.port;
    onListening?.(port);
  });

  return server;
}
