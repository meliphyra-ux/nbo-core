// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { isIP } from "node:net";
import type { Mode } from "../mode.js";
import type { ServerSettings } from "../store/server-settings.js";
import type { Project, Store } from "../store/store.js";
import { hasOwnHost, type Stage } from "../stages/stages.js";

// The host every project gets before the platform has a public edge (and
// always in dev mode, where the local edge listens on 127.0.0.1).
export const placeholderSuffix = ".127.0.0.1.sslip.io";

// defaultHostFor is a project's default host (spec A5): the base domain when
// one is set, else the edge's IP dashed into sslip.io. An edge that only has
// a hostname (some providers' load balancers) cannot be dashed into sslip.io,
// so the project keeps the placeholder until a base domain is set.
export function defaultHostFor(
  name: string,
  settings: ServerSettings,
  mode: Mode,
): { host: string; needsBaseDomain?: true } {
  const placeholder = { host: `${name}${placeholderSuffix}` };
  if (mode === "dev" || settings.edgeAddress === "") return placeholder;
  if (settings.baseDomain !== "") return { host: `${name}.${settings.baseDomain}` };
  const address = settings.edgeAddress.replace(/^\[(.*)\]$/, "$1");
  if (isIP(address) !== 0) return { host: `${name}.${address.replace(/[.:]/g, "-")}.sslip.io` };
  return { ...placeholder, needsBaseDomain: true };
}

export interface HostMoveOptions {
  // previousDefault: also move projects on the previous settings' default
  // host (the edge's address changed, so that host points nowhere now).
  previousDefault?: boolean;
  // everyProject: move every project (spec A7 "Move existing projects");
  // a project's old host, unless a placeholder, stays as a custom domain.
  everyProject?: boolean;
}

export interface HostMoves {
  // stage: set when the host is a custom environment's (stages.ts), not
  // the project's own.
  moved: { projectId: string; stage?: string; from: string; to: string }[];
  // skipped: projects (or environments) whose new default host is already in use.
  skipped: { projectId: string; stage?: string; host: string }[];
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// stageHostLabel is the name a custom environment's default host is made
// from, like a project's name: staging--shop.apps.example.com.
export function stageHostLabel(stage: Pick<Stage, "name">, project: Pick<Project, "name">): string {
  return `${stage.name}--${project.name}`;
}

// A default host that may move: a project's (Production's) or a custom
// stage's. stageId owns its domain rows.
interface Holder {
  projectId: string;
  projectName: string;
  stage?: Stage;
  stageId: string;
  label: string;
  host: string;
}

function holders(store: Store, projects: Project[]): Holder[] {
  const out: Holder[] = [];
  for (const p of projects) {
    const stages = store.listStages(p.id, { includeEphemeral: true });
    const production = stages.find((s) => s.kind === "production");
    if (p.edgeHost)
      out.push({
        projectId: p.id,
        projectName: p.name,
        stageId: production?.id ?? "",
        label: p.name,
        host: p.edgeHost,
      });
    for (const s of stages) {
      if (!hasOwnHost(s)) continue;
      // An ephemeral stage's label is its host's first DNS label (<hostLabel>--<project>), not its pv- name.
      const label = s.kind === "ephemeral" ? s.host.split(".")[0]! : stageHostLabel(s, p);
      out.push({ projectId: p.id, projectName: p.name, stage: s, stageId: s.id, label, host: s.host });
    }
  }
  return out;
}

const withStage = (h: Holder): { stage?: string } => (h.stage ? { stage: h.stage.name } : {});
const describe = (h: Holder): string =>
  h.stage ? `project ${h.projectName}'s ${h.stage.name} environment` : `project ${h.projectName}`;

// moveDefaultHosts moves projects, and their custom environments, to their
// default host under the current settings, with its default domain row.
// Hosts still on a placeholder always move; options add the others. A host
// that would itself be a placeholder is left alone. Every target is checked
// against every domain, every project's and environment's host and every
// other move before anything changes: a colliding one stays on its old host
// (logged, reported) and the rest move. The caller pushes the route table
// afterwards.
export function moveDefaultHosts(
  store: Store,
  previous: ServerSettings,
  mode: Mode,
  opts: HostMoveOptions = {},
): HostMoves {
  const settings = store.getServerSettings();
  const all = holders(store, store.listProjects());
  const domains = store.listDomains();
  const claimed = new Set<string>();
  const out: HostMoves = { moved: [], skipped: [] };
  const moves: { holder: Holder; from: string; host: string; keepOld: boolean }[] = [];
  for (const h of all) {
    const onPlaceholder = h.host.endsWith(placeholderSuffix);
    const old = defaultHostFor(h.label, previous, mode);
    const onPreviousDefault = !old.needsBaseDomain && h.host === old.host;
    if (!onPlaceholder && !(opts.previousDefault && onPreviousDefault) && !opts.everyProject) continue;
    const next = defaultHostFor(h.label, settings, mode);
    if (next.needsBaseDomain || next.host.endsWith(placeholderSuffix) || next.host === h.host) continue;
    // A host Google serves can't be a default host, even the project's own:
    // the edge would never route it. Nor can another stage's domain.
    const taken =
      claimed.has(next.host) ||
      domains.some(
        (d) =>
          d.host === next.host && (d.projectId !== h.projectId || d.stageId !== h.stageId || d.serving === "cloudrun"),
      ) ||
      all.some((o) => o !== h && o.host === next.host);
    if (taken) {
      console.error(
        `control-plane: ${describe(h)} stays on ${h.host}: its new default host ${next.host} is already in use`,
      );
      out.skipped.push({ projectId: h.projectId, ...withStage(h), host: next.host });
      continue;
    }
    claimed.add(next.host);
    // The address changed (previousDefault) leaves the old host dead;
    // otherwise a real old host keeps working as a custom domain.
    const keepOld = !onPlaceholder && !(opts.previousDefault && onPreviousDefault);
    moves.push({ holder: h, from: h.host, host: next.host, keepOld });
  }
  // Per host: the new row first, so a failure leaves the old state. Only
  // the holder's own stage's rows are touched.
  for (const m of moves) {
    const h = m.holder;
    const own = store.listDomains(h.projectId).filter((d) => d.stageId === h.stageId);
    const stageId = h.stageId || undefined;
    const existing = own.find((d) => d.host === m.host);
    try {
      if (!existing) store.addDomain(h.projectId, m.host, "default", "edge", stageId);
      else if (existing.kind !== "default") store.updateDomain(existing.id, { kind: "default" });
    } catch (err) {
      console.error(`control-plane: ${describe(h)} stays on its old host: recording ${m.host} failed: ${errText(err)}`);
      out.skipped.push({ projectId: h.projectId, ...withStage(h), host: m.host });
      continue;
    }
    if (h.stage) store.updateStage(h.stage.id, { host: m.host });
    else store.updateProject(h.projectId, { edgeHost: m.host });
    let keptOld = false;
    for (const d of own) {
      if (d.host === m.host || d.kind !== "default") continue;
      if (m.keepOld && d.host === m.from) {
        store.updateDomain(d.id, { kind: "custom" });
        keptOld = true;
      } else {
        store.deleteDomain(d.id);
      }
    }
    if (m.keepOld && !keptOld && !own.some((d) => d.host === m.from)) {
      try {
        store.addDomain(h.projectId, m.from, "custom", "edge", stageId);
      } catch (err) {
        console.error(`control-plane: ${describe(h)}: keeping ${m.from} as a custom domain failed: ${errText(err)}`);
      }
    }
    out.moved.push({ projectId: h.projectId, ...withStage(h), from: m.from, to: m.host });
  }
  return out;
}
