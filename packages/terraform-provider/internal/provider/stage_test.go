// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"nbo/terraform-provider/internal/client"
)

const stageRes = "nbo_stage"

// withStages is a project's summary as NBO answers it: the three built-in
// stages (Production's clouds are the summary's) and the custom ones.
func (f *fakeNBO) withStages(s *client.ProjectSummary) *client.ProjectSummary {
	c := *s
	c.Stages = []client.Stage{
		{ID: "stg_production", Name: "production", Kind: "production", Environments: s.Environments, Host: s.Project.EdgeHost, URL: s.DomainURL},
		{ID: "stg_preview", Name: "preview", Kind: "preview"},
		{ID: "stg_development", Name: "development", Kind: "development"},
	}
	if s.Git != nil {
		c.Stages[0].Branch = s.Git.ProductionBranch
	}
	for _, st := range f.stages[s.Project.ID] {
		c.Stages = append(c.Stages, *st)
	}
	return &c
}

// stageID is the id of a project's stage by name, "" when there is none.
func (f *fakeNBO) stageID(projectID, name string) string {
	if name == "production" || name == "preview" || name == "development" {
		return "stg_" + name
	}
	for _, st := range f.stages[projectID] {
		if st.Name == name {
			return st.ID
		}
	}
	return ""
}

func (f *fakeNBO) listStages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s, ok := f.projects[id]
	if !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	writeJSON(w, http.StatusOK, f.withStages(s).Stages)
}

func (f *fakeNBO) createStage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s, ok := f.projects[id]
	if !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	var raw map[string]any
	var body struct {
		Name       string         `json:"name"`
		Branch     string         `json:"branch"`
		Clouds     []client.Cloud `json:"clouds"`
		AutoDeploy *bool          `json:"autoDeploy"`
	}
	b, _ := readAll(r)
	if json.Unmarshal(b, &raw) != nil || json.Unmarshal(b, &body) != nil {
		writeError(w, http.StatusBadRequest, "bad body")
		return
	}
	f.stagePosts = append(f.stagePosts, raw)
	if f.stageID(id, body.Name) != "" {
		writeError(w, http.StatusConflict, fmt.Sprintf("an environment named %q already exists", body.Name))
		return
	}
	if s.Git != nil && s.Git.ProductionBranch == body.Branch {
		writeError(w, http.StatusConflict, fmt.Sprintf("the branch %q already builds the production environment", body.Branch))
		return
	}
	st := &client.Stage{
		ID: "stg_" + body.Name, Name: body.Name, Kind: "custom", Branch: body.Branch, AutoDeploy: body.AutoDeploy == nil || *body.AutoDeploy,
		Host: body.Name + "--" + s.Project.Name + ".example", URL: "http://" + body.Name + "--" + s.Project.Name + ".example",
	}
	for i, cloud := range body.Clouds {
		env := client.Environment{ID: fmt.Sprintf("%s_env%d", body.Name, i), Target: cloud.Target, ClusterID: cloud.ClusterID}
		if cloud.Target == "cloudrun" {
			env.Name = "s-" + body.Name + "-cr"
			env.Config = client.EnvironmentConfig{Project: "acme-prod", Region: "us-central1", ArRepo: "us-central1-docker.pkg.dev/acme-prod/nbo"}
		} else {
			env.Name = "s-" + body.Name + "-k8s"
		}
		st.Environments = append(st.Environments, env)
	}
	f.stages[id] = append(f.stages[id], st)
	writeJSON(w, http.StatusCreated, st)
}

func (f *fakeNBO) findStage(id, stageID string) *client.Stage {
	for _, st := range f.stages[id] {
		if st.ID == stageID {
			return st
		}
	}
	return nil
}

func (f *fakeNBO) patchStage(w http.ResponseWriter, r *http.Request) {
	st := f.findStage(r.PathValue("id"), r.PathValue("stageID"))
	if st == nil {
		writeError(w, http.StatusNotFound, "environment not found")
		return
	}
	var raw map[string]any
	var body struct {
		Branch     *string `json:"branch"`
		AutoDeploy *bool   `json:"autoDeploy"`
	}
	b, _ := readAll(r)
	if json.Unmarshal(b, &raw) != nil || json.Unmarshal(b, &body) != nil {
		writeError(w, http.StatusBadRequest, "bad body")
		return
	}
	f.stagePatches = append(f.stagePatches, raw)
	if body.Branch != nil {
		st.Branch = *body.Branch
	}
	if body.AutoDeploy != nil {
		st.AutoDeploy = *body.AutoDeploy
	}
	writeJSON(w, http.StatusOK, st)
}

