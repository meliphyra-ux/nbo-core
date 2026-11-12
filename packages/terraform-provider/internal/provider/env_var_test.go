// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const envRes = "nbo_env_var"

// storedVar is one variable in the fake; value is what NBO holds. declared is
// a name kept without a value.
type storedVar struct {
	value    string
	secret   bool
	declared bool
}

func scopeOf(r *http.Request) string {
	return r.PathValue("id") // empty for the workspace
}

func (f *fakeNBO) projectMissing(w http.ResponseWriter, scope string) bool {
	if _, ok := f.projects[scope]; scope != "" && !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return true
	}
	return false
}

// stageVarKey addresses a variable of a stage other than Production.
func stageVarKey(scope, stage, name string) string {
	return scope + "\x00" + stage + "\x00" + name
}

// envStage is the stage a variable request names: "" for Production.
func envStage(r *http.Request) string {
	stage := r.URL.Query().Get("stage")
	if stage == "production" {
		return ""
	}
	return stage
}

// lookupVar finds a variable of the requested stage.
func (f *fakeNBO) lookupVar(scope, stage, name string) (storedVar, bool) {
	if stage == "" {
		v, ok := f.vars[scope][name]
		return v, ok
	}
	v, ok := f.stageVars[stageVarKey(scope, stage, name)]
	return v, ok
}

// listEnv answers as env-vars.ts does: a secret has no value, a project's
// list includes the workspace's variables, marked inherited, and every row
// carries its stage.
func (f *fakeNBO) listEnv(w http.ResponseWriter, r *http.Request) {
	scope := scopeOf(r)
	if f.projectMissing(w, scope) {
		return
	}
	out := []map[string]any{}
	view := func(name, stage string, v storedVar) map[string]any {
		m := map[string]any{"name": name, "secret": v.secret, "stage": stage, "hasValue": !v.declared}
		if !v.secret && !v.declared {
			m["value"] = v.value
		}
		return m
	}
	for name, v := range f.vars[scope] {
		out = append(out, view(name, "production", v))
	}
	for key, v := range f.stageVars {
		parts := strings.SplitN(key, "\x00", 3)
		if parts[0] == scope {
			out = append(out, view(parts[2], parts[1], v))
		}
	}
	if scope != "" {
		for name, v := range f.vars[""] {
			if _, own := f.vars[scope][name]; !own {
				m := view(name, "production", v)
				m["inherited"] = true
				out = append(out, m)
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (f *fakeNBO) putEnv(w http.ResponseWriter, r *http.Request) {
	scope := scopeOf(r)
	if f.projectMissing(w, scope) {
		return
	}
	var body map[string]any
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		writeError(w, http.StatusBadRequest, "the request body must be JSON")
		return
	}
	f.envPuts = append(f.envPuts, envPut{uri: r.URL.RequestURI(), body: body})
	secret, hasSecret := body["secret"].(bool)
	value, hasValue := body["value"].(string)
	if _, sent := body["value"]; sent && !hasValue {
		writeError(w, http.StatusBadRequest, "value must be a string")
		return
	}
	if !hasSecret {
		writeError(w, http.StatusBadRequest, "secret must be true or false")
		return
	}
	name, stage := r.PathValue("name"), envStage(r)
	if existing, ok := f.lookupVar(scope, stage, name); ok && existing.secret && !secret {
		writeError(w, http.StatusBadRequest, "variable is secret and cannot be made plain; delete it and add it again")
		return
	}
	v := storedVar{value: value, secret: secret, declared: !hasValue}
	if stage == "" {
		if f.vars[scope] == nil {
			f.vars[scope] = map[string]storedVar{}
		}
		f.vars[scope][name] = v
	} else {
		f.stageVars[stageVarKey(scope, stage, name)] = v
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "secret": secret})
}

func (f *fakeNBO) deleteEnv(w http.ResponseWriter, r *http.Request) {
	scope, name, stage := scopeOf(r), r.PathValue("name"), envStage(r)
	if f.projectMissing(w, scope) {
		return
	}
	if _, ok := f.lookupVar(scope, stage, name); !ok {
		writeError(w, http.StatusNotFound, "variable not found")
		return
	}
	if stage == "" {
		delete(f.vars[scope], name)
	} else {
		delete(f.stageVars, stageVarKey(scope, stage, name))
	}
	w.WriteHeader(http.StatusNoContent)
}

func envFixture(t *testing.T) (*fakeNBO, *harness) {
	t.Helper()
	fake := newFakeNBO(t)
	fake.add("p1", shopRequest())
	return fake, connected(t, fake.server.URL)
}

func TestEnvVarCreatesInEachScope(t *testing.T) {
	fake, h := envFixture(t)

	state, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "API_URL", "value": "https://a"})
	wantNoError(t, diags)
	if got := fake.vars["p1"]["API_URL"]; got.value != "https://a" || got.secret {
		t.Fatalf("stored %+v", got)
	}
	if stringAttr(t, state, "id") != "p1/API_URL" || boolAttr(t, state, "secret") {
		t.Fatalf("state = %v", state)
	}

	state, diags = h.create(envRes, map[string]any{"name": "API_URL", "value": "https://w", "secret": true})
	wantNoError(t, diags)
	if got := fake.vars[""]["API_URL"]; got.value != "https://w" || !got.secret {
		t.Fatalf("stored %+v", got)
	}
	if stringAttr(t, state, "id") != "workspace/API_URL" {
		t.Fatalf("state = %v", state)
	}
}

