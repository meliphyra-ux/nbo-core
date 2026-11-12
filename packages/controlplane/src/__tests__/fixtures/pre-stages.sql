-- A control-plane database made by the code before stages (HEAD 10137af).
-- Regenerate only if the old shape itself was wrong.
BEGIN;
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
, edge_host TEXT NOT NULL DEFAULT '', polling_enabled INTEGER NOT NULL DEFAULT 1, last_seen_sha TEXT NOT NULL DEFAULT '', setup_status TEXT NOT NULL DEFAULT 'ready', setup_error TEXT NOT NULL DEFAULT '', speed_insights INTEGER NOT NULL DEFAULT 0, speed_insights_inject INTEGER NOT NULL DEFAULT 1, speed_insights_sample INTEGER NOT NULL DEFAULT 100);
INSERT INTO "projects" (id, name, created_at, edge_host, polling_enabled, last_seen_sha, setup_status, setup_error, speed_insights, speed_insights_inject, speed_insights_sample) VALUES ('proj_88e4ac33bff00c55', 'shop', '2026-11-08T01:49:05.549Z', 'shop.127.0.0.1.sslip.io', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ready', '', 0, 1, 100);
INSERT INTO "projects" (id, name, created_at, edge_host, polling_enabled, last_seen_sha, setup_status, setup_error, speed_insights, speed_insights_inject, speed_insights_sample) VALUES ('proj_c978157068b953f0', 'blog', '2026-11-08T01:49:05.666Z', 'blog.127.0.0.1.sslip.io', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ready', '', 0, 1, 100);
CREATE TABLE environments (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	target TEXT NOT NULL,
	config TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL, traffic_weight INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, auto_deploy INTEGER NOT NULL DEFAULT 1, deployments_after INTEGER NOT NULL DEFAULT 0,
	UNIQUE(project_id, name)
);
INSERT INTO "environments" (id, project_id, name, target, config, created_at, traffic_weight, archived, auto_deploy, deployments_after) VALUES ('env_523ce630bc4d9d71', 'proj_88e4ac33bff00c55', 'k8s', 'kubernetes', '{"clusterId":"kc_default"}', '2026-11-08T01:49:05.570Z', 70, 0, 1, 0);
INSERT INTO "environments" (id, project_id, name, target, config, created_at, traffic_weight, archived, auto_deploy, deployments_after) VALUES ('env_d28660f9dfc1e8ec', 'proj_88e4ac33bff00c55', 'cloudrun', 'cloudrun', '{"project":"p1","region":"us-east1"}', '2026-11-08T01:49:05.577Z', 30, 0, 1, 0);
INSERT INTO "environments" (id, project_id, name, target, config, created_at, traffic_weight, archived, auto_deploy, deployments_after) VALUES ('env_07cb2d0c3e124a74', 'proj_88e4ac33bff00c55', 'k8s-old', 'kubernetes', '{"clusterId":"kc_old"}', '2026-11-08T01:49:05.583Z', 0, 1, 1, 0);
INSERT INTO "environments" (id, project_id, name, target, config, created_at, traffic_weight, archived, auto_deploy, deployments_after) VALUES ('env_03db56b39fcfe4bf', 'proj_c978157068b953f0', 'k8s', 'kubernetes', '{}', '2026-11-08T01:49:05.686Z', 0, 0, 1, 0);
CREATE TABLE deployments (
	id TEXT PRIMARY KEY,
	environment_id TEXT NOT NULL REFERENCES environments(id),
	content_id TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL,
	url TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
, build_id TEXT NOT NULL DEFAULT '');
INSERT INTO "deployments" (id, environment_id, content_id, status, url, error, created_at, build_id) VALUES ('dep_4eaf9eaee3f9884c', 'env_523ce630bc4d9d71', 'sha256:abc', 'succeeded', 'https://k8s.example', '', '2026-11-08T01:49:05.609Z', 'build_025161df2e5e6c7d');
INSERT INTO "deployments" (id, environment_id, content_id, status, url, error, created_at, build_id) VALUES ('dep_e4bf51f78340a089', 'env_d28660f9dfc1e8ec', 'sha256:abc', 'succeeded', 'https://cloudrun.example', '', '2026-11-08T01:49:05.621Z', 'build_025161df2e5e6c7d');
CREATE TABLE crons (
	environment_id TEXT NOT NULL REFERENCES environments(id),
	cron_id TEXT NOT NULL,
	config TEXT NOT NULL,
	next_run TEXT NOT NULL,
	last_run TEXT NOT NULL DEFAULT '',
	running INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (environment_id, cron_id)
);
CREATE TABLE environment_cron_secrets (
	environment_id TEXT PRIMARY KEY REFERENCES environments(id),
	secret TEXT NOT NULL
);
CREATE TABLE project_git_config (
	project_id TEXT PRIMARY KEY REFERENCES projects(id),
	config TEXT NOT NULL
);
INSERT INTO "project_git_config" (project_id, config) VALUES ('proj_88e4ac33bff00c55', '{"repo":"https://github.com/acme/shop.git","productionBranch":"main","framework":"static","buildCommand":"npm run build","outputDir":"dist"}');
INSERT INTO "project_git_config" (project_id, config) VALUES ('proj_c978157068b953f0', '{"repo":"https://github.com/acme/blog.git","productionBranch":"main","framework":"static","buildCommand":"npm run build","outputDir":"dist"}');
CREATE TABLE project_webhook_secrets (
	project_id TEXT PRIMARY KEY REFERENCES projects(id),
	secret TEXT NOT NULL
);
CREATE TABLE builds (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	revision TEXT NOT NULL,
	status TEXT NOT NULL,
	deployment_id TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
, log TEXT NOT NULL DEFAULT '', deployment_ids TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0, commit_info TEXT, input TEXT, timeline TEXT, output_summary TEXT, content_id TEXT NOT NULL DEFAULT '', artifact INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'build', source_build_id TEXT NOT NULL DEFAULT '', target_environment_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '');
INSERT INTO "builds" (id, project_id, revision, status, deployment_id, error, created_at, log, deployment_ids, started_at, finished_at, manual, commit_info, input, timeline, output_summary, content_id, artifact, kind, source_build_id, target_environment_id, note) VALUES ('build_025161df2e5e6c7d', 'proj_88e4ac33bff00c55', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'succeeded', '', '', '2026-11-08T01:49:05.596Z', '', '[]', '2026-11-08T01:49:05.596Z', '2026-11-08T01:49:05.602Z', 0, NULL, NULL, NULL, NULL, '', 0, 'build', '', '', '');
CREATE TABLE connections (
	kind TEXT PRIMARY KEY CHECK (kind IN ('google','kubernetes')),
	config TEXT NOT NULL,
	secret TEXT NOT NULL,
	status TEXT NOT NULL,
	last_checked TEXT NOT NULL DEFAULT '',
	last_error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE TABLE kube_connections (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	config TEXT NOT NULL,
	secret TEXT NOT NULL,
	status TEXT NOT NULL,
	last_checked TEXT NOT NULL DEFAULT '',
	last_error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
, lb_annotations TEXT);
CREATE TABLE env_vars (
	project_id TEXT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	value TEXT NOT NULL,
	secret INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);
INSERT INTO "env_vars" (project_id, name, value, secret, updated_at) VALUES (NULL, 'API_URL', 'https://api.example', 0, '2026-11-08T01:49:05.647Z');
INSERT INTO "env_vars" (project_id, name, value, secret, updated_at) VALUES ('proj_88e4ac33bff00c55', 'API_URL', 'https://shop-api.example', 0, '2026-11-08T01:49:05.653Z');
CREATE TABLE platform_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE domain_pending_certs (
	domain_id TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE domain_pasted_certs (
	domain_id TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE domains (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	host TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL,
	status TEXT NOT NULL,
	last_error TEXT NOT NULL DEFAULT '',
	cert_not_after TEXT NOT NULL DEFAULT '',
	next_attempt_at TEXT NOT NULL DEFAULT '',
	failures INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	checked_at TEXT NOT NULL DEFAULT '',
	behind_cloudflare INTEGER NOT NULL DEFAULT 0,
	cert_source TEXT NOT NULL DEFAULT 'letsencrypt',
	warning TEXT NOT NULL DEFAULT '',
	serving TEXT NOT NULL DEFAULT 'edge',
	mapping_records TEXT NOT NULL DEFAULT '',
	mapping_kept INTEGER NOT NULL DEFAULT 0,
	mapping_remove_after TEXT NOT NULL DEFAULT ''
);
INSERT INTO "domains" (id, project_id, host, kind, status, last_error, cert_not_after, next_attempt_at, failures, created_at, checked_at, behind_cloudflare, cert_source, warning, serving, mapping_records, mapping_kept, mapping_remove_after) VALUES ('dom_ed3fe46f317095a1', 'proj_88e4ac33bff00c55', 'shop.127.0.0.1.sslip.io', 'default', 'dns_pending', '', '', '', 0, '2026-11-08T01:49:05.660Z', '', 0, 'letsencrypt', '', 'edge', '', 0, '');
CREATE TABLE relays (
	cluster_id TEXT PRIMARY KEY,
	address TEXT NOT NULL DEFAULT '',
	ca_pem TEXT NOT NULL,
	secret TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE api_tokens (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	prefix TEXT NOT NULL,
	hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE transfers (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	from_env_id TEXT NOT NULL,
	to_env_id TEXT NOT NULL,
	status TEXT NOT NULL,
	weight INTEGER NOT NULL DEFAULT 0,
	error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE TABLE vitals (
	project_id TEXT NOT NULL,
	environment_id TEXT NOT NULL,
	build_id TEXT NOT NULL,
	route TEXT NOT NULL,
	metric TEXT NOT NULL,
	device TEXT NOT NULL,
	hour TEXT NOT NULL,
	histogram TEXT NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (project_id, environment_id, build_id, route, metric, device, hour)
);
CREATE UNIQUE INDEX env_vars_scope_name ON env_vars (COALESCE(project_id, ''), name);
CREATE INDEX vitals_project_hour ON vitals (project_id, hour);
CREATE INDEX vitals_hour ON vitals (hour);
COMMIT;
