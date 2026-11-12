# The control-plane

The server behind NBO's API. It owns all state, runs all background work, and is the only thing that talks to the clouds and the edge. **Package:** `packages/controlplane`.

## Startup: `main.ts`

**File:** `src/main.ts` → `main()`, in this order:

1. Reads `NBO_CONTROL_PLANE_DB`; stops with an error if it's missing.
2. `createStore(dbPath)` (`store.ts`): opens SQLite with Node's built-in `node:sqlite`, creates missing tables, then `migrate(db)` (`migrate.ts`) adds any columns newer versions need. Old databases upgrade in place.
3. Builds the **deployment trigger**: a small object whose `triggerDeploy` calls `triggerDeploy(...)` in `deploy.ts`. Tests swap in a fake (`fakeDeploymentTrigger` in `testing.ts`) so they never touch a real cloud.
4. `recoverInterruptedWork(store)` (`v2.ts`): builds left `running`, setups left `provisioning`, and transfers left in progress by a previous run are marked failed / needs-setup with "interrupted: the control-plane restarted…". Background work lives only in memory, so it can't resume.
5. `resolveEdgeConfig(env)`: edge admin URL and public port.
6. `wireV2(store, …)` (`v2.ts`): creates and connects the modules below.
7. `createMux(...)` (`handlers.ts`): the HTTP router with every route.
8. Starts background loops: the cron scheduler `run(...)` (`scheduler.ts`) and `runPoller(...)` (`poller.ts`).
9. `serveFetch(mux, { host, port })`: listens on `127.0.0.1:8081`.

## The modules and how they connect

`wireV2` builds them in dependency order:

```
store
 |-- edgeSync        push splits to the edge
 |-- runner          uses deploymentTrigger; after each deploy
 |                   calls edgeSync.onDeployed
 |-- queue           runs runner.runBuild
 |-- setup           uses cloudSetup and queue
 |-- transfers       uses setup, queue and edgeSync
 `-- cloudTeardown   deletes a project's cloud resources
