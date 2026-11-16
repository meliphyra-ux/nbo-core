# Creating a Kubernetes cluster

NBO can deploy your apps to a Kubernetes cluster you own. **Kubernetes** is software that runs containers across one or more computers (called **nodes**). A **cluster** is that group of computers plus the control software. This chapter shows how to create one at three providers and what NBO needs from it. If you already have a cluster, jump to "Any other cluster".

## What NBO needs from a cluster

| Need                         | Why                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes **1.30 or newer** | NBO checks the server version when you connect and refuses older ones.                                                                                  |
| A working **LoadBalancer**   | A LoadBalancer is how the cluster gets a public IP address. NBO's public edge (see [Domains and the public edge](./domains.md)) is reached through one. |
| **Outbound internet**        | Nodes must download images and reach your container registry.                                                                                           |
| **Admin credentials, once**  | Installing NBO's account needs cluster-admin rights. NBO uses them one time and does not store them.                                                    |

NBO keeps projects apart with NetworkPolicies, which only work when the cluster's network plugin (its **CNI**) enforces them. Most managed clusters do; some minimal setups don't, and there the policies are silently ignored.

You give NBO admin credentials in one of three ways: use the machine context (the cluster your own `kubectl` already points at), paste a **kubeconfig** (a YAML file that says where the cluster is and how to log in), or enter the server URL, the CA certificate and a token separately.

## Check any cluster before connecting

Run these in a terminal with `kubectl` pointed at the new cluster:

```bash
kubectl version
kubectl get nodes
```

`kubectl version` prints a Client and a Server line. The **Server** version must be 1.30 or higher. Then confirm a LoadBalancer works:

```bash
kubectl create deployment lb-test --image=nginx
kubectl expose deployment lb-test --type=LoadBalancer --port=80
kubectl get service lb-test --watch
```

Wait until the `EXTERNAL-IP` column shows an address instead of `<pending>` (a minute or two is normal). Then clean up:

```bash
kubectl delete service,deployment lb-test
```

If the address stays `<pending>` for ten minutes, the cluster has no LoadBalancer implementation. Fix that before connecting. On Hetzner, the load balancer also needs a location: see the Hetzner section below.

## Google Kubernetes Engine (GKE)

GKE is Google's managed Kubernetes. **Autopilot** mode lets Google manage the nodes, so there is nothing to size. You need a Google Cloud project with billing on, and the `gcloud` tool logged in (`gcloud auth login`).

```bash
gcloud services enable container.googleapis.com
gcloud container clusters create-auto nbo-cluster --region us-central1
gcloud container clusters get-credentials nbo-cluster --region us-central1
```

The first command turns on the GKE API, the second creates the cluster (several minutes), and the third writes the login details into your local kubeconfig and makes `kubectl` point at it. Pick the region closest to your users. If the default version is below 1.30, add `--cluster-version` with a newer one; `gcloud container get-server-config --region us-central1` lists them.

Run the checks above. Autopilot clusters create LoadBalancers automatically.

If you also connected Google Cloud in NBO, images go to Artifact Registry and the cluster pulls them with a read-only key that NBO creates, so you do not need to set up a registry yourself.

**Cost:** Autopilot bills for the resources your pods request, plus a cluster fee that may be covered by a free tier. Check Google's GKE pricing page. Delete the cluster when you stop using it: `gcloud container clusters delete nbo-cluster --region us-central1`.

## Hetzner Cloud

