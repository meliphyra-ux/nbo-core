// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
)

// NBO core has no dashboard: messages and descriptions name the API route,
// the nbo-server command or the Terraform resource instead.

func TestWaitEndedNamesTheAPINotADashboard(t *testing.T) {
	deadline, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	for _, ctx := range []context.Context{deadline, cancelled} {
		err := waitEnded(ctx, time.Minute, errors.New("boom"))
		msg := err.Error()
		if strings.Contains(msg, "dashboard") || !strings.Contains(msg, "GET /projects/{id}/summary") {
			t.Fatalf("message = %q", msg)
		}
	}
}

func TestEnvVarDeclareOnlyRefusalNamesTheRoute(t *testing.T) {
	_, h := envFixture(t)
	_, diags := h.create(envRes, map[string]any{"project_id": "p1", "name": "DB_URL", "secret": true})
	wantError(t, diags, "PATCH /system/workspace-settings")
	if strings.Contains(diagText(diags), "dashboard") {
		t.Fatalf("names the dashboard: %s", diagText(diags))
	}
}

func TestNoDescriptionNamesTheDashboard(t *testing.T) {
	h := newHarness(t)
	check := func(where string, block *tfprotov6.SchemaBlock) {
		if strings.Contains(block.Description, "dashboard") {
			t.Errorf("%s: %q", where, block.Description)
		}
		for _, a := range block.Attributes {
			if strings.Contains(a.Description, "dashboard") {
				t.Errorf("%s.%s: %q", where, a.Name, a.Description)
			}
		}
	}
	for name, s := range h.schema.ResourceSchemas {
		check(name, s.Block)
	}
	for name, s := range h.schema.DataSourceSchemas {
		check(name, s.Block)
	}
}
