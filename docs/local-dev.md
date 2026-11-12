# Local dev: launching apps and cleaning up

Operational notes for developing NBO on your own computer, mostly on Windows: where caches can go, and the gotchas this project has actually hit. Not spec, not architecture.

Commands assume the repository root.

## Moving caches off the system drive

Docker images, pnpm caches and the OS temp folder all default to the system drive, which can run out of space during testing. One way is to move them to a second drive, here `D:\devcache\`; use any drive with room:

| What                                                                       | Location                                | How it's set                                                     |
| -------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Docker Desktop's WSL2 data (images, containers, volumes, the kind cluster) | `D:\devcache\docker-wsl\data\ext4.vhdx` | WSL distro `docker-desktop-data` imported there (see Cleanup #6) |
| Go build cache                                                             | `D:\devcache\go-cache`                  | `go env -w GOCACHE=...`                                          |
| Go module cache                                                            | `D:\devcache\go-mod`                    | `go env -w GOMODCACHE=...`                                       |
| pnpm global store                                                          | `D:\devcache\pnpm-store`                | `pnpm config set store-dir ... --global`                         |
| OS temp (`%TEMP%`/`%TMP%`)                                                 | `D:\devcache\temp`                      | user-level env var                                               |

All of this is machine config, not anything checked into the repo: a fresh clone or a different machine doesn't need any of it and just uses the OS defaults.

## Commands

The commands for building, producing `.nbo/`, validating, serving, deploying and running the conformance checks live in the manual's "Running NBO for development" chapter (`docs/manual/running.md`). The repository is all TypeScript apart from the Terraform provider (Go) and the Rust edge, so there is no separate `nbo` binary to build: the CLI runs from `packages/cli` after `pnpm build`. This file keeps only machine-level notes.

To drive a local control-plane without a dashboard, use `node packages/controlplane/dist/server-cli.js` (the same `nbo-server` command the Docker image carries): `project setup --body-file site.json`, `api GET /projects/summary`, and `help` for the rest.

For the end-to-end checks, run the scripts in `scripts/` (`./scripts/verify-step0.sh`, `./scripts/verify-slice1.sh`, `./scripts/verify-slice2.sh`).

## Cleanup

Rough edges, in the order they tend to actually bite:

**1. A `nbo serve` that got killed hard (not Ctrl+C) can orphan its spawned function host.**
On Windows, hard-killing (Task Manager, `Stop-Process -Force`, a script whose own kill doesn't land) bypasses `nbo serve`'s graceful shutdown, because Windows has no real `SIGTERM` for Node to catch. The orphaned Node child keeps the port open and keeps the function's bundle directory locked, so a later `rm -rf .nbo` fails with `EBUSY`/"resource busy".

Find and kill it:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'nbo-nodehost' } |
  Select-Object ProcessId, CommandLine
Stop-Process -Id <id> -Force
```

**2. A stale `nbo`/test binary can be squatting the port you want.**
If `nbo serve --port N` fails with "Only one usage of each socket address", or curl against that port returns something unexpected, check who actually owns it before assuming your own process is broken:

```powershell
Get-NetTCPConnection -LocalPort 4100 | Select-Object OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object ProcessId, Name, CommandLine
```

Confirm it's actually yours (an old `nbo serve`/`next start` from a previous session) before killing it.

**3. Removing build output.**

```bash
rm -rf fixtures/<app>/.next fixtures/<app>/.nbo
```

If this fails with "Device or resource busy", that's #1, kill the orphaned node process first, then retry.

**4. Tear down test deployments on the cluster** (these are disposable test infra, safe to delete and redeploy):

```bash
kubectl delete deployment <app-name> <app-name>-fn-<function-name> --ignore-not-found
kubectl delete service <app-name>-fn-<function-name> --ignore-not-found
```

Needed before a redeploy whose `.nbo/` content didn't change: `nbo deploy`'s content-id check would otherwise skip the function deployments and you'd never see a function-image fix take effect. Full cluster teardown (rare, only if you want a genuinely clean slate): `kind delete cluster --name nbo-local`, then `./scripts/bootstrap-local-k8s.sh` again.

**5. Docker disk usage.**
Each deploy builds fresh, timestamp-tagged images (`nbo-app-<name>:<digest>`, `nbo-fn-<name>-<fn>:<timestamp>`) that accumulate. Check and reclaim images/build cache only:

```bash
docker system df
docker image prune -af
docker builder prune -af
```

**Never run `docker volume prune` (with or without `-af`) without first listing volumes and checking every name.** Docker Desktop is shared across every project on the machine, a volume prune doesn't scope to nbo, it removes every _unused_ volume system-wide, and "unused" just means no container is running right now, not "safe to delete." This has deleted the databases of unrelated projects in one `-af` run. Check first:

```bash
docker volume ls
```

and only remove ones you can name and don't need.

With Docker's data on a roomy drive (see above) this is a smaller concern, but images and build cache still accumulate over a long session.

**6. If Docker Desktop's storage ever needs moving to another drive again:** stop Docker Desktop AND kill `com.docker.backend`/`com.docker.build` explicitly (`Stop-Process -Force` on just the "Docker Desktop" window process name misses these, they kept running once already, which left the engine in a stuck state until they were killed too and Docker Desktop restarted fully clean). Then `wsl --shutdown`, `wsl --export docker-desktop-data <dest>.tar`, `wsl --unregister docker-desktop-data`, `wsl --import docker-desktop-data <new-path> <dest>.tar --version 2`, restart Docker Desktop. Known limitation hit doing this: Docker Desktop tracks its data distro by more than just the WSL name internally, so a relocated import can come back with the _filesystem_ intact but image/container _metadata_ reset to empty (build cache blobs survive as orphaned/reclaimable, named images and the kind cluster don't). Nothing in this project is uniquely stored only in Docker, everything (images, the kind cluster) is one `./scripts/bootstrap-local-k8s.sh` + a redeploy away from being back, so this is an inconvenience, not data loss, _for this project_. It is real data loss for anything else running in Docker on the same machine if its state wasn't otherwise backed up, check other projects' containers before relying on this working cleanly.
