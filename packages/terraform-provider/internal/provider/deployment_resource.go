// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"fmt"
	"time"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"nbo/terraform-provider/internal/client"
)

var (
	_ resource.ResourceWithConfigure      = &deploymentResource{}
	_ resource.ResourceWithImportState    = &deploymentResource{}
	_ resource.ResourceWithValidateConfig = &deploymentResource{}
)

const defaultBuildTimeout = "20m"

type deploymentResource struct {
	resourceBase
}

func newDeploymentResource() resource.Resource {
	return &deploymentResource{}
}

type deploymentModel struct {
	ID              types.String `tfsdk:"id"`
	ProjectID       types.String `tfsdk:"project_id"`
	Triggers        types.Map    `tfsdk:"triggers"`
	Stage           types.String `tfsdk:"stage"`
	Values          types.Map    `tfsdk:"values"`
	ValuesWO        types.Map    `tfsdk:"values_wo"`
	ValuesWOVersion types.String `tfsdk:"values_wo_version"`
	Timeout         types.String `tfsdk:"timeout"`
	Status          types.String `tfsdk:"status"`
	Commit          types.String `tfsdk:"commit"`
}

func (r *deploymentResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_deployment"
}

func (r *deploymentResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	stable := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	resp.Schema = schema.Schema{
		Description: "One build of a project's branch head, deployed to its clouds. Put depends_on on the project's variables, " +
			"so they exist when it runs. A failed build is replaced by the next apply, and the project stays as it is.",
		Attributes: map[string]schema.Attribute{
			"id":     schema.StringAttribute{Computed: true, Description: "The build's id.", PlanModifiers: stable},
			"status": schema.StringAttribute{Computed: true, Description: "The build's status.", PlanModifiers: stable},
			"commit": schema.StringAttribute{Computed: true, Description: "The commit that was built.", PlanModifiers: stable},
			"project_id": schema.StringAttribute{
				Required:      true,
				Description:   "The project. Changing it runs a new build.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"triggers": schema.MapAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Any change runs a new build.",
				PlanModifiers: []planmodifier.Map{mapplanmodifier.RequiresReplaceIf(
					func(_ context.Context, req planmodifier.MapRequest, resp *mapplanmodifier.RequiresReplaceIfFuncResponse) {
						resp.RequiresReplace = !importedTriggers(req.StateValue)
					},
					"Any change runs a new build.",
					"Any change runs a new build.",
				)},
			},
			"stage": stageAttribute("The environment to build and deploy, such as a custom one (an nbo_stage)."),
			"values": schema.MapAttribute{
				Optional:    true,
				Sensitive:   true,
				ElementType: types.StringType,
				Description: "Variable values for this deploy, by name, when NBO stores no values. Marked sensitive, but kept in Terraform's state, which then holds your secrets: protect it. " +
					"A change runs a new build. Prefer values_wo with Terraform 1.11 or newer, which is never written to state.",
				PlanModifiers: []planmodifier.Map{valuesPlanModifier{}},
			},
			"values_wo": schema.MapAttribute{
				Optional:    true,
				Sensitive:   true,
				WriteOnly:   true,
				ElementType: types.StringType,
				Description: "Like values, but write-only: Terraform sends it with the build and never stores it (Terraform 1.11 or newer). " +
					"Terraform can't see it change, so change values_wo_version to deploy with new values.",
			},
			"values_wo_version": schema.StringAttribute{
				Optional:    true,
				Description: "Any change runs a new build with the current values_wo.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplaceIf(
					func(ctx context.Context, req planmodifier.StringRequest, resp *stringplanmodifier.RequiresReplaceIfFuncResponse) {
						resp.RequiresReplace = !importedState(ctx, req.State)
					},
					"Any change runs a new build.", "Any change runs a new build.",
				)},
			},
			"timeout": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Default:     stringdefault.StaticString(defaultBuildTimeout),
				Description: `How long to wait for the build, like "20m". Default 20m.`,
			},
		},
	}
}

// importedTriggers recognises the empty map an import leaves. An import can't
// know the triggers, and config filling them in must not rebuild.
func importedTriggers(state types.Map) bool {
	return !state.IsNull() && !state.IsUnknown() && len(state.Elements()) == 0
}

func (r *deploymentResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config deploymentModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if !config.Values.IsNull() && !config.ValuesWO.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("values_wo"), "values and values_wo together", "Use values_wo (write-only, never in state) or values, not both.")
	}
	if !isSet(config.Timeout) {
		return
	}
	if timeout, err := time.ParseDuration(config.Timeout.ValueString()); err != nil || timeout <= 0 {
		resp.Diagnostics.AddAttributeError(path.Root("timeout"), "Invalid timeout", `Use a positive duration, like "20m" or "1h30m".`)
	}
}

func (m *deploymentModel) fillFrom(b *client.Build) {
	m.ID = types.StringValue(b.ID)
	m.Status = types.StringValue(b.Status)
	m.Commit = types.StringValue(b.Revision)
}

// buildOutcome reads a build: finished or not, and if so, what went wrong. NBO
// marks a build failed when any cloud failed, and its error names them.
func buildOutcome(b *client.Build) (bool, error) {
	switch b.Status {
	case client.BuildSucceeded:
		if len(b.DeploymentIDs) == 0 {
			return true, fmt.Errorf("build %s deployed nowhere: %s", b.ID, b.Note)
		}
		return true, nil
	case client.BuildFailed:
		return true, fmt.Errorf("build %s failed: %s", b.ID, b.Error)
	case client.BuildSkipped:
		return true, fmt.Errorf("build %s was skipped: %s", b.ID, b.Error)
	}
	return false, nil
}

