// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"nbo/terraform-provider/internal/client"
)

// Variables, deployments, domains and traffic of one environment.

func TestEnvVarOfAStageGoesToThatStage(t *testing.T) {
	fake, h := envFixture(t)
	state, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "API_URL", "value": "https://s", "stage": "staging"})
	wantNoError(t, diags)

	if got := fake.stageVars[stageVarKey("p1", "staging", "API_URL")]; got.value != "https://s" {
		t.Fatalf("stored %+v", fake.stageVars)
	}
	if _, inProduction := fake.vars["p1"]["API_URL"]; inProduction {
		t.Fatal("the variable landed in Production")
	}
	if !strings.HasSuffix(fake.envPuts[0].uri, "?stage=staging") {
		t.Fatalf("uri = %s", fake.envPuts[0].uri)
	}
	if stringAttr(t, state, "id") != "p1/staging/API_URL" || stringAttr(t, state, "stage") != "staging" {
		t.Fatalf("state = %v", state)
	}
}

// Left out, the stage is Production: ids and requests stay as they were.
func TestEnvVarStageDefaultsToProduction(t *testing.T) {
	fake, h := envFixture(t)
	state, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "1"})
	wantNoError(t, diags)
	if stringAttr(t, state, "stage") != "production" || stringAttr(t, state, "id") != "p1/A" {
		t.Fatalf("state = %v", state)
	}
	if got := fake.vars["p1"]["A"]; got.value != "1" {
		t.Fatalf("stored %+v", fake.vars)
	}
	// Spelling the default out is no change.
	planned, resp := h.plan(envRes, state, h.config(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "1", "stage": "production"}))
	wantNoChange(t, state, planned, resp)
}

// State written before environments existed has no stage.
func TestEnvVarFromOlderStateDoesNotReplace(t *testing.T) {
	_, h := envFixture(t)
	state, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "1"})
	wantNoError(t, diags)
	old := withAttr(t, state, "stage", tftypes.NewValue(tftypes.String, nil))
	_, resp := h.plan(envRes, old, h.config(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "1"}))
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
}

func withAttr(t *testing.T, v tftypes.Value, name string, to tftypes.Value) tftypes.Value {
	t.Helper()
	var attrs map[string]tftypes.Value
	if err := v.As(&attrs); err != nil {
		t.Fatal(err)
	}
	attrs[name] = to
	return tftypes.NewValue(v.Type(), attrs)
}

func TestEnvVarSameNameInTwoStagesAreTwoVariables(t *testing.T) {
	fake, h := envFixture(t)
	fake.vars["p1"] = map[string]storedVar{"API_URL": {value: "https://prod"}}
	fake.stageVars[stageVarKey("p1", "staging", "API_URL")] = storedVar{value: "https://stage"}

	staging, diags := h.read(envRes, h.importState(envRes, "p1/staging/API_URL"))
	wantNoError(t, diags)
	if stringAttr(t, staging, "value") != "https://stage" || stringAttr(t, staging, "stage") != "staging" {
		t.Fatalf("staging = %v", staging)
	}
	production, diags := h.read(envRes, h.importState(envRes, "p1/API_URL"))
	wantNoError(t, diags)
	if stringAttr(t, production, "value") != "https://prod" || stringAttr(t, production, "stage") != "production" {
		t.Fatalf("production = %v", production)
	}
}

func TestEnvVarFourImportForms(t *testing.T) {
	for _, tc := range []struct {
		id, project, stage, wantID string
	}{
		{"p1/A", "p1", "production", "p1/A"},
		{"p1/staging/A", "p1", "staging", "p1/staging/A"},
		{"p1/production/A", "p1", "production", "p1/A"},
		{"p1/*/A", "p1", "*", "p1/*/A"},
		{"workspace/A", "", "production", "workspace/A"},
		{"workspace/preview/A", "", "preview", "workspace/preview/A"},
		{"workspace/*/A", "", "*", "workspace/*/A"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			fake, h := envFixture(t)
			scope := tc.project
			stage := tc.stage
			if stage == "production" {
				if fake.vars[scope] == nil {
					fake.vars[scope] = map[string]storedVar{}
				}
				fake.vars[scope]["A"] = storedVar{value: "v"}
			} else {
				fake.stageVars[stageVarKey(scope, stage, "A")] = storedVar{value: "v"}
			}
			state, diags := h.read(envRes, h.importState(envRes, tc.id))
			wantNoError(t, diags)
			if state.IsNull() {
				t.Fatal("not found")
			}
			if stringAttr(t, state, "project_id") != tc.project || stringAttr(t, state, "stage") != tc.stage ||
				stringAttr(t, state, "id") != tc.wantID || stringAttr(t, state, "value") != "v" {
				t.Fatalf("state = %v", state)
			}
		})
	}
	_, h := envFixture(t)
	wantError(t, h.importDiags(envRes, "p1/a/b/C"), "workspace/<stage>/<name>")
}

