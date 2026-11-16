# Linking to a hosted dashboard

NBO has no web interface of its own. If you would rather click than call an API, a hosted dashboard (a separate product, run by someone else) can drive your NBO server for you. This chapter explains what that link is, what it lets the dashboard do, what it can never do, and what happens when it breaks. You never have to link: an NBO that is never linked works exactly as the rest of this manual says.

> **Not tried for real yet.** Linking has run only on a local computer with a local kind cluster and a test link server. No real hosted dashboard, and no server on the internet, has been linked.

## What linking is

Think of your NBO server as a shop and the dashboard as a remote control. The remote control sends requests like "build this commit" or "move 10% of the traffic to Cloud Run". Your server decides, on its own, whether each request is allowed, and only then does it act.

Four things are true however the link is set up:

- **Your sites never depend on it.** Serving visitors, deploys on a push, certificates, crons, page revalidation and ephemeral environment expiry all run on your server and in your clusters. If the dashboard disappears, they carry on. A test starts a server pointed at an address that never answers and checks that a deploy, a poll, a certificate pass and a cron all finish.
- **Your server calls out, nobody calls in.** The server opens one connection to the dashboard (a WebSocket, with a slower fallback if that is blocked). You open no port for it.
- **The server checks everything.** The list of allowed requests, the approvals and the secret rules are all enforced inside your server, not trusted from the dashboard.
- **You can cut it at any time**, from the server, without the dashboard's help (see [Unlinking](#unlinking)).

## Linking

On the server, with the three values the dashboard shows when you add a server:

```
docker compose exec nbo nbo-server link - --url https://link.example.com --owner-key sha256:...
```

The `-` makes `nbo-server` read the one-time code from standard input: type the code, press Enter, then Ctrl-D. Prefer this to putting the code after `link` on the command line, because a code on the command line stays in your shell history. The code works once and expires after an hour.

You can instead set `NBO_LINK_ENROLL_URL`, `NBO_LINK_ENROLL_CODE` and `NBO_LINK_OWNER_KEY` before the server starts (see [Server settings](./server-settings.md)); the dashboard's setup command does that for you. Once the server is linked, those three settings are ignored, so leaving them in the env file is harmless.

The link address must be `https://`. Plain `http://` is accepted only for a loopback address on your own computer.

### The fingerprint, and why it matters

The dashboard hands you a fingerprint (`--owner-key sha256:...`). It identifies the first Owner's signing key, which was made in that person's browser, not on the dashboard's servers. When the server links, the dashboard sends back the Owner's full key, and the server accepts it only if it matches that fingerprint. This is what stops the dashboard from quietly putting in a key of its own. Take the fingerprint from the person who will be the Owner, not from a place the dashboard could have altered.

If linking fails, `nbo-server link` says why. After it works, `nbo-server link status` shows the team and whether the connection is up right now.

### Checking the core's key

The server also has an encryption key of its own, made on the server when it links. The dashboard encrypts secrets to it. `nbo-server link` and `nbo-server link status` print its fingerprint as `encryptionKeyFingerprint`, and so does the line the server logs when it links from the environment. The dashboard asks you to compare that fingerprint with the one it shows. If they differ, don't send secrets: unlink and link again.

## What the dashboard can and cannot make NBO do

Every request from the dashboard is one of three kinds, called tiers. The tier of each API route is fixed in the server's code, in one table next to the access table (`packages/controlplane/src/http/access.ts`), so a dashboard cannot widen it.

| Tier | What it covers                                                                                                                                                                                                                                                                                                    | What it needs                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 0    | Reading: projects, builds and their logs, traffic, domains, variable names, the link's own status                                                                                                                                                                                                                 | A valid request from the dashboard                              |
| 1    | Operating: starting a build, checking the repository for new commits now (`POST /projects/{id}/git/poll`), deploying a build you already have, changing traffic, moving between clouds, revalidating pages, checking, moving or removing a domain, removing a pasted certificate, creating ephemeral environments | The same                                                        |
| 2    | Changing what runs or who can reach it: creating or deleting a project, a git credential, variable values (including a build, deploy or move between clouds that brings its own values), cloud and cluster connections, the edge, custom environments, adding a domain, installing a certificate, member keys     | A signature from a team member's own key (an Admin or an Owner) |

A few more rules hold for every tier:

