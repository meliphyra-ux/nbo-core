// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"strings"
	"testing"
	"time"

	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"nbo/terraform-provider/internal/client"
)

const res = "nbo_project"

func TestMain(m *testing.M) {
	pollInterval = time.Millisecond
	m.Run()
}

func shopRequest() client.SetupRequest {
	return client.SetupRequest{
		Name: "shop", Repo: "https://example.com/shop.git", ProductionBranch: "main", Framework: "static", BuildCommand: "pnpm build",
		Clouds: []client.Cloud{{Target: "kubernetes"}},
	}
}

// shopConfig is the HCL a person would write for shopRequest.
func shopConfig() map[string]any {
	return map[string]any{
		"name": "shop", "repo_url": "https://example.com/shop.git", "branch": "main", "framework": "static", "build_command": "pnpm build",
		"clouds": []map[string]any{{"target": "kubernetes"}},
	}
}

func with(base map[string]any, extra map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// setupFinished is what NBO reports once the clouds are ready: no build yet.
func setupFinished(s *client.ProjectSummary) {
	s.Project.SetupStatus = client.SetupReady
	s.DomainURL = "https://shop.example.net"
}

func TestCreatePostsTheSetupBody(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, with(shopConfig(), map[string]any{
		"framework": "static", "spa": true, "output_dir": "build", "root_directory": "apps/web", "ignored_build_step_command": "git diff --quiet",
		"clouds": []map[string]any{
			{"target": "cloudrun", "mode": "manual", "region": "europe-west1", "project": "acme-prod", "ar_repo": "europe-west1-docker.pkg.dev/acme-prod/nbo"},
			{"target": "kubernetes", "cluster_id": "kc_abc"},
		},
	}))
	wantNoError(t, diags)

	if len(fake.setups) != 1 {
		t.Fatalf("setups = %d", len(fake.setups))
	}
	got := fake.setups[0]
	if got.Name != "shop" || got.Repo != "https://example.com/shop.git" || got.ProductionBranch != "main" || got.Framework != "static" ||
		got.BuildCommand != "pnpm build" || !got.Spa || got.OutputDir != "build" || got.RootDirectory != "apps/web" || got.IgnoredBuildStepCommand != "git diff --quiet" {
		t.Fatalf("setup body = %+v", got)
	}
	var run, kube *client.Cloud
	for i := range got.Clouds {
		if got.Clouds[i].Target == "cloudrun" {
			run = &got.Clouds[i]
		} else {
			kube = &got.Clouds[i]
		}
	}
	if run == nil || kube == nil || kube.ClusterID != "kc_abc" || run.Mode != "manual" || run.Region != "europe-west1" ||
		run.Project != "acme-prod" || run.ArRepo != "europe-west1-docker.pkg.dev/acme-prod/nbo" {
		t.Fatalf("clouds = %+v", got.Clouds)
	}
	if stringAttr(t, state, "id") != "p1" || stringAttr(t, state, "address") != "http://shop.example" {
		t.Fatalf("state = %v", state)
	}
	if len(fake.patches) != 0 {
		t.Fatalf("no setting asked to differ, yet patched: %v", fake.patches)
	}
}

func TestCreateFillsWhatNBOChose(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)
	if got := stringAttr(t, state, "output_dir"); got != "dist" {
		t.Fatalf("output_dir = %q", got)
	}
	if !boolAttr(t, state, "polling_enabled") || boolAttr(t, state, "speed_insights") {
		t.Fatalf("state = %v", state)
	}
}

func TestCreateAppliesSettingsSetupDoesNotTake(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, with(shopConfig(), map[string]any{"polling_enabled": false, "speed_insights": true, "speed_insights_sample_rate": 25}))
	wantNoError(t, diags)
	if len(fake.patches) != 1 {
		t.Fatalf("patches = %v", fake.patches)
	}
	p := fake.patches[0]
	if len(p) != 3 || p["pollingEnabled"] != false || p["speedInsights"] != true || p["speedInsightsSampleRate"] != float64(25) {
		t.Fatalf("patch = %v", p)
	}
	if boolAttr(t, state, "polling_enabled") {
		t.Fatal("polling_enabled should be off")
	}
}

