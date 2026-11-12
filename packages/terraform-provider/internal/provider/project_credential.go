// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"nbo/terraform-provider/internal/client"
)

// This file is nbo_project's git credential: how NBO reaches a private
// repository. The token is write-only (like nbo_deployment's values_wo), so
// Terraform sends it from config and never keeps it in the plan or state.

const (
	credentialPublic    = "public"
	credentialToken     = "token"
	credentialDeployKey = "deploy-key"
)

// repoURLPattern accepts what NBO accepts as a repository address: https://,
// ssh:// and the scp-like git@host:path form. Whether the one given fits the
// credential is checked in validateCredential.
var repoURLPattern = regexp.MustCompile(`^(https://|ssh://|[^@/:\s]+@[^/:@\s]+:)`)

func isHTTPSRepo(repo string) bool {
	u, err := url.Parse(repo)
	return err == nil && u.Scheme == "https"
}

var scpRepo = regexp.MustCompile(`^[^@/:\s]+@([^/:@\s]+):`)

// repoOrigin is where git connects for repo: scheme, host and port (the scp-like
// form is ssh on port 22). Like NBO, a stored credential stays with one origin.
func repoOrigin(repo string) string {
	if m := scpRepo.FindStringSubmatch(repo); m != nil && !strings.Contains(repo, "://") {
		return "ssh://" + strings.ToLower(m[1]) + ":22"
	}
	u, err := url.Parse(repo)
	if err != nil || u.Host == "" {
		return repo
	}
	port := u.Port()
	if port == "" {
		port = map[string]string{"https": "443", "ssh": "22", "http": "80"}[u.Scheme]
	}
	return u.Scheme + "://" + strings.ToLower(u.Hostname()) + ":" + port
}

// repoMoved reports whether the repository is now on another origin.
func (m *projectModel) repoMoved(prior *projectModel) bool {
	return isSet(m.RepoURL) && isSet(prior.RepoURL) && repoOrigin(m.RepoURL.ValueString()) != repoOrigin(prior.RepoURL.ValueString())
}

// kind is git_credential, "public" when left out.
func (m *projectModel) credentialKind() string {
	if m.GitCredential.IsNull() || m.GitCredential.IsUnknown() || m.GitCredential.ValueString() == "" {
		return credentialPublic
	}
	return m.GitCredential.ValueString()
}

// validateCredential checks the credential attributes against each other and
// against repo_url. Values not known yet pass.
func validateCredential(config projectModel, diags *diag.Diagnostics) {
	if config.GitCredential.IsUnknown() {
		return
	}
	kind := config.credentialKind()
	if kind == credentialToken {
		if config.GitTokenWO.IsNull() {
			diags.AddAttributeError(path.Root("git_token_wo"), "git_token_wo is required", `git_credential = "token" needs git_token_wo, the access token. It needs Terraform 1.11 or newer.`)
		}
	} else {
		if isSet(config.GitTokenWO) {
			diags.AddAttributeError(path.Root("git_token_wo"), "git_token_wo has no meaning here", fmt.Sprintf("git_token_wo is for git_credential = %q, not %q.", credentialToken, kind))
		}
		if isSet(config.GitUsername) {
			diags.AddAttributeError(path.Root("git_username"), "git_username has no meaning here", fmt.Sprintf("git_username is for git_credential = %q, not %q.", credentialToken, kind))
		}
	}
	if !isSet(config.RepoURL) {
		return
	}
	https := isHTTPSRepo(config.RepoURL.ValueString())
	switch {
	case kind == credentialDeployKey && https:
		diags.AddAttributeError(path.Root("repo_url"), "repo_url does not fit a deploy key", `A deploy key works over ssh: use ssh://git@host/path or git@host:path, or use git_credential = "token" for an https:// address.`)
	case kind != credentialDeployKey && !https && repoURLPattern.MatchString(config.RepoURL.ValueString()):
		diags.AddAttributeError(path.Root("repo_url"), "repo_url needs a deploy key", `An ssh address works only with git_credential = "deploy-key".`)
	}
}

// credentialToSend is the credential a new project sends: nothing for a public
// repository, which is also what older NBO servers expect.
func (m *projectModel) credentialToSend(token types.String) *client.Credential {
	switch m.credentialKind() {
	case credentialToken:
		return &client.Credential{Kind: credentialToken, Token: token.ValueString(), Username: m.GitUsername.ValueString()}
	case credentialDeployKey:
		return &client.Credential{Kind: credentialDeployKey}
	}
	return nil
}

// credentialChange is the credential an update must send, nil when what NBO
// holds already is right. A token is sent only when the credential kind, the
// user name or git_token_wo_version changed, since Terraform can't see the
// write-only token itself change.
func (m *projectModel) credentialChange(prior *projectModel, token types.String) *client.Credential {
	kind := m.credentialKind()
	moved := m.repoMoved(prior)
	if kind == prior.credentialKind() {
		switch kind {
		case credentialPublic:
			return nil
		case credentialDeployKey:
			if !moved {
				return nil
			}
		case credentialToken:
			if !moved && m.GitUsername.Equal(prior.GitUsername) && m.GitTokenWOVersion.Equal(prior.GitTokenWOVersion) {
				return nil
			}
		}
	}
	if kind == credentialPublic {
		return &client.Credential{Kind: credentialPublic}
	}
	return m.credentialToSend(token)
}

