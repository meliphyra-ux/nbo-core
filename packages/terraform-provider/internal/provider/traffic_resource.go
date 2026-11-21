// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"nbo/terraform-provider/internal/client"
)

var (
	_ resource.ResourceWithConfigure      = &trafficResource{}
	_ resource.ResourceWithImportState    = &trafficResource{}
	_ resource.ResourceWithValidateConfig = &trafficResource{}
)

type trafficResource struct {
	resourceBase
}

func newTrafficResource() resource.Resource {
	return &trafficResource{}
}

type trafficModel struct {
	ID        types.String `tfsdk:"id"`
	ProjectID types.String `tfsdk:"project_id"`
	Stage     types.String `tfsdk:"stage"`
	Weights   types.Map    `tfsdk:"weights"`
}

func (r *trafficResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_traffic"
}

func (r *trafficResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The traffic split of a project, or of one of its custom environments. Destroying this only removes it from state, since a project always has a split.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The project's id, or <project id>/<stage> for another environment than production.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"project_id": schema.StringAttribute{
				Required:      true,
				Description:   "The project. Changing it replaces this resource.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"stage": stageAttribute("The environment whose split this is, such as a custom one (an nbo_stage)."),
			"weights": schema.MapAttribute{
				Required:      true,
				ElementType:   types.Int64Type,
				Description:   `Cloud name to percent, adding up to 100, like { k8s = 90, cloudrun = 10 }. A custom environment names its clouds s-<environment>-cr, s-<environment>-lm, s-<environment>-k8s and so on. A cloud left out gets 0.`,
				PlanModifiers: []planmodifier.Map{weightsPlanModifier{}},
			},
		},
	}
}

// weightsIn reads a weights map; ok is false while it isn't fully known.
func weightsIn(m types.Map) (map[string]int64, bool) {
	if m.IsNull() || m.IsUnknown() {
		return nil, false
	}
	out := map[string]int64{}
	for name, element := range m.Elements() {
		weight, isInt := element.(types.Int64)
		if !isInt || !isSet(weight) {
			return nil, false
		}
		out[name] = weight.ValueInt64()
	}
	return out, true
}

func weightProblem(weights map[string]int64) string {
	var total int64
	for name, weight := range weights {
		if weight < 0 || weight > 100 {
			return fmt.Sprintf("The weight of %q must be from 0 to 100.", name)
		}
		total += weight
	}
	if total != 100 {
		return fmt.Sprintf("Weights must add up to 100, not %d.", total)
	}
	return ""
}

func (r *trafficResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config trafficModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if weights, ok := weightsIn(config.Weights); ok {
		if problem := weightProblem(weights); problem != "" {
			resp.Diagnostics.AddAttributeError(path.Root("weights"), "Invalid weights", problem)
		}
	}
}

// sameWeights compares two splits. An environment at 0 and one left out are
// the same thing, and NBO reports neither way of writing it.
func sameWeights(a, b map[string]int64) bool {
	for name, weight := range a {
		if b[name] != weight {
			return false
		}
	}
	for name, weight := range b {
		if a[name] != weight {
			return false
		}
	}
	return true
}

// weightsPlanModifier keeps the state's value when config means the same split.
type weightsPlanModifier struct{}

func (weightsPlanModifier) Description(context.Context) string {
	return "An environment at 0 and one left out are the same."
}

func (m weightsPlanModifier) MarkdownDescription(ctx context.Context) string {
	return m.Description(ctx)
}

func (weightsPlanModifier) PlanModifyMap(_ context.Context, req planmodifier.MapRequest, resp *planmodifier.MapResponse) {
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() {
		return
	}
	state, stateKnown := weightsIn(req.StateValue)
	config, configKnown := weightsIn(req.ConfigValue)
	if stateKnown && configKnown && sameWeights(state, config) {
		resp.PlanValue = req.StateValue
	}
}