func (f *fakeNBO) deleteStage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	st := f.findStage(id, r.PathValue("stageID"))
	if st == nil {
		writeError(w, http.StatusNotFound, "environment not found")
		return
	}
	f.stageDeletes = append(f.stageDeletes, r.URL.RequestURI())
	kept := f.stages[id][:0]
	for _, other := range f.stages[id] {
		if other != st {
			kept = append(kept, other)
		}
	}
	f.stages[id] = kept
	w.WriteHeader(http.StatusNoContent)
}

func readAll(r *http.Request) ([]byte, error) {
	return io.ReadAll(r.Body)
}

func stageFixture(t *testing.T) (*fakeNBO, *harness) {
	t.Helper()
	fake := newFakeNBO(t)
	fake.add("p1", shopRequest())
	return fake, connected(t, fake.server.URL)
}

func stageConfig() map[string]any {
	return map[string]any{
		"project_id": "p1", "name": "staging", "branch": "develop",
		"clouds": []map[string]any{{"target": "cloudrun", "mode": "auto"}},
	}
}

func TestStageCreateSendsNameBranchAndClouds(t *testing.T) {
	fake, h := stageFixture(t)
	state, diags := h.create(stageRes, stageConfig())
	wantNoError(t, diags)

	if len(fake.stagePosts) != 1 {
		t.Fatalf("posts = %v", fake.stagePosts)
	}
	post := fake.stagePosts[0]
	clouds, _ := post["clouds"].([]any)
	if post["name"] != "staging" || post["branch"] != "develop" || len(clouds) != 1 {
		t.Fatalf("body = %v", post)
	}
	if _, sent := post["autoDeploy"]; sent {
		t.Fatalf("auto_deploy was not configured, so NBO should choose: %v", post)
	}
	if stringAttr(t, state, "id") != "stg_staging" || stringAttr(t, state, "host") != "staging--shop.example" ||
		stringAttr(t, state, "url") != "http://staging--shop.example" || !boolAttr(t, state, "auto_deploy") {
		t.Fatalf("state = %v", state)
	}
}

func TestStageCreateSendsAutoDeployWhenConfigured(t *testing.T) {
	fake, h := stageFixture(t)
	state, diags := h.create(stageRes, with(stageConfig(), map[string]any{"auto_deploy": false}))
	wantNoError(t, diags)
	if fake.stagePosts[0]["autoDeploy"] != false || boolAttr(t, state, "auto_deploy") {
		t.Fatalf("body = %v, state = %v", fake.stagePosts[0], state)
	}
}

func TestStageCreateShowsNBOsRefusal(t *testing.T) {
	_, h := stageFixture(t)
	state, diags := h.create(stageRes, with(stageConfig(), map[string]any{"branch": "main"}))
	wantError(t, diags, "already builds the production environment")
	if !state.IsNull() {
		t.Fatalf("state = %v", state)
	}
}

func TestStagePlanAfterCreateIsEmpty(t *testing.T) {
	_, h := stageFixture(t)
	state, diags := h.create(stageRes, stageConfig())
	wantNoError(t, diags)
	refreshed, diags := h.read(stageRes, state)
	wantNoError(t, diags)
	planned, resp := h.plan(stageRes, refreshed, h.config(stageRes, stageConfig()))
	wantNoChange(t, refreshed, planned, resp)
}

