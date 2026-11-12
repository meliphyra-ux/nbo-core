# Running NBO for development

This chapter is about **dev mode**: running NBO on your own computer to try it or to work on its code. Dev mode deploys to a local kind cluster and gives sites addresses like `name.127.0.0.1.sslip.io`. To run NBO for real sites, with your own domains and certificates, read [Launch NBO on a server](../production.md) instead.

## What you need installed

| Tool                        | Why                                                                             | Needed for         |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| **Node.js 24** and **pnpm** | Runs everything; installs packages.                                             | Always             |
| **Git**                     | The control-plane clones repositories and asks remotes for their newest commit. | Always             |
| **Docker**                  | Builds images; runs the kind cluster.                                           | Deploying anywhere |
| **kind** and **kubectl**    | Local Kubernetes cluster and the tool to control it.                            | Kubernetes         |
| **gcloud** (logged in)      | Pushes images and deploys to Cloud Run.                                         | Cloud Run          |

You don't need both clouds. With only Docker + kind you can deploy to Kubernetes; with only gcloud, to Cloud Run.

## First-time setup

```bash
pnpm install          # install every package's dependencies
pnpm build --force    # compile every package to dist/
```

`--force` skips Turborepo's cache. Use it after pulling changes: the cache for some packages doesn't restore `dist/`, so a cached "build" can leave old code in place.

For Kubernetes, create the local cluster once:

```bash
./scripts/bootstrap-local-k8s.sh
```

It creates a kind cluster named `nbo-local` and installs ingress-nginx and cert-manager. On machines using cgroup v1 it needs the node image `kindest/node:v1.31.4`.

For Cloud Run, log in once with `gcloud auth login` and pick a project with `gcloud config set project <id>`. A Cloud Run cloud with `"mode": "auto"` in the project's setup then enables the APIs and creates the registry for you.

## Starting the three servers

Open three terminals at the repository root.

**1. Edge**

```bash
node packages/edge/dist/main.js
```

Listens on `9443` for visitors and `127.0.0.1:9444` for its admin API. This is the Node edge, the default.

The Rust edge is the same program written in Rust, with the same ports, settings and admin API. Build it once with Cargo and run its binary instead:

```bash
cd packages/edge-rs && cargo build --release
./target/release/nbo-edge
```

On Windows the binary is `nbo-edge.exe`. Use one or the other, never both. Which one NBO installs on a real cluster is a different setting, `NBO_EDGE_IMPL` (see [Server settings](./server-settings.md)).

**2. Control-plane**

```bash
NBO_CONTROL_PLANE_DB=./nbo.db node packages/controlplane/dist/main.js
```

Listens on `127.0.0.1:8081`. Creates the database file if it doesn't exist and upgrades older ones automatically (`src/migrate.ts`).

**3. Check that it answers**

```bash
curl http://127.0.0.1:8081/healthz
```

It answers `{"ok":true}`. The API is at plain paths on that address, for example `http://127.0.0.1:8081/projects`. NBO has no web page of its own: you drive it through the API, Terraform or `nbo-server`, and the control-plane never has to be reachable from outside your machine.

**4. Add a project**

`nbo-server` is the operator's command (`node packages/controlplane/dist/server-cli.js`; inside the Docker image it is simply `nbo-server`). Describe the project as the body of `POST /projects/setup` in a file:

```json
{ "name": "hello", "repo": "https://github.com/you/hello.git", "productionBranch": "main",
  "framework": "static", "buildCommand": "npm ci && npm run build", "outputDir": "dist",
  "clouds": [{ "target": "kubernetes" }] }
```

```bash
node packages/controlplane/dist/server-cli.js project setup --body-file site.json
node packages/controlplane/dist/server-cli.js api GET /projects/summary
```

The second command shows the build's progress. Once it has deployed, the site answers at `http://hello.127.0.0.1.sslip.io:9443`. `node packages/controlplane/dist/server-cli.js help` lists every command; `api <METHOD> <path>` sends any API request.

Start the edge before the control-plane if you can. If you don't, nothing breaks: the control-plane re-sends every project's traffic split to the edge once it's reachable.

This is dev mode, for working on your computer. For real sites, see [Launch NBO on a server](../production.md).

## Settings (environment variables)

All settings are environment variables, read at startup. Every one of them, with its default, where it is read and whether you can change it on a running server, is in [Server settings](./server-settings.md). For your own computer you need only these:

- `NBO_CONTROL_PLANE_DB` is required: the path of the control-plane's database file.
- `TEMP` or `TMPDIR` is where build clones go; point it at a roomy disk.

## Everyday commands

| Command (at the repo root)                            | What it does                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm build`                                          | Compile all packages.                                                                |
| `pnpm test`                                           | Run every package's tests.                                                           |
| `pnpm lint`                                           | ESLint across the repository.                                                        |
| `pnpm check-types`                                    | TypeScript type check without writing files.                                         |
| `pnpm --filter @nbo/router test`                      | Tests for one package only.                                                          |
| `npx prettier --write <path>`                         | Format files.                                                                        |
| `pnpm docs:check`                                     | Check that the manual and repo docs match the code (links, paths, routes, settings). |
| `./scripts/verify-step0.sh`                           | End-to-end check: build fixtures twice (same content id?), validate, serve.          |
| `./scripts/verify-slice1.sh` … `verify-slice5-ppr.sh` | Bigger end-to-end checks against the kind cluster.                                   |

### The `nbo` command

`packages/cli` builds a command you can run by hand: `node packages/cli/dist/main.js <command>`.

| Command                                         | What it does                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `serve <.nbo dir> [--port 4000]`                | Serve a `.nbo/` folder locally, exactly as a container would. Functions run as local child processes. |
| `validate <.nbo dir> [--strict]`                | Check the folder against the spec. `--strict` turns warnings into errors.                             |
| `plan <.nbo dir> --target kubernetes\|cloudrun` | Show whether a cloud can run this build.                                                              |
| `deploy …`                                      | Deploy without the control-plane.                                                                     |
| `conformance <dir> <baseURL> [--insecure]`      | Replay recorded HTTP transcripts against a running app.                                               |

## After changing code

| You changed                                                                  | Do this                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Any other package                                                            | `pnpm --filter @nbo/<name> build`, then restart the program that uses it (control-plane or edge). |
| Something inside deployed containers (`cli`, `serve`, `router`, `funcproxy`) | Rebuild, then redeploy a project; the image copies the CLI's `dist/` at deploy time.              |
