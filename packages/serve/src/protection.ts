// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash, createHmac, scrypt, timingSafeEqual } from "node:crypto";
import { secretEquals } from "./secret-equals.js";

// Deployment protection: a password in front of every request this server answers, set by the project's
// owner. Core hands the server only a salted scrypt hash, as NBO_PROTECTION; a visitor who types the
// password gets a cookie for this host. Cron calls (signed by core) and /_nbo/revalidate (its own secret)
// pass without it. How it behaves for users: docs/manual/protection.md.

const COOKIE = "nbo_protect";
const COOKIE_SECONDS = 7 * 24 * 3600;
const FORM_PATH = "/_nbo/protect";
const CRON_SKEW_SECONDS = 300;
const MINUTE_MS = 60_000;
const PER_ADDRESS = 10;
const PER_PROCESS = 100;
const MAX_FORM_BYTES = 8192;
const MAX_CHECKING = 2;

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

/** Checks NBO_PROTECTION's shape: scrypt$N$r$p$<salt b64url>$<key b64url>. Throws naming the variable, never the value. */
export function parseProtectionHash(hash: string): ParsedHash {
  const parts = hash.split("$");
  const [alg, n, r, p, salt, key] = parts;
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN);
  const parsed = {
    N: num(n),
    r: num(r),
    p: num(p),
    salt: Buffer.from(salt ?? "", "base64url"),
    key: Buffer.from(key ?? "", "base64url"),
  };
  if (
    parts.length !== 6 ||
    alg !== "scrypt" ||
    [parsed.N, parsed.r, parsed.p].some((x) => !(x > 0)) ||
    // scrypt needs N a power of two; the bounds keep one check's memory small (core writes 16384, 8, 1).
    (parsed.N & (parsed.N - 1)) !== 0 ||
    parsed.N > 1 << 20 ||
    parsed.r > 32 ||
    parsed.p > 16 ||
    parsed.salt.length < 16 ||
    parsed.key.length < 16
  )
    throw new Error("NBO_PROTECTION is not a valid protection hash");
  return parsed;
}

/** Whether password matches the hash; the scrypt work runs off the event loop. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const h = parseProtectionHash(hash);
  const derived = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: 256 * h.N * h.r }, (err, k) =>
      err ? reject(err) : resolve(k),
    ),
  );
  return timingSafeEqual(derived, h.key);
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function pageHtml(next: string, message?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Protected</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#1d1d1b}
@media (prefers-color-scheme:dark){body{background:#1b1b19;color:#eceae4}input{background:#262623;color:inherit;border-color:#75716a}}
main{width:min(22rem,calc(100% - 2rem))}
h1{font-size:1.25rem;font-weight:600;margin:0 0 1.25rem}
label{display:block;font-size:.875rem;margin-bottom:.375rem}
input{box-sizing:border-box;width:100%;padding:.625rem .75rem;font:inherit;border:1px solid #8a857a;border-radius:4px}
button{margin-top:1rem;width:100%;padding:.625rem;font:inherit;font-weight:600;border:0;border-radius:4px;background:#1d1d1b;color:#f6f5f1;cursor:pointer}
@media (prefers-color-scheme:dark){button{background:#eceae4;color:#1b1b19}}
p{font-size:.875rem;margin:.75rem 0 0}
</style>
</head>
<body>
<main>
<h1>This site is protected.</h1>
<form method="post" action="${FORM_PATH}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Continue</button>
${message ? `<p role="alert">${esc(message)}</p>` : ""}
</form>
</main>
</body>
</html>
`;
}

const refusalHeaders = { "cache-control": "no-store", "x-robots-tag": "noindex" };

function refuse(request: Request, status: number, next: string, message?: string): Response {
  if ((request.headers.get("accept") ?? "").includes("text/html"))
    return new Response(pageHtml(next, message), {
      status,
      headers: { ...refusalHeaders, "content-type": "text/html; charset=utf-8" },
    });
  return new Response(message ?? "This site is protected.", {
    status,
    headers: { ...refusalHeaders, "content-type": "text/plain; charset=utf-8" },
  });
}

// A path on this host only: "//x", "/\x", absolute URLs and control characters (browsers drop tabs)
// could send the visitor elsewhere.
const safeNext = (next: string | null): string => {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  try {
    const u = new URL(next, "http://h");
    return u.host === "h" ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
};

// readForm reads at most max bytes of the body, counting as it goes (a chunked body has no
// content-length); null when it is longer.
async function readForm(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * keepPrivate: a response the gate let through, marked private, so no shared cache (a CDN in front of
 * the site) keeps protected content and hands it to visitors without the password.
 */
