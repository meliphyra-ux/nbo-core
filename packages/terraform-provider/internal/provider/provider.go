// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Package provider is the Terraform provider for NBO.
//
// To add a resource: put its routes in internal/client, write a file here with
// a type embedding resourceBase, and list its constructor in Resources.
package provider

import (
	"context"
	"net/url"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"nbo/terraform-provider/internal/client"
)

// New returns a constructor of the provider at the given release version.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &nboProvider{version: version}
	}
}

type nboProvider struct {
	version string
}

type providerModel struct {
	Endpoint types.String `tfsdk:"endpoint"`
	Token    types.String `tfsdk:"token"`
}

func (p *nboProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "nbo"
	resp.Version = p.version
}

func (p *nboProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages projects on an NBO control-plane.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{
				Optional:    true,
				Description: "URL of the control-plane API, such as http://localhost:8081. Falls back to NBO_ENDPOINT.",
			},
			"token": schema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				Description: "An NBO API token. Falls back to NBO_TOKEN.",
			},
		},
	}
}

func (p *nboProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if config.Endpoint.IsUnknown() {
		resp.Diagnostics.AddAttributeError(path.Root("endpoint"), "Unknown NBO endpoint", "The endpoint must be known when Terraform plans.")
	}
	if config.Token.IsUnknown() {
		resp.Diagnostics.AddAttributeError(path.Root("token"), "Unknown NBO token", "The token must be known when Terraform plans.")
	}
	if resp.Diagnostics.HasError() {
		return
	}

	endpoint := valueOrEnv(config.Endpoint, "NBO_ENDPOINT")
	token := valueOrEnv(config.Token, "NBO_TOKEN")
	if endpoint == "" {
		resp.Diagnostics.AddAttributeError(path.Root("endpoint"), "Missing NBO endpoint", "Set endpoint in the provider block, or NBO_ENDPOINT in the environment.")
	} else if !isHTTPURL(endpoint) {
		// The value isn't repeated here: it could be a token pasted in the wrong place.
		resp.Diagnostics.AddAttributeError(path.Root("endpoint"), "Invalid NBO endpoint", "The endpoint must be an http:// or https:// URL.")
	}
	if token == "" {
		resp.Diagnostics.AddAttributeError(path.Root("token"), "Missing NBO token", "Set token in the provider block, or NBO_TOKEN in the environment.")
	}
	if resp.Diagnostics.HasError() {
		return
	}

	c := client.New(endpoint, token)
	resp.ResourceData = c
	resp.DataSourceData = c
}

func valueOrEnv(v types.String, name string) string {
	if s := v.ValueString(); s != "" {
		return s
	}
	return os.Getenv(name)
}

func isHTTPURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func (p *nboProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		newProjectResource,
		newStageResource,
		newEnvVarResource,
		newDomainResource,
		newTrafficResource,
		newDeploymentResource,
	}
}

func (p *nboProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		newProjectDataSource,
	}
}
