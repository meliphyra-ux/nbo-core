# Continuous integration (GitLab)

NBO's checks run in GitLab through `.gitlab-ci.yml`. This page says what runs and when, what it costs, and what you set up once for the Cloud Run check.

Status: the pipeline file and its scripts are written and tested locally (`pnpm test:ci`). No real GitLab run has happened yet, and the Cloud Run job has never run. The harness counts as proven once a real `kubernetes` run and a real `cloudrun` run are both green.

## The 10 jobs

| Job                  | Stage       | When it runs                                                                                            | What it does                                                                                                                                                                                                           |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-checks`        | check       | every pipeline                                                                                          | Build, type-check and test the whole workspace, then `pnpm test:ci` (tests of the CI scripts themselves) and `pnpm docs:check` (links, repo paths, server settings and the API table in the docs)                      |
| `lint`               | check       | every pipeline                                                                                          | `pnpm lint`. Blocks the pipeline                                                                                                                                                                                       |
| `terraform-provider` | check       | every pipeline                                                                                          | `go vet` and `go test` in `packages/terraform-provider`                                                                                                                                                                |
| `rust`               | check       | every pipeline                                                                                          | `cargo fmt --check`, clippy, tests, and a release build of the Rust edge                                                                                                                                               |
| `edge-rust-blackbox` | check       | the nightly schedule; by hand on protected `main`                                                       | Runs the edge black-box suite against the Rust binary from `rust`                                                                                                                                                      |
| `determinism-static` | determinism | every pipeline                                                                                          | Builds the static site and the React app twice (`scripts/verify-step0.sh`); the content ids must match and each build must pass `nbo validate --strict`                                                                |
| `determinism-next`   | determinism | `main` and the nightly schedule; not merge requests or other branches                                   | Builds the two Next.js fixtures twice (`scripts/ci/determinism-next.sh`). The content ids must match, or differ only in pages the app rendered at build time (see below); each build must pass `nbo validate --strict` |
| `kubernetes`         | targets     | the nightly schedule; by hand on protected `main`. Never on merge requests or other branches            | The Next.js harness against `nbo serve`, then against a throwaway kind cluster made inside the job                                                                                                                     |
| `cloudrun`           | targets     | protected branches only, with the Google key set: schedules, or a manual start. Never on merge requests | The same harness against real Cloud Run. Deletes everything it made afterwards                                                                                                                                         |
| `cloudrun-janitor`   | targets     | schedules only, same conditions as `cloudrun`                                                           | Deletes leftover `ci-` services and images older than 3 hours                                                                                                                                                          |

A larger workspace may add jobs through an optional local `include` (skipped when its file is absent), and `scripts/ci/check-pipeline.mjs` checks the included jobs with the same rules.

The pipeline uses only committed files. A job never commits, pushes, stashes or resets.

## Next.js determinism

Two builds of a Next.js fixture can't always match exactly: pages that print the clock are rendered again on each build, and the partial prerendering resume state carries the time each `"use cache"` entry was made. Inside a container, as on GitLab's runners, Next also makes new draft-mode keys and a new server-actions key on every build; it keeps them in `.next/cache` only outside a container, so the cache never makes them stable in CI. The script therefore gives every build of a run one random `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (a key you set yourself wins), and the draft-mode keys, which Next lets nobody supply, are allowed to differ. `determinism-next` passes when the content ids match, or when the only differences are those build-time renders (prerender seed files in `static.index.json`, `x-nbo-ppr.postponedState` in `prerender.json`) or draft-mode keys (`.next/server/preview-props.json` and the `preview` keys of `.next/prerender-manifest.json` in a function bundle, and the digests they move); it prints `deterministic apart from build-time renders: <fixture>`, the paths, and the draft-mode key files under `Next draft-mode keys (allowed):`. Any other difference fails the pipeline and names every differing path. The rule is the spec's Determinism section (`docs/nbo-spec.md`); `scripts/ci/nbo-diff.mjs --classify` applies it. A fixture with no `.next/cache` yet (a fresh runner) gets one warm-up build first, because builds 1 and 2 must start from the same cache (outside a container that cache also holds the keys); on a failure the log lists the bundle entries that differ.

## What it costs

GitLab.com's hosted runners count a medium runner minute as 2. Since 2026-11-16 a merge request pipeline runs only the fast checks (the slow `kubernetes`, `edge-rust-blackbox` and `determinism-next` jobs moved to `main`, the nightly schedule or a manual start), so it costs about 20 counted minutes; a nightly run with `kubernetes` costs about 60. The Free tier gives 400 minutes a month. Your options:

