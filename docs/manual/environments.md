# Environments and variables

An **environment** is one version of your site with its own branch, its own variable values and its own address. NBO gives every project three built-in ones, and you can add your own, such as `staging`. This chapter also covers **variables**, the named settings (API keys, database addresses) your site reads, because each one belongs to an environment.

One naming note. This manual says **environment**. NBO's API, its code and Terraform say **stage**, because "environment" in the API already means one cloud a project runs on (a row of `GET /projects/{id}/traffic`). When you read `stage` in a request, it means what this manual calls an environment. A cloud row is a **cloud** in this manual.

## The built-in environments

| Environment | What it does |
| --- | --- |
| **Production** | Everything NBO did before environments existed. Its branch is the project's production branch (`PUT /projects/{id}/git`), its clouds and traffic split are the project's clouds and split (`/projects/{id}/traffic`), its address is the project address. |
| **Preview** | The variables every [ephemeral environment](#ephemeral-environments) uses. Preview itself is not an environment with one branch and one address: each ephemeral environment is a short-lived environment of its own that uses these values. |
| **Development** | Variables only. It never deploys. `GET /projects/{id}/env` gives you its plain values, for example to write a `.env` file for your laptop. Secrets are listed by name with no value, because NBO never hands a secret back. |

Projects you made before this version have everything under Production: the same clouds, builds, domains and variables. Nothing changed for them.

## Adding your own

> **Not tried for real yet.** Custom environments, their addresses, certificates, variables and teardown ran against fakes and local tests. No real cluster or Google project has built, served or deleted one.

Add one with `POST /projects/{id}/stages` (or Terraform's `nbo_stage`), with `{ "name": "staging", "branch": "develop", "clouds": [...] }`:

- a **name**: 1 to 16 characters, lowercase letters, digits and hyphens (never two hyphens in a row), starting with a letter and not ending with a hyphen. It can't be `production`, `preview` or `development`, can't start with `pv-`, can't have `fn` as a part between hyphens (`fn`, `a-fn`, `fn-b`), can't be exactly two characters long (an address like `qa--shop` is a kind of web address that certificates can't be issued for; environments named that way before keep working), and can't be changed later;
- a **branch**, such as `develop`. One branch feeds one environment, so it can't be the production branch or another environment's branch;
- one or more **clouds**, written as in `POST /projects/setup`.

Adding an environment builds nothing. The first build comes from the next push to its branch (NBO notices within about 45 seconds, or at once through the GitHub webhook), or by starting a build of that environment from the API or Terraform. The first successful deploy gets all of that environment's traffic.

Each environment has its own switch, `autoDeploy` (`PATCH /projects/{id}/stages/{stageId}`). Off, a push to its branch builds nothing.

An environment has its own cloud rows, so it can run on Cloud Run, on a cluster, or on several. Their names look like `s-staging-cr` (Cloud Run), `s-staging-k8s` (the first cluster) or `s-staging-k-1a2b3c` (another cluster, with six letters or digits taken from its id); you only see these in the Traffic section of the API and in Terraform. Environments other than Production have no cloud-to-cloud transfers; you change the split from the API or Terraform.

With the public edge, a cluster other than the edge's own is reached only through its relay. NBO refuses to add such a cluster to an environment until you enable public entry for it (`nbo-server cluster relay <id> --confirm-billing`), the same rule transfers follow.

### Addresses

Every environment gets its own address. Production keeps `shop.apps.example.com`. A custom one gets `staging--shop.apps.example.com` (two hyphens). In local development it is `staging--shop.127.0.0.1.sslip.io`. The wildcard DNS record you already made for the base domain covers all of them, as [Launch NBO on a server](../production.md) describes.

You can add your own domains to an environment too. Send the environment's name as `stage` when you add the domain (`POST /projects/{id}/domains`). Custom domains for any environment other than Production need the public edge, because Cloud Run domain mappings are for Production only. See [Domains and the public edge](./domains.md).

Because every address is a different name under your base domain, **each environment address takes its own Let's Encrypt certificate**. Let's Encrypt limits how many certificates one domain can get per week, so adding many environments to many projects in one week can hit the limit. Waiting a few days clears it.

### What is different from Production

- **Crons** run only on Production, so a staging app doesn't run your scheduled jobs a second time.
- **Speed Insights** collects only on Production hosts.
- **Builds** run one at a time per project. Production goes first, then custom environments, then ephemeral ones, so a staging build can wait behind a Production one. A newer staging push replaces only a waiting staging build, never a waiting Production one.
- **Build commands** get three extra variables: `NBO_ENV` (the environment's name), `NBO_GIT_COMMIT_REF` (its branch) and `NBO_GIT_COMMIT_SHA`. The Ignored Build Step gets them too (before, it got nothing).
- **Deploying a chosen build** can target any environment's cloud. It uses the variables of the environment you deploy to. Values used during the build itself stay as they were, so a build made for another environment keeps what it baked in.

### Removing an environment

`DELETE /projects/{id}/stages/{stageId}`. It removes the environment's variables, domains, cron records and edge address, and keeps its builds in the history, labelled "deleted environment". Add `?resources=true` to take down what it runs; without it the services keep running by themselves. NBO refuses while a build for that environment is queued or running, and only deletes that environment's own services, never Production's.

## Ephemeral environments

An **ephemeral environment** is a short-lived copy of your site: its own branch, its own address and an end time. NBO removes it by itself when the end time passes, so a forgotten one never keeps running (and costing cloud money). They suit preview deployments of branches and pull requests: make them through the API, for example from a CI job.

Make one with `POST /projects/{id}/stages`:

```json
{ "kind": "ephemeral", "branch": "feature/login", "hostLabel": "feature-login", "clouds": [{ "target": "kubernetes" }], "ttlHours": 72, "label": "pr #12" }
```

- **hostLabel** makes the address `<hostLabel>--<project>.<base domain>`, such as `feature-login--shop.apps.example.com`. It follows the environment name rules (lowercase letters, digits and hyphens, starting with a letter, never two hyphens in a row, not exactly two characters) and can be up to 40 characters. An address already in use is refused with "that address is taken".
- **ttlHours** (1 to 2160, so at most 90 days) or **expiresAt** (an exact time, at most 90 days ahead) sets the end time. Give exactly one. `PATCH /projects/{id}/stages/{stageId}` with `{ "expiresAt": "..." }` moves it later or earlier.
- **label** is free text up to 200 characters that NBO shows and never reads.
- **clouds** names exactly one cloud.

NBO names it `pv-` plus 8 characters and builds nothing yet. The next push to its branch builds it (or `POST /projects/{id}/builds` with its name as `stage`), with **Preview's variables** and `NBO_ENV=preview`. A branch can have only one ephemeral environment at a time, and not the production branch or a custom environment's branch. It takes no custom domains and no traffic split, and like other environments it runs no crons.

**Removal.** Every 10 minutes NBO removes each ephemeral environment whose end time has passed; `DELETE /projects/{id}/stages/{stageId}` removes one now (it answers 202 and works in the background). Removal takes its address off the edge at once, then deletes its certificate and its own app on its cloud, and nothing else: never Production's or another environment's services. The environment stays in the list as `removed` (with `removedAt`) for 7 days, and its builds stay in the history; after that `GET /projects/{id}/stages?all=1` still lists it. If a step fails, it is retried after 10 minutes, then 1 hour, then every 6 hours, and the environment shows `removal-failed` with the reason. `GET /projects/{id}/stages` lists them with `expiresAt`, `label`, `removal` and `removedAt`.

**Certificates.** Each ephemeral address takes its own Let's Encrypt certificate. NBO orders at most 20 of them per registered domain in any 7 days, so Production and its renewals keep room under Let's Encrypt's weekly limit of 50. One over the limit is served over HTTP with a warning until the week has room.

**Previews made by an earlier NBO** become ephemeral environments when NBO upgrades. Each keeps its address, its cloud and its builds. Its end time is its last push plus the project's old preview expiry (7 days unless you changed it), and its label is `pr #<number>` or its branch. One whose end time has already passed, or that was waiting to be removed (its pull request closed or its branch deleted), is removed on the first pass after the upgrade. One whose removal had failed keeps its retry count. NBO itself no longer creates previews, reacts to pull requests or removes a preview when its branch is deleted: a remaining preview keeps building pushes to its branch until its end time, and later pushes no longer extend it. The old preview settings and lists stay in the database, unused.

## Deleting a project

`DELETE /projects/{id}` removes the project from NBO: its builds, clouds, environments, settings and its address on the edge. This can't be undone. Add `?resources=true` to take down the Kubernetes apps and Cloud Run services too; without it they keep running until you remove them yourself. Images in the registry are kept either way. To delete one environment instead, see [Removing an environment](#removing-an-environment) above.

## Page cache and revalidation secret

Each environment has its own page cache and its own revalidation secret, so `staging` can't refresh Production. Details in [Page cache and revalidation](./cache.md).

## Variables per environment

Each variable belongs to **All environments** or to one. `PUT /projects/{id}/env/{name}?stage=staging` (or `/workspace/env/{name}`) sets it for one environment; `?stage=*` means all of them. Setting it for several environments makes one row per environment. `GET /projects/{id}/env` lists each row with its environment.

For a given environment the most specific value wins, from weakest to strongest:

1. workspace, all environments
2. workspace, this environment (only for the three built-ins, since a workspace variable belongs to no project)
3. project, all environments
4. project, this environment

The first deploy after upgrading keeps everything as it was: **every variable you had before is now a Production variable.** Preview and staging start with none, so a branch build never receives your production secrets by surprise. If staging needs the same values, add them.

**You can't go back by just running older code.** An older NBO on this upgraded database is not supported: once a variable name exists in two environments, or you have used names-only variables, it won't start. To roll back, restore the backup of the volumes you took before upgrading (see [Launch NBO on a server](../production.md)).

Changes apply on the next deploy, as before. A custom environment's required variables (`env.required`) are checked against its own set before it deploys.

## Don't store variable values

Some teams keep their secrets somewhere else, such as Terraform or a vault, and don't want NBO's database to hold any. The workspace setting **Don't store variable values** switches NBO to keeping only names. Turn it on from the server: `nbo-server api PATCH /system/workspace-settings --body-stdin` with `{"storeEnvValues": false, "confirm": "delete values"}`.

### What changes

- NBO keeps each variable's **name**, its environment and whether it is secret. It no longer keeps any value.
- You send the values **with each deploy**: `values` in the body of `POST /projects/{id}/builds`, `POST /builds/{id}/deploy` and `POST /projects/{id}/transfer`. With Terraform, `nbo_deployment` takes `values_wo` or `values` (see [Terraform](./terraform.md#keeping-values-out-of-nbo)). With no names declared, no values are needed.
- A deploy must give a value for every name its environment declares, and only those names. Otherwise NBO refuses and lists the names.
- Values live in memory while the job runs and are dropped when it ends, however it ends. If the control-plane restarts mid-build, that build is marked failed and you deploy again.
- The values reach the build command, and then the running app: the Kubernetes Secret `<app>-env`, or Cloud Run's Secret Manager and environment file. Cloud Run's file is written to a private temporary file for a moment, because `gcloud` needs a path, and deleted straight after. So the promise is "not in NBO's database, logs or build records", not "never on any disk".
- They never go into the database, the build record (it lists names only), the stored build output's details, error messages or build logs. Secret values are always hidden from logs. In this mode **plain values of 6 or more characters** are hidden too. A plain value shorter than that, such as `true` or `prod`, can appear in a log if your build prints it, because hiding it would garble every log.
- The keyed fingerprint (a hash that can't be reversed without NBO's secret key) is still recorded, so "already live" still works. The fingerprint route answers `null`, because NBO can't compare values it doesn't have.
- A framework can still put values into its own output. A Next.js `NEXT_PUBLIC_*` value is written into the JavaScript, so it is in the stored build output. Those values are public by design.

### What it costs

- **Pushes don't deploy environments that have names.** With no values, NBO can't build on its own, so a push to such an environment's branch is recorded as skipped with "Waiting for variable values". Deploy from Terraform or the API instead. An environment with no declared names still builds on push.
- **You send values every time** you deploy.
- **Turning it on deletes every stored value**, for every project and environment, secrets included. The request must say `"confirm": "delete values"`. It can't be undone: turning it off again keeps the names but each row has no value until you set one.
- **A name with no value lets a lower level show through.** After you turn the setting off again, a project variable that has a name but no value is skipped, so the workspace value of the same name is used. Set a value, or delete the name, if you don't want that.
- **Only the server can change the setting.** It is a `local` route: API tokens get 403 on it.

### Running sites keep their values

Turning the setting on touches only NBO's own database. It does not delete or change the Kubernetes Secret `<app>-env` or the Secret Manager entries of apps that are already running, so a running site keeps working and keeps the values it had. What changes is the next deploy of each app: its values come from that deploy request. A deploy replaces the app's whole set. If you send fewer names, the app loses the others. If that deploy has no variables at all, NBO removes the app's Kubernetes Secret, or clears the Cloud Run variables.

### Honest limits of the deletion

When you turn it on, NBO also hides the old values in stored build logs and error text, then rebuilds the database file (`VACUUM`) with secure deletion on, so old values, edited or deleted earlier, leave the file. Two things remain: the temporary journal files SQLite uses while it does this are **deleted, not overwritten**, so your disk's free blocks may still hold old data until reused; and plain values shorter than 6 characters are not scrubbed from old logs. If a value was a real secret, change it at its source.

## Where to go next

- [Builds](./builds.md) for how a build for an environment runs.
- [Deploying](./deploying.md) for removing one environment's apps.
- [Terraform](./terraform.md#environments) for `nbo_stage`.
