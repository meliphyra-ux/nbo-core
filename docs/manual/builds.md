# Builds

A **build** turns one commit into a `.nbo/` folder, then deploys it everywhere the project runs. This chapter covers the first half: from repository to `.nbo/`. The [Deploying](./deploying.md) chapter covers the second.

## Where builds run

On the same machine as the control-plane, as normal child processes. There's no sandbox: the build command can do anything your user account can. That's acceptable for a single developer and is the first thing that must change before NBO serves other people (see the multitenancy notes in `docs/`).

Builds use your installed `git`, `node`, `pnpm`/`npm`, and `docker`.

## The build record

A row in the `builds` table:

| Column                                    | Meaning                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `id`                                      | `build_` + 16 hex characters                                        |
| `project_id`                              | which project                                                       |
| `revision`                                | the commit SHA                                                      |
| `status`                                  | `queued` → `running` → `succeeded` / `failed` / `skipped`           |
| `log`                                     | everything printed, up to 256 KiB (older text is cut with a marker) |
| `deployment_ids`                          | JSON list of the deployments this build created                     |
| `error`                                   | one-line reason when it failed                                      |
| `created_at`, `started_at`, `finished_at` | timestamps                                                          |
| `commit_info`                             | JSON: commit message, author, date (null for older builds)          |
| `input`                                   | JSON: the settings the build used (null for older builds)           |
| `timeline`                                | JSON: each step with its start and duration (null for older builds) |
| `output_summary`                          | JSON: what `.nbo/` contains (null for older builds)                 |
| `content_id`                              | the content id of the `.nbo/` it produced                           |
| `stage_id`                                | the environment the build is for (older builds: Production)         |
| `artifact`                                | 1 while the build's stored output still exists                      |

## What each build keeps

`GET /builds/{id}` answers one build with its log and details, and `GET /builds/{id}/files` and `/functions` list its output. They read two things recorded during the build:

- **A copy of the build's `.nbo/` output**, kept in the artifact store: `NBO_ARTIFACTS_DIR`, or an `artifacts/` folder next to the database. `/files` and `/functions` read it.
- **Details** stored on the build row. Commit (message, author, date). Settings used: repository, branch, framework, build command and so on. Variable **names** only, marked plain or secret; values are never recorded. Timing for each step (clone, build, deploy and its sub-steps). A summary of the output: framework and version, static file count and size, functions, prerenders, crons, and whether images are optimized.

Capture reads local files only; it makes no extra network or cloud calls.

