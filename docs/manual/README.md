# The NBO manual

Every chapter of the manual for NBO, in reading order. NBO has no web interface: you set it up with `nbo-server` on the server, and use it through its HTTP API or Terraform. To launch NBO for real sites, start with [Launch NBO on a server](../production.md). To try it on your own computer, start with [Running NBO for development](./running.md). Every API route, with who may call it, is in the architecture page, `docs/architecture/index.html` (open it in a browser).

## Use NBO

- [Environments and variables](./environments.md): Production, Preview, Development and your own, ephemeral environments, variables per environment, the no-stored-values setting and deleting a project.
- [Domains and the public edge](./domains.md): the public edge in your cluster, base domain, your own domains and certificates.
- [Page cache and revalidation](./cache.md): ISR pages, the page cache, revalidating from code or a CMS, the secret, and what it costs.
- [Traffic and moving clouds](./traffic.md): change the traffic split between clouds, move a project from one cloud to another, and how the edge decides.
- [Terraform](./terraform.md): manage projects, private repositories, variables, domains and traffic from .tf files, with API tokens.

## Run NBO

- [Creating a Kubernetes cluster](./clusters.md): create a Kubernetes cluster for NBO at GKE, Hetzner, DigitalOcean or anywhere else, and connect it.
- [Server settings](./server-settings.md): every setting the programs read, `nbo-server`, the Compose .env file, ports, files and volumes, and what NBO prints when it refuses to start.
- [What has been tried for real](./tried.md): what has run on real infrastructure and what has only run against fakes, feature by feature.
- [Linking to a hosted dashboard](./link.md): what the link lets a hosted dashboard do to your server, member keys and approval, the journal, unlinking and what keeps working without it.
- [Troubleshooting](./troubleshooting.md): errors you may see, what they mean and how to fix them.

## How NBO works

- [Concepts](./concepts.md): every idea the rest of the manual uses, explained from zero.
- [Repository map](./repository.md): every folder and package, and what lives where.
- [Running NBO for development](./running.md): starting the services, a first project, ports, settings and commands.
- [Builds](./builds.md): how NBO clones, builds and packages your code, and how it reaches private repositories.
- [Deploying](./deploying.md): how a build becomes running containers on Kubernetes and Cloud Run.
- [Inside a running app](./runtime.md): what happens inside a deployed app for every request.
- [The control-plane](./control-plane.md): the server behind the API: data, modules and routes.
- [Tests and code quality](./quality.md): how the code is tested and kept tidy.
