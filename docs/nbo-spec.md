# Neutral Build Output Spec 1.0

Release candidate until the `spec-v1.0.0` tag. This file in the repo is the source of truth; it replaces the draft of 2026-10-22.

## Overview and goals

NBO (Neutral Build Output) is the contract between frameworks and clouds. A framework adapter writes one `.nbo/` directory, and every provider adapter deploys from it without reading framework code. It describes what the app is, never where it runs. The product's name may still change, but the wire names (`.nbo/`, `nbo`, `x-nbo-*`, `/_nbo/`, `NBO_`) are fixed for all of 1.x (see Decisions).

1.0 scope: Next.js, React single-page apps and static sites. The format stays framework-agnostic, but only these producers are built and tested, and `node` is the only runtime kind.

Goals for 1.0:

- Cover the features users expect from Vercel that NBO ships: static files, SSR functions with streaming, middleware, ISR with on-demand revalidation, image optimization, crons, redirects, rewrites and headers (in the format; the Next.js producer doesn't translate `next.config`'s own, see Producers in 1.0). Edge functions and container functions are not in 1.0 (see Reserved for later).
- Deploy to any provider adapter with no framework-specific logic inside the adapter.
- Build once, promote everywhere: the same stored build moves from one environment to another and from one cloud to another, without a rebuild.
- Let the planner decide, before anything is provisioned, whether a target can run the app.

Out of scope for 1.0:

- Provider details such as accounts, regions, resource names and instance types. They belong in the deployment plan.
- Data services such as databases, KV and queues. The output only declares which ones it needs.
- Running the build itself. NBO starts where `npm run build` ends.
- Packaging and signing. 1.0 defines the `.nbo/` directory, not an archive format; NBO keeps each build's `.nbo/` in its own artifact store (see Distribution). An archive format, signing and provenance may come after 1.0.

## Design principles

Seven rules decide every schema question below. When a field is in doubt, check it against them.

1. **What, never where.** No cloud names, account ids, resource names or provider region codes. 1.0 has no geography field (`placement` is reserved).
2. **Declarative and static.** The planner reads JSON. It never runs framework code to work out what the app does.
3. **Content-addressed.** Every file is pinned by its sha256 digest, and every metadata JSON file is written in canonical form (RFC 8785), so a file's digest and its canonical JSON digest are the same. The digest of `manifest.json` minus its `build` block is the deployment's identity, its content id.
4. **Capability-explicit.** Any feature a provider might lack is declared up front, so an unsupported target fails at plan time, not in production.
5. **Environment-free.** No secret values and no environment-specific values. Anything baked in at build time is declared (`env.inlinedAtBuild`); 1.0 records it but does not compare it when a build is promoted.
6. **Portable routing.** Patterns use a regex syntax every router can run (RE2), and the semantics are pinned down by HTTP transcripts in a conformance suite, run against `nbo serve` and each adapter.
7. **Strict core, open edges.** Unknown core fields are rejected. Extensions are namespaced and say whether a consumer may ignore them.

## Where the spec sits

NBO sits between the framework build and the planner. Everything before the planner is identical for every cloud; everything after it belongs to one provider.

```
  ┌─ cloud-neutral: defined by this spec ─────────────────────┐
  │  Framework build          next build, vite build, a folder │
  │        ↓                                                   │
  │  Framework adapter / producer      writes .nbo/            │
  │        ↓                                                   │
  │  .nbo/ build output       THE CONTRACT: what, never where  │
  │        ↓                                                   │
  │  Validate                 schemas, digests, RE2, references│
  │        ↓                                                   │
  │  Store                    artifact store, by content id    │
  └────────┬──────────────────────────────────────────────────┘
           ↓
  Stored build ───────────→  PLANNER  ←── Provider capabilities
  (manifest, functions)         ↓        (features and limits)
  ┌─ provider-specific ────────┴──────────────────────────────┐
  │  Deployment plan          provider resources, regions     │
  │        ↓                                                   │
  │  Provider adapter         applies the plan as a workflow   │
  └────────────────────────────────────────────────────────────┘
```

The planner combines the stored build and the target's published capabilities and limits into a plan, which the provider adapter then applies. In 1.0 the planner gets no environment values: variables reach the app at deploy time (see Environment, secrets and bindings).

At run time each cloud runs the app server (`nbo serve`), which holds the router and serves `.nbo/` as written: static files, routing phases, functions, middleware, prerendering and images. The platform's edge in front of the clouds only picks a cloud for each visitor (by weight, keeping a visitor on one cloud) and never routes inside the app.

## Directory layout

A build produces one `.nbo/` directory with a root manifest, a routing table, static files with their index, one folder per function, and, when the app prerenders, one `prerender.json`.

```
.nbo/
├── manifest.json            # root: spec version, build info, requirements, digests
├── routes.json              # routing table: phases and rules
├── static.index.json        # per-file digest, content type, cache class
├── static/                  # files served as-is
│   ├── index.html
│   ├── blog/hello.html
│   └── _assets/app.3f9a1c.js
├── functions/
│   ├── ssr/
│   │   ├── function.json    # name, runtime, handler, bundle digest
│   │   └── bundle/
│   │       ├── index.mjs           # entry module (handler.entry)
│   │       ├── bundle.index.json   # digest and size of every other file in bundle/
│   │       ├── dispatch.json       # route id to pathname, read by the entry module
│   │       └── …                   # producer files: traced code, dependencies, tables
│   └── middleware/
│       ├── function.json
│       └── bundle/
└── prerender.json           # ISR config for every prerendered route; only when there is one
```

Rules:

- Functions are keyed by name, not by URL path. Vercel derives the URL from the function's folder path; NBO maps paths to functions only in `routes.json`. One SSR function usually serves hundreds of routes, and adapters want few deployables.
- Paths are POSIX, case-sensitive, UTF-8 NFC. No symlinks, so a copy or tarball of `.nbo/` is always complete. Validate rejects a symlink under `static/` or `bundle/`.
- Every metadata JSON file (`manifest.json`, `routes.json`, `static.index.json`, `prerender.json`, every `function.json` and `bundle.index.json`) is written in RFC 8785 canonical form. Validate rejects one that isn't. Files inside `bundle/` and `static/` are opaque bytes.
- `prerender.json` is one file, `{ "version": 1, "prerenders": [...] }`, pinned by `manifest.digests["prerender.json"]`. A build with no prerendered routes has neither the file nor the digest.
- `bundle/` is fully traced and installed. Deploying never runs a package manager. It holds the entry module named by `handler.entry` (`index.mjs` from the reference writer), `bundle.index.json`, and every file the producer adds: traced code, dependencies and the producer's own tables (the Next.js adapter's `next-dispatch.json`, for example).
- `bundle.index.json` lists every file in `bundle/` except itself, with its digest and size, so every byte a function runs is inside the content id. `function.json`'s `artifact.digest` pins `bundle.index.json`.
- The reference writer adds `dispatch.json` at the bundle root, `{ "routes": { "<route id>": { "pathname": "/about" } } }`, from the routes the producer registered for the function; the entry module reads it at run time. It is listed in `bundle.index.json` like any other file. Only the function's own code reads it, so another producer may leave it out. Builds made before 1.0 final wrote it after the index, unlisted; validate accepts exactly that (see Versioning and compatibility).
- URL paths under `/_nbo/` belong to the platform (the image endpoint, revalidation, Speed Insights). Producers must not put static files there; validate warns about a `static.index.json` key under `/_nbo/` (an error with `--strict`).

## Manifest

`manifest.json` is the root of a content-addressed tree: it lists what the app requires and pins every other file by digest.

