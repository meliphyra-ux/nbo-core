// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHmac, timingSafeEqual } from "node:crypto";
import { ErrNotFound, type Store } from "../store/store.js";
import { branchInUse, type Stage } from "../stages/stages.js";
import { ephemeralInfo, withoutDetails, type Build, type GitConfig } from "./git.js";
import type { CommandRunner } from "@nbo/deploy";
import { run } from "../builds/run.js";
import {
  credentialInput,
  credentialView,
  generateDeployKey,
  githubImportRefused,
  parseCredential,
  repoCredentialProblem,
  repoMovedHost,
  repoOrigin,
  type GitCredentialRequest,
} from "./git-credentials.js";
import type { Router } from "../http/router.js";
import { isTokenRequest } from "../http/api-tokens.js";
import { isRecord, writeJSON, writeError, statusForStoreError, errorMessage } from "../http/handlers.js";

// BuildTrigger is the minimal shape the webhook route needs to kick
// off a real build — build-queue.ts's createBuildQueue implements it.
// enqueue is synchronous: it records a queued build and starts it in
// the background when the project is idle, so the webhook answers
// immediately (a real build takes minutes; GitHub's delivery times out
// long before that).
export interface BuildTrigger {
  // manual: a hand-requested full rebuild (bypasses the ignored build step).
  // stageId: the stage the build is for (Production when not given).
  // values: variable values the request brought (names only; kept in memory).
  enqueue(
    projectId: string,
    revision: string,
    opts?: { manual?: boolean; stageId?: string; values?: Record<string, string> },
  ): Build;
}

