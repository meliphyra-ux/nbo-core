# NBO

NBO is a hosting platform you run yourself, a bit like Vercel. Point it at a Git repository and it builds the site, packages the result into a cloud-neutral folder (`.nbo/`), deploys it to Kubernetes, Google Cloud Run or both, and puts its own edge in front so you can move a site between clouds without downtime. It supports Next.js, React single-page apps (Vite) and static sites.

NBO has no web interface. You drive it with `nbo-server` (a command on the server), its HTTP API and its Terraform provider. A hosted dashboard made by NBO's licensor can sit on top of the same API; NBO does not need it.

## Quick start on your computer

This runs NBO in dev mode against a local Kubernetes cluster made with `kind`. You need Node.js 24, pnpm, Docker, `kind` and `kubectl`.

```bash
pnpm install
pnpm build
./scripts/bootstrap-local-k8s.sh          # a local kind cluster with ingress and certificates
NBO_CONTROL_PLANE_DB=./nbo.db node packages/controlplane/dist/main.js &
node packages/edge/dist/main.js &          # the local edge on :9443
```

Then describe a site in `site.json` (any public repository with a static site works) and send it with `nbo-server`:

```json
{
  "name": "hello",
  "repo": "https://github.com/you/hello.git",
  "productionBranch": "main",
  "framework": "static",
  "buildCommand": "npm ci && npm run build",
  "outputDir": "dist",
  "clouds": [{ "target": "kubernetes" }]
}
```

```bash
node packages/controlplane/dist/server-cli.js project setup --body-file site.json
node packages/controlplane/dist/server-cli.js api GET /projects/summary
```

When the build has deployed, the site answers at `http://hello.127.0.0.1.sslip.io:9443`. The [Running NBO for development](./docs/manual/running.md) chapter has the details, and [Launch NBO on a server](./docs/production.md) runs NBO for real sites with Docker Compose.

## Which document for what

| You want to                                               | Open                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| Launch NBO on a server for real sites                     | `docs/production.md`                                                |
| Learn how to use and run NBO, or how the code works       | The manual in `docs/manual/`, starting with `docs/manual/README.md` |
| See the architecture and the HTTP API                     | `docs/architecture/index.html` (open it in a browser)               |
| Read the exact `.nbo/` format                             | `docs/nbo-spec.md`                                                  |
| Understand a design decision                              | `docs/context.md` and `docs/adr/`                                   |
| Set up your machine for development and clean up after it | `docs/local-dev.md`                                                 |
| Read about the GitLab pipeline                            | `docs/ci.md`                                                        |
| Know what is unfinished or rough                          | `docs/points-to-improve-or-fix.md`                                  |

## Commands

Run these at the repository root.

```bash
pnpm install                     # install the workspace
pnpm build                       # compile every package
pnpm test                        # run every package's tests
docker compose up -d             # run NBO from the published image (API on 127.0.0.1:8081)
docker compose -f compose.yaml -f compose.build.yaml up -d --build   # or build the image here
pnpm docs:check                  # check the documentation against the code
git config blame.ignoreRevsFile .git-blame-ignore-revs   # blame skips the format-only commits
```

## License

NBO is released under the Functional Source License (FSL-1.1-ALv2). In plain words:

You may use, copy, change and run NBO, including for your company's own sites and for clients. You may not offer NBO, or something built from it, as a product or service that competes with NBO or with the hosted dashboard made by its licensor. Each release becomes Apache 2.0 two years after it is published. This is a summary; LICENSE.md is what counts.

Third-party code and data NBO contains or installs (web-vitals, libvips through sharp, and a few data licenses) keep their own licenses: see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), which also says where to get the libvips source.