```json
{
  "$schema": "urn:nbo:spec:v1:manifest",
  "specVersion": "1.0",
  "build": {
    "id": "b_01JB7Q4X9K",
    "createdAt": "2026-10-22T14:03:11Z",
    "source": { "repo": "github.com/acme/web", "revision": "9f2c1e7" },
    "framework": { "name": "nextjs", "version": "16.2.6", "adapter": "nbo-next@0.4.0" }
  },
  "requires": {
    "capabilities": ["fn.streaming", "images.optimize", "prerender.isr", "prerender.onDemand"],
    "extensions": []
  },
  "routing": { "trailingSlash": "never", "cleanUrls": true, "caseSensitive": true },
  "functions": ["ssr", "middleware", "og-image"],
  "images": { "widths": [640, 1080, 1920], "formats": ["image/avif", "image/webp"], "qualities": [75] },
  "crons": [
    { "id": "nightly-sync", "schedule": "0 3 * * *", "timezone": "UTC",
      "target": { "function": "ssr", "path": "/api/cron/sync", "method": "POST" }, "overlap": "skip", "timeoutSec": 300 }
  ],
  "env": { "required": ["DATABASE_URL"], "optional": ["SENTRY_DSN"], "inlinedAtBuild": ["NEXT_PUBLIC_API_URL"], "inlinedEnvDigest": "sha256:0be1…" },
  "bindings": [{ "name": "DB", "type": "postgres" }],
  "digests": {
    "routes.json": "sha256:41aa…",
    "static.index.json": "sha256:9c07…",
    "functions/ssr/function.json": "sha256:e2d4…",
    "functions/middleware/function.json": "sha256:77f0…",
    "functions/og-image/function.json": "sha256:1b3e…",
    "prerender.json": "sha256:c8a9…"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `$schema` | No | Any string; ignored. The schemas' own ids are `urn:nbo:spec:v1:<file>` (`manifest`, `function`, `routes`, `static-index`, `prerender`, `bundle-index`). |
| `specVersion` | Yes | `"MAJOR.MINOR"` of the spec this build follows. See Versioning and compatibility. |
| `build` | Yes | `id`, `createdAt` (RFC 3339 date-time), `framework` (`name`, optional `version` and `adapter`), optional `source` (`repo`, `revision`). Provenance only; never changes how the app behaves. |
| `requires` | Yes | `capabilities` (ids from the vocabulary in Capabilities and extensions) and `extensions` (`id`, `version`, `critical`) the planner must satisfy. |
| `routing` | No | Global path handling, applied before any rule runs: `trailingSlash` (`never`, `always` or `preserve`), `cleanUrls` and `caseSensitive`. In 1.0 `cleanUrls` and `caseSensitive` can only be `true`; `false` is reserved. |
| `functions` | Yes | Names of folders under `functions/`, each matching `^[a-z][a-z0-9-]{0,62}$`. Empty for a static site. |
| `images`, `crons` | No | See Images and crons. A cron's `timezone` can only be `UTC`, and `target.method` is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. |
| `env`, `bindings` | No | See Environment, secrets and bindings. |
| `digests` | Yes | sha256 of every other JSON file: it must name `static.index.json`, `routes.json` and every function's `function.json` (validate refuses a manifest that leaves one out, since that file would sit outside the content id), and `prerender.json` exactly when the file exists. Function bundles and static files are pinned one level down, in their own files. |
| `x-…` keys | No | Extension data (see Capabilities and extensions). |

The content id is `sha256:` plus the sha256 of the canonical manifest (RFC 8785 JSON) with its top-level `build` key removed. Two builds with identical output share a content id, so redeploying is a no-op; `build.id` still tells them apart in logs. Every JSON file is canonical, so file digests and canonical digests coincide: a digest in `digests` is both the sha256 of the bytes on disk and the sha256 of the parsed file re-serialized canonically. Through `digests`, each `function.json`'s `artifact.digest` and `bundle.index.json`, the content id covers every file of the build, `dispatch.json` included.

Because 1.0 final moved `dispatch.json` inside `bundle.index.json`, a build with functions made after the upgrade has a different content id from the same commit built before it. Builds already stored keep their own content ids and still validate and promote. No deploy is forced by the upgrade itself: the first new build of each project with functions (a new commit, or a manual Redeploy) deploys once even if nothing else changed, instead of being skipped as already live, and later builds are compared as usual. Static and SPA builds have no functions, so their content ids don't change.

## Determinism

Producers are deterministic: the same build input always gives the same `.nbo/` and content id. The input is the source tree, the producer's settings, the build's environment (for Next.js, `NBO_BUILD_ID` and `.next/cache`, which holds the draft mode and server action keys) and the Node major that ran the build (`runtime.version` is `>=<that major>`). Different `NEXT_PUBLIC_*` values give a different content id on purpose (`inlinedEnvDigest`).

One exception is allowed: pages the app itself renders at build time. A Next.js page that prints the clock is rendered again on every build, and Next writes the wall-clock time of each `"use cache"` entry into the PPR resume state, which it reads back when resuming. So two builds of the same commit may differ in exactly these places, and in nothing else:

- In `static.index.json`, an entry whose key is a `seeds` file of a prerender entry may differ in `digest` and `size` (and its file's bytes). Same keys, every other field equal.
- In `prerender.json`, an entry's `x-nbo-ppr.postponedState`. Entries are compared by `id`, so their order may differ; each id appears once in each build, the same ids appear in both, every top-level field is equal, and each entry is equal once its `postponedState` is blanked (a `postponedState` present in one build and missing in the other is a difference).
- In `manifest.json`, the `digests` of those two files (and `build`, which the content id leaves out anyway).

`routes.json`, every `function.json` and every `bundle.index.json` must be byte-equal. CI builds each fixture twice from the same commit: static and SPA fixtures must give the same content id; Next.js fixtures must give the same content id or differ only as above (`scripts/ci/nbo-diff.mjs --classify`, run by `scripts/ci/determinism-next.sh`, which names every differing path). Each fresh build must also pass `nbo validate --strict`.

The content id still covers seeds and `postponedState`, so two builds that rendered different pages are two deployments. The "already live" check, carried files and Speed Insights attribution rely on that.

## Static assets

`static.index.json` maps every URL path to a file, its digest, an explicit content type and a cache class, so no provider ever guesses headers.

```json
{
  "files": {
    "/": { "file": "index.html", "digest": "sha256:ab12…", "size": 5120, "contentType": "text/html; charset=utf-8", "cache": "revalidate" },
    "/blog/hello": { "file": "blog/hello.html", "digest": "sha256:3e9d…", "size": 9311, "contentType": "text/html; charset=utf-8", "cache": "revalidate" },
    "/_assets/app.3f9a1c.js": {
      "file": "_assets/app.3f9a1c.js", "digest": "sha256:c4f0…", "size": 88211,
      "contentType": "text/javascript; charset=utf-8", "cache": "immutable"
    }
  }
}
```

The key is the URL path and `file` is the path under `static/`. That one indirection covers clean URLs, `index.html` resolution and Vercel's `overrides` without extra config.

| Cache class | `Cache-Control` sent | Use for |
| --- | --- | --- |
| `immutable` | `max-age=31536000, immutable` | Hashed assets |
| `revalidate` | `max-age=0, must-revalidate` | HTML and unhashed files |
| `no-store` | `no-store` | Files that must always come from origin |

- The app server sends exactly these `Cache-Control` values on a `200` for the file. It sends no `CDN-Cache-Control` and no other cache header. Header rules in `routes.json` run after it and can override the value.
- A page served as the `404` error page, or as the file of a `respond` action, gets no `Cache-Control` from its cache class.
- An entry has exactly `file`, `digest`, `size`, `contentType` and `cache`, plus `x-` extension keys. Precompressed `variants` are reserved (see Reserved for later): the 1.0 schema rejects them.
- `contentType` is mandatory. Object stores guess types differently, and a wrong guess on `.mjs` or `.wasm` breaks pages silently.

## Functions

Each `functions/<name>/function.json` says what the code needs (runtime, handler, bundle, and optionally resources and capabilities) and leaves the mapping to Cloud Run or a Kubernetes pod to the adapter.

```json
{
  "name": "ssr",
  "runtime": { "kind": "node", "version": ">=22" },
  "handler": { "style": "fetch", "entry": "index.mjs", "export": "default" },
  "artifact": { "type": "bundle", "path": "bundle/", "digest": "sha256:5d3a…", "files": "bundle.index.json" },
  "resources": { "memoryMb": 1024, "maxDurationSec": 60, "maxRequestBodyMb": 10 },
  "concurrency": "multi",
  "requires": ["fn.streaming"]
}
```

| Runtime `kind` | Contract | Typical targets |
| --- | --- | --- |
| `node` | Fetch handler on Node.js within a version range | Cloud Run, a Kubernetes pod |

Field notes:

- `name` equals the function's folder name and matches `^[a-z][a-z0-9-]{0,62}$` (lower-case letters, digits and hyphens, starting with a letter, at most 63 characters), because adapters derive cloud object names from it.
- `runtime.kind` is `node` in 1.0. `runtime.version` is an optional free-form range. The Next.js producer writes `>=<major>`, the Node.js major of the machine that ran the build (`>=22` on Node 22), so building the same commit on another Node.js major gives another `function.json` and so another content id. Nothing in 1.0 reads `runtime.version`: the images run the Node.js version they were built with.
- `handler` is `{ "style": "fetch", "entry": "index.mjs", "export": "default" }` in every build the reference writer makes; see Runtime contract.
- `concurrency` is always `multi`: an instance may serve parallel requests.
- `resources` (`memoryMb`, `maxDurationSec`, `maxRequestBodyMb`, all integers) and `requires` (ids from the capability vocabulary) are optional. When present, the planner checks each `resources` value against the target adapter's published limits and fails the plan rather than silently clamping (on Cloud Run, `memoryMb` and `maxDurationSec` also set the service's memory and request timeout), and resolves each `requires` id like a build-level capability. The reference writer writes neither: a producer's per-function capabilities (the Next.js `ssr` function's `fn.streaming`) go into the manifest's `requires.capabilities`.
- Reserved, rejected by the 1.0 schema (see Reserved for later): runtime kinds `edge`, `container` and `python`; `concurrency: "single"`; the fields `group`, `platform`, `placement`, `scaling`, `env` and `bindings`. Function-level env and bindings are declared once, in the manifest.
- `function.json` accepts `x-` extension keys at its root.

## Runtime contract

A function's bundle holds an ES module at `handler.entry` (`index.mjs`). Its export named by `handler.export` (`default`) is an object with a `fetch` method:

```ts
export default {
  async fetch(request: Request): Promise<Response> { /* … */ }
};
```

- The function host (`host.mjs` in `@nbo/funcproxy`, which runs every function locally, in Kubernetes and on Cloud Run) loads the module once, then calls `fetch(request)` for each request, as a plain function (not as a method of the module object). The request's URL is the function's own address with the original path and query; the public host is in `x-forwarded-host`. The request is aborted when the caller disconnects. A `fetch` that throws gives `500`.
- `fetch` gets one argument. The `env` and `ctx` arguments of earlier drafts (with `waitUntil`, `requestId`, `deploymentId`) are reserved for a later minor. The deployment id is in the `x-nbo-deployment-id` request header. Work left running after the response is not awaited: the instance may stop at any time (`fn.waitUntil` is unsupported on every 1.0 target, and Next's `after()` and `waitUntil` are not awaited).
- Values reach the function only through `process.env`: the project's variables, resolved bindings and the platform's `NBO_` names (see Environment, secrets and bindings). They are in place before the module is imported, so module-level code sees them.
- The host streams every response body as the function produces it. `fn.streaming` declares that the function depends on that: a target that can't stream must refuse the plan. A function that doesn't declare it must still work if a target buffers its body.
- Logs go to stdout and stderr, where the cloud's own logging picks them up (the pod's logs in Kubernetes, Cloud Logging on Cloud Run). One JSON object per line is recommended, not required. NBO injects no tracing configuration in 1.0.

Request headers a function can rely on:

| Header | Set by | Value |
| --- | --- | --- |
| `x-nbo-deployment-id` | The app server, on every request to a function or middleware, replacing a client's copy | The manifest content id of the build being served |
| `x-forwarded-host` | The edge, from the visitor's `Host`; when absent, the app server fills it from the request's `Host` | The public host |
| `x-forwarded-proto` | The edge | `https` or `http`: the edge's listener scheme in a cluster; in dev mode the visitor's own scheme (the edge reads its `x-forwarded-proto` or `forwarded`) |
| `x-forwarded-for` | The edge in a cluster: the visitor's address (for a domain behind Cloudflare, `CF-Connecting-IP` when the request comes from Cloudflare's ranges). In dev mode the visitor's own header passes through unchanged | Client address |

Headers removed before a function sees them:

- The app server removes Next.js's platform-only headers from every client request (listed under Platform behaviour), and replaces any client `x-nbo-deployment-id`.
- The edge removes `x-nbo-relay-token` and `x-nbo-upstream` (its relay protocol) from every visitor request. In a cluster it also removes the visitor's `x-forwarded-proto`, `x-forwarded-for`, `x-real-ip`, `forwarded`, `cf-connecting-ip`, `true-client-ip` and `x-nbo-client-ip`, then sets its own values as in the table.
- On Cloud Run the app server sends the client's `authorization` to the function as `x-nbo-forwarded-authorization` (the `authorization` slot carries Google's identity token), and the function host turns it back into `authorization` before `fetch` runs.

A function trusts no other `x-nbo-*` request header: anything else under that prefix may come from the visitor. Cron calls are authenticated by their signature, not by a header's presence (see Crons). `x-nbo-request-id`, `forwarded` (as a header NBO sets) and the geo headers `x-nbo-geo-country`, `x-nbo-geo-region` and `x-nbo-geo-city` are reserved: no 1.0 component sets them.

Response headers: the app server sets `x-nbo-deployment-id` on every response, replacing a function's copy, and `x-nbo-carried-from` on carried files (see Platform behaviour); the edge adds `x-nbo-edge-backend` (the URL of the cloud backend that served the request). All three reach the visitor. Middleware's protocol headers never do (see Middleware). Any other header a function sets is passed to the visitor unchanged. Other `x-nbo-*` names a function sets reach the visitor in 1.0 too, but they are reserved for the platform: a 1.x release may remove them.

## Routing

`routes.json` holds ordered rules in six phases, matched with RE2 regexes. The reference router (`@nbo/router`) runs inside the app server, `nbo serve`, which is what the Kubernetes and Cloud Run images run and what runs locally, so routing behaves identically on every cloud. The edge does not route within an app: it only picks which cloud gets the request. There is no separate route-testing command in 1.0; to try routing locally, run `nbo serve` on the build.

Before any rule runs, the path is normalized: unreserved percent-escapes decoded, dot segments resolved, and the manifest's `routing.trailingSlash` policy applied. The policy rewrites the path silently and never redirects: with `never` (what the reference producers write), `/about/` is routed as `/about`; with `always`, `/about` is routed as `/about/`; `preserve` leaves the path as sent. The root path `/` is never changed. A site that wants visitors to see one form in the address bar adds a `redirect` rule.

Phases, in order:

1. `beforeFiles`: redirects, header rules, middleware, and rewrites that must win over files.
2. `filesystem` (implicit): look the path up in `static.index.json`, after checking prerender routes first, so seeded ISR pages never bypass their cache. A hit ends routing and runs `onMatch`.
3. `afterFiles`: rewrites to functions, including dynamic routes such as `/blog/[slug]`.
4. `fallback`: last-chance rules, such as catch-all SSR or a single-page-app `index.html`.
5. `onMatch`: header rules applied to whatever was finally served.
6. `error`: names the static page served for a `404`.

A rewrite to a path re-enters `filesystem` with the new path. After 8 rewrites the router stops with `508 Loop Detected`. Redirects and fixed responses end routing at once. The names follow Next.js rewrites (`beforeFiles`, `afterFiles`, `fallback`) because most framework routers already think in these steps.

A path-target rewrite re-checks the filesystem on its new path immediately. If that check hits, routing ends. If it misses, routing continues from the phase after the one the rewrite fired in: a `beforeFiles` rewrite miss falls through to `afterFiles` then `fallback`. `fallback` has no phase after it, so a miss there instead re-checks `fallback`'s own rules against the new path, letting one fallback rule hand off to another (one rule's rewrite target happening to be the path a second fallback rule matches, which rewrites again, for example). This stops with a clean `404` the moment a rewrite returns the path it was given (repeating it could only reproduce the same state), or when no `fallback` rule matches the new path at all. If instead the rewrites keep producing genuinely new paths, the shared 8-rewrite cap (counted across the whole request, not per phase) ends the request with `508` the moment it is exceeded, not `404`. `beforeFiles` and `afterFiles` are never re-run against a rewritten path, by themselves or by an earlier phase. When a rewrite's immediate filesystem check hits, `onMatch` runs against the path that was actually served, not the original request path.

```json
{
  "version": 1,
  "beforeFiles": [
    { "id": "old-docs", "match": { "path": "^/docs/v1/(?P<rest>.*)$" },
      "action": { "type": "redirect", "location": "/docs/$rest", "status": 308 } },
    { "id": "security-headers", "match": { "path": "^/" },
      "action": { "type": "headers", "set": { "x-frame-options": "DENY" } }, "continue": true },
    { "id": "mw", "match": { "path": "^/", "pathNot": "^/(_assets|_nbo)/" },
      "action": { "type": "middleware", "function": "middleware" } }
  ],
  "afterFiles": [
    { "id": "blog-detail", "match": { "path": "^/blog/(?P<slug>[^/]+)$", "methods": ["GET", "HEAD"] },
      "action": { "type": "rewrite", "function": "ssr" } }
  ],
  "fallback": [
    { "id": "ssr-catch-all", "match": { "path": "^/" }, "action": { "type": "rewrite", "function": "ssr" } }
  ],
  "onMatch": [
    { "id": "blog-section", "match": { "path": "^/blog/" },
      "action": { "type": "headers", "set": { "x-section": "blog" } }, "continue": true }
  ],
  "error": { "404": { "file": "/404" } }
}
```

| Action `type` | Fields | Effect |
| --- | --- | --- |
| `redirect` | `location` and `status`, both required; `status` is 301, 302, 307 or 308 | Ends routing |
| `respond` | `status`, optional `file` | Ends routing with a fixed response |
| `rewrite` | `function` or `path`, or both | `function` serves (with `path` given, the function sees that path); `path` alone re-enters `filesystem` |
| `headers` | `set`, `append`, `delete` on the response | Usually paired with `continue: true` |
| `middleware` | `function` | Outcome decided by the middleware's response |

`error` has one possible key in 1.0, `"404"`, whose value is `{ "file": "<static.index.json key>" }`: the page served when routing ends in a 404. Other statuses and function error pages are reserved. A rule (not its `match` or `action`) accepts `x-` extension keys.

Matching rules:

- `path` is RE2 syntax, matched against the normalized path: unreserved percent-escapes decoded, dot segments resolved, the `trailingSlash` policy applied. No lookarounds and no backreferences, so Envoy, Go and Rust routers can all run it.
- Vercel's route `src` is a PCRE-compatible regex ([Vercel docs](https://vercel.com/docs/build-output-api/configuration)), and Next.js-generated patterns can contain lookaheads too. Producers must lower lookaheads into `pathNot` or an earlier rule, or fail the build with the offending pattern named.
- Named groups `(?P<name>…)` substitute as `$name`, numbered groups as `$1`. A function rewrite keeps the original path unless `path` is given.
- A match has `path`, optional `pathNot` and optional `methods`. Header, cookie, query and host conditions (`has` and `missing`) are reserved, as are the `transform` action and rewrites to an external `url` (see Reserved for later); the 1.0 schema rejects them.
- Within a phase the first match without `continue` ends the phase. Rules with `continue: true` stack their header changes and evaluation goes on.

## Middleware

Middleware is an ordinary function invoked from a `beforeFiles` rule (`"action": { "type": "middleware", "function": "<name>" }`). It steers routing through reserved response headers, so any runtime that returns a `Response` can implement it.

| Middleware returns | Router does |
| --- | --- |
| `x-nbo-next: 1` | Continues routing with the original path |
| `x-nbo-rewrite: /path` (optionally `?query`, which replaces the request's query string) | Continues routing with the new path |
| `x-nbo-request-headers: a,b` plus `x-nbo-request-header-a: …` | Replaces the request headers for everything downstream with exactly the named set |
| Any other response, including a redirect | Sends it to the client as is; routing ends |

- `x-nbo-rewrite` takes a path only. A full URL (`http://…` or `https://…`) is not followed: the request fails closed with `502`.
- On a continue or rewrite, every other response header (such as `Set-Cookie`) is merged into the final response. The status and body are discarded. The protocol headers `x-nbo-next`, `x-nbo-rewrite`, `x-nbo-request-headers` and every `x-nbo-request-header-*` never reach the client, whatever the outcome (with a response sent as is too). Other headers pass; the app server then replaces `x-nbo-deployment-id` with the real one, as on every response. Other `x-nbo-*` names pass in 1.0 too, but they are reserved for the platform: a 1.x release may remove them.
- The middleware request is the visitor's request (method, URL, headers, and the body up to 10 MiB). A middleware function runs at most once per request, even when several rules name it.
- The Next.js adapter maps Next's own middleware headers onto these names, so Next middleware runs unchanged.
- Middleware gets a 5-second budget. On timeout the router fails closed with `504`, so an auth check is never skipped. A middleware that can't be reached, throws, or gets a body over 10 MiB fails closed with `502`.

