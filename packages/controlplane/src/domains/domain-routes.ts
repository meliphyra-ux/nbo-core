// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Routes for the public edge, platform domain settings, relays and project
// domains (spec A1, A4, A6, A7). Responses never carry a secret: relay
// tokens and keys, the drain token and pasted admin credentials stay out.
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { redact } from "@nbo/deploy";
import type { Router } from "../http/router.js";
import type { Store } from "../store/store.js";
import type { V2 } from "../v2.js";
import type { Domain } from "./domains.js";
import { normalizeDomainHost } from "./domains.js";
import { ErrConflict, ErrDuplicateName, ErrInvalid, ErrNotFound } from "../store/errors.js";
import { errorMessage, isRecord, statusForStoreError, writeError, writeJSON } from "../http/handlers.js";
import { parseKubeSource, secretsIn } from "../clouds/connection-routes.js";
import { certSecretName } from "../edge/edge-manifests.js";
import { edgeHostKey } from "../edge/edge-table.js";
import { moveDefaultHosts } from "./hosts.js";
import { domainMappingRegions } from "../clouds/regions.js";
import { moveRefusal } from "./certs.js";
import { edgeJobKey, relayJobKey } from "../edge/edge-jobs.js";
import type { ServerSettings } from "../store/server-settings.js";
import { hasOwnHost } from "../stages/stages.js";

export const needsProductionMessage = "Domains need the public edge (production mode)";
export const installEdgeFirstMessage = "Install the edge first (nbo-server edge install on the server)";
export const defaultNotRemovableMessage = "The default address can't be removed";
export const deployToCloudRunFirstMessage = "Deploy this project to Cloud Run first";
export const confirmGapMessage = "Confirm the HTTPS gap first";
export const unsupportedRegionMessage = (region: string): string =>
  `Cloud Run can't map domains in ${region}. Connect a Kubernetes cluster and install the edge, or deploy this project to a supported region.`;
const googleServesMessage = "Google serves this domain, so this setting doesn't apply";
// Google's limit on a mapped domain's length.
const mappedHostLimit = 64;
const edgeNeedsProduction = "The public edge needs production mode";
const confirmFirst = "confirm the load balancer first";
export const edgeBusyMessage = "An edge install is already running";
export const relayBusyMessage = "Enabling public entry is already running for this cluster";

export interface DnsRecord {
  type: "A" | "AAAA" | "CNAME" | "ALIAS";
  name: string;
  value: string;
  // note: extra advice the dashboard shows with the record.
  note?: string;
}

export const apexAliasNote =
  "Use an ALIAS/ANAME record (or your DNS provider's flattened CNAME); a domain's apex can't use CNAME.";

// Two-level public suffixes recognised by isApex. A rough rule, not the
// Public Suffix List: under other multi-level suffixes (e.g. com.mx) an
// apex reads as a subdomain and gets a CNAME.
const twoLevelSuffixes = new Set(["co.uk", "org.uk", "com.au", "co.jp", "com.br", "co.nz"]);

// rootDomainOf: the registrable domain a host sits under (shop.example.co.uk
// is under example.co.uk).
export function rootDomainOf(host: string): string {
  const labels = host.split(".");
  return labels.slice(twoLevelSuffixes.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

// isApex: the registrable domain itself (example.com, example.co.uk).
export const isApex = (host: string): boolean => rootDomainOf(host) === host;

// rootDomain: on Cloud Run rows, what the owner verifies with Google.
// stage: the name of the environment the host serves ("" if it is gone).
export type DomainView = Domain & { record: DnsRecord; rootDomain?: string; stage: string };

// recordFor is the DNS record a domain needs: A/AAAA to an edge IP, CNAME to
// an edge that only has a hostname (ALIAS at an apex, where DNS forbids a
// CNAME).
export function recordFor(host: string, edgeAddress: string): DnsRecord {
  const address = edgeAddress.replace(/^\[(.*)\]$/, "$1");
  const v = isIP(address);
  if (v === 6) return { type: "AAAA", name: host, value: address };
  if (v === 4 || address === "") return { type: "A", name: host, value: address };
  if (isApex(host)) return { type: "ALIAS", name: host, value: address, note: apexAliasNote };
  return { type: "CNAME", name: host, value: address };
}

async function readObject(request: Request, allowed: string[]): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    const text = await request.text();
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new ErrInvalid("the request body must be JSON");
  }
  if (!isRecord(body)) throw new ErrInvalid("the request body must be a JSON object");
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0)
    throw new ErrInvalid(
      `unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")} (allowed: ${allowed.join(", ") || "none"})`,
    );
  return body;
}

