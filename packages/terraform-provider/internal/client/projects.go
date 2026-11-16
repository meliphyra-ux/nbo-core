// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"net/http"
	"net/url"
)

// Cloud is one entry of a setup request's clouds (setup.ts parseCloudChoice).
type Cloud struct {
	Target    string `json:"target"`
	ClusterID string `json:"clusterId,omitempty"`
	Mode      string `json:"mode,omitempty"`
	Region    string `json:"region,omitempty"`
	Project   string `json:"project,omitempty"`
	ArRepo    string `json:"arRepo,omitempty"`
}

// SetupRequest is the body of POST /projects/setup (setup.ts parseSetupRequest).
type SetupRequest struct {
	Name                    string      `json:"name"`
	Repo                    string      `json:"repo"`
	ProductionBranch        string      `json:"productionBranch"`
	Framework               string      `json:"framework"`
	Spa                     bool        `json:"spa"`
	BuildCommand            string      `json:"buildCommand"`
	OutputDir               string      `json:"outputDir,omitempty"`
	IgnoredBuildStepCommand string      `json:"ignoredBuildStepCommand,omitempty"`
	RootDirectory           string      `json:"rootDirectory,omitempty"`
	Clouds                  []Cloud     `json:"clouds"`
	SkipFirstBuild          bool        `json:"skipFirstBuild,omitempty"`
	Credential              *Credential `json:"credential,omitempty"`
}

// Credential is how NBO reaches a repository (git-credentials.ts parseCredential):
// kind "public", "token" (with a token and optionally a user name) or "deploy-key".
// It is only ever sent; NBO never answers with a token.
type Credential struct {
	Kind     string `json:"kind"`
	Token    string `json:"token,omitempty"`
	Username string `json:"username,omitempty"`
}

// CredentialView is what GET /projects/{id}/git says of the credential: the kind,
// a deploy key's public half, a token's user name.
type CredentialView struct {
	Kind      string `json:"kind"`
	PublicKey string `json:"publicKey"`
	Username  string `json:"username"`
}

// ProjectSettings is the body of PATCH /projects/{id}/settings: only what is
// set is sent.
type ProjectSettings struct {
	PollingEnabled          *bool  `json:"pollingEnabled,omitempty"`
	SpeedInsights           *bool  `json:"speedInsights,omitempty"`
	SpeedInsightsInject     *bool  `json:"speedInsightsInject,omitempty"`
	SpeedInsightsSampleRate *int64 `json:"speedInsightsSampleRate,omitempty"`
}

// Empty reports whether the patch changes nothing.
func (s ProjectSettings) Empty() bool {
	return s == ProjectSettings{}
}

// Project is the project object inside a summary.
type Project struct {
	ID                      string `json:"id"`
	Name                    string `json:"name"`
	EdgeHost                string `json:"edgeHost"`
	PollingEnabled          bool   `json:"pollingEnabled"`
	SetupStatus             string `json:"setupStatus"`
	SetupError              string `json:"setupError"`
	SpeedInsights           bool   `json:"speedInsights"`
	SpeedInsightsInject     bool   `json:"speedInsightsInject"`
	SpeedInsightsSampleRate int64  `json:"speedInsightsSampleRate"`
}

// GitConfig is a project's repository and build settings. PUT /projects/{id}/git
// replaces it whole, so a change must send every field.
type GitConfig struct {
	Repo                    string `json:"repo"`
	ProductionBranch        string `json:"productionBranch"`
	Framework               string `json:"framework"`
	BuildCommand            string `json:"buildCommand"`
	OutputDir               string `json:"outputDir,omitempty"`
	Spa                     bool   `json:"spa"`
	IgnoredBuildStepCommand string `json:"ignoredBuildStepCommand,omitempty"`
	RootDirectory           string `json:"rootDirectory,omitempty"`
}

// EnvironmentConfig is the part of an environment's config the provider reads.
type EnvironmentConfig struct {
	Project string `json:"project"`
	Region  string `json:"region"`
	ArRepo  string `json:"arRepo"`
}

// Environment is one cloud a project runs on.
type Environment struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Target        string            `json:"target"`
	ClusterID     string            `json:"clusterId"`
	Config        EnvironmentConfig `json:"config"`
	TrafficWeight int64             `json:"trafficWeight"`
}