## Prerendering and ISR

A prerender config turns a function route into a cached page with stale-while-revalidate behavior. The cache is the platform's own cache service (`@nbo/isrcache`, reached by the app server through `NBO_ISRCACHE_URL`, or through the `__isrcache` entry of the function URL map in a deploy), so ISR works the same on every cloud instead of depending on provider features.

All prerender configs of a build live in one optional file, `prerender.json`, pinned by `manifest.digests["prerender.json"]`. A build with no prerender routes has no `prerender.json`.

```json
{
  "version": 1,
  "prerenders": [
    {
      "id": "blog-detail",
      "match": "^/blog/(?P<slug>[^/]+)$",
      "function": "ssr",
      "revalidateSec": 300,
      "expireSec": 86400,
      "tags": ["blog", "post:$slug"],
      "seeds": {
        "/blog/hello": { "file": "/blog/hello" },
        "/blog/launch": { "file": "/blog/launch" }
      },
      "onMiss": "blocking",
      "allowQuery": ["page"],
      "varyHeaders": ["accept-language"],
      "bypassToken": { "env": "NBO_PRERENDER_BYPASS" }
    }
  ]
}
```

`id`, `match` (an RE2 pattern over the path), `function` (a name in `manifest.functions`), `revalidateSec`, `expireSec`, `onMiss` and `bypassToken` are required; `tags`, `seeds`, `allowQuery` and `varyHeaders` are optional.

