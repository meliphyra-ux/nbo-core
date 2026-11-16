// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"strings"
	"testing"
	"time"

	"nbo/terraform-provider/internal/client"
)

func TestCreateAsksNBONotToBuild(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	_, diags := h.create(res, shopConfig())
	wantNoError(t, diags)
	if !fake.setups[0].SkipFirstBuild {
		t.Fatal("setup was not told to skip the first build")
	}
	if len(fake.builds) != 0 {
		t.Fatalf("builds = %v", fake.builds)
	}
}

func TestCreateWaitsOnlyForSetup(t *testing.T) {
	fake := newFakeNBO(t)
	fake.steps = []func(*client.ProjectSummary){func(*client.ProjectSummary) {}, func(*client.ProjectSummary) {}, setupFinished}
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)
	if n := fake.callCount("GET /projects/p1/summary"); n != 3 {
		t.Fatalf("polled %d times", n)
	}
	if got := stringAttr(t, state, "address"); got != "https://shop.example.net" {
		t.Fatalf("address = %q, want the one known after setup", got)
	}
}

func TestProjectHasNoDeployOptions(t *testing.T) {
	for _, a := range newHarness(t).schema.ResourceSchemas[res].Block.Attributes {
		if a.Name == "wait_for_deploy" || a.Name == "deploy_timeout" {
			t.Fatalf("%s is still in the schema", a.Name)
		}
	}
}

func TestSetupFailureIsAnErrorAndKeepsTheProjectInState(t *testing.T) {
	fake := newFakeNBO(t)
	fake.steps = []func(*client.ProjectSummary){func(s *client.ProjectSummary) {
		s.Project.SetupStatus = client.SetupNeedsSetup
		s.Project.SetupError = "Kubernetes is not connected"
	}}
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, shopConfig())
	wantError(t, diags, "Kubernetes is not connected")
	if state.IsNull() || stringAttr(t, state, "id") != "p1" || !state.IsFullyKnown() {
		t.Fatalf("state = %v", state)
	}
}

func TestSetupWaitHasALimit(t *testing.T) {
	limit := setupTimeout
	setupTimeout = 30 * time.Millisecond
	t.Cleanup(func() { setupTimeout = limit })

	fake := newFakeNBO(t)
	fake.steps = []func(*client.ProjectSummary){func(*client.ProjectSummary) {}}
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, shopConfig())
	wantError(t, diags, "30ms")
	if stringAttr(t, state, "id") != "p1" {
		t.Fatal("id missing from state")
	}
}

func TestSetupWaitSurvivesAPassingServerError(t *testing.T) {
	fake := newFakeNBO(t)
	fake.steps = []func(*client.ProjectSummary){setupFinished}
	fake.failReads = 2
	h := connected(t, fake.server.URL)

	_, diags := h.create(res, shopConfig())
	wantNoError(t, diags)
	if n := fake.callCount("GET /projects/p1/summary"); n != 3 {
		t.Fatalf("polled %d times", n)
	}
}

func TestSetupDeadlineNamesTheLastServerError(t *testing.T) {
	limit := setupTimeout
	setupTimeout = 20 * time.Millisecond
	t.Cleanup(func() { setupTimeout = limit })

	fake := newFakeNBO(t)
	fake.steps = []func(*client.ProjectSummary){setupFinished}
	fake.failReads = 1 << 30
	h := connected(t, fake.server.URL)

	_, diags := h.create(res, shopConfig())
	wantError(t, diags, "restarting")
}

func TestSetupWaitStopsWhenTheProjectIsGone(t *testing.T) {
	fake := newFakeNBO(t)
	fake.steps = []func(*client.ProjectSummary){func(s *client.ProjectSummary) { delete(fake.projects, s.Project.ID) }, setupFinished}
	h := connected(t, fake.server.URL)

	// The step deletes during the first poll, so the second one answers 404.
	state, diags := h.create(res, shopConfig())
	wantError(t, diags, "project not found")
	if stringAttr(t, state, "id") != "p1" {
		t.Fatal("id missing from state")
	}
}

// clouds is a set, so Terraform's order means nothing, while NBO gives the
// first one crons and first traffic.
func TestCloudsAreSentInAFixedOrder(t *testing.T) {
	configs := [][]map[string]any{
		{{"target": "kubernetes", "cluster_id": "kc_b"}, {"target": "cloudrun", "mode": "auto"}, {"target": "kubernetes", "cluster_id": "kc_a"}},
		{{"target": "kubernetes", "cluster_id": "kc_a"}, {"target": "kubernetes", "cluster_id": "kc_b"}, {"target": "cloudrun", "mode": "auto"}},
	}
	for _, clouds := range configs {
		fake := newFakeNBO(t)
		h := connected(t, fake.server.URL)
		_, diags := h.create(res, with(shopConfig(), map[string]any{"clouds": clouds}))
		wantNoError(t, diags)

		got := fake.setups[0].Clouds
		if got[0].Target != "cloudrun" || got[1].ClusterID != "kc_a" || got[2].ClusterID != "kc_b" {
			t.Fatalf("clouds = %+v", got)
		}
	}
}

func TestReservedVariableNamesFailAtPlanTime(t *testing.T) {
	h := newHarness(t)
	for _, name := range []string{"NBO_TOKEN", "PORT", "K_SERVICE", "K_REVISION", "K_CONFIGURATION", "NEXT_ADAPTER_PATH"} {
		wantError(t, h.validate(envRes, map[string]any{"name": name, "value": "1"}), "reserved")
	}
	long := make([]byte, 257)
	for i := range long {
		long[i] = 'A'
	}
	wantError(t, h.validate(envRes, map[string]any{"name": string(long), "value": "1"}), "256")
	wantNoError(t, h.validate(envRes, map[string]any{"name": "NBOX", "value": "1"}))
	wantNoError(t, h.validate(envRes, map[string]any{"name": unknown, "value": "1"}))
}

func TestSetupOutcomeWaitingForKey(t *testing.T) {
	s := &client.ProjectSummary{}
	s.Project.SetupStatus = client.SetupWaitingForKey
	s.Project.SetupError = "Permission denied (publickey)"
	done, err := setupOutcome(s)
	if !done {
		t.Fatal("waiting-for-key must end the wait")
	}
	if err == nil || !strings.Contains(err.Error(), "deploy key") || !strings.Contains(err.Error(), "Permission denied (publickey)") {
		t.Fatalf("err = %v", err)
	}
}
