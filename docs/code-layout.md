# Code layout

How the code is laid out, so a file is quick to find, quick to understand and safe to change. The rule below covers core (`packages/`).

## The rule

- Every TypeScript package keeps its source in `src/` and its tests in `src/__tests__/` (or `src/<folder>/__tests__/` for a feature folder). Modules are named in kebab-case; React components in PascalCase.
- A package's `src/` stays flat until about 25 modules. Past that, modules are grouped into folders by feature (what they are about), never by kind (`utils/`, `types/`).
- A test that covers one folder lives in that folder's `__tests__/`. A test that crosses folders, and the helpers and fixtures shared by several folders, stay in `src/__tests__/`.
- Entry points stay at the top of `src/` and at their `dist/` paths: the Dockerfile, Compose, scripts and docs call them.
- A new module goes into the folder it is about. A folder gets a one-line entry in this file.

## `packages/controlplane/src`

The files at the top are the entry points and the wiring: `main.ts` (the server), `server-cli.ts` (`nbo-server`), `index.ts` (the package's exports), `v2.ts` (wires everything the routes and loops need), `testing.ts` (fakes shared with other packages' tests) and `mode.ts` (`NBO_MODE`).

| Folder       | What it is about                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builds/`    | A build from queue to stored output: the queue, the runner, the process runner, build details and logs, the artifact store, the build routes.     |
| `clouds/`    | Connecting and preparing clouds: Kubernetes and Google connections, bootstrap, regions, Hetzner detection, cloud setup and teardown.              |
| `deploys/`   | Putting a build on a cloud: deploy, project setup and import, transfers between clouds, cron jobs and the scheduler.                              |
| `domains/`   | Hosts, custom domains, DNS and Cloudflare checks, certificates (ordering, renewal, storage), Cloud Run domain mappings, the domain routes.        |
| `edge/`      | The public edge and relays: install, jobs, manifests, the route table and the sync that pushes splits and settings.                               |
| `git/`       | How core reaches a repository: project git settings, credentials, host keys, last seen heads, `ls-remote`, the poller, webhooks, the legacy path. |
| `http/`      | The HTTP layer: router, handlers, the access table and token gate, API tokens, the public URL, the v2 routes, the Terraform provider download.    |
| `insights/`  | Speed Insights: the drain from the edge and the histograms.                                                                                       |
| `link/`      | The link to a hosted platform: enrolment, verification, dispatch, tiers, the client and its transport.                                            |
| `stages/`    | Environments (stages): the model, routes, ephemeral expiry, and revalidation of a stage's ISR pages.                                              |
| `store/`     | SQLite: the store, migrations, sealed secrets, server settings and the shared store errors.                                                       |
| `variables/` | Environment variables: the store views, routes, values supplied per deploy, and the revalidation secret that rides the variable snapshot.         |

## Split modules

Large files were split by responsibility; each new file starts with a one-line comment saying what it holds. Entry points and importers did not change. Where a closure's state had to be shared, it moved onto one object made per instance (a loop, a client, a build job), so each instance still has its own.

| Was                                  | Now                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controlplane/src/domains/certs.ts`  | `certs.ts` is the domain loop (`createDomainLoop`). `cert-acme.ts` (Let's Encrypt client, challenge store, Secret writer, edge probe), `cert-policy.ts` (timings, messages, ephemeral cap, error cleaning), `cert-loop-ctx.ts` (deps and the loop's shared state), `cert-issue.ts`, `cert-warnings.ts`, `cert-mapped.ts`. |
| `controlplane/src/store/store.ts`    | `store.ts` is `createStore`. `store-types.ts` (row types and the `Store` interface), `store-rows.ts` (ids, base schema, row shapes), `store-projects.ts`, `store-environments.ts`, `store-deployments.ts` (methods by table group).                                                                                       |
| `controlplane/src/http/v2-routes.ts` | `v2-routes.ts` registers the groups. `project-summary.ts` (the summary view), `v2-project-routes.ts`, `v2-traffic-routes.ts`, `v2-lifecycle-routes.ts`, `v2-route-util.ts`.                                                                                                                                               |
| `controlplane/src/builds/runner.ts`  | `runner.ts` is `createRunner` (clone, build, produce). `runner-job.ts` (options and one job's log, redaction and timeline), `runner-deploy.ts`, `runner-promote.ts`, `runner-helpers.ts`.                                                                                                                                 |
| `controlplane/src/link/client.ts`    | `client.ts` is `startLinkClient` (the loop). `client-ctx.ts` (types and shared state), `client-live.ts` (messages), `client-sessions.ts` (WebSocket and long-poll), `client-reply.ts` (`sendReply`).                                                                                                                      |
| `controlplane/src/server-cli.ts`     | Stays the entry (`dist/server-cli.js`) and dispatches to `cli/`: `args.ts`, `context.ts`, `setup-commands.ts`, `project-commands.ts`, `admin-commands.ts`.                                                                                                                                                                |
| `serve/src/prerender.ts`             | `prerender.ts` is `handlePrerender` and `handleRevalidate`. `prerender-cache.ts` (cache client and keys), `prerender-request.ts` (render requests, router headers), `prerender-ppr.ts` (partial prerendering).                                                                                                            |

## Tool ignores

Everything the tools skip, with the reason. An entry here needs a reason; a new ignore without one doesn't go in.

### `.prettierignore`

| Entry                                                         | Why                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `node_modules`, `dist`, `coverage`, `.turbo`, `.next`, `.nbo` | Installed, built or generated output.                                                      |
| `pnpm-lock.yaml`, `**/pnpm-lock.yaml`                         | Written by pnpm.                                                                           |
| `spec/generated`                                              | Generated from the JSON Schemas.                                                           |
| `fixtures`, `fixtures/*/next-env.d.ts`                        | Test inputs: real Next.js and Vite apps with their own style; content ids must not change. |
| Planning history and tool state folders                       | History and tool state: never reformatted.                                                 |
| `*.log`                                                       | Logs.                                                                                      |
| Local credential files and folders                            | May hold a token or App credentials: never read or formatted.                              |
| `packages/edge-rs/target`, `**/*.go`, `**/*.rs`               | Rust and Go have their own formatters (`cargo fmt`, `gofmt`).                              |
| `packages/edge-rs/assets`                                     | Byte-compared by the Rust edge tests and embedded in the binary.                           |
| `packages/edge-rs/tests/golden`                               | Golden files compared byte for byte.                                                       |
| `docs/architecture/index.html`                                | Hand laid out tour; `scripts/docs/check-docs.mjs` reads its API table by text.             |

### `eslint.config.mjs`

| Entry                        | Why                                                          |
| ---------------------------- | ------------------------------------------------------------ |
| `spec/generated/**`          | Generated.                                                   |
| `fixtures/**`                | Test inputs with their own configs.                          |
| `packages/edge-rs/assets/**` | A minified browser bundle (web-vitals) served byte for byte. |

### `knip.json`

| Entry                                                                          | Why                                                                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `fixtures/**`                                                                  | Test inputs.                                                                                    |
| `packages/edge-rs/assets/web-vitals.iife.js`                                   | Vendored bundle included by the Rust edge (`include_str!`) and checked by a vendored-copy test. |
| `scripts/ci/nbo-diff.mjs`                                                      | Called by `determinism-next.sh` and tests, not imported.                                        |
| `@nbo/next-adapter` (dependency), entry `packages/next-adapter/src/adapter.js` | Loaded by path through `NEXT_ADAPTER_PATH` and `createRequire`, never imported.                 |
| `canonicalize` (dependency)                                                    | Used by tests across packages, resolved from the root.                                          |
| `openssl`, `ssh-keygen`, `glab` (binaries)                                     | Real system tools that scripts and the core call.                                               |
| `rules.types: off`, `ignoreExportsUsedInFile`                                  | Exported types are the packages' public surface; an export used in its own file stays.          |

## Moving a file

Use `git mv` and fix the imports in the same commit, with nothing else, so git sees a rename. Then grep for the file's name in `docs/`, `scripts/`, `Dockerfile`, `compose*.yaml`, `CLAUDE.md` and the manual, and update the hits. `pnpm docs:check` checks the repo paths the docs name.