- Buy minutes.
- Keep `kubernetes` manual on more branches (edit its `rules`).
- Register your own runner. Jobs on it use no GitLab minutes. It needs the Docker executor with `privileged = true`, at least 4 CPUs, 8 GB of memory (16 GB is better), 30 GB of free disk and outbound internet. The Hetzner machine can host one. Only this Docker executor setup is supported: the `kubernetes` job makes its kind cluster inside its own Docker-in-Docker service, and a shell executor would share the host's Docker, ports 80 and 443 and cluster names with everything else on that machine.

The jobs tagged `saas-linux-medium-amd64` (`rust`, `kubernetes`, `cloudrun`) need that tag on your own runner too, or you change the tag in the file.

Google Cloud, per Cloud Run run: five services for about 15 minutes and some images, all deleted within the hour. It fits the free tier and costs a few cents in storage. A nightly schedule should stay under 1 US dollar a month.

## Set up Cloud Run checks (once)

Skip this and `cloudrun` and `cloudrun-janitor` simply never run.

1. Make a new Google Cloud project used only for CI, with billing linked. The cleanup script deletes anything starting with `ci-` in it, so never reuse a project that holds real sites.
2. In that project, enable the APIs and create the image repository and a service account. Replace `PROJECT` and the region as needed:

   ```
   gcloud config set project PROJECT
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com
   gcloud artifacts repositories create nbo-ci --repository-format=docker --location=europe-west1
   gcloud iam service-accounts create nbo-ci --display-name="NBO CI"
   ```