// newerBuild is the id of the newest commit build after id, or "". A queued
// build is replaced when a newer one arrives, and carries on as that one.
func newerBuild(ctx context.Context, c *client.Client, projectID, id string) (string, error) {
	builds, err := c.ProjectBuilds(ctx, projectID)
	if err != nil {
		return "", err
	}
	// Another environment's build is not this one's replacement.
	stageID := ""
	for _, b := range builds {
		if b.ID == id {
			stageID = b.StageID
		}
	}
	newer, passed := "", false
	for _, b := range builds {
		if passed && b.Kind == "build" && b.StageID == stageID {
			newer = b.ID
		}
		passed = passed || b.ID == id
	}
	return newer, nil
}

// waitForBuild follows a build until it deploys or fails, and returns the last
// it saw of it, which is a newer build if this one was replaced.
func waitForBuild(ctx context.Context, c *client.Client, projectID, id string, timeout, interval time.Duration) (*client.Build, error) {
	var last *client.Build
	err := poll(ctx, timeout, interval, func(ctx context.Context) (bool, error) {
		b, err := c.Build(ctx, id)
		if err != nil {
			return false, err
		}
		last = b
		if b.Status == client.BuildSkipped {
			newer, err := newerBuild(ctx, c, projectID, b.ID)
			if err != nil {
				return false, err
			}
			if newer != "" {
				id = newer
				return false, nil
			}
		}
		return buildOutcome(b)
	})
	return last, err
}

func (r *deploymentResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan deploymentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	timeout, err := time.ParseDuration(plan.Timeout.ValueString())
	if err != nil {
		resp.Diagnostics.AddAttributeError(path.Root("timeout"), "Invalid timeout", err.Error())
		return
	}
	projectID := plan.ProjectID.ValueString()

	// Values come from the plan, or from config when they are write-only,
	// which the plan never holds.
	var woConfig types.Map
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("values_wo"), &woConfig)...)
	if resp.Diagnostics.HasError() {
		return
	}
	values, err := valuesOf(ctx, plan.Values)
	if err == nil && values == nil {
		values, err = valuesOf(ctx, woConfig)
	}
	if err != nil {
		resp.Diagnostics.AddAttributeError(path.Root("values"), "Invalid values", err.Error())
		return
	}
	build, err := r.client.StartBuild(ctx, projectID, client.StartBuildRequest{Stage: apiStage(plan.Stage), Values: values})
	if err != nil {
		resp.Diagnostics.AddError("Could not start the build", scrubError(err, values).Error())
		return
	}
	plan.fillFrom(build)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	final, err := waitForBuild(ctx, r.client, projectID, build.ID, timeout, pollInterval)
	if final != nil {
		plan.fillFrom(final)
		resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	}
	if err != nil {
		resp.Diagnostics.AddError("The deployment did not succeed", fmt.Sprintf("%s\n\nThe next apply builds again. The project isn't touched.", scrubError(err, values)))
	}
}

func (r *deploymentResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state deploymentModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	build, err := r.client.Build(ctx, state.ID.ValueString())
	if client.IsNotFound(err) {
		build = nil
	} else if err != nil {
		resp.Diagnostics.AddError("Could not read the build", err.Error())
		return
	}

	// After an import only the build knows its project.
	if state.ProjectID.IsNull() {
		if build == nil {
			resp.State.RemoveResource(ctx)
			return
		}
		state.ProjectID = types.StringValue(build.ProjectID)
	}
	summary, err := r.client.ProjectSummary(ctx, state.ProjectID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	} else if err != nil {
		resp.Diagnostics.AddError("Could not read the project", err.Error())
		return
	}
	// The stage is what the build was for; state from before environments
	// has none, and an import learns it here.
	if !isSet(state.Stage) {
		state.Stage = stageValue("")
		if build != nil {
			if name := stageNameFor(summary, build.StageID); name != "" {
				state.Stage = stageValue(name)
			}
		}
	}

	// NBO cleans old builds up, and that isn't a change to undo: state stays.
	if build != nil {
		state.fillFrom(build)
	}
	if state.Timeout.IsNull() {
		state.Timeout = types.StringValue(defaultBuildTimeout)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Update only saves what has no effect on NBO: timeout, and the triggers
// config gives an imported deployment.
func (r *deploymentResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan deploymentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Delete calls nothing: a build that ran stays in NBO's history, and what it
// deployed stays live.
func (r *deploymentResource) Delete(context.Context, resource.DeleteRequest, *resource.DeleteResponse) {
}

func (r *deploymentResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if req.ID == "" {
		resp.Diagnostics.AddError("Invalid import id", "Expected a build id.")
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	empty, diags := types.MapValue(types.StringType, nil)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("triggers"), empty)...)
}

// valuesPlanModifier runs a new build when the values change, which is how
// the new values reach the app. An import knows no values, and filling them in
// from config must not rebuild.
type valuesPlanModifier struct{}

func (valuesPlanModifier) Description(context.Context) string {
	return "Any change runs a new build."
}

func (m valuesPlanModifier) MarkdownDescription(ctx context.Context) string {
	return m.Description(ctx)
}

func (valuesPlanModifier) PlanModifyMap(ctx context.Context, req planmodifier.MapRequest, resp *planmodifier.MapResponse) {
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() || importedState(ctx, req.State) {
		return
	}
	resp.RequiresReplace = !req.StateValue.Equal(req.PlanValue)
}