// verifyGithubSignature checks rawBody against GitHub's own
// X-Hub-Signature-256 header format (`sha256=<hex HMAC-SHA256>`) —
// never throws, so a missing/malformed header is just "not verified",
// not a crash. timingSafeEqual on equal-length buffers only: a
// non-constant-time compare on a secret-derived value is a real
// timing side channel, the same reasoning cron-ping's own fixture
// already applies to its signature check.
export function verifyGithubSignature(secret: string, rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const want = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const validFrameworks = new Set(["nextjs", "static"]);

// isSafeOutputDir rejects anything that could escape the cloned
// repository once resolved against it — an absolute path, "..", or
// "." (the whole clone, .git/ included) would otherwise publish the
// repo's full history and node_modules as the deployed static site.
// A plain relative path with no ".." segment is the only shape
// accepted; runner.ts's own resolved-path check is defense in depth
// on top of this, not a substitute for it.
// normalizeDir drops "./" prefixes and trailing slashes: "./web/" → "web".
export function normalizeDir(dir: string): string {
  return dir
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
}

export function isSafeOutputDir(dir: string): boolean {
  if (dir === "" || dir === "." || dir.startsWith("/") || dir.startsWith("\\") || /^[a-zA-Z]:/.test(dir)) return false;
  return !dir.split(/[/\\]/).some((seg) => seg === "..");
}

// isRealSha reports whether after looks like a real git commit sha
// (40 lowercase hex characters) — a real push event's own payload
// always has one; anything else (an option-shaped string, a
// malformed value) must never reach `git checkout` as a literal
// argument.
function isRealSha(after: string): boolean {
  return /^[0-9a-f]{40}$/.test(after);
}

// stageForBranch returns the custom environment that builds from branch,
// else the ephemeral one on it that isn't being removed, or null
// (Production's branch belongs to no other environment).
export function stageForBranch(store: Store, projectId: string, branch: string): Stage | null {
  const stages = store.listStages(projectId, { includeEphemeral: true });
  return (
    stages.find((s) => s.kind === "custom" && s.branch === branch) ??
    stages.find((s) => s.kind === "ephemeral" && s.removal === "" && s.branch === branch) ??
    null
  );
}

const allZeroSha = "0".repeat(40);

// sameRepoUrl: the same repository however it is spelled (case, a trailing
// ".git", trailing slashes), so a client that writes the URL its own way
// (Terraform, a hand-edited form) doesn't drop the GitHub link.
export function sameRepoUrl(a: string, b: string): boolean {
  const norm = (u: string): string =>
    u
      .trim()
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
  return norm(a) === norm(b);
}

// GitConfigRouteDeps: keygen runs ssh-keygen for deploy keys (the real
// runner by default).
export interface GitConfigRouteDeps {
  keygen?: CommandRunner;
}

const localRunner: CommandRunner = (cmd, args, opts) =>
  run(cmd, args, { timeoutMs: opts?.timeoutMs ?? 60_000, env: opts?.env, input: opts?.input });

// registerGitConfigRoutes: each project's repository, branch, build settings
// and git credential (git-credentials.ts). No answer carries a stored token
// or private key: only the credential's kind, public key and user name.
export function registerGitConfigRoutes(router: Router, store: Store, deps: GitConfigRouteDeps = {}): void {
  const keygen = deps.keygen ?? localRunner;
  router.handle("PUT", "/projects/{projectID}/git", async (request, params) => {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return writeError(400, "repo, productionBranch, framework and buildCommand are required");
    }
    if (isRecord(parsed) && parsed.github !== undefined) return writeError(400, githubImportRefused);
    if (
      !isRecord(parsed) ||
      typeof parsed.repo !== "string" ||
      !parsed.repo ||
      typeof parsed.productionBranch !== "string" ||
      !parsed.productionBranch ||
      typeof parsed.buildCommand !== "string" ||
      !parsed.buildCommand ||
      typeof parsed.framework !== "string" ||
      !validFrameworks.has(parsed.framework) ||
      (parsed.outputDir !== undefined &&
        (typeof parsed.outputDir !== "string" || !isSafeOutputDir(parsed.outputDir))) ||
      (parsed.rootDirectory !== undefined &&
        (typeof parsed.rootDirectory !== "string" ||
          (parsed.rootDirectory !== "" && !isSafeOutputDir(parsed.rootDirectory))))
    ) {
      return writeError(
        400,
        'repo, productionBranch, framework ("nextjs" or "static"), and buildCommand are required; outputDir and rootDirectory, if given, must be plain relative paths with no ".." segment',
      );
    }
    const projectId = params.projectID!;
    let requested: GitCredentialRequest | undefined;
    try {
      requested = parseCredential(parsed.credential);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
    let stored: GitConfig | undefined;
    try {
      stored = store.getGitConfig(projectId);
    } catch (err) {
      if (!(err instanceof ErrNotFound)) return writeError(statusForStoreError(err), errorMessage(err));
    }
    const repo = parsed.repo;
    // A project linked to the old per-server GitHub App keeps its link while
    // its repository and credential are left as they are (github-legacy.ts).
    const keepLink = stored?.github !== undefined && requested === undefined && sameRepoUrl(repo, stored.repo);
    try {
      store.getProject(projectId);
      const kind = keepLink
        ? "github-legacy"
        : (requested?.kind ?? store.getGitCredential(projectId)?.kind ?? "public");
      const problem = keepLink ? null : repoCredentialProblem(repo, kind);
      if (problem) return writeError(400, problem);
      // A stored credential never follows the repository to another host (or
      // scheme, or port): sending a token there would hand it to that host.
      if (!requested && stored && store.getGitCredential(projectId) && repoOrigin(repo) !== repoOrigin(stored.repo)) {
        return writeError(400, repoMovedHost);
      }
      const taken = branchInUse(store, projectId, parsed.productionBranch);
      if (taken && taken !== "production") {
        return writeError(409, `the branch "${parsed.productionBranch}" already builds the ${taken} environment`);
      }
      const input = requested ? await credentialInput(store, requested, projectId, projectId, keygen) : "keep";
      const config: GitConfig = {
        repo: keepLink ? stored!.repo : repo,
        productionBranch: parsed.productionBranch,
        framework: parsed.framework as "nextjs" | "static",
        buildCommand: parsed.buildCommand,
        outputDir: typeof parsed.outputDir === "string" ? parsed.outputDir : undefined,
        spa: parsed.spa === true,
        ignoredBuildStepCommand:
          typeof parsed.ignoredBuildStepCommand === "string" ? parsed.ignoredBuildStepCommand : undefined,
        rootDirectory:
          typeof parsed.rootDirectory === "string" && parsed.rootDirectory !== ""
            ? normalizeDir(parsed.rootDirectory)
            : undefined,
        ...(keepLink ? { github: stored!.github } : {}),
      };
      if (input !== "keep") store.setGitCredential(projectId, input);
      store.setGitConfig(projectId, config);
      const webhookSecret = store.ensureWebhookSecret(projectId);
      const view = { ...config, credential: credentialView(store, projectId, config) };
      // The signing secret goes to a loopback caller, never to an API token.
      const hide = isTokenRequest(request);
      return writeJSON(hide ? view : { ...view, webhookSecret }, 200);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
  });

  // A new deploy key pair for the project (a key it had is replaced). The
  // answer is the public half, to add to the repository as a read-only
  // deploy key; the private half never leaves NBO.
  router.handle("POST", "/projects/{projectID}/git/deploy-key", async (_request, params) => {
    const projectId = params.projectID!;
    try {
      store.getProject(projectId);
      const pair = await generateDeployKey(projectId, keygen);
      store.setGitCredential(projectId, { kind: "deploy-key", ...pair });
      return writeJSON({ publicKey: pair.publicKey }, 201);
    } catch (err) {
      const status = statusForStoreError(err);
      return writeError(
        status,
        status === 500 ? `NBO couldn't make a deploy key: ${errorMessage(err).split(/\r?\n/)[0]}` : errorMessage(err),
      );
    }
  });

  router.handle("GET", "/projects/{projectID}/git", async (_request, params) => {
    try {
      const config = store.getGitConfig(params.projectID!);
      return writeJSON({ ...config, credential: credentialView(store, params.projectID!, config) }, 200);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
  });

  router.handle("GET", "/projects/{projectID}/builds", async (_request, params) => {
    try {
      // Without logs or captured details: a build log can be up to
      // 256 KiB; GET /builds/{id} returns one build in full.
      const withEphemeral = ephemeralInfo(store);
      return writeJSON(
        store.listBuilds(params.projectID!).map((b) => withEphemeral(withoutDetails(b))),
        200,
      );
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("GET", "/builds/{buildID}", async (_request, params) => {
    try {
      return writeJSON(ephemeralInfo(store)(store.getBuild(params.buildID!)), 200);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
  });

  // The stored (already redacted) log as plain text. follow=1 keeps the body
  // open and sends what the build appends until the build is final.
  router.handle("GET", "/builds/{buildID}/log", async (request, params) => {
    const buildId = params.buildID!;
    try {
      store.getBuild(buildId);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
    const url = new URL(request.url);
    const rawFrom = url.searchParams.get("from");
    let from = 0;
    if (rawFrom !== null) {
      from = Number(rawFrom);
      if (!Number.isInteger(from) || from < 0)
        return writeError(400, "from must be a whole number of bytes, 0 or more");
    }
    const follow = url.searchParams.get("follow") === "1";
    const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
    const read = () => {
      const b = store.getBuild(buildId);
      return { bytes: Buffer.from(b.log ?? "", "utf8"), final: b.status !== "queued" && b.status !== "running" };
    };
    if (!follow) return new Response(read().bytes.subarray(from), { status: 200, headers });
    let sent = from;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = () => {
          stop();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        if (request.signal.aborted) return onAbort();
        request.signal.addEventListener("abort", onAbort, { once: true });
        const tick = () => {
          if (stopped) return;
          try {
            const { bytes, final } = read();
            if (bytes.length > sent) {
              controller.enqueue(new Uint8Array(bytes.subarray(sent)));
              sent = bytes.length;
            }
            if (final) {
              stop();
              request.signal.removeEventListener("abort", onAbort);
              controller.close();
              return;
            }
            timer = setTimeout(tick, 500);
          } catch (err) {
            controller.error(err);
          }
        };
        tick();
      },
      cancel() {
        stop();
      },
    });
    return new Response(stream, { status: 200, headers });
  });
}

export type PushOutcome =
  | { status: "queued"; buildId: string }
  | { status: "ignored"; reason: string }
  | { status: "error"; code: number; message: string };

function outcomeResponse(o: Exclude<PushOutcome, { status: "error" }>): Response {
  return o.status === "queued"
    ? writeJSON({ status: "queued", buildId: o.buildId }, 202)
    : writeJSON({ status: "ignored", reason: o.reason }, 200);
}

// A GitHub delivery is at most 25 MiB; ours are far smaller. The cap keeps an
// unauthenticated sender from making the control-plane buffer more.
export const maxWebhookBody = 5 * 1024 * 1024;

// readCappedBody reads the request text, or null once it passes max bytes.
export async function readCappedBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function registerWebhookRoutes(router: Router, store: Store, trigger?: BuildTrigger): void {
  router.handle("POST", "/projects/{projectID}/webhooks/github", async (request, params) => {
    const projectId = params.projectID!;
    try {
      // A project with no git config has no webhook.
      store.getGitConfig(projectId);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }

    // The raw bytes are what the signature covers — request.json()
    // would consume the body through a parse step with no way to get
    // the original bytes back out.
    // Capped first: the read happens before anyone is authenticated.
    const rawBody = await readCappedBody(request, maxWebhookBody);
    if (rawBody === null) return writeError(413, "webhook body too large");
    const secret = store.ensureWebhookSecret(projectId);
    if (!verifyGithubSignature(secret, rawBody, request.headers.get("x-hub-signature-256"))) {
      return writeError(401, "invalid signature");
    }

    // Any verified delivery counts as the webhook working, whatever it is.
    try {
      store.updateProject(projectId, { lastWebhookAt: new Date().toISOString() });
    } catch {
      // a bookkeeping failure must not fail the delivery
    }

    // GitHub's own "ping" event (sent the moment a webhook is created
    // in their UI, before any push ever happens) has no ref/after at
    // all; any event other than "push" is accepted and ignored too —
    // gated on the event-type header, not the payload's own shape,
    // since that's what actually tells them apart.
    const eventType = request.headers.get("x-github-event");
    if (eventType === "ping") {
      return writeJSON({ status: "ok" }, 200);
    }
    // Pull requests drive previews, which the hosted dashboard runs (it
    // creates an ephemeral environment for one through the stages API).
    if (eventType === "pull_request") {
      return writeJSON({ status: "ignored", reason: "pull requests are handled by the hosted dashboard" }, 200);
    }
    if (eventType && eventType !== "push") {
      return writeJSON({ status: "ignored", reason: `event type "${eventType}" is not push` }, 200);
    }

    const payload = parseDelivery(request, rawBody);
    if (payload instanceof Response) return payload;
    let outcome: PushOutcome;
    try {
      outcome = await dispatchPush({ store, trigger }, projectId, payload);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
    if (outcome.status === "error") return writeError(outcome.code, outcome.message);
    return outcomeResponse(outcome);
  });
}

export interface PushDeps {
  store: Store;
  trigger?: BuildTrigger;
}

// dispatchPush is what a verified push to the project's own webhook does:
// Production's branch builds Production; a custom or ephemeral
// environment's branch builds that environment when it deploys
// automatically; any other branch is ignored. The head moves through
// advanceHead, a compare-and-set on the payload's before, for every project,
// so the webhook and the poller build one push once and a delivery replayed
// later (an older push, or the newest one again) builds nothing. A new
// branch (before all zeros) or a payload without a before only sets a head
// that is empty or older than the push. Throws only when the queue throws.
export async function dispatchPush(deps: PushDeps, projectId: string, payload: unknown): Promise<PushOutcome> {
  const { store, trigger } = deps;
  if (!isRecord(payload) || typeof payload.ref !== "string" || typeof payload.after !== "string") {
    return { status: "error", code: 400, message: "ref and after are required" };
  }
  const config = store.getGitConfig(projectId);

  // Production's branch builds Production; a custom or ephemeral
  // environment's branch builds that environment when it deploys automatically.
  const branch = payload.ref.startsWith("refs/heads/") ? payload.ref.slice("refs/heads/".length) : null;
  let stage: Stage | null = null;
  if (branch === null || branch !== config.productionBranch) {
    stage = branch === null ? null : stageForBranch(store, projectId, branch);
    if (!stage) return { status: "ignored", reason: "not the production branch" };
    if (!stage.autoDeploy) return { status: "ignored", reason: `deploying automatically is off for ${stage.name}` };
  }

  // A branch-deletion push sends after as all zeros (with
  // deleted: true) — there is no real revision to build. Anything
  // else that isn't a real 40-character sha must never reach
  // `git checkout` as a literal argument.
  if (payload.after === allZeroSha) return { status: "ignored", reason: "branch deleted" };
  if (!isRealSha(payload.after))
    return { status: "error", code: 400, message: "after must be a real 40-character git commit sha" };
  if (!trigger) return { status: "error", code: 503, message: "no build runner configured" };

  // All zeros matches no stored head, so a new branch compares against an
  // empty head (or an older one, through newer) only.
  const before = typeof payload.before === "string" && isRealSha(payload.before) ? payload.before : allZeroSha;
  const previous = stage ? stage.lastSeenSha : store.getProject(projectId).lastSeenSha;
  const previousAt = store.headSeenAt(projectId, stage?.id);
  // A compare-and-set miss still advances when this push is newer than the
  // one that set the head (a branch change, a manual build or a given-up
  // delivery left a head no later push names as its before); an older
  // delivery arriving late, or replayed, still loses.
  if (!store.advanceHead(projectId, payload.after, stage?.id, before, { at: pushedAtMs(payload), newer: true })) {
    return { status: "ignored", reason: "NBO has already seen this commit, or a newer one" };
  }
  try {
    const build = stage
      ? trigger.enqueue(projectId, payload.after, { stageId: stage.id })
      : trigger.enqueue(projectId, payload.after);
    return { status: "queued", buildId: build.id };
  } catch (err) {
    // Put the head back (only if nothing moved it since), so the retry of
    // this delivery, or the poller, builds it.
    store.advanceHead(projectId, previous, stage?.id, payload.after, { at: previousAt });
    throw err;
  }
}

// pushedAtMs: when GitHub took the push (repository.pushed_at, seconds in
// push payloads, an ISO time elsewhere), in ms; undefined when absent.
function pushedAtMs(payload: Record<string, unknown>): number | undefined {
  const repo = payload.repository;
  if (!isRecord(repo)) return undefined;
  const v = repo.pushed_at;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

// parseDelivery turns a verified delivery's raw bytes into its JSON
// payload. GitHub's webhook configuration defaults to "Content type:
// application/x-www-form-urlencoded", sending the JSON as a `payload=`
// field; the signature already covers rawBody exactly as GitHub sent it
// either way. Returns a Response (400) when it can't be read.
export function parseDelivery(request: Request, rawBody: string): unknown {
  const contentType = request.headers.get("content-type") ?? "";
  let jsonText = rawBody;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const raw = new URLSearchParams(rawBody).get("payload");
    if (!raw) return writeError(400, "missing payload field in form-encoded body");
    jsonText = raw;
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    return writeError(400, "invalid JSON payload");
  }
}