func TestEnvVarStageChangeReplaces(t *testing.T) {
	_, h := envFixture(t)
	base := map[string]any{"project_id": "p1", "name": "A", "value": "1", "stage": "staging"}
	state, diags := h.create(envRes, base)
	wantNoError(t, diags)
	_, resp := h.plan(envRes, state, h.config(envRes, with(base, map[string]any{"stage": "qa"})))
	wantReplace(t, resp.RequiresReplace, "stage")
}

func TestEnvVarDeclareOnlyHasNoValue(t *testing.T) {
	fake, h := envFixture(t)
	fake.namesOnly = true
	attrs := map[string]any{"project_id": "p1", "name": "DB_URL", "secret": true, "stage": "staging"}
	wantNoError(t, h.validate(envRes, attrs))

	state, diags := h.create(envRes, attrs)
	wantNoError(t, diags)
	put := fake.envPuts[0]
	if _, sent := put.body["value"]; sent || put.body["secret"] != true {
		t.Fatalf("body = %v", put.body)
	}
	if !attrOf(t, state, "value").IsNull() {
		t.Fatalf("state = %v", state)
	}
	refreshed, diags := h.read(envRes, state)
	wantNoError(t, diags)
	planned, resp := h.plan(envRes, refreshed, h.config(envRes, attrs))
	wantNoChange(t, refreshed, planned, resp)
}

// Declaring a name without a value would erase the value an NBO that stores
// values holds, so it is refused before anything is written.
func TestEnvVarDeclareOnlyIsRefusedWhenNBOStoresValues(t *testing.T) {
	fake, h := envFixture(t)
	attrs := map[string]any{"project_id": "p1", "name": "DB_URL", "secret": true}

	state, diags := h.create(envRes, attrs)
	wantError(t, diags, "stores variable values")
	if !state.IsNull() || len(fake.envPuts) != 0 {
		t.Fatalf("state = %v, puts = %v", state, fake.envPuts)
	}

	// Update: a value taken out of config must not wipe it either.
	created, diags := h.create(envRes, with(attrs, map[string]any{"value": "s3cret"}))
	wantNoError(t, diags)
	puts := len(fake.envPuts)
	config := h.config(envRes, attrs)
	planned, resp := h.plan(envRes, created, config)
	_, diags = h.apply(envRes, created, planned, config, resp.PlannedPrivate)
	wantError(t, diags, "stores variable values")
	if len(fake.envPuts) != puts || fake.vars["p1"]["DB_URL"].value != "s3cret" {
		t.Fatalf("a write got through: %v", fake.vars["p1"])
	}
}

func TestEnvVarValueStaysEmptyWhenNBOKeepsNoValues(t *testing.T) {
	fake, h := envFixture(t)
	state, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "1"})
	wantNoError(t, diags)
	// NBO stopped storing values: the name stays, the value is gone.
	fake.vars["p1"]["A"] = storedVar{declared: true}
	refreshed, diags := h.read(envRes, state)
	wantNoError(t, diags)
	if stringAttr(t, refreshed, "value") != "1" {
		t.Fatalf("state lost its value: %v", refreshed)
	}
}

func TestEnvVarSecretMayNotBeEmptyButMayBeLeftOut(t *testing.T) {
	h := newHarness(t)
	wantError(t, h.validate(envRes, map[string]any{"name": "A", "value": "", "secret": true}), "empty")
	wantNoError(t, h.validate(envRes, map[string]any{"name": "A", "secret": true}))
}

// Deployments.

func TestDeploymentSendsStageAndValues(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	fake.stages["p1"] = []*client.Stage{{ID: "stg_staging", Name: "staging", Kind: "custom", Branch: "develop"}}
	state, diags := h.create(deployRes, with(deployConfig("a"), map[string]any{
		"stage": "staging", "values": map[string]string{"DB_URL": "postgres://u:p@h/db", "API_KEY": "k-12345678"},
	}))
	wantNoError(t, diags)
	if len(fake.buildBodies) != 1 {
		t.Fatalf("bodies = %v", fake.buildBodies)
	}
	body := fake.buildBodies[0]
	values, _ := body["values"].(map[string]any)
	if body["stage"] != "staging" || values["DB_URL"] != "postgres://u:p@h/db" || values["API_KEY"] != "k-12345678" {
		t.Fatalf("body = %v", body)
	}
	if stringAttr(t, state, "stage") != "staging" {
		t.Fatalf("state = %v", state)
	}
}

