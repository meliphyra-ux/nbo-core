// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"nbo/terraform-provider/internal/client"
)

// resourceBase gives a resource its Configure method and its client.
type resourceBase struct {
	client *client.Client
}

func (b *resourceBase) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	b.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

// dataSourceBase gives a data source its Configure method and its client.
type dataSourceBase struct {
	client *client.Client
}

func (b *dataSourceBase) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	b.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

// clientFrom unpacks what the provider's Configure handed over. Terraform
// calls Configure before the provider is configured too, with nothing in it.
func clientFrom(data any, diags *diag.Diagnostics) *client.Client {
	if data == nil {
		return nil
	}
	c, ok := data.(*client.Client)
	if !ok {
		diags.AddError("Unexpected provider data", fmt.Sprintf("Expected *client.Client, got %T. This is a bug in the provider.", data))
		return nil
	}
	return c
}

// splitImportID splits <scope>/<name> at the first slash.
func splitImportID(id string) (string, string, bool) {
	scope, name, found := strings.Cut(id, "/")
	return scope, name, found && scope != "" && name != ""
}

// optString is NBO's "not set", an empty or absent string, as Terraform's null.
func optString(s string) types.String {
	if s == "" {
		return types.StringNull()
	}
	return types.StringValue(s)
}
