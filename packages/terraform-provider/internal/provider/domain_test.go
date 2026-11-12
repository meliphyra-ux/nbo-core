// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"nbo/terraform-provider/internal/client"
)

const domainRes = "nbo_domain"

func (f *fakeNBO) listDomains(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if f.projectMissing(w, id) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"domains": f.domains[id], "edgeAddress": "203.0.113.9"})
}

func (f *fakeNBO) addDomain(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if f.projectMissing(w, id) {
		return
	}
	if f.domainRefusal != "" {
		writeError(w, http.StatusConflict, f.domainRefusal)
		return
	}
	var body struct {
		Host  string `json:"host"`
		Stage string `json:"stage"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.domainStages = append(f.domainStages, body.Stage)
	d := client.Domain{
		Stage: body.Stage, ID: fmt.Sprintf("dom_%d", len(f.domains[id])+1), Host: body.Host, Status: "dns_pending", Serving: "edge",
		Record: client.DNSRecord{Type: "A", Name: body.Host, Value: "203.0.113.9"},
	}
	f.domains[id] = append(f.domains[id], d)
	writeJSON(w, http.StatusCreated, d)
}

func (f *fakeNBO) deleteDomain(w http.ResponseWriter, r *http.Request) {
	id, domainID := r.PathValue("id"), r.PathValue("domainID")
	if f.projectMissing(w, id) {
		return
	}
	for i, d := range f.domains[id] {
		if d.ID == domainID {
			f.domains[id] = append(f.domains[id][:i], f.domains[id][i+1:]...)
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeError(w, http.StatusNotFound, "domain not found")
}

func records(t *testing.T, state tftypes.Value) [][3]string {
	t.Helper()
	var list []tftypes.Value
	if err := attrOf(t, state, "records").As(&list); err != nil {
		t.Fatal(err)
	}
	out := [][3]string{}
	for _, r := range list {
		out = append(out, [3]string{stringAttr(t, r, "type"), stringAttr(t, r, "name"), stringAttr(t, r, "value")})
	}
	return out
}

func domainFixture(t *testing.T) (*fakeNBO, *harness) {
	t.Helper()
	fake := newFakeNBO(t)
	fake.add("p1", shopRequest())
	return fake, connected(t, fake.server.URL)
}

func TestDomainCreateExposesTheEdgeRecord(t *testing.T) {
	_, h := domainFixture(t)
	state, diags := h.create(domainRes, map[string]any{"project_id": "p1", "host": "www.example.com"})
	wantNoError(t, diags)

	if stringAttr(t, state, "id") != "dom_1" || stringAttr(t, state, "status") != "dns_pending" || stringAttr(t, state, "serving") != "edge" {
		t.Fatalf("state = %v", state)
	}
	got := records(t, state)
	if len(got) != 1 || got[0] != [3]string{"A", "www.example.com", "203.0.113.9"} {
		t.Fatalf("records = %v", got)
	}
}

func TestDomainRecordsComeFromTheMappingOnCloudRun(t *testing.T) {
	fake, h := domainFixture(t)
	fake.domains["p1"] = []client.Domain{{
		ID: "dom_9", Host: "www.example.com", Status: "cert_pending", Serving: "cloudrun",
		Record: client.DNSRecord{Type: "A", Name: "www.example.com", Value: ""},
		MappingRecords: []client.DNSRecord{
			{Type: "CNAME", Name: "www", Value: "ghs.googlehosted.com."},
			{Type: "A", Name: "@", Value: "216.239.32.21"},
		},
	}}

	state, diags := h.read(domainRes, h.importState(domainRes, "p1/www.example.com"))
	wantNoError(t, diags)
	got := records(t, state)
	if len(got) != 2 || got[0] != [3]string{"CNAME", "www", "ghs.googlehosted.com."} || got[1] != [3]string{"A", "@", "216.239.32.21"} {
		t.Fatalf("records = %v", got)
	}
}

func TestDomainOnTheEdgeIgnoresAKeptMapping(t *testing.T) {
	fake, h := domainFixture(t)
	fake.domains["p1"] = []client.Domain{{
		ID: "dom_9", Host: "www.example.com", Status: "active", Serving: "edge",
		Record:         client.DNSRecord{Type: "A", Name: "www.example.com", Value: "203.0.113.9"},
		MappingRecords: []client.DNSRecord{{Type: "CNAME", Name: "www", Value: "ghs.googlehosted.com."}},
	}}
	state, diags := h.read(domainRes, h.importState(domainRes, "p1/www.example.com"))
	wantNoError(t, diags)
	if got := records(t, state); len(got) != 1 || got[0][2] != "203.0.113.9" {
		t.Fatalf("records = %v", got)
	}
}

func TestDomainPlanAfterImportIsEmpty(t *testing.T) {
	fake, h := domainFixture(t)
	fake.domains["p1"] = []client.Domain{{ID: "dom_9", Host: "www.example.com", Status: "active", Serving: "edge", Record: client.DNSRecord{Type: "A", Name: "www.example.com", Value: "203.0.113.9"}}}

	state, diags := h.read(domainRes, h.importState(domainRes, "p1/www.example.com"))
	wantNoError(t, diags)
	if stringAttr(t, state, "id") != "dom_9" || stringAttr(t, state, "project_id") != "p1" || stringAttr(t, state, "host") != "www.example.com" {
		t.Fatalf("state = %v", state)
	}
	planned, resp := h.plan(domainRes, state, h.config(domainRes, map[string]any{"project_id": "p1", "host": "www.example.com"}))
	wantNoChange(t, state, planned, resp)
}

func TestDomainStatusMovingOnShowsNoDiff(t *testing.T) {
	fake, h := domainFixture(t)
	attrs := map[string]any{"project_id": "p1", "host": "www.example.com"}
	state, diags := h.create(domainRes, attrs)
	wantNoError(t, diags)

	fake.domains["p1"][0].Status = "active"
	refreshed, diags := h.read(domainRes, state)
	wantNoError(t, diags)
	if stringAttr(t, refreshed, "status") != "active" {
		t.Fatal("status not refreshed")
	}
	planned, resp := h.plan(domainRes, refreshed, h.config(domainRes, attrs))
	wantNoChange(t, refreshed, planned, resp)
}

func TestDomainChangesReplace(t *testing.T) {
	for attrName, v := range map[string]string{"host": "shop.example.com", "project_id": "p2"} {
		t.Run(attrName, func(t *testing.T) {
			_, h := domainFixture(t)
			base := map[string]any{"project_id": "p1", "host": "www.example.com"}
			state, diags := h.create(domainRes, base)
			wantNoError(t, diags)
			_, resp := h.plan(domainRes, state, h.config(domainRes, with(base, map[string]any{attrName: v})))
			wantReplace(t, resp.RequiresReplace, attrName)
		})
	}
}

func TestDomainDropsFromStateWhenGone(t *testing.T) {
	for name, change := range map[string]func(*fakeNBO){
		"domain removed":  func(f *fakeNBO) { f.domains["p1"] = nil },
		"project deleted": func(f *fakeNBO) { delete(f.projects, "p1") },
	} {
		t.Run(name, func(t *testing.T) {
			fake, h := domainFixture(t)
			state, diags := h.create(domainRes, map[string]any{"project_id": "p1", "host": "www.example.com"})
			wantNoError(t, diags)
			change(fake)
			after, diags := h.read(domainRes, state)
			wantNoError(t, diags)
			if !after.IsNull() {
				t.Fatalf("state = %v", after)
			}
		})
	}
}

func TestDomainDelete(t *testing.T) {
	fake, h := domainFixture(t)
	state, diags := h.create(domainRes, map[string]any{"project_id": "p1", "host": "www.example.com"})
	wantNoError(t, diags)

	_, diags = h.apply(domainRes, state, h.null(domainRes), h.null(domainRes), nil)
	wantNoError(t, diags)
	if len(fake.domains["p1"]) != 0 {
		t.Fatal("not deleted")
	}
	_, diags = h.apply(domainRes, state, h.null(domainRes), h.null(domainRes), nil)
	wantNoError(t, diags) // already gone is fine
}

func TestDomainCreateShowsNBOsRefusal(t *testing.T) {
	fake, h := domainFixture(t)
	fake.domainRefusal = "Domains need the public edge (production mode)"
	state, diags := h.create(domainRes, map[string]any{"project_id": "p1", "host": "www.example.com"})
	wantError(t, diags, "Domains need the public edge")
	if !state.IsNull() {
		t.Fatalf("state = %v", state)
	}
}

func TestDomainValidation(t *testing.T) {
	h := newHarness(t)
	wantError(t, h.validate(domainRes, map[string]any{"project_id": "p1", "host": "WWW.Example.com."}), `"www.example.com"`)
	wantNoError(t, h.validate(domainRes, map[string]any{"project_id": "p1", "host": "www.example.com"}))
	wantNoError(t, h.validate(domainRes, map[string]any{"project_id": unknown, "host": unknown}))
}

func TestDomainImportNeedsBothParts(t *testing.T) {
	_, h := domainFixture(t)
	wantError(t, h.importDiags(domainRes, "www.example.com"), "<project id>/<host>")
}
