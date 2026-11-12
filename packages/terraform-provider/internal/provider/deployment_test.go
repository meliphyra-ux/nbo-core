// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"nbo/terraform-provider/internal/client"
)

const deployRes = "nbo_deployment"

const headSha = "0123456789012345678901234567890123456789"

func (f *fakeNBO) startBuild(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if f.projectMissing(w, id) {
		return
	}
	if f.startRefusal != "" {
		writeError(w, http.StatusConflict, f.startRefusal)
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.buildBodies = append(f.buildBodies, body)
	b := f.newBuild(id, client.BuildQueued)
	if name, _ := body["stage"].(string); name != "" {
		b.StageID = f.stageID(id, name)
	}
	writeJSON(w, http.StatusAccepted, b)
}

// newBuild records a build, as a queue would.
func (f *fakeNBO) newBuild(projectID, status string) *client.Build {
	b := &client.Build{ID: fmt.Sprintf("build%d", len(f.builds)+1), ProjectID: projectID, Revision: headSha, Status: status, Kind: "build"}
	f.builds = append(f.builds, b)
	return b
}

func (f *fakeNBO) listBuilds(w http.ResponseWriter, r *http.Request) {
	out := []*client.Build{}
	for _, b := range f.builds {
		if b.ProjectID == r.PathValue("id") {
			out = append(out, b)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (f *fakeNBO) getBuild(w http.ResponseWriter, r *http.Request) {
	if f.failBuildReads > 0 {
		f.failBuildReads--
		writeError(w, http.StatusServiceUnavailable, "restarting")
		return
	}
	for _, b := range f.builds {
		if b.ID == r.PathValue("id") {
			if len(f.buildSteps) > 0 {
				f.buildSteps[0](b)
				if len(f.buildSteps) > 1 {
					f.buildSteps = f.buildSteps[1:]
				}
			}
			writeJSON(w, http.StatusOK, b)
			return
		}
	}
	writeError(w, http.StatusNotFound, "build not found")
}

func running(b *client.Build) {
	b.Status = client.BuildRunning
}

func succeeded(b *client.Build) {
	b.Status = client.BuildSucceeded
	b.DeploymentIDs = []string{"dep1"}
}

func deployFixture(t *testing.T, steps ...func(*client.Build)) (*fakeNBO, *harness) {
	t.Helper()
	fake := newFakeNBO(t)
	fake.add("p1", shopRequest())
	fake.buildSteps = steps
	return fake, connected(t, fake.server.URL)
}

func deployConfig(trigger string) map[string]any {
	return map[string]any{"project_id": "p1", "triggers": map[string]string{"variables": trigger}}
}

func TestDeploymentBuildsAndWaits(t *testing.T) {
	fake, h := deployFixture(t, running, running, succeeded)

	state, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)
	if n := fake.callCount("POST /projects/p1/builds"); n != 1 {
		t.Fatalf("started %d builds", n)
	}
	if n := fake.callCount("GET /builds/build1"); n != 3 {
		t.Fatalf("polled %d times", n)
	}
	if stringAttr(t, state, "id") != "build1" || stringAttr(t, state, "status") != "succeeded" || stringAttr(t, state, "commit") != headSha {
		t.Fatalf("state = %v", state)
	}
	if got := stringAttr(t, state, "timeout"); got != "20m" {
		t.Fatalf("timeout = %q", got)
	}
}

func TestDeploymentFailures(t *testing.T) {
	cases := []struct {
		name  string
		step  func(*client.Build)
		extra map[string]any
		want  string
	}{
		{name: "build failed", want: "pnpm build exited 1", step: func(b *client.Build) {
			b.Status, b.Error = client.BuildFailed, "pnpm build exited 1"
		}},
		// The runner marks a build failed when any cloud failed, and lists them.
		{name: "one cloud failed", want: "cloudrun: quota exceeded", step: func(b *client.Build) {
			b.Status, b.Error, b.DeploymentIDs = client.BuildFailed, "cloudrun: quota exceeded", []string{"dep1", "dep2"}
		}},
		{name: "deployed nowhere", want: "no cloud set to deploy", step: func(b *client.Build) {
			b.Status, b.Note = client.BuildSucceeded, "Built, no cloud set to deploy new commits automatically"
		}},
		{name: "skipped with nothing after it", want: "skipped", step: func(b *client.Build) {
			b.Status = client.BuildSkipped
		}},
		{name: "timed out", want: "50ms", step: running, extra: map[string]any{"timeout": "50ms"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, h := deployFixture(t, tc.step)
			state, diags := h.create(deployRes, with(deployConfig("a"), tc.extra))
			wantError(t, diags, tc.want)
			if state.IsNull() || stringAttr(t, state, "id") != "build1" || !state.IsFullyKnown() {
				t.Fatalf("state = %v", state)
			}
			text := diagText(diags)
			if strings.Contains(text, "untaint") || strings.Contains(text, "wait_for_deploy") {
				t.Fatalf("stale advice: %s", text)
			}
		})
	}
}

func TestDeploymentFailureRecordsTheFailedStatus(t *testing.T) {
	_, h := deployFixture(t, func(b *client.Build) { b.Status, b.Error = client.BuildFailed, "boom" })
	state, _ := h.create(deployRes, deployConfig("a"))
	if got := stringAttr(t, state, "status"); got != "failed" {
		t.Fatalf("status = %q", got)
	}
}

func TestDeploymentFollowsTheBuildThatReplacedIt(t *testing.T) {
	fake, h := deployFixture(t)
	// A newer commit reached the queue first: NBO replaces the queued build.
	fake.buildSteps = []func(*client.Build){
		func(b *client.Build) {
			b.Status, b.Error = client.BuildSkipped, "superseded by a newer build"
			newer := fake.newBuild("p1", client.BuildRunning)
			newer.Revision = strings.Repeat("a", 40)
		},
		succeeded,
	}
	state, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)
	if stringAttr(t, state, "id") != "build2" || stringAttr(t, state, "commit") != strings.Repeat("a", 40) || stringAttr(t, state, "status") != "succeeded" {
		t.Fatalf("state = %v", state)
	}
	if n := fake.callCount("POST /projects/p1/builds"); n != 1 {
		t.Fatalf("started %d builds", n)
	}
}

func TestDeploymentDoesNotFollowAPromoteJob(t *testing.T) {
	fake, h := deployFixture(t)
	fake.buildSteps = []func(*client.Build){func(b *client.Build) {
		b.Status = client.BuildSkipped
		fake.newBuild("p1", client.BuildRunning).Kind = "promote"
	}}
	_, diags := h.create(deployRes, deployConfig("a"))
	wantError(t, diags, "skipped")
}

// A build already running stays; ours queues behind it and has the variables.
func TestDeploymentQueuesBehindARunningBuild(t *testing.T) {
	fake, h := deployFixture(t, func(b *client.Build) {}, running, succeeded)
	fake.newBuild("p1", client.BuildRunning)

	state, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)
	if stringAttr(t, state, "id") != "build2" {
		t.Fatalf("state = %v", state)
	}
}

func TestDeploymentWaitSurvivesAPassingServerError(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	fake.failBuildReads = 2
	_, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)
}

