// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import { nodeToFetch } from "@nbo/nodehost";
import type { AddressInfo } from "node:net";
import { normalizeHost, type Registry } from "./registry.js";
import { createProxyHandler, type FetchHandler } from "./proxy.js";
import { createAdminMux } from "./admin.js";
import type { Aggregator } from "./insights/aggregator.js";
import type { CertStore, ChallengeStore } from "./cert-store.js";
import type { CloudflareTrust } from "./cloudflare-trust.js";

const ACME_PREFIX = "/.well-known/acme-challenge/";

export interface ClusterDeps {
  registry: Registry;
  certs: CertStore;
  challenges: ChallengeStore;
  insights: Aggregator;
  httpPort: number;
  httpsPort: number;
  adminPort: number;
  drainToken: string;
  cloudflareTrust?: CloudflareTrust;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeAll(servers: Server[]): Promise<void> {
  return Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (!s.listening) return resolve();
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  ).then(() => undefined);
}

export async function startClusterListeners(
  deps: ClusterDeps,
): Promise<{ close(): Promise<void>; ports: { http: number; https: number; admin: number } }> {
  const { registry, certs, challenges, insights } = deps;
  const httpProxy = createProxyHandler(registry, { insights, scheme: "http", cloudflareTrust: deps.cloudflareTrust });
  const httpsProxy = createProxyHandler(registry, { insights, scheme: "https", cloudflareTrust: deps.cloudflareTrust });

  // withChallenges answers pending ACME http-01 tokens for any host, on any
  // listener (Cloudflare may validate over HTTPS); everything else goes on.
  const withChallenges =
    (next: FetchHandler): FetchHandler =>
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith(ACME_PREFIX)) {
        const answer = challenges.get(url.pathname.slice(ACME_PREFIX.length));
        if (answer === undefined) return new Response("not found", { status: 404 });
        return new Response(answer, { status: 200, headers: { "content-type": "text/plain" } });
      }
      return next(request);
    };

  const httpHandler: FetchHandler = withChallenges(async (request) => {
    const url = new URL(request.url);
    const host = normalizeHost(request.headers.get("host") ?? "");
    const target = registry.get(host);
    // Redirect only when HTTPS will actually work: a missing Secret must
    // never send visitors into a failing handshake.
    if (target?.tls && target.redirectHttps && certs.contextFor(host, registry)) {
      return new Response(null, { status: 308, headers: { location: `https://${host}${url.pathname}${url.search}` } });
    }
    return httpProxy(request);
  });

  const httpServer = createHttp(nodeToFetch(httpHandler, { scheme: "http", clientIp: true }));
  const httpsServer = createHttps(
    {
      SNICallback(servername, cb) {
        const ctx = certs.contextFor(servername, registry);
        if (ctx) cb(null, ctx);
        else cb(new Error(`no certificate for ${servername}`));
      },
    },
    nodeToFetch(withChallenges(httpsProxy), { scheme: "https", clientIp: true }),
  );
  const adminServer = createHttp(
    nodeToFetch(createAdminMux(registry, { insights, drainToken: deps.drainToken }), { scheme: "http" }),
  );

  const servers = [httpServer, httpsServer, adminServer];
  try {
    const [http, https, admin] = await Promise.all([
      listen(httpServer, deps.httpPort),
      listen(httpsServer, deps.httpsPort),
      listen(adminServer, deps.adminPort),
    ]);
    return { ports: { http, https, admin }, close: () => closeAll(servers) };
  } catch (err) {
    await closeAll(servers);
    throw err;
  }
}
