// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestSetEnvRoutesByScope(t *testing.T) {
	var requests []string
	var bodies []map[string]any
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		_, _ = io.WriteString(w, `{"name":"API_KEY","secret":true}`)
	})
	if err := c.SetEnv(context.Background(), "p1", "", "API_KEY", ptr("s3cret"), true); err != nil {
		t.Fatal(err)
	}
	if err := c.SetEnv(context.Background(), "", "", "API_KEY", ptr(""), false); err != nil {
		t.Fatal(err)
	}
	if requests[0] != "PUT /projects/p1/env/API_KEY" || requests[1] != "PUT /workspace/env/API_KEY" {
		t.Fatalf("requests = %v", requests)
	}
	if bodies[0]["value"] != "s3cret" || bodies[0]["secret"] != true {
		t.Fatalf("body = %v", bodies[0])
	}
	if v, sent := bodies[1]["value"]; !sent || v != "" || bodies[1]["secret"] != false {
		t.Fatalf("an empty value must still be sent: %v", bodies[1])
	}
}

func TestListEnvRoutesByScope(t *testing.T) {
	var paths []string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		_, _ = io.WriteString(w, `[{"name":"A","value":"1","secret":false},{"name":"B","secret":true},{"name":"C","value":"","secret":false,"inherited":true}]`)
	})
	got, err := c.ListEnv(context.Background(), "p1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.ListEnv(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if paths[0] != "/projects/p1/env" || paths[1] != "/workspace/env" {
		t.Fatalf("paths = %v", paths)
	}
	if len(got) != 3 || *got[0].Value != "1" || got[1].Value != nil || !got[1].Secret || !got[2].Inherited || *got[2].Value != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestDeleteEnvRoutesByScope(t *testing.T) {
	var requests []string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	})
	if err := c.DeleteEnv(context.Background(), "p1", "", "A"); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteEnv(context.Background(), "", "", "A"); err != nil {
		t.Fatal(err)
	}
	if requests[0] != "DELETE /projects/p1/env/A" || requests[1] != "DELETE /workspace/env/A" {
		t.Fatalf("requests = %v", requests)
	}
}

func TestDomainRoutes(t *testing.T) {
	var requests []string
	var body map[string]any
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodPost:
			_ = json.NewDecoder(r.Body).Decode(&body)
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"id":"dom_1","host":"a.example.com","status":"dns_pending","serving":"edge","mappingRecords":[],"record":{"type":"A","name":"a.example.com","value":"203.0.113.9"}}`)
		case http.MethodGet:
			_, _ = io.WriteString(w, `{"domains":[{"id":"dom_1","host":"a.example.com"}],"edgeAddress":"203.0.113.9"}`)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	added, err := c.AddDomain(context.Background(), "p1", "a.example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if body["host"] != "a.example.com" || len(body) != 1 {
		t.Fatalf("body = %v", body)
	}
	if added.ID != "dom_1" || added.Status != "dns_pending" || added.Record.Value != "203.0.113.9" {
		t.Fatalf("added = %+v", added)
	}
	list, err := c.Domains(context.Background(), "p1")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Host != "a.example.com" {
		t.Fatalf("list = %+v", list)
	}
	if err := c.DeleteDomain(context.Background(), "p1", "dom_1"); err != nil {
		t.Fatal(err)
	}
	want := []string{"POST /projects/p1/domains", "GET /projects/p1/domains", "DELETE /projects/p1/domains/dom_1"}
	for i := range want {
		if requests[i] != want[i] {
			t.Fatalf("requests = %v", requests)
		}
	}
}

func TestSetTrafficPutsWeightsByEnvironmentID(t *testing.T) {
	var request string
	var body map[string]map[string]int64
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		request = r.Method + " " + r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = io.WriteString(w, `{"host":"x","backends":[]}`)
	})
	if err := c.SetTraffic(context.Background(), "p1", "", map[string]int64{"env1": 90, "env2": 10}); err != nil {
		t.Fatal(err)
	}
	if request != "PUT /projects/p1/traffic" || body["weights"]["env1"] != 90 || body["weights"]["env2"] != 10 {
		t.Fatalf("%s %v", request, body)
	}
}

func TestBuildRoutes(t *testing.T) {
	var requests []string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/projects/p1/builds":
			if r.Method == http.MethodPost {
				w.WriteHeader(http.StatusAccepted)
				_, _ = io.WriteString(w, `{"id":"b1","projectId":"p1","revision":"abc","status":"queued","kind":"build","deploymentIds":[]}`)
				return
			}
			_, _ = io.WriteString(w, `[{"id":"b1","kind":"build"},{"id":"b2","kind":"promote"}]`)
		default:
			_, _ = io.WriteString(w, `{"id":"b1","status":"failed","error":"boom","note":"n","deploymentIds":["d1"]}`)
		}
	})
	started, err := c.StartBuild(context.Background(), "p1", StartBuildRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if started.ID != "b1" || started.Revision != "abc" || started.Status != BuildQueued || started.ProjectID != "p1" {
		t.Fatalf("started = %+v", started)
	}
	got, err := c.Build(context.Background(), "b1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Error != "boom" || got.Note != "n" || len(got.DeploymentIDs) != 1 {
		t.Fatalf("got = %+v", got)
	}
	list, err := c.ProjectBuilds(context.Background(), "p1")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[1].Kind != "promote" {
		t.Fatalf("list = %+v", list)
	}
	want := []string{"POST /projects/p1/builds", "GET /builds/b1", "GET /projects/p1/builds"}
	for i := range want {
		if requests[i] != want[i] {
			t.Fatalf("requests = %v", requests)
		}
	}
}