func TestCreateErrorLeavesNoState(t *testing.T) {
	fake := newFakeNBO(t)
	fake.add("p0", shopRequest())
	h := connected(t, fake.server.URL)

	state, diags := h.create(res, shopConfig())
	wantError(t, diags, "already exists")
	if !state.IsNull() {
		t.Fatalf("state = %v", state)
	}
}

func TestReadDropsAProjectDeletedInTheDashboard(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	delete(fake.projects, "p1")
	after, diags := h.read(res, state)
	wantNoError(t, diags)
	if !after.IsNull() {
		t.Fatalf("state = %v", after)
	}
}

func TestReadShowsAnyOtherErrorAsAnError(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	fake.server.Close()
	_, diags = h.read(res, state)
	if !hasError(diags) {
		t.Fatal("want an error")
	}
}

func TestPlanAfterCreateIsEmpty(t *testing.T) {
	configs := map[string]map[string]any{
		"static defaults":     shopConfig(),
		"next, no output dir": with(shopConfig(), map[string]any{"framework": "nextjs"}),
		"everything set": with(shopConfig(), map[string]any{
			"spa": true, "output_dir": "build", "root_directory": "apps/web", "ignored_build_step_command": "true",
			"polling_enabled": false, "speed_insights": true, "speed_insights_inject": false, "speed_insights_sample_rate": 50,
			"delete_cloud_resources": true,
		}),
		"cloud run auto": with(shopConfig(), map[string]any{"clouds": []map[string]any{{"target": "cloudrun", "mode": "auto"}}}),
		"lambda":         with(shopConfig(), map[string]any{"clouds": []map[string]any{{"target": "lambda"}}}),
	}
	for name, attrs := range configs {
		t.Run(name, func(t *testing.T) {
			fake := newFakeNBO(t)
			h := connected(t, fake.server.URL)
			state, diags := h.create(res, attrs)
			wantNoError(t, diags)

			refreshed, diags := h.read(res, state)
			wantNoError(t, diags)
			planned, resp := h.plan(res, refreshed, h.config(res, attrs))
			wantNoChange(t, refreshed, planned, resp)
		})
	}
}

// Review focus 3: an import must not plan changes, let alone a replacement.
func TestPlanAfterImportIsEmpty(t *testing.T) {
	cases := map[string]struct {
		request client.SetupRequest
		config  map[string]any
	}{
		"kubernetes, cluster filled in by NBO": {
			request: func() client.SetupRequest {
				r := shopRequest()
				r.Clouds = []client.Cloud{{Target: "kubernetes", ClusterID: "kc_only"}}
				return r
			}(),
			config: shopConfig(),
		},
		"cloud run auto": {
			request: func() client.SetupRequest {
				r := shopRequest()
				r.Clouds = []client.Cloud{{Target: "cloudrun", Mode: "auto"}}
				return r
			}(),
			config: with(shopConfig(), map[string]any{"clouds": []map[string]any{{"target": "cloudrun", "mode": "auto"}}}),
		},
		"cloud run with a region, and kubernetes": {
			request: func() client.SetupRequest {
				r := shopRequest()
				r.Clouds = []client.Cloud{{Target: "kubernetes"}, {Target: "cloudrun", Mode: "auto", Region: "europe-west1"}}
				return r
			}(),
			config: with(shopConfig(), map[string]any{"clouds": []map[string]any{
				{"target": "cloudrun", "mode": "auto", "region": "europe-west1"}, {"target": "kubernetes"},
			}}),
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			fake := newFakeNBO(t)
			fake.add("p9", tc.request)
			h := connected(t, fake.server.URL)

			state, diags := h.read(res, h.importState(res, "p9"))
			wantNoError(t, diags)
			if stringAttr(t, state, "id") != "p9" || stringAttr(t, state, "name") != "shop" {
				t.Fatalf("state = %v", state)
			}
			planned, resp := h.plan(res, state, h.config(res, tc.config))
			wantNoChange(t, state, planned, resp)
		})
	}
}