func TestDeploymentWithoutStageOrValuesSendsNoBody(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	state, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)
	if fake.buildBodies[0] != nil {
		t.Fatalf("body = %v", fake.buildBodies[0])
	}
	if stringAttr(t, state, "stage") != "production" {
		t.Fatalf("state = %v", state)
	}
}

func TestDeploymentValuesAreSensitive(t *testing.T) {
	seen := false
	for _, a := range newHarness(t).schema.ResourceSchemas[deployRes].Block.Attributes {
		if a.Name == "values" || a.Name == "values_wo" {
			seen = true
			if !a.Sensitive {
				t.Errorf("%s is not sensitive", a.Name)
			}
		}
		if a.Name == "values_wo" && !a.WriteOnly {
			t.Error("values_wo must be write-only")
		}
	}
	if !seen {
		t.Fatal("no values attribute")
	}
}

func TestDeploymentChangedValuesPlanReplacement(t *testing.T) {
	_, h := deployFixture(t, succeeded)
	base := with(deployConfig("a"), map[string]any{"values": map[string]string{"A": "one"}})
	state, diags := h.create(deployRes, base)
	wantNoError(t, diags)

	for name, values := range map[string]map[string]string{
		"changed value": {"A": "two"},
		"added name":    {"A": "one", "B": "x"},
	} {
		_, resp := h.plan(deployRes, state, h.config(deployRes, with(base, map[string]any{"values": values})))
		if len(resp.RequiresReplace) == 0 {
			t.Errorf("%s did not plan a replacement", name)
		}
	}
	planned, resp := h.plan(deployRes, state, h.config(deployRes, base))
	wantNoChange(t, state, planned, resp)
}

func TestDeploymentStageChangeReplaces(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	fake.stages["p1"] = []*client.Stage{{ID: "stg_staging", Name: "staging", Kind: "custom"}}
	state, diags := h.create(deployRes, deployConfig("a"))
	wantNoError(t, diags)
	_, resp := h.plan(deployRes, state, h.config(deployRes, with(deployConfig("a"), map[string]any{"stage": "staging"})))
	wantReplace(t, resp.RequiresReplace, "stage")
}

// Values never reach a diagnostic, whether NBO echoes them or not.
func TestDeploymentValuesNeverAppearInDiagnostics(t *testing.T) {
	const secret = "s3cr3t-value-123"
	cfg := with(deployConfig("a"), map[string]any{"values": map[string]string{"DB_URL": secret}})

	t.Run("start refused", func(t *testing.T) {
		fake, h := deployFixture(t)
		fake.startRefusal = "could not use " + secret
		_, diags := h.create(deployRes, cfg)
		wantError(t, diags, "could not use")
		if strings.Contains(diagText(diags), secret) {
			t.Fatalf("diagnostics leak the value: %s", diagText(diags))
		}
	})
	t.Run("build failed", func(t *testing.T) {
		_, h := deployFixture(t, func(b *client.Build) {
			b.Status, b.Error, b.Note = client.BuildFailed, "connecting to "+secret+" failed", "tried "+secret
		})
		_, diags := h.create(deployRes, cfg)
		wantError(t, diags, "connecting to")
		if strings.Contains(diagText(diags), secret) {
			t.Fatalf("diagnostics leak the value: %s", diagText(diags))
		}
	})
}

func TestDeploymentWriteOnlyValuesAreSentButNotKept(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	cfg := with(deployConfig("a"), map[string]any{"values_wo": map[string]string{"DB_URL": "wo-value-1"}, "values_wo_version": "1"})
	state, diags := h.create(deployRes, cfg)
	wantNoError(t, diags)

	values, _ := fake.buildBodies[0]["values"].(map[string]any)
	if values["DB_URL"] != "wo-value-1" {
		t.Fatalf("body = %v", fake.buildBodies[0])
	}
	if !attrOf(t, state, "values_wo").IsNull() || strings.Contains(state.String(), "wo-value-1") {
		t.Fatalf("a write-only value is in state: %v", state)
	}
	// Changing the value alone is invisible to Terraform; the version says "deploy again".
	refreshed, diags := h.read(deployRes, state)
	wantNoError(t, diags)
	planned, resp := h.plan(deployRes, refreshed, h.config(deployRes, with(cfg, map[string]any{"values_wo": map[string]string{"DB_URL": "other"}})))
	wantNoChange(t, refreshed, planned, resp)
	_, resp = h.plan(deployRes, refreshed, h.config(deployRes, with(cfg, map[string]any{"values_wo_version": "2"})))
	wantReplace(t, resp.RequiresReplace, "values_wo_version")
}