// weightsByID turns a split by name into the body NBO wants: by id, naming every
// environment, because NBO leaves one not listed as it was.
func weightsByID(weights map[string]int64, environments []client.Environment) (map[string]int64, error) {
	out := map[string]int64{}
	names := make([]string, 0, len(environments))
	known := map[string]bool{}
	for _, env := range environments {
		out[env.ID] = weights[env.Name]
		names = append(names, env.Name)
		known[env.Name] = true
	}
	for name := range weights {
		if !known[name] {
			sort.Strings(names)
			return nil, fmt.Errorf("this project has no environment named %q. It has: %s", name, strings.Join(names, ", "))
		}
	}
	return out, nil
}

// liveWeights is the split NBO reports, by name, without environments at 0.
func liveWeights(environments []client.Environment) map[string]int64 {
	out := map[string]int64{}
	for _, env := range environments {
		if env.TrafficWeight > 0 {
			out[env.Name] = env.TrafficWeight
		}
	}
	return out
}

func (r *trafficResource) apply(ctx context.Context, m *trafficModel, diags *diag.Diagnostics) {
	weights, ok := weightsIn(m.Weights)
	if !ok {
		diags.AddAttributeError(path.Root("weights"), "Invalid weights", "The weights must be whole numbers known at apply time.")
		return
	}
	projectID := m.ProjectID.ValueString()
	summary, err := r.client.ProjectSummary(ctx, projectID)
	if err != nil {
		diags.AddError("Could not read the project", err.Error())
		return
	}
	stage := apiStage(m.Stage)
	environments, ok := stageEnvironments(summary, stage)
	if !ok {
		diags.AddAttributeError(path.Root("stage"), "Unknown environment", fmt.Sprintf("this project has no environment named %q", stage))
		return
	}
	body, err := weightsByID(weights, environments)
	if err != nil {
		diags.AddAttributeError(path.Root("weights"), "Unknown environment", err.Error())
		return
	}
	if err := r.client.SetTraffic(ctx, projectID, stage, body); err != nil {
		diags.AddError("Could not set the traffic split", err.Error())
		return
	}
	m.ID = types.StringValue(trafficID(projectID, stage))
}

func (r *trafficResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan trafficModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.apply(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *trafficResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state trafficModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	summary, err := r.client.ProjectSummary(ctx, state.ProjectID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Could not read the traffic split", err.Error())
		return
	}
	// State from before environments has no stage: that was Production.
	if !isSet(state.Stage) {
		state.Stage = stageValue("")
	}
	environments, ok := stageEnvironments(summary, apiStage(state.Stage))
	if !ok {
		resp.State.RemoveResource(ctx)
		return
	}
	live := liveWeights(environments)
	if current, ok := weightsIn(state.Weights); !ok || !sameWeights(current, live) {
		weights, diags := types.MapValueFrom(ctx, types.Int64Type, live)
		resp.Diagnostics.Append(diags...)
		state.Weights = weights
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *trafficResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan trafficModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.apply(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Delete calls nothing: a project always has a split, so the resource only
// leaves state.
func (r *trafficResource) Delete(context.Context, resource.DeleteRequest, *resource.DeleteResponse) {
}

func (r *trafficResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	projectID, stage, _ := strings.Cut(req.ID, "/")
	if projectID == "" || strings.Contains(stage, "/") {
		resp.Diagnostics.AddError("Invalid import id", fmt.Sprintf("Expected <project id> or <project id>/<stage>, got %q.", req.ID))
		return
	}
	if stage == "" {
		stage = productionStage
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), trafficID(projectID, stage))...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project_id"), projectID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("stage"), stage)...)
}

// trafficID is the project's id for Production, <project id>/<stage> for
// another environment. Production's is the form before environments existed.
func trafficID(projectID, stage string) string {
	if stage == "" || stage == productionStage {
		return projectID
	}
	return projectID + "/" + stage
}