Semantics:

- **Cache key**: the decoded path, plus only the query params in `allowQuery` and the headers in `varyHeaders`. Everything else is ignored, which keeps the hit rate high.
- **Fresh** (age under `revalidateSec`): served from cache.
- **Stale** (age under `expireSec`): served from cache while one background regeneration runs. Concurrent requests for the same key never trigger a second render.
- **Expired or missing**: `onMiss` decides. `blocking` renders and waits; `shell` serves the seed for the requested path at once (`404` when there is none) and regenerates in the background; `notFound` answers with the build's `404`.
- **What is stored**: a render answering `200`, `301`, `302`, `307`, `308`, `404` or `410`. Anything else (a `5xx`) is not stored, so a failed regeneration keeps the stale page. Renders for the cache drop the visitor's conditional request headers.
- **Seeds** are pages rendered at build time: ordinary files in `static.index.json`, keyed by URL path, named in `seeds` (each `file` is a `static.index.json` key). They are served only through their prerender route: by `shell` on a miss, and as the shell of an `x-nbo-ppr` route (see Appendix: NBO extensions).
- **Methods**: only `GET` and `HEAD` read or write the cache. Any other method (a server action `POST` to the page URL) goes to the function unchanged.
- **On-demand revalidation**: `POST /_nbo/revalidate`, answered by the app server itself. The request carries `Authorization: Bearer <token>`, where the token is the value of the environment variable a prerender route's `bypassToken.env` names (any route of the build); a build with no prerender routes has no token. The body is a JSON object with only `tags` (an array of tag strings) and/or `paths` (an array of URL paths): every entry with one of the tags, or stored under one of the paths, is dropped, and the next request renders it again. Answers: `401` without a matching token; `400` for a body that isn't a JSON object (an array, `null`, a string or a number included) or has any other field; `500` when no cache service is configured for the app; otherwise the cache service's own status (`204`). Next's own `revalidatePath()` and `revalidateTag()` don't reach this cache: a server action's answer shows the new render, but a later document `GET` of an ISR page gets the cached entry until its window ends.
- **Public host**: a request with no `x-forwarded-host` gets one from its `Host` before any function sees it, since the function's own `Host` is the platform's internal address and Next refuses a server action whose `Origin` doesn't match. A value already on the request (the edge's) is never replaced.
- **Draft mode**: a request with cookie `__nbo_bypass` set to the token skips the cache entirely.
- **Framework data requests (Next.js)**: a request with `rsc: 1` is flight data, not the page. It neither reads nor writes a cache entry, on any `onMiss` policy, and goes to the function, streamed. A render stored for every visitor (blocking, stale regeneration, shell) carries no `rsc`, `next-router-*`, `next-url`, `next-action` or `next-hmr-refresh`. Every response on a prerender route has `vary: rsc, next-router-state-tree, next-router-prefetch`. These names are Next's; the reference server applies them to every prerender route, and they are harmless for other producers.
- **Rewrites**: a rewrite whose target matches a prerender route is that route, in every phase and before the filesystem check. The seed, the cache key and the function go by the target, not the path the visitor asked for.
- **What a deploy gives**: Kubernetes and Cloud Run deploys of a build with prerender routes run one cache service per app (one per environment and cloud, named `<app>-isr`), hand the app its address under the reserved function name `__isrcache` (function names can't be that, and the URL is not a secret), and give each environment one generated revalidation token, delivered at runtime as `NBO_PRERENDER_BYPASS`. Neither the token nor the cache's address is ever written into `.nbo/`. Every cache key starts with the build's content id, so a new build never reads a page an older build cached, even while both run during a rollout; revalidation by tag or path drops matching entries of every build in that cache. A cache read that fails, answers anything but `200` or `404`, or takes over 2 seconds counts as a miss, and a cache write never delays the visitor's answer. The cache is in memory and bounded (96 MiB by default, least recently used pages go first): a restarted cache starts empty, and the build's seed pages still answer `shell` routes at once. A cloud has its own cache, so a revalidation has to reach every cloud that serves the address: the edge answers `POST /_nbo/revalidate` for a host it serves by sending the same request (method, path, `Authorization`, `Content-Type`, body of at most 64 KiB, else `413`) to every backend of that host, including those at 0%, in parallel with a 10 second limit each. It answers `204` when every backend answered `2xx`; the shared status, with an empty body, when every backend answered the same other status (a wrong token stays `401`); else `502` with `{"backends": [{"id": "<environment id>", "status": 204}, ...]}`, status `0` meaning unreachable or timed out; `400` when it can't read the request body; a host with no backends gets the unknown-host `404`. Every answer carries `x-nbo-edge-fanout: <number of backends>` and `cache-control: no-store`. The edge doesn't check the token; each app does. An edge older than this behaviour sends the request to one cloud only. Without an edge, a client calls each cloud's own address. A producer's contract above is unchanged.

Requires `prerender.isr`; on-demand needs `prerender.onDemand`. The Next.js data cache (fetch results, `unstable_cache`) is not part of the build output.

Next.js partial prerendering is not in 1.0 core. It is the NBO extension `x-nbo-ppr`, described in Appendix: NBO extensions.

## Images and crons

Image optimization and crons are platform services declared in the manifest. The platform implements both itself, so neither depends on a provider feature.

### Images

```json
"images": {
  "widths": [640, 750, 828, 1080, 1200, 1920],
  "formats": ["image/avif", "image/webp"],
  "qualities": [50, 75],
  "remotePatterns": [{ "protocol": "https", "hostname": "^cdn\\.acme\\.com$", "pathname": "^/media/" }],
  "localPatterns": [{ "pathname": "^/assets/" }],
  "minimumCacheTTLSec": 3600,
  "allowSvg": false
}
```

- The endpoint is `GET /_nbo/image?url=…&w=…&q=…`, answered by the app server. Producers point the framework's image loader at it, the way Vercel uses `/_vercel/image`. `url` is a local path (a `static.index.json` key) or an absolute URL; `w` is the width in pixels; `q` is the quality.
- `w` must be one of `widths` and `q` one of `qualities`; a local `url` must match a `localPatterns` `pathname`, a remote one a `remotePatterns` entry (`protocol` when given, `hostname` and `pathname`, each RE2). A `localPatterns` that is absent or empty allows every local path, as Next does when its list is unset (the Next producer wrote `[]` for an unset list before 1.0 final); a pattern without `pathname` matches any path. To allow no local image, write a pattern no path matches, such as `^$`. An absent or empty `remotePatterns` allows no remote image. Anything else is `400`. A block without `widths` or `qualities` allows no value for that parameter, so every request is `400`. Without those allowlists anyone can make the platform resize arbitrary images at arbitrary sizes, at the customer's expense.
- A local `url` with no `static.index.json` entry is `404`. A remote source that can't be fetched (5 seconds, at most 10 MiB read), or a source that can't be decoded or encoded, is `502`. A build without an `images` block answers `500`.
- Output is JPEG at quality `q`, or PNG when the resized image has real transparency. `formats` is advisory: it records what the framework asked for, and 1.0 does not negotiate on `Accept`. `allowSvg` is not read.
- A resized image is stored in the cache service under the key `url`, `w`, `q`, with `minimumCacheTTLSec` as its lifetime (`0`, not stored, when the field is missing); the next identical request is served from it.

### Crons

```json
"crons": [
  { "id": "nightly-sync", "schedule": "0 3 * * *", "timezone": "UTC",
    "target": { "function": "ssr", "path": "/api/cron/sync", "method": "POST" },
    "overlap": "skip", "timeoutSec": 300 }
]
```

- `schedule` has exactly five fields separated by spaces: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-6, Sunday is 0). Each field is `*`, `*/N` (N at least 1, counted from the field's lowest value), or a comma list of numbers. Ranges (`1-5`) and names (`MON`) are not supported.
- A minute matches when all five fields match. That includes the two day fields: with both day of month and day of week restricted, a run needs both (`0 0 13 * 5` runs only on a Friday the 13th), unlike classic cron, where either one is enough.
- Times are UTC. `timezone` may be omitted or `"UTC"`; nothing else is accepted.
- `target.function` must be in `manifest.functions`; `target.method` is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. The call is an ordinary HTTP request to the deployment's address plus `target.path`, with no body.
- Each call carries three headers: `x-nbo-cron: <id>`, `x-nbo-cron-timestamp: <ts>` (Unix seconds) and `authorization: Bearer <signature>`, where the signature is the lower-case hex HMAC-SHA256 of the string `<id>:<ts>` keyed with the value of `NBO_CRON_SIGNING_SECRET`, which the platform sets in the app's and functions' environment (one secret per cloud a project runs on, kept by the control plane). A cron path is otherwise an ordinary public route, so the function verifies the signature (and the timestamp's age) itself.
- `timeoutSec` bounds the call (default 60 when omitted or 0). A call that fails or times out is not retried; the cron runs again at its next scheduled time. Handlers should still be idempotent.
- `overlap` is `skip` or `allow` (omitted means `allow`). With `skip`, a cron whose previous call is still running is not called again until it finishes. Crons run in production only unless the environment opts in.
- The scheduler belongs to the control plane, not to EventBridge or Cloud Scheduler, so schedules survive a move between clouds.

## Environment, secrets and bindings

The build output names what it needs and never carries values. Values are resolved per environment at deploy time, so one build can run against a database in one cloud today and another tomorrow.

- `env.required`: names the app cannot run without. Before deploying, NBO checks every required name, plus every binding's `<NAME>_URL`, against the names that will have a value (the project's variables for that environment, the names NBO supplies itself, and in dev mode NBO's own process environment) and refuses the deploy, naming every missing one at once. A deploy outside the control plane (`nbo deploy`) checks the same names against its own process environment.
- `env.optional`: names that may be absent. A value is passed when one is set; nothing fails when it isn't.
- Declaring names is what makes the check possible; it doesn't limit delivery. At runtime the app and its functions get every variable the project sets for the environment, declared or not, in `process.env` (a Kubernetes Secret, or Cloud Run's environment and Secret Manager), never baked into an image or into `.nbo/`.
- `env.inlinedAtBuild` lists variables the bundler baked into code. The Next.js producer lists every `NEXT_PUBLIC_*` name set in the build's environment. `env.inlinedEnvDigest` is `sha256:` plus the lower-case hex SHA-256 of those names' `NAME=value` lines, sorted by name and joined by `\n` (no trailing newline).
- The planner compares that digest only when it is given the target environment's values (a name with no value counts as empty), and then fails the plan on a mismatch. 1.0 deploys and `nbo plan` give it no values, so the digest is not compared. Instead, before a promote of a stored build, the dashboard warns when the project's variables changed since that build was made and asks to confirm; it does not refuse.

Bindings declare a service by protocol, never by product. A binding is `{ "name": "<name>", "type": "<type>" }` in the manifest's `bindings`; no 1.0 producer writes one.

| Binding `type` | Contract | Value the app gets | Examples it can point to |
| --- | --- | --- | --- |
| `postgres` | Postgres wire protocol | `<NAME>_URL`, a connection string | RDS, Cloud SQL, Neon, CloudNativePG |
| `s3` | S3 API | `<NAME>_URL` | S3, GCS (interoperability mode), R2, self-hosted S3-compatible stores |
| `redis` | RESP (Redis and Valkey) | `<NAME>_URL` | ElastiCache, Memorystore, self-hosted Valkey |
| `cache` | Platform data-cache API | `<NAME>_URL` | Nothing in 1.0: NBO resolves no binding itself |

- `<NAME>` is the binding's `name` in upper case. Every binding type gets exactly one variable, and every binding is required: the deploy check above refuses a deploy without it.
- The value comes from the project's variables, like any other variable (in dev mode also from NBO's own environment). NBO provisions nothing and supplies no credentials for a binding in 1.0.
- Queues, pub/sub and blob events are not in 1.0 core. They come as extensions once two providers can be mapped cleanly.

