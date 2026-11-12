// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"strings"
	"testing"
)

func TestConfigureNeedsEndpointAndToken(t *testing.T) {
	t.Setenv("NBO_ENDPOINT", "")
	t.Setenv("NBO_TOKEN", "")

	wantError(t, newHarness(t).configure(map[string]any{"token": testToken}), "NBO_ENDPOINT")
	wantError(t, newHarness(t).configure(map[string]any{"endpoint": "http://localhost:8081"}), "NBO_TOKEN")
}

func TestConfigureReadsTheEnvironment(t *testing.T) {
	fake := newFakeNBO(t)
	fake.add("p1", shopRequest())
	t.Setenv("NBO_ENDPOINT", fake.server.URL)
	t.Setenv("NBO_TOKEN", testToken)

	h := newHarness(t)
	wantNoError(t, h.configure(map[string]any{}))
	_, diags := h.read("nbo_project", h.importState("nbo_project", "p1"))
	wantNoError(t, diags)
}

func TestConfigBeatsTheEnvironment(t *testing.T) {
	fake := newFakeNBO(t)
	fake.add("p1", shopRequest())
	t.Setenv("NBO_ENDPOINT", "http://127.0.0.1:1")
	t.Setenv("NBO_TOKEN", "nbo_wrong")

	h := connected(t, fake.server.URL)
	_, diags := h.read("nbo_project", h.importState("nbo_project", "p1"))
	wantNoError(t, diags)
}

func TestConfigureRejectsAnEndpointThatIsNotHTTP(t *testing.T) {
	diags := newHarness(t).configure(map[string]any{"endpoint": "ftp://example.com", "token": testToken})
	wantError(t, diags, "endpoint")
}

func TestTokenNeverAppearsInConfigureErrors(t *testing.T) {
	t.Setenv("NBO_ENDPOINT", "")
	t.Setenv("NBO_TOKEN", "")
	for _, attrs := range []map[string]any{
		{"token": testToken},
		{"endpoint": "::not a url::", "token": testToken},
		{"endpoint": testToken, "token": testToken},
	} {
		text := diagText(newHarness(t).configure(attrs))
		if text == "" {
			t.Fatalf("no error for %v", attrs)
		}
		if strings.Contains(text, testToken) {
			t.Fatalf("token in error: %s", text)
		}
	}
}

func TestProviderTokenIsSensitive(t *testing.T) {
	h := newHarness(t)
	for _, a := range h.schema.Provider.Block.Attributes {
		if a.Name == "token" && !a.Sensitive {
			t.Fatal("token is not marked sensitive")
		}
	}
}
