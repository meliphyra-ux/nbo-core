# Traffic and moving clouds

A project can run on one cloud or on several (Cloud Run, and any Kubernetes cluster you connected). Visitors never choose: they use the project's own address, and NBO's **edge** decides, request by request, which cloud answers. This chapter shows how to change that split, how to move a site from one cloud to another without downtime, and how the edge does it. The last section, [How it works](#how-it-works), is for readers who want the machinery.

## Why NBO has its own edge

Each cloud gives your app its own address: Cloud Run gives something like `https://p4715bebb-cloudrun-….run.app`, Kubernetes gives `https://p4715bebb-k8s.127.0.0.1.sslip.io`. If visitors used those, moving to another cloud would mean changing the address everyone uses.

So NBO puts its own server in front: the **edge**. Visitors always use the project's edge address (in local development, `http://next-app.127.0.0.1.sslip.io:9443`; on a server, the project's address under your base domain, see [Domains and the public edge](./domains.md)). The edge decides which cloud answers. Moving clouds becomes "change the numbers in the edge", with no new address, no DNS change and no downtime.

Each visitor stays on the cloud the edge first gave them, so a page and its script files come from the same build. A change in the split moves only as many visitors as it must.

## Changing the split by hand

A **split** is the share of visitors each cloud gets, written as percentages that add up to 100. It matters once the project runs on two or more clouds that have each deployed successfully.

1. Read the project's clouds and their split: `GET /projects/{id}/traffic`. Each cloud has an `id`.
2. Send the new split: `PUT /projects/{id}/traffic` with `{ "weights": { "<cloud id>": 90, "<cloud id>": 10 } }`. On the server: `nbo-server api PUT /projects/<id>/traffic --body-stdin`.
3. Read it again. `edgeInSync: true` means the edge has the same numbers as NBO. If it is `false`, send the split again, or wait for the next sync (about 45 seconds).

The rules:

- The numbers must be whole numbers from 0 to 100, and at least one above 0.
- A cloud that has never deployed successfully has nothing to serve, so NBO refuses to give it traffic. A cloud that did deploy and is now redeploying, or whose latest deploy failed, can still take traffic, because the earlier deployment still serves.
- A cluster without public entry can't take traffic yet. NBO refuses with "This cluster has no public entry yet"; enable it with `nbo-server cluster relay <id> --confirm-billing`. See [Other clusters: public entry](./domains.md#other-clusters-public-entry).
- You can't change the split while a transfer is running (below).

The new numbers apply from the very next request. Requests already in flight finish where they started.

The same split can be set from code with `nbo_traffic` in [Terraform](./terraform.md) or `PUT /projects/{id}/traffic`.

