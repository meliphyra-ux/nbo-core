# Launch NBO on a server

How to run NBO for real sites, on one server you control, with one command. This guide follows the order a first launch happens in. For running NBO on your own computer instead, see [Running NBO for development](./manual/running.md).

## What production mode is

NBO has two modes, set by `NBO_MODE` when the control-plane starts. Dev is the default. They differ in where your sites run and who can reach them:

|                                   | Dev mode                                | Production mode                                             |
| --------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Made for                          | Working on NBO on your computer         | Real sites                                                  |
| Kubernetes                        | The local kind cluster                  | Clusters you connect, each with its own limited access      |
| Cloud access                      | Your own logged-in tools                | Credentials saved in NBO, encrypted                         |
| First launch                      | Ready for the local kind cluster        | Nothing deploys until you connect a cloud with `nbo-server` |
| Where the edge runs               | On your computer, as its own process    | Inside the cluster you choose                               |
| Project address                   | `http://<name>.127.0.0.1.sslip.io:9443` | `https://<name>.<your base domain>`, plus your own domains  |
| HTTPS                             | None for visitors                       | Let's Encrypt certificates, renewed automatically           |
| Project isolation                 | One shared namespace                    | One namespace per project, with network rules               |
| Values from NBO's own environment | Passed to deployed apps                 | Never passed; apps get only the variables you set           |

Compose (step 2) sets production mode for you.

## The steps at a glance

A typical setup is one Linux machine that runs NBO with Docker Compose, plus a place for your sites: a Kubernetes cluster (for example k3s on Hetzner), Cloud Run in a Google project you already have, or both.

1. Prepare a server: SSH key, Docker and a firewall.
2. Start NBO with `docker compose up -d`, which pulls the ready-made image.
3. Connect your clouds with the `nbo-server` command on the server.
4. Give NBO access to private repositories (a deploy key or a token per project). Public repositories need nothing.
5. Install the public edge, with Let's Encrypt staging first, and point your domain at it. Skip this if you only use Cloud Run.
6. Deploy your first project and add its domains.
7. Team access: API tokens (NBO has no sign-in, members or roles).
8. Give NBO its own https address, if tokens and webhooks must reach it from outside.

