# Project context: how we got here

Summary of the planning conversation (claude.ai, 2026-10-22) that produced `nbo-spec.md` and the first build plan. Read this for the _why_; the spec holds the _what_.

## Goal

A hosting platform like Vercel that supports most of Vercel's functionality and lets a project switch between cloud providers.

## Decisions and status

| Item                                                                                                                                | Status                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| v1 scope: Next.js, React single-page apps and static sites only                                                                     | **Decided** by the owner                                                                          |
| Build in vertical slices; spec 1.0 only after Next.js passes on all three targets                                                   | **Accepted** plan                                                                                 |
| "React" means client-side SPAs (e.g. Vite). Server-rendered React goes through Next.js; React Router framework mode is out of scope | **Assumption** — confirm with the owner before building SPA-specific features beyond the fallback |
| What "switch" means in v1 (proposed: target per environment + planned migration, no active-active)                                  | **Proposed** — goes into the Step 0 ADR                                                           |
| Targets in order: Kubernetes → Cloud Run → Lambda                                                                                   | **Proposed** — Step 0 ADR                                                                         |
| Languages: TypeScript for producers and writer; Go for control plane, router, adapters                                              | **Proposed** — Step 0 ADR                                                                         |
| Product name; `.nbo/` is a placeholder                                                                                              | **Open**                                                                                          |
| The rest of the open decisions                                                                                                      | See the table at the end of `nbo-spec.md`                                                         |

Current status: Step 0 not started.

## Architecture rationale

The central move: stop thinking "support AWS, GCP, Azure" and define the platform's own primitives, with each cloud as one interchangeable backend. It is a compiler model: frameworks are frontends, NBO is the IR, clouds are backends.

