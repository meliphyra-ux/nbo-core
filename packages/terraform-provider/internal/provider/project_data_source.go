// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ datasource.DataSourceWithConfigure = &projectDataSource{}

type projectDataSource struct {
	dataSourceBase
}

func newProjectDataSource() datasource.DataSource {
	return &projectDataSource{}
}

func (d *projectDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_project"
}

func (d *projectDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	text := func(description string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, Description: description}
	}
	flag := func(description string) schema.BoolAttribute {
		return schema.BoolAttribute{Computed: true, Description: description}
	}
	resp.Schema = schema.Schema{
		Description: "Finds a project on NBO by name.",
		Attributes: map[string]schema.Attribute{
			"name":                       schema.StringAttribute{Required: true, Description: "The project's name."},
			"id":                         text("The project's id."),
			"address":                    text("The project's public URL. Empty until NBO has one."),
			"repo_url":                   text("The git URL."),
			"branch":                     text("The production branch."),
			"framework":                  text(`"nextjs" or "static".`),
			"spa":                        flag("Whether a single-page app's index is served for unknown paths."),
			"build_command":              text("The command that builds the site."),
			"output_dir":                 text("Static sites: the folder the build writes."),
			"ignored_build_step_command": text("The command that decides whether a commit is built."),
			"root_directory":             text("The folder inside the repository that is built."),
			"polling_enabled":            flag("Whether the branch is checked for new commits."),
			"speed_insights":             flag("Whether Speed Insights is collected."),
			"speed_insights_inject":      flag("Whether the edge inserts the Speed Insights tag."),
			"speed_insights_sample_rate": schema.Int64Attribute{Computed: true, Description: "Percent of visits measured."},
			"stages":                     schema.MapAttribute{Computed: true, ElementType: types.StringType, Description: "The project's environments, by name, valued by id."},
			"clouds": schema.SetNestedAttribute{
				Computed:    true,
				Description: "Where the project runs now. NBO doesn't report a Cloud Run mode, so mode is always null here.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"target":     text(`"kubernetes", "cloudrun" or "lambda".`),
						"cluster_id": text("Kubernetes in production: the connected cluster's id."),
						"mode":       text("Always null."),
						"region":     text("Cloud Run: the region."),
						"project":    text("Cloud Run: the Google Cloud project."),
						"ar_repo":    text("Cloud Run: the Artifact Registry repository."),
					},
				},
			},
		},
	}
}

func (d *projectDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config projectData
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	name := config.Name.ValueString()
	summaries, err := d.client.ProjectSummaries(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Could not list projects", err.Error())
		return
	}
	for i := range summaries {
		if summaries[i].Project.Name == name {
			data := projectDataFrom(ctx, &summaries[i], &resp.Diagnostics)
			resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
			return
		}
	}
	resp.Diagnostics.AddError("Project not found", fmt.Sprintf("NBO has no project named %q.", name))
}
