# Repository map

## How the repository is organised

NBO is a **monorepo**: one Git repository holding many small packages that depend on each other. It uses:

- **pnpm workspaces**: `pnpm-workspace.yaml` lists the package folders. A package can depend on another with `"@nbo/writer": "workspace:*"` in its `package.json`, and pnpm links it locally instead of downloading it.
- **Turborepo** (`turbo.json`): runs `build`, `test`, `lint`, `check-types` in every package, in the right order (a package is built after the packages it depends on), and caches results.
- **TypeScript almost everywhere.** Each package has `src/` (source) and, after `pnpm build`, `dist/` (compiled JavaScript). Other packages and the running programs use `dist/`, so **after changing a back-end package you must rebuild it**. Two packages are not TypeScript: `edge-rs` is Rust (a Cargo crate, built with `cargo`) and `terraform-provider` is Go (its own module, tested with `go test ./...`).

Every TypeScript package name starts with `@nbo/`. Tests live next to the code in `src/__tests__/` (or `*.test.ts`).

## Top-level folders

| Folder                                               | What's in it                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/`                                          | All code. One folder per package; listed below.                                                                                                                                                                                                 |
| `spec/`                                              | JSON Schemas for every `.nbo/` file, TypeScript types generated from them, `version.json` (the spec version the writer stamps into every build) and `CHANGELOG.md`. The validator uses these. See [Builds](./builds.md#the-output-and-spec-10). |
| `fixtures/`                                          | Small sample apps used by tests and verify scripts: `static-site`, `react-spa`, `next-app`, `ppr-app`, plus `fixtures/conformance/` (recorded HTTP request/response pairs every deployment must reproduce).                                     |
| `scripts/`                                           | Shell scripts: `bootstrap-local-k8s.sh` creates the kind cluster; `verify-*.sh` are end-to-end checks, one per feature area.                                                                                                                    |
| `docs/`                                              | The spec (`nbo-spec.md`), decision records (`adr/`), this manual (`manual/`), `production.md` ([Launch NBO on a server](../production.md)), `ci.md` and the HTML architecture page and API reference in `docs/architecture/`.                   |
| `Dockerfile`, `compose.yaml`, `compose.public.yaml`  | One image that runs all of NBO, and the Docker Compose files that start it (the second adds the public address with Caddy). See [Launch NBO on a server](../production.md).                                                                     |
| `.gitlab-ci.yml`                                     | The CI pipeline. See [Tests and code quality](./quality.md).                                                                                                                                                                                    |
| `eslint.config.mjs`, `.prettierrc.json`, `knip.json` | Lint, formatting and unused-code configuration (see [Tests and code quality](./quality.md)).                                                                                                                                                    |

## The packages, grouped by job

### Control and routing (long-running servers)

| Package         | Role                                                                                                                                                                                                                                 | Start reading at                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `controlplane`  | The API server: database, build queue, runner, setup, transfers, edge sync. Also `nbo-server` (`src/server-cli.ts`), the operator's command.                                                                                         | `src/main.ts` → `src/v2.ts` → `wireV2`                           |
| `edge`          | Visitor-facing proxy plus admin API for setting splits. The default edge, in Node.                                                                                                                                                   | `src/main.ts`, `src/proxy.ts`, `src/registry.ts`, `src/admin.ts` |
| `edge-rs`       | The same edge written in Rust (one binary, `nbo-edge`). Opt-in with `NBO_EDGE_IMPL=rust`. A Cargo crate.                                                                                                                             | `src/main.rs`, `src/proxy.rs`, `src/registry.rs`, `src/admin.rs` |
| `isrcache`      | A small cache server for Next.js incremental static regeneration (ISR) pages, shared by all copies of an app.                                                                                                                        | `src/mux.ts`, `src/store.ts`                                     |
| `link-protocol` | The rules a linked core and a hosted dashboard share: the instruction envelope, signing bytes, sealed boxes and the tier of every route. WebCrypto only, so browsers can use it too. See [Linking to a hosted dashboard](./link.md). | `src/index.ts`, `src/tiers.ts`                                   |

### Building: framework output → `.nbo/`

| Package           | Role                                                                                                              | Start reading at             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `writer`          | `NboWriter` class: add static files, functions, routes … then `write()` produces `.nbo/`. Used by both producers. | `src/writer.ts`              |
| `producer-static` | Static sites and SPAs: walks a build folder, adds every file.                                                     | `src/produce.ts` → `produce` |
| `next-adapter`    | Plugs into Next.js's own build (`onBuildComplete`) and writes `.nbo/`.                                            | `src/adapter.js`             |
| `digest`          | Canonical JSON, SHA-256, `contentId`.                                                                             | `src/digest.ts`              |
| `validate`        | Checks a `.nbo/` folder: schemas, digests, RE2 patterns, no secrets.                                              | `src/index.ts` → `validate`  |

### Deploying: `.nbo/` → cloud

| Package            | Role                                                                             | Start reading at                                                      |
| ------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `deploy`           | Generic deploy flow (`deploy`) plus the two targets that glue adapters together. | `src/deploy.ts`, `src/kubernetes-target.ts`, `src/cloudrun-target.ts` |
| `planner`          | Compares what a build needs against what a cloud can do.                         | `src/planner.ts` → `evaluate`                                         |
| `adapter-k8s`      | Builds Docker images, renders Kubernetes YAML, applies it with `kubectl`.        | `src/image.ts`, `src/manifest.ts`, `src/templates.ts`                 |
| `adapter-cloudrun` | Pushes images and runs `gcloud run deploy`.                                      | `src/deploy.ts`, `src/image.ts`, `src/iam.ts`                         |

### Running: inside every deployed container

| Package     | Role                                                                                                                                                    | Start reading at                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `cli`       | The `nbo` command: `serve`, `validate`, `deploy`, `plan`, `conformance`. In a container it runs `nbo serve`.                                            | `src/main.ts`, `src/serve.ts`                |
| `serve`     | The request handler for a deployed app: static files, redirects, functions, ISR, images.                                                                | `src/serve.ts` → `createHandler`, `dispatch` |
| `router`    | Decides what to do with a URL using `routes.json` (six phases, RE2).                                                                                    | `src/router.ts` → `createRouter`             |
| `funcproxy` | Forwards a request to a function (local child process, Kubernetes service or Cloud Run service). Also `host.mjs`, the tiny server that runs a function. | `src/proxy.ts`, `src/host.mjs`               |
| `nodehost`  | Turns a `FetchHandler` into a real Node HTTP server.                                                                                                    | `src/serve-fetch.ts` → `serveFetch`          |
| `nbopath`   | Safe file-path resolution inside `.nbo/static`.                                                                                                         | `src/nbopath.ts`                             |

### Infrastructure as code

| Package              | Role                                                                                                                                                             | Start reading at                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `terraform-provider` | The Terraform provider (Go): projects, variables, deployments, domains and traffic split, driven through the control-plane API. See [Terraform](./terraform.md). | `main.go`, then the `provider` and `client` folders |

### Testing tools

| Package       | Role                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `conformance` | Replays recorded HTTP transcripts against a running app and compares responses.         |
| `loadtest`    | Sends steady traffic while shifting weights, to prove no request fails during a switch. |

### Shared configuration

| Package             | Role                     |
| ------------------- | ------------------------ |
| `eslint-config`     | Shared lint rules.       |
| `typescript-config` | Shared `tsconfig` bases. |

## Where data lives on disk

| What                                 | Where                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All projects, builds, logs, settings | One SQLite file, path from `NBO_CONTROL_PLANE_DB`.                                                                                                                                                                                               |
| Build clones                         | Temporary folders `nbo-build-*` in your system temp folder (`TEMP`/`TMPDIR`), deleted after each build.                                                                                                                                          |
| Docker images                        | Docker's own storage; app images are tagged `nbo-app-<app>:<id>-b<hash>`, functions `nbo-fn-<app>-<name>:<time>`.                                                                                                                                |
| Kubernetes objects                   | Inside the kind cluster (a Docker container named `nbo-local-control-plane`).                                                                                                                                                                    |
| Cloud Run services and images        | Your Google Cloud project: Cloud Run services and the `nbo` Artifact Registry repository.                                                                                                                                                        |
| Edge traffic table                   | In dev mode, only in the edge's memory: lost when the edge restarts, and the control-plane pushes it back (see [Traffic](./traffic.md)). In production the cluster edge reads it from a ConfigMap the control-plane writes.                      |
| Secret key and stored build output   | The secret key file (`NBO_SECRET_KEY_FILE`, `nbo-secret.key` next to the database) and the build artifact store (`NBO_ARTIFACTS_DIR`, `artifacts/` next to the database). In the Docker image both are on the `nbo-keys` and `nbo-data` volumes. |
