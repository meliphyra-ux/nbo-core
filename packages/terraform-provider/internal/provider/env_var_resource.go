// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

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
	_ resource.ResourceWithConfigure      = &envVarResource{}
	_ resource.ResourceWithImportState    = &envVarResource{}
	_ resource.ResourceWithValidateConfig = &envVarResource{}
)

// workspaceScope stands for "no project" in this resource's ids.
const workspaceScope = "workspace"

// The rules in env-vars.ts validateEnvName.
var envNamePattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)

const maxEnvNameLength = 256

var reservedEnvNames = map[string]bool{"PORT": true, "K_SERVICE": true, "K_REVISION": true, "K_CONFIGURATION": true, "NEXT_ADAPTER_PATH": true}

type envVarResource struct {
	resourceBase
}

func newEnvVarResource() resource.Resource {
	return &envVarResource{}
}

type envVarModel struct {
	ID        types.String `tfsdk:"id"`
	ProjectID types.String `tfsdk:"project_id"`
	Stage     types.String `tfsdk:"stage"`
	Name      types.String `tfsdk:"name"`
	Value     types.String `tfsdk:"value"`
	Secret    types.Bool   `tfsdk:"secret"`
}

func (r *envVarResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_env_var"
}

func (r *envVarResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "An environment variable of a project, or of the workspace, for one environment or all of them. Changes apply on the next deploy.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "<project id>/<name>, or <project id>/<stage>/<name> for another environment than production. workspace/... for the workspace.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"project_id": schema.StringAttribute{
				Optional:      true,
				Description:   "The project. Left out, this is a workspace variable. Changing it replaces the variable.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"stage": stageAttribute(`The environment: "*" for every environment, "production", "preview", "development", or the name of a custom one (an nbo_stage). Workspace variables can use only those built-in names and "*".`),
			"name": schema.StringAttribute{
				Required:      true,
				Description:   "A-Z, 0-9 and _, not starting with a digit. Changing it replaces the variable.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
				Validators: []validator.String{
					stringvalidator.RegexMatches(envNamePattern, "must use only A-Z, 0-9 and _, and not start with a digit"),
				},
			},
			"value": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				Description: "The value. Left out, the name is only declared, which is how a name is kept while NBO stores no values (the value then comes with nbo_deployment). NBO never returns a secret's value, so a secret changed outside Terraform isn't detected, " +
					"and the first plan after importing a secret writes this value.",
			},
			"secret": schema.BoolAttribute{
				Optional:    true,
				Computed:    true,
				Default:     booldefault.StaticBool(false),
				Description: "Encrypt the value and redact it from build logs. Default false. Making a secret plain replaces the variable.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.RequiresReplaceIf(
					func(_ context.Context, req planmodifier.BoolRequest, resp *boolplanmodifier.RequiresReplaceIfFuncResponse) {
						resp.RequiresReplace = req.StateValue.ValueBool() && !req.PlanValue.ValueBool()
					},
					"NBO refuses to make a secret plain, so it is deleted and added again.",
					"NBO refuses to make a secret plain, so it is deleted and added again.",
				)},
			},
		},
	}
}

func (r *envVarResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config envVarModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if isSet(config.Name) {
		name := config.Name.ValueString()
		if len(name) > maxEnvNameLength {
			resp.Diagnostics.AddAttributeError(path.Root("name"), "Invalid name", fmt.Sprintf("A variable name must be at most %d characters.", maxEnvNameLength))
		}
		if strings.HasPrefix(name, "NBO_") || reservedEnvNames[name] {
			resp.Diagnostics.AddAttributeError(path.Root("name"), "Invalid name", fmt.Sprintf("The variable name %q is reserved.", name))
		}
	}
	if config.Secret.ValueBool() && isSet(config.Value) && config.Value.ValueString() == "" {
		resp.Diagnostics.AddAttributeError(path.Root("value"), "Invalid value", "A secret's value can't be empty.")
	}
}

