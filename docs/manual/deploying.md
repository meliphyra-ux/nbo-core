# Deploying

How a `.nbo/` folder becomes running containers. This is the most cloud-specific part of NBO, so it's covered in detail for both Kubernetes and Cloud Run.

## The path through the code

```
runner.runBuild                      packages/controlplane/src/builds/runner.ts
  `- triggerDeploy(env, nboDir)      packages/controlplane/src/deploys/deploy.ts
       |- createKubernetesTarget     packages/deploy/src/kubernetes-target.ts
       |  or createCloudRunTarget    packages/deploy/src/cloudrun-target.ts
       `- deploy(deployer, …)        packages/deploy/src/deploy.ts
            |- validate              packages/validate
            |- evaluate (planner)    packages/planner
            |- liveContentID         (already running? stop here)
            |- deployFunctions       one container per function
            `- buildAndDeploy        the app container
```

## `triggerDeploy`: one environment

**File:** `packages/controlplane/src/deploys/deploy.ts`

1. Loads the environment row.
2. `deployAppName(env)` picks the name used for every cloud object, `p` + the first 8 characters of the project id + `-` + the environment name, for example `p4715bebb-k8s` (environment names are `cloudrun`, `k8s` for the local cluster or the upgraded `default` cluster, and `k8s-<cluster name>` for every other connected cluster). Stable across deploys, so each deploy updates the same objects.
3. `store.ensureCronSigningSecret(envId)` gets (or creates) a secret that the app uses to verify cron calls really come from NBO. Passed as `NBO_CRON_SIGNING_SECRET`.
4. Creates the right **target** for `env.target`. In production, a Kubernetes environment records the id of its cluster (`clusterId` in its config), and the deploy reads that cluster's own credentials and registry, never another cluster's. If the environment has no `clusterId`, or its cluster has been disconnected, the deploy is refused before anything is created. For Cloud Run, reads `project`, `region`, `arRepo` from the environment's config; missing any → error.
5. Inserts a `deployments` row (status `pending`).
6. Calls `deploy(...)`, then records success (URL, content id) or failure (error text) on the deployment row. After a successful deploy, `store.registerCronsFromManifest` records the build's `crons.json` schedules for this environment.

## `deploy`: the same for every cloud

**File:** `packages/deploy/src/deploy.ts` → `deploy(deployer, nboDir, appName)`

A **deployer** is an object with a few functions (`capabilities`, `liveContentID`, `deployFunctions`, `buildAndDeploy`, `urlFor`). `deploy` doesn't know which cloud it's talking to:

1. **Validate.** `validate(nboDir)`; any error → "refusing to deploy an invalid build: …".
2. **Plan.** `loadFromDir` + `evaluate(manifest, functions, capabilities)` from `@nbo/planner`. Each capability the build needs is checked against the cloud's list (`capabilities.ts` in each adapter), as well as limits like memory and duration. Fails with the plan report if the cloud can't do it.
3. **Content id.** `contentId(manifest)`.
4. **Skip if live.** `deployer.liveContentID(appName)` asks the cloud which content id is running. Same → return immediately with `alreadyLive: true`. This is why building an unchanged commit again takes seconds.
5. **Functions first.** If the manifest lists functions, `deployFunctions` deploys each one and remembers its URL. Functions go first because the app container needs their URLs.
6. **App.** `buildAndDeploy(nboDir, appName, contentId)`.

Between 4 and 5, when the build has prerender routes (ISR pages), `deploy` also deploys the page cache (`deployIsrCache`), so its address is known before the app image is built. A build with none deploys no cache; when the cloud's previous live build had ISR and this one hasn't, the cache is removed after the new app is live (a failed removal is a progress line, not a failed deploy).

## Deploying a stored build

Every successful build keeps a copy of its `.nbo/` output (see [Builds](./builds.md#what-each-build-keeps)). You can deploy that copy to any cloud of the project without building again: `POST /builds/{id}/deploy` with `{ environmentId }` makes the control-plane queue a **promote** job.

Before anything is deployed, the promote checks the stored copy:

1. It runs the same validation as any deploy.
2. It computes the content id of the stored manifest and compares it with the id recorded when the build was made. If they differ, the files were changed or damaged, and the job fails with `This build's stored output is damaged: rebuild it`. If the copy was already deleted by retention, it fails with `This build's stored output was cleaned up: rebuild it to deploy it`.

The deploy then uses your **current** variables for the cloud you deploy to, not the ones the build was made with. A cloud belongs to one [environment](./environments.md), so deploying a build made for staging to a Production cloud uses Production's variables. To see whether they changed, compare the fingerprint of the current variables (`GET /projects/{id}/env/fingerprint`; no names, no values) with the one recorded on the build (`GET /builds/{id}`).

Each deployment records the build it ran (`deployments.build_id`). That is how NBO knows which build a cloud is serving: the build behind that cloud's newest successful deployment.

## Kubernetes in detail

**Files:** `packages/deploy/src/kubernetes-target.ts`, `packages/adapter-k8s/src/{image,manifest,templates}.ts`

The cluster is the local kind cluster `nbo-local`. The app's in-cluster URL is `https://<app>.127.0.0.1.sslip.io`.

