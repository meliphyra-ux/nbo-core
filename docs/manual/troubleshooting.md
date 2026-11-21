# Troubleshooting

This chapter is the index by symptom. Each entry quotes the message you see, says in plain words what caused it, and links to the chapter section that has the fix. Find the message (or a piece of it) with the search box.

Commands are written for a server in production mode first: NBO in Docker Compose, your sites in a connected Kubernetes cluster or on Cloud Run. Run `kubectl` from your own computer with your own kubeconfig for that cluster (the one you used to connect it). Each project runs in its own namespace, `nbo-p-<id>`, where `<id>` is the project's id from the dashboard's address bar (`/projects/<id>`). Lines that start with **Dev mode:** are for NBO started from the repository on your own computer, with the local `kind` cluster.

Jump to a group: [NBO won't start](#nbo-wont-start), [Docker Compose](#docker-compose), [API tokens and access](#api-tokens-and-access), [Ephemeral and other environments](#ephemeral-and-other-environments), [Page cache](#page-cache), [Upgrades and rolling back](#upgrades-and-rolling-back), [Rust edge](#rust-edge), and [chapters with their own troubleshooting](#chapters-with-their-own-troubleshooting).

## Where to look first

| Problem shows up in                                      | Look at                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A build                                                  | `GET /builds/{id}`: its log. Every command is printed as `$ command`, followed by its output. `GET /projects/{id}/builds` lists the builds.  |
| Setup (`needs-setup`)                                    | `GET /projects/{id}/summary`: the error is in `setupError`. Retry with `nbo-server project retry <id>`.                                      |
| Setup (`waiting-for-key`)                                | A deploy key not yet added to the repository. NBO retries by itself; see below.                                                              |
| Connections ("not reachable", "gcloud is not logged in") | `nbo-server status`, then run the same commands yourself (below).                                                                            |
| The site itself                                          | Browser network tab: the `x-nbo-edge-backend` response header names the environment id (`env_…`) of the cloud that answered.                 |
| The control-plane                                        | `docker compose logs nbo` on the server. Lines start with `control-plane:`. Dev mode: its terminal output.                                   |
| A Kubernetes app                                         | `kubectl -n nbo-p-<id> get pods`, then `kubectl -n nbo-p-<id> logs deployment/<app>`. Dev mode: `kubectl --context kind-nbo-local get pods`. |
| The edge                                                 | `kubectl -n nbo-edge get pods`, then `kubectl -n nbo-edge logs deployment/nbo-edge`. Dev mode: the edge's terminal.                          |
| A Cloud Run app                                          | Google Cloud console → Cloud Run → the service → Logs.                                                                                       |
| A Lambda app                                             | AWS console → Lambda → the function `<app>` (or `<app>-fn-<name>`) → Monitor → CloudWatch logs.                                              |

## NBO won't start

The control-plane checks its settings in a fixed order, prints one line that starts with `control-plane:`, and exits. With Compose read it with `docker compose logs nbo`; without Docker it is in the terminal. The full list, with what each line means, is [When NBO refuses to start](./server-settings.md#when-nbo-refuses-to-start). The common ones:

### "NBO_MODE must be" …

`NBO_MODE` has a typo. It is `dev` or `production`; empty counts as `dev`. Fix it in `.env` or the environment ([Server settings](./server-settings.md#compose-env-file)).

### "must be exactly 32 bytes"

The full line starts with `secret key file`. The key file was edited, truncated or replaced by a text file. Restore it from your backup ([Backups and restore](../production.md#backups-and-restore)). NBO never makes a new key beside existing secrets.

### "is missing but the database holds sealed secrets"

The database has stored cloud credentials, but the key file is not where NBO looks. With Compose, check that the `nbo-keys` volume is still attached; otherwise restore the file or point `NBO_SECRET_KEY_FILE` at it. See [Restore onto a new server](../production.md#restore-onto-a-new-server).

### "does not decrypt the secrets stored in this database"

A key file exists but it is not the one this database was sealed with, for example after restoring only one of the two volumes. Restore the matching pair from the same backup.

### "this database has settings in both platform_settings and server_settings"

An older NBO (from before 2026-11-12) was started on this database after the upgrade, without restoring the backup, and saved settings. Restore the volume backup taken before the upgrade. See [Rolling back](../production.md#rolling-back).

### "this database holds data from features that moved to the hosted dashboard"

Not an error: NBO starts. The database comes from an NBO that had sign-in, the GitHub App, previews or Speed Insights. Those tables are kept, unused, for the hosted dashboard's import. See the 2026-11-12 note in [Upgrading NBO](../production.md#notes-for-specific-versions).

### "NBO_PUBLIC_URL must be an https:// address"

`NBO_PUBLIC_URL` must be `https://`, with no path, query, fragment or user name. The other `NBO_PUBLIC_URL` lines in [the list](./server-settings.md#when-nbo-refuses-to-start) name which of those you broke. See [Reaching NBO on its own address](../production.md#8-reaching-nbo-on-its-own-address).

### "is not a key=value annotation"

An entry in `NBO_LB_ANNOTATIONS` is not `key=value`. The bad entry is named in the message. The setting is optional ([Hetzner load balancer location](../production.md#5-install-the-public-edge)).

## Docker Compose

### Port 8081 is already allocated

Docker prints this when something else uses the port NBO wants. Put `NBO_PORT=8091` (any free port) in a `.env` file next to `compose.yaml` and start again. See [Start NBO](../production.md#2-start-nbo) and [Ports](./server-settings.md#ports).

### NBO can't be reached

NBO listens on `127.0.0.1` of the server only. On the server, `docker compose exec nbo nbo-server status` reaches it; from your computer you go through an SSH tunnel; `http://<server address>:8081` never works, on purpose. Read [Connect your clouds](../production.md#3-connect-your-clouds). If the tunnel fails, see [If ssh times out](../production.md#if-ssh-times-out).

### nbo-server: "can't reach the control-plane"

`nbo-server` talks to `http://127.0.0.1:<port>`, the port taken from `NBO_CONTROL_PLANE_ADDR` (8081 when unset). Run it inside the container (`docker compose exec nbo nbo-server ...`), where that is right. If NBO listens on another port or loopback address of the same computer, set `NBO_SERVER_URL` to it, for example `http://127.0.0.1:8091`. `nbo-server` refuses any address that is not on this computer, because its commands carry kubeconfigs and keys. A line `nbo-server: <status> <reason>` is NBO's own answer, not a connection problem: the reason says what to fix.

### nbo-server: "unknown flag --kubeconfig"

On purpose: `nbo-server` never takes a secret as a flag's value. Use `--kubeconfig-file <path>` (or `-` for stdin) instead; the same goes for `--key-file` and `--body-file`. API tokens are made with `nbo-server token create`, never typed in.

### "Cannot connect to the Docker daemon"

Docker is not running, or your user may not use it. Start Docker; on Linux add your user to the `docker` group or use `sudo`.

### The container restarts again and again

Read `docker compose logs nbo`. The last line that starts with `control-plane:` is the reason; look it up in [NBO won't start](#nbo-wont-start).

## API tokens and access

NBO has no sign-in, members or roles. Without a token, NBO answers only requests made on the server itself (through the SSH tunnel); with a token, it answers from anywhere that can reach it.

### "invalid API token"

`401`. The token is wrong or was revoked. Make a new one on the server: `curl -X POST http://127.0.0.1:8081/system/api-tokens -d '{"name":"ci"}'` prints it once.

### "this API token was made for a member below Admin while sign-in was on"

`401`. The token was made for a Viewer or a Developer back when this NBO had sign-in. NBO no longer knows roles, so such a token would otherwise be allowed everything; it is refused instead. Make a new token as above. Tokens made for an Admin or an Owner keep working, even if that member was later given a lower role: NBO can no longer check the member, only the role the token was made with.

### "API tokens can't use this route"

`403`. Tokens can't use `/system/*` (connections, clusters, the edge, tokens) or the two legacy routes. Run that request on the server itself, without a token.

### "request refused: the control-plane only accepts loopback callers"

`403`. The request had no token and was not addressed to `localhost`, `127.0.0.1` or `[::1]`. Use the SSH tunnel to `http://localhost:8081`, or send an API token.

### "request refused: on NBO's public address only API tokens and webhooks are accepted"

`403`. `NBO_PUBLIC_URL` is set and the request came through that address without a token. On its public address NBO accepts only requests with an API token and the per-project push webhooks. Send a token, or use the SSH tunnel.

## Reaching the API

### Every request fails to connect

Nothing answers on NBO's port. Through a tunnel, check that the `ssh -N -L` command is still running (it stops when your computer sleeps). On the server, `docker compose ps` should show NBO `healthy`; if not, read `docker compose logs nbo` and see [NBO won't start](#nbo-wont-start).

Dev mode: is the control-plane running (`node packages/controlplane/dist/main.js`) and listening on `127.0.0.1:8081`? `curl http://127.0.0.1:8081/healthz` answers `{"ok":true}` when it is.

A `403` from the API is one of the refusals in [API tokens and access](#api-tokens-and-access); the body names which.

## Several clusters

### "has no Kubernetes cluster recorded"

The environment has no `clusterId` in its config, so NBO won't guess which cluster to use. Add the cloud again (`POST /projects/{id}/environments/add` with a `clusterId`).

### "the Kubernetes cluster ... runs on is no longer connected"

The cluster was disconnected while the environment still existed (disconnect normally refuses this). A cluster connected again is a new connection with a new id, even under the same name, so the environment still points at the old one. To move the project there:

1. Connect the cluster again with `nbo-server connect kubernetes`. Use the **same name** as before.
2. Move all traffic off the broken environment (`PUT /projects/{id}/traffic`), then archive it (`POST /environments/{id}/archive`).
3. Add the cluster to the project again (`POST /projects/{id}/environments/add` with the new `clusterId`, or a transfer to it). NBO brings back the archived environment (same name, so the same cloud objects) now on the new connection, at 0% with nothing live; it deploys the build, then you give it traffic.

One exception: the cluster that was upgraded from the single-cluster days (its environment is called plain `k8s`). Reconnected as `default`, its environments are named `k8s-default`, so step 3 creates a new environment instead of bringing the old one back. That works, but the old `k8s` objects stay in the namespace; delete them with kubectl.

If the broken environment is the project's only one, add the reconnected cluster first under a **different** name (it gets its own environment), move traffic, then remove the broken one. Under a different name the objects get new names (`k8s-<new name>`) in the same `nbo-p-<id>` namespace; the old ones are left for you to delete with kubectl.

### "a cluster named ... is already connected"

Names must be unique. Pick another name, or replace the existing cluster's credentials instead. Names cannot be changed after connecting.

### "choose a Kubernetes cluster"

More than one cluster is connected and the request did not say which. Send `clusterId` (`nbo-server status` lists the clusters).

### "not migrating the old Kubernetes connection"

Printed by the control-plane at every start when an upgrade could not move the old single connection into `kube_connections`, because the id `kc_default` or the name `default` was already used. Your old credentials are kept but the old cluster is not listed among the connections. Connect it again under another name.

## Connections

### "failing" or "not connected" for Kubernetes or Cloud Run

In production mode `nbo-server status` shows the saved connections. "Not connected" means none is saved; connect one with `nbo-server connect`. "Failing" means NBO's last check of that connection failed: read its error there, and check again with `nbo-server cluster test <id>` (or `nbo-server api POST /system/connections/google/test`). A cluster whose token was deleted or whose address changed needs new credentials (`PUT /system/connections/kubernetes/{id}`).

### "not reachable" for Kubernetes

Dev mode only: `kubectl --context kind-nbo-local get nodes` failed or took more than 4 seconds (Dev mode).

- Is Docker running? The cluster is a Docker container.
- Dev mode: does the cluster exist? `kind get clusters` should list `nbo-local`. If not, run `./scripts/bootstrap-local-k8s.sh` (Dev mode).
- After a reboot, start Docker and give the cluster a minute.

### "gcloud is not logged in" for Cloud Run

Dev mode only: `gcloud` on your computer isn't logged in or has no project. Run `gcloud auth login` and `gcloud config set project <id>`. The status refreshes within 15 seconds.

## Setup

### "gcloud is not ready" / "Docker is not ready"

Dev mode: automatic Cloud Run setup (`"mode": "auto"`) needs both on your computer. Fix as above, then retry (`nbo-server project retry <id>`). In production mode Cloud Run uses the Google connection instead.

### Permission errors while enabling APIs or creating the registry

Your Google account needs permission to enable services and create Artifact Registry repositories in that project (Owner or Editor works). Or create them yourself and use a manual Cloud Run cloud (`"mode": "manual"` with `project`, `region` and `arRepo`).

### "interrupted: the control-plane restarted during setup" … "retry it"

Exactly that. Retry: `nbo-server project retry <id>`.

## Builds

### `git clone` fails

- **"could not read Username"**: git asked for a login. The URL is wrong, or the repository is private and the project has no credential. Give it a deploy key or a token (see [Private repositories](../production.md#4-private-repositories)).
- Network errors: check you can `git clone` the URL yourself.

### "the build sandbox needs Docker: …"

In production mode builds run in a container ([Where builds run](./builds.md#where-builds-run)), and NBO couldn't reach Docker to make one; the rest of the line is Docker's own message. With Compose, check that `compose.yaml` still mounts `/var/run/docker.sock` and that Docker is running on the server (`docker info`). NBO never builds outside the container when this happens. On a computer of your own where Docker can't run containers (such as a Windows host), set `NBO_BUILD_ISOLATION=none` ([Server settings](./server-settings.md)).

### A build stops with exit code 137, or "Killed"

The build container ran out of memory: a build may use `NBO_BUILD_MEMORY` (default `4g`) and no swap. Large Next.js apps can need more. Raise it in `.env` (for example `NBO_BUILD_MEMORY=6g`) and restart NBO, and keep `NBO_BUILD_CONCURRENCY` times that below the server's memory. `pnpm: not found` in the same place is a different problem: pnpm and Yarn come from corepack in the build image, so an `NBO_BUILD_IMAGE` of your own without corepack needs them installed (the log says `corepack enable failed`).

### "not enough free disk: …" or "stopped: the disk is almost full (…)"

The disk guard of container builds ([Server settings](./server-settings.md), `NBO_BUILD_MIN_FREE`, default `10g`). The message names the folder: Docker's data folder (as Docker reports it, usually `/var/lib/docker`) or one of NBO's folders (the database's folder or the temporary folder). `not enough free disk` means the build never started; `stopped` means it was writing while that folder dropped under half the minimum, so NBO removed its container and volume. Free space there: `docker system df` shows what Docker keeps, and `docker image prune` and `docker builder prune` remove unused images and build cache; old build volumes are removed by NBO itself. If one build really writes that much, look at its log for what grows (a cache, test output), and give Docker's data folder its own disk ([Launching NBO](../production.md)). Lowering `NBO_BUILD_MIN_FREE` or setting it to `0` only hides the problem until the disk is really full.

### "the build network's firewall rules couldn't be applied"

The full message is `the build network's firewall rules couldn't be applied (NBO_BUILD_EGRESS=restricted): …`, and the rest of the line says why. Before every container build NBO makes sure the server's `DOCKER-USER` firewall chain keeps builds off private addresses and the cloud metadata address ([Where builds run](./builds.md#where-builds-run)), using a short-lived helper container started with `--privileged` that runs the server's own `iptables`; without the rules it doesn't build. `sh: iptables: not found` means the server has no `iptables` command: install it (on Debian and Ubuntu, `sudo apt install iptables`) and build again. A message about `--privileged` or permissions usually means rootless Docker or a Docker that refuses privileged containers, which can't add the rules; Docker Desktop also answers `iptables: not found`, since its `iptables` lives in Docker's own part of its virtual machine. `the Docker network nbo-builds has the bridge …` means a network of that name was made by hand: remove it with `docker network rm nbo-builds` and NBO makes its own. To check the rules once a build has run: `sudo iptables -S DOCKER-USER` lists seven lines naming `nbo-builds0`. If you can't give NBO the rules, set `NBO_BUILD_EGRESS=open` in `.env` and restart NBO ([Server settings](./server-settings.md)): builds then reach every address, the cloud metadata address included, so do that only on a machine whose cloud identity has no rights.

### "timed out after" … or "the build ran past its 30-minute limit"

Each build step may take 10 minutes, and in container mode the whole build, copies in and out included, 30 minutes. The step was stopped and, in container mode, its container removed. Look at the log for a step that hangs (an install waiting for input, a test watcher started by the build command). A build that is only slow needs a faster server or less work per build; the limits aren't settings.

### "expected the build command to create "dist", but it does not exist"

Static / React (Vite): the build command finished but wrote somewhere else. Check the framework's output folder (Vite: `dist`, Create React App: `build`, Astro: `dist`) and set **Output directory**. In a monorepo, also set **Root directory**.

### "expected the build command to produce" … "set Root Directory"

Next.js built in a subfolder. Set **Root directory** to the folder named in the message, and remove any `cd` from the build command.

### "expected the build command to produce" … "check that this is a Next.js 14+ app"

The build left neither `.nbo/` (Next.js 16, through the adapter) nor `.next/required-server-files.json` (Next.js 14 and 15). Make sure the app uses Next.js 14 or later and the build command actually runs `next build` (for example `pnpm install && pnpm run build`). A custom `distDir` isn't supported on 14 and 15: NBO looks in `.next`.

### "outputDir … escapes the cloned repository"

The output or root directory contains `..`. Use a folder inside the repository.

### The build was "Skipped"

Open the build's log or note; it names the reason. "Waiting for variable values" is the names-only case below. If the log says "Ignored build step exited 0", the ignored-build-step command exited with 0, which means "skip": change or clear it (`ignoredBuildStepCommand` in `PUT /projects/{id}/git`). Any other note is a different cause.

### "Waiting for variable values: this NBO doesn't store them"

The workspace setting **Don't store variable values** is on, and this environment declares variable names, so a push can't build by itself: NBO has no values to give it. Deploy with the values (`values` in `POST /projects/{id}/builds`) or from Terraform. See [What it costs](./environments.md#what-it-costs).

### "[log truncated]"

The log passed 256 KiB; later output was cut. The build itself still ran.

### "interrupted"

The control-plane restarted during the build. Start it again: `POST /projects/{id}/builds`.

## Deploys

### "refusing to deploy an invalid build: …"

`.nbo/` broke a rule. The message names the file and the rule. Usually a bug in a producer; check that the build used a current NBO version (`pnpm build --force`).

### "refusing to deploy: plan failed for target …"

The build needs something this cloud can't do. The plan report below the message lists each requirement with `[ok]` or `[FAIL]`. Run `node packages/cli/dist/main.js plan <.nbo dir> --target kubernetes` locally to see it again.

### "missing required environment variable(s): …"

The app says it can't run without these names (`env.required`, or a database binding's `<NAME>_URL`). Add them (`PUT /projects/{id}/env/{name}` or `/workspace/env/{name}`, or Terraform's `nbo_env_var`), then build again (`POST /projects/{id}/builds`).

### "reconnect Google Cloud … to enable the Secret Manager API" / "grant Secret Manager access"

Secret variables on Cloud Run live in Secret Manager. "Enable" means the API is off in your Google project: connect Google again (`nbo-server connect google`), or in dev mode run `gcloud services enable secretmanager.googleapis.com`. "Grant" means the account lacks `roles/secretmanager.admin`: reconnect, or grant the role to the account named in the message.

### "Secret values can't be empty" or a reserved name

Secrets need a value. Names starting with `NBO_`, and `PORT`, `K_SERVICE`, `K_REVISION`, `K_CONFIGURATION` and `NEXT_ADAPTER_PATH`, are set by NBO or the cloud and can't be used.

### "Lambda allows 4 KB of environment variables in all" or "Lambda sets … itself"

A deploy to AWS Lambda puts every variable into the function's environment, which Lambda limits to 4 KB in all, measured as the JSON of the names and values; the message names the largest. Move large values out (a file in the build, or a store the app reads at start), or keep the project off Lambda. "Lambda sets … itself" names variables such as `AWS_REGION` that Lambda reserves: rename them for this project. Both are checked before anything is built or pushed. More in [AWS Lambda in detail](./deploying.md#aws-lambda-in-detail).

### "cloudrun environment needs project, region and arRepo"

A manual Cloud Run setup is missing one of the Google project, the region or the registry. Delete the project and set it up again, or retry setup with an automatic Cloud Run cloud (`nbo-server api POST /projects/<id>/setup/retry` with `{"clouds": [{"target": "cloudrun", "mode": "auto"}]}`).

### Docker errors (`docker build` / `docker push`)

- "Cannot connect to the Docker daemon": Docker isn't running on the server, or the Compose service lost the host's Docker socket. Check `docker compose ps` and restart with `docker compose up -d`.
- `push` "denied" / "unauthenticated": NBO pushes with its Google connection's credentials. Check it with `nbo-server api POST /system/connections/google/test`, and connect it again if that fails. Dev mode: run `gcloud auth configure-docker <region>-docker.pkg.dev`.
- "no space left on device": `docker system prune` on the server (removes unused images).

### `kubectl rollout status` timed out

The new pod didn't become ready within 120 seconds. `kubectl -n nbo-p-<id> get pods` and `kubectl -n nbo-p-<id> describe pod <name>` show why: `ImagePullBackOff` (the cluster can't pull the image from the registry: check the cluster's connection with `nbo-server cluster test <id>`), `CrashLoopBackOff` (the app crashes at start: `kubectl -n nbo-p-<id> logs <name>`).

Dev mode: `kubectl --context kind-nbo-local get pods`; `ImagePullBackOff` there means the image wasn't loaded into kind (Dev mode).

### "deployed, but updating the edge failed"

The cloud has the new version, but the edge didn't get the split. Usually the edge isn't running: `kubectl -n nbo-edge get pods` on the edge's cluster, and `nbo-server edge reinstall` if it is gone. The next poller tick (≤ 45 s) re-sends everything. Dev mode: start the edge.

## Visiting the site

### "edge: no target registered for host …" (404)

The edge doesn't know this domain:

- No successful deploy yet.
- The edge restarted and the control-plane hasn't re-sent yet (≤ 45 s).
- Wrong domain: use `https://<name>.<base domain>` (or the custom domain you added). Dev mode: `http://<name>.127.0.0.1.sslip.io:9443`, port included.

### "edge: backend unreachable" (502)

The edge picked a cloud that didn't answer. The edge's log has the reason (`edge: backend env_… for <host> unreachable: …`). Other 502s from the edge start with `edge:` too. `relay: upstream unreachable` means the cluster's relay reached the cluster but not the app's Service; the relay's log (`kubectl -n nbo-edge logs deployment/nbo-relay` on that cluster) has the reason. Check that cloud's app (pods running? Cloud Run service healthy?). Move traffic away (`PUT /projects/{id}/traffic`) while you fix it.

### `502` without "edge:" in the body

The app's own server couldn't reach one of its functions. Kubernetes: `kubectl -n nbo-p-<id> get pods`: is `<app>-fn-<name>` running? Cloud Run: does the function service exist, and does the app's service account have the invoker role?

### Old content after a deploy

- Hashed assets are cached forever on purpose; HTML is revalidated on every visit. Hard-refresh (Ctrl+Shift+R).
- With a split, some requests still go to the other cloud, which may run an older commit. Check `x-nbo-edge-backend`.

### "This build's stored output is damaged" / "was cleaned up"

You tried to deploy a stored build. "Damaged" means the saved `.nbo/` failed validation or no longer matches the content id recorded for the build, so NBO refuses to deploy it. "Cleaned up" means retention already deleted it. Either way, redeploy the commit (build it again) and deploy the new build.

## Traffic

### "a transfer is moving traffic right now" … "stop it before setting a split by hand" (409)

Cancel the transfer first, or wait for it to finish.

### "… has no successful deployment yet, so it can't take traffic"

This environment has never deployed successfully (a cloud that did once can take traffic even while a redeploy is pending or after one failed). Redeploy so it gets a working deployment, then set the split. A cloud brought back after it was removed starts over: it needs a new successful deploy first.

### Transfer "failed"

The transfer's error (in the project summary) names the reason. A transfer needs a live build with stored output on the cloud you move from; if that build's output was cleaned up, redeploy it there first, then transfer. Traffic stays at the last step that worked. The usual cause is the build failing on the new cloud; open the build log.

## Speed Insights

NBO core collects the numbers but keeps and shows none: a product built on it supplies the storage and the charts (see [The control-plane](./control-plane.md)). The steps below check the collecting side.

### No numbers anywhere

That is expected with NBO core alone: nothing drains the edge, nothing stores the numbers and nothing computes a score. The edge keeps what it collects in memory (at most 100,000 histograms) until a product built on NBO drains it. To check that collecting works, open your site in a normal browser (not a headless one or a bot) and check in order:

1. The switch is on (`speedInsights: true` in `PATCH /projects/{id}/settings`), and the project's edge address (not the cloud's own URL) is what you opened. Only the edge inserts the script and takes beacons.
2. View the page source: with automatic insertion on, there is a `<script defer src="/_nbo/insights/v1/script.js" …>` before `</head>`. No tag means the page was not a `200 text/html` document, or the response says `cache-control: no-transform`. Use manual mode.
3. `/_nbo/insights/v1/script.js` opens with `200`. A `503` means the edge cannot read its `web-vitals` file (a broken install).
4. The browser's network panel shows a `POST /_nbo/insights/v1/vitals` answered `204` (some metrics are sent at once, the rest when you leave or hide the page). A `204` doesn't prove the edge counted it: a bot's beacon, or one over a limit, gets one too; a host with Speed Insights off answers `404`. INP is only measured after a click or tap.
5. The sample rate is low: a 10% rate means nine in ten views send nothing.
6. To see what the edge holds, call its admin API's `GET /insights/drain` (`?token=<drain token>` on a cluster edge). It answers with the batches and **empties** them, so do this only on an edge nothing else drains.

### The script is blocked (CSP)

The browser console says something like "Refused to load the script … violates the Content-Security-Policy". Your site's policy does not allow inline-inserted scripts. Switch to manual mode and add the tag yourself with your nonce, or allow `script-src 'self'` (the script is served from your own address).

### Inserting the tag broke an inline script

The edge puts the tag before the **first** `</head>` it sees as text, even one inside an HTML comment or a JavaScript string. If your page has that, the page may show broken code. Turn insertion off (manual mode) and place the tag yourself.

### Traffic changes don't reach the edge after enabling Speed Insights

Saving a split, a transfer step or the Speed Insights switch seems to work, but the edge keeps the old split (and `GET /projects/{id}/traffic` may say `edgeInSync: false`). The edge is older than the control-plane: it refuses any `PUT /targets/{host}` body with fields it doesn't know (`id`, `insights`) with a 400, so the **whole** update is rejected, backends and weights included, not just the Speed Insights part. Upgrade the edge first and restart it; the control-plane then re-pushes everything.

## Domains and the public edge

### "edge: NBO_EDGE_DRAIN_TOKEN is required"

Either edge stops with this line. The install's Secret is missing or blank. Run `nbo-server edge reinstall`. The other `edge:` lines are in [Server settings](./server-settings.md#when-nbo-refuses-to-start). Read them with `kubectl -n nbo-edge logs deployment/nbo-edge`.

### A Cloud Run domain stays on "Verify ownership"

Without an edge, a custom domain on Cloud Run goes through a Cloud Run domain mapping, and Google maps a domain only for an account that owns it. The domain's status is `verify_pending` until the account named in the domain's status is a verified owner of the root domain in Google Search Console. The steps are in [Domains without a cluster](./domains.md#domains-without-a-cluster); NBO retries every 5 minutes, and `POST /projects/{id}/domains/{domainId}/check` tries at once.

[Domains and the public edge](./domains.md) covers install failures, "Waiting for DNS", certificate errors (CAA, port 80, rate limits), "Cluster setup is out of date", "This cluster has no public entry yet", and the messages and warnings for domains behind Cloudflare.

## Git and pushes

### The first look at a repository with a deploy key fails

Expected for a new project with a deploy key: NBO made the key pair, but the repository doesn't know the public half yet, so the project waits in `waiting-for-key`. NBO tries again on every poll for an hour, then every 10 minutes for 7 days, and finishes setup (and builds the first commit) as soon as the key works; after 7 days it moves to `needs-setup`. Read the key (`GET /projects/{id}/git`, `credential.publicKey`, or Terraform's `deploy_key_public`), add it to the repository as a read-only deploy key, and wait, or run `nbo-server project retry <id>` to finish at once. A "Host key verification failed" error means the git server's key changed since NBO first saw it; check with the host before you remove its line from `known_hosts` next to the database.

### "the repository moved to another host: give its credential again"

A `PUT /projects/{id}/git` moved the repository to another host, port or scheme without a `credential`. A credential stays with its host, so send it again in the same request.

### "NBO's GitHub App can't reach" owner/name "any more"

Only for a project linked to an older NBO's own GitHub App: the app lost its access to that repository. Give the project a deploy key or a token of its own (`PUT /projects/{id}/git`), and the link is no longer used.

### Pushes arrive late or not at all

NBO asks each repository for new commits about every 45 seconds, so a push can take that long. The per-project webhook (`POST /projects/{id}/webhooks/github`) is faster when GitHub can reach NBO's own address. A delivery answered `ignored` with "NBO has already seen this commit, or a newer one" is a push the poller (or an earlier delivery) already built, or a redelivery; start a manual build to build it again. If nothing arrives, check that polling is on for the project (`pollingEnabled`) and that its credential still works (the setup error or the build log names the git error).

A project linked to an older NBO's own GitHub App builds on the poll only: the app's deliveries to `POST /github/webhook` get `404` (GitHub lists them as failed) and its check runs stopped. That is expected since 2026-11-12. Give the project a credential of its own (`PUT /projects/{id}/git` with a `credential`) and the per-project webhook; see [Upgrading NBO](../production.md#upgrading-nbo).

### A push built but deployed nowhere

No cloud of that environment had automatic deploys on. Turn it on (`PATCH /environments/{id}` with `{"autoDeploy": true}`), or deploy the build yourself (`POST /builds/{id}/deploy`).

## Ephemeral and other environments

The full story is in [Environments](./environments.md), including [Ephemeral environments](./environments.md#ephemeral-environments).

### "Waiting: NBO's weekly limit for ephemeral environments' certificates is reached"

NBO orders at most 20 certificates for ephemeral addresses per registered domain in 7 days, to stay under Let's Encrypt's limits. The address serves over HTTPS once the week allows it. (Earlier versions said "preview certificates"; the next check replaces that wording.)

### A push to a branch doesn't build an ephemeral environment

Check in order:

1. The environment is still running: `GET /projects/{id}/stages` shows it with `removal` empty. Once its removal starts it takes no builds.
2. The push was to exactly its branch, and that branch is not the production branch or a custom environment's (those build only their own environment).
3. NBO hears about the push: the project has its own webhook, or its polling is on.

### "ephemeral environment removed"

Not an error. A build waiting in the queue was skipped because its ephemeral environment was being removed (its end time passed, or someone removed it).

### An ephemeral environment shows removal-failed

Removing its app on its cloud, or its certificate, failed; `removalError` says why. NBO tries again after 10 minutes, then 1 hour, then every 6 hours. Its address stopped routing at the first attempt. To try again now, send `DELETE /projects/{id}/stages/{stageId}`.

### "is already in use"

The full message names an address (`the address "..." is already in use`) or a domain. Two environments or projects would answer on the same address, or the domain belongs to another project. Rename the environment or pick another domain ([Addresses](./environments.md#addresses)).

### "can't contain" "--"

Environment and new project names can't hold two hyphens in a row, because `--` separates the environment from the project in `<environment>--<project>` addresses. Use a single hyphen ([Adding your own](./environments.md#adding-your-own)).

## Page cache

Revalidation answers and what to do are in the table [If it does not work](./cache.md#if-it-does-not-work). The messages:

### "Nothing in this environment uses ISR yet"

`409`. The environment never had a build with ISR pages, so there is no secret. Deploy a build that has a page with `revalidate`.

### "isn't active yet"

`409`. The full message says the address's certificate isn't active yet. NBO won't send the secret over plain `http`. Wait for the certificate ([Domains](./domains.md)).

### "no ISR cache service configured"

`500`. The app has no page cache to talk to. Usually the live build has no ISR page, so none was started; it can also be an image older than the cache feature. Deploy a build that has an ISR page, with the current NBO.

### The old page still shows after revalidating

Usually a browser or CDN cache in front of NBO, or the call went to another address or environment. See the last row of [If it does not work](./cache.md#if-it-does-not-work).

## Upgrades and rolling back

### "built for NBO spec" …

`nbo validate` or a deploy refuses a build written for a newer minor version of the build-output spec than this NBO reads. It happens after a rollback to an older NBO. Rebuild the project with the older NBO. See [Rolling back](../production.md#rolling-back).

### "is not supported; this nbo reads"

The build was made for a different major version of the spec. Rebuild it with the NBO you run now.

### An older NBO will not start on the upgraded database

Running older code on the upgraded database is not supported: it refuses to start once a variable name exists in two environments or names-only variables was turned on. Restore the backup you took before upgrading, then run the older code. The steps are in [Rolling back](../production.md#rolling-back); what to back up first is in [Every upgrade](../production.md#every-upgrade).

### A feature is missing after an upgrade

Some upgrades need an action after the new version runs, for example reinstalling the edge or updating a cluster's setup. [Notes for specific versions](../production.md#notes-for-specific-versions) lists them by date.

### Restoring from a backup fails

Restore both volumes from the same backup, then run the check in [Check a backup](../production.md#check-a-backup).

## Rust edge

### "NBO_EDGE_IMPL must be"

The full message is `NBO_EDGE_IMPL must be "ts" (the default) or "rust"`. The control-plane started fine; only the edge install refused. Fix the value in `.env` and run `nbo-server edge reinstall`. See [Trying the Rust edge](../production.md#trying-the-rust-edge).

### The edge stays on "Waiting for the load balancer's address"

The cluster's load balancer has no address yet. On Hetzner the usual cause is a missing location annotation; the steps are in [Install the public edge](../production.md#5-install-the-public-edge). The Rust edge changes nothing here.

### A browser or client fails over HTTP/2 on the Rust edge

The Rust edge offers HTTP/2 to visitors on port 443; the Node edge doesn't. If a client misbehaves with it (stalls, protocol errors), turn it off on the edge's cluster: `kubectl -n nbo-edge set env deployment/nbo-edge NBO_EDGE_HTTP2=off`. A reinstall of the edge undoes it. See [Trying the Rust edge](../production.md#trying-the-rust-edge) and [Server settings](./server-settings.md).

## Chapters with their own troubleshooting

These chapters keep their fixes next to the feature, so they are linked here and not repeated:

- [Domains and the public edge](./domains.md#troubleshooting): install failures, DNS, certificates, Cloudflare.
- [Terraform](./terraform.md#troubleshooting): endpoint, tokens, traffic ordering.
- [Page cache and revalidation](./cache.md#if-it-does-not-work): revalidation answers.
- [Server settings](./server-settings.md#when-nbo-refuses-to-start): every refusal at start.
- [Creating a Kubernetes cluster](./clusters.md#check-any-cluster-before-connecting): what NBO needs from a cluster.
- [What has been tried for real](./tried.md): what has only run against fakes, so a surprise on real infrastructure is expected there.

## Windows notes

- If C: is nearly full, point `TEMP`/`TMP` (build clones) and `VITE_CACHE_DIR` at another drive, and the database with `NBO_CONTROL_PLANE_DB`.
- Hard-killing `nbo serve` can leave its function child processes running; end stray `node` processes in Task Manager.
- Git converts line endings on checkout (`core.autocrlf`); Prettier's `endOfLine: "auto"` keeps that from showing every file as changed.
