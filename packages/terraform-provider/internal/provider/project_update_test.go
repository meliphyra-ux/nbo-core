// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"nbo/terraform-provider/internal/client"
)

// putGit replaces the whole config, as webhooks.ts does: what isn't sent is gone.
func (f *fakeNBO) putGit(w http.ResponseWriter, r *http.Request) {
	s, ok := f.projects[r.PathValue("id")]
	if !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	body, _ := io.ReadAll(r.Body)
	var raw map[string]any
	var git client.GitConfig
	if json.Unmarshal(body, &raw) != nil || json.Unmarshal(body, &git) != nil {
		writeError(w, http.StatusBadRequest, "bad body")
		return
	}
	if dir, sent := raw["outputDir"]; sent && dir == "" {
		writeError(w, http.StatusBadRequest, "outputDir must be a plain relative path")
		return
	}
	if !f.putCredential(w, s.Git, git.Repo, r.PathValue("id"), raw) {
		return
	}
	f.gitPuts = append(f.gitPuts, raw)
	s.Git = &git
	writeJSON(w, http.StatusOK, git)
}

// applyChange plans config against state, checks it stays in place, applies it
// and checks the result is what was planned.
func applyChange(t *testing.T, h *harness, attrs map[string]any, state tftypes.Value) tftypes.Value {
	t.Helper()
	config := h.config(res, attrs)
	planned, resp := h.plan(res, state, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("plan asks for replacement because of %v", resp.RequiresReplace)
	}
	after, diags := h.apply(res, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if !after.IsFullyKnown() {
		t.Fatalf("state holds unknown values: %v", after)
	}
	if planned.IsFullyKnown() {
		if diffs, _ := planned.Diff(after); len(diffs) > 0 {
			t.Fatalf("apply result differs from the plan: %v", diffs)
		}
	}
	return after
}

func TestBuildSettingsChangeInPlace(t *testing.T) {
	changes := map[string]struct {
		attr  string
		value any
		check func(*client.GitConfig) bool
	}{
		"repo":       {"repo_url", "https://example.com/other.git", func(g *client.GitConfig) bool { return g.Repo == "https://example.com/other.git" }},
		"branch":     {"branch", "next", func(g *client.GitConfig) bool { return g.ProductionBranch == "next" }},
		"command":    {"build_command", "make", func(g *client.GitConfig) bool { return g.BuildCommand == "make" }},
		"spa":        {"spa", true, func(g *client.GitConfig) bool { return g.Spa }},
		"output dir": {"output_dir", "public", func(g *client.GitConfig) bool { return g.OutputDir == "public" }},
		"root":       {"root_directory", "web", func(g *client.GitConfig) bool { return g.RootDirectory == "web" }},
		"ignored":    {"ignored_build_step_command", "true", func(g *client.GitConfig) bool { return g.IgnoredBuildStepCommand == "true" }},
	}
	for name, tc := range changes {
		t.Run(name, func(t *testing.T) {
			fake := newFakeNBO(t)
			h := connected(t, fake.server.URL)
			base := with(shopConfig(), map[string]any{"root_directory": "apps/web", "ignored_build_step_command": "false", "output_dir": "build", "spa": false})
			state, diags := h.create(res, base)
			wantNoError(t, diags)

			applyChange(t, h, with(base, map[string]any{tc.attr: tc.value}), state)

			if len(fake.gitPuts) != 1 {
				t.Fatalf("PUT /git calls = %d", len(fake.gitPuts))
			}
			git := fake.projects["p1"].Git
			if !tc.check(git) {
				t.Fatalf("not changed: %+v", git)
			}
			// Everything else survives the whole-config PUT.
			want := client.GitConfig{
				Repo: "https://example.com/shop.git", ProductionBranch: "main", Framework: "static", BuildCommand: "pnpm build",
				OutputDir: "build", RootDirectory: "apps/web", IgnoredBuildStepCommand: "false",
			}
			got := *git
			switch tc.attr {
			case "repo_url":
				got.Repo = want.Repo
			case "branch":
				got.ProductionBranch = want.ProductionBranch
			case "build_command":
				got.BuildCommand = want.BuildCommand
			case "spa":
				got.Spa = want.Spa
			case "output_dir":
				got.OutputDir = want.OutputDir
			case "root_directory":
				got.RootDirectory = want.RootDirectory
			case "ignored_build_step_command":
				got.IgnoredBuildStepCommand = want.IgnoredBuildStepCommand
			}
			if got != want {
				t.Fatalf("other fields changed\n got %+v\nwant %+v", got, want)
			}
			if len(fake.deletes) != 0 || len(fake.setups) != 1 {
				t.Fatal("the project was replaced")
			}
		})
	}
}

func TestDefaultOutputDirSurvivesAnUnrelatedChange(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	after := applyChange(t, h, with(shopConfig(), map[string]any{"branch": "next"}), state)
	if fake.projects["p1"].Git.OutputDir != "dist" || stringAttr(t, after, "output_dir") != "dist" {
		t.Fatalf("output dir lost: %+v", fake.projects["p1"].Git)
	}
}

func TestRemovingAnOptionalBuildSettingClearsIt(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, with(shopConfig(), map[string]any{"root_directory": "web", "ignored_build_step_command": "true"}))
	wantNoError(t, diags)

	after := applyChange(t, h, shopConfig(), state)
	git := fake.projects["p1"].Git
	if git.RootDirectory != "" || git.IgnoredBuildStepCommand != "" {
		t.Fatalf("still set: %+v", git)
	}
	refreshed, diags := h.read(res, after)
	wantNoError(t, diags)
	planned, resp := h.plan(res, refreshed, h.config(res, shopConfig()))
	wantNoChange(t, refreshed, planned, resp)
}

