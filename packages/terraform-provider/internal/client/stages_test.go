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

func ptr(s string) *string { return &s }

func TestStageRoutes(t *testing.T) {
	var requests []string
	var bodies []map[string]any
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.RequestURI())
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		switch r.Method {
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case http.MethodPost:
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"id":"stg_1","name":"staging","kind":"custom","branch":"develop","autoDeploy":true,"host":"staging--shop.example","url":"http://staging--shop.example","environments":[{"id":"e1","name":"s-staging-cr","target":"cloudrun","trafficWeight":0}]}`)
		case http.MethodPatch:
			_, _ = io.WriteString(w, `{"id":"stg_1","name":"staging","kind":"custom","branch":"next","autoDeploy":false}`)
		default:
			_, _ = io.WriteString(w, `[{"id":"stg_p","name":"production","kind":"production"},{"id":"stg_1","name":"staging","kind":"custom","branch":"develop","autoDeploy":true}]`)
		}
	})
	ctx := context.Background()
	list, err := c.Stages(ctx, "p1")
	if err != nil || len(list) != 2 || list[1].Name != "staging" || !list[1].AutoDeploy {
		t.Fatalf("list = %+v, %v", list, err)
	}
	auto := false
	created, err := c.CreateStage(ctx, "p1", CreateStageRequest{Name: "staging", Branch: "develop", Clouds: []Cloud{{Target: "cloudrun", Mode: "auto"}}})
	if err != nil || created.ID != "stg_1" || len(created.Environments) != 1 || created.Environments[0].Name != "s-staging-cr" {
		t.Fatalf("created = %+v, %v", created, err)
	}
	if _, sent := bodies[1]["autoDeploy"]; sent {
		t.Fatalf("autoDeploy must be left out when unset: %v", bodies[1])
	}
	if _, err := c.UpdateStage(ctx, "p1", "stg_1", UpdateStageRequest{Branch: ptr("next"), AutoDeploy: &auto}); err != nil {
		t.Fatal(err)
	}
	if bodies[2]["branch"] != "next" || bodies[2]["autoDeploy"] != false {
		t.Fatalf("patch body = %v", bodies[2])
	}
	if err := c.DeleteStage(ctx, "p1", "stg_1", false); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteStage(ctx, "p1", "stg_1", true); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"GET /projects/p1/stages", "POST /projects/p1/stages", "PATCH /projects/p1/stages/stg_1",
		"DELETE /projects/p1/stages/stg_1", "DELETE /projects/p1/stages/stg_1?resources=true",
	}
	for i := range want {
		if requests[i] != want[i] {
			t.Fatalf("requests = %v", requests)
		}
	}
}

func TestStageAwareRequests(t *testing.T) {
	var requests []string
	var bodies []map[string]any
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.RequestURI())
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_, _ = io.WriteString(w, `{"id":"b1","host":"x"}`)
	})
	ctx := context.Background()
	if err := c.SetEnv(ctx, "p1", "staging", "A", ptr("1"), false); err != nil {
		t.Fatal(err)
	}
	if err := c.SetEnv(ctx, "", "*", "A", nil, true); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteEnv(ctx, "p1", "staging", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.StartBuild(ctx, "p1", StartBuildRequest{Stage: "staging", Values: map[string]string{"A": "1"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddDomain(ctx, "p1", "s.example.com", "staging"); err != nil {
		t.Fatal(err)
	}
	if err := c.SetTraffic(ctx, "p1", "staging", map[string]int64{"e1": 100}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"PUT /projects/p1/env/A?stage=staging", "PUT /workspace/env/A?stage=%2A", "DELETE /projects/p1/env/A?stage=staging",
		"POST /projects/p1/builds", "POST /projects/p1/domains", "PUT /projects/p1/traffic",
	}
	for i := range want {
		if requests[i] != want[i] {
			t.Fatalf("requests[%d] = %q, want %q", i, requests[i], want[i])
		}
	}
	if _, has := bodies[1]["value"]; has || bodies[1]["secret"] != true {
		t.Fatalf("a declared name sends no value: %v", bodies[1])
	}
	vals, _ := bodies[3]["values"].(map[string]any)
	if bodies[3]["stage"] != "staging" || vals["A"] != "1" {
		t.Fatalf("build body = %v", bodies[3])
	}
	if bodies[4]["stage"] != "staging" || bodies[4]["host"] != "s.example.com" || bodies[5]["stage"] != "staging" {
		t.Fatalf("bodies = %v %v", bodies[4], bodies[5])
	}
}

func TestStartBuildWithoutOptionsSendsNoBody(t *testing.T) {
	var length int64 = -1
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		length = int64(len(raw))
		_, _ = io.WriteString(w, `{"id":"b1"}`)
	})
	if _, err := c.StartBuild(context.Background(), "p1", StartBuildRequest{}); err != nil {
		t.Fatal(err)
	}
	if length != 0 {
		t.Fatalf("sent %d bytes", length)
	}
}