### Functions

Functions deploy concurrently, up to 4 at once (`mapLimit`); the first failure fails the deploy once the others in flight have finished. For each function (`deployOneFunction`):

0. **Skip if unchanged.** The image tag is the function's content hash (`functionImageHash`: Dockerfile, `host.mjs`, `function.json`, every bundle file, and the baked env; only the values enter the hash). The Deployment also carries `nbo.dev/fn-config`, a hash of the rendered manifests (`functionConfigHash`). Steps 1–3 are skipped (log: `function <name>: unchanged, skipped`) only if `kubectl get deployment <app>-fn-<name>` shows that exact image, that exact config, and a finished, healthy rollout (`observedGeneration ≥ generation`, `updatedReplicas = availableReplicas = replicas`). Image loads into kind run one at a time per cluster.
1. **Image.** `buildFunctionImage` writes a temporary folder with `host.mjs` (the function runner from `@nbo/funcproxy`), the function's `bundle/`, `function.json` and `env.json`, then runs `docker build` with this Dockerfile (`templates.ts` → `functionDockerfile`):

   ```
   FROM node:24-slim
   COPY host.mjs /app/host.mjs
   COPY bundle /app/bundle
   COPY function.json /app/function.json
   COPY env.json /app/env.json
   WORKDIR /app/bundle
   ENTRYPOINT ["node", "/app/host.mjs", "/app/bundle"]
   ```