func TestStageBranchAndAutoDeployChangeInPlace(t *testing.T) {
	fake, h := stageFixture(t)
	state, diags := h.create(stageRes, stageConfig())
	wantNoError(t, diags)

	config := h.config(stageRes, with(stageConfig(), map[string]any{"branch": "next", "auto_deploy": false}))
	planned, resp := h.plan(stageRes, state, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
	after, diags := h.apply(stageRes, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if len(fake.stagePatches) != 1 || fake.stagePatches[0]["branch"] != "next" || fake.stagePatches[0]["autoDeploy"] != false {
		t.Fatalf("patches = %v", fake.stagePatches)
	}
	if stringAttr(t, after, "branch") != "next" || stringAttr(t, after, "id") != "stg_staging" {
		t.Fatalf("after = %v", after)
	}
	if diffs, _ := planned.Diff(after); len(diffs) > 0 {
		t.Fatalf("apply result differs from the plan: %v", diffs)
	}
}

// Only what changed is sent, so an unchanged branch is not re-checked.
func TestStagePatchSendsOnlyWhatChanged(t *testing.T) {
	fake, h := stageFixture(t)
	state, diags := h.create(stageRes, stageConfig())
	wantNoError(t, diags)
	config := h.config(stageRes, with(stageConfig(), map[string]any{"auto_deploy": false}))
	planned, resp := h.plan(stageRes, state, config)
	_, diags = h.apply(stageRes, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if _, sent := fake.stagePatches[0]["branch"]; sent || len(fake.stagePatches[0]) != 1 {
		t.Fatalf("patch = %v", fake.stagePatches[0])
	}
}

func TestStageReplacements(t *testing.T) {
	cases := map[string]struct {
		attr  string
		extra map[string]any
	}{
		"name":        {"name", map[string]any{"name": "qa"}},
		"project":     {"project_id", map[string]any{"project_id": "p2"}},
		"new cloud":   {"clouds", map[string]any{"clouds": []map[string]any{{"target": "cloudrun", "mode": "auto"}, {"target": "kubernetes"}}}},
		"other cloud": {"clouds", map[string]any{"clouds": []map[string]any{{"target": "kubernetes"}}}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, h := stageFixture(t)
			state, diags := h.create(stageRes, stageConfig())
			wantNoError(t, diags)
			_, resp := h.plan(stageRes, state, h.config(stageRes, with(stageConfig(), tc.extra)))
			wantReplace(t, resp.RequiresReplace, tc.attr)
		})
	}
}

func TestStageDeleteAsksForResourcesOnlyWhenTold(t *testing.T) {
	for name, tc := range map[string]struct {
		extra map[string]any
		want  string
	}{
		"default":           {nil, "/projects/p1/stages/stg_staging"},
		"explicitly false":  {map[string]any{"delete_cloud_resources": false}, "/projects/p1/stages/stg_staging"},
		"delete the clouds": {map[string]any{"delete_cloud_resources": true}, "/projects/p1/stages/stg_staging?resources=true"},
	} {
		t.Run(name, func(t *testing.T) {
			fake, h := stageFixture(t)
			state, diags := h.create(stageRes, with(stageConfig(), tc.extra))
			wantNoError(t, diags)
			after, diags := h.apply(stageRes, state, h.null(stageRes), h.null(stageRes), nil)
			wantNoError(t, diags)
			if !after.IsNull() || len(fake.stageDeletes) != 1 || fake.stageDeletes[0] != tc.want {
				t.Fatalf("deletes = %v, after = %v", fake.stageDeletes, after)
			}
			// Already gone is fine.
			_, diags = h.apply(stageRes, state, h.null(stageRes), h.null(stageRes), nil)
			wantNoError(t, diags)
		})
	}
}

func TestStageDropsFromStateWhenGone(t *testing.T) {
	for name, change := range map[string]func(*fakeNBO){
		"stage deleted":   func(f *fakeNBO) { f.stages["p1"] = nil },
		"project deleted": func(f *fakeNBO) { delete(f.projects, "p1") },
	} {
		t.Run(name, func(t *testing.T) {
			fake, h := stageFixture(t)
			state, diags := h.create(stageRes, stageConfig())
			wantNoError(t, diags)
			change(fake)
			after, diags := h.read(stageRes, state)
			wantNoError(t, diags)
			if !after.IsNull() {
				t.Fatalf("state = %v", after)
			}
		})
	}
}

func TestStageReadSeesDashboardChanges(t *testing.T) {
	fake, h := stageFixture(t)
	state, diags := h.create(stageRes, stageConfig())
	wantNoError(t, diags)
	fake.stages["p1"][0].Branch = "hotfix"
	fake.stages["p1"][0].AutoDeploy = false
	refreshed, diags := h.read(stageRes, state)
	wantNoError(t, diags)
	if stringAttr(t, refreshed, "branch") != "hotfix" || boolAttr(t, refreshed, "auto_deploy") {
		t.Fatalf("state = %v", refreshed)
	}
	// A cloud added in the dashboard is not a reason to replace the environment.
	fake.stages["p1"][0].Environments = append(fake.stages["p1"][0].Environments, client.Environment{ID: "x", Name: "s-staging-k8s", Target: "kubernetes"})
	refreshed, diags = h.read(stageRes, refreshed)
	wantNoError(t, diags)
	_, resp := h.plan(stageRes, refreshed, h.config(stageRes, with(stageConfig(), map[string]any{"branch": "hotfix", "auto_deploy": false})))
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
}

func TestStageImport(t *testing.T) {
	fake, h := stageFixture(t)
	fake.stages["p1"] = []*client.Stage{{
		ID: "stg_qa", Name: "qa", Kind: "custom", Branch: "qa", AutoDeploy: true, Host: "qa--shop.example", URL: "http://qa--shop.example",
		Environments: []client.Environment{{ID: "e9", Name: "s-qa-cr", Target: "cloudrun", Config: client.EnvironmentConfig{Project: "acme-prod", Region: "us-central1", ArRepo: "r"}}},
	}}
	state, diags := h.read(stageRes, h.importState(stageRes, "p1/qa"))
	wantNoError(t, diags)
	if stringAttr(t, state, "id") != "stg_qa" || stringAttr(t, state, "project_id") != "p1" || stringAttr(t, state, "name") != "qa" || stringAttr(t, state, "branch") != "qa" {
		t.Fatalf("state = %v", state)
	}
	// Config says what NBO resolved only in part; the import must not plan a replacement.
	planned, resp := h.plan(stageRes, state, h.config(stageRes, map[string]any{
		"project_id": "p1", "name": "qa", "branch": "qa", "clouds": []map[string]any{{"target": "cloudrun", "mode": "auto"}},
	}))
	wantNoChange(t, state, planned, resp)

	wantError(t, h.importDiags(stageRes, "qa"), "<project id>/<name>")
}

func TestStageImportOfAMissingStageLeavesNothing(t *testing.T) {
	_, h := stageFixture(t)
	state, diags := h.read(stageRes, h.importState(stageRes, "p1/nope"))
	wantNoError(t, diags)
	if !state.IsNull() {
		t.Fatalf("state = %v", state)
	}
}

func TestStageNameValidation(t *testing.T) {
	h := newHarness(t)
	for _, bad := range []string{"Staging", "1st", "-a", "a-", "this-name-is-too-long", "production", "preview", "development", "pv-1", "fn", "a-fn-b", "fn-a", "a_b"} {
		diags := h.validate(stageRes, with(stageConfig(), map[string]any{"name": bad}))
		if !hasError(diags) {
			t.Errorf("name %q was accepted", bad)
		}
	}
	for _, good := range []string{"staging", "qa", "pre-prod", "a1", "func", "x-1-y"} {
		wantNoError(t, h.validate(stageRes, with(stageConfig(), map[string]any{"name": good})))
	}
	wantNoError(t, h.validate(stageRes, with(stageConfig(), map[string]any{"name": unknown})))
}

func TestStageCloudsAreChecked(t *testing.T) {
	h := newHarness(t)
	bad := with(stageConfig(), map[string]any{"clouds": []map[string]any{{"target": "cloudrun"}}})
	wantError(t, h.validate(stageRes, bad), "needs mode")
}

// The project lists its environments by name, so other resources can use their ids.
func TestProjectStagesAttributeHasNoDiffAfterRefresh(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	stages := func(v tftypes.Value) map[string]string {
		var raw map[string]tftypes.Value
		if err := attrOf(t, v, "stages").As(&raw); err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for k, e := range raw {
			var s string
			if err := e.As(&s); err != nil {
				t.Fatal(err)
			}
			out[k] = s
		}
		return out
	}
	if got := stages(state); got["production"] != "stg_production" || got["preview"] != "stg_preview" || got["development"] != "stg_development" || len(got) != 3 {
		t.Fatalf("stages = %v", got)
	}
	// An environment made elsewhere shows after the refresh, and then plans nothing.
	fake.stages["p1"] = []*client.Stage{{ID: "stg_qa", Name: "qa", Kind: "custom"}}
	refreshed, diags := h.read(res, state)
	wantNoError(t, diags)
	if got := stages(refreshed); got["qa"] != "stg_qa" {
		t.Fatalf("stages = %v", got)
	}
	planned, resp := h.plan(res, refreshed, h.config(res, shopConfig()))
	wantNoChange(t, refreshed, planned, resp)
}

func TestProjectDataSourceListsStages(t *testing.T) {
	fake := newFakeNBO(t)
	fake.add("p1", shopRequest())
	fake.stages["p1"] = []*client.Stage{{ID: "stg_qa", Name: "qa", Kind: "custom"}}
	h := connected(t, fake.server.URL)
	state, diags := h.readDataSource(res, map[string]any{"name": "shop"})
	wantNoError(t, diags)
	var raw map[string]tftypes.Value
	if err := attrOf(t, state, "stages").As(&raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["qa"]; !ok || len(raw) != 4 {
		t.Fatalf("stages = %v", raw)
	}
}