- **Values with a deploy need approval.** On a server set to "Don't store variable values", each build, deploy or move between clouds brings its variable values with it. Such a request is Tier 2 whenever it carries values at all, even an empty list, because those values become your app's variables. The same request without values stays Tier 1.
- **Secrets arrive sealed.** Values for variables, git tokens, certificate keys and cloud credentials must be encrypted to your server's own key before they leave the dashboard, so the dashboard's servers never see them in clear text. Each sealed value is also bound to your server and to the exact request and field it was sealed for (for example the variable `FOO` of one project), so it can't be copied into another project's request, another variable or another server. A request that sends one in clear text is refused.
- **Secrets never go back.** Every answer passes a filter first. Fields such as `value`, `secret`, `token`, `kubeconfig` and `keyPem` are replaced with `[withheld over the link]`, and any secret your server knows is blanked out of text, including in a build log streamed in pieces. To read a revalidation secret, read it on your server.
- **A stream the dashboard stops reading stops here too.** When the dashboard stops reading a build log (the page is closed), your server stops sending that stream as well; the build itself keeps running.
- **Only some `/system` routes.** The link can read the preflight, connections and edge state, and can connect or disconnect a cloud, install the edge, update a cluster's setup and change domains (those changes are Tier 2). It cannot make or read API tokens, download the Terraform provider, or link, unlink or reset keys.
- **No "run" instruction.** There is no message that runs a command on your server. The dashboard can only ask for routes that exist in the API.
- **Builds come from a branch.** Every build, however it was asked for (the API, Terraform or the dashboard), must be a commit that is on a branch of the project's repository. Deploying a build you already have (Promote) still works for rollbacks.
- **Cloud choices stay yours.** When the link creates an environment or moves a project between clouds, a Cloud Run choice can only be "auto", your server's own connected Google project, and a request that names another project is refused. Setting up a project, retrying its setup and adding a cloud are Tier 2: with an Admin's or Owner's signature they may name a manual Cloud Run project, as on the server itself.

## Member keys and approval

For a Tier 2 request, a person on the team approves it with a key that lives in their browser. The server holds each person's public key (a "member key") with a role, `owner` or `admin`. Only Owners can add or remove member keys, and the last Owner key cannot be removed. The approving signature covers the whole request, including its id and expiry, so an approved request cannot be replayed with small changes.

See the keys from the server:

```
docker compose exec nbo nbo-server keys list
```

An API token can also register an Owner key over plain HTTP (`POST /link/member-keys`). That is deliberate: whoever can reach your server with a token is root on it anyway. The dashboard cannot make tokens, so it cannot do this.

### When every Owner key is lost

```
docker compose exec nbo nbo-server keys reset --key sha256:<fingerprint>
```

`--key` is required: it is the fingerprint of the new Owner key, which the dashboard shows (with this whole command, ready to copy) under **Lost every browser with a key?**. The command prints a one-time code, valid for 1 hour and shown once, that registers that one key and no other. The Owner enters it in the dashboard, in the browser that holds the key.

A code is used up by its first try, even when the registration is refused. Tried with any other key, it is refused and spent, so someone who learns the code can't register a key of their own and gets no second try. A key that does not import uses it up too. Run `keys reset --key ...` again for a fresh one.

## The journal

Your server writes down every request the dashboard sends, whether it did the work or refused it:

```
docker compose exec nbo nbo-server link journal --limit 50
```

The same list is at `GET /link/journal`. Each row has the time, the route, the tier, who signed it, a status and a reason. Rows are kept 90 days, and they stay after an unlink.

Read the status, not only the word "accepted". `accepted` means your server's own checks passed (the signature, the expiry, the tier, the sequence number). A later check inside the route, such as a secret sent in clear text, can still answer 400, and the row keeps `accepted` with that status. A row that is not accepted was refused before anything ran.

## Keys change over time

The dashboard signs requests with a key that it rotates. Your server accepts a new dashboard key only when the key it already trusts signed it, and only one version at a time. If the acknowledgement of a rotation is lost on the way, the dashboard announces the same key again and your server acknowledges it again. A retired key is never trusted again, so a stolen old key cannot take over a server.

## Unlinking

```
docker compose exec nbo nbo-server unlink
```

This takes effect at once. The dashboard's keys, the member keys and any reset codes are forgotten, and the connection closes and stays closed. A request that was already running finishes (your server never cuts its own work short), but its answer is dropped. The journal is kept. Link again with a new code if you want.

## What keeps working when the link is down

| Keeps working                                    | Why                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Serving your sites                               | The edge and the apps run in your clusters and never call the dashboard. |
| Deploys on a push                                | Your server polls the repository itself with its own git credential.     |
| Certificates                                     | The renewal loop runs on your server and asks Let's Encrypt directly.    |
| Crons, page revalidation                         | They run on your server and in your own apps.                            |
| Ephemeral environment expiry                     | Your server removes them on their own timer.                             |
| Rollbacks, traffic changes, moves between clouds | The API and Terraform, with a token.                                     |

