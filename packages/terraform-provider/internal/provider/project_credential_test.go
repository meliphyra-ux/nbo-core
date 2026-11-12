// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tfprotov6"

	"nbo/terraform-provider/internal/client"
)

// storedCredential is what the fake NBO keeps of a project's git credential.
type storedCredential struct {
	kind, token, username, publicKey string
}

const fakePublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests nbo-p1"

func (f *fakeNBO) storeCredential(id string, c *client.Credential) {
	if c == nil || c.Kind == "public" {
		return
	}
	if f.creds == nil {
		f.creds = map[string]*storedCredential{}
	}
	stored := &storedCredential{kind: c.Kind, token: c.Token, username: c.Username}
	if c.Kind == "deploy-key" {
		stored.publicKey = fakePublicKey
	}
	f.creds[id] = stored
}

// putCredential applies the credential of a PUT .../git body the way NBO does:
// none keeps the stored one, unless the repository moved to another host.
// It answers false after writing an error.
func (f *fakeNBO) putCredential(w http.ResponseWriter, old *client.GitConfig, repo, id string, raw map[string]any) bool {
	sent, has := raw["credential"]
	if !has {
		if f.creds[id] != nil && old != nil && hostOf(old.Repo) != hostOf(repo) {
			writeError(w, http.StatusBadRequest, "the repository moved to another host: give its credential again")
			return false
		}
		return true
	}
	body, _ := json.Marshal(sent)
	var c client.Credential
	_ = json.Unmarshal(body, &c)
	if c.Kind == "deploy-key" && f.creds[id] != nil && f.creds[id].kind == "deploy-key" {
		return true
	}
	delete(f.creds, id)
	f.storeCredential(id, &c)
	return true
}

func hostOf(repo string) string {
	u, err := url.Parse(repo)
	if err != nil {
		return repo
	}
	return u.Host
}

func (f *fakeNBO) getGit(w http.ResponseWriter, r *http.Request) {
	s, ok := f.projects[r.PathValue("id")]
	if !ok || s.Git == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	view := map[string]any{"kind": "public"}
	if c := f.creds[r.PathValue("id")]; c != nil {
		view["kind"] = c.kind
		if c.publicKey != "" {
			view["publicKey"] = c.publicKey
		}
		if c.username != "" {
			view["username"] = c.username
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"repo": s.Git.Repo, "productionBranch": s.Git.ProductionBranch, "credential": view})
}

func (f *fakeNBO) postDeployKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := f.projects[id]; !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	_, _ = io.Copy(io.Discard, r.Body)
	delete(f.creds, id)
	f.storeCredential(id, &client.Credential{Kind: "deploy-key"})
	writeJSON(w, http.StatusCreated, map[string]string{"publicKey": f.creds[id].publicKey})
}

func tokenConfig() map[string]any {
	return with(shopConfig(), map[string]any{"git_credential": "token", "git_token_wo": "t0ken-secret", "git_token_wo_version": "1", "git_username": "u"})
}

func sshConfig() map[string]any {
	return with(shopConfig(), map[string]any{"repo_url": "git@github.com:you/shop.git", "git_credential": "deploy-key"})
}

func TestTokenCredentialIsSentButNeverKept(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, tokenConfig())
	wantNoError(t, diags)

	got := fake.setups[0].Credential
	if got == nil || got.Kind != "token" || got.Token != "t0ken-secret" || got.Username != "u" {
		t.Fatalf("setup credential = %+v", got)
	}
	if strings.Contains(state.String(), "t0ken-secret") {
		t.Fatalf("state holds the token: %s", state)
	}
	if !attrOf(t, state, "git_token_wo").IsNull() {
		t.Fatal("git_token_wo must stay null in state")
	}
	if stringAttr(t, state, "git_credential") != "token" || stringAttr(t, state, "git_username") != "u" {
		t.Fatalf("state = %s", state)
	}
	if !attrOf(t, state, "deploy_key_public").IsNull() {
		t.Fatal("a token project has no deploy key")
	}

	refreshed, diags := h.read(res, state)
	wantNoError(t, diags)
	planned, resp := h.plan(res, refreshed, h.config(res, tokenConfig()))
	wantNoChange(t, refreshed, planned, resp)
}