Then set up [backups](#backups-and-restore) and read [Upgrading NBO](#upgrading-nbo) before your first upgrade. To run NBO without Docker, see [Running without Docker](#running-without-docker).

## Read this first

> **Not tried for real yet.** The public edge. Installing it, relays and Let's Encrypt certificates are covered by automated tests with fakes only. Do your first run on a throwaway cluster with Let's Encrypt **staging**, and treat it as a trial. On 2026-11-06 an install on a real Hetzner k3s cluster reached the load balancer step, which showed that Hetzner needs a location (see step 5). Certificates and visitor traffic on a real cluster are still unconfirmed.

Docker Compose on a Linux server has been run for real: NBO has run with Compose on a Hetzner Linux server since November 2026, with a Hetzner k3s cluster connected. Earlier, on 2026-11-05 on Docker Desktop on Windows, data and key survived a restart and a new container, and the backup and restore commands below worked on that same machine.

> **Not tried for real yet.** A Google project connected from a Compose install, a site deployed end to end this way, and restoring a backup onto a different server.

> **Not tried for real yet.** Connecting Google Cloud from NBO, with your own login or a service account key, and the production-mode deploys that follow, ran against fake commands only. No real Google project has been connected this way.

> **Not tried for real yet.** The Rust edge. It passed the black-box suite it shares with the Node edge, the load test (zero failed requests) and a one-core benchmark, all on a local machine. It has not served a real site over HTTPS on a real cluster.

The full list, feature by feature, is in [What has been tried for real](./manual/tried.md).

- **NBO has no login.** Compose publishes the API on the server's loopback address only, and you reach it through an SSH tunnel. Don't change that to a public address, and don't put a VPN or reverse proxy in front of it: requests without an API token are trusted by their Host header, which a proxy can rewrite. NBO's own https address (see [step 8](#8-reaching-nbo-on-its-own-address)) is the one exception, and it lets in only requests with a token and the push webhooks. Builds are not isolated, so anyone who can run a build, a token holder included, is effectively root on the server.
- **The Docker socket makes NBO equal to root on its server.** NBO's container runs as root with the host's Docker socket mounted, because it builds images. Anything that controls that container controls the server. Use a machine dedicated to NBO.
- **Only build repositories you trust.** Builds run inside NBO's container. A build can read the secret key and database, and reach the Docker socket, so a hostile repository takes over the server. NBO has no isolated builds, and none are scheduled.
- **Back up by hand.** NBO has no automatic backups, and none are scheduled. See [Backups and restore](#backups-and-restore).

## What you need

**A server** (Linux, x64) with Git, Docker Engine and the Compose plugin. Everything else NBO uses (Node.js, pnpm, kubectl, gcloud, the Docker client) is inside its image, about 1.5 GB. Ubuntu 24.04 with 4 vCPUs and 8 GB of memory is a comfortable size, because builds run on this server. Don't pick an ARM plan, such as Hetzner's CAX: NBO's image is x64.

**This server doesn't host your sites.** It runs NBO's API and the builds. Your sites run on a cloud, which is billed separately.

**A cloud to deploy to**, either or both:

- A Google Cloud project for Cloud Run. This is the simplest start, but sites only get a `run.app` address unless you map your own domains through Google (see step 5).
- A Kubernetes cluster, version 1.30 or newer, with admin credentials and LoadBalancer support (the cloud's way of giving the cluster a public address). You need this for your own domains and HTTPS through the edge. [Creating a Kubernetes cluster](./manual/clusters.md) shows how to make one, including a k3s cluster on Hetzner.

**For public HTTPS:** a domain whose DNS you control, and ports 80 and 443 reachable on the edge's load balancer. Let's Encrypt checks port 80.

**For private repositories:** a way to add a read-only deploy key to each repository, or a read-only access token (step 4).

## 1. Prepare a server

Create a server with Ubuntu 24.04 and add your SSH key while creating it. If you don't have a key yet, run this on your own computer (it also works in Windows PowerShell), and press Enter to accept the default location:

```bash
ssh-keygen -t ed25519
```

Use the server only for NBO. Then log in and install Docker:

```bash
ssh root@YOUR_IP
apt-get update && apt-get install -y git
curl -fsSL https://get.docker.com | sh
```

You don't need Homebrew for anything here. It refuses to run as root anyway, with "Don't run this as root!".

### If you created the server without an SSH key

You don't need to recreate it. These steps are for Hetzner, which emails a root password when a server has no key.

1. Log in once with `ssh root@YOUR_IP`. Hetzner makes you change the password on first login. If you have no email, open the server in the Hetzner Console, go to **Rescue** and choose **Reset root password**.
2. From your own computer, add your key. In Windows PowerShell:

   ```powershell
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@YOUR_IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
   ```

3. Run `ssh root@YOUR_IP` again. It should no longer ask for the server's password.

If you can't connect at all, the **Console** button (`>_`) on the server's page logs you in through the browser.

### If `ssh` times out

A timeout means the connection never reached the server, so it isn't a password or key problem. Check these in order:

1. **The server is running.**
2. **The address is right.** Copy the IPv4 from the server's overview page. If it only shows IPv6, your network may not reach it: add a Primary IPv4 under the server's **Networking** tab.
3. **The firewall allows port 22.** A firewall with no rule for port 22 drops all SSH.

To test the port from Windows PowerShell:

```powershell
Test-NetConnection YOUR_IP -Port 22
```

If `TcpTestSucceeded` is `False` and `PingSucceeded` is `True`, recheck the firewall. If both are `False`, turn off any VPN and try from a phone hotspot. If that works, your own network is blocking port 22.

### Close the firewall

The server should accept connections from the internet on port 22 only, unless you give NBO its own address (see [step 8](#8-reaching-nbo-on-its-own-address)), which also opens 80 and 443. NBO has no login, so its own port must never be public.

| Port             | State      | Why                                 |
| ---------------- | ---------- | ----------------------------------- |
| 22 (SSH)         | Open       | How you get in                      |
| 8081 (NBO's API) | Not public | Reached through the SSH tunnel only |
| 80, 443          | Closed     | Your sites don't run on this server |
| Everything else  | Closed     | Nothing else should be reachable    |

Outgoing traffic stays allowed, so NBO can reach your Git host, Google and your clusters.

On Hetzner, create a firewall in the Console with one inbound rule, TCP port 22, and attach it to the server. This is better than `ufw` inside the server, because Docker can bypass `ufw`.

Once key login works, turn off password login so bots can't guess their way in:

```bash
echo 'PasswordAuthentication no' > /etc/ssh/sshd_config.d/10-nbo.conf
systemctl reload ssh
```

Keep your current session open and check that a new `ssh` login works before you close it.

### Copying files to and from the server

You don't need to copy NBO's code, because the server clones it. For a backup or a `.env` file, use `scp` from your own computer:

```bash
scp ./.env root@YOUR_IP:/opt/nbo/
scp root@YOUR_IP:/opt/nbo/nbo-backup.tgz .
```

Add `-r` to copy a folder.

## 2. Start NBO

```bash
git clone --depth 1 https://github.com/meliphyra-ux/nbo-core /opt/nbo
cd /opt/nbo
docker compose up -d
```

This pulls the ready-made image (`ghcr.io/meliphyra-ux/nbo-core`, built from the repository on every change to `main`; about a minute on a normal connection) and starts one container, which comes back by itself after a reboot.

**To build the image yourself instead,** for example from your own fork or a private copy, run `docker compose -f compose.yaml -f compose.build.yaml up -d --build`, and use the same two `-f` options in every later `docker compose` command that starts NBO. The first build takes 10 to 15 minutes on a small server (it compiles the Terraform provider for five platforms) and needs a few GB of free disk. If your copy of the repository is private, make a read-only token and use it as the password when `git clone` asks. On GitLab, that's a deploy token with `read_repository`, under **Settings → Repository → Deploy tokens**.

`docker compose ps` shows `health: starting`, then `healthy` when it's ready, usually within a minute. `docker compose logs -f nbo` shows its log, which is the place to look if it's `unhealthy` or keeps restarting. A line starting with `control-plane:` just before it stops names the problem; [When NBO refuses to start](./manual/server-settings.md#when-nbo-refuses-to-start) lists each one.

NBO stores everything in two Docker volumes. They stay when you remove or rebuild the container:

| Volume         | What it holds                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `nbo_nbo-data` | `nbo.db` (projects, deployments, encrypted credentials), `artifacts/` (stored build output), and temporary build files |
| `nbo_nbo-keys` | `nbo-secret.key`, the key for those credentials, created on first start                                                |

It listens on `127.0.0.1:8081`. If that port is taken, put `NBO_PORT=8091` (or any free port) in a `.env` file next to `compose.yaml`. Every setting the `.env` file takes is in [Server settings](./manual/server-settings.md).

You don't start an edge on this server. In production the edge runs inside your cluster, once you install it in step 5.

## 3. Connect your clouds

NBO has no web interface. You set it up with `nbo-server`, a command inside the NBO container that connects clouds, installs the edge, sets domains, makes API tokens and sets up projects. Run it on the server, in the folder with `compose.yaml`:

```bash
docker compose exec nbo nbo-server status
```

It talks to NBO on the server's own loopback address with no token, and prints NBO's answers as JSON. A refusal prints `nbo-server: <status> <reason>` and exits with 1. `docker compose exec nbo nbo-server help` lists every command; `nbo-server api <METHOD> <path>` sends any other API request.

**Secrets never go on the command line.** Kubeconfigs, Google keys, registry passwords and request bodies come from a file or from stdin, never from a flag's value, so they don't show up in the process list or your shell history. `nbo-server` has no `--kubeconfig`, `--key` or `--token` flag. Give `-` as the file to read stdin; add `-T` to `docker compose exec` when you pipe something in. Only one flag per command can read stdin. For a second file, copy it into the container, and afterwards remove it there and on the server:

```bash
docker compose cp registry.json nbo:/tmp/registry.json
# ... the nbo-server command that reads /tmp/registry.json ...
docker compose exec nbo rm /tmp/registry.json
rm registry.json
```

> **Not tried for real yet.** `nbo-server` on a production-mode server. Every command ran against a fake control-plane in automated tests, and the image checks that it starts. `status`, `token create` and `api` also ran against a real dev-mode NBO on a local kind cluster on 2026-11-12 (`scripts/verify-headless.sh`); none has been run against a production-mode server.

Connect at least one cloud. Credentials you give for a Kubernetes cluster are used once to set up NBO's own limited access and aren't kept. Connect Google first if you plan to use it, because a cluster can then store its images there. You can add more clouds later.

To reach NBO's API from your own computer without a token, open an SSH tunnel and leave it running:

```bash
ssh -N -L 8081:127.0.0.1:8081 root@YOUR_IP
```

It prints nothing, which is normal. Then `http://localhost:8081` reaches NBO. It's important that the address is `localhost` or `127.0.0.1`: NBO refuses anything else without a token.

### Connect Google Cloud without a key (keyless)

This is the way to prefer. No deployer key exists: you run one setup command in Google's Cloud Shell, it makes Google trust this core's own public key, and the core signs a short-lived token each time it talks to Google. Use a project just for NBO (see the warning in the next section; the deployer account has the same roles).

First read the core's own Google identity. On the server, in the folder with `compose.yaml`:

```bash
docker compose exec nbo nbo-server google identity
```

It prints the issuer, the subject, the provider id and the key id (`keyId`). The setup command carries this core's issuer, provider and public key. It is shown, in full, by the hosted dashboard you manage this core with (pick Google Cloud, keyless); this repository carries no copy of it. If you manage the core only through the API, use a key instead (below). Run it in Cloud Shell, signed in as a project owner. It enables the APIs, makes the `nbo-deployer` and `nbo-puller` accounts, grants the deployer its six roles, makes the `nbo-cores` pool and this core's provider, and prints:

- one `Google trusts key: <key id> (provider <provider id>)` line for every provider in the pool, and
- a `Connection code: nbo-gcp1.…`.

Besides the six roles it deploys with, the deployer gets two read-only roles so the core can check the project's trust setup itself: `roles/iam.workloadIdentityPoolViewer` (to read the pool's providers and this core's provider keys) and `roles/iam.securityReviewer` (to read IAM policies; it can read every IAM policy in the project, which is why the project should be NBO's alone).

**The key lines are the command's own.** The line for this core's provider should show the same `keyId` that `nbo-server google identity` printed, and any other line should be a core of yours. These lines are printed by the command itself, so they only help if the command's last lines are unchanged: they catch mistakes, not a changed command. The real check is the core's own, after connecting (below). The command runs as you, a project owner, so read it before running it.

Then connect with the code and the region your sites should run in:

```bash
docker compose exec nbo nbo-server connect google --code nbo-gcp1.… --region europe-west1
```

The core checks that the code is for this core (a code wrapped over several lines is read as one), tries the connection (Google can take about half a minute to accept the new trust; it retries for five minutes) and reads the project's trust setup. `--code` can't be combined with `--key-file` or `--from-machine`. Where the organization forbids service-account keys, the core makes no image puller key, so a cluster can't pull from Artifact Registry and needs another registry; sites on Cloud Run are not affected.

**Check from the core.** This is the step that holds even if the command was changed on its way to you:

```bash
docker compose exec nbo nbo-server google check
```

The core reads its provider, every provider in the `nbo-cores` pool and the IAM policies of the project and of `nbo-deployer` from Google itself, as the deployer. When nothing but this core can act as `nbo-deployer`, it prints `Google trusts only this core's key, and nothing else can act as nbo-deployer.` and exits 0. Otherwise it prints each warning on its own line and each other core as `Other core this project trusts: <provider>`; it exits 1 when there is any warning. An other core is fine only if it is one of yours. If it reports anything you didn't set up, remove it in Google now: not connecting is not enough, because the setup command already made its changes. To remove a provider and its grant, see [Disconnecting and removing NBO](./manual/clusters.md#disconnecting-and-removing-nbo); remove any other binding it names in the console's IAM page. The same check runs on every connection test, and its findings are listed as warnings on the connection.

**Switching from a key.** Connecting keyless over a key connection replaces it, but switching from a key leaves the old key valid in Google: the keyless deployer can't delete keys. The connection shows "Delete the old <account> key <key id> in the Google console" until you connect again; delete that key (`gcloud iam service-accounts keys delete <key id> --iam-account <account>@PROJECT.iam.gserviceaccount.com`). Image pulls keep working only when you switch within the same project, because the old puller key is kept; in a new project the core makes a new one, or none where keys are forbidden.

> **Not tried for real yet.** A 2026-11-17 spike proved the token exchange, impersonation, `gcloud` with the credential file and reading the provider back. A real connect and deploy, `nbo-server google check` against a real project, Docker pushes on Linux and a project with no organization have not run.

### Connect Google Cloud with your own account

You need a Google Cloud project with billing linked, and a Google account that owns it. **Use a project just for NBO.** An existing project works, but NBO's `nbo-deployer` account gets project-wide admin roles there: `roles/run.admin`, `roles/iam.serviceAccountUser`, `roles/iam.serviceAccountAdmin` and `roles/secretmanager.admin`, plus Artifact Registry and service usage admin. Builds run inside NBO and can read the key that unlocks that account (see [Read this first](#read-this-first)). So in a shared project, NBO, any member with the Developer role or a compromised repository could change every Cloud Run service, read every Secret Manager secret and act as any service account in it, including ones your other systems use. Make a new project for NBO, or use one where nothing else matters. You sign in once, NBO creates its own `nbo-deployer` and `nbo-puller` accounts with only the roles they need, and it saves their keys. It doesn't use your login for deploys.

gcloud is inside the NBO container, so sign in there. On the server, in the folder with `compose.yaml`:

```bash
docker compose exec -it nbo gcloud auth login --no-launch-browser
docker compose exec nbo gcloud config set project YOUR_PROJECT_ID
```

The first command prints a link. Open it in your browser, sign in, and paste the code it gives you back into the server terminal.

Then connect, with the region your sites should run in:

```bash
docker compose exec nbo nbo-server connect google --from-machine --project YOUR_PROJECT_ID --region europe-west1
```

Once it answers with the connection, remove your login from the server:

```bash
docker compose exec nbo gcloud auth revoke
```

> **Not tried for real yet.** Connecting with your own account has not been run against a real Google project.

### Or connect Google Cloud with a service account key

Signing in with your own account is the better choice, because NBO then has only the roles it needs. Use a key if you can't sign in on the server.

**A key made this way stays in use.** NBO stores it encrypted and deploys with it from then on, so it keeps owner rights over the project. Anyone who has it controls the project, so treat it like a password. Deleting the key or its account in Google Cloud breaks NBO's connection.

Open [Google Cloud Console](https://console.cloud.google.com), click the `>_` icon at the top right to open Cloud Shell, and run:

```bash
gcloud config set project YOUR_PROJECT_ID
PROJECT=$(gcloud config get-value project)
gcloud services enable iam.googleapis.com cloudresourcemanager.googleapis.com serviceusage.googleapis.com
gcloud iam service-accounts create nbo-setup --display-name="NBO setup"
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:nbo-setup@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/owner"
gcloud iam service-accounts keys create nbo-key.json \
  --iam-account=nbo-setup@$PROJECT.iam.gserviceaccount.com
cat nbo-key.json
```

On the server, write the JSON to a file without it landing in your shell history: run `(umask 077; cat > nbo-key.json)` so only you can read the file, paste all the JSON, press Enter and then Ctrl+D. Connect, then delete both copies (`rm nbo-key.json` on the server and in Cloud Shell):

```bash
docker compose exec -T nbo nbo-server connect google --key-file - --region europe-west1 < nbo-key.json
rm nbo-key.json
```

A policy error about key creation means your organization blocks keys.

### Connect a Kubernetes cluster

If you don't have a cluster yet, [Creating a Kubernetes cluster](./manual/clusters.md) shows how to make one. For a k3s cluster on Hetzner, follow [Hetzner Cloud](./manual/clusters.md#hetzner-cloud); you can run its commands on this server.

NBO runs in a container, so it can't see a kubeconfig on the server by itself: you hand it one. The cluster also needs a registry, which is where NBO stores your site images so the cluster can download them. Describe it in a small JSON file, `registry.json`.

**If Google is connected,** use Artifact Registry, and NBO handles the logins itself:

```json
{ "registry": { "kind": "artifact-registry" } }
```

**Otherwise, use another registry:**

```json
{
  "registry": { "kind": "custom", "server": "ghcr.io/your-github-name", "username": "your-github-name" },
  "registryPassword": "..."
}
```

| Field              | GitLab                                                   | GitHub                                                                    |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `server`           | `registry.gitlab.com/<group>/<project>`                  | `ghcr.io/<your-github-name>`                                              |
| `username`         | The deploy token's username                              | Your GitHub name                                                          |
| `registryPassword` | A deploy token with `read_registry` and `write_registry` | A classic personal access token with `write:packages` and `read:packages` |

Then connect, with a name for the cluster (1 to 30 lowercase letters, digits or hyphens; it can't change later). The kubeconfig comes through stdin and the registry file is copied in for the one command:

```bash
docker compose cp registry.json nbo:/tmp/registry.json
docker compose exec -T nbo nbo-server connect kubernetes --name hetzner \
  --kubeconfig-file - --registry-file /tmp/registry.json < kubeconfig.yaml
docker compose exec nbo rm /tmp/registry.json
rm registry.json
```

Add `--context <name>` to use a context other than the kubeconfig's current one. The answer holds the cluster's id (`kc_...`), which the commands below take. `nbo-server cluster test <id>` checks it again later, and `nbo-server disconnect kubernetes <id>` forgets it.

Write the server in lowercase. On GitLab, make the token under **Settings → Repository → Deploy tokens**, and check that **Container registry** is on under **Settings → General → Visibility, project features, permissions**.

Use a token made just for NBO, not your account password. NBO stores it encrypted, and also copies it into a Secret on your cluster so nodes can download images.

> **Not tried for real yet.** A custom registry: the registry settings, the pull secret and the image pushes ran against fake commands, never a real registry.

## 4. Private repositories

NBO reaches each repository with a credential of the project's own, so pushes keep building whatever else is down. A public repository needs none: give its `https://` address. For a private one, pick one per project when you create it (`credential` on `POST /projects/setup`, or later on `PUT /projects/{id}/git`):

- **A deploy key** (recommended): give the repository's SSH address (`git@github.com:you/site.git`) and `{ "kind": "deploy-key" }`. NBO makes a key pair and keeps the private half encrypted. Read the public half from `GET /projects/{id}/git` (`credential.publicKey`) and add it to the repository as a read-only deploy key (on GitHub: the repository's **Settings → Deploy keys**). `POST /projects/{id}/git/deploy-key` makes a new pair when you want to replace it. GitHub, GitLab and Bitbucket are checked against the host keys they publish. Any other git server is remembered in `known_hosts` next to the database the first time NBO reaches it, and refused if its key ever changes; to check it from the very first connection, add its line to that file first.
- **A token**: give the `https://` address and `{ "kind": "token", "token": "...", "username": "..." }` (the user name is optional). Use a read-only token made for NBO, such as a GitHub fine-grained token with **Contents: read** on that one repository.

With `nbo-server`, put the project in a JSON file (the body of `POST /projects/setup`) and send it:

```json
{
  "name": "site",
  "repo": "git@github.com:you/site.git",
  "productionBranch": "main",
  "framework": "static",
  "buildCommand": "npm ci && npm run build",
  "clouds": [{ "target": "kubernetes", "clusterId": "kc_..." }],
  "credential": { "kind": "deploy-key" }
}
```

```bash
docker compose exec -T nbo nbo-server project setup --body-stdin < site.json
```

With a deploy key, the command prints the public half and the next step. NBO's first look at the repository fails until the key is added to it, so add the key, then run `docker compose exec nbo nbo-server project retry <project id>`. NBO makes the key pair before the project's first look at the repository, so the project waits in `needs-setup` until then. With Terraform, `nbo_project` gives the public half as `deploy_key_public` (see [Private repositories](./manual/terraform.md#private-repositories)). For a token, the token sits in the JSON file, so delete the file afterwards.

Tokens and private keys are stored encrypted with the secret key and never shown again. A credential stays with its host: moving a project to a repository on another host needs the credential given again. NBO finds new commits by asking the repository every 45 seconds; a per-project webhook (`POST /projects/{id}/webhooks/github`) makes it faster. See [Builds](./manual/builds.md#1-clone) for how the credential reaches git.

Projects imported through an older NBO's own GitHub App keep building: NBO still asks GitHub for a read-only token for them with the app's stored key. They get no check runs any more, the app's deliveries to `POST /github/webhook` fail with `404`, and pushes build on the 45-second poll only. Give such a project a deploy key or token (`PUT /projects/{id}/git` with a `credential`, which drops the old link) and, for faster pushes, the per-project webhook; the app path is kept only for the move and will go.

> **Not tried for real yet.** Deploy keys and tokens ran against local repositories and a fake GitHub only.

## 5. Install the public edge

The edge is the part of NBO that receives your visitors, holds the HTTPS certificates and sends each request to the cloud that runs the site. In production it runs inside one of your clusters.

Skip this if you only use Cloud Run: projects then show their `run.app` address, and you can add your own domains through Cloud Run domain mapping (see [Domains without a cluster](./manual/domains.md#domains-without-a-cluster)). That's a Preview feature at Google, so use the edge for real traffic. Traffic splits need the edge. Without an edge, the control-plane log repeats "edge unreachable" and "edge reconcile failed" messages; they're harmless.

A Kubernetes project has no public address until the edge is installed.

On the server, with `nbo-server`:

1. Set the Let's Encrypt email, and use **staging** for your first run. Staging certificates aren't trusted by browsers, but mistakes there don't use up your real limits:

   ```bash
   docker compose exec nbo nbo-server domains settings --acme-email you@example.com
   echo '{"acmeDirectory":"staging"}' | docker compose exec -T nbo nbo-server api PATCH /system/domains --body-stdin
   ```

   Send `{"acmeDirectory":"production"}` the same way to switch to real certificates later.

2. Install the edge on the cluster of your choice, with admin credentials (used once, not stored). `--confirm-billing` says you know this creates a load balancer that **your provider bills**:

   ```bash
   docker compose exec -T nbo nbo-server edge install --cluster kc_... \
     --admin-kubeconfig-file - --confirm-billing < admin-kubeconfig.yaml
   ```

3. Wait for the job to finish. `nbo-server edge status --wait` checks every 2 seconds until it does (at most 30 minutes) and then prints the edge's public address.
4. Set a base domain (`nbo-server domains settings --base-domain apps.example.com`) and point your domain at the edge, as described below.

**On Hetzner Cloud,** you don't have to do anything. Hetzner won't create a load balancer without a location, so NBO reads it from your cluster's nodes whenever you give it admin credentials (when you connect the cluster, run `nbo-server cluster update-setup`, or install the edge), saves it for that cluster, and uses it for the edge and for relays. Reinstalling the edge reuses the saved location.

A cluster you connected with an older NBO has no location saved yet. Give admin credentials once for it:

```bash
docker compose exec -T nbo nbo-server cluster update-setup kc_... --admin-kubeconfig-file - < admin-kubeconfig.yaml
```

Or set the location by hand in the `.env` file next to `compose.yaml`, then run `docker compose up -d`:

```bash
NBO_LB_ANNOTATIONS=load-balancer.hetzner.cloud/location=nbg1
```

`NBO_LB_ANNOTATIONS` is optional. When it is set it wins over the detected location. Without any location, the install stops at "Waiting for the load balancer's address", and the service's events say `neither load-balancer.hetzner.cloud/location nor load-balancer.hetzner.cloud/network-zone set`. You can read them with `kubectl -n nbo-edge describe service nbo-edge`.

If you're stuck in that state mid-install, add the location to the running service, and the install carries on:

```bash
kubectl -n nbo-edge annotate service nbo-edge load-balancer.hetzner.cloud/location=nbg1
kubectl -n nbo-edge get service nbo-edge -w
```

Add `--overwrite` to change a value you've already set. If the install has already stopped with "got no address", start it again. Don't restart NBO during an install, because that interrupts it.

`NBO_LB_ANNOTATIONS` takes comma-separated `key=value` pairs and applies to the edge's and every relay's load balancer, so other clouds can use it too. A value NBO can't read stops it from starting, with the bad pair named in the log.

Other clusters that run projects need public entry (a relay), which creates another billed load balancer: `docker compose exec nbo nbo-server cluster relay kc_... --confirm-billing`. It runs in the background; `nbo-server api GET /system/clusters/kc_.../relay` shows how far it got. A cluster connected before this version is "out of date" until you run `nbo-server cluster update-setup` for it, as above.

### Trying the Rust edge

NBO has two builds of the edge: the Node edge, which is the default, and a faster one written in Rust that does the same job (ADR 0005 has the measurements). The Rust edge has passed every automated check, but it has not yet served a real site over HTTPS on a real cluster, so it is opt-in. To try it:

1. Add `NBO_EDGE_IMPL=rust` to `.env` in the NBO folder and run `docker compose up -d`. Without Docker, set it in the control-plane's environment and restart it.
2. Reinstall the edge: `docker compose exec nbo nbo-server edge reinstall`, then `docker compose exec nbo nbo-server edge status --wait`. The first build of the Rust image compiles the edge inside Docker and takes a few minutes; later reinstalls reuse Docker's cache.
3. Open one of your sites over HTTPS and check that the page loads and the padlock shows.

Relays need nothing: they keep running whichever edge they were installed with, and the relay protocol is the same, so a Rust edge works with Node relays and the other way round. Visitors keep their cloud across the switch: both edges pick the same cloud for the same visitor. Two things differ on purpose: compressed answers (gzip, brotli) reach visitors as the app sent them, and browsers can use HTTP/2 on port 443. If a client has trouble with HTTP/2, set `NBO_EDGE_HTTP2=off` on the edge (`kubectl -n nbo-edge set env deployment/nbo-edge NBO_EDGE_HTTP2=off`; a reinstall undoes it).

**To go back,** remove the `NBO_EDGE_IMPL` line (or set it to `ts`), run `docker compose up -d`, and reinstall the edge again (`nbo-server edge reinstall`). Relays need nothing. Routes and certificates live in the cluster, not in the edge, so nothing else changes.

### Find the edge's address

`docker compose exec nbo nbo-server edge status` shows it. From the machine that has your cluster's kubeconfig, you can also run:

```bash
kubectl -n nbo-edge get service nbo-edge -o jsonpath='{.status.loadBalancer.ingress[0].ip}{"\n"}'
```

If `kubectl` can't connect, point it at the kubeconfig first, for example `export KUBECONFIG=$PWD/kubeconfig`. On Hetzner, the address is also in the Console under **Load Balancers**. An empty line means the load balancer has no address yet.

### Point your domain at the edge

NBO doesn't create DNS records. You add one wildcard record, once, wherever your domain's DNS is managed, such as Netlify, Cloudflare or your registrar. On Netlify, that's **Domains → your domain → DNS settings → Add new record**.

| Type | Name     | Value              |
| ---- | -------- | ------------------ |
| A    | `*.apps` | The edge's address |

This points everything under `apps.example.com` at NBO and leaves whatever you host on `example.com` alone. It also covers each project's custom environments: an environment named `staging` of the project `shop` is served at `staging--shop.apps.example.com`. Every environment address takes its own Let's Encrypt certificate, so many environments across many projects can reach the weekly limit. The same wildcard covers ephemeral environments (`feature-login--shop.apps.example.com`); NBO orders at most 20 new certificates for them in any 7 days per registered domain, so Production and its renewals keep room under Let's Encrypt's limit of 50. One over the cap is served over HTTP until the window has room; use the Let's Encrypt staging option while testing. If your provider refuses a wildcard, add one record per site, such as `next-app.apps`. On Cloudflare, set the record to **DNS only** (grey cloud).

Set the base domain: `docker compose exec nbo nbo-server domains settings --base-domain apps.example.com`. If projects already exist, add `--move-existing` so each gets `<name>.apps.example.com` as its default address. Then check the record from your computer. It should print the edge's address:

```bash
nslookup next-app.apps.example.com 1.1.1.1
```

**The browser says the DNS address could not be found** (`DNS_PROBE_POSSIBLE`, or "Non-existent domain" from `nslookup`). The record is missing, or the domain itself doesn't exist yet. Check at your registrar that the domain is registered and active and has nameservers. After you fix it, the browser may keep showing the error for about 15 minutes, because "doesn't exist" answers get cached.

**No domain yet?** Without a base domain, projects use `<name>.<edge-ip-with-dashes>.sslip.io`, for example `next-app.203-0-113-7.sslip.io`. It needs no DNS record and is fine for a trial, but it shares Let's Encrypt limits with other sslip.io users. Don't set a base domain you don't own, because Let's Encrypt can't issue certificates for it.

### Get HTTPS

NBO gets a free certificate from Let's Encrypt by itself, once DNS points at the edge. You don't install anything. Port 80 must be reachable, because that's how Let's Encrypt checks your domain.

Watch the status with `nbo-server api GET /projects/<id>/domains`. It moves through "Waiting for DNS", "Issuing certificate" and "Active". `nbo-server api POST /projects/<id>/domains/<domain id>/check` skips any wait, at most once a minute.

With staging on, browsers show a certificate warning. That's expected, and it means the certificate was issued.

When the staging trial works, turn staging off. Existing staging certificates stay in place until they're renewed, about 60 days after they were issued. Remove and re-add custom domains to get trusted ones right away. A project's default address can't be removed, so it keeps its staging certificate. To avoid that, run the staging trial on the sslip.io address and set your base domain after you turn staging off, or set a new base domain then.

## 6. Deploy your first project

Describe the project as the body of `POST /projects/setup`, as in [step 4](#4-private-repositories), and send it on the server:

```json
{
  "name": "site",
  "repo": "https://github.com/you/site.git",
  "productionBranch": "main",
  "framework": "nextjs",
  "buildCommand": "npm ci && npm run build",
  "clouds": [{ "target": "kubernetes", "clusterId": "kc_..." }]
}
```

```bash
docker compose exec -T nbo nbo-server project setup --body-stdin < site.json
docker compose exec nbo nbo-server api GET /projects/summary
```

NBO doesn't install dependencies, so the build command must. `framework` is `nextjs` or `static` (add `"spa": true` for a single-page app and `"outputDir"` if it isn't `dist`). Each cloud is `{ "target": "kubernetes", "clusterId": "kc_..." }` or `{ "target": "cloudrun", "mode": "auto" }`. Setup prepares the clouds and starts the first build; the summary shows its progress and, once it has deployed, the project's address. From then on every push to the production branch builds and deploys. Terraform's `nbo_project` and `nbo_deployment` do the same from a `.tf` file (see [Manage it from code](#manage-it-from-code)).

Then add custom domains: `POST /projects/{id}/domains` with `{"host": "shop.example.com"}` (on the server, `nbo-server api POST /projects/<id>/domains --body-stdin`), or Terraform's `nbo_domain`. The answer holds the DNS record to create, and the domain then moves through "Waiting for DNS", "Issuing certificate" and "Active".

Using Cloudflare? A **DNS only** (grey cloud) record needs nothing special. For a proxied (orange cloud) record, turn on Behind Cloudflare for that domain (`PATCH /projects/{id}/domains/{domainId}` with `{"behindCloudflare": true}`), set SSL/TLS to Full (strict) and keep Always Use HTTPS off until the domain is Active. The steps and limits are in [Domains behind Cloudflare](./manual/domains.md#domains-behind-cloudflare).

> **Not tried for real yet.** Behind Cloudflare. The reach check, the warnings and the Origin CA option ran against fakes; no real Cloudflare zone has been used.

### Ephemeral environments (previews)

An [ephemeral environment](./manual/environments.md#ephemeral-environments) is a copy of the site for one branch, at its own address, that NBO removes by itself at its end time. They need no extra DNS beyond the wildcard record. NBO makes one only when asked through the API (the hosted dashboard does that for its previews); it no longer creates previews from pull requests or branch pushes on its own. Previews made by an earlier NBO become ephemeral environments when you upgrade: each keeps its address until its end time (its last push plus the project's old preview expiry, 7 days by default), and one already past it, or waiting for removal, is removed within 10 minutes of the upgrade. An ephemeral environment builds every push to its branch as the NBO user, so only make them for branches whose authors you trust.

### Staging and other environments

You can add environments such as `staging` (`POST /projects/{id}/stages`, or Terraform's `nbo_stage`), each with its own branch, variable values and address (`staging--<project>.<base domain>`). The [Environments](./manual/environments.md) chapter explains them. Variables are set with `PUT /projects/{id}/env/{name}` or Terraform's `nbo_env_var`. If you keep secrets in Terraform or a vault, the workspace setting [Don't store variable values](./manual/environments.md#dont-store-variable-values) makes NBO keep only variable names and take the values with each deploy. Turning it on deletes every stored value for good, so turn it on before you enter secrets you want to keep out of NBO's database. Running sites keep working, because their values live in your cluster or Google Cloud, but pushes to environments that have variable names no longer build by themselves.

## 7. Team access

NBO has no sign-in, members or roles. It trusts two kinds of caller. A request made on the server (through the SSH tunnel) with no token may do everything. A request with an API token may use the project API from anywhere that can reach NBO, but never `/system/*` (connections, clusters, the edge, tokens). Make a token on the server:

```bash
docker compose exec nbo nbo-server token create ci
```

It prints the token once: store it now, it is not shown again. `nbo-server token list` lists tokens (never their values) and `nbo-server token revoke <id>` removes one. A token can run builds, and a build can control this server, so only give a token to people and programs you'd give the root password.

Tokens made while an older NBO had sign-in on keep working if they were made for an Admin or an Owner. Those made for a Viewer or a Developer are refused with `401`, since NBO can no longer limit them; make new ones.

## 8. Reaching NBO on its own address

You can serve NBO at an address like `https://nbo.example.com` so that programs with an API token (Terraform, CI) and GitHub's push webhooks reach it without the SSH tunnel. On that address NBO answers only requests with a token and the per-project webhooks (which check their own signature); everything else gets `403`. You keep using the tunnel for everything without a token.

Conditions, all of them:

- The name is not under your projects' base domain. Use `nbo.example.com` with sites on `*.apps.example.com`, not `nbo.apps.example.com`.
- A DNS A record for the name points at this server, and ports 80 and 443 are open in the firewall.

Steps:

1. Add the name to `.env` next to `compose.yaml`: `NBO_PUBLIC_HOST=nbo.example.com`.
2. Start both files together:

   ```bash
   docker compose -f compose.yaml -f compose.public.yaml up -d
   ```

   `compose.public.yaml` adds Caddy (pinned to `caddy:2.8.4`) on ports 80 and 443. Caddy gets the certificate by itself and passes the `Host` header on unchanged. NBO gets `NBO_PUBLIC_URL=https://nbo.example.com`, and its own port stays on `127.0.0.1`. From now on, use the same two `-f` options in every `docker compose` command that starts NBO, including upgrades; a plain `docker compose up -d` restarts NBO without `NBO_PUBLIC_URL`.

3. Check it: `curl https://nbo.example.com/healthz` answers `{"ok":true}`, and `curl -H "Authorization: Bearer <token>" https://nbo.example.com/projects` lists your projects.

`NBO_PUBLIC_URL` must be `https://` with no path, or NBO won't start. If you use your own proxy instead of Caddy, it must pass `Host` unchanged. Check the log with `docker compose logs nbo`.

> **Not tried for real yet.** The Caddy setup has run only in local tests.

## Manage it from code

To set up projects, variables, domains and traffic from `.tf` files, make an API token with `nbo-server token create` (see [Team access](#7-team-access)) and see the [Terraform](./manual/terraform.md) chapter. A token can run builds, so treat it like a root password for this server.

## Linking to a hosted dashboard (optional)

NBO works fully without a dashboard. If you want a hosted dashboard to drive this server, link it with the one-time code the dashboard gives you, using `nbo-server link -` (it reads the code from standard input, so it stays out of your shell history). Your sites, deploys, certificates and crons never wait on the link, and the server checks every request itself; read [Linking to a hosted dashboard](./manual/link.md) first. To remove the link at any time, run `nbo-server unlink` on the server: it takes effect at once and your sites keep running exactly as before.

## Backups and restore

NBO has no automatic backups, and none are scheduled: you copy its two volumes by hand. Do it before every upgrade, and on a schedule of your own. If you script it, for example with `cron`, put the date in the file name (`nbo-backup-$(date +%F).tgz`) so a run doesn't overwrite the last good backup, and remember that NBO is stopped while it runs.

Copy both volumes while NBO is stopped. Run this in the folder with `compose.yaml`:

```bash
git rev-parse HEAD     # write this commit down: a restore needs the same version
docker compose stop
docker run --rm -v nbo_nbo-data:/data:ro -v nbo_nbo-keys:/keys:ro -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/nbo-backup.tgz --exclude=data/tmp --exclude=data/.pnpm-store -C / data keys
docker compose start
```

Then copy `nbo-backup.tgz` and your `.env` file off the server (see [Copying files to and from the server](#copying-files-to-and-from-the-server)). A backup that only lives on the server is lost with it.

To restore onto the same server:

```bash
docker compose down
docker run --rm -v nbo_nbo-data:/data -v nbo_nbo-keys:/keys -v "$PWD":/backup debian:bookworm-slim \
  tar xzf /backup/nbo-backup.tgz -C /
docker compose up -d
```

If you used step 8, add `-f compose.yaml -f compose.public.yaml` to both `docker compose` commands.

The archive holds the key and the credentials it opens, so store it somewhere safe. **If you lose `nbo-secret.key`, the stored credentials can't be read**, and NBO refuses to start while encrypted data exists without it. Always restore both volumes from the same archive: a key from one backup doesn't open the database of another. `docker compose down -v` deletes both volumes, so never add `-v` unless you mean it.

Sites keep serving while the control-plane is down, because the edge holds its routes and certificates. Renewal waits, and NBO renews 30 days before expiry, so you have about a month.

### Restore onto a new server

For when the old server is gone, or you are moving NBO.

> **Not tried for real yet.** Restoring onto a different server. The backup and restore commands were checked on one machine only (see [Read this first](#read-this-first)).

1. If the old server still runs, stop NBO there first with `docker compose down`, so two copies never manage the same clusters and domains at once.
2. Prepare the new server as in [step 1](#1-prepare-a-server): SSH key, Docker, firewall.
3. Clone NBO at the commit you wrote down with the backup, and build the image without starting it:

   ```bash
   git clone <your NBO repository> /opt/nbo
   cd /opt/nbo
   git checkout <commit from the backup>
   docker compose build
   ```

4. Copy `nbo-backup.tgz` and `.env` into `/opt/nbo` with `scp` from your computer.
5. Let Compose create its volumes, restore into them, then start:

   ```bash
   docker compose up --no-start
   docker run --rm -v nbo_nbo-data:/data -v nbo_nbo-keys:/keys -v "$PWD":/backup debian:bookworm-slim \
     tar xzf /backup/nbo-backup.tgz -C /
   docker compose up -d
   ```

   If you used step 8, add `-f compose.yaml -f compose.public.yaml` to the last command.

6. Check it:
   - `docker compose ps` shows `healthy`, and `docker compose logs nbo` contains `control-plane: listening on` and no `control-plane:` refusal. Lines after it about the edge being unreachable are harmless until NBO reaches your cluster.
   - `docker compose exec nbo nbo-server status` lists your connections, and `nbo-server api GET /projects/summary` your projects.
   - Your sites still answer. They never stopped: the edge runs in your cluster, not on this server.
   - If NBO has its own address (step 8), move its DNS A record to the new server's address.
   - If you limited your cluster's API or your Google project to the old server's address, allow the new one.

To come back to the newest version afterwards, follow [Upgrading NBO](#upgrading-nbo).

### Check a backup

A backup you have never opened may be empty. List what is inside:

```bash
tar tzf nbo-backup.tgz | grep -E '^(data/nbo\.db|keys/nbo-secret\.key)$'
```

It should print both `data/nbo.db` and `keys/nbo-secret.key`. If either is missing, the backup can't restore NBO: take a new one.

## Upgrading NBO

This is for a server that already runs NBO (this is also how you update it). Your projects keep serving while you upgrade, because the edge holds the routes and certificates. Run these in the folder you cloned NBO into, for example `/opt/nbo`. If you used step 8, add `-f compose.yaml -f compose.public.yaml` to each `docker compose up` below.

### Releases

Each release of NBO is tagged with its date, `v<year>.<month>.<day>`, and a second release on the same day gets `.2` (for example `v2026.11.19` and `v2026.11.19.2`). Its image has the same name, such as `ghcr.io/meliphyra-ux/nbo-core:v2026.11.19`, and `latest` is always the newest. The tags are listed at https://github.com/meliphyra-ux/nbo-core/tags.

To see the release your server runs, use `docker compose exec nbo nbo-server link status` and read `version`. A server from before release tags shows no `version`; a server built from source shows `dev`. A server linked to the hosted dashboard shows its release on its core page, together with these steps whenever a newer release exists. To stay on one release instead of `latest`, set `NBO_IMAGE=ghcr.io/meliphyra-ux/nbo-core:v2026.11.19` in `.env`.

### Every upgrade

1. **Back up both volumes first.** This is what makes a rollback safe. It uses the image you already have, so do it before you rebuild:

   ```bash
   cd /opt/nbo
   git rev-parse HEAD     # write this commit down, it is your way back
   git log -1 --format=%cs   # and its date: the version notes below go by it
   docker compose stop
   docker run --rm -v nbo_nbo-data:/data:ro -v nbo_nbo-keys:/keys:ro -v "$PWD":/backup debian:bookworm-slim \
     tar czf /backup/nbo-backup-before-upgrade.tgz --exclude=data/tmp --exclude=data/.pnpm-store -C / data keys
   docker compose start
   ```

   The archive holds the secret key and the credentials it opens, so keep it somewhere safe. See [Backups and restore](#backups-and-restore) for restoring it.

2. **Fetch the new version and start it:**

   ```bash
   git pull
   docker compose pull
   docker compose up -d
   ```

   The old container keeps running until the new one starts. The database upgrades itself when NBO starts, and the volumes `nbo-data` and `nbo-keys` keep everything: projects, connections, variables and the secret key. If you build the image yourself (`compose.build.yaml`, see [step 2](#2-start-nbo)), run `docker compose -f compose.yaml -f compose.build.yaml up -d --build` instead of the last two lines; that build is slow and needs a few GB of free disk.

3. **Check that it came up:**

   ```bash
   docker compose ps
   docker compose logs --tail 50
   ```

   `docker compose ps` should show the container as `healthy` (give it a minute after `health: starting`), and the log should end with NBO listening, not an error.

4. **Reinstall the edge.** Run `docker compose exec nbo nbo-server edge reinstall`, then `docker compose exec nbo nbo-server edge status --wait`, every time you upgrade. Nothing tells you when the edge is out of date, and an older edge lacks fixes (for example it passes a visitor's `CF-Connecting-IP` through) and can't take the Behind Cloudflare switch. Reinstalling reuses the saved load balancer location and keeps the same address.
5. **Clean up.** Each upgrade leaves the old image behind (and a build cache, if you build yourself). `docker image prune` and `docker builder prune` remove them.
6. **Read the notes below** for every version newer than the one you came from, and do what they say once.

### Notes for specific versions

Each note is headed with the date of the version it applies to. If the NBO you upgraded from is that date or newer (the date you noted in step 1 of [Every upgrade](#every-upgrade)), skip it.

**From 2026-11-08: save the Hetzner load balancer location.** NBO now reads the location from your nodes. Keep the `NBO_LB_ANNOTATIONS` line in `.env` until you've done this. Run `nbo-server cluster update-setup <id> --admin-kubeconfig-file -` once per cluster with admin credentials (see [step 5](#5-install-the-public-edge)), so NBO saves the location itself. After that you can remove the `.env` line and run `docker compose up -d`.

**From 2026-11-08: redeploy once for the deployment header and carried files.** A cloud sends `x-nbo-deployment-id` (so Speed Insights credits the exact build) and keeps the previous build's hashed files only from its next real deploy, which builds a new app image. Building again a build that is "already live" skips the image, so push a commit or change a variable. Until then that cloud keeps the older behaviour.

**From 2026-11-08: environments.** The first start upgrades the database: every project gets the Production, Preview and Development environments, and all existing variables, clouds, builds and domains become Production's, so nothing about a running site changes. Each environment address takes its own Let's Encrypt certificate under your base domain, which counts toward the weekly limit.

**From 2026-11-08: the Terraform provider in the image.** The image is about 130 MB bigger, because it carries the Terraform provider for five platforms. Check that the downloads are there with `docker compose exec nbo nbo-server api GET /system/terraform-provider`.

**From 2026-11-09: apps with ISR pages redeploy once to get a cache.** Reinstall the edge before you revalidate pages: an older edge sends `POST /_nbo/revalidate` to one cloud only, so a project on two clouds would refresh just one of them. A Next.js app with pages that have `export const revalidate` runs its own small cache and gets a revalidation secret from its next deploy. A fresh build of the branch (`POST /projects/{id}/builds`) or deploying the live build again is enough: the new secret makes the build count as changed, so it deploys once even when nothing else changed, with a new app image. No commit is needed. Until then its pages are not cached and revalidation answers `401`. The cache is one small pod per app on Kubernetes (about 64 MiB) and one Cloud Run service per app that scales to zero (256 MiB). Sites without ISR pages are not touched. More in [Page cache and revalidation](./manual/cache.md).

**From 2026-11-09: Neutral Build Output spec 1.0.** The first new build of each project that has functions deploys once, because its content id changed. Stored builds keep validating and can still be deployed.

**From 2026-11-12: NBO without the dashboard, sign-in, the GitHub App, previews or Speed Insights storage.** Those features moved to the hosted dashboard. The first start upgrades the database: the settings table is renamed (every value, sealed ones included, is kept, and the key check still covers the stored GitHub and Google secrets), previews become [ephemeral environments](#ephemeral-environments-previews), and the tables of the moved features (members, sessions, invites, sign-in rules, the audit log, the GitHub App's installation and deliveries, preview settings and Speed Insights data) stay in the database, unused and unchanged, for the hosted dashboard's one-time import. NBO prints one line naming them at every start (`this database holds data from features that moved to the hosted dashboard`); it is a notice, not an error. If sign-in was on, read this before you start the new NBO: sign-in no longer protects anything, so a request that reaches NBO's port with no token may do everything, as on an NBO that never had sign-in. Keep the port published on `127.0.0.1` only (the default `compose.yaml` does) and reach NBO through the SSH tunnel; never publish it on a public address. Tokens made for a Viewer or a Developer stop working ([Team access](#7-team-access)).

The API also lost its `/api/controlplane` prefix, which only the dashboard's server added. **If you use Terraform,** change the provider's `endpoint` (or `NBO_ENDPOINT`) to NBO's own address with no path, such as `http://localhost:8081`; with the old path the provider stops with "NBO answered with something that isn't its API". Scripts that call `/api/controlplane/...` need the same change. Projects linked to the old GitHub App keep building, with three changes you will notice: their check runs no longer appear on commits and pull requests (and "Re-run" on an old check does nothing); GitHub's deliveries to the app's `POST /github/webhook` now get `404` and show as failed in the app's settings on GitHub; and so a push builds only when NBO's poll sees it, about 45 seconds later. Nothing is broken. To move such a project to a credential of its own, send `PUT /projects/{id}/git` with its settings and a `credential` (a deploy key, with the repository's SSH address, or a token; see [Private repositories](#4-private-repositories)): that drops the old link. For faster pushes, add the per-project webhook (`POST /projects/{id}/webhooks/github`, signed with the `webhookSecret` that same answer gives) to the repository, then uninstall the old app.

### Rolling back

**To roll back,** restore the backup you took in step 1 of [Every upgrade](#every-upgrade), and then run the older code on it. Running an older NBO on the upgraded database is not supported: once a variable name exists in two environments, or you have turned on names-only variables, the older NBO refuses to start, and even before then it mishandles rows that newer features created (domain rows, and the clouds and builds of custom environments, which it would show as Production's). So the restore is not optional, and anything you changed in NBO after the backup is lost. Builds follow the same rule. An NBO that reads Neutral Build Output spec 1.0 refuses a build written for a newer minor version of the spec, so after a rollback the builds the newer NBO made can't be promoted or deployed. Rebuild them with the older NBO (the restore already brings back the builds it knew). When NBO moved to spec 1.0 final, the first new build of each project that has functions deployed once, because its content id changed; going back does not undo that.

Rolling back from 2026-11-12 or newer to an NBO from before that date also means restoring the backup. The older NBO looks for its settings under their old table name, finds nothing, and runs as if it had none (no base domain, no Let's Encrypt account, no GitHub App). If it then saves a setting, the newer NBO refuses to start later with `this database has settings in both platform_settings and server_settings`, rather than lose that change silently. The fix is the same: restore the backup from before the upgrade.

1. If you are going back to a version older than 2026-11-08 and removed the `NBO_LB_ANNOTATIONS` line from `.env`, put it back, because the older NBO doesn't detect the location itself.
2. Find the previous commit. Use the one you wrote down in step 1 of Every upgrade, or `git log --oneline -5` or `git reflog`.
3. Restore the backup you took in step 1 of Every upgrade, then check out that commit and run its image. Each commit on `main` has its own image, tagged `sha-` plus the first 12 characters of the commit, and each release also has one tagged with its name (see [Releases](#releases)):

   ```bash
   docker compose down
   docker run --rm -v nbo_nbo-data:/data -v nbo_nbo-keys:/keys -v "$PWD":/backup debian:bookworm-slim \
     tar xzf /backup/nbo-backup-before-upgrade.tgz -C /
   git checkout <previous commit>
   echo "NBO_IMAGE=ghcr.io/meliphyra-ux/nbo-core:sha-$(git rev-parse --short=12 HEAD)" >> .env
   docker compose up -d
   ```

   Restoring puts the database back as it was before the upgrade, which is what lets the older code start. Anything you changed in NBO since then is lost. To come back to the newest version later, remove the `NBO_IMAGE` line from `.env`, then run `git checkout main && git pull && docker compose pull && docker compose up -d`. If you build the image yourself, run `docker compose -f compose.yaml -f compose.build.yaml up -d --build` after the checkout instead of setting `NBO_IMAGE`. Images exist only for commits made after 2026-11-16; an older commit has to be built this way.

## Running without Docker

The same NBO, run directly on the server.

> **Not tried for real yet.** Running without Docker. These steps were checked on Windows up to starting in production mode. The `systemd` example hasn't been run.

You need Node.js 24, pnpm, Git, Docker and kubectl on the server, plus gcloud with its beta component if you use Cloud Run (`gcloud components install beta`). Keep the repository checkout there: installing the edge builds its image from it.

```bash
git clone <your NBO repository> /opt/nbo
cd /opt/nbo
pnpm install
pnpm build --force

sudo mkdir -p /var/lib/nbo
sudo chown "$USER" /var/lib/nbo
chmod 700 /var/lib/nbo

NBO_MODE=production \
NBO_CONTROL_PLANE_DB=/var/lib/nbo/nbo.db \
node packages/controlplane/dist/main.js
```

`--force` matters: a cached build can leave old code in `dist/`.

It listens on `127.0.0.1:8081`. Leave `NBO_CONTROL_PLANE_ADDR` unset, so it stays on loopback. Then continue from step 3.

The command above sets two settings. Every variable NBO reads, with its default and whether it is safe to change on a running server, is in [Server settings](./manual/server-settings.md).

To keep it running after you log out, use systemd:

```ini
# /etc/systemd/system/nbo-control-plane.service
[Unit]
Description=NBO control-plane
After=network-online.target docker.service

[Service]
User=nbo
WorkingDirectory=/opt/nbo
Environment=NBO_MODE=production
Environment=NBO_CONTROL_PLANE_DB=/var/lib/nbo/nbo.db
ExecStart=/usr/bin/node packages/controlplane/dist/main.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The `nbo` user needs access to Docker, and `node`, `git`, `docker` and `kubectl` on its `PATH`. Adjust the path to `node` for your install.

To back up, stop the service and copy the data folder:

```bash
sudo systemctl stop nbo-control-plane
tar czf nbo-backup.tgz -C /var/lib nbo
sudo systemctl start nbo-control-plane
```

To update:

```bash
cd /opt/nbo
git pull
pnpm install
pnpm build --force
sudo systemctl restart nbo-control-plane
```

## Checks in GitLab

The repository has a GitLab pipeline that builds, tests and deploys the Next.js test sites to a throwaway Kubernetes cluster and to a CI-only Cloud Run project. What runs, what it costs and the one-time Google setup are in `docs/ci.md`.

## Known limits

- The page cache for ISR pages (memory only, Cloud Run cost, the Kubernetes security settings, server actions, the render cost of prefetching) is described in [Page cache and revalidation](./manual/cache.md#limits).
- PPR shells don't refresh until the next deploy, even for `"use cache"` content.
- Cookies set while a PPR page's dynamic part renders are dropped, because headers go out with the shell.
- The control-plane, and therefore builds and deploys, run on one server.
- Builds are not isolated from NBO itself, and backups are by hand. Neither is scheduled to change.
- The edge and relay images are built for x64. Build on an x64 server if your cluster's nodes are x64.