func TestEnvVarValueIsSensitive(t *testing.T) {
	for _, a := range newHarness(t).schema.ResourceSchemas[envRes].Block.Attributes {
		if a.Name == "value" && !a.Sensitive {
			t.Fatal("value is not sensitive")
		}
	}
}

func TestEnvVarSecretReadKeepsTheStateValue(t *testing.T) {
	_, h := envFixture(t)
	attrs := map[string]any{"project_id": "p1", "name": "TOKEN", "value": "s3cret", "secret": true}
	state, diags := h.create(envRes, attrs)
	wantNoError(t, diags)

	refreshed, diags := h.read(envRes, state)
	wantNoError(t, diags)
	if got := stringAttr(t, refreshed, "value"); got != "s3cret" {
		t.Fatalf("value = %q", got)
	}
	planned, resp := h.plan(envRes, refreshed, h.config(envRes, attrs))
	wantNoChange(t, refreshed, planned, resp)
}

func TestEnvVarPlainReadSeesDashboardChanges(t *testing.T) {
	fake, h := envFixture(t)
	attrs := map[string]any{"project_id": "p1", "name": "API_URL", "value": "https://a"}
	state, diags := h.create(envRes, attrs)
	wantNoError(t, diags)

	fake.vars["p1"]["API_URL"] = storedVar{value: "https://changed"}
	refreshed, diags := h.read(envRes, state)
	wantNoError(t, diags)
	if got := stringAttr(t, refreshed, "value"); got != "https://changed" {
		t.Fatalf("value = %q", got)
	}
}

func TestEnvVarEmptyPlainValueShowsNoDiff(t *testing.T) {
	_, h := envFixture(t)
	attrs := map[string]any{"project_id": "p1", "name": "EMPTY", "value": ""}
	state, diags := h.create(envRes, attrs)
	wantNoError(t, diags)
	refreshed, diags := h.read(envRes, state)
	wantNoError(t, diags)
	planned, resp := h.plan(envRes, refreshed, h.config(envRes, attrs))
	wantNoChange(t, refreshed, planned, resp)
}

func TestEnvVarUpdatesInPlace(t *testing.T) {
	fake, h := envFixture(t)
	state, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "1"})
	wantNoError(t, diags)

	config := h.config(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "2", "secret": true})
	planned, resp := h.plan(envRes, state, config)
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("replace: %v", resp.RequiresReplace)
	}
	_, diags = h.apply(envRes, state, planned, config, resp.PlannedPrivate)
	wantNoError(t, diags)
	if got := fake.vars["p1"]["A"]; got.value != "2" || !got.secret {
		t.Fatalf("stored %+v", got)
	}
}

func TestEnvVarReplacements(t *testing.T) {
	base := map[string]any{"project_id": "p1", "name": "A", "value": "1", "secret": true}
	cases := map[string]struct {
		attr  string
		extra map[string]any
	}{
		"name":    {"name", map[string]any{"name": "B"}},
		"project": {"project_id", map[string]any{"project_id": "p2"}},
		// NBO refuses to make a secret plain, so it must be deleted and added.
		"secret to plain": {"secret", map[string]any{"secret": false}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, h := envFixture(t)
			state, diags := h.create(envRes, base)
			wantNoError(t, diags)
			_, resp := h.plan(envRes, state, h.config(envRes, with(base, tc.extra)))
			wantReplace(t, resp.RequiresReplace, tc.attr)
		})
	}
}