func TestDeploymentValuesAndWriteOnlyValuesExcludeEachOther(t *testing.T) {
	h := newHarness(t)
	wantError(t, h.validate(deployRes, with(deployConfig("a"), map[string]any{
		"values": map[string]string{"A": "1"}, "values_wo": map[string]string{"B": "2"},
	})), "values_wo")
	wantNoError(t, h.validate(deployRes, with(deployConfig("a"), map[string]any{"values_wo": map[string]string{"B": "2"}})))
}

// A build of another environment that arrives is not this one's replacement.
func TestDeploymentFollowsOnlyBuildsOfItsOwnStage(t *testing.T) {
	fake, h := deployFixture(t)
	fake.stages["p1"] = []*client.Stage{{ID: "stg_staging", Name: "staging", Kind: "custom"}}
	fake.buildSteps = []func(*client.Build){func(b *client.Build) {
		b.Status = client.BuildSkipped
		fake.newBuild("p1", client.BuildRunning) // a production build: another environment
	}}
	_, diags := h.create(deployRes, with(deployConfig("a"), map[string]any{"stage": "staging"}))
	wantError(t, diags, "skipped")
}

func TestDeploymentImportFindsItsStage(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	fake.stages["p1"] = []*client.Stage{{ID: "stg_staging", Name: "staging", Kind: "custom"}}
	b := fake.newBuild("p1", client.BuildSucceeded)
	b.StageID = "stg_staging"
	state, diags := h.read(deployRes, h.importState(deployRes, b.ID))
	wantNoError(t, diags)
	if stringAttr(t, state, "stage") != "staging" {
		t.Fatalf("state = %v", state)
	}
}

// The import can't know values, and that must not rebuild.
func TestDeploymentImportThenValuesDoesNotReplace(t *testing.T) {
	fake, h := deployFixture(t, succeeded)
	fake.newBuild("p1", client.BuildSucceeded)
	state, diags := h.read(deployRes, h.importState(deployRes, "build1"))
	wantNoError(t, diags)
	_, resp := h.plan(deployRes, state, h.config(deployRes, with(deployConfig("a"), map[string]any{"values": map[string]string{"A": "1"}})))
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
}

// Domains.

func TestDomainOfAStageSendsAndKeepsTheStage(t *testing.T) {
	fake, h := domainFixture(t)
	attrs := map[string]any{"project_id": "p1", "host": "staging.example.com", "stage": "staging"}
	state, diags := h.create(domainRes, attrs)
	wantNoError(t, diags)
	if len(fake.domainStages) != 1 || fake.domainStages[0] != "staging" || stringAttr(t, state, "stage") != "staging" {
		t.Fatalf("stages = %v, state = %v", fake.domainStages, state)
	}
	refreshed, diags := h.read(domainRes, state)
	wantNoError(t, diags)
	planned, resp := h.plan(domainRes, refreshed, h.config(domainRes, attrs))
	wantNoChange(t, refreshed, planned, resp)

	_, resp = h.plan(domainRes, refreshed, h.config(domainRes, with(attrs, map[string]any{"stage": "qa"})))
	wantReplace(t, resp.RequiresReplace, "stage")
}

func TestDomainStageDefaultsToProduction(t *testing.T) {
	fake, h := domainFixture(t)
	attrs := map[string]any{"project_id": "p1", "host": "www.example.com"}
	state, diags := h.create(domainRes, attrs)
	wantNoError(t, diags)
	if fake.domainStages[0] != "" || stringAttr(t, state, "stage") != "production" {
		t.Fatalf("stages = %v, state = %v", fake.domainStages, state)
	}
	planned, resp := h.plan(domainRes, state, h.config(domainRes, attrs))
	wantNoChange(t, state, planned, resp)
}

func TestDomainImportLearnsItsStage(t *testing.T) {
	fake, h := domainFixture(t)
	fake.domains["p1"] = []client.Domain{{ID: "dom_9", Host: "s.example.com", Status: "active", Serving: "edge", Stage: "staging", Record: client.DNSRecord{Type: "A", Name: "s.example.com", Value: "203.0.113.9"}}}
	state, diags := h.read(domainRes, h.importState(domainRes, "p1/s.example.com"))
	wantNoError(t, diags)
	if stringAttr(t, state, "stage") != "staging" {
		t.Fatalf("state = %v", state)
	}
	planned, resp := h.plan(domainRes, state, h.config(domainRes, map[string]any{"project_id": "p1", "host": "s.example.com", "stage": "staging"}))
	wantNoChange(t, state, planned, resp)
}

