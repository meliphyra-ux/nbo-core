// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Ids, the base schema, name rules and the row shapes of projects, environments, deployments and transfers.
import { randomBytes } from "node:crypto";
import type { Deployment, Environment, Project, SetupStatus, Transfer, TransferStatus } from "./store-types.js";

export const baseSchema = `
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS environments (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	target TEXT NOT NULL,
	config TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS deployments (
	id TEXT PRIMARY KEY,
	environment_id TEXT NOT NULL REFERENCES environments(id),
	content_id TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL,
	url TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
`;

// newID returns a short, opaque, collision-resistant id for a new row.
export function newID(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function nowUTC(): string {
  return new Date().toISOString();
}

// validEnvironmentName matches a conservative DNS-1123-label-shaped
// name, capped well under Kubernetes' 63-char label limit (and Cloud
// Run's matching service-name limit) to leave room for a
// "<projectSuffix>-" prefix and a "-fn-<function>" suffix once this
// name is combined into an actual deploy target name
// (@nbo/controlplane's own deployAppName). On Kubernetes a combined
// name still over 63 is shortened with a hash (@nbo/adapter-k8s
// kubeName); "<app>-fn-" itself always fits within the 54 characters
// kubeName keeps, so a function's name still starts with it.
export const validEnvironmentName = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;

export const validTargets: Record<string, boolean> = { kubernetes: true, cloudrun: true };

// node:sqlite has no error codes, so a unique violation is recognised by its message.
export function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

export const projectColumns =
  "id, name, created_at, edge_host, polling_enabled, last_seen_sha, setup_status, setup_error, speed_insights, speed_insights_inject, speed_insights_sample, last_webhook_at, skip_first_build, key_wait_since";
export type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  edge_host: string;
  polling_enabled: number;
  last_seen_sha: string;
  setup_status: string;
  setup_error: string;
  speed_insights: number;
  speed_insights_inject: number;
  speed_insights_sample: number;
  last_webhook_at: string;
  skip_first_build: number;
  key_wait_since: string;
};
export function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    edgeHost: r.edge_host,
    pollingEnabled: r.polling_enabled === 1,
    lastSeenSha: r.last_seen_sha,
    setupStatus: r.setup_status as SetupStatus,
    setupError: r.setup_error,
    speedInsights: r.speed_insights === 1,
    speedInsightsInject: r.speed_insights_inject === 1,
    speedInsightsSampleRate: r.speed_insights_sample,
    lastWebhookAt: r.last_webhook_at,
    skipFirstBuild: r.skip_first_build === 1,
    keyWaitSince: r.key_wait_since,
  };
}

export const environmentColumns =
  "id, project_id, name, target, config, created_at, traffic_weight, archived, auto_deploy, stage_id";
export type EnvironmentRow = {
  stage_id: string;
  id: string;
  project_id: string;
  name: string;
  target: string;
  config: string;
  created_at: string;
  traffic_weight: number;
  archived: number;
  auto_deploy: number;
};
export function rowToEnvironment(r: EnvironmentRow): Environment {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    target: r.target,
    config: r.config,
    createdAt: r.created_at,
    trafficWeight: r.traffic_weight,
    archived: r.archived === 1,
    autoDeploy: r.auto_deploy === 1,
    stageId: r.stage_id,
  };
}

export const deploymentColumns = "id, environment_id, content_id, status, url, error, created_at, build_id";
export type DeploymentRow = {
  id: string;
  environment_id: string;
  content_id: string;
  status: string;
  url: string;
  error: string;
  created_at: string;
  build_id: string;
};
export function rowToDeployment(r: DeploymentRow): Deployment {
  return {
    id: r.id,
    environmentId: r.environment_id,
    contentId: r.content_id,
    status: r.status,
    url: r.url,
    error: r.error,
    createdAt: r.created_at,
    buildId: r.build_id,
  };
}

export const transferColumns = "id, project_id, from_env_id, to_env_id, status, weight, error, created_at";
export type TransferRow = {
  id: string;
  project_id: string;
  from_env_id: string;
  to_env_id: string;
  status: string;
  weight: number;
  error: string;
  created_at: string;
};
export function rowToTransfer(r: TransferRow): Transfer {
  return {
    id: r.id,
    projectId: r.project_id,
    fromEnvId: r.from_env_id,
    toEnvId: r.to_env_id,
    status: r.status as TransferStatus,
    weight: r.weight,
    error: r.error,
    createdAt: r.created_at,
  };
}