// renewDeployKey makes NBO replace the deploy key: a repository on another host
// needs a key added there, and a PUT alone keeps the one the project has.
func (m *projectModel) renewDeployKey(ctx context.Context, c *client.Client, id string) error {
	_, err := c.CreateDeployKey(ctx, id)
	return err
}

// checkMove refuses a move of a token project to another host without a new
// token sent, and warns that a deploy key project gets a new key.
func checkMove(plan, state *projectModel, diags *diag.Diagnostics) {
	if !plan.repoMoved(state) {
		return
	}
	switch plan.credentialKind() {
	case credentialToken:
		if plan.credentialKind() == state.credentialKind() && plan.GitTokenWOVersion.Equal(state.GitTokenWOVersion) {
			diags.AddAttributeError(path.Root("git_token_wo_version"), "A repository on another host needs the token sent again",
				"NBO never sends a stored token to another host. Change git_token_wo_version (and make sure git_token_wo holds the token for the new host) so Terraform sends it with the new repo_url.")
		}
	case credentialDeployKey:
		if state.credentialKind() == credentialDeployKey {
			diags.AddAttributeWarning(path.Root("deploy_key_public"), "The repository moved: NBO makes a new deploy key",
				"Add the new public key (deploy_key_public, known after apply) to the repository at its new host as a read-only deploy key. The old key is replaced.")
		}
	}
}

// readDeployKey fills deploy_key_public from NBO: the public half when the
// credential is a deploy key, null otherwise.
func (m *projectModel) readDeployKey(ctx context.Context, c *client.Client, id string) error {
	if m.credentialKind() != credentialDeployKey {
		m.DeployKeyPublic = types.StringNull()
		return nil
	}
	view, err := c.ProjectCredential(ctx, id)
	if err != nil {
		m.DeployKeyPublic = types.StringNull()
		return err
	}
	if view.Kind != credentialDeployKey || view.PublicKey == "" {
		m.DeployKeyPublic = types.StringNull()
		return errors.New("NBO has no deploy key for this project")
	}
	m.DeployKeyPublic = types.StringValue(view.PublicKey)
	return nil
}

// refreshCredential reads the credential kind into state after an import (when
// it is null) and for a deploy key, whose public half can change in the
// dashboard. A token, which state can't compare, is left as it is.
func (m *projectModel) refreshCredential(ctx context.Context, c *client.Client, id string) error {
	imported := m.GitCredential.IsNull()
	if !imported && m.GitCredential.ValueString() != credentialDeployKey {
		return nil
	}
	view, err := c.ProjectCredential(ctx, id)
	if err != nil {
		return err
	}
	switch view.Kind {
	case credentialPublic, credentialToken, credentialDeployKey:
		m.GitCredential = types.StringValue(view.Kind)
	default:
		// A project still linked to an older GitHub App: it is plain public
		// as far as these attributes go.
		if imported {
			m.GitCredential = types.StringValue(credentialPublic)
		}
	}
	if imported && m.GitUsername.IsNull() {
		m.GitUsername = optString(view.Username)
	}
	m.DeployKeyPublic = types.StringNull()
	if m.GitCredential.ValueString() == credentialDeployKey {
		m.DeployKeyPublic = optString(view.PublicKey)
	}
	return nil
}

// scrubToken is err with the token taken out of its text.
func scrubToken(err error, token types.String) error {
	if token.IsNull() || token.IsUnknown() {
		return err
	}
	return scrubError(err, map[string]string{"git_token_wo": token.ValueString()})
}

// deployKeyPublicModifier plans deploy_key_public: null unless the credential
// is a deploy key, the key NBO already made when it stays one, and unknown
// while NBO has still to make it.
type deployKeyPublicModifier struct{}

func (deployKeyPublicModifier) Description(context.Context) string {
	return "Known only for a deploy key; NBO makes the key."
}

func (m deployKeyPublicModifier) MarkdownDescription(ctx context.Context) string {
	return m.Description(ctx)
}

func (deployKeyPublicModifier) PlanModifyString(ctx context.Context, req planmodifier.StringRequest, resp *planmodifier.StringResponse) {
	if req.Plan.Raw.IsNull() {
		return
	}
	var planned types.String
	resp.Diagnostics.Append(req.Plan.GetAttribute(ctx, path.Root("git_credential"), &planned)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if planned.IsUnknown() {
		resp.PlanValue = types.StringUnknown()
		return
	}
	if planned.ValueString() != credentialDeployKey {
		resp.PlanValue = types.StringNull()
		return
	}
	if !req.State.Raw.IsNull() {
		var current types.String
		resp.Diagnostics.Append(req.State.GetAttribute(ctx, path.Root("git_credential"), &current)...)
		var plannedRepo, currentRepo types.String
		resp.Diagnostics.Append(req.Plan.GetAttribute(ctx, path.Root("repo_url"), &plannedRepo)...)
		resp.Diagnostics.Append(req.State.GetAttribute(ctx, path.Root("repo_url"), &currentRepo)...)
		moved := isSet(plannedRepo) && isSet(currentRepo) && repoOrigin(plannedRepo.ValueString()) != repoOrigin(currentRepo.ValueString())
		if current.ValueString() == credentialDeployKey && !req.StateValue.IsNull() && !moved {
			resp.PlanValue = req.StateValue
			return
		}
	}
	resp.PlanValue = types.StringUnknown()
}
