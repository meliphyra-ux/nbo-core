// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export type RouteHandler = (request: Request, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  pattern: string;
  patternParts: string[];
  handler: RouteHandler;
}

// Match is the route a request selects: its method and pattern exactly as
// passed to handle (the key of the access table, access.ts), the decoded
// params, and the handler that will run.
export interface Match {
  pattern: string;
  method: string;
  params: Record<string, string>;
  handler: RouteHandler;
}

export interface Router {
  handle(method: string, pattern: string, handler: RouteHandler): void;
  // match finds the route dispatch would run, without running it; null for
  // no route, or for a path whose parameter can't be decoded.
  match(request: Request): Match | null;
  // routes lists every registered route as "<METHOD> <pattern>".
  routes(): string[];
  (request: Request): Promise<Response>;
}

class DecodeError extends Error {}

// matchPattern splits pattern and path on "/" and compares
// segment-by-segment; a "{name}" pattern segment captures the
// corresponding path segment (decodeURIComponent'd — Go's own
// net/http.ServeMux decodes a path segment automatically, so this
// router does the same explicitly) rather than requiring a literal
// match.
function matchPattern(patternParts: string[], pathParts: string[]): Record<string, string> | null {
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!;
    if (p.startsWith("{") && p.endsWith("}")) {
      try {
        params[p.slice(1, -1)] = decodeURIComponent(pathParts[i]!);
      } catch (err) {
        throw new DecodeError(err instanceof Error ? err.message : String(err));
      }
    } else if (p !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// createRouter builds a small, dependency-free Fetch-style router —
// Go's own net/http.ServeMux (1.22+'s own "METHOD /path/{param}"
// pattern syntax) has no TS built-in equivalent; this is this
// project's own established "own the mechanism, minimal dependencies"
// posture, not a new risk for a routing need this small.
export function createRouter(): Router {
  const routes: Route[] = [];

  // find is the one matching loop: dispatch and match both use it, so the
  // route the access check sees is the route that runs. A malformed
  // percent-escape in a parameter throws DecodeError at the first route
  // whose shape fits, as the loop always did.
  const find = (request: Request): Match | null => {
    const pathParts = new URL(request.url).pathname.split("/").filter(Boolean);
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const params = matchPattern(route.patternParts, pathParts);
      if (params) return { pattern: route.pattern, method: route.method, params, handler: route.handler };
    }
    return null;
  };

  const router = async (request: Request): Promise<Response> => {
    try {
      const m = find(request);
      if (m) return await m.handler(request, m.params);
      return new Response(null, { status: 404 });
    } catch (err) {
      // A backstop, not a replacement for a handler's own error
      // mapping: an unanticipated throw (a malformed percent-escape
      // in decodeURIComponent, or any future handler bug) must never
      // reach the caller as an unhandled rejection.
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  };

  (router as Router).handle = (method: string, pattern: string, handler: RouteHandler) => {
    routes.push({ method, pattern, patternParts: pattern.split("/").filter(Boolean), handler });
  };
  (router as Router).match = (request: Request): Match | null => {
    try {
      return find(request);
    } catch (err) {
      if (err instanceof DecodeError) return null;
      throw err;
    }
  };
  (router as Router).routes = () => routes.map((r) => `${r.method} ${r.pattern}`);

  return router as Router;
}