Platform variables: names starting with `NBO_` are reserved (see Platform behaviour). At build time the control plane sets `NBO_ENV`, `NBO_GIT_COMMIT_REF`, `NBO_GIT_COMMIT_SHA` and `NBO_GIT_PULL_REQUEST_ID`; the Next.js producer reads `NBO_BUILD_ID` as Next's build id when it is set. At runtime the control plane's deploys set `NBO_CRON_SIGNING_SECRET`, and, for a build with prerender routes, `NBO_PRERENDER_BYPASS` (the environment's generated revalidation token, which a Next.js prerender route's `bypassToken.env` names). The app server also reads `NBO_ISRCACHE_URL` (the ISR cache service) when it is set; only someone running `nbo serve` sets that, because a deploy hands the app its cache's address through the `__isrcache` entry of the function URL map. A deploy passes `NBO_ISRCACHE_URL` and `NBO_PRERENDER_BYPASS` on from NBO's own environment in neither mode.

No secret value may appear in `.nbo/`. `nbo validate` scans the metadata JSON files (`manifest.json`, `routes.json`, `static.index.json`, `prerender.json` and every `function.json`), split into words at JSON punctuation, and fails on a word that matches a known key shape (an AWS access key id `AKIA…`, a PEM private key header, a GitHub token `ghp_…` or `github_pat_…`) or that is at least 20 characters long, contains no `/`, and has a Shannon entropy of 4.5 bits per character or more. Function bundles and static files are not scanned.

## Capabilities and extensions

Capabilities are a fixed vocabulary of feature ids. Builds declare what they need, adapters declare what they offer, and the planner resolves each need to native, emulated or unsupported before anything is provisioned.

| Capability id | Meaning |
| --- | --- |
| `fn.streaming` | Streamed response bodies |
| `fn.edge` | Edge-tier isolate functions |
| `fn.waitUntil` | Background work after the response is sent |
| `fn.arm64` | arm64 execution |
| `prerender.isr` | Time-based revalidation |
| `prerender.onDemand` | Tag and path revalidation |
| `images.optimize` | The `/_nbo/image` endpoint |
| `geo.headers` | Geo request headers |

These eight ids are the whole 1.0 vocabulary: the schema rejects any other id in `requires.capabilities` and in a function's `requires`. Middleware and crons are not capabilities: they are platform services on every 1.0 target, so a build that uses them declares nothing (`route.middleware` and `cron` are reserved). A build may declare `fn.edge`, `fn.waitUntil`, `fn.arm64` or `geo.headers`; no 1.0 target offers them, so the plan fails as unsupported.

What the producers declare: the writer adds `prerender.isr` and `prerender.onDemand` together whenever the build has a prerender entry, and `images.optimize` whenever the manifest has an `images` block; the Next.js producer gives its `ssr` function `fn.streaming`. The manifest's list is the sorted union of these and every capability a producer gave a function through the writer (the writer writes no `requires` into `function.json`).

Numeric needs (duration, memory, body size, bundle size) are not capability ids. The planner compares the function's `resources` against the adapter's published `limits`.

Each requirement resolves to one of three outcomes:

- **Native**: the provider does it, for example streaming on Cloud Run.
- **Emulated**: a platform service fills the gap, for example ISR through the platform's cache tier on a provider with no ISR. The plan shows which service.

In 1.0, `prerender.isr` and `prerender.onDemand` resolve as emulated (`platform-cache`) on Kubernetes and Cloud Run: the deploy runs the cache service and sets the revalidation token (see "What a deploy gives" in Prerendering and ISR). An adapter may attach a note to any capability it plans (`notes` in its published capabilities); the plan shows it as a `[note]` line, and notes never fail a plan. The two reference adapters have none to give today.
- **Unsupported**: the plan fails and names the requirement, the function and the limit.

Extensions add fields without a spec release:

```json
"extensions": [
  { "id": "x-nbo-ppr", "version": "1", "critical": true },
  { "id": "x-acme-analytics", "version": "2", "critical": false }
]
```

- An extension's id is its key: it matches `^x-[a-z0-9]+(-[a-z0-9]+)+$` (`x-`, then at least two lower-case words joined by hyphens, such as `x-nbo-ppr` or `x-acme-analytics`).
- Extension data lives under that key, on one of five extendable objects: the manifest root, a `function.json` root, a route rule in `routes.json`, a prerender entry in `prerender.json`, and a `static.index.json` file entry. The schemas accept any value under a key matching the pattern on those objects and nowhere else; core schemas reject every other unknown key.
- Every extension key used in a build must be declared in `requires.extensions`; `nbo validate` fails an undeclared one, naming the file and the key, so a misspelled key is still caught.
- The generic rule checks only the key. An extension that needs its data checked deeply ships its own schema: NBO's own `x-nbo-ppr` (see Appendix: NBO extensions) keeps an explicit, typed property in `prerender.schema.json`, so an `x-nbo-ppr` with no `postponedState` is still rejected.
- An unknown `critical` extension fails the plan. An unknown non-critical one is ignored with a warning.

## Versioning and compatibility