func TestTokenChangesOnlyWhenItsVersionChanges(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, tokenConfig())
	wantNoError(t, diags)

	// A different token alone is invisible to Terraform: nothing is sent.
	changed := with(tokenConfig(), map[string]any{"git_token_wo": "other-token"})
	planned, resp := h.plan(res, state, h.config(res, changed))
	wantNoChange(t, state, planned, resp)
	if len(fake.gitPuts) != 0 {
		t.Fatalf("puts = %v", fake.gitPuts)
	}

	// A new version sends the token once and keeps it out of state.
	rotated := with(changed, map[string]any{"git_token_wo_version": "2"})
	after := applyChange(t, h, rotated, state)
	if len(fake.gitPuts) != 1 {
		t.Fatalf("puts = %v", fake.gitPuts)
	}
	cred, _ := fake.gitPuts[0]["credential"].(map[string]any)
	if cred["kind"] != "token" || cred["token"] != "other-token" || cred["username"] != "u" {
		t.Fatalf("credential sent = %v", cred)
	}
	if strings.Contains(after.String(), "other-token") {
		t.Fatalf("state holds the token: %s", after)
	}
	if fake.creds["p1"].token != "other-token" {
		t.Fatal("NBO did not get the new token")
	}
}

func TestChangingBuildSettingsKeepsTheStoredCredential(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, tokenConfig())
	wantNoError(t, diags)

	applyChange(t, h, with(tokenConfig(), map[string]any{"branch": "next"}), state)
	if len(fake.gitPuts) != 1 {
		t.Fatalf("puts = %v", fake.gitPuts)
	}
	if _, sent := fake.gitPuts[0]["credential"]; sent {
		t.Fatalf("the token was sent again: %v", fake.gitPuts[0])
	}
}

func TestDeployKeyPublicHalfComesFromNBO(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, sshConfig())
	wantNoError(t, diags)

	if got := fake.setups[0].Credential; got == nil || got.Kind != "deploy-key" || got.Token != "" {
		t.Fatalf("setup credential = %+v", got)
	}
	if stringAttr(t, state, "deploy_key_public") != fakePublicKey {
		t.Fatalf("deploy_key_public = %q", stringAttr(t, state, "deploy_key_public"))
	}
	refreshed, diags := h.read(res, state)
	wantNoError(t, diags)
	planned, resp := h.plan(res, refreshed, h.config(res, sshConfig()))
	wantNoChange(t, refreshed, planned, resp)
}

func TestDeployKeyKeepsWorkingWhenSetupWaitsForTheKey(t *testing.T) {
	fake := newFakeNBO(t)
	fake.steps = []func(*client.ProjectSummary){func(s *client.ProjectSummary) {
		s.Project.SetupStatus = client.SetupNeedsSetup
		s.Project.SetupError = "git ls-remote failed: Permission denied (publickey)"
	}}
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, sshConfig())
	wantNoError(t, diags)
	if stringAttr(t, state, "deploy_key_public") != fakePublicKey {
		t.Fatalf("state = %s", state)
	}
	found := false
	for _, d := range diags {
		found = found || (strings.Contains(d.Detail, "deploy key") && strings.Contains(d.Detail, "nbo-server project retry p1") && strings.Contains(d.Detail, "nbo_deployment"))
	}
	if !found {
		t.Fatalf("want a warning about adding the key, got: %s", diagText(diags))
	}
}

func TestSwitchingAnExistingProjectToADeployKeyAndBack(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)
	if fake.setups[0].Credential != nil {
		t.Fatalf("a public project sends no credential: %+v", fake.setups[0].Credential)
	}

	config := sshConfig()
	planned, _ := h.plan(res, state, h.config(res, config))
	if attrOf(t, planned, "deploy_key_public").IsKnown() {
		t.Fatalf("deploy_key_public must be unknown in the plan, got %s", attrOf(t, planned, "deploy_key_public"))
	}
	after := applyChange(t, h, config, state)
	cred, _ := fake.gitPuts[0]["credential"].(map[string]any)
	if cred["kind"] != "deploy-key" {
		t.Fatalf("credential sent = %v", fake.gitPuts[0])
	}
	if stringAttr(t, after, "deploy_key_public") != fakePublicKey {
		t.Fatalf("state = %s", after)
	}

	back := applyChange(t, h, with(shopConfig(), map[string]any{"git_credential": "public"}), after)
	if !attrOf(t, back, "deploy_key_public").IsNull() {
		t.Fatalf("state = %s", back)
	}
	if fake.creds["p1"] != nil {
		t.Fatal("the credential should be gone")
	}
}