// fail maps typed errors to their status; anything else came from the
// cluster (kubectl, the registry) and is a 502. secrets are scrubbed.
function fail(err: unknown, secrets: string[] = []): Response {
  const status = statusForStoreError(err);
  return writeError(status === 500 ? 502 : status, redact(errorMessage(err), secrets.filter(Boolean)));
}

const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface DomainsPatch {
  settings: Partial<ServerSettings>;
  moveExisting: boolean;
}

function parseDomainsPatch(body: Record<string, unknown>): DomainsPatch {
  const settings: Partial<ServerSettings> = {};
  if (body.baseDomain !== undefined) {
    if (typeof body.baseDomain !== "string") throw new ErrInvalid("baseDomain must be a string");
    settings.baseDomain = body.baseDomain.trim() === "" ? "" : normalizeDomainHost(body.baseDomain);
  }
  if (body.acmeEmail !== undefined) {
    if (typeof body.acmeEmail !== "string") throw new ErrInvalid("acmeEmail must be a string");
    const email = body.acmeEmail.trim();
    if (email !== "" && (!emailShape.test(email) || email.length > 254))
      throw new ErrInvalid(`"${email}" is not an email address`);
    settings.acmeEmail = email;
  }
  if (body.acmeDirectory !== undefined) {
    if (body.acmeDirectory !== "production" && body.acmeDirectory !== "staging")
      throw new ErrInvalid('acmeDirectory must be "production" or "staging"');
    settings.acmeDirectory = body.acmeDirectory;
  }
  if (body.moveExisting !== undefined && typeof body.moveExisting !== "boolean")
    throw new ErrInvalid("moveExisting must be a boolean");
  return { settings, moveExisting: body.moveExisting === true };
}