The project summary (`GET /projects/{id}/summary`) lists each cloud's address, its share and its **live build**. A cloud at 0% that isn't in a transfer can be removed when the project has another cloud: `POST /environments/{id}/archive`. Removing it only stops NBO deploying there. The running service is left in place, and you delete it in your cloud console or with `kubectl`. To take everything down, delete the whole project with `DELETE /projects/{id}?resources=true` (see [Environments and variables](./environments.md#deleting-a-project)).

## Which build is production

Each cloud serves its own live build, and the clouds can differ when automatic deploys (`autoDeploy`, `PATCH /environments/{id}`) are off on one of them. The project's **production** build is the live build of the cloud with the most traffic (ties go to the first cloud). Before any cloud serves a build, it is the newest commit build that deployed somewhere.

`GET /projects/{id}/summary` names each cloud's live build and the production build.

## Moving to another cloud: transfers

A **transfer** moves a project's traffic to one cloud (Cloud Run, or any connected cluster, including from one cluster to another), gradually, so a problem on the new side affects only a few visitors before you notice.

1. Pick the destination: Cloud Run, or a connected cluster by its id (`nbo-server status` lists them).
2. Start it: `nbo-server transfer <project id> --to cloudrun` (or `--to kc_...`), or `POST /projects/{id}/transfer` with `{ "target": "kubernetes", "clusterId": "kc_..." }`. If the workspace uses [names-only variables](./environments.md#dont-store-variable-values), send them as `values` in the same body.

NBO then does this; the project summary shows the transfer's `status` at each step:

1. **Provisioning.** It sets up the new cloud, as at import (a cluster needs nothing more; Cloud Run may enable APIs and create the registry).
2. **Building.** It waits for a running build to finish, then deploys the build that is live on the old cloud to the new cloud only. Nothing is rebuilt, and the old cloud is untouched. If the old cloud has no live build, or its stored output was cleaned up, the transfer is refused before it starts.
3. **Shifting.** Traffic moves in steps of **1%, 10%, 50% and 100%** to the new cloud, with a 20 second pause after each so you can watch. If the edge refuses a step, the weights go back to the previous step and the transfer fails with the error.
4. **Scheduled jobs (crons)** move to the new cloud and are turned off everywhere else, so they run only on the target.
5. **Done.** All traffic is on the new cloud. **The old cloud is not removed**: it stays at 0%, so you can move back at once by changing the split. Remove it (`POST /environments/{id}/archive`) when you are sure. Moving back later to a cloud you removed brings back that same cloud entry, with the same id and name, at 0% and with nothing live until it deploys again.

Stop it at any step (`nbo-server transfer cancel <project id>`, or `POST /projects/{id}/transfer/cancel`) and it ends as `cancelled`, leaving the split wherever it had got to. Adjust the split by hand or start again. If NBO restarts during a transfer, the transfer is marked failed, because its waiting loop didn't survive.

Each cloud keeps its own page cache, so pages cached on the old cloud are not copied (see [Page cache and revalidation](./cache.md#one-cache-per-environment-and-cloud)). Transfers belong to Production. A custom environment such as `staging` has no transfers; you change its split from the API or Terraform.

> **Not tried for real yet.** A transfer between a real cluster and a real Google project. The weight shift was proven under load on a local machine, and transfers ran against fakes and tests; see [What has been tried](./tried.md).

## Splitting across many clouds

A project can run on Cloud Run and on any number of connected clusters at once. The traffic route lists one row per cloud, named by its `displayName` (the cluster's name, or Cloud Run). A transfer to a new cloud takes traffic from every other cloud in proportion to the shares they had when it started.

## How it works

Everything above is done by two programs and a database. The control-plane stores the split, and the edge applies it.

### The edge program

**Package:** `packages/edge` (Node). A Rust edition, `packages/edge-rs`, speaks the same admin API, route table and headers; you opt in with `NBO_EDGE_IMPL=rust` and Reinstall edge (see [Domains and the public edge](./domains.md#installing-the-edge)). Two servers in one process:

| Server       | Port             | Who calls it           | Code                                  |
| ------------ | ---------------- | ---------------------- | ------------------------------------- |
| Data (proxy) | `9443`           | Visitors' browsers     | `src/proxy.ts` → `createProxyHandler` |
| Admin        | `127.0.0.1:9444` | Only the control-plane | `src/admin.ts` → `createAdminMux`     |

### The registry: the traffic table

**File:** `src/registry.ts`

A `Map` in memory from host name to a **target**:

```json
{
  "host": "next-app.127.0.0.1.sslip.io",
  "backends": [
    { "url": "https://p4715bebb-k8s.127.0.0.1.sslip.io", "weight": 50, "insecureSkipVerify": true },
    { "url": "https://p4715bebb-cloudrun-xyz.a.run.app", "weight": 50, "insecureSkipVerify": false }
  ]
}
```

`set` rejects negative weights, bad URLs, and splits where every weight is 0. Host names are lower-cased and stripped of ports, so `Next-App.127.0.0.1.sslip.io:9443` finds the same entry.

`insecureSkipVerify` is true for `*.sslip.io` backends: the local cluster uses a self-signed certificate that a normal HTTPS check would reject.

**The table lives only in memory.** Restart the edge and it's empty. That's on purpose: the control-plane's database is the single source of truth, and it re-sends everything (see "Keeping the edge in sync").

### Picking a backend: each visitor stays on one cloud

A visitor who flipped between clouds could load a page from one build and then ask the other cloud for that build's script files, which it doesn't have (404). So the edge keeps each visitor on one cloud. All of it is in `packages/edge/src/sticky.ts`; `proxy.ts` calls it. The reasons are in `docs/adr/0003-sticky-visitors.md`.

1. **The cookie.** When a visitor loads a **page** (a document navigation, not an image, script or API call) without a valid id, the edge makes a random one (`newVisitorId`, 32 hex characters) and sends it back as the cookie `nbo_v` (`HttpOnly`, `SameSite=Lax`, `Path=/`, a week long, `Secure` when the visitor used https, whether the edge's own scheme or `X-Forwarded-Proto`/`Forwarded` from a TLS terminator in front of it). It is set only on pages because a `Set-Cookie` on an asset stops CDNs from caching it. If the request carries several `nbo_v` values (a stale one from another path, say), the edge scans past a malformed one and uses the first valid one. It's a random load-balancing id, not linked to any account. The edge removes `nbo_v` from the request before passing it to your app (`stripVisitorCookie`), so your app never sees it.
2. **The pick.** `pickSticky(target, visitorId)` scores every backend with weight > 0: a hash of the visitor id and the backend's **stable key** (the cloud entry's id that the control-plane sends as `id`; the URL if there is none), scaled by the backend's weight. The best score wins. This is called _weighted rendezvous hashing_.
3. **What that gives you:**
   - The same visitor reaches the same cloud on every request, on every copy of the edge, with nothing stored anywhere but the cookie.
   - Across many visitors the split is honoured (70/30 → about 70% / 30% of visitors).
   - When the split changes, a visitor moves only to a cloud whose share **grew**. 70/30 → 50/50 moves just the 20% that has to move; a transfer moves people to the destination cloud and nowhere else. (Whole-percent rounding in a transfer step can move about 1% of visitors sideways between two shrinking clouds.)
   - A new deploy on a cloud doesn't move anyone: its visitors stay and get the new version there.
   - This fixes mixing **between clouds** (page from build A, assets asked of build B). Mixing **inside one cloud** during that cloud's own rolling update is narrowed by two things: each deploy carries the previous live build's `immutable` hashed files and serves them only where the new build answers 404 (the response then carries `x-nbo-carried-from`), and the Kubernetes app container has a readiness probe and a 5 second `preStop` sleep. A short window remains while the old pod leaves the Service.
4. **No cookie** (curl, bots, a browser blocking cookies): each request gets a fresh id, so each one is picked at random by weight.
5. **Two cookie details.** `SameSite=Lax` means the browser leaves the cookie off a cross-site `POST` that navigates to your site (a payment provider's redirect form, say), so that one request may be re-rolled onto another cloud; the next page load sends it again. And the cookie belongs to one host: `a.example.com` and `b.example.com` each give a visitor their own id.

The old per-request `pick(target)` in `registry.ts` (random by weight) is still there but the proxy no longer uses it.

### Proxying

`createProxyHandler` (`src/proxy.ts`), for every visitor request:

1. Reads the `Host` header and looks it up. Unknown host → **404** "edge: no target registered for host …".
2. `pick` a backend. Nothing pickable → **502**.
3. Forwards the request with `proxyRequest` (from `@nbo/funcproxy`), adding `x-forwarded-host` (the original host, so the app knows its public name) and `x-forwarded-proto`.
4. Backend unreachable or too slow to start answering → **502** "edge: backend unreachable". The reason (refused connection, timeout, certificate) goes to the edge's log, never to the visitor.
5. Streams the backend's response back, adding `x-nbo-edge-backend: <backend id>`: the environment id (`env_…`) the control-plane sends with each backend, never the backend's URL. A backend without an id (a route table from an older control-plane) gets no header. Open your browser's network tab to see which cloud answered; `GET /projects/{id}/summary` lists each cloud's environment id. The app server's `x-nbo-deployment-id` (the build's content id) stays on the response too.

### Admin API

| Request                                            | Effect                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `PUT /targets/{host}` with `{ "backends": [...] }` | Create or replace the split for a host. 204 on success, 400 with the reason if invalid. |
| `GET /targets/{host}`                              | The current split, or 404.                                                              |
| `DELETE /targets/{host}`                           | Forget the host.                                                                        |

It listens only on `127.0.0.1`, so nothing outside your machine can change routing.

### In production: the edge runs in a cluster

Everything above describes the edge as one program with an in-memory table and an admin API on your computer, which is how dev mode works. In production mode the edge runs as two pods in a cluster, reads its table from a ConfigMap that the control-plane writes (the admin `PUT /targets` is switched off there), and serves HTTPS with certificates for your domains. Backends on other clusters are reached through a relay. See [Domains and the public edge](./domains.md).

### Who decides the split: the control-plane

The weights are stored in the database, on each cloud entry (`environments.traffic_weight`, a whole number 0 to 100; the table keeps the older name `environments` for what this manual calls a cloud). The edge just copies them.

**File:** `packages/controlplane/src/edge/edge-sync.ts` → `createEdgeSync`

| Method                         | What it does                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `desiredTarget(projectId)`     | Builds the split from the database: for each cloud with a successful deployment, its latest URL and weight.                           |
| `push(projectId)`              | `PUT`s that split to the edge admin. Skipped if every weight is 0 (nothing to route yet).                                             |
| `onDeployed(projectId, envId)` | Called by the runner after every successful deploy. If no cloud has traffic yet (first deploy ever), gives this one 100. Then `push`. |
| `inSync(projectId)`            | Compares the edge's live split with the database. The traffic route answers `edgeInSync: true` when they match.                       |
| `remove(host)`                 | `DELETE` when a project is deleted.                                                                                                   |
| `reconcile()`                  | `push` for every project.                                                                                                             |

### Keeping the edge in sync

`reconcile()` runs on every poller tick (about every 45 seconds; `packages/controlplane/src/git/poller.ts`). So after the edge restarts, every project is routable again within a minute, without anyone doing anything. Failures are logged and retried next tick.

### How a hand-made split is saved

1. A client sends `PUT /projects/{id}/traffic` with `{ weights: { <cloud id>: 50, <cloud id>: 30, <cloud id>: 20 } }`.
2. The route (`http/v2-routes.ts`) checks: no transfer is running (otherwise `409`), every cloud belongs to the project and isn't archived, each with a positive weight has ever had a successful deployment with a URL (`canTakeTraffic` in `http/project-summary.ts`, also sent in the summary; a pending or failed redeploy after that doesn't matter), each weight is a whole number 0 to 100, and at least one is above 0. Weights are relative, so 1 and 3 means 25% / 75%; send them adding to 100 to keep them easy to read.
3. `store.setTrafficWeights(...)` saves them; `edgeSync.push` sends them to the edge.
4. The edge uses the new numbers from the very next request.

### How a transfer runs

**Server:** `POST /projects/{id}/transfer` → `createTransfers().start(...)` in `packages/controlplane/src/deploys/transfer.ts`. The steps above map to the transfer's `status`: `provisioning` (`setup.addCloud(...)`), `building` (waits for `queue.idle`, then a promote of the live build), `shifting`, then `done`. In each shifting step the new side gets the step's weight and the rest is shared among every other cloud of the project in proportion to the weights they had when the transfer started (if none had traffic, the source cloud takes it all), so the weights always add up to 100. `POST /projects/{id}/transfer/cancel` sets `cancelled`; the loop checks this before every step. Any failure sets `failed` with the error. On restart, `recoverInterruptedWork` in `src/v2.ts` marks an interrupted transfer failed.

### Proving it works

`packages/loadtest` sends a steady stream of requests through the edge while shifting weights, and fails if a single request fails. This was the gate for the cloud switch ("zero failed requests across a weight shift under load"), and it runs against the Rust edge too.
