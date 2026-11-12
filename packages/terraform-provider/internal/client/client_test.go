// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testToken = "nbo_0123456789abcdef"

func serve(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(srv.URL+"/", testToken)
}

func TestSendsBearerToken(t *testing.T) {
	var got string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		_, _ = io.WriteString(w, `{"project":{"id":"p1"}}`)
	})
	if _, err := c.ProjectSummary(context.Background(), "p1"); err != nil {
		t.Fatal(err)
	}
	if got != "Bearer "+testToken {
		t.Fatalf("Authorization = %q", got)
	}
}

func TestErrorBodyBecomesAPIError(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"a build is running"}`)
	})
	err := c.DeleteProject(context.Background(), "p1", false)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %#v, want *APIError", err)
	}
	if apiErr.Status != http.StatusConflict || apiErr.Message != "a build is running" {
		t.Fatalf("got %+v", apiErr)
	}
	if !strings.Contains(err.Error(), "a build is running") {
		t.Fatalf("Error() = %q", err.Error())
	}
}

func TestIsNotFound(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"project not found"}`)
	})
	_, err := c.ProjectSummary(context.Background(), "p1")
	if !IsNotFound(err) {
		t.Fatalf("IsNotFound(%v) = false", err)
	}
	if IsNotFound(errors.New("other")) || IsNotFound(nil) {
		t.Fatal("IsNotFound is true for something that is not a 404")
	}
}

func TestTokenNeverAppearsInAnError(t *testing.T) {
	t.Run("echoed by the server", func(t *testing.T) {
		c := serve(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "bad token " + r.Header.Get("Authorization")})
		})
		_, err := c.ProjectSummary(context.Background(), "p1")
		if err == nil || strings.Contains(err.Error(), testToken) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("connection refused", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		url := srv.URL
		srv.Close()
		_, err := New(url, testToken).ProjectSummary(context.Background(), "p1")
		if err == nil || strings.Contains(err.Error(), testToken) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestSetupProjectPostsTheSetupBody(t *testing.T) {
	var body map[string]any
	var method, path string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"project":{"id":"p1","name":"shop"},"domainUrl":"http://shop.example"}`)
	})
	got, err := c.SetupProject(context.Background(), SetupRequest{
		Name: "shop", Repo: "https://example.com/a.git", ProductionBranch: "main", Framework: "static",
		BuildCommand: "pnpm build", Clouds: []Cloud{{Target: "cloudrun", Mode: "auto"}, {Target: "kubernetes", ClusterID: "kc_a"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPost || path != "/projects/setup" {
		t.Fatalf("%s %s", method, path)
	}
	if got.Project.ID != "p1" || got.DomainURL != "http://shop.example" {
		t.Fatalf("got %+v", got)
	}
	want := map[string]any{
		"name": "shop", "repo": "https://example.com/a.git", "productionBranch": "main", "framework": "static",
		"spa": false, "buildCommand": "pnpm build",
		"clouds": []any{map[string]any{"target": "cloudrun", "mode": "auto"}, map[string]any{"target": "kubernetes", "clusterId": "kc_a"}},
	}
	gotJSON, _ := json.Marshal(body)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("body\n got %s\nwant %s", gotJSON, wantJSON)
	}
}

func TestUpdateSettingsSendsOnlyWhatIsSet(t *testing.T) {
	var body map[string]any
	var method, path string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = io.WriteString(w, `{"project":{"id":"p1"}}`)
	})
	off := false
	if _, err := c.UpdateProjectSettings(context.Background(), "p1", ProjectSettings{PollingEnabled: &off}); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPatch || path != "/projects/p1/settings" {
		t.Fatalf("%s %s", method, path)
	}
	if len(body) != 1 || body["pollingEnabled"] != false {
		t.Fatalf("body = %v", body)
	}
}

func TestDeleteProjectAsksForResourcesOnlyWhenTold(t *testing.T) {
	var queries []string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.Method+" "+r.URL.RequestURI())
		w.WriteHeader(http.StatusNoContent)
	})
	if err := c.DeleteProject(context.Background(), "p1", false); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteProject(context.Background(), "p1", true); err != nil {
		t.Fatal(err)
	}
	want := []string{"DELETE /projects/p1", "DELETE /projects/p1?resources=true"}
	if strings.Join(queries, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v", queries)
	}
}

func TestProjectIDIsEscapedInThePath(t *testing.T) {
	var uri string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		uri = r.RequestURI
		_, _ = io.WriteString(w, `{"project":{"id":"x"}}`)
	})
	if _, err := c.ProjectSummary(context.Background(), "../system/x"); err != nil {
		t.Fatal(err)
	}
	if uri != "/projects/..%2Fsystem%2Fx/summary" {
		t.Fatalf("uri = %q", uri)
	}
}

func TestListProjectSummaries(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/projects/summary" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `[{"project":{"id":"p1","name":"a"}},{"project":{"id":"p2","name":"b"}}]`)
	})
	got, err := c.ProjectSummaries(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].Project.Name != "b" {
		t.Fatalf("got %+v", got)
	}
}