This is the setup [Launch NBO on a server](../production.md#the-steps-at-a-glance) has in mind: NBO running with Docker Compose on one machine and a k3s cluster on Hetzner for the edge and your sites. You can run the commands below on that machine; NBO itself doesn't need them.

Hetzner is a low-cost European host. It has no one-click Kubernetes, so a community tool, `hetzner-k3s`, builds a cluster of **k3s** (a lightweight Kubernetes) on Hetzner servers. It also installs Hetzner's cloud controller, which is what makes LoadBalancer services work.

1. Create a Hetzner Cloud project and, under Security, an API token with read and write rights.
2. Install `hetzner-k3s`, `kubectl` and Helm. On an Ubuntu server you don't need Homebrew:

```bash
wget https://github.com/vitobotta/hetzner-k3s/releases/latest/download/hetzner-k3s-linux-amd64
chmod +x hetzner-k3s-linux-amd64
mv hetzner-k3s-linux-amd64 /usr/local/bin/hetzner-k3s
snap install kubectl --classic
snap install helm --classic
hetzner-k3s --version
```

The tool's README at github.com/vitobotta/hetzner-k3s covers other systems. NBO's own `kubectl` is inside its container, so the machine needs one of its own for this.

3. Write a config file, `cluster.yaml`:

```yaml
hetzner_token: <your API token>
cluster_name: nbo
kubeconfig_path: "./kubeconfig"
k3s_version: v1.32.0+k3s1

networking:
  ssh:
    port: 22
    use_agent: false
    public_key_path: "~/.ssh/id_ed25519.pub"
    private_key_path: "~/.ssh/id_ed25519"
  allowed_networks:
    ssh:
      - 0.0.0.0/0
    api:
      - 0.0.0.0/0

masters_pool:
  instance_type: cpx22
  instance_count: 1
  locations:
    - fsn1

worker_node_pools:
  - name: workers
    instance_type: cpx32
    instance_count: 2
    location: fsn1
```

`k3s_version` must be v1.30 or newer; `hetzner-k3s releases` lists what is available. Server type names change over time, so take current ones from the tool's README. Use x64 types, not ARM (`cax`), because NBO's images are x64. This file holds your API token, so never commit it to a repository. Three control-plane servers is the sturdy setup; one is fine for trying things out.

4. Create the cluster:

```bash
hetzner-k3s create --config cluster.yaml
export KUBECONFIG=./kubeconfig
```

The kubeconfig is written next to the config file. Keep it private: it is an admin login.

Run the checks above, with one change: Hetzner won't create a load balancer without a location. Add it after the `expose` command, using the location from `cluster.yaml`:

```bash
kubectl annotate service lb-test load-balancer.hetzner.cloud/location=fsn1
```

Without it, `kubectl describe service lb-test` shows `neither load-balancer.hetzner.cloud/location nor load-balancer.hetzner.cloud/network-zone set`. NBO's own load balancers don't need this step: NBO reads the location from your nodes when you connect the cluster, and saves it. A cluster connected with an older NBO has no location saved yet. Update its setup once with admin credentials: `nbo-server cluster update-setup kc_... --admin-kubeconfig-file -`, with the kubeconfig on stdin. Or use the `NBO_LB_ANNOTATIONS` line described in [Launch NBO on a server](../production.md).

If the test still never gets an address, check that the Hetzner cloud controller pod is running: `kubectl -n kube-system get pods | grep hcloud`.

**Cost:** you pay per server and per load balancer. Check Hetzner's pricing page. To remove everything, first set `protect_against_deletion: false` in `cluster.yaml` (the tool refuses to delete a protected cluster), then run `hetzner-k3s delete --config cluster.yaml` and type the cluster name when it asks you to confirm.

## DigitalOcean

DigitalOcean offers managed Kubernetes (DOKS) with LoadBalancers built in. Install `doctl` and log in with `doctl auth init`.

```bash
doctl kubernetes options versions
doctl kubernetes cluster create nbo-cluster --region nyc1 --version <slug> --size s-2vcpu-4gb --count 2
```

Use the first command to find a version slug for Kubernetes 1.30 or newer (slugs look like `1.32.2-do.0`) and put it in `<slug>`. `doctl` saves the login details to your kubeconfig by default, so `kubectl` now points at the new cluster. To get the kubeconfig as text for pasting:

```bash
doctl kubernetes cluster kubeconfig show nbo-cluster
```

Run the checks above.

**Cost:** you pay for the worker nodes and for each LoadBalancer. Check DigitalOcean's pricing page. Delete with `doctl kubernetes cluster delete nbo-cluster`.

## Connect it in NBO

On the NBO server, with `nbo-server` (see [Connect your clouds](../production.md#3-connect-your-clouds) for the details):

1. Get the cluster's admin kubeconfig (from `cat kubeconfig` or `doctl kubernetes cluster kubeconfig show`).
2. Write a `registry.json` that says where images live (below).
3. Connect it with a **name** (see "Connecting several clusters" below):

   ```bash
   docker compose cp registry.json nbo:/tmp/registry.json
   docker compose exec -T nbo nbo-server connect kubernetes --name prod-eu \
     --kubeconfig-file - --registry-file /tmp/registry.json < kubeconfig.yaml
   docker compose exec nbo rm /tmp/registry.json
   ```

   Add `--context <name>` for a context other than the kubeconfig's current one. NBO checks the version, installs its account and answers with the cluster's id (`kc_...`).

Images need somewhere to live. With Google Cloud connected, NBO can push them to Artifact Registry: `{ "registry": { "kind": "artifact-registry" } }`. That needs Google Cloud connected first; NBO refuses it otherwise. Without it, name a registry such as Docker Hub or GitHub's `ghcr.io`: `{ "registry": { "kind": "custom", "server": "ghcr.io/you", "username": "you" }, "registryPassword": "..." }`.

> **Not tried for real yet.** A registry other than Artifact Registry (Docker Hub, `ghcr.io`, GitLab's): the registry settings, the pull secret copied into the cluster and the image pushes ran against fake commands only. No real registry was used.

## Connecting several clusters

NBO can connect **any number of clusters** at once, for example one in Europe and one in the US, or a cheap one for previews. Run `nbo-server connect kubernetes` for each one. Every cluster has:

- A **name** you choose when you connect it. Use 1 to 30 lowercase letters, digits or hyphens, starting and ending with a letter or digit (`prod-eu`, `hetzner1`). Two clusters cannot share a name.
- Its **own credentials and registry**, stored encrypted and used only for that cluster. NBO's install (described under "Any other cluster") is done separately in each cluster, so each one gets its own `nbo-controller` account.
- Its own checks and changes: `nbo-server cluster test <id>`, `PUT /system/connections/kubernetes/{id}` (new credentials or registry, through `nbo-server api`) and `nbo-server disconnect kubernetes <id>`.

**Names cannot be changed.** The names NBO gives a project's clouds on that cluster, such as `k8s-prod-eu`, are built from the cluster name, so to rename a cluster you disconnect it and connect it again. Replacing its credentials keeps the name.

When you set up a project (or add a cloud later), you name each cluster by its id (`{ "target": "kubernetes", "clusterId": "kc_..." }`), and you can list several. A project runs at most once per cluster. Deploys, transfers, traffic and status for a project's cloud always use that cloud's own cluster, never another one.

**Disconnect is refused while projects still run on that cluster.** The message lists them. Move their traffic away and archive those clouds (`POST /environments/{id}/archive`), or delete the project with its cloud resources (`DELETE /projects/{id}?resources=true`) while the cluster is still connected, then disconnect.

**Upgrading from a single cluster.** If you connected one cluster before several were supported, the first start of the new version renames nothing. The cluster becomes a connection named `default`, and the project clouds you already had on Kubernetes (still called `k8s`) are linked to it. Their running apps, image names and cloud objects are untouched. Clusters you add later get clouds named `k8s-<name>`.

Local development (dev mode) is unchanged: one local kind cluster, no names.

## Any other cluster

Any conformant Kubernetes works: another cloud's managed service, k3s on your own servers, or a bare-metal cluster. It must meet the table at the top: version 1.30 or newer, a LoadBalancer implementation (on bare metal, something like MetalLB), outbound internet, and admin credentials for the one-time install.

**What NBO installs**, in this order:

- An admission policy named `nbo-namespace-guard`, applied first. It keeps NBO's account inside the `nbo-system`, `nbo-edge` and `nbo-p-*` namespaces. It also requires that Services are ClusterIP without `externalIPs` (the one exception: the public edge's and relay's own LoadBalancer Services, `nbo-edge` and `nbo-relay` in the `nbo-edge` namespace), that role bindings stay pinned, and that new namespaces carry Pod Security labels. It records the setup version in an annotation, `nbo.dev/setup-version`.
- A namespace `nbo-system`, with the Pod Security `baseline` level enforced.
- A ServiceAccount `nbo-controller` with a token secret.
- Two ClusterRoles, `nbo-controller` and `nbo-project-deployer`.
- A namespace `nbo-edge` for the public edge and relay, also Pod Security `baseline`. It is separate from `nbo-system` because the edge faces the internet and can read the secrets where it runs; `nbo-system` holds NBO's own token. In it: a ServiceAccount `nbo-edge` that may only read config maps and secrets there, and roles that let `nbo-controller` deploy there and reach its pods through the API server's proxy (for the edge's Speed Insights).

**Cluster setup is out of date.** A cluster connected before the public edge shows this until you update it with admin credentials once more (`nbo-server cluster update-setup`). Only the admission policy and the roles are re-applied; the stored token stays, and the admin credentials are not stored.

Each project you deploy later gets its own namespace, `nbo-p-<id>`.

**What NBO keeps:** only a kubeconfig built from the `nbo-controller` token, stored encrypted. Your admin credentials are used for the install and then discarded.

## Disconnecting and removing NBO

**Disconnecting** (`nbo-server disconnect kubernetes kc_...` or `nbo-server disconnect google`) only makes NBO forget the credentials it stored. It revokes nothing: the `nbo-controller` token keeps working in the cluster, and the Google service-account keys stay valid, until you delete them. Sites already running in `nbo-p-*` namespaces, or on Cloud Run, keep running.

NBO refuses to disconnect a cloud while projects still run on it. Archiving those clouds does not stop their sites either. To take a site down, delete its project with `DELETE /projects/{id}?resources=true` while the cloud is still connected.

To remove everything NBO installed in a cluster, run these with admin `kubectl`:

```bash
kubectl delete namespace -l app.kubernetes.io/managed-by=nbo
kubectl delete clusterrolebinding nbo-controller
kubectl delete clusterrole nbo-controller nbo-project-deployer
kubectl delete validatingadmissionpolicybinding,validatingadmissionpolicy nbo-namespace-guard
```

The first command deletes `nbo-system` (and with it the `nbo-controller` token, which stops working) and every `nbo-p-*` project namespace, which stops the sites in them. Or delete the whole cluster.

To revoke what NBO created in Google Cloud, list and delete the keys of its two service accounts (replace `PROJECT`; repeat for `nbo-puller`):

```bash
gcloud iam service-accounts keys list --iam-account nbo-deployer@PROJECT.iam.gserviceaccount.com --managed-by user
gcloud iam service-accounts keys delete KEY_ID --iam-account nbo-deployer@PROJECT.iam.gserviceaccount.com
```

Or delete the accounts themselves with `gcloud iam service-accounts delete nbo-deployer@PROJECT.iam.gserviceaccount.com` (and `nbo-puller@…`). If you connected with a pasted key, NBO created only `nbo-puller`; revoke your own key the way you normally would. The `nbo` Artifact Registry repository holds your images: delete it with `gcloud artifacts repositories delete nbo --location REGION` once you no longer need them.