export function registerDomainRoutes(router: Router, store: Store, v2: V2): void {
  const production = (): boolean => v2.mode === "production";
  const edgeInstalled = (): boolean => store.getServerSettings().edgeClusterId !== "";
  const stageName = (d: Domain): string => {
    try {
      return store.getStage(d.stageId).name;
    } catch {
      return "";
    }
  };
  const view = (d: Domain): DomainView => ({
    ...d,
    stage: stageName(d),
    record: recordFor(d.host, store.getServerSettings().edgeAddress),
    ...(d.serving === "cloudrun" ? { rootDomain: rootDomainOf(d.host) } : {}),
  });
  const requireCluster = (id: string): void => {
    if (!store.getKubernetesConnection(id)) throw new ErrNotFound("that Kubernetes cluster is not connected");
  };
  // cloudRunGate says whether a new domain of this project can be served by
  // Cloud Run domain mappings (no edge installed), and why not. An installed
  // edge serves new domains itself, so Cloud Run is not offered then.
  const cloudRunGate = (projectId: string): { available: boolean; reason: string; region: string } => {
    const env = store.listEnvironments(projectId).find((e) => e.target === "cloudrun");
    let region = "";
    if (env) {
      try {
        const cfg = JSON.parse(env.config) as { region?: unknown };
        if (typeof cfg.region === "string") region = cfg.region;
      } catch {
        // an unreadable config has no region
      }
    }
    const no = (reason: string) => ({ available: false, reason, region });
    if (!production()) return no(needsProductionMessage);
    if (edgeInstalled()) return no("");
    if (!env) return no(installEdgeFirstMessage);
    if (!store.listDeployments(env.id).some((d) => d.status === "succeeded")) return no(deployToCloudRunFirstMessage);
    if (!domainMappingRegions.regions.includes(region)) return no(unsupportedRegionMessage(region));
    return { available: true, reason: "", region };
  };
  // ownDomain: the project's domain, else 404 (never another project's).
  const ownDomain = (projectId: string, domainId: string): Domain => {
    store.getProject(projectId);
    const d = store.listDomains(projectId).find((x) => x.id === domainId);
    if (!d) throw new ErrNotFound(`domain "${domainId}"`);
    // An ephemeral stage's row is its own (removal deletes it): no route
    // here changes it.
    let kind = "";
    try {
      if (d.stageId !== "") kind = store.getStage(d.stageId).kind;
    } catch (err) {
      if (!(err instanceof ErrNotFound)) throw err;
    }
    if (kind === "ephemeral") throw new ErrNotFound(`domain "${domainId}"`);
    return d;
  };
  // Route table pushes after a change; a failure is healed by the poll
  // loop's reconcile, so it is logged, not returned.
  const pushTable = async (what: () => Promise<void>, label: string): Promise<void> => {
    try {
      await what();
    } catch (err) {
      console.error(`control-plane: ${label}: updating the edge route table failed: ${errorMessage(err)}`);
    }
  };

  // --- The edge (nbo-server edge ...) ---

  router.handle("GET", "/system/edge", async () => {
    try {
      const status = production()
        ? await v2.edgeInstaller.edgeStatus()
        : { installed: false, clusterId: "", address: "", ready: 0, desired: 0 };
      const job = v2.edgeJobs.latest(edgeJobKey);
      return writeJSON({ ...status, mode: v2.mode, settings: store.getServerSettings(), ...(job ? { job } : {}) }, 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Install and reinstall check their input now (400/409), then run as a
  // background job (202 { job }); GET /system/edge reports its progress.
  router.handle("POST", "/system/edge/install", async (request) => {
    let secrets: string[] = [];
    try {
      if (!production()) throw new ErrConflict(edgeNeedsProduction);
      const body = await readObject(request, ["clusterId", "admin", "confirmBilling"]);
      secrets = secretsIn(body.admin);
      if (body.confirmBilling !== true) throw new ErrInvalid(confirmFirst);
      if (typeof body.clusterId !== "string" || body.clusterId === "") throw new ErrInvalid("clusterId is required");
      const admin = parseKubeSource(body.admin, "admin");
      requireCluster(body.clusterId);
      if (v2.edgeJobs.running(edgeJobKey)) throw new ErrConflict(edgeBusyMessage);
      const req = { clusterId: body.clusterId, admin, confirmBilling: true };
      v2.edgeInstaller.validateInstall(req);
      const adminSecrets = secrets;
      const job = v2.edgeJobs.start(
        edgeJobKey,
        "install",
        edgeBusyMessage,
        (onStep) => v2.edgeInstaller.installEdge(req, { onStep }),
        () => adminSecrets,
      );
      return writeJSON({ job }, 202);
    } catch (err) {
      return fail(err, secrets);
    }
  });

  router.handle("POST", "/system/edge/reinstall", async (request) => {
    try {
      if (!production()) throw new ErrConflict(edgeNeedsProduction);
      await readObject(request, []);
      if (v2.edgeJobs.running(edgeJobKey)) throw new ErrConflict(edgeBusyMessage);
      v2.edgeInstaller.validateReinstall();
      const job = v2.edgeJobs.start(edgeJobKey, "reinstall", edgeBusyMessage, (onStep) =>
        v2.edgeInstaller.reinstallEdge({ onStep }),
      );
      return writeJSON({ job }, 202);
    } catch (err) {
      return fail(err);
    }
  });

  // Re-runs a cluster's guard and RBAC setup with admin credentials (never
  // stored); clusters connected before the edge need it (spec A1).
  router.handle("POST", "/system/clusters/{id}/update-setup", async (request, params) => {
    let secrets: string[] = [];
    try {
      requireCluster(params.id!);
      const body = await readObject(request, ["admin"]);
      secrets = secretsIn(body.admin);
      const admin = parseKubeSource(body.admin, "admin");
      return writeJSON(await v2.kubeConnect.updateSetup(params.id!, admin), 200);
    } catch (err) {
      return fail(err, secrets);
    }
  });

  // --- Relays (nbo-server cluster relay) ---

  type RelayView = {
    status: string;
    address: string;
    caFingerprint?: string;
    job?: ReturnType<typeof v2.edgeJobs.latest>;
  };
  const relayView = (clusterId: string): RelayView => {
    const relay = store.getRelay(clusterId);
    const job = v2.edgeJobs.latest(relayJobKey(clusterId));
    const withJob = (v: RelayView): RelayView => (job ? { ...v, job } : v);
    if (!relay) return withJob({ status: "none", address: "" });
    const out: RelayView = { status: relay.status, address: relay.address };
    // A rotating bundle holds the old CA first and the new one last.
    const pems = relay.caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    try {
      if (pems.length > 0) out.caFingerprint = new X509Certificate(pems[pems.length - 1]!).fingerprint256;
    } catch {
      // not a certificate: no fingerprint
    }
    return withJob(out);
  };

  router.handle("GET", "/system/clusters/{id}/relay", async (_request, params) => {
    try {
      requireCluster(params.id!);
      return writeJSON(relayView(params.id!), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Enabling a relay checks its input now (400/409, including the cluster's
  // setup version), then runs as a background job (202 { job }).
  router.handle("POST", "/system/clusters/{id}/relay", async (request, params) => {
    const clusterId = params.id!;
    const relaySecrets = (): string[] => {
      const relay = store.getRelay(clusterId);
      return relay ? [relay.token, relay.keyPem, relay.caKeyPem] : [];
    };
    try {
      if (!production()) throw new ErrConflict(edgeNeedsProduction);
      requireCluster(clusterId);
      const body = await readObject(request, ["confirmBilling"]);
      if (body.confirmBilling !== true) throw new ErrInvalid(confirmFirst);
      const key = relayJobKey(clusterId);
      if (v2.edgeJobs.running(key)) throw new ErrConflict(relayBusyMessage);
      const req = { clusterId, confirmBilling: true };
      await v2.edgeInstaller.validateRelay(req);
      const job = v2.edgeJobs.start(
        key,
        "relay",
        relayBusyMessage,
        (onStep) => v2.edgeInstaller.enableRelay(req, { onStep }),
        relaySecrets,
      );
      return writeJSON({ job }, 202);
    } catch (err) {
      return fail(err, relaySecrets());
    }
  });

  // --- Platform domain settings (base domain, Let's Encrypt) ---

  router.handle("PATCH", "/system/domains", async (request) => {
    try {
      const body = await readObject(request, ["baseDomain", "acmeEmail", "acmeDirectory", "moveExisting"]);
      const patch = parseDomainsPatch(body);
      const previous = store.getServerSettings();
      const settings = store.updateServerSettings(patch.settings);
      let moves: { moved: unknown[]; skipped: unknown[] } = { moved: [], skipped: [] };
      // Placeholder projects always move to the new default host; with
      // moveExisting every project does, keeping its old host (spec A7).
      if (
        patch.settings.baseDomain !== undefined &&
        (patch.settings.baseDomain !== previous.baseDomain || patch.moveExisting)
      ) {
        moves = moveDefaultHosts(store, previous, v2.mode, { everyProject: patch.moveExisting });
        if (moves.moved.length > 0) await pushTable(() => v2.edgeSync.reconcile(), "base domain change");
      }
      return writeJSON({ mode: v2.mode, settings, ...moves }, 200);
    } catch (err) {
      return fail(err);
    }
  });

  // --- Project domains ---

  router.handle("GET", "/projects/{projectID}/domains", async (_request, params) => {
    try {
      store.getProject(params.projectID!);
      const cloudRun = { ...cloudRunGate(params.projectID!), account: store.getGoogleConnection()?.deployer ?? "" };
      // Ephemeral stages' rows are theirs alone and aren't listed here.
      const ephemeral = new Set(
        store
          .listStages(params.projectID!, { includeEphemeral: true })
          .filter((s) => s.kind === "ephemeral")
          .map((s) => s.id),
      );
      const domains = store.listDomains(params.projectID!).filter((d) => !ephemeral.has(d.stageId));
      return writeJSON(
        { domains: domains.map(view), edgeAddress: store.getServerSettings().edgeAddress, cloudRun },
        200,
      );
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/domains", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const project = store.getProject(projectId);
      if (!production()) throw new ErrConflict(needsProductionMessage);
      const body = await readObject(request, ["host", "stage"]);
      // stage: the environment the domain serves, Production by default. Only
      // Production and custom environments have sites.
      if (body.stage !== undefined && typeof body.stage !== "string")
        throw new ErrInvalid("stage must be an environment name");
      const stage = store.getStageByName(projectId, (body.stage as string | undefined) ?? "production");
      if (stage.kind !== "production" && stage.kind !== "custom")
        throw new ErrInvalid(`the ${stage.name} environment has no address, so it can't have domains`);
      // With no edge, Cloud Run can serve a Production domain through a
      // domain mapping; other environments' domains need the edge.
      const viaCloudRun = !edgeInstalled();
      if (viaCloudRun && stage.kind !== "production") throw new ErrConflict(installEdgeFirstMessage);
      if (viaCloudRun) {
        const gate = cloudRunGate(projectId);
        if (!gate.available) throw new ErrConflict(gate.reason);
      }
      if (typeof body.host !== "string") throw new ErrInvalid("host is required");
      const host = normalizeDomainHost(body.host);
      if (viaCloudRun && host.length > mappedHostLimit)
        throw new ErrInvalid(
          `"${host}" is longer than ${mappedHostLimit} characters, the longest domain Google can map`,
        );
      // A host some project routes on without a domain row (a placeholder
      // or a default host recorded before rows existed) is taken too.
      const routed = store.listProjects().flatMap((p) => [
        p.edgeHost,
        ...store
          .listStages(p.id, { includeEphemeral: true })
          .filter(hasOwnHost)
          .map((s) => s.host),
      ]);
      if (routed.some((h) => h !== "" && edgeHostKey(h) === host))
        throw new ErrDuplicateName(`the domain "${host}" is already in use`);
      if (viaCloudRun) {
        const row = store.addDomain(projectId, host, "custom", "cloudrun");
        // The first attempt runs now; the domain loop records a failure on
        // the row and retries later.
        let current = row;
        try {
          current = await v2.domains.checkNow(row.id);
        } catch (err) {
          console.error(`control-plane: first attempt for ${host}: ${errorMessage(err)}`);
          current = store.getDomain(row.id);
        }
        return writeJSON(view(current), 201);
      }
      const domain = store.addDomain(projectId, host, "custom", "edge", stage.id);
      // Routed over HTTP right away; the domain loop moves it on to its
      // certificate once DNS points at the edge.
      await pushTable(() => v2.edgeSync.push(projectId), `project ${project.name}: domain ${host}`);
      return writeJSON(view(domain), 201);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("DELETE", "/projects/{projectID}/domains/{domainID}", async (_request, params) => {
    const projectId = params.projectID!;
    try {
      const domain = ownDomain(projectId, params.domainID!);
      if (domain.kind === "default") throw new ErrConflict(defaultNotRemovableMessage);
      // In the loop's queue: Google's mapping goes first, and if that fails
      // the row stays visible.
      await v2.domains.removeMapped(domain.id);
      if (domain.serving === "cloudrun" && !edgeInstalled()) return new Response(null, { status: 204 });
      await pushTable(() => v2.edgeSync.push(projectId), `domain ${domain.host} removed`);
      try {
        await v2.certs.deleteCert(certSecretName(domain.host));
      } catch (err) {
        console.error(
          `control-plane: domain ${domain.host} removed, but deleting its certificate Secret failed: ${errorMessage(err)}`,
        );
      }
      return new Response(null, { status: 204 });
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/domains/{domainID}/check", async (_request, params) => {
    try {
      const domain = ownDomain(params.projectID!, params.domainID!);
      return writeJSON(view(await v2.domains.checkNow(domain.id)), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Hands a domain Google serves over to the edge. The mapping stays until
  // the edge row is active, so the site keeps answering until DNS changes.
  router.handle("POST", "/projects/{projectID}/domains/{domainID}/move-to-edge", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const domain = ownDomain(projectId, params.domainID!);
      const body = await readObject(request, ["confirmGap"]);
      if (body.confirmGap !== true) throw new ErrInvalid(confirmGapMessage);
      if (!production() || !edgeInstalled()) throw new ErrConflict(installEdgeFirstMessage);
      if (domain.serving !== "cloudrun") throw new ErrConflict("This domain is already served by the edge");
      // Answered now, not after waiting in the loop's queue.
      const refusal = moveRefusal(store);
      if (refusal) throw new ErrConflict(refusal);
      const moved = await v2.domains.moveToEdge(domain.id);
      await pushTable(() => v2.edgeSync.push(projectId), `domain ${domain.host} moved to the edge`);
      return writeJSON(view(moved), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Behind Cloudflare: the domain's record is proxied by Cloudflare, so
  // the edge trusts its address ranges (spec). Old edges answer 409.
  router.handle("PATCH", "/projects/{projectID}/domains/{domainID}", async (request, params) => {
    try {
      const domain = ownDomain(params.projectID!, params.domainID!);
      if (domain.serving === "cloudrun") throw new ErrConflict(googleServesMessage);
      const body = await readObject(request, ["behindCloudflare"]);
      if (typeof body.behindCloudflare !== "boolean") throw new ErrInvalid("behindCloudflare must be true or false");
      return writeJSON(view(await v2.domains.setBehindCloudflare(domain.id, body.behindCloudflare)), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // A pasted (Cloudflare Origin CA) certificate. The key is read, checked and
  // written to the cluster; no answer or stored error carries it.
  router.handle("PUT", "/projects/{projectID}/domains/{domainID}/certificate", async (request, params) => {
    let keyPem = "";
    try {
      const domain = ownDomain(params.projectID!, params.domainID!);
      if (domain.serving === "cloudrun") throw new ErrConflict(googleServesMessage);
      const body = await readObject(request, ["certPem", "keyPem"]);
      if (typeof body.keyPem === "string") keyPem = body.keyPem;
      if (typeof body.certPem !== "string" || typeof body.keyPem !== "string")
        throw new ErrInvalid("certPem and keyPem are required");
      return writeJSON(view(await v2.domains.pasteCert(domain.id, body.certPem, body.keyPem)), 200);
    } catch (err) {
      return fail(err, [keyPem]);
    }
  });

  router.handle("DELETE", "/projects/{projectID}/domains/{domainID}/certificate", async (_request, params) => {
    try {
      const domain = ownDomain(params.projectID!, params.domainID!);
      if (domain.serving === "cloudrun") throw new ErrConflict(googleServesMessage);
      return writeJSON(view(await v2.domains.removePastedCert(domain.id)), 200);
    } catch (err) {
      return fail(err);
    }
  });
}
