// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"nbo/terraform-provider/internal/client"
)

const testToken = "nbo_0123456789abcdef"

// harness drives the provider through the same protocol-6 server Terraform
// talks to, so defaults, plan modifiers, validators and state handling all run
// for real. Only Terraform's own part is imitated: proposedNew below.
type harness struct {
	t      *testing.T
	server tfprotov6.ProviderServer
	schema *tfprotov6.GetProviderSchemaResponse
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	server := providerserver.NewProtocol6(New("test")())()
	schema, err := server.GetProviderSchema(context.Background(), &tfprotov6.GetProviderSchemaRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(schema.Diagnostics) > 0 {
		t.Fatalf("schema diagnostics: %s", diagText(schema.Diagnostics))
	}
	return &harness{t: t, server: server, schema: schema}
}

// connected returns a harness whose provider is configured against endpoint.
func connected(t *testing.T, endpoint string) *harness {
	t.Helper()
	h := newHarness(t)
	if diags := h.configure(map[string]any{"endpoint": endpoint, "token": testToken}); len(diags) > 0 {
		t.Fatalf("configure: %s", diagText(diags))
	}
	return h
}

func (h *harness) configure(attrs map[string]any) []*tfprotov6.Diagnostic {
	h.t.Helper()
	typ := h.schema.Provider.ValueType()
	resp, err := h.server.ConfigureProvider(context.Background(), &tfprotov6.ConfigureProviderRequest{
		Config: dynamic(h.t, typ, value(h.t, typ, attrs)),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return resp.Diagnostics
}

func (h *harness) resourceType(name string) tftypes.Type {
	return h.schema.ResourceSchemas[name].ValueType()
}

func (h *harness) null(name string) tftypes.Value {
	return tftypes.NewValue(h.resourceType(name), nil)
}

func (h *harness) config(name string, attrs map[string]any) tftypes.Value {
	h.t.Helper()
	return value(h.t, h.resourceType(name), attrs)
}

func (h *harness) validate(name string, attrs map[string]any) []*tfprotov6.Diagnostic {
	h.t.Helper()
	typ := h.resourceType(name)
	resp, err := h.server.ValidateResourceConfig(context.Background(), &tfprotov6.ValidateResourceConfigRequest{
		TypeName:           name,
		Config:             dynamic(h.t, typ, value(h.t, typ, attrs)),
		ClientCapabilities: &tfprotov6.ValidateResourceConfigClientCapabilities{WriteOnlyAttributesAllowed: true},
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return resp.Diagnostics
}

// plan asks for a plan from prior state to config, the way Terraform does.
func (h *harness) plan(name string, prior, config tftypes.Value) (tftypes.Value, *tfprotov6.PlanResourceChangeResponse) {
	h.t.Helper()
	typ := h.resourceType(name)
	resp, err := h.server.PlanResourceChange(context.Background(), &tfprotov6.PlanResourceChangeRequest{
		TypeName:         name,
		PriorState:       dynamic(h.t, typ, prior),
		ProposedNewState: dynamic(h.t, typ, h.proposedNew(name, prior, config)),
		Config:           dynamic(h.t, typ, config),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	if hasError(resp.Diagnostics) {
		h.t.Fatalf("plan: %s", diagText(resp.Diagnostics))
	}
	return undynamic(h.t, typ, resp.PlannedState), resp
}

// planResponse is plan without the failure on errors.
func (h *harness) planResponse(name string, prior, config tftypes.Value) *tfprotov6.PlanResourceChangeResponse {
	h.t.Helper()
	typ := h.resourceType(name)
	resp, err := h.server.PlanResourceChange(context.Background(), &tfprotov6.PlanResourceChangeRequest{
		TypeName:         name,
		PriorState:       dynamic(h.t, typ, prior),
		ProposedNewState: dynamic(h.t, typ, h.proposedNew(name, prior, config)),
		Config:           dynamic(h.t, typ, config),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

// proposedNew imitates Terraform core: config wins; a computed attribute left
// out of config keeps its prior value.
func (h *harness) proposedNew(name string, prior, config tftypes.Value) tftypes.Value {
	h.t.Helper()
	if config.IsNull() || prior.IsNull() {
		return config
	}
	var priorAttrs, configAttrs map[string]tftypes.Value
	if err := prior.As(&priorAttrs); err != nil {
		h.t.Fatal(err)
	}
	if err := config.As(&configAttrs); err != nil {
		h.t.Fatal(err)
	}
	out := map[string]tftypes.Value{}
	for k, v := range configAttrs {
		out[k] = v
	}
	for _, attr := range h.schema.ResourceSchemas[name].Block.Attributes {
		if attr.Computed && configAttrs[attr.Name].IsNull() {
			out[attr.Name] = priorAttrs[attr.Name]
		}
	}
	return tftypes.NewValue(h.resourceType(name), out)
}

func (h *harness) apply(name string, prior, planned, config tftypes.Value, private []byte) (tftypes.Value, []*tfprotov6.Diagnostic) {
	h.t.Helper()
	typ := h.resourceType(name)
	resp, err := h.server.ApplyResourceChange(context.Background(), &tfprotov6.ApplyResourceChangeRequest{
		TypeName:       name,
		PriorState:     dynamic(h.t, typ, prior),
		PlannedState:   dynamic(h.t, typ, planned),
		Config:         dynamic(h.t, typ, config),
		PlannedPrivate: private,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return undynamic(h.t, typ, resp.NewState), resp.Diagnostics
}

// create plans and applies a new resource from attrs.
func (h *harness) create(name string, attrs map[string]any) (tftypes.Value, []*tfprotov6.Diagnostic) {
	h.t.Helper()
	config := h.config(name, attrs)
	planned, resp := h.plan(name, h.null(name), config)
	return h.apply(name, h.null(name), planned, config, resp.PlannedPrivate)
}

func (h *harness) read(name string, state tftypes.Value) (tftypes.Value, []*tfprotov6.Diagnostic) {
	h.t.Helper()
	typ := h.resourceType(name)
	resp, err := h.server.ReadResource(context.Background(), &tfprotov6.ReadResourceRequest{
		TypeName:     name,
		CurrentState: dynamic(h.t, typ, state),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return undynamic(h.t, typ, resp.NewState), resp.Diagnostics
}

func (h *harness) importState(name, id string) tftypes.Value {
	h.t.Helper()
	typ := h.resourceType(name)
	resp, err := h.server.ImportResourceState(context.Background(), &tfprotov6.ImportResourceStateRequest{TypeName: name, ID: id})
	if err != nil {
		h.t.Fatal(err)
	}
	if hasError(resp.Diagnostics) {
		h.t.Fatalf("import: %s", diagText(resp.Diagnostics))
	}
	if len(resp.ImportedResources) != 1 {
		h.t.Fatalf("imported %d resources", len(resp.ImportedResources))
	}
	return undynamic(h.t, typ, resp.ImportedResources[0].State)
}

func (h *harness) readDataSource(name string, attrs map[string]any) (tftypes.Value, []*tfprotov6.Diagnostic) {
	h.t.Helper()
	typ := h.schema.DataSourceSchemas[name].ValueType()
	resp, err := h.server.ReadDataSource(context.Background(), &tfprotov6.ReadDataSourceRequest{
		TypeName: name,
		Config:   dynamic(h.t, typ, value(h.t, typ, attrs)),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	if resp.State == nil {
		return tftypes.NewValue(typ, nil), resp.Diagnostics
	}
	return undynamic(h.t, typ, resp.State), resp.Diagnostics
}

// value builds a Terraform value of typ from plain Go values. Attributes left
// out of a map are null. unknown marks a value not known yet.
func value(t *testing.T, typ tftypes.Type, v any) tftypes.Value {
	t.Helper()
	if v == nil {
		return tftypes.NewValue(typ, nil)
	}
	if v == any(unknown) {
		return tftypes.NewValue(typ, tftypes.UnknownValue)
	}
	switch tt := typ.(type) {
	case tftypes.Object:
		attrs, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("want a map for %s, got %T", typ, v)
		}
		for k := range attrs {
			if _, known := tt.AttributeTypes[k]; !known {
				t.Fatalf("no attribute %q", k)
			}
		}
		out := map[string]tftypes.Value{}
		for k, at := range tt.AttributeTypes {
			out[k] = value(t, at, attrs[k])
		}
		return tftypes.NewValue(typ, out)
	case tftypes.Map:
		if text, isText := v.(map[string]string); isText {
			out := map[string]tftypes.Value{}
			for k, s := range text {
				out[k] = value(t, tt.ElementType, s)
			}
			return tftypes.NewValue(typ, out)
		}
		weights, ok := v.(map[string]int)
		if !ok {
			t.Fatalf("want a map of ints for %s, got %T", typ, v)
		}
		out := map[string]tftypes.Value{}
		for k, n := range weights {
			out[k] = value(t, tt.ElementType, n)
		}
		return tftypes.NewValue(typ, out)
	case tftypes.Set:
		items, ok := v.([]map[string]any)
		if !ok {
			t.Fatalf("want a list of maps for %s, got %T", typ, v)
		}
		out := make([]tftypes.Value, 0, len(items))
		for _, item := range items {
			out = append(out, value(t, tt.ElementType, item))
		}
		return tftypes.NewValue(typ, out)
	}
	if typ.Is(tftypes.Number) {
		n, ok := v.(int)
		if !ok {
			t.Fatalf("want an int, got %T", v)
		}
		return tftypes.NewValue(typ, big.NewFloat(float64(n)))
	}
	return tftypes.NewValue(typ, v)
}

type unknownMarker struct{}

var unknown = unknownMarker{}

func dynamic(t *testing.T, typ tftypes.Type, v tftypes.Value) *tfprotov6.DynamicValue {
	t.Helper()
	dv, err := tfprotov6.NewDynamicValue(typ, v)
	if err != nil {
		t.Fatal(err)
	}
	return &dv
}

func undynamic(t *testing.T, typ tftypes.Type, dv *tfprotov6.DynamicValue) tftypes.Value {
	t.Helper()
	v, err := dv.Unmarshal(typ)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// attr returns one top-level attribute of an object value.
func attrOf(t *testing.T, v tftypes.Value, name string) tftypes.Value {
	t.Helper()
	var attrs map[string]tftypes.Value
	if err := v.As(&attrs); err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	got, ok := attrs[name]
	if !ok {
		t.Fatalf("no attribute %q", name)
	}
	return got
}

func stringAttr(t *testing.T, v tftypes.Value, name string) string {
	t.Helper()
	var s *string
	if err := attrOf(t, v, name).As(&s); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if s == nil {
		return ""
	}
	return *s
}

func boolAttr(t *testing.T, v tftypes.Value, name string) bool {
	t.Helper()
	var b *bool
	if err := attrOf(t, v, name).As(&b); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return b != nil && *b
}

func hasError(diags []*tfprotov6.Diagnostic) bool {
	for _, d := range diags {
		if d.Severity == tfprotov6.DiagnosticSeverityError {
			return true
		}
	}
	return false
}

func diagText(diags []*tfprotov6.Diagnostic) string {
	var b strings.Builder
	for _, d := range diags {
		fmt.Fprintf(&b, "[%s] %s: %s\n", d.Severity, d.Summary, d.Detail)
	}
	return b.String()
}

// wantError fails unless diags hold an error containing text.
func wantError(t *testing.T, diags []*tfprotov6.Diagnostic, text string) {
	t.Helper()
	if !hasError(diags) {
		t.Fatalf("want an error containing %q, got: %s", text, diagText(diags))
	}
	if !strings.Contains(diagText(diags), text) {
		t.Fatalf("want an error containing %q, got: %s", text, diagText(diags))
	}
}

func wantNoError(t *testing.T, diags []*tfprotov6.Diagnostic) {
	t.Helper()
	if hasError(diags) {
		t.Fatalf("unexpected error: %s", diagText(diags))
	}
}

// wantNoChange fails unless the plan is a no-op: nothing differs from prior
// state and nothing asks for replacement.
func wantNoChange(t *testing.T, prior, planned tftypes.Value, resp *tfprotov6.PlanResourceChangeResponse) {
	t.Helper()
	if len(resp.RequiresReplace) > 0 {
		t.Fatalf("plan asks for replacement because of %v", resp.RequiresReplace)
	}
	diffs, err := prior.Diff(planned)
	if err != nil {
		t.Fatal(err)
	}
	if len(diffs) > 0 {
		t.Fatalf("plan is not empty: %v", diffs)
	}
}

// fakeNBO is an in-memory control-plane answering the routes the provider uses.
type fakeNBO struct {
	mu       sync.Mutex
	server   *httptest.Server
	projects map[string]*client.ProjectSummary
	setups   []client.SetupRequest
	patches  []map[string]any
	deletes  []string
	calls    []string
	// steps change a project on each summary read, in order; the last repeats.
	steps   []func(*client.ProjectSummary)
	gitPuts []map[string]any
	builds  []*client.Build
	// buildSteps change a build on each read, in order; the last repeats.
	buildSteps []func(*client.Build)
	// failBuildReads answers this many build reads with a 503 first.
	failBuildReads int
	// startRefusal answers POST /builds with a 409.
	startRefusal string
	vars         map[string]map[string]storedVar // by project id, "" for the workspace
	domains      map[string][]client.Domain
	// domainRefusal and trafficRefusal answer those writes with a 409.
	domainRefusal  string
	trafficRefusal string
	trafficPuts    []map[string]int64
	// htmlGets answers every GET with the dashboard page, as a wrong endpoint does.
	htmlGets bool
	// failReads answers this many summary reads with a 503 first.
	failReads int
	// Custom environments (stage_test.go): by project id.
	stages map[string][]*client.Stage
	// stageVars hold variables of other stages than Production, keyed by
	// scope, stage and name (see stageVarKey).
	stageVars map[string]storedVar
	// buildBodies are the JSON bodies POST /builds got, in order.
	buildBodies []map[string]any
	// stagePosts and stagePatches are the bodies stage writes got.
	stagePosts, stagePatches []map[string]any
	// buildError, when set, is the error text a failed build carries.
	// stageDeletes are the stage DELETE addresses.
	stageDeletes []string
	// trafficStages and domainStages are the stage each write named.
	trafficStages, domainStages []string
	// envPuts are the raw env PUT bodies, with their address.
	envPuts []envPut
	// namesOnly makes NBO keep no variable values (GET /workspace/settings).
	namesOnly bool
	// creds are the git credentials NBO holds, by project id (project_credential_test.go).
	creds map[string]*storedCredential
}

type envPut struct {
	uri  string
	body map[string]any
}

func newFakeNBO(t *testing.T) *fakeNBO {
	t.Helper()
	f := &fakeNBO{
		projects: map[string]*client.ProjectSummary{}, vars: map[string]map[string]storedVar{}, domains: map[string][]client.Domain{},
		stages: map[string][]*client.Stage{}, stageVars: map[string]storedVar{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /projects/setup", f.setup)
	mux.HandleFunc("GET /projects/summary", f.list)
	mux.HandleFunc("GET /projects/{id}/summary", f.summary)
	mux.HandleFunc("PATCH /projects/{id}/settings", f.patch)
	mux.HandleFunc("DELETE /projects/{id}", f.delete)
	mux.HandleFunc("PUT /projects/{id}/git", f.putGit)
	mux.HandleFunc("GET /projects/{id}/git", f.getGit)
	mux.HandleFunc("POST /projects/{id}/git/deploy-key", f.postDeployKey)
	mux.HandleFunc("GET /workspace/env", f.listEnv)
	mux.HandleFunc("PUT /workspace/env/{name}", f.putEnv)
	mux.HandleFunc("DELETE /workspace/env/{name}", f.deleteEnv)
	mux.HandleFunc("GET /projects/{id}/env", f.listEnv)
	mux.HandleFunc("PUT /projects/{id}/env/{name}", f.putEnv)
	mux.HandleFunc("DELETE /projects/{id}/env/{name}", f.deleteEnv)
	mux.HandleFunc("GET /projects/{id}/domains", f.listDomains)
	mux.HandleFunc("POST /projects/{id}/domains", f.addDomain)
	mux.HandleFunc("DELETE /projects/{id}/domains/{domainID}", f.deleteDomain)
	mux.HandleFunc("PUT /projects/{id}/traffic", f.putTraffic)
	mux.HandleFunc("POST /projects/{id}/builds", f.startBuild)
	mux.HandleFunc("GET /projects/{id}/builds", f.listBuilds)
	mux.HandleFunc("GET /builds/{id}", f.getBuild)
	mux.HandleFunc("GET /workspace/settings", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"storeEnvValues": !f.namesOnly})
	})
	mux.HandleFunc("GET /projects/{id}/stages", f.listStages)
	mux.HandleFunc("POST /projects/{id}/stages", f.createStage)
	mux.HandleFunc("PATCH /projects/{id}/stages/{stageID}", f.patchStage)
	mux.HandleFunc("DELETE /projects/{id}/stages/{stageID}", f.deleteStage)
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, r.Method+" "+r.URL.RequestURI())
		if f.htmlGets && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, "<!doctype html><title>NBO</title>")
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// add stores a project as NBO would after a finished deploy.
func (f *fakeNBO) add(id string, req client.SetupRequest) *client.ProjectSummary {
	outputDir := req.OutputDir
	if req.Framework == "static" && outputDir == "" {
		outputDir = "dist"
	}
	if req.Framework != "static" {
		outputDir = ""
	}
	s := &client.ProjectSummary{
		Project: client.Project{
			ID: id, Name: req.Name, EdgeHost: req.Name + ".example", PollingEnabled: true,
			SetupStatus: client.SetupReady, SpeedInsightsInject: true, SpeedInsightsSampleRate: 100,
		},
		Git: &client.GitConfig{
			Repo: req.Repo, ProductionBranch: req.ProductionBranch, Framework: req.Framework, Spa: req.Spa,
			BuildCommand: req.BuildCommand, OutputDir: outputDir,
			IgnoredBuildStepCommand: req.IgnoredBuildStepCommand, RootDirectory: req.RootDirectory,
		},
		DomainURL:   "http://" + req.Name + ".example",
		LatestBuild: &client.Build{ID: "b1", Status: client.BuildSucceeded},
	}
	for i, cloud := range req.Clouds {
		env := client.Environment{ID: fmt.Sprintf("env%d", i), Target: cloud.Target, ClusterID: cloud.ClusterID}
		if cloud.Target == "cloudrun" {
			env.Name = "cloudrun"
			env.Config = client.EnvironmentConfig{Project: "acme-prod", Region: "us-central1", ArRepo: "us-central1-docker.pkg.dev/acme-prod/nbo"}
			if cloud.Region != "" {
				env.Config.Region = cloud.Region
			}
		} else if cloud.Target == "lambda" {
			env.Name = "lambda"
			env.Config = client.EnvironmentConfig{Region: "eu-west-1"}
		} else {
			env.Name = "k8s"
		}
		s.Environments = append(s.Environments, env)
	}
	f.projects[id] = s
	return s
}

func (f *fakeNBO) setup(w http.ResponseWriter, r *http.Request) {
	var req client.SetupRequest
	body, _ := io.ReadAll(r.Body)
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, s := range f.projects {
		if s.Project.Name == req.Name {
			writeError(w, http.StatusConflict, "a project with this name already exists")
			return
		}
	}
	f.setups = append(f.setups, req)
	s := f.add(fmt.Sprintf("p%d", len(f.setups)), req)
	f.storeCredential(s.Project.ID, req.Credential)
	s.Project.SetupStatus = client.SetupProvisioning
	s.LatestBuild = nil
	if len(f.steps) == 0 {
		s.Project.SetupStatus = client.SetupReady
	}
	writeJSON(w, http.StatusCreated, f.withStages(s))
}

func (f *fakeNBO) list(w http.ResponseWriter, _ *http.Request) {
	out := []*client.ProjectSummary{}
	for _, s := range f.projects {
		out = append(out, f.withStages(s))
	}
	writeJSON(w, http.StatusOK, out)
}

func (f *fakeNBO) summary(w http.ResponseWriter, r *http.Request) {
	if f.failReads > 0 {
		f.failReads--
		writeError(w, http.StatusServiceUnavailable, "restarting")
		return
	}
	s, ok := f.projects[r.PathValue("id")]
	if !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	if len(f.steps) > 0 {
		f.steps[0](s)
		if len(f.steps) > 1 {
			f.steps = f.steps[1:]
		}
	}
	writeJSON(w, http.StatusOK, f.withStages(s))
}

func (f *fakeNBO) patch(w http.ResponseWriter, r *http.Request) {
	s, ok := f.projects[r.PathValue("id")]
	if !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	body, _ := io.ReadAll(r.Body)
	var raw map[string]any
	var settings client.ProjectSettings
	if json.Unmarshal(body, &raw) != nil || json.Unmarshal(body, &settings) != nil {
		writeError(w, http.StatusBadRequest, "bad body")
		return
	}
	f.patches = append(f.patches, raw)
	if settings.PollingEnabled != nil {
		s.Project.PollingEnabled = *settings.PollingEnabled
	}
	if settings.SpeedInsights != nil {
		s.Project.SpeedInsights = *settings.SpeedInsights
	}
	if settings.SpeedInsightsInject != nil {
		s.Project.SpeedInsightsInject = *settings.SpeedInsightsInject
	}
	if settings.SpeedInsightsSampleRate != nil {
		s.Project.SpeedInsightsSampleRate = *settings.SpeedInsightsSampleRate
	}
	writeJSON(w, http.StatusOK, s)
}

func (f *fakeNBO) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := f.projects[id]; !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	f.deletes = append(f.deletes, r.URL.RequestURI())
	delete(f.projects, id)
	w.WriteHeader(http.StatusNoContent)
}

func (f *fakeNBO) callCount(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

// importDiags imports an id expected to be refused.
func (h *harness) importDiags(name, id string) []*tfprotov6.Diagnostic {
	h.t.Helper()
	resp, err := h.server.ImportResourceState(context.Background(), &tfprotov6.ImportResourceStateRequest{TypeName: name, ID: id})
	if err != nil {
		h.t.Fatal(err)
	}
	return resp.Diagnostics
}
