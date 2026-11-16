# Concepts

Every idea used in the rest of the manual, starting from what a front-end developer already knows. Skim the headings and read the ones that are new to you.

## The web basics we build on

### Server, request, response

A **server** is a program that waits for **requests** and sends back **responses**. When your browser opens `https://example.com/about`, it sends a request ("GET /about, please") and gets a response: a **status code** (200 = OK, 404 = not found, 500 = server error, 502 = the server behind me failed), some **headers** (key/value metadata such as `content-type: text/html`), and a **body** (the HTML, JSON, image …).

### Port

One computer can run many servers. Each listens on a numbered **port**. `localhost:8081` means "this computer, port 8081". In dev mode NBO uses: 8081 (control-plane), 9443 (edge, for visitors), 9444 (edge admin). In production the Docker image serves the control-plane on one port (8081 unless you change it) and the edge listens on ports 80 and 443 in your cluster.

### Host and domain

The **host** is the name part of a URL: in `http://next-app.127.0.0.1.sslip.io:9443/`, the host is `next-app.127.0.0.1.sslip.io`. Browsers send it in every request as the `Host` header. The edge uses it to know which project you want.

**sslip.io** is a free public service: any name ending in `.127.0.0.1.sslip.io` points to `127.0.0.1` (your own machine). That gives every project its own domain locally without editing any files. Production uses your own domain instead; see **Base domain** below.

### API and JSON

An **API** is a set of URLs a program answers with data rather than pages. The control-plane's API returns **JSON** (the same format as JavaScript object literals). `nbo-server`, Terraform and your own scripts call it, much like a React app calls a backend with `fetch`.

### Fetch-style handler

Modern JavaScript has standard `Request` and `Response` classes (the ones `fetch` uses). Much of NBO's server code is written as a **handler**: a function `(request: Request) => Promise<Response>`. It's easy to test (call it with a fake request, check the response) and the same function can run in many places. You'll see the type name `FetchHandler` throughout.

## Building and packaging

### Build

Most front-end projects need a **build** step before they can be served: TypeScript is compiled to JavaScript, files are bundled and minified, and file names get a hash (`index.3f9a2c.js`) so browsers can cache them forever. The build output for a Vite app is usually a `dist/` folder; Next.js writes to `.next/`.

### Static vs dynamic

- **Static** files are the same for every visitor: HTML, CSS, JS, images. Any file server can send them.
- **Dynamic** responses are computed per request by running code on the server: server-side rendering (SSR), API routes, middleware. NBO calls each piece of server code a **function**.

### SPA fallback

A **single-page app** (SPA) has one `index.html`; React Router decides what to show from the URL. If a visitor opens `/settings` directly, there's no `settings.html` file, so the server must answer with `index.html` anyway. That's the **SPA fallback**. NBO turns it on with `--spa` / the "React (Vite)" preset.

### `.nbo/`, the neutral build output

The folder NBO produces from any framework's build. Inside:

| File / folder                                             | What it holds                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `manifest.json`                                           | The table of contents: framework, functions, required capabilities, digests of the other files. |
| `static/`                                                 | Every static file, renamed by its content hash.                                                 |
| `static.index.json`                                       | Maps each URL path (`/about`) to a file in `static/`, with its `contentType` and cache policy.  |
| `routes.json`                                             | Routing rules: redirects, rewrites, headers, which paths go to which function.                  |
| `functions/<name>/`                                       | One folder per server function: `function.json` (how to run it) and `bundle/` (its code).       |
| `prerender.json`, `images.json`, `env.json`, `crons.json` | Optional: ISR pages, image optimization settings, environment variable names, scheduled jobs.   |

Rule: `.nbo/` never mentions a cloud. No account ids, no region names, no secrets. The exact format is in `docs/nbo-spec.md`.

### Producer

A program that writes `.nbo/` from a framework's build. NBO has two: `packages/producer-static` (static sites and SPAs) and `packages/next-adapter` (Next.js). Both use the shared writer in `packages/writer`.

### Digest, hash, content id

A **hash** (here SHA-256) turns any data into a fixed 64-character fingerprint. Change one byte and the fingerprint changes completely. A **digest** is a hash used to check that a file is exactly what was expected.

The **content id** is the hash of `manifest.json` (minus its `build` block, which holds timestamps). Because the manifest contains the digests of every other file, the content id fingerprints the entire build. Two builds of the same commit produce the same content id; that's checked in CI. The one allowed difference is pages your app renders at build time: a Next.js page that prints the time is rendered again on each build, so those two builds get different content ids, and CI accepts that only when nothing else differs. NBO uses it to skip work: if the cloud is already running this content id, deploying again is a no-op.

### Canonical JSON

The same object can be written as JSON many ways (key order, spaces). To hash JSON reliably, NBO first writes it in one fixed way, **canonical JSON** (RFC 8785). Code: `packages/digest/src/digest.ts` → `canonicalize`, `contentId`.

### RE2

A kind of regular expression that's guaranteed to run fast (no "catastrophic backtracking"). All route patterns in `routes.json` must be RE2-compatible, so a malicious URL can't make the router hang.

## Running code in the cloud

### Container and image

A **container** is a sealed box holding a program plus everything it needs (Node.js, libraries, files), so it runs the same on any machine. The recipe for building one is a **Dockerfile**; the built, frozen result is an **image**; a running copy of an image is a container. NBO builds images with **Docker** on your machine.

### Registry