export function keepPrivate(res: Response): Response {
  const kept = (res.headers.get("cache-control") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "" && !/^(public|private|s-maxage\s*=|proxy-revalidate)/i.test(d));
  const value = ["private", ...kept].join(", ");
  try {
    res.headers.set("cache-control", value);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set("cache-control", value);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

function cookieValue(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

// The visitor's address: the last X-Forwarded-For entry, the one the cluster edge or Google's front end
// added (earlier entries are the client's own word).
const clientOf = (request: Request): string =>
  (request.headers.get("x-forwarded-for") ?? "").split(",").pop()!.trim() || "unknown";

/**
 * The gate: null lets the request through, a Response answers it. `now` is in milliseconds.
 */
export function createGate(opts: {
  hash: string;
  cronSecret?: string;
  now?: () => number;
}): (request: Request) => Promise<Response | null> {
  parseProtectionHash(opts.hash);
  const now = opts.now ?? Date.now;
  // A new password is a new hash, so every earlier cookie stops matching.
  const cookieKey = createHash("sha256").update(opts.hash).digest();
  const sign = (expiry: number) => createHmac("sha256", cookieKey).update(String(expiry)).digest("hex");

  const failures = new Map<string, { start: number; count: number }>();
  let processFailures = { start: 0, count: 0 };
  const current = (w: { start: number; count: number } | undefined) =>
    w && now() - w.start < MINUTE_MS ? w : { start: now(), count: 0 };
  const limited = (address: string) =>
    current(processFailures).count >= PER_PROCESS || current(failures.get(address)).count >= PER_ADDRESS;
  // refund takes back a counted guess that turned out right.
  const refund = (address: string) => {
    processFailures.count = Math.max(0, processFailures.count - 1);
    const w = failures.get(address);
    if (w) w.count = Math.max(0, w.count - 1);
  };
  // Password checks running at once: each holds 16 MiB and a libuv thread the rest of the site shares.
  let checking = 0;
  const fail = (address: string) => {
    processFailures = current(processFailures);
    processFailures.count++;
    const w = current(failures.get(address));
    w.count++;
    failures.set(address, w);
    if (failures.size > 10_000) for (const [k, v] of failures) if (now() - v.start >= MINUTE_MS) failures.delete(k);
  };

  const signedIn = (request: Request): boolean => {
    const value = cookieValue(request);
    const m = value ? /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value) : null;
    if (!m) return false;
    const expiry = Number(m[1]);
    return expiry * 1000 > now() && secretEquals(m[2]!, sign(expiry));
  };

  const cronSigned = (request: Request): boolean => {
    if (!opts.cronSecret) return false;
    const id = request.headers.get("x-nbo-cron");
    const ts = request.headers.get("x-nbo-cron-timestamp");
    const auth = request.headers.get("authorization") ?? "";
    if (!id || !ts || !/^\d{1,12}$/.test(ts) || !auth.startsWith("Bearer ")) return false;
    if (Math.abs(now() / 1000 - Number(ts)) > CRON_SKEW_SECONDS) return false;
    const want = createHmac("sha256", opts.cronSecret).update(`${id}:${ts}`).digest("hex");
    return secretEquals(auth.slice("Bearer ".length), want);
  };

  const submit = async (request: Request): Promise<Response> => {
    const address = clientOf(request);
    const declared = Number(request.headers.get("content-length") ?? 0);
    const text = declared > MAX_FORM_BYTES ? null : await readForm(request, MAX_FORM_BYTES);
    if (text === null) return refuse(request, 413, "/", "That request is too large.");
    const form = new URLSearchParams(text);
    const next = safeNext(form.get("next"));
    const tooMany = () => refuse(request, 429, next, "Too many attempts. Try again in a minute.");
    if (limited(address)) return tooMany();
    // Counted before the check, so guesses sent at once cannot all pass the limit; refunded when right.
    fail(address);
    if (checking >= MAX_CHECKING) return tooMany();
    checking++;
    let right: boolean;
    try {
      right = await verifyPassword(opts.hash, form.get("password") ?? "");
    } finally {
      checking--;
    }
    if (!right) return refuse(request, 401, next, "That password is not right.");
    refund(address);
    const expiry = Math.floor(now() / 1000) + COOKIE_SECONDS;
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
        "cache-control": "no-store",
        "set-cookie": `${COOKIE}=${expiry}.${sign(expiry)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_SECONDS}`,
      },
    });
  };

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/_nbo/revalidate") return null; // checks its own secret
    if (url.pathname === FORM_PATH) {
      if (request.method === "POST") return submit(request);
      return signedIn(request)
        ? new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } })
        : refuse(request, 401, "/");
    }
    if (signedIn(request) || cronSigned(request)) return null;
    return refuse(request, 401, safeNext(url.pathname + url.search));
  };
}
