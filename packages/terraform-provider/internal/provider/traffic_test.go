// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"encoding/json"
	"math/big"
	"net/http"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"nbo/terraform-provider/internal/client"
)

const trafficRes = "nbo_traffic"

// putTraffic applies only the weights sent, as store.ts setTrafficWeights does.
func (f *fakeNBO) putTraffic(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if f.projectMissing(w, id) {
		return
	}
	if f.trafficRefusal != "" {
		writeError(w, http.StatusConflict, f.trafficRefusal)
		return
	}
	var body struct {
		Stage   string           `json:"stage"`
		Weights map[string]int64 `json:"weights"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.trafficPuts = append(f.trafficPuts, body.Weights)
	f.trafficStages = append(f.trafficStages, body.Stage)
	envs := f.projects[id].Environments
	if body.Stage != "" && body.Stage != "production" {
		envs = nil
		for _, st := range f.stages[id] {
			if st.Name == body.Stage {
				envs = st.Environments
			}
		}
	}
	for i := range envs {
		if weight, sent := body.Weights[envs[i].ID]; sent {
			envs[i].TrafficWeight = weight
		}
	}
	s := f.projects[id]
	writeJSON(w, http.StatusOK, map[string]any{"host": s.Project.EdgeHost})
}

// trafficFixture has one project on k8s (env0, 100%) and cloudrun (env1, 0%).
func trafficFixture(t *testing.T) (*fakeNBO, *harness) {
	t.Helper()
	fake := newFakeNBO(t)
	r := shopRequest()
	r.Clouds = []client.Cloud{{Target: "kubernetes"}, {Target: "cloudrun", Mode: "auto"}}
	fake.add("p1", r).Environments[0].TrafficWeight = 100
	return fake, connected(t, fake.server.URL)
}

func split(weights map[string]int) map[string]any {
	return map[string]any{"project_id": "p1", "weights": weights}
}

func weightsOf(t *testing.T, state tftypes.Value) map[string]int64 {
	t.Helper()
	var raw map[string]tftypes.Value
	if err := attrOf(t, state, "weights").As(&raw); err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	for k, v := range raw {
		var n big.Float
		if err := v.As(&n); err != nil {
			t.Fatal(err)
		}
		i, _ := n.Int64()
		out[k] = i
	}
	return out
}

func TestTrafficSendsEveryEnvironmentByID(t *testing.T) {
	fake, h := trafficFixture(t)
	state, diags := h.create(trafficRes, split(map[string]int{"k8s": 90, "cloudrun": 10}))
	wantNoError(t, diags)

	if len(fake.trafficPuts) != 1 || fake.trafficPuts[0]["env0"] != 90 || fake.trafficPuts[0]["env1"] != 10 {
		t.Fatalf("puts = %v", fake.trafficPuts)
	}
	if stringAttr(t, state, "id") != "p1" {
		t.Fatalf("state = %v", state)
	}
}

// NBO leaves unsent environments alone, so leaving one out must mean zero.
func TestTrafficLeftOutEnvironmentGoesToZero(t *testing.T) {
	fake, h := trafficFixture(t)
	_, diags := h.create(trafficRes, split(map[string]int{"cloudrun": 100}))
	wantNoError(t, diags)
	if got := fake.trafficPuts[0]; len(got) != 2 || got["env0"] != 0 || got["env1"] != 100 {
		t.Fatalf("put = %v", got)
	}
}

func TestTrafficUnknownEnvironmentNamesTheOnesThatExist(t *testing.T) {
	fake, h := trafficFixture(t)
	_, diags := h.create(trafficRes, split(map[string]int{"k8s-eu": 100}))
	wantError(t, diags, "k8s-eu")
	wantError(t, diags, "cloudrun")
	if len(fake.trafficPuts) != 0 {
		t.Fatalf("puts = %v", fake.trafficPuts)
	}
}

func TestTrafficWeightsMustAddUpAtPlanTime(t *testing.T) {
	h := newHarness(t)
	wantError(t, h.validate(trafficRes, split(map[string]int{"k8s": 90, "cloudrun": 20})), "100")
	wantError(t, h.validate(trafficRes, split(map[string]int{"k8s": 150, "cloudrun": -50})), "weights")
	wantNoError(t, h.validate(trafficRes, split(map[string]int{"k8s": 100, "cloudrun": 0})))
	wantNoError(t, h.validate(trafficRes, map[string]any{"project_id": "p1", "weights": unknown}))
}

func TestTrafficConflictShowsNBOsMessage(t *testing.T) {
	fake, h := trafficFixture(t)
	state, diags := h.create(trafficRes, split(map[string]int{"k8s": 100}))
	wantNoError(t, diags)

	fake.trafficRefusal = "a transfer is moving traffic right now"
	config := h.config(trafficRes, split(map[string]int{"k8s": 50, "cloudrun": 50}))
	planned, resp := h.plan(trafficRes, state, config)
	_, diags = h.apply(trafficRes, state, planned, config, resp.PlannedPrivate)
	wantError(t, diags, "a transfer is moving traffic right now")
}

func TestTrafficUpdatesInPlace(t *testing.T) {
	fake, h := trafficFixture(t)
	state, diags := h.create(trafficRes, split(map[string]int{"k8s": 100, "cloudrun": 0}))
	wantNoError(t, diags)

	config := h.config(trafficRes, split(map[string]int{"k8s": 50, "cloudrun": 50}))
	planned, resp := h.plan(trafficRes, state, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
	after, diags := h.apply(trafficRes, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if got := weightsOf(t, after); got["k8s"] != 50 || got["cloudrun"] != 50 {
		t.Fatalf("weights = %v", got)
	}
	if fake.projects["p1"].Environments[1].TrafficWeight != 50 {
		t.Fatal("not applied")
	}
}

func TestTrafficZeroEntriesShowNoDiff(t *testing.T) {
	for name, weights := range map[string]map[string]int{
		"zero spelled out": {"k8s": 100, "cloudrun": 0},
		"zero left out":    {"k8s": 100},
	} {
		t.Run(name, func(t *testing.T) {
			_, h := trafficFixture(t)
			state, diags := h.create(trafficRes, split(weights))
			wantNoError(t, diags)
			refreshed, diags := h.read(trafficRes, state)
			wantNoError(t, diags)
			planned, resp := h.plan(trafficRes, refreshed, h.config(trafficRes, split(weights)))
			wantNoChange(t, refreshed, planned, resp)
		})
		t.Run(name+" after import", func(t *testing.T) {
			_, h := trafficFixture(t)
			state, diags := h.read(trafficRes, h.importState(trafficRes, "p1"))
			wantNoError(t, diags)
			if stringAttr(t, state, "project_id") != "p1" {
				t.Fatalf("state = %v", state)
			}
			planned, resp := h.plan(trafficRes, state, h.config(trafficRes, split(weights)))
			wantNoChange(t, state, planned, resp)
		})
	}
}

func TestTrafficReadSeesAChangedSplit(t *testing.T) {
	fake, h := trafficFixture(t)
	attrs := split(map[string]int{"k8s": 100})
	state, diags := h.create(trafficRes, attrs)
	wantNoError(t, diags)

	fake.projects["p1"].Environments[0].TrafficWeight = 40
	fake.projects["p1"].Environments[1].TrafficWeight = 60
	refreshed, diags := h.read(trafficRes, state)
	wantNoError(t, diags)
	if got := weightsOf(t, refreshed); got["k8s"] != 40 || got["cloudrun"] != 60 {
		t.Fatalf("weights = %v", got)
	}
	planned, _ := h.plan(trafficRes, refreshed, h.config(trafficRes, attrs))
	if got := weightsOf(t, planned); got["k8s"] != 100 {
		t.Fatalf("planned = %v", got)
	}
}

func TestTrafficDropsFromStateWhenTheProjectIsGone(t *testing.T) {
	fake, h := trafficFixture(t)
	state, diags := h.create(trafficRes, split(map[string]int{"k8s": 100}))
	wantNoError(t, diags)
	delete(fake.projects, "p1")
	after, diags := h.read(trafficRes, state)
	wantNoError(t, diags)
	if !after.IsNull() {
		t.Fatalf("state = %v", after)
	}
}

func TestTrafficDeleteMakesNoCall(t *testing.T) {
	fake, h := trafficFixture(t)
	state, diags := h.create(trafficRes, split(map[string]int{"k8s": 100}))
	wantNoError(t, diags)

	calls := len(fake.calls)
	after, diags := h.apply(trafficRes, state, h.null(trafficRes), h.null(trafficRes), nil)
	wantNoError(t, diags)
	if !after.IsNull() {
		t.Fatalf("state = %v", after)
	}
	if len(fake.calls) != calls {
		t.Fatalf("calls: %v", fake.calls[calls:])
	}
}

func TestTrafficProjectChangeReplaces(t *testing.T) {
	_, h := trafficFixture(t)
	state, diags := h.create(trafficRes, split(map[string]int{"k8s": 100}))
	wantNoError(t, diags)
	_, resp := h.plan(trafficRes, state, h.config(trafficRes, map[string]any{"project_id": "p2", "weights": map[string]int{"k8s": 100}}))
	wantReplace(t, resp.RequiresReplace, "project_id")
}
