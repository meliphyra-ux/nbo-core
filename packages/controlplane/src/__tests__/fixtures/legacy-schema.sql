-- A control-plane database made by the code before the core split (498eada),
-- with sign-in on, the GitHub App stored, an active preview and vitals rows.
-- Sealed values use the key of 32 bytes 0x42. Regenerate only if the old shape itself was wrong.
BEGIN;
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
, edge_host TEXT NOT NULL DEFAULT '', polling_enabled INTEGER NOT NULL DEFAULT 1, last_seen_sha TEXT NOT NULL DEFAULT '', setup_status TEXT NOT NULL DEFAULT 'ready', setup_error TEXT NOT NULL DEFAULT '', speed_insights INTEGER NOT NULL DEFAULT 0, speed_insights_inject INTEGER NOT NULL DEFAULT 1, speed_insights_sample INTEGER NOT NULL DEFAULT 100, last_webhook_at TEXT NOT NULL DEFAULT '', last_seen_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO "projects" (id, name, created_at, edge_host, polling_enabled, last_seen_sha, setup_status, setup_error, speed_insights, speed_insights_inject, speed_insights_sample, last_webhook_at, last_seen_at) VALUES ('proj_legacy01', 'shop', '2026-11-10T09:00:00.000Z', 'shop.nbo.example.com', 1, 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ready', '', 1, 1, 100, '2026-11-10T09:00:00.000Z', 1762765200000);
CREATE TABLE environments (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	target TEXT NOT NULL,
	config TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL, traffic_weight INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, auto_deploy INTEGER NOT NULL DEFAULT 1, deployments_after INTEGER NOT NULL DEFAULT 0, stage_id TEXT NOT NULL DEFAULT '',
	UNIQUE(project_id, name)
);
INSERT INTO "environments" (id, project_id, name, target, config, created_at, traffic_weight, archived, auto_deploy, deployments_after, stage_id) VALUES ('env_legacy01', 'proj_legacy01', 'k8s', 'kubernetes', '{"clusterId":"kc_default"}', '2026-11-10T09:00:00.000Z', 100, 0, 1, 0, 'stg_prod01');
INSERT INTO "environments" (id, project_id, name, target, config, created_at, traffic_weight, archived, auto_deploy, deployments_after, stage_id) VALUES ('env_legacy02', 'proj_legacy01', 's-pv-1a2b3c4d-k8s', 'kubernetes', '{"clusterId":"kc_default"}', '2026-11-10T09:00:00.000Z', 100, 0, 1, 0, 'stg_pv01');
CREATE TABLE deployments (
	id TEXT PRIMARY KEY,
	environment_id TEXT NOT NULL REFERENCES environments(id),
	content_id TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL,
	url TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
, build_id TEXT NOT NULL DEFAULT '');
INSERT INTO "deployments" (id, environment_id, content_id, status, url, error, created_at, build_id) VALUES ('dep_legacy01', 'env_legacy01', 'sha256:c0ffee', 'succeeded', '', '', '2026-11-10T09:00:00.000Z', 'build_legacy01');
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
INSERT INTO "project_git_config" (project_id, config) VALUES ('proj_legacy01', '{"repoUrl":"https://github.com/acme/shop.git","branch":"main","github":{"installationId":501,"repoId":9001}}');
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
, log TEXT NOT NULL DEFAULT '', deployment_ids TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0, commit_info TEXT, input TEXT, timeline TEXT, output_summary TEXT, content_id TEXT NOT NULL DEFAULT '', artifact INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'build', source_build_id TEXT NOT NULL DEFAULT '', target_environment_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', stage_id TEXT NOT NULL DEFAULT '', github_check_run_id INTEGER NOT NULL DEFAULT 0);
INSERT INTO "builds" (id, project_id, revision, status, deployment_id, error, created_at, log, deployment_ids, started_at, finished_at, manual, commit_info, input, timeline, output_summary, content_id, artifact, kind, source_build_id, target_environment_id, note, stage_id, github_check_run_id) VALUES ('build_legacy01', 'proj_legacy01', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'succeeded', '', '', '2026-11-10T09:00:00.000Z', '', '["dep_legacy01"]', '', '', 0, NULL, NULL, NULL, NULL, 'sha256:c0ffee', 1, 'build', '', '', '', 'stg_prod01', 4242);
CREATE TABLE connections (
	kind TEXT PRIMARY KEY CHECK (kind IN ('google','kubernetes')),
	config TEXT NOT NULL,
	secret TEXT NOT NULL,
	status TEXT NOT NULL,
	last_checked TEXT NOT NULL DEFAULT '',
	last_error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
INSERT INTO "connections" (kind, config, secret, status, last_checked, last_error, created_at) VALUES ('google', '{"project":"p"}', 'v1:cmSEdrXDCAw5bm3Y:53q0fSxzjo3l0fq8c7xX4g==:CCY3RKn8bkXZ/0tQpLZleaaX77sQ4EkzAet+K2RyyG/cTuY=', 'connected', '', '', '2026-11-10T09:00:00.000Z');
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
INSERT INTO "kube_connections" (id, name, config, secret, status, last_checked, last_error, created_at, lb_annotations) VALUES ('kc_default', 'default', '{}', 'v1:1QZMYYkOXbjSRUkM:Zwf5Wgpc0RC4UFlJk7p47Q==:1w3T5N+1rqKGNERSerlJROrYmtr/EODPxpu4Lyvzng==', 'connected', '', '', '2026-11-10T09:00:00.000Z', NULL);
CREATE TABLE env_vars (
	project_id TEXT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	value TEXT NOT NULL,
	secret INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	stage TEXT NOT NULL DEFAULT 'production',
	has_value INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "env_vars" (project_id, name, value, secret, updated_at, stage, has_value) VALUES ('proj_legacy01', 'API_KEY', 'v1:m34ce5D/9L5N4N2e:oAfpGDG3AmAjI3YFXsVEXg==:HWlxMicv+/L+qTaemfE=', 1, '2026-11-10T09:00:00.000Z', 'production', 1);
INSERT INTO "env_vars" (project_id, name, value, secret, updated_at, stage, has_value) VALUES (NULL, 'PUBLIC_NAME', 'Shop', 0, '2026-11-10T09:00:00.000Z', '*', 1);
CREATE TABLE platform_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
INSERT INTO "platform_settings" (key, value) VALUES ('base_domain', 'nbo.example.com');
INSERT INTO "platform_settings" (key, value) VALUES ('auth_mode', 'on');
INSERT INTO "platform_settings" (key, value) VALUES ('org_name', 'Acme');
INSERT INTO "platform_settings" (key, value) VALUES ('google_client_id', 'client.apps.example');
INSERT INTO "platform_settings" (key, value) VALUES ('github_app', '{"appId":77,"slug":"nbo-acme","owner":"acme"}');
INSERT INTO "platform_settings" (key, value) VALUES ('acme_account_key', 'v1:FkHNSj3pxhOOE2XI:Se4V3BhGnY7rfGIQTeemGw==:9FRPLjxYuEtQGPMSgWVClA==');
INSERT INTO "platform_settings" (key, value) VALUES ('edge_drain_token', 'v1:in1OjmVsEDHY6R4P:XOHCirY3z8Wdab3ao6xR7A==:q9JENP3lcxxy1Ks=');
INSERT INTO "platform_settings" (key, value) VALUES ('google_client_secret', 'v1:HfjL58LCPgK96uwz:SL5ROxaOy2qXMUSFQy6sLw==:uqys6RbSg8m8YgTJTg==');
INSERT INTO "platform_settings" (key, value) VALUES ('github_private_key', 'v1:iHOSKDYlW+/IKW+0:oquj4fq0RRRpRrNHmW7YVw==:oSPw5QAB8ZlSe5n7j4E=');
INSERT INTO "platform_settings" (key, value) VALUES ('github_client_secret', 'v1:JaIYwWUUOvYDCoXp:N/WPk29ZNQBytnb01FgirA==:C9Za/F5S9Ynjln3b3Hw7DiDOw34=');
INSERT INTO "platform_settings" (key, value) VALUES ('github_webhook_secret', 'v1:drhdfGOJ0R6i5R3q:av9fWf7VWHGY6RUVLUHyGg==:UgkIIGcPJSNUWokf9hD59ohQahEp');
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
, stage_id TEXT NOT NULL DEFAULT '');
INSERT INTO "domains" (id, project_id, host, kind, status, last_error, cert_not_after, next_attempt_at, failures, created_at, checked_at, behind_cloudflare, cert_source, warning, serving, mapping_records, mapping_kept, mapping_remove_after, stage_id) VALUES ('dom_legacy01', 'proj_legacy01', 'shop.example.org', 'custom', 'active', '', '', '', 0, '2026-11-10T09:00:00.000Z', '', 0, 'letsencrypt', '', 'edge', '', 0, '', 'stg_prod01');
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
, user_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'admin');
INSERT INTO "api_tokens" (id, name, prefix, hash, created_at, last_used_at, user_id, role) VALUES ('tok_legacy01', 'ci', 'nbo_ab12', '1111111111111111111111111111111111111111111111111111111111111111', '2026-11-10T09:00:00.000Z', '', 'usr_owner01', 'admin');
INSERT INTO "api_tokens" (id, name, prefix, hash, created_at, last_used_at, user_id, role) VALUES ('tok_legacy02', 'viewer-bot', 'nbo_cd34', '2222222222222222222222222222222222222222222222222222222222222222', '2026-11-10T09:00:00.000Z', '', 'usr_viewer01', 'viewer');
CREATE TABLE stages (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	branch TEXT NOT NULL DEFAULT '',
	auto_deploy INTEGER NOT NULL DEFAULT 1,
	host TEXT NOT NULL DEFAULT '',
	last_seen_sha TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL, last_seen_at INTEGER NOT NULL DEFAULT 0,
	UNIQUE(project_id, name)
);
INSERT INTO "stages" (id, project_id, name, kind, branch, auto_deploy, host, last_seen_sha, created_at, last_seen_at) VALUES ('stg_prod01', 'proj_legacy01', 'production', 'production', '', 1, '', '', '2026-11-10T09:00:00.000Z', 0);
INSERT INTO "stages" (id, project_id, name, kind, branch, auto_deploy, host, last_seen_sha, created_at, last_seen_at) VALUES ('stg_prev01', 'proj_legacy01', 'preview', 'preview', '', 1, '', '', '2026-11-10T09:00:00.000Z', 0);
INSERT INTO "stages" (id, project_id, name, kind, branch, auto_deploy, host, last_seen_sha, created_at, last_seen_at) VALUES ('stg_dev01', 'proj_legacy01', 'development', 'development', '', 1, '', '', '2026-11-10T09:00:00.000Z', 0);
INSERT INTO "stages" (id, project_id, name, kind, branch, auto_deploy, host, last_seen_sha, created_at, last_seen_at) VALUES ('stg_pv01', 'proj_legacy01', 'pv-1a2b3c4d', 'preview-deployment', 'feature/cart', 1, 'feature-cart--shop.nbo.example.com', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', '2026-11-10T09:00:00.000Z', 0);
CREATE TABLE preview_settings (
	project_id TEXT PRIMARY KEY,
	enabled INTEGER NOT NULL DEFAULT 0,
	branches TEXT NOT NULL DEFAULT '[]',
	without_pull_request INTEGER NOT NULL DEFAULT 1,
	expire_after_days INTEGER NOT NULL DEFAULT 7,
	delete_on_close INTEGER NOT NULL DEFAULT 1,
	max_active INTEGER NOT NULL DEFAULT 10,
	cloud TEXT NOT NULL DEFAULT ''
);
INSERT INTO "preview_settings" (project_id, enabled, branches, without_pull_request, expire_after_days, delete_on_close, max_active, cloud) VALUES ('proj_legacy01', 1, '["feature/*"]', 1, 7, 1, 10, 'env_legacy01');
CREATE TABLE previews (
	stage_id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	branch TEXT NOT NULL,
	host TEXT NOT NULL DEFAULT '',
	pr_number INTEGER NOT NULL DEFAULT 0,
	pr_state TEXT NOT NULL DEFAULT '',
	last_sha TEXT NOT NULL DEFAULT '',
	last_push_at TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'active',
	remove_reason TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT NOT NULL DEFAULT '',
	removed_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
INSERT INTO "previews" (stage_id, project_id, branch, host, pr_number, pr_state, last_sha, last_push_at, status, remove_reason, error, attempts, next_attempt_at, removed_at, created_at) VALUES ('stg_pv01', 'proj_legacy01', 'feature/cart', 'feature-cart--shop.nbo.example.com', 12, 'open', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', '2026-11-10T09:00:00.000Z', 'active', '', '', 0, '', '', '2026-11-10T09:00:00.000Z');
CREATE UNIQUE INDEX previews_active_branch ON previews (project_id, branch) WHERE status = 'active';
CREATE TABLE preview_branch_heads (
	project_id TEXT NOT NULL,
	branch TEXT NOT NULL,
	sha TEXT NOT NULL,
	PRIMARY KEY (project_id, branch)
);
INSERT INTO "preview_branch_heads" (project_id, branch, sha) VALUES ('proj_legacy01', 'feature/cart', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2');
CREATE TABLE preview_cert_orders (
	registered_domain TEXT NOT NULL,
	host TEXT NOT NULL,
	ordered_at TEXT NOT NULL
);
INSERT INTO "preview_cert_orders" (registered_domain, host, ordered_at) VALUES ('example.com', 'feature-cart--shop.nbo.example.com', '2026-11-10T09:00:00.000Z');
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	email TEXT NOT NULL DEFAULT '',
	avatar_url TEXT NOT NULL DEFAULT '',
	role TEXT NOT NULL,
	joined_via TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_sign_in_at TEXT NOT NULL
);
INSERT INTO "users" (id, name, email, avatar_url, role, joined_via, created_at, last_sign_in_at) VALUES ('usr_owner01', 'Owner', 'owner@example.com', '', 'owner', 'claim', '2026-11-10T09:00:00.000Z', '2026-11-10T09:00:00.000Z');
INSERT INTO "users" (id, name, email, avatar_url, role, joined_via, created_at, last_sign_in_at) VALUES ('usr_viewer01', 'Viewer', 'viewer@example.com', '', 'viewer', 'invite', '2026-11-10T09:00:00.000Z', '2026-11-10T09:00:00.000Z');
CREATE TABLE user_identities (
	provider TEXT NOT NULL,
	subject TEXT NOT NULL,
	user_id TEXT NOT NULL,
	login TEXT NOT NULL DEFAULT '',
	email TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	PRIMARY KEY (provider, subject)
);
INSERT INTO "user_identities" (provider, subject, user_id, login, email, created_at) VALUES ('github', '1001', 'usr_owner01', 'owner', '', '2026-11-10T09:00:00.000Z');
CREATE INDEX user_identities_user ON user_identities (user_id);
CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	user_agent TEXT NOT NULL DEFAULT ''
);
INSERT INTO "sessions" (id, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES ('3333333333333333333333333333333333333333333333333333333333333333', 'usr_owner01', '2026-11-10T09:00:00.000Z', '2026-11-10T09:00:00.000Z', '2026-12-10T09:00:00.000Z', 'Mozilla/5.0');
CREATE INDEX sessions_user ON sessions (user_id);
CREATE TABLE invites (
	id TEXT PRIMARY KEY,
	github_login TEXT NOT NULL DEFAULT '',
	email TEXT NOT NULL DEFAULT '',
	role TEXT NOT NULL,
	invited_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
INSERT INTO "invites" (id, github_login, email, role, invited_by, created_at, expires_at) VALUES ('inv_legacy01', 'newdev', '', 'developer', 'usr_owner01', '2026-11-10T09:00:00.000Z', '2026-11-17T09:00:00.000Z');
CREATE TABLE sign_in_rules (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	value TEXT NOT NULL,
	role TEXT NOT NULL
);
INSERT INTO "sign_in_rules" (id, provider, value, role) VALUES ('rule_legacy01', 'github', 'acme', 'viewer');
CREATE TABLE oauth_states (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	purpose TEXT NOT NULL,
	verifier TEXT NOT NULL,
	next TEXT NOT NULL,
	origin TEXT NOT NULL,
	user_id TEXT NOT NULL DEFAULT '',
	expires_at TEXT NOT NULL
);
INSERT INTO "oauth_states" (id, provider, purpose, verifier, next, origin, user_id, expires_at) VALUES ('4444444444444444444444444444444444444444444444444444444444444444', 'github', 'sign-in', 'verifier', '/', 'https://nbo.example.com', '', '2026-11-10T09:10:00.000Z');
CREATE TABLE sign_in_links (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
INSERT INTO "sign_in_links" (id, user_id, expires_at) VALUES ('5555555555555555555555555555555555555555555555555555555555555555', 'usr_owner01', '2026-11-10T09:15:00.000Z');
CREATE TABLE audit_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	user_id TEXT NOT NULL DEFAULT '',
	token_id TEXT NOT NULL DEFAULT '',
	method TEXT NOT NULL,
	route TEXT NOT NULL,
	params TEXT NOT NULL DEFAULT '{}',
	status INTEGER NOT NULL
);
INSERT INTO "audit_events" (id, at, user_id, token_id, method, route, params, status) VALUES (1, '2026-11-10T09:00:00.000Z', 'usr_owner01', '', 'POST', '/projects/{projectID}/builds', '{"projectID":"proj_legacy01"}', 202);
INSERT INTO "audit_events" (id, at, user_id, token_id, method, route, params, status) VALUES (2, '2026-11-10T09:00:00.000Z', '', 'tok_legacy01', 'PUT', '/traffic', '{}', 200);
CREATE INDEX audit_events_at ON audit_events (at);
CREATE TABLE github_installations (
	id INTEGER PRIMARY KEY,
	account_login TEXT NOT NULL,
	account_id INTEGER NOT NULL,
	account_type TEXT NOT NULL,
	avatar_url TEXT NOT NULL DEFAULT '',
	repository_selection TEXT NOT NULL,
	suspended INTEGER NOT NULL DEFAULT 0,
	html_url TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);
INSERT INTO "github_installations" (id, account_login, account_id, account_type, avatar_url, repository_selection, suspended, html_url, updated_at) VALUES (501, 'acme', 7001, 'Organization', '', 'selected', 0, '', '2026-11-10T09:00:00.000Z');
CREATE TABLE github_deliveries (
	guid TEXT PRIMARY KEY,
	event TEXT NOT NULL,
	action TEXT NOT NULL DEFAULT '',
	received_at TEXT NOT NULL,
	outcome TEXT NOT NULL DEFAULT ''
);
INSERT INTO "github_deliveries" (guid, event, action, received_at, outcome) VALUES ('11111111-2222-3333-4444-555555555555', 'push', '', '2026-11-10T09:00:00.000Z', 'built');
CREATE INDEX github_deliveries_received ON github_deliveries (received_at);
CREATE TABLE github_states (
	id TEXT PRIMARY KEY,
	purpose TEXT NOT NULL,
	data TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
INSERT INTO "github_states" (id, purpose, data, expires_at) VALUES ('6666666666666666666666666666666666666666666666666666666666666666', 'install', '{}', '2026-11-10T10:00:00.000Z');
CREATE TABLE stage_revalidate_tokens (
	stage_id TEXT PRIMARY KEY REFERENCES stages(id),
	token TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX env_vars_scope_stage_name ON env_vars (COALESCE(project_id, ''), stage, name);
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
INSERT INTO "vitals" (project_id, environment_id, build_id, route, metric, device, hour, histogram, count) VALUES ('proj_legacy01', 'env_legacy01', 'build_legacy01', '/', 'LCP', 'mobile', '2026-11-10T09', '[0,1,2]', 3);
CREATE INDEX vitals_project_hour ON vitals (project_id, hour);
CREATE INDEX vitals_hour ON vitals (hour);
-- Core rows added by hand in the old shape: a cron, its secret, a relay (sealed) and a finished transfer.
INSERT INTO "crons" (environment_id, cron_id, config, next_run, last_run, running) VALUES ('env_legacy01', 'nightly', '{"schedule":"0 3 * * *","path":"/api/nightly"}', '2026-11-11T03:00:00.000Z', '2026-11-10T03:00:00.000Z', 0);
INSERT INTO "environment_cron_secrets" (environment_id, secret) VALUES ('env_legacy01', 'cron-secret-legacy');
INSERT INTO "relays" (cluster_id, address, ca_pem, secret, status, created_at) VALUES ('kc_default', '203.0.113.7', 'test-ca-not-a-certificate', 'v1:JFN752J7JwlB3hJT:3vo6r0GTMeHc8IAItcd+eg==:+aPPHTs8DUcOkfg=', 'ready', '2026-11-10T09:00:00.000Z');
INSERT INTO "transfers" (id, project_id, from_env_id, to_env_id, status, weight, error, created_at) VALUES ('tr_legacy01', 'proj_legacy01', 'env_legacy01', 'env_legacy01', 'done', 100, '', '2026-11-10T10:00:00.000Z');
COMMIT;