```

| Module         | File                                                      | Job                                                                                             |
| -------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Store          | `store.ts`, `git.ts`, `cron.ts`                           | Every read/write to SQLite. Nothing else runs SQL.                                              |
| Migrations     | `migrate.ts`                                              | Adds new columns and the `transfers` table to older databases.                                  |
| Build queue    | `build-queue.ts`                                          | One running + one waiting build per project. `enqueue`, `idle(projectId)` (wait until free).    |
| Runner         | `runner.ts`                                               | Clone, build, produce, deploy to each environment, log.                                         |
| Deploy         | `deploy.ts`                                               | One environment: pick target, call `@nbo/deploy`, record the deployment.                        |
| Cloud setup    | `cloud-setup.ts`                                          | `preflight()` (Docker, kind, gcloud status; cached 15 s) and `ensureCloudRun(project, region)`. |
| Setup          | `setup.ts`                                                | Import: create project, environments, find HEAD, queue the first build. `retry`, `addCloud`.    |
| Edge sync      | `edge-sync.ts`                                            | Push splits to the edge; `reconcile` all projects.                                              |
| Transfers      | `transfer.ts`                                             | Stepped cloud-to-cloud moves.                                                                   |
| Poller         | `poller.ts`                                               | Every 45 s: `git ls-remote` per project, queue new commits, `edgeSync.reconcile()`.             |
| Scheduler      | `scheduler.ts`, `cron.ts`                                 | Every 30 s: fire due cron jobs, signed.                                                         |
| Teardown       | `cloud-teardown.ts`                                       | Delete Kubernetes objects / Cloud Run services of a deleted project.                            |
| Git helpers    | `gitremote.ts`                                            | `lsRemoteHead`, `isHttpsGitUrl`, `repoSlug`, non-interactive `gitEnv`.                          |
| Command runner | `run.ts`                                                  | Spawns processes with output streaming, timeouts and whole-tree kill.                           |
| HTTP           | `router.ts`, `handlers.ts`, `v2-routes.ts`, `webhooks.ts` | Routes, JSON helpers, error mapping, request guard.                                             |

## The database

One SQLite file. Tables (columns added by `migrate.ts` included):

### `projects`

| Column                        | Meaning                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `id`                          | `proj_` + 16 hex                                          |
| `name`                        | unique, lowercase, used in the edge host                  |
| `edge_host`                   | `<name>.127.0.0.1.sslip.io`                               |
| `polling_enabled`             | auto-deploy on (1) / off (0)                              |
| `speed_insights`              | Speed Insights off (0, default) / on (1)                  |
| `speed_insights_inject`       | insert the script automatically (1, default) / manual (0) |
| `speed_insights_sample`       | share of page views that report: 100, 50, 25 or 10        |
| `last_seen_sha`               | newest commit the poller has seen                         |
| `setup_status`, `setup_error` | `provisioning` / `ready` / `needs-setup`, and why         |
| `created_at`                  | ISO timestamp                                             |

### Speed Insights data

Core stores none. The edge collects Web Vitals in memory and a **drain loop** (`insights/drain.ts`) can pull them: it calls the edge's `GET /insights/drain` every 60 seconds, validates each batch, finds the project by host and the build by content id (falling back to the cloud's live build), merges them by adding bucket counts into hourly rows (`VitalsRow`) and hands the rows to an `InsightsSink` (`write(rows)`). A sink that throws loses that batch; the next tick runs. `main` starts the loop only when an embedding product passes a sink, and core has none, so on its own nothing drains the edge and it keeps at most 100,000 histograms in memory, dropping the oldest. The `speed_insights*` settings above, the script injection and the beacon endpoints stay in core, so a site with Speed Insights on keeps serving. A database from an earlier NBO keeps its `vitals` table untouched.

### `project_git_config`

`project_id` + `config`, where `config` is a JSON object: `repo`, `productionBranch`, `framework` (`nextjs` / `static`), `buildCommand`, `outputDir`, `spa`, `ignoredBuildStepCommand`, `rootDirectory`.

### `kube_connections`

One row per connected Kubernetes cluster: `id` (`kc_` + hex), `name` (unique), `config` (server and registry, plain), `secret` (kubeconfig and registry password, encrypted), `status`, `last_checked`, `last_error`, `created_at`. Google keeps its single row in `connections`.

**Migration.** Before several clusters, the Kubernetes connection was a row in `connections` (`kind = 'kubernetes'`). On start, `migrateKubernetesConnections` moves it in one transaction to `kube_connections` as id `kc_default`, name `default`, copies the encrypted secret unchanged (no key needed), adds `clusterId: "kc_default"` to every Kubernetes environment, and deletes the old row. Running it again does nothing. If `kc_default` or the name `default` is already taken, it logs a message to the control-plane's error output on every start and keeps the old row, so no credentials are lost.

### `environments`

| Column               | Meaning                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `id`                 | `env_` + hex                                                                                     |
| `project_id`, `name` | `cloudrun`, `k8s`, `k8s-<cluster>`; unique                                                       |
| `target`             | `kubernetes` or `cloudrun`                                                                       |
| `config`             | JSON: Cloud Run `project`, `region`, `arRepo`; production Kubernetes `clusterId`; `cronsEnabled` |
| `traffic_weight`     | 0–100                                                                                            |
| `archived`           | 1 = hidden, no longer deployed to                                                                |
| `auto_deploy`        | 1 (default) = new commits' builds deploy here; 0 = they don't                                    |

### `builds`, `deployments`, `transfers`

- `builds`: `kind` (`build` or `promote`), and for promote jobs `source_build_id` and `target_environment_id`; `note` holds an informational outcome that is not an error (for example, built but no cloud takes new commits automatically). Columns for the build page (`commit_info`, `input`, `timeline`, `output_summary`, `content_id`, `artifact`) were added by migration and are null for older builds. The stored output lives under `NBO_ARTIFACTS_DIR` (default: `artifacts/` next to the database). Retention keeps the newest 20 successful builds plus every live build. A build is live on a cloud when the cloud's newest successful deployment names it in `build_id` (older rows: the build that lists that deployment in its deployment ids, then the newest build with the same `content_id`). A running promote also holds its source build's output until it finishes. See [Builds](./builds.md#the-build-record).
- `deployments`: `environment_id`, `build_id` (the build whose output this deployment ran; empty on older rows), `content_id`, `status`, `url`, `error`, `created_at`. One per build per environment.
- `transfers`: `project_id`, `from_env_id`, `to_env_id`, `status`, `weight` (last step reached), `error`.

### Environments (stages)

The API calls this manual's environments **stages**, because `environments` already names a cloud a project runs on. `stages`: `id` (`stg_` + 16 hex), `project_id`, `name`, `kind` (`production`, `preview`, `development`, `custom`, `ephemeral`), `branch` (custom and ephemeral only), `auto_deploy`, `host` (custom and ephemeral only; Production's stays in `projects.edge_host`), `last_seen_sha`, `created_at`; unique per project and name. `createProject` makes the three built-in rows, and the database upgrade makes them for old projects. `environments`, `builds` and `domains` have a `stage_id`; old rows are backfilled to Production. `listEnvironments(projectId)` with no options returns Production's cloud rows only, so a staging cloud can never join Production's split or a transfer; callers that must see every row say `allStages: true`.

Routes: `GET` / `POST /projects/{id}/stages`, `PATCH` / `DELETE /projects/{id}/stages/{stageId}` (custom only; API tokens may use them). `POST /projects/{id}/environments/add`, `POST /projects/{id}/builds`, `GET` / `PUT /projects/{id}/traffic` and `POST /projects/{id}/domains` take an optional `stage` (a name, default `production`). Transfers stay Production only (409 otherwise). `GET /projects/{id}/summary` gains `stages`; its `environments`, `productionBuild` and `domainUrl` keep meaning Production. See [Environments](./environments.md).

### Environment variables

`env_vars`: `project_id` (empty for workspace-wide variables), `stage` (an environment name, or `*` for all; old rows are `production`), `name`, `value` (only secret values are encrypted with the secret key file; plain values are stored as text), `secret` (0/1), `has_value` (0 when NBO keeps names only), `updated_at`; unique per scope, stage and name. Names are `A-Z`, digits and `_` (not starting with a digit), up to 256 characters; values up to 64 KiB. `NBO_*`, `PORT`, `K_SERVICE`, `K_REVISION`, `K_CONFIGURATION` and `NEXT_ADAPTER_PATH` are reserved. A secret can't be empty. API responses never include a secret's value.

Routes: `GET /workspace/env`, `PUT` / `DELETE /workspace/env/{name}`, and the same under `/projects/{id}/env`; `PUT`, `DELETE` and `GET .../env/fingerprint` take `?stage=` (default `production`). Changes apply on the next deploy. `GET /workspace/settings` returns `{ storeEnvValues }`; `PATCH /system/workspace-settings` with `{ storeEnvValues: false, confirm: "delete values" }` turns on [names only](./environments.md#dont-store-variable-values), which blanks every value, redacts them from old logs and VACUUMs the database (dashboard only, tokens get 403). With names only, `PUT` takes `{ secret }` and no value, and the deploy routes (`POST /projects/{id}/builds`, `POST /builds/{id}/deploy`, `POST /projects/{id}/transfer`) take `values`.

### Secrets and crons

- `project_webhook_secrets`: per-project secret for GitHub webhook signatures.
- `environment_cron_secrets`: per-environment signing secret, passed to apps as `NBO_CRON_SIGNING_SECRET`.
- `crons`: one row per scheduled job per environment, with `config`, `next_run`, `last_run`, `running`.

The webhook and cron secrets above are stored as plain text. Cloud credentials, secret variables, certificate keys, git tokens, deploy keys and an older GitHub App's keys are different: they are encrypted with the key in the secret key file (`NBO_SECRET_KEY_FILE`) before they reach the database.

### Cloud connections and the edge

- `connections`: the Google connection (one row, `kind = 'google'`): `config` in plain text, `secret` encrypted, `status`, `last_checked`, `last_error`. Older databases also kept the Kubernetes connection here (see `kube_connections` above).
- `relays`: one row per cluster that has a relay to the public edge: `cluster_id`, `address`, the pinned private CA (`ca_pem`), an encrypted `secret` and `status`.
- `server_settings` (called `platform_settings` before the core split; an older database is renamed on open): key and value pairs for workspace settings, such as the base domain, the Let's Encrypt email and the names-only switch.
- `domains`: custom and default hosts: `project_id`, `host`, `kind`, `status`, the certificate's `cert_not_after`, retry state (`next_attempt_at`, `failures`), `behind_cloudflare`, `cert_source`, and for Cloud Run domain mappings `serving` and the `mapping_*` columns. See [Domains and the public edge](./domains.md).
- `domain_pending_certs` and `domain_pasted_certs`: a certificate being ordered, and an Origin CA certificate pasted for a Cloudflare domain. Both are keyed by domain id and the value is encrypted.

### Ephemeral environments and cache

- `stages` is above; an ephemeral one also has `expires_at`, `label`, `removal_status`, `removal_attempts`, `next_attempt_at` and `removal_error` (`stage-expiry.ts` reads and writes them).
- `preview_cert_orders`: when NBO ordered each ephemeral environment's certificate, to stay under Let's Encrypt's weekly limit (`ephemeral-certs.ts`; the table keeps the name earlier versions gave it).
- A database from an earlier NBO may also hold `preview_settings`, `previews` and `preview_branch_heads`. NBO reads `previews` and `preview_settings` once, when it turns those previews into ephemeral environments, and never changes or creates these tables; deleting a project deletes its rows from them.
- `stage_revalidate_tokens`: the secret that lets your code revalidate an environment's cached pages (see [Page cache and revalidation](./cache.md)).

### Git access

- `project_git_credentials`: how NBO reaches each project's repository (`src/git-credentials.ts`). One row per project: `kind` (`token` or `deploy-key`), the token or the deploy key's private half encrypted in `sealed`, the deploy key's `public_key`, the token's `username`. No row means a public repository. The API shows the kind, the public key and the user name, never `sealed`.

A database from an NBO that had its own GitHub App also holds `github_installations`, `github_deliveries` and `github_states`. NBO leaves them as they are and never reads them; a new database does not have them. Projects linked to that app keep building: `src/github-legacy.ts` reads the app's id and its encrypted private key from `server_settings` and asks GitHub for a read-only token for the one repository. That path is kept only until the project moves to a deploy key or token.

### Tokens

- `api_tokens`: named API tokens. Only a hash and the first characters are stored, never the token. `user_id` and `role` are what an older NBO with sign-in wrote; NBO now writes `''` and `admin`, and refuses a token whose role is `viewer` or `developer`.

A database from an NBO that had sign-in on also holds `users`, `user_identities`, `sessions`, `invites`, `sign_in_rules`, `oauth_states`, `sign_in_links` and `audit_events`. NBO leaves them and their rows as they are and never reads them; a new database does not have them.

## The HTTP API

All JSON. Errors are `{ "error": "message" }` with a fitting status: 400 (invalid input), 404 (not found), 409 (name taken / conflicting action), 502 (a cloud or the edge failed).

### Request guard

Every route has one row in `access.ts`: `public` (only `GET /healthz`, any caller), `webhook` (the handler checks the signature; loopback or `NBO_PUBLIC_URL`'s address), `token` (an API token from anywhere, or no token from loopback) or `local` (loopback without a token; every `/system/*` route and the two legacy routes). `createMux` (`handlers.ts`) refuses a route with no row, then runs `guardRequest` (`api-tokens.ts`). Without a token, `isAllowedRequest` rejects any request whose `Host` isn't `localhost` / `127.0.0.1` / `[::1]`, or whose `Origin` (if sent) isn't a loopback `http://` origin. This stops a malicious website open in your browser from calling the API (cross-site requests and DNS-rebinding tricks).

### The main routes

The complete list, with who may call each one, is the API table in `docs/architecture/index.html`. `nbo-server` (`src/server-cli.ts`) is a thin command over these routes for the server's operator.

| Method and path                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                            | Liveness: `{"ok":true}`. The one route that needs no token from any Host, for Compose and load balancers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /system/preflight`                                   | Docker / gcloud readiness, plus Kubernetes: a `summary` and a `clusters` list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /system/connections`                                 | Google, plus a list of Kubernetes clusters (never secrets).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /system/connections/kubernetes`                     | Connect a new cluster (`name` required).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PUT` / `DELETE /system/connections/kubernetes/{id}`      | Replace one cluster's credentials (name cannot change) / disconnect it (409 while used).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /system/connections/kubernetes/{id}/test`           | Re-check one cluster.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /projects/setup`                                    | Create a project from a repository and its clouds, then provision and build in the background (`nbo-server project setup`). 201.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /projects/{id}/setup/retry`                         | Retry a failed setup, optionally with different clouds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /projects/summary`                                   | Every project with its git config, environments, latest build, traffic, active transfer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /projects/{id}/summary`                              | The same for one project, plus `edgeInSync`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DELETE /projects/{id}?resources=true`                    | Delete a project (and optionally its cloud resources).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PATCH /projects/{id}/settings`                           | Any of `pollingEnabled`, `speedInsights`, `speedInsightsInject` (booleans) and `speedInsightsSampleRate` (100, 50, 25 or 10). Changing a Speed Insights field pushes the new settings to the edge.                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET` / `PUT /projects/{id}/git`                          | Read / change build settings and the git credential. `PUT` takes `credential`: `{ "kind": "public" }`, `{ "kind": "token", "token": "...", "username": "..." }` or `{ "kind": "deploy-key" }`; `GET` answers `credential: { kind, publicKey?, username? }`, never the token or private key. A `github` field is 400.                                                                                                                                                                                                                                                                            |
| `POST /projects/{id}/git/deploy-key`                      | Make (or replace) the project's SSH deploy key pair. 201 `{ publicKey }`: add it to the repository as a read-only deploy key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /projects/{id}/builds`, `POST /projects/{id}/builds` | List builds; start one (optional `revision`, `stage`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /builds/{id}`                                        | One build with its log and details.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /builds/{id}/deploy`                                | Deploy a stored build to one cloud: `{ environmentId }`. Queues a promote job. 202.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PATCH /environments/{id}`                                | `{ autoDeploy }`: deploy new commits to this cloud or not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /projects/{id}/env/fingerprint`                      | Fingerprint of the current variables (no names or values), so a client can tell when a build's variables differ from today's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /builds/{id}/files`                                  | The build's static files, paged: `prefix`, `cursor`, `limit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /builds/{id}/functions`                              | The build's functions (runtime, size, memory, routes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /environments/{id}/deployments`                      | Deployment history of one environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /projects/{id}/environments/add`                    | Add a cloud.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /environments/{id}/archive`                         | Archive an environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET` / `PUT /projects/{id}/traffic`                      | Read / set the split.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /projects/{id}/transfer`, `…/transfer/cancel`       | Start / stop a transfer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Every environment the API returns also carries `clusterId` (the cluster it runs on, or `null`) and `displayName` (the cluster's name, `Kubernetes` in dev mode, or `Cloud Run`). `POST /projects/setup` and `POST /projects/{id}/environments/add` accept `{ "target": "kubernetes", "clusterId": "kc_..." }`; `clusterId` may be left out only when exactly one cluster is connected. Up to 10 clouds can be chosen at once.

### Edge, domains and relays (production mode)

`GET /system/edge`, `POST /system/edge/install` and `/reinstall` (background jobs, answered `202` with a job whose `step` you poll; one at a time, `409` while one runs), `PATCH /system/domains` (base domain, Let's Encrypt email and directory), `POST /system/clusters/{id}/update-setup`, `GET`/`POST /system/clusters/{id}/relay`, and `GET`/`POST /projects/{id}/domains`, `DELETE /projects/{id}/domains/{domainId}`, `POST …/{domainId}/check`. They need production mode (`409` otherwise). Unknown keys in a body are `400`. A transfer or a weight increase for a cluster without public entry is refused. The ideas are explained in [Domains and the public edge](./domains.md).

### Edge admin additions

The edge's admin API (see [Traffic and the edge](./traffic.md)) gained two things for Speed Insights: `PUT /targets/{host}` accepts an optional `insights: { enabled, inject, sampleRate }` (absent means off; `GET /targets/{host}` returns it when set), and `GET /insights/drain` returns `{ batches: [...] }` and empties what it returned. Core does not call it (see above); a sink-carrying product does. Draining is a GET that **throws data away** for everyone else: any stray `GET /insights/drain` (a curl, a browser tab on the admin port) takes up to a minute of samples that the control-plane then never sees. Edge sync sends the `insights` field and treats a host whose live settings differ as out of sync, so it is re-pushed.

**Upgrade order: edge first, then the control-plane.** An older edge rejects the backend `id` and the `insights` field with `400`, so a newer control-plane could not sync to it. Without the drain route (`404`), the control-plane just logs once and keeps going.

### Older and lower-level routes

Kept from NBO's first API and used by scripts and tests: `GET/POST /projects`, `GET /projects/{id}`, `GET/POST /projects/{id}/environments`, `GET /environments/{id}`, `POST /environments/{id}/deployments` (deploy a `.nbo/` folder already on disk), and `POST /projects/{id}/webhooks/github`.

## How a route is written

**Files:** `src/router.ts` (tiny path matcher with `{param}` placeholders), `src/v2-routes.ts`.

```ts
router.handle("GET", "/projects/{projectID}/summary", async (_request, params) => {
  return writeJSON(summarize(store, params.projectID!, v2.edgePublicPort));
});
```

Handlers are plain `(Request, params) => Promise<Response>`. Store errors (`ErrNotFound`, `ErrDuplicateName`, … in `errors.ts`) are turned into status codes by `statusForStoreError`. To add an endpoint: add a `router.handle(...)` line, a store method if it needs data, and a test in `src/__tests__/`.

## Testing without clouds

`src/testing.ts` provides fakes: `fakeDeploymentTrigger`, `fakeCloudSetup` / `readyPreflight`, `fakeCloudTeardown`, and `makeLocalRepo` (creates a real Git repository in a temp folder, so clone and `ls-remote` run for real). Tests create the whole server with `createMux` over a fresh in-memory-like database file and call it with `Request` objects, no ports, no network.