func TestImportedCloudThatTrulyDiffersPlansReplacement(t *testing.T) {
	fake := newFakeNBO(t)
	r := shopRequest()
	r.Clouds = []client.Cloud{{Target: "cloudrun", Mode: "auto", Region: "us-central1"}}
	fake.add("p9", r)
	h := connected(t, fake.server.URL)

	state, diags := h.read(res, h.importState(res, "p9"))
	wantNoError(t, diags)
	config := with(shopConfig(), map[string]any{"clouds": []map[string]any{{"target": "cloudrun", "mode": "auto", "region": "europe-west1"}}})
	_, resp := h.plan(res, state, h.config(res, config))
	wantReplace(t, resp.RequiresReplace, "clouds")
}

func TestImportOfAMissingProjectLeavesNothing(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.read(res, h.importState(res, "nope"))
	wantNoError(t, diags)
	if !state.IsNull() {
		t.Fatalf("state = %v", state)
	}
}

func TestDashboardChangesToUnmanagedSettingsShowNoDiff(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	fake.projects["p1"].Project.SpeedInsights = true
	fake.projects["p1"].DomainURL = "https://www.shop.example"
	refreshed, diags := h.read(res, state)
	wantNoError(t, diags)
	if !boolAttr(t, refreshed, "speed_insights") {
		t.Fatal("read did not pick up speed_insights")
	}
	if got := stringAttr(t, refreshed, "address"); got != "https://www.shop.example" {
		t.Fatalf("address = %q", got)
	}
	planned, resp := h.plan(res, refreshed, h.config(res, shopConfig()))
	wantNoChange(t, refreshed, planned, resp)
}