What stops is the dashboard itself, and anything that needs it. Your server queues nothing for the dashboard that could block work.

## Known gaps

- **The reset command comes from the dashboard's page.** The fingerprint and the `keys reset --key` command under **Lost every browser with a key?** are shown by the dashboard, and the dashboard's page is served by the hosted platform. A fully compromised platform serving its own page could show its own key's fingerprint there. If in doubt, compare the fingerprint with your browser's own key list (Settings → Signing keys) before you run the command.
- **Some domain changes stay Tier 1, by decision.** Changing a domain's "behind Cloudflare" switch (`PATCH` on a domain), removing a pasted certificate, moving a domain to the edge and removing a domain are operating, not changing what runs: the worst a misused one does is take a domain offline until you put it back. Adding a domain and installing a certificate are Tier 2.
- **The label on a reset registration is the platform's.** A key registered with a reset code is stored with the member id the platform sends with it. That id is only a label in the key list and the journal: the key's power comes from the code and its fingerprint, not from the label.

## If it does not work

These are the reasons your server gives when it refuses a request. They show in the journal and in the dashboard.

| Message                                                                     | What it means                                                                                                                     | What to do                                                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `instruction expired at <time>; this core's clock says <time>`              | The request was already out of date when it arrived. Either the server's clock is wrong or the connection was very slow.          | Check the server's clock (`date -u`) and fix it with time sync. Requests are good for 60 seconds, with 5 seconds of allowed difference. |
| `instruction expires too far ahead (<time>); this core's clock says <time>` | The server's clock is behind the dashboard's.                                                                                     | Fix the server's clock.                                                                                                                 |
| `instruction was already received`                                          | The server has seen this request before. Usually a harmless repeat.                                                               | Nothing, unless it happens on every request. Then reconnect the link.                                                                   |
| `instruction sequence jumps too far ahead`                                  | The request numbers are out of step with the last one seen.                                                                       | Reconnect the link. If it persists, unlink and link again.                                                                              |
| `instruction signature is not valid`                                        | The request was not signed by the dashboard key your server pinned, or was altered on the way.                                    | Check that you linked to the right dashboard. If its key changed without a rotation, unlink and link again with a new code.             |
| `instruction is for another core`                                           | The request was meant for a different server.                                                                                     | Check that the dashboard has the right server selected.                                                                                 |
| `route is not allowed over the link: <METHOD /path>`                        | The link may never call that route (for example API tokens or the Terraform provider download).                                   | Do it on the server, or with a token.                                                                                                   |
| `Tier 2 needs a valid member signature`                                     | The change needs a team member's approval, and the signature is missing, from an unknown key, or does not check out.              | Approve it again in the dashboard. If you lost every Owner key, use `nbo-server keys reset --key`.                                      |
| `the signing key's role <role> can't sign <route>`                          | The member key's role is too low for that change. Member keys can only be managed by an Owner.                                    | Ask an Owner to approve.                                                                                                                |
| `<field> must be sealed to this core's key`                                 | A secret was sent in clear text.                                                                                                  | Use a dashboard that seals it.                                                                                                          |
| `<field> does not open with this core's key`                                | The secret was sealed to a different server's key (for example before an unlink and a new link), or for another field or request. | Reload the dashboard and send it again.                                                                                                 |
| `<field> is in the old sealed format (v1); seal it again`                   | The secret was sealed by an older dashboard or tool, before sealed values were bound to where they are used.                      | Reload the dashboard (or update the tool) and send it again.                                                                            |
| `<field> can't be sent over the link`                                       | The request tried to send something the link never allows, such as a Google project of the dashboard's choosing.                  | Use the "auto" choice, or do it on the server.                                                                                          |
| `this core is not linked`                                                   | The server was unlinked while a request was on its way.                                                                           | Link again if you want the dashboard back.                                                                                              |
| `core is busy` or `too many open streams`                                   | The server runs at most 16 instructions at a time and a limited number of log streams.                                            | Try again in a moment.                                                                                                                  |

If enrollment times out after the dashboard already used the code, trying the same code again answers "used, expired or unknown". Ask the dashboard for a new code. A used code still sitting in `NBO_LINK_ENROLL_CODE` is ignored once the server is linked; on a server that is not linked it prints one line, `control-plane: linking with the code from NBO_LINK_ENROLL_CODE was refused: <reason>`, and the server runs as usual.