func TestEnvVarImport(t *testing.T) {
	t.Run("project variable", func(t *testing.T) {
		fake, h := envFixture(t)
		fake.vars["p1"] = map[string]storedVar{"API_URL": {value: "https://a"}}

		state, diags := h.read(envRes, h.importState(envRes, "p1/API_URL"))
		wantNoError(t, diags)
		if stringAttr(t, state, "project_id") != "p1" || stringAttr(t, state, "name") != "API_URL" || stringAttr(t, state, "value") != "https://a" {
			t.Fatalf("state = %v", state)
		}
		planned, resp := h.plan(envRes, state, h.config(envRes, map[string]any{"project_id": "p1", "name": "API_URL", "value": "https://a"}))
		wantNoChange(t, state, planned, resp)
	})
	t.Run("workspace variable", func(t *testing.T) {
		fake, h := envFixture(t)
		fake.vars[""] = map[string]storedVar{"API_URL": {value: "https://w"}}

		state, diags := h.read(envRes, h.importState(envRes, "workspace/API_URL"))
		wantNoError(t, diags)
		if !attrOf(t, state, "project_id").IsNull() || stringAttr(t, state, "id") != "workspace/API_URL" {
			t.Fatalf("state = %v", state)
		}
		planned, resp := h.plan(envRes, state, h.config(envRes, map[string]any{"name": "API_URL", "value": "https://w"}))
		wantNoChange(t, state, planned, resp)
	})
	// NBO can't say what a secret holds, so the first plan writes config's
	// value, in place. It must not replace the variable.
	t.Run("secret variable", func(t *testing.T) {
		fake, h := envFixture(t)
		fake.vars["p1"] = map[string]storedVar{"TOKEN": {value: "s3cret", secret: true}}

		state, diags := h.read(envRes, h.importState(envRes, "p1/TOKEN"))
		wantNoError(t, diags)
		if !attrOf(t, state, "value").IsNull() || !boolAttr(t, state, "secret") {
			t.Fatalf("state = %v", state)
		}
		_, resp := h.plan(envRes, state, h.config(envRes, map[string]any{"project_id": "p1", "name": "TOKEN", "value": "s3cret", "secret": true}))
		if len(resp.RequiresReplace) > 0 {
			t.Fatalf("replace: %v", resp.RequiresReplace)
		}
	})
	t.Run("bad id", func(t *testing.T) {
		_, h := envFixture(t)
		wantError(t, h.importDiags(envRes, "API_URL"), "workspace/<name>")
	})
}

func TestEnvVarDropsFromStateWhenGone(t *testing.T) {
	cases := map[string]func(*fakeNBO){
		"variable deleted":             func(f *fakeNBO) { delete(f.vars["p1"], "A") },
		"project deleted":              func(f *fakeNBO) { delete(f.projects, "p1") },
		"only a workspace one remains": func(f *fakeNBO) { delete(f.vars["p1"], "A"); f.vars[""] = map[string]storedVar{"A": {value: "w"}} },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			fake, h := envFixture(t)
			state, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "1"})
			wantNoError(t, diags)
			change(fake)
			after, diags := h.read(envRes, state)
			wantNoError(t, diags)
			if !after.IsNull() {
				t.Fatalf("state = %v", after)
			}
		})
	}
}

func TestEnvVarDelete(t *testing.T) {
	fake, h := envFixture(t)
	state, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "A", "value": "1"})
	wantNoError(t, diags)

	_, diags = h.apply(envRes, state, h.null(envRes), h.null(envRes), nil)
	wantNoError(t, diags)
	if _, still := fake.vars["p1"]["A"]; still {
		t.Fatal("not deleted")
	}
	_, diags = h.apply(envRes, state, h.null(envRes), h.null(envRes), nil)
	wantNoError(t, diags) // already gone is fine
}

func TestEnvVarValidation(t *testing.T) {
	h := newHarness(t)
	wantError(t, h.validate(envRes, map[string]any{"name": "lower", "value": "1"}), "name")
	wantError(t, h.validate(envRes, map[string]any{"name": "A", "value": "", "secret": true}), "empty")
	wantNoError(t, h.validate(envRes, map[string]any{"name": "A", "value": ""}))
	wantNoError(t, h.validate(envRes, map[string]any{"name": "A", "value": unknown, "secret": true}))
}