func TestDashboardChangeToAManagedSettingIsCorrected(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	attrs := with(shopConfig(), map[string]any{"polling_enabled": true})
	state, diags := h.create(res, attrs)
	wantNoError(t, diags)

	fake.projects["p1"].Project.PollingEnabled = false
	refreshed, diags := h.read(res, state)
	wantNoError(t, diags)
	config := h.config(res, attrs)
	planned, resp := h.plan(res, refreshed, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
	_, diags = h.apply(res, refreshed, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if !fake.projects["p1"].Project.PollingEnabled {
		t.Fatal("not corrected")
	}
}

func TestUpdatePatchesOnlyWhatChanged(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	attrs := with(shopConfig(), map[string]any{"speed_insights": true, "speed_insights_sample_rate": 10})
	config := h.config(res, attrs)
	planned, resp := h.plan(res, state, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
	after, diags := h.apply(res, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if len(fake.patches) != 1 || len(fake.patches[0]) != 2 || fake.patches[0]["speedInsights"] != true || fake.patches[0]["speedInsightsSampleRate"] != float64(10) {
		t.Fatalf("patches = %v", fake.patches)
	}
	if diffs, _ := planned.Diff(after); len(diffs) > 0 {
		t.Fatalf("apply result differs from the plan: %v", diffs)
	}
}

func TestChangingOnlyProviderOptionsCallsNothing(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	config := h.config(res, with(shopConfig(), map[string]any{"delete_cloud_resources": true}))
	planned, resp := h.plan(res, state, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
	calls := len(fake.calls)
	after, diags := h.apply(res, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if len(fake.calls) != calls {
		t.Fatalf("calls: %v", fake.calls[calls:])
	}
	if !boolAttr(t, after, "delete_cloud_resources") {
		t.Fatal("not saved")
	}
}

func TestUpdateErrorShowsNBOsMessage(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	delete(fake.projects, "p1")
	config := h.config(res, with(shopConfig(), map[string]any{"polling_enabled": false}))
	planned, resp := h.plan(res, state, config)
	_, diags = h.apply(res, state, planned, config, resp.PlannedPrivate)
	wantError(t, diags, "project not found")
}

func TestChangingCloudsPlansReplacement(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	for name, clouds := range map[string][]map[string]any{
		"another cloud": {{"target": "kubernetes"}, {"target": "cloudrun", "mode": "auto"}},
		"different one": {{"target": "cloudrun", "mode": "auto"}},
	} {
		t.Run(name, func(t *testing.T) {
			_, resp := h.plan(res, state, h.config(res, with(shopConfig(), map[string]any{"clouds": clouds})))
			wantReplace(t, resp.RequiresReplace, "clouds")
		})
	}
}

func TestChangingARegionOnACreatedCloudPlansReplacement(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	clouds := func(region any) map[string]any {
		return with(shopConfig(), map[string]any{"clouds": []map[string]any{{"target": "cloudrun", "mode": "auto", "region": region}}})
	}
	state, diags := h.create(res, clouds(nil))
	wantNoError(t, diags)
	_, resp := h.plan(res, state, h.config(res, clouds("europe-west1")))
	wantReplace(t, resp.RequiresReplace, "clouds")
}

func TestCloudOrderDoesNotMatter(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	a := []map[string]any{{"target": "kubernetes"}, {"target": "cloudrun", "mode": "auto"}}
	b := []map[string]any{{"target": "cloudrun", "mode": "auto"}, {"target": "kubernetes"}}
	state, diags := h.create(res, with(shopConfig(), map[string]any{"clouds": a}))
	wantNoError(t, diags)
	planned, resp := h.plan(res, state, h.config(res, with(shopConfig(), map[string]any{"clouds": b})))
	wantNoChange(t, state, planned, resp)
}

func TestACloudAddedInTheDashboardDoesNotReplaceTheProject(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)

	s := fake.projects["p1"]
	s.Environments = append(s.Environments, client.Environment{ID: "e2", Name: "cloudrun", Target: "cloudrun"})
	refreshed, diags := h.read(res, state)
	wantNoError(t, diags)
	planned, resp := h.plan(res, refreshed, h.config(res, shopConfig()))
	wantNoChange(t, refreshed, planned, resp)
}

func TestDeleteAsksForCloudResourcesOnlyWhenTold(t *testing.T) {
	for _, tc := range []struct {
		flag any
		want string
	}{{nil, "/projects/p1"}, {false, "/projects/p1"}, {true, "/projects/p1?resources=true"}} {
		fake := newFakeNBO(t)
		h := connected(t, fake.server.URL)
		state, diags := h.create(res, with(shopConfig(), map[string]any{"delete_cloud_resources": tc.flag}))
		wantNoError(t, diags)

		after, diags := h.apply(res, state, h.null(res), h.null(res), nil)
		wantNoError(t, diags)
		if !after.IsNull() {
			t.Fatalf("state = %v", after)
		}
		if len(fake.deletes) != 1 || fake.deletes[0] != tc.want {
			t.Fatalf("deletes = %v, want %s", fake.deletes, tc.want)
		}
	}
}

func TestDeletingAProjectAlreadyGoneSucceeds(t *testing.T) {
	fake := newFakeNBO(t)
	h := connected(t, fake.server.URL)
	state, diags := h.create(res, shopConfig())
	wantNoError(t, diags)
	delete(fake.projects, "p1")

	_, diags = h.apply(res, state, h.null(res), h.null(res), nil)
	wantNoError(t, diags)
}

func TestValidation(t *testing.T) {
	cases := []struct {
		name  string
		extra map[string]any
		want  string
	}{
		{"name shape", map[string]any{"name": "Shop_1"}, "name"},
		{"repo not https", map[string]any{"repo_url": "git@example.com:a.git"}, "repo_url"},
		{"unknown framework", map[string]any{"framework": "vue"}, "framework"},
		{"output_dir on nextjs", map[string]any{"framework": "nextjs", "output_dir": "out"}, "output_dir"},
		{"root_directory not plain", map[string]any{"root_directory": "./web/"}, `"web"`},
		{"empty root_directory", map[string]any{"root_directory": ""}, "root_directory"},
		{"empty ignored command", map[string]any{"ignored_build_step_command": ""}, "ignored_build_step_command"},
		{"sample rate", map[string]any{"speed_insights_sample_rate": 33}, "speed_insights_sample_rate"},
		{"no clouds", map[string]any{"clouds": []map[string]any{}}, "clouds"},
		{"unknown target", map[string]any{"clouds": []map[string]any{{"target": "azure"}}}, "target"},
		{"lambda with region", map[string]any{"clouds": []map[string]any{{"target": "lambda", "region": "eu-west-1"}}}, "region"},
		{"cloud run without mode", map[string]any{"clouds": []map[string]any{{"target": "cloudrun"}}}, "mode"},
		{"manual without project", map[string]any{"clouds": []map[string]any{{"target": "cloudrun", "mode": "manual", "region": "us-central1"}}}, "project"},
		{"auto with project", map[string]any{"clouds": []map[string]any{{"target": "cloudrun", "mode": "auto", "project": "acme-prod"}}}, "project"},
		{"kubernetes with region", map[string]any{"clouds": []map[string]any{{"target": "kubernetes", "region": "us-central1"}}}, "region"},
		{"cloud run with cluster", map[string]any{"clouds": []map[string]any{{"target": "cloudrun", "mode": "auto", "cluster_id": "kc_a"}}}, "cluster_id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wantError(t, newHarness(t).validate(res, with(shopConfig(), tc.extra)), tc.want)
		})
	}
}

func TestValidationAcceptsWhatNBOAccepts(t *testing.T) {
	h := newHarness(t)
	wantNoError(t, h.validate(res, shopConfig()))
	wantNoError(t, h.validate(res, with(shopConfig(), map[string]any{
		"root_directory": ".config/web",
		"clouds": []map[string]any{
			{"target": "cloudrun", "mode": "manual", "project": "acme-prod", "region": "us-central1", "ar_repo": "us-central1-docker.pkg.dev/acme-prod/nbo"},
			{"target": "kubernetes", "cluster_id": "kc_a"},
			{"target": "lambda"},
		},
	})))
}

func TestValidationWaitsForUnknownValues(t *testing.T) {
	h := newHarness(t)
	wantNoError(t, h.validate(res, with(shopConfig(), map[string]any{
		"framework": unknown, "output_dir": "out", "root_directory": unknown, "clouds": unknown,
	})))
	wantNoError(t, h.validate(res, with(shopConfig(), map[string]any{
		"clouds": []map[string]any{{"target": "cloudrun", "mode": unknown, "project": unknown}},
	})))
}

func wantReplace(t *testing.T, paths []*tftypes.AttributePath, name string) {
	t.Helper()
	var seen []string
	for _, p := range paths {
		seen = append(seen, p.String())
		if strings.Contains(p.String(), `"`+name+`"`) {
			return
		}
	}
	t.Fatalf("no replacement for %s, got %v", name, seen)
}

func TestDataSourceFindsByName(t *testing.T) {
	fake := newFakeNBO(t)
	other := shopRequest()
	other.Name = "blog"
	fake.add("p1", other)
	r := shopRequest()
	r.Clouds = []client.Cloud{{Target: "cloudrun", Mode: "auto"}, {Target: "kubernetes", ClusterID: "kc_a"}}
	fake.add("p2", r)
	h := connected(t, fake.server.URL)

	state, diags := h.readDataSource(res, map[string]any{"name": "shop"})
	wantNoError(t, diags)
	if stringAttr(t, state, "id") != "p2" || stringAttr(t, state, "address") != "http://shop.example" || stringAttr(t, state, "repo_url") != r.Repo ||
		stringAttr(t, state, "branch") != "main" || stringAttr(t, state, "output_dir") != "dist" || !boolAttr(t, state, "polling_enabled") {
		t.Fatalf("state = %v", state)
	}
	var clouds []tftypes.Value
	if err := attrOf(t, state, "clouds").As(&clouds); err != nil {
		t.Fatal(err)
	}
	if len(clouds) != 2 {
		t.Fatalf("clouds = %v", clouds)
	}
}

func TestDataSourceErrorsWhenNothingMatches(t *testing.T) {
	fake := newFakeNBO(t)
	fake.add("p1", shopRequest())
	h := connected(t, fake.server.URL)
	_, diags := h.readDataSource(res, map[string]any{"name": "missing"})
	wantError(t, diags, `"missing"`)
}