A storage service for images. Cloud Run can only run images from a registry it can reach, so NBO **pushes** images to Google **Artifact Registry** (a repository named `nbo`). In dev mode the local Kubernetes cluster doesn't need one: NBO loads images straight into it. A cluster you connect in production pulls from the same Artifact Registry repository, through a read-only service account NBO makes for it.

### Kubernetes, cluster, kind, kubectl

**Kubernetes** runs containers across a group of machines (a **cluster**) and keeps them running. You describe what you want in YAML files ("one copy of this image, reachable on port 8080") and Kubernetes makes it so. In production you connect a cluster you rent from any provider (version 1.30 or newer); see [Creating a Kubernetes cluster](./clusters.md). **kind** ("Kubernetes in Docker") runs a whole cluster inside Docker on your laptop; dev mode uses one called `nbo-local` (context `kind-nbo-local`). **kubectl** is the command-line tool to talk to a cluster.

The Kubernetes objects NBO creates:

- **Deployment**: "keep N copies of this container running"; replaces them when the image changes.
- **Pod**: one running copy (Kubernetes creates these for the Deployment).
- **Service**: a stable internal address that spreads requests across the pods.
- **Ingress**: a rule that routes outside traffic for a host name to a Service. Handled by **ingress-nginx**.
- **cert-manager**: issues TLS (HTTPS) certificates. NBO's local kind cluster uses a self-signed issuer; in production, NBO's own edge gets certificates from Let's Encrypt (see [Domains and the public edge](./domains.md)).

### Cloud Run, gcloud

**Cloud Run** is Google's service that runs a container image and gives it an HTTPS URL, scaling it up and down (to zero when idle). Each deployed thing is a **service**. **gcloud** is Google's command-line tool; NBO calls it to push images and deploy services. In dev mode it uses whatever Google account you logged into with `gcloud auth login`. In production you connect Google once with `nbo-server connect google` (with your own login or a key) and NBO uses its own service accounts.

### Adapter

The code that knows one cloud. Takes `.nbo/` and turns it into that cloud's objects. `packages/adapter-k8s` and `packages/adapter-cloudrun`, wired together in `packages/deploy`.

### Capabilities and the planner

Each adapter declares what it can do (stream responses? run crons? max memory?). Each build declares what it needs. The **planner** (`packages/planner`) compares the two before deploying and refuses with a readable report if the cloud can't run the build.

## NBO's own words

| Word                       | Meaning                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**                | One imported repository. Has a name, Git settings, one or more clouds, and an edge host.                                                                                                                                                                                                                                                |
| **Cloud**                  | One place a project runs: a Kubernetes cluster you connected, or Cloud Run (with its Google project, region and registry). A project can run on several clouds at once. This manual calls each one a cloud; the code and the API call it an environment row, which is why you will sometimes see `environments` in the code.            |
| **Environment**            | A named copy of your project with its own branch, variables, address and clouds. Every project has **Production**, **Preview** and **Development**, and you can add your own such as `staging`. This is the same word Vercel uses. The code and API call a custom one a **stage**. See [Environments and variables](./environments.md). |
| **Ephemeral environment**  | A temporary copy of your site for one branch, with its own address and an end time; NBO removes it when the end time passes. Previews of pull requests can be made as ephemeral environments through the API. See [Ephemeral environments](./environments.md#ephemeral-environments).                                                   |
| **Build**                  | One attempt to clone, build and package a commit, then deploy it to every cloud that should get it. Has a status (queued, running, skipped, succeeded, failed) and a log.                                                                                                                                                               |
| **Deployment**             | The result of deploying one build to one cloud. Has a URL and a status. One build makes one deployment per cloud.                                                                                                                                                                                                                       |
| **Live build**             | The build a cloud is serving right now. Each cloud has one. `GET /projects/{id}/summary` names it for each cloud.                                                                                                                                                                                                                       |
| **Production build**       | The live build of the cloud that gets the most Production traffic. It is "what visitors see" for the project.                                                                                                                                                                                                                           |
| **Environment variable**   | A named setting (like `DATABASE_URL`) given to your build and your running app. Set for the whole workspace or one project (project wins); mark it secret to hide it. Changes apply on the next deploy.                                                                                                                                 |
| **Edge host**              | The project's public name on the edge. In dev mode it is `<name>.127.0.0.1.sslip.io`; in production it is `<name>.<base domain>` (or `<name>.<ip-with-dashes>.sslip.io` until you set a base domain). Custom environments add `<environment>--<name>` in front.                                                                         |
| **Base domain**            | A domain you own (for example `example.com`) that NBO builds default addresses from: `my-site.example.com`. You point it at the edge once. Set with `nbo-server domains settings --base-domain`.                                                                                                                                        |
| **Traffic weight / split** | How many of every 100 visitor requests go to each cloud.                                                                                                                                                                                                                                                                                |
| **Transfer**               | Moving a project from one cloud to another in steps: 1% → 10% → 50% → 100%.                                                                                                                                                                                                                                                             |
| **Preflight**              | A quick check of whether the connected clouds are usable right now (`nbo-server status`, or `GET /system/preflight`).                                                                                                                                                                                                                   |
| **API token**              | A named secret that lets a program (Terraform, CI, a script) use NBO's project API from outside the server. Made with `nbo-server token create`. NBO has no sign-in, members or roles. See [Terraform](./terraform.md).                                                                                                                 |
| **Control-plane**          | The server that manages everything and answers the API.                                                                                                                                                                                                                                                                                 |
| **Edge**                   | The proxy visitors connect to; picks a cloud for each request. It runs on your computer in dev mode and inside your cluster in production.                                                                                                                                                                                              |