**Retention.** The newest 20 successful builds of each project keep their output, plus every build that is live on any environment (a build is live on a cloud when that cloud's newest successful deployment ran it), plus any build a deploy is using right now. Older copies are deleted after each build. Deleting a project deletes all its stored output. A build whose output was cleaned up still has its log and details; `/files` answers 404, and a new build of the same commit makes it again.

Builds made before NBO kept details have no details; their logs still work.

## Reading a log as a stream

`GET /builds/{id}/log` answers the stored log as plain text (it is already redacted). Add `?from=<bytes>` to skip that many bytes. Add `?follow=1` and the answer stays open: NBO checks the build every 500 ms, sends whatever was appended, and closes the answer when the build reaches a final status. An unknown build is a 404. Pass `from` the number of bytes you already have to continue where you left off. Logs over 256 KiB are cut with a marker, so a byte offset past the cut can skip text.

## Live builds

The project summary (`GET /projects/{id}/summary`) names, for every cloud, the build it is serving (its live build) and its share of traffic, and names the **production build**: the live build of the cloud with the most traffic. They are worked out from deployments, not stored on the build row.

## Builds per environment

Every commit build belongs to one [environment](./environments.md). A push to the production branch builds Production; a push to a custom environment's branch (with its auto-deploy on) builds that environment; a push to an [ephemeral environment](./environments.md#ephemeral-environments)'s branch builds that one until its removal starts; any other branch is ignored. The branch poller makes one `git ls-remote --heads` call per project each tick and compares every environment's head with the last one it saw. Check for new commits now with `POST /projects/{id}/git/poll` (no body): it runs the same check at once, shares the poller's bookkeeping so a push builds once, and answers the builds it queued; with automatic deploys off it answers a note and reads nothing. The per-project push webhook moves the same last-seen head, with a compare-and-set on the push's `before`: a push builds only when the head NBO last saw is that `before` (or nothing yet, for the first push or a new branch), or when the push is newer than the event that set the head (a manual build or a branch change can leave a head no push names). So a push the poller already built is not built again, and a delivery sent again later, the newest one or an older one, builds nothing: use a manual build (or Redeploy) to build a commit again. GitHub gives a push's time to the second, so two pushes to one branch in the same second, delivered out of order, can leave one of them to the next poll (about 45 seconds). A head that an older NBO stored without a time counts as seen at the upgrade. A build gets its environment's variables and deploys only to that environment's clouds. Starting one by hand (`POST /projects/{id}/builds`) takes an optional `stage`, the environment's name, and builds the head of its branch.

When NBO is set to [keep no variable values](./environments.md#dont-store-variable-values), a push to an environment that has declared variable names is recorded as `skipped` with "Waiting for variable values", because there are no values to build with.

## Promote jobs

Deploying a stored build to a cloud is also a row in `builds`, with `kind` `promote`. It goes through the same queue as normal builds, so a build and a promote of one project never run at the same time. A promote job has no clone and no build command: it validates the stored output and deploys it to one cloud. See [Deploying](./deploying.md#deploying-a-stored-build).

## The queue

**File:** `packages/controlplane/src/builds/build-queue.ts`

- One build runs per project at a time; different projects build in parallel.
- At most one build waits behind it **for each [environment](./environments.md)**. A newer request replaces the waiting build of the same environment only, so a staging push never throws away a waiting Production build. When the running build finishes, Production goes first, then custom environments, oldest first.
- If the control-plane stops mid-build, the build would stay "running" forever. On startup, `recoverInterruptedBuilds` / `recoverInterruptedWork` (`src/v2.ts`) marks such builds failed with "interrupted".

## Step by step: `runBuild`

**File:** `packages/controlplane/src/builds/runner.ts` → `createRunner(...).runBuild(buildId)`

Every command is printed to the log first as `$ command args`, so the log reads like a terminal session. Commands run through `step()`, which has a time limit; on timeout the whole process tree is killed (`taskkill /T /F` on Windows, process group kill elsewhere).

### 1. Clone

```
git clone -- <repo> <temp>/nbo-build-XXXX
git -C <clone> checkout -q <sha>
```

After the checkout, the runner runs `git branch -r --contains <sha>`. The clone is a full one (every branch and tag, but not the `refs/pull/*` refs), so this asks honestly whether the commit is on a branch of your repository. If it is not, for example because it only exists under a tag or in a pull request, the build fails with `commit <sha> is not on a branch of <repo>`. A normal build of a branch tip is as fast as before, because nothing extra is fetched. This also means a full Redeploy of an old commit fails once its branch was deleted, force-pushed away or squash-merged. Promote (deploying a stored build, with no rebuild) still works for rollbacks, as long as the build's stored output is kept.

`gitEnv` (`src/git/gitremote.ts`) disables interactive prompts, so a private repository fails fast instead of waiting for a password forever.

A private repository needs a git credential on the project (`src/git/git-credentials.ts`), set with `credential` on `POST /projects/setup` or `PUT /projects/{id}/git`:

- **Token** (`https://` addresses): an HTTPS access token, with an optional user name. Git gets it as an `Authorization` header for that one repository address, through `GIT_CONFIG_*` variables in the environment of the git steps only (clone, checkout, reading the commit, `ls-remote`), with `http.followRedirects=false` so a redirect can't carry it to another address. The token never goes into the address, an argument, `.git/config` or the build command's environment, and the log and the build error hide it.
- **Deploy key** (`ssh://git@host/path` or `git@host:path` addresses): `POST /projects/{id}/git/deploy-key` makes an SSH key pair and answers the public half; add it to the repository as a read-only deploy key. For each git step the private half is written to a file only NBO can read, used through `GIT_SSH_COMMAND`, and deleted when the step ends. Host keys of github.com, gitlab.com and bitbucket.org are checked against the keys those services publish (`src/git/git-host-keys.ts`, written to `known_hosts.published` next to the database) from the first connection. Any other host is remembered in `known_hosts` next to the database the first time; a changed key is refused either way. A new project whose key isn't on the repository yet waits in the setup status `waiting-for-key`: NBO checks again on every poll for an hour, then every 10 minutes for 7 days (even with deploying automatically off), and builds the first commit once the read works (once, even if a setup retry runs at the same moment) (a project created to skip its first build only records the commit). After 7 days it becomes `needs-setup`.
- **Public**: no credential (the default).

A stored credential stays with its host: a `PUT /projects/{id}/git` that moves the repository to another host, port or scheme without a new `credential` is refused with "the repository moved to another host: give its credential again".

Tokens and private keys are stored encrypted with the secret key; the API shows only the kind, the public key and the user name. Projects linked to an older NBO's own GitHub App keep building with a token NBO asks GitHub for (`src/git/github-legacy.ts`) until they get a credential of their own.

### 2. Find the app folder

`appDir = clone + rootDirectory`. If the result would be outside the clone (`../../etc`), the build fails.

### 3. Ignored build step (optional)

If set, run it in `appDir`. **Exit code 0 means "skip"**: the build ends as `skipped` and nothing deploys. Same convention as Vercel. Typical: `git diff --quiet HEAD^ HEAD ./`.

### 4. Build command

Runs in `appDir` through the shell (so `&&` works), with one extra environment variable:

```
NEXT_ADAPTER_PATH=<repo>/packages/next-adapter/src/adapter.js
```

Next.js 16+ reads this and loads NBO's adapter during `next build`. You don't need to change `next.config.ts`. Other frameworks ignore it.

The build command and the ignored build step also get three variables that say which [environment](./environments.md) the build is for: `NBO_ENV` (its name, such as `production` or `staging`), `NBO_GIT_COMMIT_REF` (its branch) and `NBO_GIT_COMMIT_SHA`. An ephemeral environment's builds get `NBO_ENV=preview`. (Earlier versions also set `NBO_GIT_PULL_REQUEST_ID` for previews; NBO no longer knows about pull requests, so it is gone.) User variables can't use `NBO_*` names, so these can't clash.

**NBO's own settings stay out of builds.** The build command and the ignored build step inherit NBO's environment (`PATH`, `HOME`, proxy settings and so on) minus every `NBO_*` variable, because those name NBO's database, its secret key file, the link's enrolment code and its cloud accounts, and a build runs code from the repository. Three kinds pass: `NBO_ENV`, `NBO_GIT_*` and `NBO_BUILD_ID` (which pins the Next.js build id). NBO then adds `NBO_ENV`, `NBO_GIT_COMMIT_REF`, `NBO_GIT_COMMIT_SHA`, `NEXT_ADAPTER_PATH` and, for the build command, your variables. Only `NBO_*` names are dropped: every other variable in NBO's own environment (for example `GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`, `DOCKER_HOST` or `CLOUDSDK_CONFIG` set for NBO's process) is still inherited by the build until builds are isolated; don't give NBO's process cloud credentials through its environment. Builds are not isolated yet either, so a build can still read files NBO can read.

The build command gets **all** the variables of the build's environment (workspace ones, overridden by project ones; see [Environments](./environments.md#variables-per-environment)), secret or not, so `NEXT_PUBLIC_*` values can be baked into the bundle. Secret values are replaced with `[redacted]` in the build log, even when the output arrives split across chunks. Very short secrets (one or two characters) can over-redact, because every match in the log is hidden. The ignored build step (step 3) runs **without** your project variables.

**A build started by hand** (`POST /projects/{id}/builds`) is a full rebuild: it skips the ignored build step, so it always builds and deploys. Which commit it builds depends on how it's asked:

- `POST /projects/{id}/builds` with `{ "revision": "<sha>" }` rebuilds that exact commit.
- `POST /projects/{id}/builds` with no `revision` in the body reads the production branch's current head again (`git ls-remote`) and builds that. If the branch has moved since the last build, you get the newer commit.

### 5. Produce `.nbo/`

- **Static / React (Vite):** checks the output folder exists (`dist` by default, must be inside the clone), then calls `produce(outputDir, appDir/.nbo, { spa })` from `@nbo/producer-static`.
- **Next.js:** the adapter already wrote `appDir/.nbo` during `next build`. If it's missing, the runner looks one level down for a `.nbo` and, if found, tells you to set **Root directory** to that folder. Otherwise it explains that `NEXT_ADAPTER_PATH` needs Next.js 16+.

### 6. Deploy to every cloud with automatic deploys on

See [Deploying](./deploying.md). Each cloud that has automatic deploys on (`autoDeploy`) is deployed to at the same time as the others, and one failing does not stop the rest; the build fails if any did, with all reasons joined. If every cloud has the switch off, the build still succeeds and keeps its output, and the build page shows a note that it deployed nowhere. You can deploy it to a cloud later (see [Deploying](./deploying.md#deploying-a-stored-build)).

### 7. Clean up

The clone is deleted in a `finally` block, so it goes even after errors.

## The static producer

**File:** `packages/producer-static/src/produce.ts` → `produce(buildDir, outDir, { spa })`

1. `classifyBuildDir(buildDir)` (`classify.ts`) walks every file and works out its URL path (`dist/about/index.html` → `/about/index.html`, also served at `/about/`).
2. For each file, `writer.addStatic(urlPath, filePath, { cache })`. Cache policy from `isHashedAsset(urlPath)`: names with a hash (`app.3f9a2c1b.js`) or anything under `/assets/` → `"immutable"` (browsers cache forever); everything else → `"revalidate"` (browsers check each time).
3. With `spa`, `writer.setFallbackToRoot()` adds a rule: unknown paths serve `/index.html`.
4. `writer.write()`.

## The Next.js adapter

**File:** `packages/next-adapter/src/adapter.js`

Next.js 16 lets a plugin run code after the build, through `onBuildComplete({ outputs, routing, config, repoRoot, projectDir, nextVersion })`. `outputs` lists every page, route, static file and prerender Next produced. NBO's adapter:

1. `addStaticOutputs`: every static output and every file in `public/` (`public-files.js`) becomes a static entry.
2. Unless `output: "export"` (pure static):
   - `assertSlice2Scope(outputs)`: fails clearly on features NBO doesn't support yet.
   - `addSsrFunction`: one function named for SSR, bundling the server code and the files Next traced as needed. An **entry shim** (`entry-shim.mjs`) bridges NBO's `(Request) => Response` style to Next's Node `req`/`res` handler through a loopback server.
   - `addMiddlewareFunction`: Next middleware becomes its own function (`middleware-entry-shim.mjs`).
   - `addPrerenderSeeds` + `translatePrerenders`: ISR pages, meaning their first HTML, and how to regenerate them.
   - `fromNextImages(config.images)`: `next/image` settings (allowed sizes, remote patterns translated to RE2 with `nextPatternToRe2`).
   - `fromNextEnv(process.env)`: records which `NEXT_PUBLIC_*` variables were baked in at build time (names and a digest, never values).
   - `setRoutes`: `translateRoutes(outputs)` and `translateMiddleware(...)` (`translate-routing.js`) turn Next's routing into `routes.json`.
3. `nbo.write()` and prints `nbo: wrote .nbo/ in …ms (content id …)`.

## The output and spec 1.0

Every producer ends by writing the same folder, `.nbo/`. It is cloud-neutral: it says what the app needs, never where it runs, so it holds no cloud names, account ids, region codes or secret values. The format is the **Neutral Build Output spec**, written in `docs/nbo-spec.md` in the repository and now at version 1.0.

```
.nbo/
  manifest.json       spec version, build info, what the app requires, and a digest of every other metadata file
  routes.json         the routing table (six phases, RE2 patterns)
  static.index.json   every static file: digest, content type (required), cache class
  static/             the files themselves, under their site paths (their digests are in static.index.json)
  functions/<name>/   function.json plus bundle/ (entry module, bundle.index.json, dispatch.json, traced files)
  prerender.json      ISR settings; only when the app has prerendered pages
```

- **The version.** `spec/version.json` holds `{ "specVersion": "1.0" }`. The writer copies that into every `manifest.json`, and the validator reads the same file, so the two can't disagree. The format is `MAJOR.MINOR`.
- **The versions policy.** A minor release (1.1, 1.2) only adds optional things, so every 1.x build stays valid for every later 1.x NBO. Anything that removes or renames a field, or changes what a digest or the content id means, is a new major. `nbo validate` checks the version first: another major is refused, and so is a minor newer than the one it knows (it tells you to upgrade NBO), because an older validator can't know a newer minor's fields. Changes are listed in `spec/CHANGELOG.md`.
- **Digests and the content id.** A digest is the SHA-256 of a file's bytes. Every metadata JSON file is written in RFC 8785 canonical form, so the digest of the bytes and of the parsed file agree. The **content id** is the SHA-256 of `manifest.json` with its `build` block (timestamps) removed. The manifest holds the digest of everything else, so two builds with the same output have the same content id, and a deploy of that content id is a no-op.
- **Functions are named, not placed.** A function lives under `functions/<name>/`; URL paths reach it only through rules in `routes.json`.
- **Deterministic builds.** The same commit built twice, with the same inputs, gives the same `.nbo/` and content id. For a static site or a React app that is exact. For Next.js the same content id is expected too, with one allowance: pages the app itself renders at build time (a page that prints the clock, or the saved state of a partially prerendered page) may differ between two builds. Any other difference is a bug that CI reports by path.

## The writer

**File:** `packages/writer/src/writer.ts` → class `NboWriter`

Both producers only call this API, which keeps `.nbo/` consistent:

| Method                                                         | Adds                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `addStatic(urlPath, file, { cache })`                          | a static file (content type from `contentTypeFor` in `content-type.ts`; mandatory) |
| `setFallbackToRoot()`                                          | SPA fallback                                                                       |
| `addFunction(name, { runtime, entryFilePath })`                | a function; returns a builder with `addRoute`, `addFiles`, `addFile`               |
| `setRoutes(routes)`                                            | `routes.json`                                                                      |
| `addPrerender`, `setImages`, `setEnv`, `addBinding`, `addCron` | optional documents                                                                 |
| `write()`                                                      | writes everything, computes digests and the content id                             |

`write()` copies each static file into `static/` at its site path, records its SHA-256 in `static.index.json`, writes the JSON documents in canonical form, builds `manifest.json` with the digest of each document, and returns `{ contentId }`.

## Validation

**File:** `packages/validate/src/index.ts` → `validate(dir)` returns a list of errors (empty = valid). It runs before every deploy and checks:

- the spec version first: a manifest built for a newer minor version of the spec than this NBO reads is refused ("upgrade NBO"), and so is another major version;
- every JSON file against its schema in `spec/` (`schemas.ts`), rejecting unknown fields and the names the spec reserves for later; keys starting with `x-` are allowed only when the manifest declares them in `requires.extensions`;
- every JSON file is in canonical form (RFC 8785), so a digest of the bytes and a digest of the parsed file agree;
- every digest in `manifest.json` matches the file (`digests.ts`), and every static file is listed; the same for each function's bundle, where every file must be listed in `bundle.index.json` (`dispatch.json` too, except as a warning in older builds); `manifest.json` must name `routes.json`, `static.index.json` and every function's `function.json`;
- references: rewrites, middleware, prerenders and crons name functions that exist, and seeds and the 404 page name files that exist;
- route patterns are RE2-compatible (`routes.ts`), without the JavaScript-only escapes;
- functions have a valid `function.json` and bundle (`functions.ts`);
- cron schedules are valid (`crons.ts`): five fields, numbers, `*` or `*/N`;
- nothing looks like a leaked secret: long high-entropy strings (`store/secrets.ts`).

A few checks are warnings, not errors, so builds stored before spec 1.0 keep deploying (today: a static file under `/_nbo/`, a `dispatch.json` that an older build left out of its bundle listing, and a prerender id used twice). `nbo validate --strict` makes warnings errors; CI uses it on fresh builds, and you can run it by hand on any `.nbo/` folder.

Image requests (`/_nbo/image`) use the build's `images` block as an allowlist: a width or quality that the block doesn't list gets `400`, and a block with no widths or no qualities allows none. A missing `minimumCacheTTLSec` means resized images are not stored. Local images follow Next: with no `localPatterns` in your `next.config`, every image in your site can be resized.
