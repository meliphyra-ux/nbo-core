# Domains and the public edge

A project needs an address people can type: `shop.example.com`, with the padlock in the browser. In production mode NBO provides that through its **public edge**: a small web server that runs inside one of your Kubernetes clusters, owns the internet-facing ports 80 and 443, holds the certificates and sends each request to the right cloud. This chapter covers installing it, setting a base domain, adding your own domains, what each status means, and what to check when something does not work.

It only applies to **production mode** (`NBO_MODE=production`). In dev mode, projects keep the local address `http://<name>.127.0.0.1.sslip.io:9443` and adding a domain is refused.

## What the edge is

[Traffic and moving clouds](./traffic.md#how-it-works) explains the edge as a program that picks a cloud for each visitor. Locally it runs on your computer. In production the same program runs **inside a cluster you choose**, as two copies (a Deployment called `nbo-edge`, so one can restart while the other serves), behind a **LoadBalancer**: a Kubernetes Service that makes your cloud provider hand out a public IP address. DNS records point your domains at that address.

What lives where:

| Piece                 | Where                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| The edge pods         | Namespace `nbo-edge` on the edge cluster                                                       |
| The route table       | A ConfigMap `nbo-edge-routes` in `nbo-edge`: which host goes to which cloud, with what weights |
| Certificates          | Secrets in `nbo-edge`, one per host (`kubernetes.io/tls`)                                      |
| NBO's own login token | Namespace `nbo-system`, which the edge **cannot read**                                         |

The edge has its own namespace on purpose. The edge faces the whole internet and can read the Secrets in its namespace (the certificates' private keys). If it ran next to NBO's own token and someone found a bug in it, they could take control of NBO's access to your cluster. In its own namespace, the worst case is limited to certificates.

The control-plane keeps the route table up to date. It rebuilds the table from its database every 45 seconds and whenever something changes, so a lost write heals itself. Both edge pods read the ConfigMap about every five seconds and swap in the new table in one step.

## Installing the edge

> **Not tried for real yet.** Installing the edge, relays and certificates ran against fakes and automated tests. A real install on a Hetzner k3s cluster (2026-11-06) reached the load balancer step; certificates and visitor traffic on a real cluster are unconfirmed.

Installing works in production mode only. On the server, with [`nbo-server`](../production.md#3-connect-your-clouds):

1. Pick the cluster the edge should run on. It must already be connected (`nbo-server status` lists the clusters and their ids, `kc_...`).
2. Have an **admin kubeconfig** for that cluster at hand. It is used once and **not stored**. It is needed because installing the edge creates roles and a namespace, which NBO's day-to-day token is deliberately not allowed to do.
3. Install. This creates Deployment `nbo-edge` (2 copies), a Service of type LoadBalancer on ports 80 and 443, and a ConfigMap and Secrets in `nbo-edge`. **Your cloud provider bills for the load balancer**, which is what `--confirm-billing` says you know:

   ```bash
   docker compose exec -T nbo nbo-server edge install --cluster kc_... \
     --admin-kubeconfig-file - --confirm-billing < admin-kubeconfig.yaml
   ```

Installing runs as a **background job** with visible steps: updating the cluster setup, building the edge image, pushing it to the cluster's registry, applying it, waiting for the load balancer's address, waiting for the pods, updating the route table. Only one install or reinstall can run at a time (a second one is refused with "An edge install is already running"). `nbo-server edge status --wait` follows the job, checking every 2 seconds, and exits with 1 if it failed. If the control-plane restarts mid-job, the job shows as failed ("interrupted") and you retry it. Because credentials are not stored, retrying an install means running the install command again with them.

When it finishes, `nbo-server edge status` shows the edge's public address (an IP, or a hostname on some providers) and how many pods are ready. `nbo-server edge reinstall` re-applies it with the current NBO version (this is how you upgrade it); it needs no credentials.

A faster edge written in Rust is available to try but is not the default yet: set `NBO_EDGE_IMPL=rust` where NBO runs (in `.env` with Docker Compose) and reinstall the edge; remove the setting and reinstall to go back (see [Launch NBO on a server](../production.md)).

You cannot move the edge to another cluster while custom domains exist on it.

### Clusters connected before this version

A cluster connected before the public edge existed is **"out of date"** until you update it with admin credentials once more: `nbo-server cluster update-setup kc_... --admin-kubeconfig-file -`, with the kubeconfig on stdin. NBO re-applies only the admission policy and the roles; the stored token stays.

## The default address and the base domain

Every project has a **default host**. With no base domain set, it is `<name>.<edge-ip-with-dashes>.sslip.io`, for example `shop.203-0-113-7.sslip.io`. **sslip.io** is a free public DNS service that turns any such name back into the IP address inside it, so it works with no DNS setup. That is handy to try things, but the parent domain is shared by everyone who uses sslip.io, and Let's Encrypt limits how many certificates one parent domain can get per week, so a certificate request can be refused. **For real use, set a base domain you own.**

To set one:

1. Create the **wildcard record** at your DNS provider: a record named `*.apps.example.com` pointing at the edge (type A for an IPv4 address, AAAA for IPv6, CNAME for a hostname). A wildcard means every name under it, so you add it once and every project's default host `<name>.apps.example.com` works.
2. Set it: `nbo-server domains settings --base-domain apps.example.com`. Add `--move-existing` to give every existing project `<name>.apps.example.com` as its default host, keeping the old default as a custom domain so existing links still work (you can remove it later). Without it, existing projects keep their host and only new ones use the base domain. A project whose new name is already taken is skipped and listed in the answer.

Also set the **Let's Encrypt email** (where Let's Encrypt can warn you about problems): `nbo-server domains settings --acme-email you@example.com`. There is a **staging** switch (`{"acmeDirectory":"staging"}` through `nbo-server api PATCH /system/domains`, as [Launch NBO on a server](../production.md#5-install-the-public-edge) shows): staging certificates are not trusted by browsers but have much higher limits, so use it while testing and switch it off for real sites. A staging certificate stays until it's renewed, and a project's default address can't be removed and re-added, so plan your trial as [Launch NBO on a server](../production.md) describes.

## Environment addresses

A custom [environment](./environments.md) such as `staging` gets its own default host: `staging--shop.apps.example.com` (the environment name, two hyphens, the project name). Without a base domain it is the sslip.io form, for example `staging--shop.203-0-113-7.sslip.io`. The wildcard record above covers it, so there is nothing more to set up. Each such host is a row in the Domains list with its own DNS check and certificate, so **each environment address takes its own Let's Encrypt certificate** and counts against the weekly limit. When you change the base domain, environment hosts move with the project hosts.

To add your own domain to an environment, send its name as `stage` when you add the domain. Environments other than Production need the public edge for custom domains, because Cloud Run domain mappings are for Production only.

[Ephemeral environments](./environments.md#ephemeral-environments) get addresses the same way: `feature-login--shop.apps.example.com`, covered by the same wildcard record. Each one takes its own certificate, and NBO orders at most 20 new ones for ephemeral addresses in any 7 days so Production keeps room under Let's Encrypt's weekly limit. One over the cap is served over HTTP with a warning until the window has room. Ephemeral environments take no custom domains, and their rows never appear in a project's domain list.

## Adding a domain to a project

A project with [deployment protection](./protection.md) asks for its password on custom domains too.

`GET /projects/{id}/domains` lists the default host and each custom domain. Terraform's `nbo_domain` does the same as the steps below.

1. Add the domain: `POST /projects/{id}/domains` with `{"host": "shop.example.com"}` (and `"stage"` for an environment other than Production). It is lower-cased and must be a plain DNS name: no `*`, no IP address, not already used by another project.
2. The answer holds the **DNS record** to create at your DNS provider. Create it exactly as given:
   - edge address is an IPv4: an `A` record with the name and the IP;
   - an IPv6: `AAAA`;
   - the edge only has a hostname: a `CNAME` pointing at it. A bare domain like `example.com` (the **apex**) **cannot** use a CNAME in DNS, so NBO gives an `ALIAS` record with a note: use your provider's ALIAS or ANAME record type, or its "CNAME flattening" option. (NBO recognises an apex as a name with two labels, or three ending in `co.uk`, `org.uk`, `com.au`, `co.jp`, `com.br` or `co.nz`. For other multi-part endings it gives a CNAME.)
3. Wait. NBO checks DNS every minute. The status (in `GET /projects/{id}/domains`) moves forward by itself. `POST /projects/{id}/domains/{domainId}/check` repeats the check immediately (at most once a minute per domain).
4. When the status is **Active**, `https://shop.example.com` works, and becomes the project's address.

Right after you add a domain it already answers over plain HTTP, so you can test it before the certificate is ready.

`DELETE /projects/{id}/domains/{domainId}` deletes the route, the certificate Secret and the row. The default host cannot be removed.

## What each status means

| Status                  | Meaning                                                                         | What to do                                                        |
| ----------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Waiting for DNS**     | The domain's DNS does not point at the edge yet (or the change has not spread). | Create the record shown; wait up to the record's TTL.             |
| **Issuing certificate** | DNS is right. NBO is getting the certificate from Let's Encrypt.                | Wait a minute or two.                                             |
| **Active**              | Served over HTTPS with a valid certificate.                                     | Nothing.                                                          |
| **Failed**              | Let's Encrypt refused, or saving the certificate failed. The message is shown.  | Read it (see Troubleshooting below), fix it, run the check again. |

## Certificates

NBO gets certificates from **Let's Encrypt** itself. There is no cert-manager and no ingress controller involved. The control-plane is the Let's Encrypt client:

1. For a host whose DNS is right, it uses the **HTTP-01** challenge: Let's Encrypt is told to fetch a secret token from `http://<host>/.well-known/acme-challenge/<token>`. NBO puts the token into the route table, waits until both edge pods serve it, then asks Let's Encrypt to check. The request comes through the edge on port 80, so **port 80 must be reachable from the internet**.
2. The issued certificate is stored (encrypted) in NBO and written as a Secret into the `nbo-edge` namespace. The edge pods load it and serve it for that host name. Once a host has a certificate, other plain-HTTP requests to it get a `308` redirect to HTTPS.
3. **Renewal**: NBO checks every domain once a minute and renews a certificate as soon as fewer than **30 days** are left.
4. If getting a certificate fails, NBO tries again later with growing waits: **1 hour, then 6 hours, then every 24 hours**. This keeps you under Let's Encrypt's limits on failed attempts. **Check now** skips the wait (at most once a minute).
5. If the certificate was issued but writing it into the cluster failed, NBO **keeps the issued certificate** and only retries the saving, so a cluster hiccup does not use up your Let's Encrypt allowance.

**If NBO is down,** your sites **keep serving**: the edge pods run on their own from the route table and certificates already in the cluster. What waits is renewal. A certificate lasts 90 days and renewal starts at 30 days left, so you have roughly **a month** of slack to bring NBO back.

The edge also stops trusting a visitor's own `X-Forwarded-Proto` header: it decides http or https from the port the request arrived on.

## Other clusters: public entry

The edge can send traffic to apps on **other clusters** too. Visitors still only reach the edge cluster, so a cluster that is not the edge cluster needs a way in. NBO calls it a **relay**: two small pods, plus a LoadBalancer on port 443, in that cluster's `nbo-edge` namespace. The edge sends the request to the relay over a connection that only trusts a private certificate authority NBO made for that relay, and attaches a secret token. The relay accepts only that token, and only for services in projects' own namespaces (`<app>.nbo-p-<id>.svc.cluster.local:8080`), so it is not an open door into the cluster.

A cluster other than the edge cluster gets one with `nbo-server cluster relay kc_... --confirm-billing`: `--confirm-billing` says you know **your provider bills** the LoadBalancer. It needs no admin credentials and runs as a background job with steps, one at a time per cluster; `nbo-server api GET /system/clusters/kc_.../relay` shows its state. Until it is enabled, deploys to that cluster still succeed, but it **cannot take traffic**: a higher traffic share for it is refused with **"This cluster has no public entry yet…"**, and a transfer to it is refused (a transfer already running stops, with the split left at its last step). If every cloud with traffic is unreachable, the project does not go dark: it serves from its reachable clouds in equal shares. Cloud Run and AWS Lambda need no relay because they already have a public address. A project on Lambda gets its own domains only through the edge: NBO doesn't set up CloudFront or API Gateway, and without an edge adding a domain to it is refused.

## What your app sees as the visitor's address

Behind the cluster edge, `X-Forwarded-For` holds exactly one address: the one the visitor connected from. If a visitor sends their own `X-Forwarded-For`, `X-Real-IP` or `Forwarded`, the edge drops it, so an app that rate-limits or logs by address can trust that value. A relay passes it on unchanged. The Service keeps visitors' addresses visible to the edge, but a cloud load balancer that proxies connections itself shows up as its own address instead.

## Speed Insights in the cluster

The Speed Insights numbers collected by the edge pods (the edge's Speed Insights collection, read by an insights sink) are fetched by the control-plane through the **Kubernetes API server's pod proxy**. A password-like token for the pods is included in the request URL. That means the token can show up in the **API server's audit logs**, if you have them on. It only works for the drain request, but treat those logs as sensitive. NBO's own NetworkPolicy opens port 9444 on the edge pods for this. The port is not on the LoadBalancer, so visitors can't reach it, and without the token it answers nothing. A firewall between the API server and the nodes can still block it, and then Speed Insights stays empty (see Troubleshooting).

## Domains behind Cloudflare

Cloudflare can sit in front of your domain: visitors reach Cloudflare first, and Cloudflare passes the request on to NBO. You turn this on in Cloudflare by making the DNS record **Proxied** (the orange cloud). A plain **DNS only** record (grey cloud) needs nothing special and works as described above.

> **Not tried for real yet.** Behind Cloudflare. The reach check, the warnings, the Origin CA option and the visitor-address rules ran against fakes and tests only; no real Cloudflare zone and no real certificate was used. The public edge itself has not served real visitors on a real cluster either. Expect rough edges on the first real try. If the first certificate won't issue under Full (strict), use plain **Full** until the domain is Active, or paste a certificate.

### When to use the switch

Use **Behind Cloudflare** when the domain's record is orange-clouded. A proxied record makes DNS answer with Cloudflare's addresses, not NBO's, so NBO can never see that the domain points at it and the status stays "Waiting for DNS" forever. With the switch on, NBO stops comparing DNS with the edge's address and tests the real path instead.

The switch is for **custom domains only**. The default host and the base domain's wildcard record stay **DNS only**. If the switch is off and a domain's DNS answers with Cloudflare's addresses, the domain's status says to turn it on.

### Steps

1. Make sure the edge is up to date. You don't need to work this out yourself: if the edge needs reinstalling, NBO refuses the switch with the message "Reinstall the edge first". Then reinstall it with `nbo-server edge reinstall`. An old edge would reject the new route table (the list that tells the edge which host goes where) and stop picking up changes.
2. Add the domain, then turn on the switch: `PATCH /projects/{id}/domains/{domainId}` with `{"behindCloudflare": true}`.
3. In Cloudflare, create the record NBO shows, with the orange cloud on (Proxied).
4. In Cloudflare, open **SSL/TLS** and set the mode to **Full (strict)**. Full (strict) rejects Let's Encrypt staging certificates, so during a staging trial use plain **Full**, or paste an Origin CA certificate.
5. Keep **Always Use HTTPS** off until the domain is Active, or paste an Origin CA certificate (below), which makes this step unnecessary. Once the domain is Active you can turn Always Use HTTPS on.
6. Wait. The status moves through "Waiting for DNS", "Issuing certificate" and "Active" as usual.

### How NBO checks the domain

For a Cloudflare domain NBO sends a real request. It publishes a one-time token in the route table, then fetches `http://<host>/.well-known/acme-challenge/<token>` from the public internet, through Cloudflare, and compares what comes back. The same check runs before every certificate issue and renewal, so a blocked path fails here and not against Let's Encrypt's limits. A failed check doesn't count as a Let's Encrypt failure. NBO tries again in 5 minutes. If the check before a renewal fails, the domain stays Active and shows the error.

A Cloudflare domain still needs a DNS answer. Until the record exists, the status stays at "Waiting for DNS" and no check runs. Any answer will do, because Cloudflare hides the real target.

NBO must also reach the edge directly on port 80 from its own server, to confirm that the token is in place before it asks through Cloudflare. If a firewall in front of the edge allows only Cloudflare's addresses, it must allow NBO's server too, or reach checks and renewals fail.

Let's Encrypt works through Cloudflare, because Cloudflare passes the challenge request on to the edge. The edge answers challenges on both port 80 and port 443, so renewals should keep working with Always Use HTTPS on.

### The Origin CA option

In Cloudflare you can create an **Origin CA certificate**: a free certificate that only Cloudflare trusts, which is all Cloudflare needs on its way to NBO. Send the certificate and the private key with `PUT /projects/{id}/domains/{domainId}/certificate` (`{"certPem": "...", "keyPem": "..."}`, through `nbo-server api ... --body-file -` on the server, so the key stays off the command line). NBO checks that both can be read, that they belong together, that the certificate covers the host and that it hasn't expired. Then the domain goes straight to Active. There is no Let's Encrypt order and no renewal.

NBO stores the key encrypted so it can write the certificate into the cluster again. The daily pass does this; if a write fails, NBO waits 1 hour before the next try. About 30 days before the certificate expires, the domain carries a warning. NBO can't renew it: create a new one in Cloudflare and send it again.

Browsers don't trust Origin CA certificates. So **turning the switch off while a pasted certificate is in place removes it** and goes back to Let's Encrypt. Removing the pasted certificate on its own (`DELETE .../certificate`) has the same result.

### Warnings you may see

- **Flexible mode.** "Cloudflare is set to Flexible, so visitors get stuck in a redirect loop. In Cloudflare, open SSL/TLS and set the mode to Full (strict)." In Flexible mode Cloudflare talks plain http to the edge, the edge redirects to https, and the visitor loops. The domain stays Active and shows the warning. NBO checks when the domain goes Active, on **Check now** and once a day. The edge does not work around it, because that would leave the leg from Cloudflare to the edge unencrypted.
- **Pasted certificate expiring.** "The pasted Origin CA certificate expires on <date>. NBO can't renew it: create a new one in Cloudflare and paste it here."
- **Certificate refused (error 526).** "Cloudflare doesn't accept the certificate on the edge (error 526)." Full (strict) refuses an untrusted certificate, and a Let's Encrypt staging certificate is one. Visitors get Cloudflare's error page. Use a production certificate or paste an Origin CA certificate. For a staging trial, use plain Full.
- **Connection failed (error 525 or another 52x).** "Cloudflare can't complete the connection to the edge (error <number>)." Check that the edge is running and that the record in Cloudflare points at NBO's public address.
- **Pasted certificate, host out of reach.** "NBO couldn't reach <host> over https." A pasted certificate goes Active without any check of the path, so this may be the first sign of a wrong record. Check the DNS record in Cloudflare.
- **Pasted certificate, record not proxied.** "DNS for <host> doesn't answer with Cloudflare's addresses." Set the record to Proxied. Browsers don't trust Origin CA certificates, so visitors must come through Cloudflare.
- **Pasted certificate, no record.** "DNS has no record for <host> yet." Create it in Cloudflare and set it to Proxied.

The domain stays Active with any of these, and more than one can show at once. Each one clears by itself once a check finds the problem fixed. The checks run when the domain goes Active, on **Check now** and once a day. If NBO gets no answer from the host, it tries again after 1 hour.

### What your app sees

For a domain with the switch on, the edge uses Cloudflare's `CF-Connecting-IP` as the visitor's address in `X-Forwarded-For`, but only when the connection comes from one of Cloudflare's published address ranges. NBO fetches that list daily and keeps a bundled copy for when the fetch fails. If Cloudflare adds a range NBO hasn't picked up yet, visitors from it show up with Cloudflare's address.

For every other domain the edge deletes `CF-Connecting-IP` and `True-Client-IP`, so a visitor can't forge them to your app.

### Limits and Cloudflare settings that cause trouble

- **Cache Everything**, or any rule that ignores your origin's cache headers, is not supported. It can show one visitor's page to another and it breaks sticky visitors. Cloudflare's default settings are fine: it doesn't cache HTML or JSON, and it obeys `private` and `no-store`, which NBO already sends where needed.
- **Rocket Loader** and **Email Obfuscation** rewrite your HTML and can break React hydration. Turn them off for the domain.
- **Deploys don't purge Cloudflare's cache.** Files with hashed names are safe. If you cache something at a fixed address, purge it in Cloudflare yourself.
- **Traffic straight to the edge's address isn't blocked.** Anyone who knows the address can skip Cloudflare, and with it your Cloudflare firewall rules.
- **Moving the edge** to another cluster stays refused while custom domains exist, as without Cloudflare.

## Domains without a cluster

A project on Cloud Run can use its own domain with no edge and no cluster. NBO creates a **Cloud Run domain mapping**, Google gives you the DNS records, and Google issues the certificate. A mapping is free.

**Google calls this a Preview feature.** Its documentation says mappings aren't production-ready and can add latency, so use the edge for real traffic. A mapping also goes straight to one Cloud Run service, so traffic splits and Speed Insights don't apply.

> **Not tried for real yet.** Cloud Run domain mappings: the ownership check, the Active signal and moving a domain to the edge ran against a fake `gcloud` only. No real Google project was used.

You need all of this:

- No edge installed. Once an edge exists, new domains always use it.
- The project deployed to Cloud Run.
- A region with domain mapping. If yours doesn't have it, adding the domain is refused with a message saying so. Connect a cluster and install the edge, or deploy to a supported region.

Add the domain with `POST /projects/{id}/domains`. Then:

1. **Verify ownership**, once per root domain. Google only maps a domain for an account that owns it. Open [Google Search Console](https://search.google.com/search-console), verify the root domain (a DNS TXT record), then add the account named in the domain's status as a **verified owner** of that domain: select the domain, open **Verified owners** and choose **Add an owner**. NBO retries every 5 minutes, and the check route tries at once.
2. **Create the records** listed in the domain's `mappingRecords` at your DNS provider. If the domain has CAA records, allow both `pki.goog` and `letsencrypt.org`. For a subdomain this is usually one `CNAME` to `ghs.googlehosted.com.`.

   Each DNS record NBO gives (the edge's `record` and each of `mappingRecords`) has `type`, `name` and `value`, and the same target again as `data`. The hosted dashboard reads `data`, because the link never passes a field named `value`.

3. **Wait.** Google's certificate usually takes about 15 minutes and can take up to 24 hours. The status becomes **Active** when Google reports the mapping ready, and from then on the domain is the project's address (until then it is the cloud's `run.app` one).

Wildcards aren't supported, and a domain can have at most 64 characters.

### Moving a domain to the edge

After you install the edge, each mapped domain can move with `POST /projects/{id}/domains/{domainId}/move-to-edge`.

A move needs the Let's Encrypt email set (`nbo-server domains settings --acme-email`).

1. Send the move. The domain now gives the edge's record. Nothing changes for visitors yet: DNS still points at Google, and the mapping stays.
2. Change the DNS record to the new one. Remove Google's other records for that name.
3. NBO sees the change and gets a Let's Encrypt certificate. **HTTPS fails for a few seconds to minutes in between**, because that certificate can only be issued once DNS points at the edge. Plain HTTP keeps working. If the certificate fails, HTTPS stays down until you fix the cause, so watch the status.
4. When the domain is **Active**, NBO keeps the Cloud Run mapping for 24 more hours, so visitors with an old DNS answer still reach your site. Then it removes it.

A domain can't move back to Cloud Run. Removing a moved domain also deletes its mapping, so if DNS still points at Google, the site stops working.

While a domain uses a mapping, NBO refuses to remove the Cloud Run cloud from the project or disconnect Google.

## Troubleshooting

**Status stays "Waiting for DNS".** NBO resolves the name with its own DNS lookup. Check what the world sees: `dig +short shop.example.com` (or `nslookup`). It must give the edge address, or a CNAME chain that ends at the edge hostname. Common causes: a typo in the name, the record on the wrong domain, an old record still cached (wait for its TTL), or an extra `AAAA` record pointing somewhere else.

**The browser says the DNS address could not be found.** The record is missing, or the domain itself isn't registered or has no nameservers. NBO doesn't create DNS records: see [Launch NBO on a server](../production.md).

**Failed with "CAA" or "unauthorized" in the message.** A **CAA record** on your domain lists which authorities may issue certificates. If it exists and does not include `letsencrypt.org`, Let's Encrypt must refuse. Remove the CAA record or add `0 issue "letsencrypt.org"`.

**Failed: connection timed out, or the challenge could not be fetched.** Port **80** is blocked between the internet and the edge: a cloud firewall, a security group, or a corporate network. Open port 80 to the load balancer. Also make sure the DNS name points at the edge, not at an old server.

**Failed: "too many certificates" or "rate limit".** Let's Encrypt limits certificates per domain per week. This happens on shared domains such as sslip.io, and when you retry repeatedly. Set your own base domain, or switch to staging while testing, and wait. NBO backs off by itself after failures.

**Install edge fails at "Waiting for the load balancer's address".** Read the service's events with `kubectl -n nbo-edge describe service nbo-edge`. On Hetzner, `neither load-balancer.hetzner.cloud/location nor load-balancer.hetzner.cloud/network-zone set` means the load balancer needs a location: see [Launch NBO on a server](../production.md). Otherwise the cluster has no working LoadBalancer. Run the lb-test from [Creating a Kubernetes cluster](./clusters.md) and fix that first.

**"Cluster setup is out of date".** See above: `nbo-server cluster update-setup`.

**"An edge install is already running".** Wait for the running job to finish (the Domains card shows its step), or for it to fail.

**A project answers 502 through the edge.** Projects deployed before the edge was installed need a network policy that lets the edge in. NBO updates them when you install the edge or enable a cluster's public entry, one project at a time; if one fails, the control-plane log names it and the project stays cut off from the edge. Redeploy it, or reinstall the edge to try again.

**A domain works over HTTP but not HTTPS.** The certificate is not ready. Look at the status and message; use **Check now** after fixing the cause.

**Speed Insights shows nothing on the cluster edge.** Check the control-plane log for the drain error. An edge installed before NBO opened port 9444 in its NetworkPolicy needs a reinstall (`nbo-server edge reinstall`). If it still fails, something outside NBO blocks the API server from the edge pods on port 9444: private clusters often firewall the control plane from the nodes, so allow that port there.

**Behind Cloudflare: "Always Use HTTPS is on in Cloudflare and NBO has no certificate for <host> yet."** Cloudflare sent the check to https and the edge has no certificate yet. In Cloudflare, turn Always Use HTTPS off until the domain is Active, or paste an Origin CA certificate.

**Behind Cloudflare: "Cloudflare is blocking <host> before it reaches NBO."** A WAF rule (Cloudflare's firewall for web requests), a challenge page or Bot Fight Mode (Cloudflare's automatic blocking of bots) answered the check (a 403 or 503). Allow the path `/.well-known/acme-challenge/` in Cloudflare.

**Behind Cloudflare: "Cloudflare can't reach NBO for <host>."** The check got an error, a wrong answer or no answer. Check that the record for the host points at NBO's public address and is proxied, and that the edge is running.

**Behind Cloudflare: "<host> does not point at the edge … DNS answers nothing".** The record doesn't exist yet, or hasn't spread. Create it in Cloudflare and wait for it to appear.

**Behind Cloudflare: "the edge did not serve the challenge for <host> within 30 s".** The edge isn't running, or NBO can't reach port 80 of the edge's address. An origin firewall that allows only Cloudflare must also allow NBO's server.

**Behind Cloudflare: "Reinstall the edge first".** The edge was installed before this feature. Reinstall it with `nbo-server edge reinstall`, then turn the switch on again.

**Visitors see "too many redirects" on a Cloudflare domain.** Cloudflare is in Flexible mode. Set SSL/TLS to Full (strict). The domain shows the same warning.

**A Cloudflare domain stays at "Waiting for DNS".** With the switch on, NBO needs a DNS answer and then tests a real request. Read the message under the status: it is one of the messages above. If the switch is off, turn it on.

More general problems are in [Troubleshooting](./troubleshooting.md).
