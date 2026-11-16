// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { FetchHandler } from "@nbo/funcproxy";
import { type createStore } from "@nbo/isrcache";

// createFakeCacheService replicates cmd/isrcache's own wire contract
// (GET/PUT /entries/{key}, POST /invalidate) against a real
// @nbo/isrcache Store, so tests that use it exercise prerender.ts's
// (and image.ts's) real client-side code against real
// fresh/stale/missing transitions, not a hand-waved stand-in — port
// of prerender_test.go's own fakeCacheHandler (lines 29-82).
export function createFakeCacheService(store: ReturnType<typeof createStore>): FetchHandler {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/entries\//, ""));

    if (request.method === "GET" && url.pathname.startsWith("/entries/")) {
      const got = store.get(key);
      if (!got) return new Response(null, { status: 404 });
      return Response.json({
        body: Buffer.from(got.entry.body).toString("base64"),
        header: got.entry.header ?? {},
        state: got.state,
        ...(got.entry.status !== undefined ? { status: got.entry.status } : {}),
      });
    }

    if (request.method === "PUT" && url.pathname.startsWith("/entries/")) {
      const body = (await request.json()) as {
        body: string;
        header?: Record<string, string[]>;
        tags?: string[];
        path?: string;
        revalidateSec: number;
        expireSec: number;
        status?: number;
      };
      const decoded = new Uint8Array(Buffer.from(body.body, "base64"));
      store.set(
        key,
        {
          body: decoded,
          header: body.header,
          tags: body.tags,
          path: body.path,
          ...(body.status !== undefined ? { status: body.status } : {}),
        },
        body.revalidateSec,
        body.expireSec,
      );
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && url.pathname === "/invalidate") {
      const body = (await request.json()) as { tags?: string[]; paths?: string[] };
      if (body.tags && body.tags.length > 0) store.invalidateTags(body.tags);
      if (body.paths && body.paths.length > 0) store.invalidatePaths(body.paths);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 404 });
  };
}