func TestTokenNeedsItsWriteOnlyValue(t *testing.T) {
	h := newHarness(t)
	diags := h.validate(res, with(shopConfig(), map[string]any{"git_credential": "token"}))
	wantError(t, diags, "git_token_wo")
}

func TestCredentialAttributesAgreeWithTheKind(t *testing.T) {
	h := newHarness(t)
	wantError(t, h.validate(res, with(shopConfig(), map[string]any{"git_token_wo": "x"})), "git_token_wo")
	wantError(t, h.validate(res, with(shopConfig(), map[string]any{"git_username": "x"})), "git_username")
	wantError(t, h.validate(res, with(sshConfig(), map[string]any{"git_token_wo": "x"})), "git_token_wo")
	wantError(t, h.validate(res, with(shopConfig(), map[string]any{"git_credential": "deploy-key"})), "repo_url")
	wantError(t, h.validate(res, with(shopConfig(), map[string]any{"repo_url": "git@github.com:you/shop.git"})), "repo_url")
	wantError(t, h.validate(res, with(shopConfig(), map[string]any{"git_credential": "password"})), "git_credential")
	wantNoError(t, h.validate(res, tokenConfig()))
	wantNoError(t, h.validate(res, sshConfig()))
}

func TestImportedProjectLearnsItsCredentialKind(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	created, diags := h.create(res, sshConfig())
	wantNoError(t, diags)

	imported := h.importState(res, stringAttr(t, created, "id"))
	refreshed, diags := h.read(res, imported)
	wantNoError(t, diags)
	if stringAttr(t, refreshed, "git_credential") != "deploy-key" || stringAttr(t, refreshed, "deploy_key_public") != fakePublicKey {
		t.Fatalf("state = %s", refreshed)
	}
}

func TestMovingTheRepositoryResendsTheTokenWithABumpedVersion(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, tokenConfig())
	wantNoError(t, diags)

	moved := with(tokenConfig(), map[string]any{"repo_url": "https://gitlab.example.org/shop.git", "git_token_wo_version": "2"})
	after := applyChange(t, h, moved, state)
	cred, _ := fake.gitPuts[0]["credential"].(map[string]any)
	if cred["kind"] != "token" || cred["token"] != "t0ken-secret" {
		t.Fatalf("credential sent = %v", fake.gitPuts[0])
	}
	if strings.Contains(after.String(), "t0ken-secret") {
		t.Fatal("state holds the token")
	}
}

func TestMovingTheRepositoryWithoutABumpedVersionFailsThePlan(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, tokenConfig())
	wantNoError(t, diags)

	cfg := h.config(res, with(tokenConfig(), map[string]any{"repo_url": "https://gitlab.example.org/shop.git"}))
	resp := h.planResponse(res, state, cfg)
	wantError(t, resp.Diagnostics, "git_token_wo_version")
}

func TestMovingADeployKeyRepositoryMakesANewKey(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, sshConfig())
	wantNoError(t, diags)
	fake.creds["p1"].publicKey = "ssh-ed25519 OLD"
	state, diags = h.read(res, state)
	wantNoError(t, diags)

	moved := with(sshConfig(), map[string]any{"repo_url": "git@gitlab.example.org:you/shop.git"})
	cfg := h.config(res, moved)
	planned, resp := h.plan(res, state, cfg)
	if attrOf(t, planned, "deploy_key_public").IsKnown() {
		t.Fatal("deploy_key_public must be unknown when the repository moves")
	}
	warned := false
	for _, d := range resp.Diagnostics {
		warned = warned || (d.Severity == tfprotov6.DiagnosticSeverityWarning && strings.Contains(d.Detail, "new public key"))
	}
	if !warned {
		t.Fatalf("want a warning about the new key, got: %s", diagText(resp.Diagnostics))
	}
	after, diags := h.apply(res, state, planned, cfg, resp.PlannedPrivate)
	wantNoError(t, diags)
	cred, _ := fake.gitPuts[0]["credential"].(map[string]any)
	if cred["kind"] != "deploy-key" {
		t.Fatalf("credential sent = %v", fake.gitPuts[0])
	}
	if stringAttr(t, after, "deploy_key_public") != fakePublicKey {
		t.Fatalf("the key was not renewed: %s", after)
	}
}
