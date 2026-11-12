# Inside a running app

What happens inside the container when a visitor's request arrives. The same code runs locally (`nbo serve`), on Kubernetes and on Cloud Run. That is the point of NBO.

## The container starts

The app image's start command is:

```
node dist/main.js serve /app/app --port 8080
```

**File:** `packages/cli/src/serve.ts` → `runServe`

1. `applyBakedEnv()`: reads `/env.json` (baked in at deploy time) into `process.env`.
2. `validate("/app/app")`: refuses to start on a broken build, including one made for a newer minor version of the spec than this `nbo` reads (see [Builds](./builds.md#the-output-and-spec-10)).
3. `resolveFunctions(nboDir, …)`: decides **how to reach functions**:
   - URLs given with `--function name=url`, or found in `/functions.json` (baked in at deploy time):
     - with `K_SERVICE` set (we're on Cloud Run) → `createCloudRunURLs`: adds a Google identity token to each call, because Cloud Run functions are private;
     - otherwise (Kubernetes) → `createStaticURLs`: plain HTTP to the in-cluster Service.
   - no URLs, but the manifest lists functions (local `nbo serve`) → `createLocalSpawner`: starts each function as a child Node process on a free port.
   - no functions → static-only app.
4. `createHandler(nboDir, resolve, …)` (`packages/serve/src/serve.ts`) loads everything once:
   - `loadStaticIndex`: `static.index.json` into a `Map` of path → file entry,
   - `loadRoutesDoc`: `routes.json`,
   - `loadTrailingSlashPolicy`,
   - `loadPrerenderDoc`: ISR routes,
   - `createRouter(...)`: compiles all route patterns once (RE2),
   - `loadImagesConfig`: `next/image` settings.
5. `serveFetch(handler, port)` (`packages/nodehost`) starts a Node HTTP server that turns each Node request into a standard `Request`, calls the handler, and streams the `Response` back.

## Every request

The handler returned by `createHandler`:

1. `stripPlatformOnlyHeaders`: removes internal `x-nbo-*` headers a visitor might try to send, so nobody can impersonate the platform.
2. Two built-in endpoints:
   - `POST /_nbo/revalidate` → `handleRevalidate`: on-demand ISR ("rebuild this page now"); unauthorized calls get `401`.
   - `GET /_nbo/image` → `handleImage`: resize/convert images for `next/image`.
3. Everything else → `dispatch(state, request)`.

### `dispatch`: ask the router, then act

```ts
const decision = await state.router.route(path, method, fileExists, middlewareInvoker);
switch (decision.kind) {
  case "serve":             return handleServe(...)           // a static file
  case "redirect":          return handleRedirect(...)        // 301/302/307/308
  case "respond":           return handleRespond(...)         // fixed status + optional file
  case "function":          return handleFunction(...)        // call server code
  case "prerender":         return handlePrerender(...)       // ISR page
  case "middlewareHandled": return handleMiddlewareHandled(...)
  case "loopDetected":      return 508
  default:                  return notFound(...)              // 404 (or custom error page)
}
```

## The router

**Package:** `packages/router`. `createRouter(routesDoc, trailingSlashPolicy)` returns `{ route(...) }`. It never touches the network or disk itself; it's given a `fileExists` function and a middleware invoker, which is why it's easy to test and identical everywhere.

First, `normalizePath` (`normalize.ts`) cleans the path: decodes safe percent-escapes, resolves `.` and `..`, applies the trailing-slash rule. Then it walks **six phases** in order:

| #   | Phase         | What happens                                                                            |
| --- | ------------- | --------------------------------------------------------------------------------------- |
| 1   | `beforeFiles` | Redirects, header rules, middleware, and rewrites that must win over files.             |
| 2   | filesystem    | Prerender (ISR) routes are checked first; then `static.index.json`. A hit ends routing. |
| 3   | `afterFiles`  | Rewrites to functions, e.g. `/blog/[slug]` → the SSR function.                          |
| 4   | `fallback`    | Last chance: catch-all SSR, or the SPA's `index.html`.                                  |
| 5   | `onMatch`     | Header rules added to whatever was finally served.                                      |
| 6   | `error`       | Maps a status (404, 500) to a custom page or function.                                  |

Each rule has a `match` (RE2 `path`, optional `pathNot`, `methods`, `has`/`missing` conditions on headers, cookies, query) and an `action` (`redirect`, `rewrite`, `headers`, `respond`, `middleware`). Named groups like `(?P<slug>[^/]+)` can be reused as `$slug` in targets (`substitute` in `match.ts`).

A rewrite to a new path re-checks the filesystem; more than 8 rewrites in one request → `508 Loop Detected`. The exact rules are in `docs/nbo-spec.md`, section "Routing".

### Example: a React SPA

`routes.json` from the static producer with `--spa` has one fallback rule. Request `/settings`:

1. `beforeFiles`: nothing.
2. filesystem: no `/settings` file.
3. `afterFiles`: nothing.
4. `fallback`: rewrite to `/index.html` → filesystem hit → `serve`.

## Serving a static file

`handleServe` → `serveStaticEntry`:

- Looks up the entry (`contentType`, `cache`, file digest).
- Reads `static/<digest>` safely (`resolveStatic` in `packages/nbopath` refuses paths escaping the folder).
- Sets `content-type` and `cache-control` (`cacheControlFor` in `serve.ts`):
  - `immutable` → `max-age=31536000, immutable` (hashed assets: cache a year),
  - `revalidate` → `max-age=0, must-revalidate` (browsers check again each time),
  - `no-store` → `no-store` (never cached).
- Applies any header operations collected by the router.

## Calling a function

`handleFunction` → `proxyRequest` (`packages/funcproxy/src/proxy.ts`): asks the resolver for the function's URL, forwards the request (method, headers, body, streamed), and streams the answer back. If the function can't be reached → `502`.

**A header a function can trust.** Before anything reads a request, `nbo serve` deletes any `x-nbo-deployment-id` the client sent and sets the real one: the content id of the build that is running. A function can read it to know which build it belongs to. On the way out, every response (static file, function, prerender, image, 404, carried file) gets `x-nbo-deployment-id` set last, replacing anything a function set. A `.nbo/` without `manifest.json` sends none.

**Compressed answers.** Node's `fetch()` decodes a compressed body (`gzip`, `br`, `deflate`, `zstd`) by itself, so after decoding `proxyRequest` must drop `content-encoding` and `content-length`, or the visitor would get plain bytes labelled as compressed. But `fetch()` decodes nothing for a `HEAD` request, for `204`, `205` and `304`, or when any listed coding is one it doesn't know (`identity`, `x-custom`, `gzip, x-custom`). So the headers are dropped only when `fetchDecoded(method, status, contentEncoding)` says it really decoded the body; in every other case the answer passes through untouched. A test pins which codings the running Node decodes, so a Node upgrade that changes the rule fails a test instead of breaking pages. (Before this fix those cases reached the visitor as compressed bytes with no label, which looks like garbage.)

On the other side, the function container runs `host.mjs` (`packages/funcproxy/src/host.mjs`):

1. Reads `function.json` (which file and which export to load) and `env.json`.
2. `import()`s the function's entry file and takes its `fetch` method.
3. Starts an HTTP server on `PORT` (default 8080). For each request: builds a standard `Request` (dropping hop-by-hop headers, restoring `authorization` from `x-nbo-forwarded-authorization`), calls `fetch(request)`, and streams the `Response`. If the function throws → `500`, with a JSON error line in the logs.

For Next.js, the function's entry is the **entry shim** (`packages/next-adapter/src/entry-shim.mjs`), which forwards the `Request` to Next's own request handler and turns its output back into a `Response`, streaming included, so React Server Components and `loading.tsx` stream to the browser as they would on Vercel.

## Middleware

A `middleware` rule in `beforeFiles` calls the middleware function (`createMiddlewareInvoker` in `packages/serve/src/middleware.ts`) with the request. The function's answer tells the router to continue (optionally with changed headers), rewrite, redirect, or respond directly (`middlewareHandled`). The wire format is in the spec's "Middleware" section.

## ISR: incremental static regeneration

Some Next.js pages are pre-rendered and refreshed every N seconds. `handlePrerender` (`packages/serve/src/prerender.ts`):

1. Builds a cache key (`prerenderCacheKey`) and looks it up (`cacheGet`) in the cache, the shared `isrcache` server if deployed, otherwise in memory.
2. **Fresh** → serve from cache.
3. **Stale** → serve from cache _and_ regenerate in the background (`maybeRegenerateInBackground`; `regenInFlight` makes sure only one regeneration per page runs at a time).
4. **Missing/expired** → call the function now, store the result (`cachePut`), serve it.

Four rules keep the cache healthy:

- **Only `GET` and `HEAD` are pages.** Any other method (a Server Action `POST` to the page's URL, say) goes straight to the function with its body and never reads or writes the cache. (A middleware answer with a no-body status such as `204` or `304` is built without a body, since the runtime refuses a body there.)
- **A render for the cache is not a render for this browser.** The cache always renders with a `GET`, even for a `HEAD` visitor (a `HEAD` answer would be an empty page), and `renderRequest` strips the conditional headers (`If-None-Match`, `If-Modified-Since`, `If-Match`, `If-Unmodified-Since`, `If-Range`) and `Range` before calling the function, so the cache always gets the full page rather than a `304` or a partial. (Draft mode, which isn't cached, passes them through; a 304 there is relayed with no body.)
- **Page-like results are cached with their own status.** `200`, the redirects `301`, `302`, `307`, `308`, and the not-found answers `404` and `410` are stored (`packages/serve/src/http-status.ts`). So a deleted page turns into a cached `404` when it next regenerates, and a scan of missing addresses does not run the function every time.
- **A `5xx` (or anything else) is never cached.** It is served to that one request; a failed background regeneration keeps the stale page.

`POST /_nbo/revalidate` drops the matching entries at once, so the next visit renders the page again (see [Page cache and revalidation](./cache.md)).

### The cache in a deploy

On Kubernetes and Cloud Run, a build with ISR pages also runs a small cache next to the app, one per environment and cloud, and a secret-protected `POST /_nbo/revalidate` refreshes pages on every cloud. How that works, what it costs, its limits and how to fix an error are in [Page cache and revalidation](./cache.md).

### Partial prerendering

A page with `cacheComponents` and a `<Suspense>` around something per-request has two halves: a static shell made at build time and a dynamic hole made per visitor. The visitor gets the shell at once, with the Suspense fallback showing, and the hole streams into the same response behind it (`handlePPR` and `streamAfterShell` in `packages/serve/src/prerender.ts`). Next's browser code plays no part in this; NBO calls your function itself.

- **The hole sees the real visitor.** `cookies()`, `headers()` and `searchParams` work there as on any server-rendered page. Cookies set while the hole renders don't reach the browser: the response's headers already went out with the shell.
- **Server actions work on these pages.** The form's `POST` goes straight to the function, and the answer brings the cookie and the fresh page with it. `revalidatePath()` and `revalidateTag()` only reach the function, though: on an ISR page, a reload still shows the cached copy until it goes stale. Call `POST /_nbo/revalidate` when other visitors must see the change at once.
- **A `<Link>` to the page gets the hole too.** A click asks for the page's React data rather than HTML, and NBO renders the whole page for that visitor and streams it (`renderForOneVisitor`). Prefetches get only the static part, so nobody's content is fetched before a click.
- **If the hole fails, the visitor keeps the shell.** The page stays a `200` with the fallback showing, and the error is in the logs. That is because the `200` was sent before the failure happened.
- **`redirect()` and `notFound()` in a hole still work, but the status stays `200`.** The browser goes to the target, or shows your 404 page, once the hole arrives. Search engines see a `200` page with a meta refresh or `noindex`, so call these before any `<Suspense>` if the real status matters.
- **Draft mode gets the whole page.** With the `__nbo_bypass` cookie, the page renders fresh from top to bottom, with nothing cached. Next's own draft cookie (`draftMode().enable()`) reaches the hole, but the shell stays the one from the build.
- **Nothing caches the page.** The response carries `cache-control: private, no-store`, whatever your header rules say, because it can hold one visitor's render.
- **The shell doesn't refresh on its own.** It changes on the next deploy, even when Next reports a `cacheLife` for it.
- **A page with no dynamic hole is plain static, or ISR.** `cacheComponents` labels every page as partially static, but only a page with something to resume is treated this way. With `"use cache"` and `cacheLife`, such a page revalidates on Next's schedule; without one it stays as built until the next deploy.
- **A middleware rewrite onto one of these pages works as a visit to that page,** with the visitor's URL unchanged.

## Scheduled jobs (crons)

A build's `crons.json` lists paths and schedules. The control-plane's scheduler (`packages/controlplane/src/scheduler.ts`, checks every 30 seconds, schedules in UTC only) finds due jobs in the `crons` table and calls the app's path with a signature made from `NBO_CRON_SIGNING_SECRET` (`signCron` in `cron.ts`). Only one environment per project has crons enabled, so jobs don't run twice.
