// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { DEFAULT_MAX_BYTES, type Store } from "./store.js";

export type FetchHandler = (request: Request) => Promise<Response>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// isTiming accepts an absent value or a finite, non-negative number.
function isTiming(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((k) => allowed.has(k));
}

const allowedPutKeys = new Set(["body", "header", "tags", "path", "revalidateSec", "expireSec", "status"]);
const allowedInvalidateKeys = new Set(["tags", "paths"]);

// maxBodyBytesFor is the largest request body the service reads: base64 of
// a quarter of the byte limit (the biggest storable entry) plus 64 KiB for
// the JSON around it, never more than 64 MiB.
export function maxBodyBytesFor(maxBytes: number): number {
  return Math.min(64 * 1024 * 1024, Math.ceil(((maxBytes / 4) * 4) / 3) + 65536);
}

// readJsonCapped reads a request body as JSON, stopping as soon as it
// passes the cap so a huge PUT is never buffered. It returns "too-large"
// or "invalid" instead of throwing.
async function readJsonCapped(request: Request, cap: number): Promise<{ value: unknown } | "too-large" | "invalid"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return "too-large";
  if (!request.body) return "invalid";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return "invalid";
  }
}

// createMux builds the ISR cache service's one API surface, reached by
// every app instance on either cloud over NBO_ISRCACHE_URL — not part
// of any per-app .nbo/ deploy, the same precedent @nbo/edge's own admin
// API already sets for a platform-level service. It has no
// authentication and listens on every interface unless
// NBO_ISRCACHE_ADDR names a host: the Kubernetes NetworkPolicy
// (<app>-to-isrcache) or Cloud Run IAM is the only gate, and must stay. A manual path/method match, not a generic router — three
// routes don't earn one, same rationale as @nbo/edge's admin.ts — port
// of NewMux (cmd/isrcache/main.go lines 17-88).
export function createMux(store: Store, opts: { maxBodyBytes?: number } = {}): FetchHandler {
  const maxBodyBytes = opts.maxBodyBytes ?? maxBodyBytesFor(DEFAULT_MAX_BYTES);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return new Response("ok", { status: 200 });
    }

    const entryMatch = url.pathname.match(/^\/entries\/(.+)$/);
    if (entryMatch) {
      const key = entryMatch[1]!;

      if (request.method === "GET") {
        const found = store.get(key);
        if (!found) {
          return new Response(`isrcache: no entry for key ${key}`, { status: 404 });
        }
        return Response.json({
          body: Buffer.from(found.entry.body).toString("base64"),
          header: found.entry.header,
          state: found.state,
          ...(found.entry.status !== undefined ? { status: found.entry.status } : {}),
        });
      }

      if (request.method === "PUT") {
        const read = await readJsonCapped(request, maxBodyBytes);
        if (read === "too-large") return new Response("isrcache: request body too large", { status: 413 });
        if (read === "invalid") return new Response("isrcache: invalid request body", { status: 400 });
        const raw = read.value;
        if (
          !isRecord(raw) ||
          !isTiming(raw.revalidateSec) ||
          !isTiming(raw.expireSec) ||
          !hasOnlyKeys(raw, allowedPutKeys) ||
          typeof raw.body !== "string" ||
          // status: the render's HTTP status, so 404s and redirects come
          // back as rendered. Absent on entries from older NBO (all 200s).
          (raw.status !== undefined &&
            (typeof raw.status !== "number" || !Number.isInteger(raw.status) || raw.status < 200 || raw.status > 599))
        ) {
          return new Response("isrcache: invalid request body", { status: 400 });
        }
        let decodedBody: Buffer;
        try {
          decodedBody = Buffer.from(raw.body, "base64");
        } catch (err) {
          return new Response(`isrcache: invalid base64 body: ${err instanceof Error ? err.message : String(err)}`, {
            status: 400,
          });
        }
        store.set(
          key,
          {
            body: new Uint8Array(decodedBody),
            header: raw.header as Record<string, string[]> | undefined,
            tags: raw.tags as string[] | undefined,
            path: raw.path as string | undefined,
            ...(typeof raw.status === "number" ? { status: raw.status } : {}),
          },
          Number(raw.revalidateSec ?? 0),
          Number(raw.expireSec ?? 0),
        );
        return new Response(null, { status: 204 });
      }

      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/invalidate" && request.method === "POST") {
      const read = await readJsonCapped(request, maxBodyBytes);
      if (read === "too-large") return new Response("isrcache: request body too large", { status: 413 });
      if (read === "invalid") return new Response("isrcache: invalid request body", { status: 400 });
      const raw = read.value;
      if (!isRecord(raw) || !hasOnlyKeys(raw, allowedInvalidateKeys)) {
        return new Response("isrcache: invalid request body", { status: 400 });
      }
      const tags = Array.isArray(raw.tags) ? (raw.tags as string[]) : [];
      const paths = Array.isArray(raw.paths) ? (raw.paths as string[]) : [];
      if (tags.length > 0) store.invalidateTags(tags);
      if (paths.length > 0) store.invalidatePaths(paths);
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  };
}
