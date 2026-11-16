# Terraform

**Terraform** is a tool that sets things up from text files. Instead of sending API requests one by one, you describe a project in a `.tf` file, and `terraform apply` makes NBO match it. The file can be reviewed like code, and running it again changes only what's different.

The best reason to use it with NBO: a domain tells you the DNS record it needs, so the same file can create that record at your DNS provider, with no copying.

**What's been tried.** Only part of it. Read [What has been tried](#what-has-been-tried) before you rely on it.

## What it manages

| Terraform name     | What it is                                                                      |
| ------------------ | ------------------------------------------------------------------------------- |
| `nbo_project`      | A project: repository, build settings and clouds. Creating one doesn't build it |
| `nbo_stage`        | A custom environment such as staging: its branch, clouds and address            |
| `nbo_env_var`      | A project or workspace environment variable, for one environment or all         |
| `nbo_deployment`   | Runs a build of an environment and deploys it                                   |
| `nbo_domain`       | A custom domain, with the DNS records it needs                                  |
| `nbo_traffic`      | How an environment's traffic splits across its clouds                           |
| `data.nbo_project` | Reads an existing project by name                                               |

Cloud connections, the edge, clusters and domain settings are `nbo-server` commands on the server, because they need admin credentials and confirmation of what you'll be billed for.

## Make an API token

On the server, run `docker compose exec nbo nbo-server token create terraform`. Copy the token right away, because you won't see it again. `nbo-server token list` lists tokens and `nbo-server token revoke <id>` revokes one.

NBO has no roles: every token may use every project route, and none may use `/system/*`. A token made for a Viewer or a Developer while an older NBO had sign-in on is refused with `401`; make a new one.

**Treat a token like a root password.** It can't read your cloud credentials through the API, but it can run builds, and builds have full control of NBO's server until isolated builds exist. Keep it out of `.tf` files and out of git. If one leaks, revoke it with `nbo-server token revoke`.

## Connect to NBO

NBO only listens on its own server, so Terraform reaches it through an SSH tunnel:

```bash
ssh -N -L 8081:127.0.0.1:8081 you@your-server
```

Don't put NBO behind a VPN or a reverse proxy of your own: requests without a token are trusted by their Host header, which a proxy can rewrite. NBO can have its own https address instead, which lets in only requests with a token and the push webhooks, and Terraform can use that address as the `endpoint` ([Reaching NBO on its own address](../production.md#8-reaching-nbo-on-its-own-address)).

## Install the provider

The provider isn't on the Terraform Registry yet, so you download it from your own NBO and put it where Terraform looks for local providers.

1. Open the SSH tunnel (above). The download routes need no token from your own computer through the tunnel, and refuse tokens.
2. Pick your platform: `windows_amd64`, `darwin_arm64` (a Mac with an Apple chip), `darwin_amd64` (an Intel Mac), `linux_amd64` or `linux_arm64`. On a Mac, run `uname -m`: arm64 means darwin_arm64, x86_64 means darwin_amd64.
3. Download it: `curl -o terraform-provider-nbo_v0.1.0 http://localhost:8081/system/terraform-provider/linux_amd64` (with your platform). `curl http://localhost:8081/system/terraform-provider` lists the files with their sha256, which you can compare with `sha256sum` (macOS: `shasum -a 256`) on the downloaded file.
4. Put it in Terraform's plugins folder. On Linux and macOS that is `~/.terraform.d/plugins/registry.terraform.io/nbo/nbo/0.1.0/<platform>/`, for example `linux_amd64`. On Windows it is `%APPDATA%\terraform.d\plugins\registry.terraform.io\nbo\nbo\0.1.0\windows_amd64`, and the file ends in `.exe`.
5. On macOS and Linux, make the file runnable: `chmod +x terraform-provider-nbo_v0.1.0`.

If the list route answers 404, this NBO runs without the Docker image (see Running without Docker in the production guide). Build the provider yourself instead. You need Go 1.25.8 or newer. On Linux, for x64:

```bash
cd packages/terraform-provider
go build -o terraform-provider-nbo_v0.1.0
mkdir -p ~/.terraform.d/plugins/registry.terraform.io/nbo/nbo/0.1.0/linux_amd64
mv terraform-provider-nbo_v0.1.0 ~/.terraform.d/plugins/registry.terraform.io/nbo/nbo/0.1.0/linux_amd64/
```

On macOS, use `darwin_arm64` or `darwin_amd64` for the last folder. On Windows, name the file `terraform-provider-nbo_v0.1.0.exe`.