- **Format.** `specVersion` is `"MAJOR.MINOR"`, for example `"1.0"` (the manifest schema's pattern). Editorial fixes to this document are patch releases of the document (`spec-v1.0.1`); they never change `specVersion` or any schema.
- **Minor releases only add.** A minor (1.1, 1.2) may add new optional fields, new capability ids, new action types, new enum values, or core status for a reserved name. It never changes what an existing field means. Every 1.x manifest stays valid under every later 1.x consumer.
- **A major release is anything else**: removing or renaming a field, changing a default, changing the content id definition, the digest algorithm, or the wire names.
- **One source of the version.** `spec/version.json` holds `{ "specVersion": "1.0" }` and is exported as `@nbo/spec/version.json`. The writer writes that value into every manifest; `@nbo/validate` reads the same file.
- **Consumers.** `nbo validate` (and so `nbo content-id`, `nbo deploy` and the control-plane's promote, which call it) accepts a manifest whose major equals its own and whose minor is not newer. It checks the version first and still runs every other check. A newer minor fails with `manifest.json: built for NBO spec 1.3; this nbo reads spec 1.0 and older 1.x; upgrade NBO`; another major (newer or older) fails with `manifest.json: NBO spec 2.0 is not supported; this nbo reads 1.x`. A missing or malformed `specVersion` is a schema error. Refusing a newer minor, instead of ignoring the fields it doesn't know, is what keeps "core schemas reject unknown fields" true: an older validator can't know a newer minor's fields.
- **Producers write the version they implement**, never a newer one. For operators this means: after rolling NBO back, builds made by the newer NBO can't be promoted; rebuild them.
- **Upgrade consumers before producers.** Validators, adapters and routers go first, so they already read a version when the first build that says it arrives.
- **Extensions version independently** through `requires.extensions[].version` (see Capabilities and extensions). A new extension version is not a spec release.
- **Builds made before 1.0 final** already say `"1.0"`. They differ from final 1.0 in one way: a `dispatch.json` at a function bundle's root that `bundle.index.json` doesn't list. Validate accepts exactly that one unlisted file at a bundle's root; 2.0 drops the allowance.

## Platform behaviour

This section is how NBO's app server (`nbo serve`, which runs locally and inside the Kubernetes and Cloud Run images) behaves in ways an app can observe. It is not part of `.nbo/`: producers write nothing for it and `nbo validate` checks none of it. Any other runtime for NBO builds must behave the same way. The spec 1.0 conformance suite (see Validation and conformance) checks each point below.

**Deployment id.** Every response carries `x-nbo-deployment-id: <content id>`, the content id of the build being served: pages, files, `404`s, redirects, function and middleware answers, `/_nbo/` answers and carried files. Every request the app server forwards to a function or to middleware carries the same header. The app server replaces a client's copy on the request and a function's or middleware's copy on the response, so the header can be trusted. The edge leaves it on the visitor's response.

**Platform-only request headers.** Before routing, the app server removes these headers from every client request, because Next.js treats them as signals only the platform may send: `next-resume`, `x-matched-path`, `x-next-resume-state-length`, `x-now-route-matches`, `x-nextjs-data`, `x-middleware-rewrite`, `x-middleware-redirect`, `x-middleware-set-cookie`, `x-middleware-skip`, `x-middleware-override-headers`, `x-middleware-next`. The app server itself may send some of them to a function (the resume request of `x-nbo-ppr`).

**`x-forwarded-host`.** A function sees the public host in `x-forwarded-host`. The edge sets it; when a request reaches the app server without it (a local `nbo serve`, a direct request), the app server fills it from the request's `Host`. A value already on the request is kept.

**Cache headers and trailing slashes.** Static files get exactly one `Cache-Control` value per cache class (see Static assets). The `trailingSlash` policy rewrites the path and never redirects (see Routing).

**Reserved paths: `/_nbo/`.** The app server answers `GET /_nbo/image` (see Images) and `POST /_nbo/revalidate` (see Prerendering and ISR) before routing, so `routes.json` rules never see them. The edge answers `/_nbo/insights/v1/script.js` and `/_nbo/insights/v1/vitals` (Speed Insights) without reaching the app, and fans `POST /_nbo/revalidate` out to every backend of the host (see Prerendering and ISR). Every other path under `/_nbo/` is reserved for the platform: a producer must not write a `static.index.json` key there (validate warns, `--strict` refuses), and the platform may answer new `/_nbo/` paths in any 1.x release.

**Reserved variables: `NBO_`.** Environment variable names starting with `NBO_` belong to the platform; NBO refuses a project or workspace variable with such a name. The names NBO uses in 1.0 are listed under Environment, secrets and bindings: `NBO_ENV`, `NBO_GIT_COMMIT_REF`, `NBO_GIT_COMMIT_SHA` and `NBO_GIT_PULL_REQUEST_ID` (empty except for a preview with a pull request) at build time, `NBO_BUILD_ID` read by the Next.js producer, and `NBO_CRON_SIGNING_SECRET`, `NBO_ISRCACHE_URL` (set by whoever runs `nbo serve`) and `NBO_PRERENDER_BYPASS` at runtime. New `NBO_` names may appear in any 1.x release.

**Carried files.** When NBO deploys a build over an earlier one on the same cloud, it copies the earlier build's `immutable` static files whose paths the new build does not list (from the one build before only; when they add up to more than 256 MiB, none are carried) next to the new app, so a visitor still holding an old page can fetch its hashed assets. The copy is a directory with `index.json` and the files under `static/`:

```json
{
  "version": 1,
  "contentId": "sha256:<content id of the earlier build>",
  "files": {
    "/assets/app-3f9a1c.js": { "file": "assets/app-3f9a1c.js", "contentType": "text/javascript; charset=utf-8" }
  }
}
```

- The keys are URL paths as in `static.index.json`; `file` is a path under the directory's `static/`.
- A carried file answers only a `GET` or `HEAD` that the new build answers with `404`, whatever produced that `404`. Anything the new build serves wins, including a file at the same path with new bytes.
- The answer is `200` with the entry's `contentType`, `cache-control: max-age=31536000, immutable`, `x-nbo-carried-from: <earlier content id>` and the new build's `x-nbo-deployment-id`. The new build's header rules are not applied to it.
- A missing or malformed carry directory is ignored (logged once); the app serves without it.
- Carried files are not part of `.nbo/` and do not change the new build's content id.

## Distribution

The unit of distribution in 1.0 is the `.nbo/` directory itself. There is no archive format: a build is a directory tree whose files are pinned by the manifest's digests, and its content id names it.

- NBO's control plane keeps a copy of each build's `.nbo/` in its artifact store (`NBO_ARTIFACTS_DIR`, by default `artifacts/` next to its database): the newest 20 successful builds of each project, plus every build that is live on a cloud. Deploying a stored build to another cloud or environment validates the stored copy again and deploys it as it is, without rebuilding.
- Rollback is deploying an older stored build. Nothing is rebuilt; the content id says whether that build is already live.
- How the directory reaches a cloud is the provider adapter's business, not part of `.nbo/`. The Kubernetes and Cloud Run adapters build an app image that runs `nbo serve` on a copy of the directory, and one image per function from its `bundle/`, at deploy time. Those images are not a distribution format: nothing reads them back as a build.
- Any copy of the directory is complete (there are no symlinks), so a plain file copy or a tarball moves a build. `nbo validate` on the copy proves it is intact.

After 1.0 (a sketch, not a rule): a build could ship as an OCI artifact, since every cloud runs an OCI registry and registries replicate between clouds. The draft's shape was one config blob for `manifest.json`, one layer per function bundle, static files in layers grouped by cache class, a metadata layer, references by digest only, Sigstore signatures and SLSA provenance as referrers, and a planner that refuses unsigned artifacts in production. None of it is implemented. Packaging as a whole is reserved for later (see Reserved for later), but the draft's media types are not: a later minor that adds packaging defines its own names.

## Producers in 1.0

Two producers cover the 1.0 scope: a static producer, which also handles React single-page apps, and a Next.js adapter. Both write through the reference writer (`@nbo/writer`), so everything the writer does (canonical JSON, digests, the default routing table, capabilities) is the same for both.

### Static producer

`@nbo/producer-static` (`nbo-producer-static <buildDir> --out <outDir> [--spa]`, and the same code called in-process by the control plane) turns a build folder such as `dist/`, `build/` or `out/` into `.nbo/`:

- Every regular file becomes a `static.index.json` entry. `index.html` maps to `/`, `<dir>/index.html` to `/<dir>`, `<name>.html` to `/<name>`, and any other file to its own path. `manifest.build.framework.name` is `"static"`. The build has no functions.
- Cache class: `immutable` when the URL path matches `\.[0-9a-f]{6,}\.[a-z0-9]+$` (case-insensitive: a hex hash of 6 or more characters before the extension, as in `app.3f9a1c.js`) or starts with the top-level `/assets/` (Vite's hashed output); `revalidate` for everything else. A nested `.../assets/` folder alone does not qualify.
- `contentType` comes from the writer's table of file extensions.
- With `--spa`, `routes.json` gets one `fallback` rule, `{ "id": "spa-fallback", "match": { "path": "^/", "pathNot": "\\.[A-Za-z0-9]+$" }, "action": { "type": "rewrite", "path": "/" } }`: extensionless paths load the root document (`index.html`, stored under the URL key `/`; rewrite targets are URL keys, not file paths), and a missing `/assets/app-3f9a1c.js` still answers `404` instead of HTML. Without `--spa`, `routes.json` is `{ "version": 1 }`.
- Directories named `.nbo`, and the output directory when it is inside the input, are skipped. Output is written into an emptied directory, so nothing from an earlier build survives.
- A symlink in the input fails the build. Two inputs that map to the same URL path (`foo.html` and `foo/index.html` both give `/foo`) or the same output file also fail the build, naming both sources. The input is walked in sorted order, so the result never depends on directory-read order.
- Every path is normalized to UTF-8 NFC before it becomes a `static.index.json` key.
- It writes no precompressed copies, no headers or redirect rules, no error page and no crons.

### Next.js producer

`@nbo/next-adapter` is a Next.js adapter: Next calls its `onBuildComplete` with the build's outputs. NBO's build runner enables it by setting `NEXT_ADAPTER_PATH`, so users never edit `next.config` (Next stabilized `adapterPath` in 16.2.0, [Next.js docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath)). `manifest.build.framework` is `{ "name": "nextjs", "version": <Next's version> }`.

What it writes:

- **Static files**: Next's `outputs.staticFiles` (its `_next/static/` assets and statically optimized pages) and every file in the project's `public/` folder (which Next's adapter outputs don't include). Files under `/_next/static/`, and files Next marks with an immutable hash, are `immutable`; everything else, `public/` files included, is `revalidate`.
- **One `ssr` function** for every App Router page and route handler (`outputs.appPages` and `outputs.appRoutes`), with each route's traced files in its bundle, an entry module that bridges Next's Node request handler to the `fetch(request)` contract, and its own `next-dispatch.json` table. The function declares `fn.streaming`, so the manifest requires it. `routes.json` gets one `afterFiles` rule per page or handler, an exact match on its path rewriting to `ssr`; there is no fallback rule, so any other path is a plain `404`.
- **Middleware** (Next's middleware or proxy file, Node.js runtime) as a function named `middleware`, invoked by one `beforeFiles` rule per Next matcher (`middleware-0`, `middleware-1`, ...), using the matcher's own regular expression.
- **Prerenders**: one `prerender.json` entry per prerendered route, keyed by its path (Next's own `/_not-found` and `/_global-error` pages are left out), with Next's `initialRevalidate` and `initialExpiration` as `revalidateSec` and `expireSec`, `onMiss: "blocking"`, the tag `group:<Next's group id>`, Next's `allowQuery` and `allowHeader` (minus Next's internal vary headers) as `allowQuery` and `varyHeaders`, and `bypassToken: { "env": "NBO_PRERENDER_BYPASS" }`. The page Next rendered at build time is the route's seed: a `revalidate` static file under the same path. A partially prerendered route gets `x-nbo-ppr` (see Appendix: NBO extensions); a cacheComponents page with no dynamic hole and no lifetime is served as a long-lived static page (`onMiss: "shell"`, a one-year window).
- **Images**: the manifest's `images` block, from Next's complete image config (so every Next build with a server has one): `widths` from `deviceSizes` and `imageSizes` (sorted, de-duplicated), `formats`, `qualities`, `minimumCacheTTLSec` and `allowSvg` copied, and `remotePatterns` and `localPatterns` with Next's `*` and `**` wildcards turned into RE2. A pattern without `pathname` becomes `^.*$` (Next reads it as `**`). An unset `localPatterns` becomes `[{ "pathname": "^/.*$" }]`, every local path, as in Next; Next's explicit `[]` (no local image) becomes `[{ "pathname": "^$" }]`. `port` and `search` are dropped.
- **Environment**: `env.inlinedAtBuild` lists every `NEXT_PUBLIC_*` name set in the build's environment, with `env.inlinedEnvDigest` over their values (see Environment, secrets and bindings). The adapter writes no `env.required`, `env.optional` or bindings.
- **Build id**: when `NBO_BUILD_ID` is set (letters, digits, `-` and `_` only) and the site's own `generateBuildId` returns nothing, Next's build id becomes `NBO_BUILD_ID`, so two builds of one commit can share their `_next/static/<build id>/` paths. A site's own build id wins.
- With `output: 'export'`, only the static files are written: no function, no routes, no prerenders, no images block.

What it refuses (the build fails, naming the route or matcher):

- The edge runtime, on a page, a route handler or middleware.
- The Pages Router (`pages/` pages and API routes).
- Dynamic route segments (`/blog/[slug]`, catch-alls), on every route.
- A middleware matcher with a `has` or `missing` condition. The one `missing` condition Next adds to every matcher itself (`x-prerender-revalidate`) is dropped instead.
- A prerendered route with `revalidate: false`, or with no number for its expiration.

What it ignores, without failing:

- `redirects`, `rewrites` and `headers` from `next.config`: they are not translated into `routes.json`, so they have no effect on NBO.
- Work scheduled with Next's `after()` or `waitUntil`: it is not awaited, and the instance may stop before it finishes (see Runtime contract).
- Crons and bindings: Next has no declaration for them, so the adapter writes none.
- Next's own `revalidatePath()` and `revalidateTag()`, which don't reach the platform cache (see Prerendering and ISR), and Next's data cache.

### How producers are tested

There are no golden files. Each producer has unit tests for its translation (the static producer's classification and collisions, the Next adapter's routes, prerenders, images, environment and build id); the writer has a replay test (the same inputs written twice give byte-identical trees); `nbo validate --strict` is meant for fresh builds; and the HTTP transcripts in Validation and conformance check what the built apps actually answer, against `nbo serve` and each adapter.

Other frameworks (Astro, SvelteKit, Nuxt, React Router) come after 1.0, through an importer for Vercel's Build Output API.

## Validation and conformance

The spec is only as portable as its tests. Ship a validator, a reference router and a conformance suite together with the schemas, and treat a failing adapter as a spec bug until proven otherwise.

`nbo validate` checks, in order, and reports every problem it finds (not only the first):

1. Spec version: `specVersion` has this validator's major and a minor no newer than its own (see Versioning and compatibility).
2. Schemas: `manifest.json`, `static.index.json`, `routes.json`, `prerender.json` (when present), every `function.json` and every `bundle.index.json` against their JSON Schemas.
3. Canonical JSON: each of those files is written in RFC 8785 canonical form (`<file>: not canonical JSON (RFC 8785)`).
4. Digests: `manifest.digests` has entries for `static.index.json` and `routes.json` (`<file>: manifest.json digests has no entry for it`) that match their bytes; every `static.index.json` entry's `file` stays inside `static/` and matches its `digest`; every file under `static/` is referenced by an entry and is a regular file. A `static.index.json` key under `/_nbo/` (reserved for the platform) is a warning, not an error (see below).
5. `prerender.json`: the file and `manifest.digests["prerender.json"]` are both present or both absent, and the digest matches. A prerender `id` that appears twice is a warning (`prerender.json: duplicate prerender id "<id>"`, see below).
6. Functions, for each name in `manifest.functions`: `function.json` has a manifest digest that matches it, and its `name` equals its folder; `artifact.digest` matches `bundle.index.json`; every listed file exists inside `bundle/` and matches its digest; every file under `bundle/` is listed in `bundle.index.json` and is a regular file (no symlinks). One allowance: an unlisted `dispatch.json` at the bundle root is accepted, because builds made before 1.0 final wrote it outside the index.
7. References: every rewrite or middleware `function` in every routing phase, every prerender `function` and every cron `target.function` is in `manifest.functions`; `error["404"].file` and every prerender seed's `file` are `static.index.json` keys.
8. Crons: ids are unique, and each `schedule` has five space-separated fields (minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-6), each `*`, `*/N` with N at least 1, or a comma list of plain numbers in range. No ranges or names.
9. Extension keys: every `x-` key on an extendable object (manifest root, `function.json` root, route rule, prerender config, static-index entry) is an `id` in `requires.extensions`.
10. RE2: every route `match.path` and `match.pathNot`, and every prerender `match`, compiles under RE2, without the JS-only escapes `\C`, `\cX`, `\uXXXX` and `\u{...}`.
11. Secret scan: the metadata JSON files (`manifest.json`, `routes.json`, `static.index.json`, `prerender.json`, every `function.json`) are scanned for values that look like credentials. Bundle files and static files are not scanned. There are no size limits.

Errors fail validation; warnings are printed and don't. A warning marks something a fresh 1.0 build must not have but a build stored before 1.0 final may have, so stored builds keep deploying. In 1.0 there are three warnings: a static key under `/_nbo/`, which an older build could carry from a site's own files; an unlisted `dispatch.json` at a bundle root, which the reference writer wrote before 1.0 final; and a duplicate prerender `id`, which the Next.js producer wrote before 2026-10-26 (it keyed entries by route, so a page and its `.rsc` variant shared one). `nbo validate --strict` treats warnings as errors; it is meant for producers' tests and CI on fresh builds. 2.0 makes every warning an error.

Every other check above is an error because every build NBO can hold already passes it: the reference writer has always written canonical JSON, listed every bundle file except the root `dispatch.json`, and pinned `static.index.json`, `routes.json`, every `function.json` and `prerender.json` in the manifest; no reference producer writes crons or error pages; and every prerender seed has been a static key since before the control-plane began keeping build output.

Conformance is checked with recorded HTTP transcripts. A transcript is one JSON file: `method`, `path`, optional request `headers` and `body`, `expectStatus`, and optionally `expectHeaders` (exact values), `expectHeaderPatterns` (a regular expression the whole value must match) and one body check, `expectBodySha256` or `expectBodyContains`. `nbo conformance <dir> <baseURL> [--insecure]` runs every `*.json` in a directory against a running app and prints one line per mismatch. These suites exist in 1.0:

| Suite | What it covers | Where it runs |
| --- | --- | --- |
| `packages/conformance/transcripts/spec-1.0/` (`static`, `spa`, `function`, `carry`) | Platform behaviour: deployment id on pages, `404`s, functions and carried files; a client's deployment id replaced; platform-only headers stripped; `x-forwarded-host` filled and kept; `Cache-Control` per class; trailing slash `never` without a redirect; the `404` error page; SPA deep links and missing-asset `404`s; carried files and the new build winning; `/_nbo/revalidate` without a token `401`; `/_nbo/image` with an unlisted width or quality `400` | `pnpm --filter @nbo/cli test` (so in every CI pipeline): apps built with `@nbo/writer`, served in-process by the app server with a real HTTP listener. Placeholders `{{contentId}}`, `{{host}}` and `{{carriedFrom}}` are filled with that run's exact values |
| `packages/conformance/transcripts/platform/` | Deployment id on a Next.js page | `scripts/verify-slice2.sh`, against local `nbo serve` and the local Kubernetes cluster |
| `fixtures/conformance/slice2`, `slice4-middleware` | The `next-app` fixture: static files, an SSR page, a route handler, and middleware (continue, rewrite, header override, redirect) | The Next.js harness (`scripts/ci/next-harness.sh`) in CI: local `nbo serve`, a `kind` Kubernetes cluster, and Cloud Run in its own job |
| `fixtures/conformance/slice5-ppr` | The `ppr-app` fixture: partial prerendering | The Next.js harness, as above |
| `fixtures/conformance/slice4-image`, `slice4-isr` | `next/image` and ISR | `scripts/verify-slice4-image.sh`, `scripts/verify-slice4-isr-local.sh` and `-cloud.sh`, run by hand against `nbo serve`, Kubernetes and Cloud Run |

Every new behaviour gets transcripts in one of these suites. A failing target is treated as a spec bug until proven otherwise.

There is one router, `@nbo/router`, used by the app server everywhere, so a local `nbo serve` routes with exactly the code that serves production.

## Decisions

The draft's open decisions are settled for 1.0. Every row is Claude's call, made under the maintainer's advance approval and recorded in ADR 0007; the reasons are in the "Why" column. Revisiting one follows Versioning and compatibility: a minor may add what a row leaves out (an edge runtime, for example); changing an answer that existing builds rely on is a 2.0 change.

| Decision | 1.0 answer | Why | Settled by |
| --- | --- | --- | --- |
| Regex flavor | RE2 plus `pathNot`. JS-only escapes (`\C`, `\cX`, `\uXXXX`, `\u{...}`) are rejected. Producers lower lookaheads into `pathNot` or fail naming the pattern | Implemented and tested in the router and in validate; every router family can run RE2 | Claude's call, ADR 0007 |
| Function identity | By name; URL paths map to functions only in `routes.json` | Implemented; one SSR function serves many routes, so adapters deploy few objects | Claude's call, ADR 0007 |
| Relation to Vercel's format | Not a superset. An importer for Vercel's Build Output API may come after 1.0 | Vercel's changes never force an NBO release | Claude's call, ADR 0007 |
| Edge runtime surface | No edge runtime in 1.0; `runtime.kind: "edge"` is reserved. When a minor adds it: WinterTC APIs plus `node:buffer` and `node:async_hooks` | No 1.0 target runs one, and Next marks its own Edge Runtime deprecated | Claude's call, ADR 0007 |
| ISR storage | The platform's own cache service (`@nbo/isrcache`), the same on every cloud | Implemented; behaves the same on every cloud and survives a move between clouds | Claude's call, ADR 0007 |
| Multi-service apps and daemons | Not in 1.x core; a later extension or 2.0 | Not needed for Next.js, React SPAs or static sites | Claude's call, ADR 0007 |
| Manifest shape | Split files linked by digest | Implemented; a route change doesn't touch function metadata | Claude's call, ADR 0007 |
| Name and directory | `.nbo/`, `nbo`, `x-nbo-*`, `/_nbo/` and `NBO_` are fixed for all of 1.x; renaming them is a 2.0 change. Schema ids are `urn:nbo:spec:v1:<file>` | A product name can change on the surface; wire names that change break every stored build | Claude's call, ADR 0007 |
| Extension schema mechanism | Both: a generic `^x-[a-z0-9]+(-[a-z0-9]+)+$` key rule on the five extendable objects, every key declared in `requires.extensions`, and a typed schema for NBO's own extensions (see Capabilities and extensions) | Third parties get a path without a release; a misspelled key still fails because undeclared keys fail | Claude's call, ADR 0007 |
| Partial Prefetching | Not covered; Next's client falls back to its ordinary prefetch | A separate client cache with no fixture yet | Claude's call, ADR 0007 |
| Packaging | Not part of 1.0: the unit is the `.nbo/` directory (see Distribution). An archive format, signing and provenance are a sketch for after 1.0 | Nothing implements them | Claude's call, ADR 0007 |
| Unimplemented draft features | Reserved (see Reserved for later): the 1.0 schemas reject them, and a minor can make one core | No frozen promise without code; no writer ever produced them, so no stored build breaks | Claude's call, ADR 0007 |
| Framework data requests on prerender routes | `rsc` and `next-router-*` handling (the `vary` and the cache bypass) is core and named as Next's | The reference server does it on every prerender route; it is harmless for other producers | Claude's call, ADR 0007 |

## Reserved for later

These names keep their meaning for a later minor release. The 1.0 schemas reject them and no 1.0 producer writes them; no writer has ever produced any of them, so no stored build is affected.

- Function runtime kinds `edge`, `container` and `python`; `concurrency: "single"`; the function fields `group`, `platform`, `placement`, `scaling`, `env` and `bindings`.
- Route actions `transform` and rewrite `url`; match conditions `has` and `missing`; `error` entries other than `"404": { "file" }` (other statuses, function error pages).
- Static `variants` (precompressed copies).
- Capability ids `route.middleware` and `cron`.
- `routing.cleanUrls: false` and `routing.caseSensitive: false`; cron time zones other than `UTC`.
- Request headers `x-nbo-request-id`, `forwarded` and `x-nbo-geo-*`.
- Packaging, signing and provenance (sketched under Distribution, After 1.0); the control-plane revalidate API; `nbo route test`.

## Sources

- [Build Output Configuration (Vercel Build Output API v3)](https://vercel.com/docs/build-output-api/configuration)
- [Build Output API features (Vercel)](https://vercel.com/docs/build-output-api/v3/features)
- [adapterPath (Next.js)](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath)
- [Adapters API reference (Next.js)](https://nextjs.org/docs/app/api-reference/adapters/api-reference)
- [Adapter output types (Next.js)](https://nextjs.org/docs/app/api-reference/adapters/output-types)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [RE2 syntax](https://github.com/google/re2/wiki/Syntax)
- The producers' code: `packages/producer-static`, `packages/next-adapter`, `packages/writer`; the decisions: `docs/adr/0007-spec-1-0.md`

## Appendix: NBO extensions

NBO's own extensions follow the rules in Capabilities and extensions: each is declared in `requires.extensions`, and its keys are checked by a typed schema. 1.0 has one.

### `x-nbo-ppr` version 1 (critical)

Next.js partial prerendering: a static shell plus a resumed dynamic hole. A build using it declares `{ "id": "x-nbo-ppr", "version": "1", "critical": true }`, so a target that doesn't implement it refuses the plan instead of serving a page with a hole that never fills.

A `prerenderConfig` entry gains `"x-nbo-ppr": { "postponedState": "…" }`, where `postponedState` is Next's own opaque, per-build continuation string (required, not empty). The shell is the route's seed. Such an entry has no freshness window: the Next.js producer writes `revalidateSec: 0`, `expireSec: 0` and `onMiss: "blocking"` because the schema requires the fields, and the platform does not read them for an `x-nbo-ppr` route. An `x-nbo-ppr` route never reads or writes the ISR cache.

**The platform, not the client, resumes the dynamic hole.** Next's own shipped client bundle has no code path for this at all (confirmed directly: the resume request never appears anywhere in it).

- **Document `GET`**: the platform responds at once with status `200` and the shell's raw bytes, and concurrently calls the route's function itself with a `POST` to the same URL (query string included), header `next-resume: 1`, header `x-matched-path` set to the route's path, and the raw `postponedState` string as the body, then streams the function's response body straight after the shell in the same response. The shell's own incomplete streaming markers are exactly completed by the resume response's own continuation script and closing tags.
- **Resume request headers**: the resume carries the visitor's request headers, so `cookies()` and `headers()` in the dynamic hole see the real visitor, minus conditional headers, the original's `content-length`/`content-type` and the platform-only headers below; `accept-encoding` is `identity`, because the bytes follow an uncompressed shell. A visitor disconnecting cancels the resume.
- **Failures**: since the status and the shell are already sent, a failed resume (a non-`200` answer, a thrown call, a body dying partway) can't change the status. The platform logs it and closes the document with `</body></html>`, so the visitor keeps the shell with its fallback (checked in a real browser: the fallback stays, and React logs error 412 to the console). Next doesn't report a bad `postponedState` as a failure at all: it logs, answers `200` with the hole as flight data only, and React renders the hole in the browser. `postponedState` is platform-only, so that is a build fault, not a client error.
- **`redirect()` and `notFound()`** inside a hole are not failures either, and can't change the status: the document stays a `200`, with a `<meta http-equiv="refresh">` to the target for `redirect()` and `<meta name="robots" content="noindex">` for `notFound()`, and Next's client code acts on the error it finds in the stream (it navigates, or shows the not-found page).
- **Resume response headers** (`Set-Cookie` included) are not delivered, because the response's headers went out with the shell.
- **`HEAD`** is answered with the same status and headers from the shell, with no function call. Both the document and the `HEAD` carry `cache-control: private, no-store`, set after any route header rule, because the document can hold one visitor's render, and `vary: rsc, next-router-state-tree, next-router-prefetch`.
- **Client-side navigation** (a `GET` with `rsc: 1`) must get the hole too, and a plain `GET` can't do that: with `minimalMode` on, Next answers it with the static flight data, with the hole left out. So the platform sends the same `POST`, `next-resume: 1` and `x-matched-path`, with an empty body, keeping `rsc`, `next-router-state-tree` and `next-url`, and streams the function's answer back with its status and headers (`Set-Cookie` included) and `cache-control: private, no-store`. An empty body is Next's resume with no postponed state: a whole render for this one request.
- **Draft mode** (see Prerendering and ISR) takes the same request on a `GET`, so an editor gets one finished document; a plain `GET` would get an unfinished shell.
- **Static prefetch** (`rsc: 1` with `next-router-prefetch: 1`) is a plain `GET` to the function, and answers with the shell's flight data. A static prefetch's answer, like any flight data forwarded on an ISR or hole-less route, leaves as `cache-control: private` (a `no-store` from the function stays), without Next's `s-maxage`, so a shared cache that ignores `Vary` can't store flight data at the page's URL.
- **Any other method** (a server action `POST`) is forwarded to the function unchanged.
- `next-action`, `next-router-*`, `next-url`, `rsc` and `x-prerender-revalidate` from the visitor never reach a resume, except the ones listed for a navigation.
- **Platform-only headers**: `next-resume`, `x-matched-path`, `x-next-resume-state-length`, `x-now-route-matches`, `x-nextjs-data`, `x-middleware-rewrite`, `x-middleware-redirect`, `x-middleware-set-cookie`, `x-middleware-skip`, `x-middleware-override-headers` and `x-middleware-next` (Next's own `INTERNAL_HEADERS`) are platform-only: a router or app server must strip them from every incoming client request before any routing decision, since a compiled Next handler trusts them unconditionally once the platform's required `minimalMode` request flag is on.

A route Next marks `PARTIALLY_STATIC` with no real `postponedState` (an ordinary page with no dynamic hole at all; cacheComponents marks every app page this way by default) is not a PPR route and has no `x-nbo-ppr` field. With `initialRevalidate: false` it is served as a plain, long-lived static page (`onMiss: "shell"`, a one-year window); with a number (`"use cache"` with `cacheLife`) it is ordinary ISR with Next's `revalidateSec` and `expireSec`.

Not covered: Partial Prefetching (Next's separate client-side segment-navigation prefetch cache). Next's client falls back to its ordinary prefetch.