func TestDeploymentStartRefusedLeavesNoState(t *testing.T) {
	fake, h := deployFixture(t)
	fake.startRefusal = "could not read the head of main"
	state, diags := h.create(deployRes, deployConfig("a"))
	wantError(t, diags, "could not read the head of main")
	if !state.IsNull() {
		t.Fatalf("state = %v", state)
	}
}

func TestDeploymentPlanAfterCreateIsEmpty(t *testing.T) {
	for name, attrs := range map[string]map[string]any{
		"with triggers":    deployConfig("a"),
		"without triggers": {"project_id": "p1"},
	} {
		t.Run(name, func(t *testing.T) {
			_, h := deployFixture(t, succeeded)
			state, diags := h.create(deployRes, attrs)
			wantNoError(t, diags)
			refreshed, diags := h.read(deployRes, state)
			wantNoError(t, diags)
			planned, resp := h.plan(deployRes, refreshed, h.config(deployRes, attrs))
			wantNoChange(t, refreshed, planned, resp)
		})
	}
}

func TestDeploymentReplacements(t *testing.T) {
	cases := map[string]struct {
		attr string
		from map[string]any
		to   map[string]any
	}{
		"trigger changes": {"triggers", deployConfig("a"), deployConfig("b")},
		"first trigger":   {"triggers", map[string]any{"project_id": "p1"}, deployConfig("a")},
		"project changes": {"project_id", deployConfig("a"), with(deployConfig("a"), map[string]any{"project_id": "p2"})},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, h := deployFixture(t, succeeded)
			state, diags := h.create(deployRes, tc.from)
			wantNoError(t, diags)
			_, resp := h.plan(deployRes, state, h.config(deployRes, tc.to))
			wantReplace(t, resp.RequiresReplace, tc.attr)
		})
	}
}

