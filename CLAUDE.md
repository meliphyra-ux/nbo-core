# NBO

A self-hosted hosting platform, a bit like Vercel, that deploys the same build to different clouds and can switch a project between them. NBO has no web interface: operators use `nbo-server`, the HTTP API and the Terraform provider.

## Read before working

- `docs/nbo-spec.md`: the Neutral Build Output spec, the contract every producer and adapter follows.
- `docs/context.md`: why things are the way they are, Next.js adapter API facts, the producer design.
- `docs/manual/*.md`: the manual (index in `docs/manual/README.md`), written for readers who know only front-end basics. Update the matching chapter when you change how something works, and the table in `docs/manual/tried.md` when something is proven on real infrastructure.
- `docs/production.md`: how to launch NBO for real sites. Keep it true when launch steps change.
- `docs/architecture/index.html`: the architecture tour and the complete HTTP API reference. Open it in a browser; keep it in step with the code (`pnpm docs:check` compares its API table with `packages/controlplane/src/http/access.ts`).
- `docs/adr/`: decision records.
- `docs/points-to-improve-or-fix.md`: known rough edges.

## Scope

- Frameworks: **Next.js, React single-page apps (Vite), static sites.** Nothing else until a later spec version.
- Clouds: Kubernetes (any IaaS) and Cloud Run. AWS Lambda is deferred.

## Architecture in one paragraph

Compiler model: framework producers write `.nbo/` (cloud-neutral, content-addressed) → `nbo validate` → the control-plane's artifact store (a copy of `.nbo/` per build, by content id) → the planner matches requirements against provider capabilities → a provider adapter applies a provider-specific plan. NBO owns the edge (domains, TLS, routing), so switching clouds is a weighted traffic shift. The control-plane (`packages/controlplane`) is one Node process with one SQLite store, one router and one access table; `nbo-server` (`src/server-cli.ts`) drives its loopback-only setup routes.

## Rules that must not break

- `.nbo/` never contains cloud names, account ids, provider region codes or secret values.
- Route patterns are RE2 only. Lower lookaheads into `pathNot` or fail with the pattern named.
- Digests are sha256 over file bytes; every metadata JSON file is RFC 8785 canonical. Content id = manifest minus its `build` block.
- Producers are deterministic: the same build input always gives the same `.nbo/` and content id. CI builds each fixture twice from the same commit: static and SPA fixtures must give the same content id; Next.js fixtures (same `NBO_BUILD_ID`, same `.next/cache`) must give the same content id or differ only in pages the app rendered at build time (prerender seeds and `x-nbo-ppr.postponedState`), and the check fails on any other difference.
- Functions are keyed by name; URL paths map to functions only in `routes.json`.
- `contentType` is mandatory for every static file.
- Core schemas reject unknown fields; extensions use an `x-` prefix and a `critical` flag.
- Every new behavior gets a conformance fixture with HTTP transcripts, run against `nbo serve` and, where the harness covers that suite, each adapter.
- Every API route has exactly one row in `packages/controlplane/src/http/access.ts`: `public` (only `GET /healthz`), `webhook` (signature checked), `token` (an API token from anywhere, or no token from loopback) or `local` (loopback only, no token).
- `nbo-server` never takes a secret value as a command-line argument: kubeconfigs, keys, tokens and request bodies come from files or stdin.
- Git credentials (tokens, deploy keys' private halves) never appear in an API answer, a build log, an error message or a process list.
- Wire names are fixed for all of 1.x: `.nbo/`, `nbo`, `x-nbo-*`, `/_nbo/`, `NBO_*`, the `nbo.dev/*` labels, the `nbo-*` namespaces and service accounts.

## Repo layout

Everything is TypeScript under `packages/`, except the Terraform provider (Go, ADR 0004) and the edge `packages/edge-rs` (Rust, ADR 0005).

```
spec/                     JSON Schemas + generated TS types, version.json, CHANGELOG.md
packages/writer           @nbo/writer: writes .nbo/ output
packages/producer-static  static sites and React SPAs (--spa fallback)
packages/next-adapter     Next.js adapter via NEXT_ADAPTER_PATH
packages/router           reference router (RE2 matching, redirects, header rules)
packages/cli              nbo CLI: build, validate, serve, deploy, conformance
packages/adapter-k8s      Kubernetes provider adapter
packages/adapter-cloudrun Cloud Run provider adapter
packages/controlplane     control-plane API, build queue, deploys, edge sync; nbo-server
packages/edge             edge: weighted proxy + admin API (Node, the default)
packages/edge-rs          the same edge in Rust, a Cargo crate; `cargo test` there
packages/loadtest         load-test harness (drives a switch under load)
packages/planner          capability matching, provider plan selection
packages/serve            local nbo serve + function hosting (funcproxy, nodehost)
packages/terraform-provider  Terraform provider, the one Go module; `go test ./...` there
fixtures/                 static-site, react-spa, next-app, ppr-app, conformance
docs/                     spec, manual, production guide, architecture page, ADRs
```

## Working agreements

- When implementation shows the spec is wrong or vague, change `docs/nbo-spec.md` in the same change and say so.
- Record decisions as ADRs in `docs/adr/NNNN-title.md`.
- Tests never touch real clouds, real GitHub, Google, Let's Encrypt or DNS; they use the fakes in each package.
- Features that have only run against fakes carry a block quote starting `**Not tried for real yet.**` in the manual, and a row in `docs/manual/tried.md`.
- No em dashes in user-facing text or docs. Plain words for a reader who knows front-end basics.

## Commands

- `pnpm install`: install the workspace.
- `pnpm build` / `pnpm test` / `pnpm lint` / `pnpm check-types`: turbo-orchestrated across packages, run at the repo root. One package: `pnpm --filter @nbo/writer test`.
- `./scripts/verify-step0.sh`: end-to-end gate: produce (twice, determinism check), validate and serve the fixtures.
- `./scripts/bootstrap-local-k8s.sh`: a local `kind` cluster (ingress-nginx, cert-manager, selfsigned issuer; pin `kindest/node:v1.31.4` on hosts running cgroup v1).
- `pnpm docs:check`: checks the docs against the code (links and anchors, repo paths, `NBO_*` settings, the API table and its access column); runs in CI `node-checks`.
- `pnpm test:ci`: tests of the CI scripts (`scripts/ci/__tests__`, fake `gcloud`/`kubectl`/`docker`, no real cloud). `node scripts/ci/check-pipeline.mjs` checks `.gitlab-ci.yml` against the safety rules.