// Traffic.

func trafficStageFixture(t *testing.T) (*fakeNBO, *harness) {
	t.Helper()
	fake, h := trafficFixture(t)
	fake.stages["p1"] = []*client.Stage{{ID: "stg_staging", Name: "staging", Kind: "custom", Environments: []client.Environment{
		{ID: "se0", Name: "s-staging-cr", Target: "cloudrun", TrafficWeight: 100},
		{ID: "se1", Name: "s-staging-k8s", Target: "kubernetes"},
	}}}
	return fake, h
}

func stageSplit(weights map[string]int) map[string]any {
	return map[string]any{"project_id": "p1", "stage": "staging", "weights": weights}
}

func TestTrafficOfAStageUsesThatStagesEnvironments(t *testing.T) {
	fake, h := trafficStageFixture(t)
	state, diags := h.create(trafficRes, stageSplit(map[string]int{"s-staging-cr": 70, "s-staging-k8s": 30}))
	wantNoError(t, diags)

	if len(fake.trafficPuts) != 1 || fake.trafficStages[0] != "staging" || fake.trafficPuts[0]["se0"] != 70 || fake.trafficPuts[0]["se1"] != 30 || len(fake.trafficPuts[0]) != 2 {
		t.Fatalf("puts = %v stages = %v", fake.trafficPuts, fake.trafficStages)
	}
	if fake.projects["p1"].Environments[0].TrafficWeight != 100 {
		t.Fatal("Production's split changed")
	}
	if stringAttr(t, state, "id") != "p1/staging" || stringAttr(t, state, "stage") != "staging" {
		t.Fatalf("state = %v", state)
	}
	// Production's names are not this stage's.
	_, diags = h.create(trafficRes, stageSplit(map[string]int{"k8s": 100}))
	wantError(t, diags, "s-staging-cr")
}

func TestTrafficOfAStageReadsThatStagesSplit(t *testing.T) {
	fake, h := trafficStageFixture(t)
	attrs := stageSplit(map[string]int{"s-staging-cr": 100})
	state, diags := h.create(trafficRes, attrs)
	wantNoError(t, diags)
	refreshed, diags := h.read(trafficRes, state)
	wantNoError(t, diags)
	planned, resp := h.plan(trafficRes, refreshed, h.config(trafficRes, attrs))
	wantNoChange(t, refreshed, planned, resp)

	fake.stages["p1"][0].Environments[0].TrafficWeight = 40
	fake.stages["p1"][0].Environments[1].TrafficWeight = 60
	refreshed, diags = h.read(trafficRes, refreshed)
	wantNoError(t, diags)
	if got := weightsOf(t, refreshed); got["s-staging-cr"] != 40 || got["s-staging-k8s"] != 60 {
		t.Fatalf("weights = %v", got)
	}
}

func TestTrafficStageImportAndReplace(t *testing.T) {
	_, h := trafficStageFixture(t)
	state, diags := h.read(trafficRes, h.importState(trafficRes, "p1/staging"))
	wantNoError(t, diags)
	if stringAttr(t, state, "project_id") != "p1" || stringAttr(t, state, "stage") != "staging" || stringAttr(t, state, "id") != "p1/staging" {
		t.Fatalf("state = %v", state)
	}
	planned, resp := h.plan(trafficRes, state, h.config(trafficRes, stageSplit(map[string]int{"s-staging-cr": 100})))
	wantNoChange(t, state, planned, resp)

	_, resp = h.plan(trafficRes, state, h.config(trafficRes, with(stageSplit(map[string]int{"s-staging-cr": 100}), map[string]any{"stage": "qa"})))
	wantReplace(t, resp.RequiresReplace, "stage")
}

func TestTrafficStageDefaultsToProduction(t *testing.T) {
	fake, h := trafficFixture(t)
	state, diags := h.create(trafficRes, split(map[string]int{"k8s": 100}))
	wantNoError(t, diags)
	if fake.trafficStages[0] != "" || stringAttr(t, state, "stage") != "production" || stringAttr(t, state, "id") != "p1" {
		t.Fatalf("stages = %v, state = %v", fake.trafficStages, state)
	}
	planned, resp := h.plan(trafficRes, state, h.config(trafficRes, split(map[string]int{"k8s": 100})))
	wantNoChange(t, state, planned, resp)
}
