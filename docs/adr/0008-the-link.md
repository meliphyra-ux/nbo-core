# ADR 0008: The link between a core and a hosted dashboard

Date: 2026-11-13. Status: accepted. The maintainer approved plans and steps in advance; every call below is Claude's, made on that approval, and the maintainer can overturn one before anyone outside the maintainer's own servers uses the link.

## Context

NBO is an open core with no web interface. A hosted dashboard (a separate product) should be able to drive a core without three things going wrong: the dashboard becoming a place where a team's secrets live, a stolen dashboard being able to run code on a team's server, and a dashboard outage touching a team's sites. So the dashboard may only ask for things the core's own API already offers, the core checks every ask itself, and nothing the core does for sites ever waits on the link.

## Decision

### An instruction is a request envelope

An instruction names an HTTP route of the core's own API: a method, a route pattern, its path parameters, a query and a body, plus `linkVersion: 1`, an `id`, a sequence number `seq`, a `nonce`, an expiry and the core's id. There is no "run this command" message. After the core's checks pass, the dispatcher calls the same router handlers the HTTP API uses, so there is one set of rules for a route whoever calls it. Messages are capped at 5 MiB, at most 16 instructions run at once (more answer 429 `core is busy` and are journaled), and an instruction is good for 60 seconds with 5 seconds of clock skew allowed on each side. A refusal for time names the core's own clock.

### Signing bytes

Every signature is Ed25519 over a prefix followed by RFC 8785 canonical JSON, so the same value always has the same bytes. The prefixes are exactly:

- `nbo-link/instruction/v1\n`, the dashboard signing an envelope.
- `nbo-link/tier2/v1\n`, a team member signing the same envelope for a Tier 2 route. It covers the whole envelope (id, seq, nonce and expiry included), so an approved instruction cannot be replayed with a new nonce. A browser therefore asks the dashboard to prepare the envelope before signing it.
- `nbo-link/auth/v1\n`, a core answering the dashboard's challenge when it connects (core id, challenge, link host).
- `nbo-link/rotate/v1\n`, the current dashboard key announcing a new one.
- `nbo-link/enroll/v1\n`, a core proving it holds the keys it sends with an enrollment code.
- `nbo-link/seal/v2`, the sealed box (below; v1 is retired).

The prefixes keep a signature made for one purpose from being accepted for another. The messages and signing bytes live in `@nbo/link-protocol`, written against WebCrypto only so a browser can use the same code.

### The tier column

`routeLinkTier` is a second table in `access.ts` with exactly the keys of `routeAccess` (a test holds them equal). A route's value is `0` (read), `1` (operate), `2` (change what runs or who can reach it), `null` (never over the link), or a function of the request for the few routes whose tier depends on the body or on stored state (for example, a settings change is Tier 1 only when every key is one of the old, harmless ones). A route with no row, or a function that throws, fails closed. The table is frozen. The legacy routes that take raw paths or unchecked cloud settings, the push webhook, API tokens, the Terraform provider download, and linking, unlinking and key reset are `null`.

Tier 2 needs a member signature from a key with the role `admin` or `owner`. Member keys are Ed25519 like every other key; registration accepts `owner` and `admin` only; the member-key routes need `owner`; the last Owner key cannot be removed. A reset code registers one Owner key and nothing else.

### Secrets: the sealed box and the outbound filter