func TestDeploymentTimeoutChangesInPlaceAndCallsNothing(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	state, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)

	config := h.config(deployRes, with(deployConfig("a"), map[string]any{"timeout": "1h"}))
	planned, resp := h.plan(deployRes, state, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
	calls := len(fake.calls)
	after, diags := h.apply(deployRes, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if len(fake.calls) != calls {
		t.Fatalf("calls: %v", fake.calls[calls:])
	}
	if diffs, _ := planned.Diff(after); len(diffs) > 0 {
		t.Fatalf("apply result differs from the plan: %v", diffs)
	}
}

func TestDeploymentReadKeepsStateWhenTheBuildIsCleanedUp(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	state, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)

	fake.builds = nil
	after, diags := h.read(deployRes, state)
	wantNoError(t, diags)
	if diffs, _ := state.Diff(after); len(diffs) > 0 {
		t.Fatalf("state changed: %v", diffs)
	}
}

func TestDeploymentDropsFromStateWhenTheProjectIsGone(t *testing.T) {
	for name, keepBuilds := range map[string]bool{"builds gone too": false, "build row left": true} {
		t.Run(name, func(t *testing.T) {
			fake, h := deployFixture(t, succeeded)
			state, diags := h.create(deployRes, deployConfig("a"))
			wantNoError(t, diags)

			delete(fake.projects, "p1")
			if !keepBuilds {
				fake.builds = nil
			}
			after, diags := h.read(deployRes, state)
			wantNoError(t, diags)
			if !after.IsNull() {
				t.Fatalf("state = %v", after)
			}
		})
	}
}

func TestDeploymentDeleteMakesNoCall(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	state, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)

	calls := len(fake.calls)
	after, diags := h.apply(deployRes, state, h.null(deployRes), h.null(deployRes), nil)
	wantNoError(t, diags)
	if !after.IsNull() {
		t.Fatalf("state = %v", after)
	}
	if len(fake.calls) != calls {
		t.Fatalf("calls: %v", fake.calls[calls:])
	}
}

// An import can't know the triggers, and that must not rebuild.
func TestDeploymentImport(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	fake.newBuild("p1", client.BuildSucceeded)

	state, diags := h.read(deployRes, h.importState(deployRes, "build1"))
	wantNoError(t, diags)
	if stringAttr(t, state, "project_id") != "p1" || stringAttr(t, state, "commit") != headSha || stringAttr(t, state, "timeout") != "20m" {
		t.Fatalf("state = %v", state)
	}
	config := h.config(deployRes, deployConfig("a"))
	planned, resp := h.plan(deployRes, state, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
	starts := fake.callCount("POST ")
	_, diags = h.apply(deployRes, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if fake.callCount("POST ") != starts {
		t.Fatal("the import started a build")
	}
}

func TestDeploymentImportOfAMissingBuildLeavesNothing(t *testing.T) {
	_, h := deployFixture(t)
	state, diags := h.read(deployRes, h.importState(deployRes, "nope"))
	wantNoError(t, diags)
	if !state.IsNull() {
		t.Fatalf("state = %v", state)
	}
}

func TestDeploymentValidation(t *testing.T) {
	h := newHarness(t)
	wantError(t, h.validate(deployRes, with(deployConfig("a"), map[string]any{"timeout": "soon"})), "timeout")
	wantError(t, h.validate(deployRes, with(deployConfig("a"), map[string]any{"timeout": "0s"})), "timeout")
	wantNoError(t, h.validate(deployRes, with(deployConfig("a"), map[string]any{"timeout": "1h30m"})))
	wantNoError(t, h.validate(deployRes, with(deployConfig("a"), map[string]any{"timeout": unknown})))
}