1. **Neutral build output (NBO).** Frameworks compile to one cloud-neutral directory. Artifacts are immutable and content-addressed, so the same artifact deploys anywhere and rollback is a pointer move.
2. **One function runtime contract.** Fetch-style `(Request) => Response` handlers with a thin shim per provider. Containers for long-running work.
3. **Provider adapters as plugins with capability declarations.** Each adapter implements a versioned interface and declares capabilities and limits. The planner matches a build's requirements before deploying. A conformance suite runs the same reference apps against every adapter in CI, so "supports X" can't rot.
4. **Substrate strategy.** Kubernetes (with scale-to-zero later) is the portable baseline that runs on any IaaS; native serverless adapters (Cloud Run, Lambda) come as optimizations.
5. **Own the edge.** Domains, DNS, TLS (ACME via cert-manager, not provider-managed certs) and routing stay out of any single cloud. Switching clouds then becomes a weighted traffic shift at the platform's router.
6. **Control plane / data plane split.** The control plane holds desired state; pull-based agents per cloud or region reconcile it. This also enables BYOC (customers' own cloud accounts) later. Deploys and migrations are durable workflows (Temporal) with compensation per step.
7. **Identity and secrets.** The control plane acts as an OIDC issuer with workload identity federation on each cloud, so there are no long-lived cloud keys. Secrets live in the platform's own store.
8. **Data via open protocols.** S3 API, Postgres wire protocol, Redis/Valkey protocol — never DynamoDB/Firestore/Cosmos-style services. Data gravity is the real lock-in. Observability goes through OpenTelemetry to the platform's own sink.

Pitfalls to plan for: cross-cloud egress costs, the lowest-common-denominator trap, a fast-growing test matrix, and provider limits that differ (timeouts, payload sizes, cold starts).

## Producing NBO

Put shared logic in one writer library (`@nbo/writer`); each producer is then a thin mapping.

1. **Hook the build** through the official extension point (Next's `NEXT_ADAPTER_PATH`; a build folder for static and SPA). The build service sets env vars, so users never touch their config.
2. **Build an in-memory model first**, then write files.
3. **Static files:** sha256, content type from the extension (never sniff), `immutable` for hashed names, precompressed `.br` and `.gz`.
4. **Functions:** copy traced deps into `bundle/`, generate a Fetch entry shim, detect `.node` binaries for `platform`, write `bundle.index.json`. The bundle digest is the sha256 of that index.
5. **Routes:** translate framework phases into NBO phases; run every pattern through an RE2 compile check; lower lookaheads into `pathNot` or fail with the pattern named.
6. **Derive `requires` from the model**, never from a hand-written list.
7. **Write deterministically, manifest last:** canonical JSON (RFC 8785), sorted lists, fixed tar mtimes. CI builds the same commit twice and asserts identical content ids.

### Next.js adapter API facts (checked 2026-10-22)

- `adapterPath` was stabilized in Next.js v16.2.0 (moved out of `experimental`). `NEXT_ADAPTER_PATH` enables zero-config use on platforms.
- Next.js 15.5 has an earlier `experimental.adapterPath` (no environment variable, a flat `outputs` array, no `routing`), and Next.js 14 has none (checked 2026-11-19), so 14 and 15 go through `packages/next-adapter/src/legacy.js`, which reads `.next/` after the build and runs Next's own server as one function (manual, Builds → Next 14 and 15).
- Hooks: `modifyConfig(config, ctx)` and `onBuildComplete(ctx)`.
- `onBuildComplete` context: `routing` (`beforeMiddleware`, `middlewareMatchers`, `beforeFiles`, `afterFiles`, `dynamicRoutes`, `onMatch`, `fallback`, `shouldNormalizeNextData`, `rsc`), `outputs`, `projectDir`, `repoRoot`, `distDir`, `config`, `nextVersion`, `buildId`.
- `outputs`: `pages`, `pagesApi`, `appPages`, `appRoutes`, `prerenders`, `staticFiles`, `middleware`. With `output: 'export'` only `staticFiles` is populated.
- Route outputs carry `id`, `filePath`, `pathname`, `runtime` (`nodejs` | `edge`), `assets` (traced deps), `assetsHashes`, `config.maxDuration`. Next now marks the Edge Runtime deprecated.
- Prerenders carry `route`, `groupId`, `fallback` (`filePath`, `initialRevalidate`, `initialExpiration`, `postponedState`) and `config` (`allowQuery`, `allowHeader`, `bypassToken`, `renderingMode: 'STATIC' | 'PARTIALLY_STATIC'`).
- Static files carry `immutableHash` when the filename contains a content hash.
- Middleware (`middleware.ts` or `proxy.ts`) carries `config.matchers` with `sourceRegex`, `has`, `missing`.
- Next ships an adapter test harness (deploy/logs/cleanup scripts via `NEXT_TEST_DEPLOY_SCRIPT_PATH` and friends) and `@next/routing` for route-matching semantics.

### Next.js → NBO mapping

| Next.js output                                         | NBO                                                                                                                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputs.staticFiles`                                  | `static.index.json`; `immutable` when `immutableHash` is set                                                                                                                                          |
| `appPages`, `appRoutes`, `pages`, `pagesApi` (Node.js) | One `ssr` function grouping all routes; `maxDuration` taken as the max                                                                                                                                |
| Outputs with `runtime: 'edge'`                         | `edge` functions (expect few)                                                                                                                                                                         |
| `outputs.middleware` + `config.matchers`               | Middleware function plus one `beforeFiles` rule per matcher, `sourceRegex` checked against RE2                                                                                                        |
| `outputs.prerenders`                                   | `prerender.json` entries: `fallback.filePath` → seed; `initialRevalidate`/`initialExpiration` → `revalidateSec`/`expireSec`; `allowQuery`/`allowHeader` → cache key; `PARTIALLY_STATIC` → `x-nbo-ppr` |
| `routing.beforeMiddleware` + `beforeFiles`             | `beforeFiles`, with redirects and headers ordered before the middleware rule                                                                                                                          |
| `routing.afterFiles` + `dynamicRoutes`                 | `afterFiles`                                                                                                                                                                                          |
| `routing.onMatch`, `routing.fallback`                  | `onMatch`, `fallback`                                                                                                                                                                                 |
| `routing.rsc`                                          | `has` header conditions so `.rsc` requests reach the right output                                                                                                                                     |

### Adapter skeleton (shape, not drop-in code — `@nbo/writer` doesn't exist yet)

```js
// nbo-next-adapter.mjs — used via NEXT_ADAPTER_PATH
import { NboWriter, translateNextRouting, fromNextImages } from "@nbo/writer";

export default {
  name: "nbo",
  async onBuildComplete({ outputs, routing, config, nextVersion }) {
    const nbo = new NboWriter({ outDir: ".nbo", framework: { name: "nextjs", version: nextVersion } });

    for (const f of outputs.staticFiles)
      nbo.addStatic(f.pathname, f.filePath, { cache: f.immutableHash ? "immutable" : "revalidate" });

    const ssr = nbo.addFunction("ssr", { runtime: { kind: "node", version: ">=20" }, concurrency: "multi" });
    for (const r of [...outputs.appPages, ...outputs.appRoutes, ...outputs.pages, ...outputs.pagesApi]) {
      ssr.addRoute(r.id, r.pathname, r.filePath); // dispatch table for the entry shim
      ssr.addFiles(r.assets); // traced deps, repo-relative → absolute
      ssr.raiseMaxDuration(r.config.maxDuration);
    }

    if (outputs.middleware) nbo.addMiddleware(outputs.middleware, routing.middlewareMatchers);

    for (const p of outputs.prerenders)
      nbo.addPrerender({
        path: p.pathname,
        route: p.route,
        function: "ssr",
        revalidateSec: p.fallback?.initialRevalidate,
        expireSec: p.fallback?.initialExpiration,
        seedFile: p.fallback?.filePath,
        allowQuery: p.config.allowQuery,
        varyHeaders: p.config.allowHeader,
        tags: [`group:${p.groupId}`],
        ppr: p.config.renderingMode === "PARTIALLY_STATIC" ? p.fallback?.postponedState : undefined,
      });

    nbo.setRoutes(translateNextRouting(routing));
    if (config.images) nbo.setImages(fromNextImages(config.images));
    await nbo.write(); // hash, index, manifest last, then validate
  },
};
```

### Gotchas

- **Bypass token:** Next generates `bypassToken` per build, and its server uses the same value at runtime. That clashes with "no secrets in the output", so treat it as a build-scoped secret: keep it out of the JSON files, keep artifacts private, rotate per build.
- **The entry shim is the hard part:** dispatching to Next's built route modules (streaming, RSC requests, `waitUntil`) must follow Next's "Invoking Entrypoints" and "Runtime Integration" adapter docs. Validate with Next's adapter test harness.
- **Regexes:** Next-generated patterns and Vercel `src` regexes can contain lookaheads; RE2 can't run them.

## Sources

- [Next.js adapterPath](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath)
- [Next.js adapters API reference](https://nextjs.org/docs/app/api-reference/adapters/api-reference)
- [Next.js adapter output types](https://nextjs.org/docs/app/api-reference/adapters/output-types)
- [Vercel Build Output Configuration](https://vercel.com/docs/build-output-api/configuration)
- Original claude.ai draft of the spec: [NBO spec](https://claude.ai/artifact/B6DpBu2JLdBQiHc5x46ztF)