Then run `terraform init` as usual, with `version = "0.1.0"` in your configuration. The download hasn't been tried with a real Terraform yet.

## An example

```hcl
terraform {
  required_providers {
    nbo        = { source = "nbo/nbo", version = "0.1.0" }
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

variable "nbo_token" {
  type      = string
  sensitive = true
}

variable "zone_id" {
  type = string
}

provider "nbo" {
  endpoint = "http://localhost:8081"
  token    = var.nbo_token
}

resource "nbo_project" "shop" {
  name          = "shop"
  repo_url      = "https://gitlab.com/you/shop.git"
  branch        = "main"
  framework     = "nextjs"
  build_command = "npm install && npm run build"
  clouds        = [{ target = "kubernetes" }]
}

resource "nbo_env_var" "api_url" {
  project_id = nbo_project.shop.id
  name       = "API_URL"
  value      = "https://api.example.com"
}

# Runs after the variables exist. Change a trigger to build again.
resource "nbo_deployment" "shop" {
  project_id = nbo_project.shop.id
  triggers = {
    api_url = nbo_env_var.api_url.value
  }
}

resource "nbo_domain" "shop" {
  project_id = nbo_project.shop.id
  host       = "shop.example.com"
  depends_on = [nbo_deployment.shop]
}

resource "cloudflare_dns_record" "shop" {
  zone_id = var.zone_id
  name    = "shop"
  type    = nbo_domain.shop.records[0].type
  content = nbo_domain.shop.records[0].value
  ttl     = 300
  proxied = false
}
```

NBO doesn't install dependencies on its own, so `build_command` must do it, for example `npm install && npm run build`. With pnpm, use `pnpm install && pnpm build`.

The `endpoint` is NBO's own address with no path. You can also set `NBO_ENDPOINT` and `NBO_TOKEN` instead of writing them in the file. For the token, prefer that, or `TF_VAR_nbo_token`.

**Building is its own step.** `nbo_project` only prepares the clouds, so your variables exist before the first build. List in `triggers` whatever should cause a new build: variables, a version, a commit. Only a change in `triggers` builds again, so a variable missing from it takes effect at the next build. A secret value in `triggers` shows in plans unless you mark it sensitive, so use a version number for those. Put `depends_on = [nbo_deployment.shop]` on `nbo_domain` and `nbo_traffic`, because they need a deployed site.

`terraform apply` doesn't wait for the domain to become Active, since the DNS record may not exist until the same run creates it. Watch its status with `GET /projects/{id}/domains`.

Use `records[0]` as above. `records` isn't known until apply, so `for_each` over it fails at plan time. A domain through a Cloud Run mapping has no records until you verify ownership, so make its DNS record after that, in a later run.

## Environments

This manual calls them environments, and the API and Terraform call them stages, because `clouds` already means where a project runs. Every project has `production`, `preview` and `development`. `nbo_stage` adds a custom one, such as staging, fed by its own branch:

```hcl
resource "nbo_stage" "staging" {
  project_id = nbo_project.shop.id
  name       = "staging"
  branch     = "develop"
  clouds     = [{ target = "cloudrun", mode = "auto" }]
}

resource "nbo_env_var" "staging_api_url" {
  project_id = nbo_project.shop.id
  stage      = nbo_stage.staging.name
  name       = "API_URL"
  value      = "https://staging-api.example.com"
}

resource "nbo_deployment" "staging" {
  project_id = nbo_project.shop.id
  stage      = nbo_stage.staging.name
  depends_on = [nbo_env_var.staging_api_url]
}
```

Creating an environment builds nothing. Its branch is built by the next push, or by an `nbo_deployment` with that `stage`. `auto_deploy = false` stops builds of new commits. A branch can feed only one environment, and not the production branch.

- **`stage`** is also an attribute of `nbo_env_var`, `nbo_deployment`, `nbo_domain` and `nbo_traffic`. Left out, it is `production`, as before. Changing it replaces the resource. A variable's `stage` can also be `*`, for every environment. Workspace variables can use only `*` and the three built-in names. A variable of one environment beats one for `*`.
- **A variable already there is not copied.** Variables you made before environments existed belong to `production`. Preview and staging start with none.
- **`nbo_traffic` for a custom environment** names its clouds, like `s-staging-cr` for Cloud Run and `s-staging-k8s` for Kubernetes. The first successful deploy of an environment gets all of its traffic.
- **`nbo_domain` for a custom environment** needs the public edge, because Cloud Run domain mappings are for production only.
- **Destroying `nbo_stage`** removes the environment, its variables and its domains, and keeps its builds in history. Its clouds keep running unless you set `delete_cloud_resources = true`. NBO refuses while a build of that environment is queued or running.
- The project's `stages` attribute lists the environments by name and id.