// Build is the part of a build the provider reads.
type Build struct {
	ID            string   `json:"id"`
	ProjectID     string   `json:"projectId"`
	Revision      string   `json:"revision"`
	Status        string   `json:"status"`
	Error         string   `json:"error"`
	Note          string   `json:"note"`
	Kind          string   `json:"kind"`
	DeploymentIDs []string `json:"deploymentIds"`
	StageID       string   `json:"stageId"`
}

// Build statuses (git.ts).
const (
	BuildQueued    = "queued"
	BuildRunning   = "running"
	BuildSkipped   = "skipped"
	BuildSucceeded = "succeeded"
	BuildFailed    = "failed"
)

// Project setup statuses (store.ts).
const (
	SetupProvisioning  = "provisioning"
	SetupReady         = "ready"
	SetupNeedsSetup    = "needs-setup"
	SetupWaitingForKey = "waiting-for-key"
)

// ProjectSummary is the answer of the summary routes (v2-routes.ts summarize).
type ProjectSummary struct {
	Project      Project       `json:"project"`
	Git          *GitConfig    `json:"git"`
	DomainURL    string        `json:"domainUrl"`
	Environments []Environment `json:"environments"`
	LatestBuild  *Build        `json:"latestBuild"`
	Stages       []Stage       `json:"stages"`
}

func projectPath(id string) string {
	return "/projects/" + url.PathEscape(id)
}

// SetupProject creates a project and prepares its clouds in the background.
func (c *Client) SetupProject(ctx context.Context, req SetupRequest) (*ProjectSummary, error) {
	var out ProjectSummary
	if err := c.do(ctx, http.MethodPost, "/projects/setup", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ProjectSummary reads one project.
func (c *Client) ProjectSummary(ctx context.Context, id string) (*ProjectSummary, error) {
	var out ProjectSummary
	if err := c.do(ctx, http.MethodGet, projectPath(id)+"/summary", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ProjectSummaries reads every project.
func (c *Client) ProjectSummaries(ctx context.Context) ([]ProjectSummary, error) {
	var out []ProjectSummary
	if err := c.do(ctx, http.MethodGet, "/projects/summary", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateProjectSettings changes the settings NBO allows on a live project.
func (c *Client) UpdateProjectSettings(ctx context.Context, id string, settings ProjectSettings) (*ProjectSummary, error) {
	var out ProjectSummary
	if err := c.do(ctx, http.MethodPatch, projectPath(id)+"/settings", settings, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateProjectGit replaces a project's build settings. The answer is not read:
// it has nothing the caller lacks.
func (c *Client) UpdateProjectGit(ctx context.Context, id string, git GitConfig) error {
	return c.do(ctx, http.MethodPut, projectPath(id)+"/git", git, nil)
}

// DeleteProject removes a project. With resources, NBO first deletes what the
// project runs on each cloud.
func (c *Client) DeleteProject(ctx context.Context, id string, resources bool) error {
	path := projectPath(id)
	if resources {
		path += "?resources=true"
	}
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}

// gitUpdate is the body of PUT /projects/{id}/git with a credential: the whole
// config, as GitConfig, plus what to store for reaching the repository.
type gitUpdate struct {
	GitConfig
	Credential *Credential `json:"credential,omitempty"`
}

// UpdateProjectGitWithCredential replaces a project's build settings and its
// git credential. A deploy key the project already has is kept.
func (c *Client) UpdateProjectGitWithCredential(ctx context.Context, id string, git GitConfig, credential Credential) error {
	return c.do(ctx, http.MethodPut, projectPath(id)+"/git", gitUpdate{GitConfig: git, Credential: &credential}, nil)
}

// ProjectCredential reads how NBO reaches a project's repository.
func (c *Client) ProjectCredential(ctx context.Context, id string) (CredentialView, error) {
	var out struct {
		Credential CredentialView `json:"credential"`
	}
	if err := c.do(ctx, http.MethodGet, projectPath(id)+"/git", nil, &out); err != nil {
		return CredentialView{}, err
	}
	return out.Credential, nil
}

// CreateDeployKey makes (or replaces) the project's deploy key pair and answers
// its public half.
func (c *Client) CreateDeployKey(ctx context.Context, id string) (string, error) {
	var out struct {
		PublicKey string `json:"publicKey"`
	}
	if err := c.do(ctx, http.MethodPost, projectPath(id)+"/git/deploy-key", struct{}{}, &out); err != nil {
		return "", err
	}
	return out.PublicKey, nil
}