3. Give the account its three roles. The first two:

   ```
   SA=nbo-ci@PROJECT.iam.gserviceaccount.com
   gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:$SA --role=roles/run.admin
   gcloud artifacts repositories add-iam-policy-binding nbo-ci --location=europe-west1 --member=serviceAccount:$SA --role=roles/artifactregistry.repoAdmin
   ```

   The cleanup deletes only Cloud Run services and images, never service accounts (`nbo deploy` doesn't create any), so the account needs no IAM list or delete rights.

   The third role is `roles/iam.serviceAccountUser` on the project's default compute service account, which is how Cloud Run services get deployed. Find that account with `gcloud iam service-accounts list` (its name looks like `1234567890-compute@developer.gserviceaccount.com`) and run:

   ```
   gcloud iam service-accounts add-iam-policy-binding 1234567890-compute@developer.gserviceaccount.com --member=serviceAccount:$SA --role=roles/iam.serviceAccountUser
   ```

4. Make a key and download it: `gcloud iam service-accounts keys create nbo-ci-key.json --iam-account=$SA`. Treat the file like a password. Delete your copy after step 5.
5. In GitLab, open Settings, CI/CD, Variables, and add these four. For each, tick Protect variable (so only protected branches see it). Tick Mask where GitLab allows it.

   | Variable             | Type     | Value                                        |
   | -------------------- | -------- | -------------------------------------------- |
   | `NBO_CI_GCP_KEY`     | File     | the whole contents of `nbo-ci-key.json`      |
   | `NBO_CI_GCP_PROJECT` | Variable | the CI project id                            |
   | `NBO_CI_GCP_REGION`  | Variable | `europe-west1` (or your region)              |
   | `NBO_CI_AR_REPO`     | Variable | `europe-west1-docker.pkg.dev/PROJECT/nbo-ci` |

   `NBO_CI_GCP_PROJECT` matters most: the cleanup script refuses to delete anything unless it matches the project the job is using, which proves the project is the CI one. A File variable can't be masked; keep it protected.

6. Make sure `main` is a protected branch (Settings, Repository, Protected branches). It usually is by default.
7. Start one `cloudrun` job by hand on `main` (Build, Pipelines, Run pipeline, then the play button on `cloudrun`). Watch it. If it fails, the log is kept for a day as a job artifact.
8. Add the schedule: Build, Pipeline schedules, New schedule, target branch `main`, for example every night at 03:00. The schedule runs `cloudrun`, `cloudrun-janitor`, `kubernetes`, `edge-rust-blackbox` and `determinism-next`. The janitor only does work when something was left behind.

## How the jobs prepare themselves

- A fresh clone has no built packages. Each determinism job first builds what its script imports (`pnpm --filter "@nbo/cli..." --filter "@nbo/producer-static..." build`, or `@nbo/next-adapter...` for the Next.js half), and the checker refuses a determinism job without a build that covers `@nbo/writer`. `determinism-next` keeps its `.next/cache` under its own cache key.
- `scripts/ci/install-tools.sh` writes `.ci-tools/env.sh`, and the next line of the job sources it (`. .ci-tools/env.sh`). With `--gcloud` that also puts the Google Cloud SDK's own `bin` folder on `PATH`, which holds `docker-credential-gcloud`: Docker needs it to push to Artifact Registry. `cloudrun`'s `after_script` sources it again.
- `NBO_KIND_CLUSTER` names the kind cluster `nbo deploy` loads images into (default `nbo-local`, so nothing changes on your machine). The `kubernetes` job sets it to `nbo-local`, the cluster it makes inside Docker-in-Docker. The harness refuses to run when that name and the kube context it checked (`kind-<name>`) don't match, so images can never land in a different cluster from the one it tests.
- After each Kubernetes deploy the harness waits for `kubectl rollout status` on the app and each of its function Deployments (180 s), then for an HTTP 200 through the ingress (up to 90 tries, 2 s apart), before any check runs.

## Reading a failed job

The harness prints one line per check and ends with `all checks passed` on success. On failure its last line names the check that stopped it. The two target jobs also keep `harness.log` as an artifact for a day (developers only). Open the job, scroll to the last `FAIL` or `error` line and start there.

## What isn't proven yet

- No real GitLab run has happened. Push a branch, open a merge request, and watch `node-checks`, `terraform-provider`, `determinism-static` and `kubernetes` go green.
- The local rehearsal (`scripts/ci/rehearse-kubernetes.sh`, which runs the `kubernetes` job in Docker containers shaped like the runner) passed end to end on 2026-11-12 in 656 s: `nbo serve` (3 suites, 8 checks) and kind (3 suites, 7 checks), with Docker Desktop given 16 GB of WSL memory. Earlier runs failed when Windows went to sleep mid-job (on resume Docker's disk was read-only, `EROFS`, and its engine died, exit 125) and when Docker Desktop's VM ran out of memory during the `ppr-app` deploy at a 10 GB limit. The rehearsal keeps Windows awake while it runs (`NBO_REHEARSE_KEEP_AWAKE=0` turns that off) and prints `[rehearse HH:MM:SS]` before each job line, so a saved log shows where the time went.
- A fresh Docker-in-Docker pulls every image cold, so the kind bootstrap waits up to 600 s for each set of pods (`NBO_BOOTSTRAP_WAIT_TIMEOUT` changes it). The old 180 s was too short for the ingress-nginx controller on a slow connection.
- `cloudrun` has never run against Google.
- The `slice4-image` suite (`next/image`) is not in the harness yet, because the test image it needs in the `next-app` fixture's public folder is not committed yet. When it is committed, adding the suite is one line in `scripts/ci/next-harness.sh`.

## Commands

- `pnpm test:ci` runs the tests of the CI scripts (`scripts/ci/__tests__`), with fake `gcloud`, `kubectl` and `docker`. It touches no real cloud.
- `node scripts/ci/check-pipeline.mjs` (add `--file path` for another file) checks `.gitlab-ci.yml` against the safety rules: pinned images, the three refusing rules and `resource_group` on every job that sees the Google key, cleanup in `after_script`, `allow_failure` only where allowed, and no git writes. `pnpm test:ci` runs it too.
- `scripts/verify-headless.sh` (not a pipeline job; it needs the local kind cluster from `scripts/bootstrap-local-k8s.sh`) takes a fresh core with no web interface from an empty database to a live site, using only `nbo-server`, the API and `curl`: it starts the edge and the control-plane in dev mode on a temporary database, runs `nbo-server status`, makes a token with `nbo-server token create`, sets up the public static-site repository named by `NBO_HEADLESS_REPO_URL` on local Kubernetes with that token, waits up to 15 minutes for the first build, checks the page through the edge, keeps the traffic split at 100% with `nbo-server api`, then deletes the project and its cluster objects. `NBO_HEADLESS_BUILD_COMMAND`, `NBO_HEADLESS_OUTPUT_DIR` and `NBO_HEADLESS_EXPECT` (text the page must contain) fit it to the repository. A command after `--` runs against the same running core with `NBO_ENDPOINT` and `NBO_TOKEN` set, for example the Terraform acceptance test. It passed on 2026-11-12 against `https://github.com/octocat/Spoon-Knife`. That repository has no build step and no `package.json`, so the default build command fails there: that run set `NBO_HEADLESS_BUILD_COMMAND` (and `NBO_ACC_BUILD_COMMAND`, for the Terraform test) to a command that copies its two files into `dist`, such as `node -e "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});for(const f of ['index.html','styles.css'])fs.copyFileSync(f,'dist/'+f)"`, and `NBO_HEADLESS_EXPECT` to text from its page.
- `pnpm docs:check` (`scripts/docs/check-docs.mjs`, `--only links,paths,env,api` runs part of it) checks the docs against the code: links and repo paths, the server settings (`NBO_*`) against the code, and the API table's control-plane rows against `http/access.ts` (the rows for the edge's admin API and public paths are not checked: both edges match those paths by hand, so keep the rows in step when an edge changes). It runs in `node-checks` after `pnpm test:ci`. The in-app manual's own checks (`docs-integrity`, including the "Not tried for real yet." label) run with the dashboard tests.