## Keeping values out of NBO

A workspace setting, **Don't store variable values** (turned on from the server, see [Environments](./environments.md#dont-store-variable-values)), makes NBO keep only the names of variables. Declaring a name without a value is refused while NBO still stores values, because it would erase the stored one. The values then come with each deploy, so Terraform is where they live. Declare the names, and leave out `value`:

```hcl
resource "nbo_env_var" "db_url" {
  project_id = nbo_project.shop.id
  name       = "DB_URL"
  secret     = true
}

resource "nbo_deployment" "shop" {
  project_id = nbo_project.shop.id
  values_wo = {
    DB_URL = var.db_url
  }
  values_wo_version = "1"
}
```

A deploy must give a value for every name its environment declares, and no others, or NBO refuses it and says which names. Values are used for the build and handed to the running app. They are not kept in NBO, and NBO removes them from build logs and error messages. Values of fewer than 6 characters that are not secret can still show in a log if your build prints them.

- **`values_wo`** is write-only: Terraform sends it and never writes it to state or the plan. It needs Terraform 1.11 or newer. Terraform can't see it change, so change `values_wo_version` to deploy again with new values.
- **`values`** works on any Terraform. It is marked sensitive, but it is kept in the state file, so protect that file. A change replaces the deployment, which builds again. Use one of the two, not both.
- A push to a branch whose environment has declared names builds nothing (NBO has no values), and the build is recorded as skipped with "Waiting for variable values". Deploy from Terraform.
- Turning the setting on deletes every stored value. It is done on the server, not through a token.

## Your first run, step by step

1. Make a token with `nbo-server token create terraform` on the server and copy it.
2. Open the SSH tunnel from above, and leave it running.
3. Install the provider as above.
4. Make an empty folder, save the example as `main.tf`, and change the name, repository and host to yours. Without Cloudflare, delete the `cloudflare` lines and the `cloudflare_dns_record` block, and add the DNS record by hand.
5. Give Terraform the token without writing it in a file:

   ```bash
   export NBO_TOKEN=nbo_...           # Windows PowerShell: $env:NBO_TOKEN = "nbo_..."
   export TF_VAR_nbo_token=$NBO_TOKEN
   ```

6. Run `terraform init`. It should find `nbo/nbo` 0.1.0 locally.
7. Run `terraform plan` and read it: it lists what will be created and changes nothing.
8. Run `terraform apply` and type `yes`. It sets up the project, adds the variable, waits for the build to deploy, then adds the domain.
9. Check it: `curl -H "Authorization: Bearer $NBO_TOKEN" http://localhost:8081/projects/summary` shows the project with its build, and `/projects/<id>/domains` its domain.
10. To change something, edit `main.tf` and apply again. Only the difference is changed. To rebuild, change a value in `triggers`.
11. To remove everything, run `terraform destroy`. The project goes; what it ran in your clouds stays unless you set `delete_cloud_resources = true`.

## How it behaves

- **Changing build settings or variables doesn't start a build.** A new branch or repository builds on the next poll. Otherwise add it to `triggers`, or start a build with `POST /projects/{id}/builds`.
- **A failed build** is an error. Terraform marks only `nbo_deployment` to run again, so fix the cause and apply. The project isn't touched. After a timeout or Ctrl-C, the build may still be running, and the next apply queues another.
- **A new commit can build before `nbo_deployment` runs,** if it lands in the short time after setup, so that build won't have your variables. `nbo_deployment` then builds again with them.
- **A failed setup** marks `nbo_project` to be replaced on the next apply.
- **Deleting a project** keeps what it runs in your clouds unless you set `delete_cloud_resources = true`.
- **Secret variables** can't be read back from NBO. A change made through the API isn't noticed, and importing one shows a single update on the first plan. Their values sit in plain text in Terraform's state file, so protect that file.
- **Changing a variable from secret to plain** replaces it, because NBO refuses that change.
- **`nbo_env_var` overwrites** an existing variable of the same name.
- **`nbo_traffic`** sets clouds you leave out to 0. A transfer shows up as a change, and `terraform apply` moves the split back.
- **`clouds`** records how the project was set up. A cloud added later through the API isn't noticed. Order doesn't matter, because NBO sorts them. The first gets the first traffic and the crons, so use `nbo_traffic` to set the split.

## Private repositories