2. **Load.** `loadImageIntoKind(tag, "nbo-local")` → `kind load docker-image`. Copies the image into the cluster's nodes, no registry needed.
3. **Apply.** `renderFunctionManifests` produces YAML for a Deployment (1 replica, port 8080) and a Service. `apply(yaml)` pipes it to `kubectl apply -f -`.
4. **URL.** The function is reachable inside the cluster at `http://<app>-fn-<name>:8080`. Kubernetes' internal DNS resolves a Service's name for anything in the same namespace. Kubernetes names are at most 63 characters: when `<app>-fn-<name>` (or another name built from the app's, like `<app>-env`) would be longer, NBO uses its first 54 characters, a dash and 8 hex digits of a hash of the full name (`kubeName` in `adapter-k8s/src/manifest.ts`), for the Deployment, the Service, the pods' `app` label and the URL alike. Shorter names are used as they are.

### The ISR cache

When the build has prerender routes, `deploy` runs `deployIsrCache` after the functions and before the app, so the app image can carry the cache's address. It is skipped otherwise (and a deploy with no cache step, such as `nbo deploy` from the command line, says "prerender routes are served uncached" once). The cache is the `isrcache` server from the same CLI bundle as the app, in its own image `nbo-isrcache:<tag>`; the tag is a hash of NBO's code, not of the build, so a deploy that changes only your app keeps the same image and the same warm cache.

- A Deployment and Service `<app>-isr` (shortened like every name), one replica, port 8080, labels `nbo.dev/role: isrcache` and `nbo.dev/app: <app>`, requests of 10m CPU and 64 MiB, a limit of 256 MiB, readiness and liveness probes on `/healthz`. It runs as user 1000 with a read-only root filesystem, no extra permissions and no service account token.
- A NetworkPolicy `<app>-to-isrcache`: only the app's own pods may reach it. Functions and other apps can't.
- NBO finds and deletes it by name and by its labels, so a function or another app that happens to have a similar name is never touched. A cluster can't be named `isr` or end in `-isr` (those names could clash).
- The app's `/functions.json` gets the cache's address under `__isrcache`. The revalidation secret reaches the app the way any secret variable does (`NBO_PRERENDER_BYPASS` in `<app>-env`).

Deleting an environment's apps also deletes its cache.

### The app

`buildAndDeployApp`:

1. `prepareCliDeployDir()`: copies the built `nbo` CLI (`packages/cli/dist` with its dependencies) to a temp folder. It is shared (`cliDeployDirs` in `kubernetes-target.ts`, `cli-deploy-dir.ts`): every environment of one build reuses one copy, prepares never overlap, and the last user removes it.
2. `buildImage(...)`: `docker build` with `appDockerfile`:

   ```
   FROM node:24-slim
   COPY cli /app/cli
   WORKDIR /app/cli
   RUN …                         ← rebuilds the re2 native module for Linux
   COPY app /app/app             ← the .nbo/ folder
   COPY carry /app/carry         ← the previous build's hashed files (see below)
   COPY functions.json /functions.json
   COPY env.json /env.json
   ENTRYPOINT ["node", "dist/main.js", "serve", "/app/app", "--carry", "/app/carry", "--port", "8080"]
   ```

   `functions.json` is the map of function name → URL from the step above. It's baked into the image because a container's start command is fixed when the image is built, before any URL could be passed in. The per-deploy `COPY` lines come last so Docker's layer cache keeps the CLI and the re2 rebuild between deploys.

3. Tag: `nbo-app-<app>:<part of content id>`, with `-c<8 hex>` added when files are carried, then `-b<8 hex>`, a hash of what else is baked in (NBO's own code, `/functions.json`, `/env.json`), so a redeploy of the same build after an NBO upgrade never starts a node's older image. `loadImageIntoKind`.
4. `renderManifests({ appName, imageTag, host, contentID })` produces:
   - a **Deployment** (1 replica, port 8080, a readiness probe and a `preStop` sleep, see below) with annotation `nbo.dev/content-id: <id>` on both the Deployment and its pods,
   - a **Service** in front of it,
   - an **Ingress** for `host` with `ingressClassName: nginx`, TLS from cert-manager (`cert-manager.io/cluster-issuer: selfsigned-issuer`, secret `<app>-tls`).
5. `apply`, then `waitForRollout(app)`: `kubectl rollout status` waits until the new pods are ready.

### Rollouts and the previous build's files

Visitors often hold a page from the build that is being replaced: it was loaded a minute ago, or a tab was left open overnight. That page asks for its own hashed files (`/assets/index-3f9a.js`, `/_next/static/chunks/...`). The new build doesn't have them, so without help the answer is a 404 and the page breaks or reloads.

So each deploy carries files over. When a cloud moves from build A to build B, the runner finds the build that is live on that cloud (A) and, if NBO still has its stored output, copies A's **hashed files** into B's image under `/app/carry`:

- **What is kept:** only files the producer marked `immutable` (Vite's `assets/`, Next's `_next/static/`, names with a content hash) whose URL B doesn't have. No pages, no functions. Only the **one earlier build**, A's own files; what A itself carried is not carried again.
- **The cap:** 256 MiB of file bytes. Over it, nothing is carried and the deploy log says `previous build's files not kept: <n> MiB is over the 256 MiB limit`. A first deploy, a missing or damaged stored output, or any other problem also just logs a line and the deploy goes on without carried files. A deploy never fails because of this.
- **How it is served:** `nbo serve` answers a carried file only where B itself would answer 404, so B's own file always wins. The answer is `200` with `cache-control: max-age=31536000, immutable` and a header `x-nbo-carried-from: <A's content id>`. **Carried answers skip the new build's header rules and middleware headers**: A's rules were applied when A served those files, and carried files are only hashed assets.
- **Image tags:** the tag gets `-c<8 hex>` (a hash of the carried files), so Kubernetes can't reuse an image of the same build that carried different files.
- **Where it applies:** the same for commit builds, deploying a stored build and transfers, on both Kubernetes and Cloud Run. `nbo deploy --carry-from <dir>` does it by hand.

On **Cloud Run**, a new revision gets every new request once it is ready, so this closes the gap. On **Kubernetes**, the app container has a readiness probe (`tcpSocket` on port 8080, every 2 seconds) so a new pod gets requests only once `nbo serve` is listening, and a `preStop` sleep of 5 seconds, so an old pod keeps answering while it leaves the Service. The rollout stays one replica, surge 1, unavailable 0 (the new pod is ready before the old one stops). `preStop` sleep needs Kubernetes 1.30 or newer, NBO's minimum. Deploys take about 5 seconds longer. **What is left:** for a few seconds while the old pod leaves the Service, a page served by the new pod can still ask the old pod for a file the old pod doesn't have, and miss. A tab left open across two deploys can also miss a lazy chunk; Next and Vite then reload the page.

### "What's running?"

`liveContentID(app)` runs `kubectl get deployment <app> -o jsonpath={.metadata.annotations.nbo\.dev/content-id}`. That annotation is how NBO recognises "already deployed".

## Cloud Run in detail

**Files:** `packages/deploy/src/cloudrun-target.ts`, `packages/adapter-cloudrun/src/{image,deploy,iam}.ts`

Settings per environment: Google `project`, `region` and `arRepo` (`<region>-docker.pkg.dev/<project>/nbo`).

### Functions

Concurrently, up to 4 at once, for each function:

0. Tag = the function's content hash (as on Kubernetes), and the service is labelled `nbo-fn-config` = a hash of its deploy arguments, run-as account and invoker member (`functionDeployConfigHash`). If `gcloud run services describe <app>-fn-<name> --format=json` shows that exact image and label, the `Ready` condition is True and the latest created revision is the latest ready one, steps 1–3 are skipped and the live URL is used. Step 4 (the invoker grant) always runs.
1. `buildFunctionImage` (same Dockerfile as Kubernetes) → local tag `nbo-fn-<app>-<name>:<content hash>`.
2. `pushImage(local, remote)` (`image.ts`) → `docker tag` + `docker push` to Artifact Registry.
3. `cloudRunDeploy(...)` (`adapter-cloudrun/src/deploy.ts` → `deploy`) runs `gcloud run deploy <app>-fn-<name> --image … --region … --project …` with memory and timeout from `function.json`, and **`--no-allow-unauthenticated`**: functions are private.
4. `grantInvoker(service, …, serviceAccount)` (`iam.ts`) lets the project's default compute service account call the function. The app runs as that account, so only the app can reach its functions.

### The ISR cache

For a build with prerender routes, `deployIsrCache` (Cloud Run target) deploys a private service `<app>-isr` from the same `nbo-isrcache` image (pushed to Artifact Registry once per NBO version): `--no-allow-unauthenticated`, `--min-instances 0`, `--max-instances 1`, `--concurrency 250`, `--memory 256Mi`, `--cpu 1`, first generation execution environment (the second needs more memory), request-based billing. In production it runs as its own role-less service account, and the app's account gets `roles/run.invoker` on it; the app calls it with an identity token, as it does for functions. Idle, it costs nothing and stops (the cached pages go with it). At 1 million ISR page views a month it costs about $3 or less, mostly inside Cloud Run's free tier; the secret adds about $0.06 a month and the image about $0.02. NBO matches the service by its labels before deleting or replacing it.

### The app

1. `buildImage` (same app Dockerfile) → push as `<arRepo>/nbo-app-<app>:<tag>` (the same tag as on Kubernetes).
2. `gcloud run deploy <app> --image … --no-invoker-iam-check` (public without an `allUsers` grant, which organisations with Domain restricted sharing refuse) with label `nbo-content-id` (a shortened form of the content id; labels can't hold the full value, hence the deployer's own `idsMatch`).
3. Cloud Run prints the service's `https://…run.app` URL; NBO stores it as the deployment URL and the edge backend.

### Calling private functions

Inside the app container, `nbo serve` sees the `K_SERVICE` environment variable (Cloud Run always sets it) and uses `createCloudRunURLs` (`packages/funcproxy/src/cloudrun.ts`): before each function call it fetches an identity token from Google's metadata server and sends it as `Authorization: Bearer …`. If the visitor's request had its own `Authorization` header, it's moved to `x-nbo-forwarded-authorization`, and `host.mjs` moves it back, so apps still see their users' headers.

### "What's running?"

`liveContentID` reads the `nbo-content-id` label with `gcloud run services describe`. "Not found" means nothing is deployed yet.

## Environment variables at deploy time

`deployTimeEnvVars(nboDir)` (`packages/deploy/src/env.ts`) reads `env.json` from the build, merges NBO's own (like `NBO_CRON_SIGNING_SECRET`) and bakes them into the images as `/env.json` (app) and `/app/env.json` (functions). On startup, `nbo serve` and `host.mjs` copy them into `process.env`.

Your own variables (workspace and project) are never baked into images; they reach the app and every function at runtime, and each deploy replaces the full set.

**On Cloud Run** (`packages/deploy/src/cloudrun-target.ts`, `packages/adapter-cloudrun/src/{deploy,secrets}.ts`):

- Plain variables go in a YAML file passed as `gcloud run deploy … --env-vars-file <file>`. The file lives in a private temp folder and is deleted right after the call; keys and values are quoted so names like `YES` or `NULL` stay strings. With no plain variables the deploy says `--clear-env-vars`.
- Secret variables live in Secret Manager, one secret per app and name: `nbo-<app>-<first 16 hex of sha256(name)>` (no value in the name). NBO runs `gcloud secrets create … --replication-policy=automatic` (an existing secret is fine), and `gcloud secrets versions add … --data-file=-` with the value on stdin, only when the secret's `nbo-value-hash` label (a keyed hash of the value, never the value) differs; NBO then updates the label and, after a successful deploy, destroys the older versions. Deleting a project's Cloud Run resources also deletes its secrets. Each runtime account (the app's and each function's own account in production, the default compute account otherwise) gets `roles/secretmanager.secretAccessor` on each secret, never project-wide. The deploy mounts them with `--set-secrets NAME=<secret>:latest,…`; with no secrets it says `--clear-secrets`.
- A project with no variables never creates Secret Manager secrets and adds no variable flags to a service that never had variables. The exceptions: if a service had variables (its `nbo-env` label) and the set is now empty, the deploy adds `--clear-env-vars --clear-secrets`; a function deployed for the first time (no live service to read) gets the same two flags, which are harmless on a new service.
- If Secret Manager is off, the deploy asks to reconnect Google Cloud to enable it (dev: "enable the Secret Manager API in your Google Cloud project"). If permission is missing: reconnect (connected from this machine), "grant roles/secretmanager.admin to <deployer>" (pasted key), or "your gcloud account needs roles/secretmanager.admin" (dev). Secret values can't be empty.

**On Kubernetes**, all of a project's variables go into one Secret named `<app>-env` (plain ones too, so nothing readable sits in the Deployment). The app and every function Deployment load it with `envFrom`, marked `optional: true` so an old pod that restarts after a failed rollout removed or replaced the Secret still starts. The Deployment carries an `nbo.dev/env-fingerprint` annotation, so when a variable changes the pods restart and pick up the new set. With no variables there is no Secret: each deploy runs `kubectl delete secret <app>-env --ignore-not-found`, which does nothing when there was never one and removes a leftover Secret when the last variable was deleted.

**Names only.** When NBO is set to [keep no variable values](./environments.md#dont-store-variable-values), the values come with the deploy request and are held in memory (`variables/supplied-values.ts`) until the job ends. They are used in exactly these places: the build command's environment, the Kubernetes Secret, and Cloud Run's env file and Secret Manager. Redaction of build logs and the deployment's `error` text covers secrets and plain values of 6 or more characters. Turning the setting on blanks the database values but does not touch these cloud-side Secrets, so apps keep running with the values they had until their next deploy.

**"Already live" includes the variables.** The check that skips an unchanged deploy compares the content id plus a fingerprint of the variable set (a keyed hash; it reveals no values). Changing a variable therefore redeploys even if the code is the same, and a project with no variables behaves exactly as before.

**Required variables.** If `manifest.json` lists `env.required` names (or a binding such as `postgres` needs `<NAME>_URL`), the deploy checks they are all set before building images and fails naming every missing one.

## One build, every cloud, then the edge

A build is deployed to **every cloud of its environment** that has automatic deploys on, all at the same time (each cloud's log lines carry its name). A failure on one cloud doesn't stop the rest, and the build is marked failed if any cloud failed. Each cloud ends up running the same `.nbo/`, which is why they all report the same content id.

After a successful deploy the control-plane tells the **edge** about the cloud (edge sync). The first deploy of a project is registered at 100%; later changes follow the traffic split you set (see [Traffic and moving clouds](./traffic.md)). The edge keeps each visitor on one cloud while the split stays the same (sticky visitors), so a page and its script files come from the same build.

The edge has two editions with the same ports, settings and admin API. The **Node edge** (`packages/edge`) is the default. The **Rust edge** (`packages/edge-rs`) is opt-in: when NBO installs the edge on a cluster it builds the Node image unless `NBO_EDGE_IMPL=rust` is set where NBO runs. Run `nbo-server edge reinstall` after changing it (see [Server settings](./server-settings.md) and [Domains and the public edge](./domains.md#installing-the-edge)).

## Deleting

`DELETE /projects/{id}?resources=true|false` deletes a project. With `resources=true`, `createCloudTeardown` (`packages/controlplane/src/clouds/cloud-teardown.ts`) runs `kubectl delete` for the app's Deployment/Service/Ingress and its functions, and `gcloud run services delete` for Cloud Run services. Images in registries are kept. Then the edge entry is removed and the database rows are deleted.

Removing a single cloud (`POST /environments/{id}/archive`) only hides it; its cloud resources stay up.

**Deleting one custom environment** (`DELETE /projects/{id}/stages/{stageId}`) tears down only that environment's apps when you add `?resources=true`. The teardown has a scope. `project` is the whole project, as above. `app` is one app: on production Kubernetes it deletes only what the adapter made for that app in the project's namespace (its Deployment and Service, its `<app>-env` Secret, its two NetworkPolicies `<app>-from-edge` and `<app>-to-functions`, and each function's Deployment and Service), and never the namespace, the shared `nbo-default-deny-ingress` policy or the image pull secret. On Cloud Run it deletes that app's services, service accounts and secrets and leaves domain mappings alone, since only Production has them. It is told the names of every other app of the project and never touches those. If a step fails, everything stays and auto-deploy is turned back on.
