# ADR 0003: Each visitor stays on one cloud

Date: 2026-11-03 · Status: accepted (approach chosen by the maintainer: "go with the bucket cookie")

## Context

The edge picked a backend at random by weight for every request. With two clouds running different builds, one visitor could load a page from build A and then request build A's hashed assets from the cloud running build B, which returns 404. The maintainer asked that a visitor keep their cloud until the cloud's version or the traffic split changes.

## Decision

- The edge gives each visitor a random 128-bit id in a first-party cookie `nbo_v` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` one week, `Secure` over https). It is set only on **document navigations** (page loads, not assets or API calls) when missing or malformed, because a `Set-Cookie` on an asset stops CDNs from caching it. A malformed `nbo_v` in a request does not hide a valid one later in the header, `Secure` follows the visitor's scheme (including `X-Forwarded-Proto`/`Forwarded` from a TLS terminator), and the cookie is stripped from the request before it reaches the app. `SameSite=Lax` means a cross-site `POST` navigation arrives without it and may be re-rolled onto another cloud. The cookie is per host.
- The backend is chosen by **weighted rendezvous hashing**. Each backend with weight > 0 scores `-ln(u) / weight`, where `u` is a uniform value from sha256(visitor id, backend key); the lowest score wins. The backend key is a stable `id` that the control-plane sends (the environment id), falling back to the URL.
- No server-side state: every edge replica makes the same choice from the cookie alone.

### Why rendezvous, not a bucket laid over the split

The maintainer approved "a bucket in a cookie". A bucket mapped over cumulative weights is simpler, but with three or more clouds it moves visitors between clouds that didn't gain any share: in a transfer from A+B to C, some A visitors would land on B. Weighted rendezvous keeps the cookie-bucket idea and moves a visitor only to a cloud whose share grew relative to theirs. A transfer, which shrinks the other clouds proportionally, therefore moves people only to the destination. Exception: whole-percent rounding in a transfer step can move about 1% of visitors sideways; this is bounded in a test.

### Version changes

A new deploy on a cloud doesn't re-assign anyone. Visitors stay on that cloud and get the new version there. This removes mixing **between clouds**. It does not remove skew **inside one cloud** during that cloud's rolling update, when old and new copies answer side by side and a visitor may get a page from one and an asset from the other; closing that would need the previous build's assets kept available for a while, which is not built.

## Consequences

- Update (2026-11-04, public edge): on the cluster edge, a visitor-supplied `X-Forwarded-Proto` / `Forwarded` is no longer trusted. The edge sets the scheme from the listener (port 8443 means https), so `Secure` follows the real connection. The dev-mode edge behind a TLS terminator still reads the headers.
- Clients without cookies (bots, curl) are picked at random by weight on each request, as before.
- The cookie is a random load-balancing id, not linked to any account.
- The edge admin API accepts an optional `id` per backend (non-empty and unique within the target). Edge sync sends it, and a live split without ids counts as out of sync, so it is re-pushed after an upgrade.