// envVarID is <scope>/<name> for Production, <scope>/<stage>/<name> for
// another environment. Production's form is the one before environments
// existed, so earlier state keeps its ids.
func envVarID(projectID, stage, name string) string {
	if projectID == "" {
		projectID = workspaceScope
	}
	if stage == "" || stage == productionStage {
		return projectID + "/" + name
	}
	return projectID + "/" + stage + "/" + name
}

// findEnvVar reads one variable set at exactly this scope and stage: nil when
// there is none, or when the project is gone. A project's list also shows
// workspace variables and other stages' rows, which aren't this one.
func findEnvVar(ctx context.Context, c *client.Client, projectID, stage, name string) (*client.EnvVar, error) {
	vars, err := c.ListEnv(ctx, projectID)
	if client.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if stage == "" {
		stage = productionStage
	}
	for i := range vars {
		rowStage := vars[i].Stage
		if rowStage == "" {
			rowStage = productionStage
		}
		if vars[i].Name == name && rowStage == stage && !vars[i].Inherited {
			return &vars[i], nil
		}
	}
	return nil, nil
}

func (r *envVarResource) write(ctx context.Context, m *envVarModel) error {
	projectID, name := m.ProjectID.ValueString(), m.Name.ValueString()
	var value *string
	if isSet(m.Value) {
		value = m.Value.ValueStringPointer()
	}
	if value == nil {
		// A name without a value, sent to an NBO that keeps values, would wipe
		// the value it holds (and a secret's can't be seen to compare).
		stores, err := r.client.StoresEnvValues(ctx)
		if err != nil {
			return err
		}
		if stores {
			return errors.New("this NBO stores variable values, so declaring " + name + " without a value would erase the one it holds. Give a value, or switch NBO to names only on the server (PATCH /system/workspace-settings with storeEnvValues false)")
		}
	}
	if err := r.client.SetEnv(ctx, projectID, apiStage(m.Stage), name, value, m.Secret.ValueBool()); err != nil {
		return err
	}
	m.ID = types.StringValue(envVarID(projectID, apiStage(m.Stage), name))
	return nil
}

func (r *envVarResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan envVarModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.write(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Could not set the variable", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *envVarResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state envVarModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// State from before environments has no stage: that was Production.
	if !isSet(state.Stage) {
		state.Stage = stageValue("")
	}
	found, err := findEnvVar(ctx, r.client, state.ProjectID.ValueString(), apiStage(state.Stage), state.Name.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Could not read the variable", err.Error())
		return
	}
	if found == nil {
		resp.State.RemoveResource(ctx)
		return
	}
	state.ID = types.StringValue(envVarID(state.ProjectID.ValueString(), apiStage(state.Stage), state.Name.ValueString()))
	state.Secret = types.BoolValue(found.Secret)
	// A secret's value never comes back, nor does any value while NBO stores
	// none, so state keeps what it has.
	if found.Value != nil {
		state.Value = types.StringValue(*found.Value)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *envVarResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan envVarModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.write(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Could not update the variable", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *envVarResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state envVarModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteEnv(ctx, state.ProjectID.ValueString(), apiStage(state.Stage), state.Name.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Could not delete the variable", err.Error())
	}
}

// ImportState takes <project id>/<name>, <project id>/<stage>/<name>, and the
// same with workspace in place of the project id.
func (r *envVarResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := strings.Split(req.ID, "/")
	for _, part := range parts {
		if part == "" {
			parts = nil
		}
	}
	if len(parts) != 2 && len(parts) != 3 {
		resp.Diagnostics.AddError("Invalid import id", fmt.Sprintf("Expected <project id>/<name>, <project id>/<stage>/<name>, workspace/<name> or workspace/<stage>/<name>, got %q.", req.ID))
		return
	}
	scope, stage, name := parts[0], productionStage, parts[len(parts)-1]
	if len(parts) == 3 {
		stage = parts[1]
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), envVarID(scope, stage, name))...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), name)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("stage"), stage)...)
	if scope != workspaceScope {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project_id"), scope)...)
	}
}
