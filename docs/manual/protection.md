# Deployment protection

Deployment protection asks for a password before anyone can open a project's sites. Use it to show unfinished work to a
client without the rest of the world seeing it, or to keep an internal tool private. The password is one you choose;
NBO keeps only a salted hash of it.

## The three settings

| Setting        | Who needs the password                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Off**        | Nobody. This is the default.                                                                                                              |
| **Previews**   | Visitors of every environment except Production: Preview, Development, custom environments such as `staging`, and ephemeral environments. |
| **Everything** | Visitors of every environment, Production included.                                                                                       |

The setting covers every address an environment answers on: its default host, its custom domains, and the cloud's own
addresses (a Cloud Run service's `*.run.app` address and the Kubernetes Service), so there is no way around it.

Set it with `PUT /projects/{id}/protection` and a body such as `{ "mode": "previews", "password": "…" }`, or in the
hosted dashboard under Project → Settings → Deployment protection. `GET /projects/{id}/protection` answers the setting
and whether a password is set (`{ "mode": "previews", "passwordSet": true }`), never the password or its hash. The
password must be 8 to 256 characters. Turning protection on needs a password the first time; after that, a body
without `password` keeps the stored one, and **Off** keeps it too, so turning protection on again needs no new password.
Through the link, changing the setting is Tier 2 and the password is sealed in the browser.

## What a visitor sees

A visitor without access gets a page that says the site is protected, with one password field. The right password
signs the visitor in for 7 days on that address (a cookie that only the site's server can read). A new password signs
every visitor out. Requests that are not page loads, such as calls to an API route, get `401` with the text
`This site is protected.`

After 10 wrong passwords in a minute from one address, that address waits a minute; after 100 wrong passwords in a
minute in all, everyone waits a minute. Search engines are told not to index the password page. The minute-wide limit across all addresses
also stops visitors typing the right password, so a flood of wrong guesses locks everyone out who is not signed in
yet, for a minute at a time; visitors already signed in are not affected. At most two passwords are checked at the
same time; more answer `429`.

Responses a signed-in visitor gets are marked `Cache-Control: private`, so a shared cache in front of the site (for
example Cloudflare) never keeps protected pages or files and hands them to someone without the password.

## What stays open

Two kinds of request reach the site without the password, because NBO sends them itself:

- **Scheduled jobs (crons).** Each carries a signature only NBO can make; the site checks it.
- **Page-cache revalidation** (`POST /_nbo/revalidate`), which checks its own secret. See
  [Page cache and revalidation](./cache.md).

Everything else, static files included, needs the password.

## When a change applies

Saving a change redeploys each affected environment's current build on every cloud, without a rebuild, so the change
applies within about a minute. Only the environments whose protection changed are redeployed (Previews to Everything
redeploys only Production). An environment with nothing deployed yet takes the setting with its first deploy; the
answer lists such clouds under `notRedeployed`, with the reason.

## How it works

The site's own server (`nbo serve`, inside every app image) does the checking. A protected environment's deploys carry
the password's hash as the secret variable `NBO_PROTECTION`, delivered the same way as your secret variables (a
Kubernetes Secret, or Secret Manager on Cloud Run), never inside the build output or the image. The setting is part of
the variables fingerprint, so a change counts as a change: a redeploy is never skipped as already live.
