// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

const notAPIText = "NBO answered with something that isn't its API. Check that endpoint is NBO's own address, such as http://localhost:8081, with no path."

func html(status int) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, "<!doctype html><title>NBO</title>")
	}
}

func TestAnAnswerThatIsNotJSONNamesTheEndpoint(t *testing.T) {
	for name, status := range map[string]int{"200": 200, "404": 404, "405": 405, "502": 502} {
		t.Run(name, func(t *testing.T) {
			_, err := serve(t, html(status)).ProjectSummary(context.Background(), "p1")
			if err == nil || err.Error() != notAPIText {
				t.Fatalf("err = %v", err)
			}
			if !errors.Is(err, ErrNotAPI) {
				t.Fatalf("errors.Is(%v, ErrNotAPI) = false", err)
			}
		})
	}
}

// A wrong endpoint must never read as "the project is gone", or a refresh
// would empty the state.
func TestAPageNotFoundIsNotAnObjectNotFound(t *testing.T) {
	_, err := serve(t, html(http.StatusNotFound)).ProjectSummary(context.Background(), "p1")
	if IsNotFound(err) {
		t.Fatal("an HTML 404 counts as NBO's 404")
	}
}

func TestJSONOfTheWrongShapeNamesTheEndpoint(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, `["not","a","summary"]`) })
	if _, err := c.ProjectSummary(context.Background(), "p1"); !errors.Is(err, ErrNotAPI) {
		t.Fatalf("err = %v", err)
	}
}

func TestAnAnswerNobodyDecodesIsStillChecked(t *testing.T) {
	if err := serve(t, html(http.StatusOK)).DeleteProject(context.Background(), "p1", false); !errors.Is(err, ErrNotAPI) {
		t.Fatalf("err = %v", err)
	}
}

func TestUnauthorizedSaysTheTokenIsBad(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"invalid API token"}`)
	})
	_, err := c.ProjectSummary(context.Background(), "p1")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("err = %#v", err)
	}
	if !strings.Contains(err.Error(), "token is invalid or revoked") {
		t.Fatalf("Error() = %q", err.Error())
	}
}

func TestForbiddenKeepsNBOsMessage(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":"API tokens can't use this route"}`)
	})
	_, err := c.ProjectSummary(context.Background(), "p1")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden || apiErr.Message != "API tokens can't use this route" {
		t.Fatalf("err = %#v", err)
	}
}

func TestJSONErrorWithoutAMessageStillGivesAStatus(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{}`)
	})
	_, err := c.ProjectSummary(context.Background(), "p1")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusInternalServerError || apiErr.Message == "" {
		t.Fatalf("err = %#v", err)
	}
}

// PUT /git replaces the whole config, so every set field must be sent, and an
// empty outputDir would be refused.
func TestUpdateGitSendsTheWholeConfig(t *testing.T) {
	var body map[string]any
	var request string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		request = r.Method + " " + r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = io.WriteString(w, `{"repo":"x"}`)
	})
	err := c.UpdateProjectGit(context.Background(), "p1", GitConfig{Repo: "https://example.com/a.git", ProductionBranch: "next", Framework: "nextjs", BuildCommand: "make"})
	if err != nil {
		t.Fatal(err)
	}
	if request != "PUT /projects/p1/git" {
		t.Fatal(request)
	}
	got, _ := json.Marshal(body)
	want := `{"buildCommand":"make","framework":"nextjs","productionBranch":"next","repo":"https://example.com/a.git","spa":false}`
	if string(got) != want {
		t.Fatalf("body\n got %s\nwant %s", got, want)
	}
}
