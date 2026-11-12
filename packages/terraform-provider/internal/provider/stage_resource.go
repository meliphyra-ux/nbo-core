// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"nbo/terraform-provider/internal/client"
)

var (
	_ resource.ResourceWithConfigure      = &stageResource{}
	_ resource.ResourceWithImportState    = &stageResource{}
	_ resource.ResourceWithValidateConfig = &stageResource{}
)

type stageResource struct {
	resourceBase
}

func newStageResource() resource.Resource {
	return &stageResource{}
}

type stageModel struct {
	ID                   types.String `tfsdk:"id"`
	ProjectID            types.String `tfsdk:"project_id"`
	Name                 types.String `tfsdk:"name"`
	Branch               types.String `tfsdk:"branch"`
	AutoDeploy           types.Bool   `tfsdk:"auto_deploy"`
	Clouds               types.Set    `tfsdk:"clouds"`
	Host                 types.String `tfsdk:"host"`
	URL                  types.String `tfsdk:"url"`
	DeleteCloudResources types.Bool   `tfsdk:"delete_cloud_resources"`
}

func (r *stageResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_stage"
}

func (r *stageResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	keep := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	resp.Schema = schema.Schema{
		Description: "A custom environment of a project, such as staging: a branch that feeds it, its own clouds, address and variables. " +
			"NBO's manual calls it an environment, and its API a stage. Creating one builds nothing: the next push to its branch does, " +
			"or an nbo_deployment with this stage.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, Description: "The environment's id.", PlanModifiers: keep},
			"project_id": schema.StringAttribute{
				Required:      true,
				Description:   "The project. Changing it replaces the environment.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				Description:   "1 to 16 lowercase letters, digits and hyphens, starting with a letter. Not production, preview or development. Changing it replaces the environment.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
				Validators:    []validator.String{stageNameValidator{}},
			},
			"branch": schema.StringAttribute{
				Required:    true,
				Description: "The branch that feeds this environment. It can't be the production branch or another environment's.",
				Validators:  []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"auto_deploy": schema.BoolAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "Build each new commit of the branch. NBO's default is true.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
			"clouds": schema.SetNestedAttribute{
				Required: true,
				Description: "Where the environment runs, as it was set up (the same shape as the project's clouds). Changing it replaces the environment. " +
					"A cloud added or removed outside Terraform later is not detected.",
				PlanModifiers: []planmodifier.Set{cloudsPlanModifier{}},
				Validators:    []validator.Set{setvalidator.SizeBetween(1, 10)},
				NestedObject:  cloudNestedObject(),
			},
			"host": schema.StringAttribute{Computed: true, Description: "The environment's default address, without a scheme.", PlanModifiers: keep},
			"url":  schema.StringAttribute{Computed: true, Description: "The environment's public URL. Empty until NBO has one.", PlanModifiers: keep},
			"delete_cloud_resources": schema.BoolAttribute{
				Optional:    true,
				Computed:    true,
				Default:     booldefault.StaticBool(false),
				Description: "Also delete what the environment runs on each cloud when it is destroyed. Default false.",
			},
		},
	}
}

func (r *stageResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config stageModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	for _, cloud := range cloudsIn(ctx, config.Clouds, &resp.Diagnostics) {
		for _, problem := range cloudProblems(cloud) {
			resp.Diagnostics.AddAttributeError(path.Root("clouds"), "Invalid cloud", problem)
		}
	}
}

// fillFrom settles what NBO decides.
func (m *stageModel) fillFrom(s *client.Stage) {
	m.ID = types.StringValue(s.ID)
	m.Branch = types.StringValue(s.Branch)
	m.AutoDeploy = types.BoolValue(s.AutoDeploy)
	m.Host = types.StringValue(s.Host)
	m.URL = types.StringValue(s.URL)
}

func (r *stageResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan stageModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := client.CreateStageRequest{Name: plan.Name.ValueString(), Branch: plan.Branch.ValueString()}
	for _, c := range cloudsIn(ctx, plan.Clouds, &resp.Diagnostics) {
		body.Clouds = append(body.Clouds, client.Cloud{
			Target: c.Target.ValueString(), ClusterID: c.ClusterID.ValueString(), Mode: c.Mode.ValueString(),
			Region: c.Region.ValueString(), Project: c.Project.ValueString(), ArRepo: c.ArRepo.ValueString(),
		})
	}
	if isSet(plan.AutoDeploy) {
		body.AutoDeploy = plan.AutoDeploy.ValueBoolPointer()
	}
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateStage(ctx, plan.ProjectID.ValueString(), body)
	if err != nil {
		resp.Diagnostics.AddError("Could not create the environment", err.Error())
		return
	}
	plan.fillFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// findStage looks a custom stage up by name: nil when there is none, or when
// the project is gone.
func findStage(ctx context.Context, c *client.Client, projectID, name string) (*client.Stage, error) {
	stages, err := c.Stages(ctx, projectID)
	if client.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	for i := range stages {
		if stages[i].Name == name {
			return &stages[i], nil
		}
	}
	return nil, nil
}

func (r *stageResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state stageModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	found, err := findStage(ctx, r.client, state.ProjectID.ValueString(), state.Name.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Could not read the environment", err.Error())
		return
	}
	if found == nil {
		resp.State.RemoveResource(ctx)
		return
	}
	if found.Kind != "custom" {
		resp.Diagnostics.AddError("Not a custom environment", fmt.Sprintf("%q is built in, so nbo_stage can't manage it.", found.Name))
		return
	}
	state.fillFrom(found)
	// clouds records how the environment was set up. Filling it from the live
	// clouds would turn one added in the dashboard into a replacement, so NBO's
	// answer is only used after an import.
	if state.Clouds.IsNull() {
		clouds := make([]cloudModel, 0, len(found.Environments))
		for _, env := range found.Environments {
			clouds = append(clouds, cloudFromEnvironment(env))
		}
		set, diags := types.SetValueFrom(ctx, cloudObjectType, clouds)
		resp.Diagnostics.Append(diags...)
		state.Clouds = set
	}
	if state.DeleteCloudResources.IsNull() {
		state.DeleteCloudResources = types.BoolValue(false)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *stageResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state stageModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var patch client.UpdateStageRequest
	if !plan.Branch.Equal(state.Branch) {
		patch.Branch = plan.Branch.ValueStringPointer()
	}
	if isSet(plan.AutoDeploy) && !plan.AutoDeploy.Equal(state.AutoDeploy) {
		patch.AutoDeploy = plan.AutoDeploy.ValueBoolPointer()
	}
	if patch != (client.UpdateStageRequest{}) {
		updated, err := r.client.UpdateStage(ctx, state.ProjectID.ValueString(), state.ID.ValueString(), patch)
		if err != nil {
			resp.Diagnostics.AddError("Could not update the environment", err.Error())
			return
		}
		plan.fillFrom(updated)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *stageResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state stageModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteStage(ctx, state.ProjectID.ValueString(), state.ID.ValueString(), state.DeleteCloudResources.ValueBool())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Could not delete the environment", err.Error())
	}
}

func (r *stageResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	projectID, name, ok := splitImportID(req.ID)
	if !ok {
		resp.Diagnostics.AddError("Invalid import id", fmt.Sprintf("Expected <project id>/<name>, got %q.", req.ID))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project_id"), projectID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), name)...)
}