Fields that hold a secret (variable values, git tokens, certificate keys, cloud and cluster credentials, the values that ride on a build) must arrive sealed to the core's own X25519 key: an ephemeral X25519 exchange, HKDF-SHA256 keyed by the two public keys (info `nbo-link/seal/v2`), and AES-256-GCM. The box is `{ "$sealed": { "v": 2, "epk", "iv", "ct" } }`, and its additional authenticated data is `nbo-link/seal/v2\n` plus the RFC 8785 canonical JSON of `{ coreId, route, path, field }`: the core's link id, the route key exactly as in `LINK_SEALED_FIELDS` (`PUT /projects/{projectID}/env/{name}`), the concrete request path the instruction targets (`/projects/p_1/env/FOO`: `requestPath(routePattern, params)`, each param percent-encoded with `encodeURIComponent`, no query string, the same path core's dispatcher routes with) and the field's dotted path (`value`). The binding never travels in the box: the core takes the route and path from the instruction it is dispatching, the field from where it finds the box and the id from its own link state, so a box copied to another field, route, project, variable name or core does not open. The approver never sees inside a box, so this is what stops one project's sealed values from being replayed into another project's request. Every sealed value is a request-body field of that table; nothing else is sealed over the link. A clear-text value on one of those fields is refused, and so is a box of the first format (`v: 1`, a fixed additional data that bound no place; amended 2026-11-15, security audit, before any real core was linked, so there is no window in which core accepts both). Going the other way, every answer passes a filter that withholds fields by name and redacts any secret the core knows, including one cut across two stream chunks. This enforcement is in the core, not on the platform.

### Replay

A 64-wide sequence window plus nonce uniqueness. An instruction whose `seq` is 64 or more behind the highest accepted, or whose `seq` and nonce are already in the journal, is refused as already received; a `seq` that jumps too far ahead is refused. Both live in the journal table, so a restart does not reopen a replay. The journal has an `accepted` flag, and a partial unique index on the nonce covers accepted rows only, so a refusal can be journaled without throwing. `accepted` means the verifier passed; a later 4xx from the handler keeps `accepted` with that status, and readers must check the status. The journal is kept 90 days and survives an unlink.

A consequence for the dashboard: because a member signature covers the sequence number, an approval prepared too early can fall out of the 64-wide window. The dashboard must prepare and sign at approval time, not at request time.

### Keys and rotation

A core pins the dashboard's instruction-signing key, the link host and the first Owner key at enrollment. The Owner key is accepted only if its fingerprint equals the one the team carried in with the code. The core accepts a new dashboard key only when the key it currently trusts signed it, one version at a time. If the acknowledgement was lost, the dashboard announces again and the core acknowledges again without a state change. No retired key is trusted: a stolen old key must not be able to rotate a core.

### The calls that touch core

- New routes: `GET /link/status`, `GET /link/journal`, `GET /link/member-keys`, `POST /link/member-keys`, `DELETE /link/member-keys/{keyId}`; local-only `POST /system/link/enroll`, `/unlink` and `/keys-reset`. A new `GET /builds/{buildID}/log` streams a build log (`?follow=1`).
- Every build checks that its commit is on a branch of the configured repository, for HTTP, Terraform and the link alike.
- `nbo-server link <code|->`, `link status`, `link journal`, `unlink`, `keys list`, `keys reset --key sha256:<fingerprint>`; no secret is a flag value, and the code may be read from stdin.
- Enrollment needs `--url` and `--owner-key` besides the code; the link host returned must equal the URL's host; `http:` only for loopback.
- Settings `NBO_LINK_ENROLL_URL`, `NBO_LINK_ENROLL_CODE`, `NBO_LINK_OWNER_KEY`; a used code left in the environment of a linked core is ignored, and a refused code never stops startup.
- The core keeps one outbound WebSocket (long-poll fallback) open in the background. No deploy, poll, build, certificate, cron, ISR or expiry path waits on it.
- `routeLinkTier` and the outbound filter live in `packages/controlplane/src/link/`.

## Consequences

- A stolen dashboard can read what Tier 0 allows and operate within Tier 1, but cannot change what runs, add a key, read a secret or run a command without a team member's own signature.
- An API token can still register an Owner key over plain HTTP; local access is root on the server anyway, and the dashboard cannot make tokens.
- Per-team rate limits and disabling old dashboard key versions after 30 days are left to later work.
- Added 2026-11-14: a `cancel` message (`{ type: "cancel", linkVersion: 1, id }`, platform to core, unsigned). It names an instruction whose answer the platform no longer reads; core stops sending that answer's stream (the source is returned, freeing its stream slot and idle timer, and the stream ends with `stream-end` error `cancelled`, or nothing is sent if the reply was not ready yet). It never stops the work itself, a plain `response` is sent whole, and a cancel for an id not in flight on that connection is ignored. It is unsigned because it can only stop relaying an answer; older cores drop it as an unknown message type.