func TestChangingFrameworkInPlaceSettlesOutputDir(t *testing.T) {
	t.Run("static to nextjs", func(t *testing.T) {
		fake := newFakeNBO(t)
		h := connected(t, fake.server.URL)
		state, diags := h.create(res, shopConfig())
		wantNoError(t, diags)

		attrs := with(shopConfig(), map[string]any{"framework": "nextjs"})
		after := applyChange(t, h, attrs, state)
		if git := fake.projects["p1"].Git; git.Framework != "nextjs" || git.OutputDir != "" {
			t.Fatalf("git = %+v", git)
		}
		if got := stringAttr(t, after, "output_dir"); got != "" {
			t.Fatalf("output_dir = %q", got)
		}
		planned, resp := h.plan(res, after, h.config(res, attrs))
		wantNoChange(t, after, planned, resp)
	})
	t.Run("nextjs to static", func(t *testing.T) {
		fake := newFakeNBO(t)
		h := connected(t, fake.server.URL)
		state, diags := h.create(res, with(shopConfig(), map[string]any{"framework": "nextjs"}))
		wantNoError(t, diags)

		after := applyChange(t, h, shopConfig(), state)
		if git := fake.projects["p1"].Git; git.Framework != "static" || git.OutputDir != "dist" {
			t.Fatalf("git = %+v", git)
		}
		if got := stringAttr(t, after, "output_dir"); got != "dist" {
			t.Fatalf("output_dir = %q", got)
		}
	})
}

func TestSettingsChangesDoNotTouchGit(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	applyChange(t, h, with(shopConfig(), map[string]any{"polling_enabled": false}), state)
	if len(fake.gitPuts) != 0 || len(fake.patches) != 1 {
		t.Fatalf("puts = %v, patches = %v", fake.gitPuts, fake.patches)
	}
}

func TestBuildAndSettingsChangesTogether(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	applyChange(t, h, with(shopConfig(), map[string]any{"branch": "next", "speed_insights": true}), state)
	if len(fake.gitPuts) != 1 || len(fake.patches) != 1 {
		t.Fatalf("puts = %v, patches = %v", fake.gitPuts, fake.patches)
	}
}

func TestOnlyNameAndCloudsPlanReplacement(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	_, resp := h.plan(res, state, h.config(res, with(shopConfig(), map[string]any{"name": "shop2"})))
	wantReplace(t, resp.RequiresReplace, "name")
	if len(resp.RequiresReplace) != 1 {
		t.Fatalf("replace = %v", resp.RequiresReplace)
	}
}

func TestAGitUpdateErrorShowsNBOsMessage(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	delete(fake.projects, "p1")
	config := h.config(res, with(shopConfig(), map[string]any{"branch": "next"}))
	planned, resp := h.plan(res, state, config)
	_, diags = h.apply(res, state, planned, config, resp.PlannedPrivate)
	wantError(t, diags, "project not found")
}

const notAPIText = "isn't its API"

// The dashboard answers GETs with a page at the plain paths, while POSTs still
// reach the API, so with a wrong endpoint the project is created.
func TestWrongEndpointDuringCreateStopsAtOnce(t *testing.T) {
	fake := newFakeNBO(t)
	fake.steps = []func(*client.ProjectSummary){setupFinished}
	fake.htmlGets = true
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, shopConfig())
	wantError(t, diags, notAPIText)
	if stringAttr(t, state, "id") != "p1" {
		t.Fatal("id missing from state")
	}
	if n := fake.callCount("GET "); n != 1 {
		t.Fatalf("polled %d times", n)
	}
}

func TestWrongEndpointOnReadKeepsTheState(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	fake.htmlGets = true
	_, diags = h.read(res, state)
	wantError(t, diags, notAPIText)
}