`nbo_project` reaches a public repository without a credential. For a private one, set `git_credential`:

```hcl
# An access token over https. git_token_wo is write-only (Terraform 1.11 or newer).
resource "nbo_project" "shop" {
  name                 = "shop"
  repo_url             = "https://gitlab.com/you/shop.git"
  branch               = "main"
  framework            = "nextjs"
  build_command        = "npm install && npm run build"
  clouds               = [{ target = "kubernetes" }]
  git_credential       = "token"
  git_username         = "oauth2"
  git_token_wo         = var.git_token
  git_token_wo_version = "1"
}

# A deploy key over ssh. NBO makes the key pair; you add its public half.
resource "nbo_project" "shop_ssh" {
  name           = "shop-ssh"
  repo_url       = "git@github.com:you/shop.git"
  branch         = "main"
  framework      = "nextjs"
  build_command  = "npm install && npm run build"
  clouds         = [{ target = "kubernetes" }]
  git_credential = "deploy-key"
}

resource "github_repository_deploy_key" "nbo" {
  title      = "NBO"
  repository = "shop"
  key        = nbo_project.shop_ssh.deploy_key_public
  read_only  = true
}
```

- **`git_credential`** is `public` (the default), `token` or `deploy-key`. A token works with an `https://` address, a deploy key with an `ssh://git@host/path` or `git@host:path` address.
- **`git_token_wo`** is write-only: Terraform sends it and never writes it to state or the plan, and NBO never shows it again. Terraform can't see it change, so change `git_token_wo_version` to send a new one. `git_username` is the user name some hosts want with the token.
- **`deploy_key_public`** is the public half of the key NBO made. Give it to your git host as a read-only deploy key. NBO can't read the repository until you do. Changing `git_credential` to `deploy-key` on an existing project makes the key then.
- **A new project with a deploy key waits for the key.** NBO's first look at the repository fails until the key is added, so the project waits in `waiting-for-key` (`terraform apply` ends with a warning, not an error). After you add the key, NBO finds it by itself: it checks on every poll for an hour, then every 10 minutes for 7 days, and then builds the first commit (unless the project skips its first build). To finish at once, run `nbo-server project retry <project id>` on the NBO server. After 7 days the project moves to `needs-setup`.
- Editing other settings of a project never sends the credential again.
- **Moving `repo_url` to another host needs the credential sent again.** With a token, change `git_token_wo_version` in the same change, or the plan stops with an error. With a deploy key, NBO makes a new key: add the new `deploy_key_public` to the repository at its new host.

## Importing what you already have

```bash
terraform import nbo_project.shop <project id>
terraform import nbo_env_var.api_url <project id>/API_URL
terraform import nbo_env_var.global workspace/API_URL
terraform import nbo_domain.shop <project id>/shop.example.com
terraform import nbo_stage.staging <project id>/staging
terraform import nbo_env_var.staging_api_url <project id>/staging/API_URL
terraform import nbo_env_var.global_all workspace/*/API_URL
terraform import nbo_traffic.staging <project id>/staging
```

A variable's id is `<project id>/<name>` for production, and `<project id>/<stage>/<name>` for another environment, with `workspace` in place of the project id for a workspace variable.

`nbo_deployment` imports by build id: `terraform import nbo_deployment.shop <build id>`. Adding triggers after that doesn't run a build until one of them changes.

## What has been tried

> **Not tried for real yet.** Most of the Terraform provider. `TestAccProject` passed with Terraform 1.17.1 against a local dev-mode NBO on 2026-11-08: it created a project, a variable and a deployment, read them back, imported them and destroyed them. The rest ran in Go tests against a fake NBO, and its logic was also run against a real dev-mode control-plane without Terraform. Private repositories (`git_credential`), environments, values sent with a deploy, domains, traffic, the install from the plugins folder and the Cloudflare example haven't been run with Terraform yet, so try them on a throwaway project first.

## Troubleshooting

**"NBO answered with something that isn't its API".** The `endpoint` has a path (an older NBO's `/api/controlplane`, for example) or points at something other than NBO. Use NBO's own address, such as `http://localhost:8081`. A project may have been created anyway: check `GET /projects` before retrying.

**"invalid API token".** The token is wrong or revoked.

**"API tokens can't use this route".** Tokens can't reach cloud connections, the edge or other tokens. Use `nbo-server` on the server for those.

**"no successful deployment" from `nbo_traffic`.** Add `depends_on = [nbo_deployment.shop]`.

**Connection refused.** The SSH tunnel isn't running.
