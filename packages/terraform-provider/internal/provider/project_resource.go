// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"fmt"
	"regexp"
	"sort"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"nbo/terraform-provider/internal/client"
)

var (
	_ resource.ResourceWithConfigure      = &projectResource{}
	_ resource.ResourceWithImportState    = &projectResource{}
	_ resource.ResourceWithValidateConfig = &projectResource{}
	_ resource.ResourceWithModifyPlan     = &projectResource{}
)

// The rule in setup.ts.
var projectNamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$`)

type projectResource struct {
	resourceBase
}

func newProjectResource() resource.Resource {
	return &projectResource{}
}

// projectModel adds what only Terraform knows about to the project.
type projectModel struct {
	projectData
	DeleteCloudResources types.Bool `tfsdk:"delete_cloud_resources"`
	// How NBO reaches the repository (project_credential.go). The token is
	// write-only: it is read from config, and the plan and state hold null.
	GitCredential     types.String `tfsdk:"git_credential"`
	GitUsername       types.String `tfsdk:"git_username"`
	GitTokenWO        types.String `tfsdk:"git_token_wo"`
	GitTokenWOVersion types.String `tfsdk:"git_token_wo_version"`
	DeployKeyPublic   types.String `tfsdk:"deploy_key_public"`
}

func (r *projectResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_project"
}

func (r *projectResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A project on NBO: a repository built and deployed to one or more clouds.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The project's id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"address": schema.StringAttribute{
				Computed:      true,
				Description:   "The project's public URL. Empty until NBO has one.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				Description:   "Lowercase letters, digits and hyphens, up to 40 characters. Changing it replaces the project.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
				Validators: []validator.String{
					stringvalidator.RegexMatches(projectNamePattern, "must be lowercase letters, numbers and hyphens, up to 40 characters, starting and ending with a letter or number"),
				},
			},
			"repo_url": schema.StringAttribute{
				Required: true,
				Description: "The repository: an https:// git URL (public, or with git_credential = \"token\"), " +
					"or with git_credential = \"deploy-key\" an ssh address (ssh://git@host/path or git@host:path).",
				Validators: []validator.String{stringvalidator.RegexMatches(repoURLPattern, "must be an https:// git URL, or with a deploy key an ssh address (ssh://git@host/path or git@host:path)")},
			},
			"branch": schema.StringAttribute{
				Required:    true,
				Description: "The production branch.",
				Validators:  []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"framework": schema.StringAttribute{
				Required:    true,
				Description: `"nextjs" or "static".`,
				Validators:  []validator.String{stringvalidator.OneOf("nextjs", "static")},
			},
			"spa": schema.BoolAttribute{
				Optional:    true,
				Computed:    true,
				Default:     booldefault.StaticBool(false),
				Description: "Serve a single-page app's index for unknown paths.",
			},
			"build_command": schema.StringAttribute{
				Required:    true,
				Description: "The command that builds the site.",
				Validators:  []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"output_dir": schema.StringAttribute{
				Optional:      true,
				Computed:      true,
				Description:   `Static sites only: the folder the build writes. NBO uses "dist" when left out.`,
				PlanModifiers: []planmodifier.String{outputDirPlanModifier{}},
				Validators:    []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"ignored_build_step_command": schema.StringAttribute{
				Optional:    true,
				Description: "A command that decides whether a commit is built.",
				Validators:  []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"root_directory": schema.StringAttribute{
				Optional:    true,
				Description: "The folder inside the repository to build, like apps/web.",
				Validators:  []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"clouds": schema.SetNestedAttribute{
				Required: true,
				Description: "Where the project runs, as it was set up. Changing it replaces the project. " +
					"A cloud added or removed outside Terraform later is not detected. " +
					"Order here means nothing: NBO sets clouds up sorted by target, then cluster_id, so cloudrun comes before kubernetes, then lambda. " +
					"The first one runs crons, and the first to deploy in that order gets all traffic.",
				PlanModifiers: []planmodifier.Set{cloudsPlanModifier{}},
				Validators:    []validator.Set{setvalidator.SizeBetween(1, 10)},
				NestedObject:  cloudNestedObject(),
			},
			"polling_enabled": schema.BoolAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "Check the branch for new commits. Left out, Terraform doesn't manage it.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
			"speed_insights": schema.BoolAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "Collect Speed Insights. Left out, Terraform doesn't manage it.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
			"speed_insights_inject": schema.BoolAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "Let the edge insert the Speed Insights tag. Left out, Terraform doesn't manage it.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
			"speed_insights_sample_rate": schema.Int64Attribute{
				Optional:      true,
				Computed:      true,
				Description:   "Percent of visits measured: 100, 50, 25 or 10. Left out, Terraform doesn't manage it.",
				PlanModifiers: []planmodifier.Int64{int64planmodifier.UseStateForUnknown()},
				Validators:    []validator.Int64{int64validator.OneOf(100, 50, 25, 10)},
			},
			"stages": schema.MapAttribute{
				Computed:      true,
				ElementType:   types.StringType,
				Description:   "The project's environments, by name, valued by id: production, preview, development and the custom ones. Refreshed on every plan.",
				PlanModifiers: []planmodifier.Map{mapplanmodifier.UseStateForUnknown()},
			},
			"git_credential": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Default:     stringdefault.StaticString(credentialPublic),
				Description: `How NBO reaches the repository: "public" (default), "token" (needs git_token_wo) or "deploy-key" (an ssh repo_url; NBO makes the key and shows its public half in deploy_key_public).`,
				Validators:  []validator.String{stringvalidator.OneOf(credentialPublic, credentialToken, credentialDeployKey)},
			},
			"git_token_wo": schema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				WriteOnly:   true,
				Description: "The access token for git_credential = \"token\". Write-only: Terraform sends it and never writes it to state or the plan. It needs Terraform 1.11 or newer. Terraform can't see it change, so change git_token_wo_version to send a new one.",
			},
			"git_token_wo_version": schema.StringAttribute{
				Optional:    true,
				Description: "Any change sends the current git_token_wo to NBO again.",
			},
			"git_username": schema.StringAttribute{
				Optional:    true,
				Description: "The user name that goes with the token, for git hosts that want one. Only for git_credential = \"token\".",
				Validators:  []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"deploy_key_public": schema.StringAttribute{
				Computed:      true,
				Description:   "With git_credential = \"deploy-key\": the public half of the key NBO made, to add to the repository as a read-only deploy key. Null otherwise.",
				PlanModifiers: []planmodifier.String{deployKeyPublicModifier{}},
			},
			"delete_cloud_resources": schema.BoolAttribute{
				Optional:    true,
				Computed:    true,
				Default:     booldefault.StaticBool(false),
				Description: "Also delete what the project runs on each cloud when it is destroyed. Default false.",
			},
		},
	}
}

func (r *projectResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config projectModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if isSet(config.OutputDir) && isSet(config.Framework) && config.Framework.ValueString() != "static" {
		resp.Diagnostics.AddAttributeError(path.Root("output_dir"), "output_dir is for static sites", "NBO ignores output_dir unless framework is static.")
	}
	if isSet(config.RootDirectory) {
		if dir := config.RootDirectory.ValueString(); normalizeDir(dir) != dir {
			// NBO stores the short form, which would show as a change forever.
			resp.Diagnostics.AddAttributeError(path.Root("root_directory"), "root_directory is not in plain form", fmt.Sprintf("Write it as %q.", normalizeDir(dir)))
		}
	}
	validateCredential(config, &resp.Diagnostics)
	for _, cloud := range cloudsIn(ctx, config.Clouds, &resp.Diagnostics) {
		for _, problem := range cloudProblems(cloud) {
			resp.Diagnostics.AddAttributeError(path.Root("clouds"), "Invalid cloud", problem)
		}
	}
}

// ModifyPlan checks what a plan against existing state can only know now: a
// repository that moved to another host.
func (r *projectResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() {
		return
	}
	var plan, state projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	checkMove(&plan, &state, &resp.Diagnostics)
}

func isSet(v interface {
	IsNull() bool
	IsUnknown() bool
}) bool {
	return !v.IsNull() && !v.IsUnknown()
}

// cloudProblems checks the fields of a cloud against its target and mode.
// Values not known yet pass.
func cloudProblems(c cloudModel) []string {
	var problems []string
	mustBeEmpty := func(v types.String, name, when string) {
		if isSet(v) {
			problems = append(problems, fmt.Sprintf("%s has no meaning for %s.", name, when))
		}
	}
	mustBeSet := func(v types.String, name, when string) {
		if v.IsNull() {
			problems = append(problems, fmt.Sprintf("%s needs %s.", when, name))
		}
	}
	switch c.Target.ValueString() {
	case "kubernetes":
		mustBeEmpty(c.Mode, "mode", "kubernetes")
		mustBeEmpty(c.Region, "region", "kubernetes")
		mustBeEmpty(c.Project, "project", "kubernetes")
		mustBeEmpty(c.ArRepo, "ar_repo", "kubernetes")
	case "lambda":
		mustBeEmpty(c.ClusterID, "cluster_id", "lambda")
		mustBeEmpty(c.Mode, "mode", "lambda")
		mustBeEmpty(c.Region, "region", "lambda")
		mustBeEmpty(c.Project, "project", "lambda")
		mustBeEmpty(c.ArRepo, "ar_repo", "lambda")
	case "cloudrun":
		mustBeEmpty(c.ClusterID, "cluster_id", "cloudrun")
		mustBeSet(c.Mode, "mode", "cloudrun")
		switch c.Mode.ValueString() {
		case "auto":
			mustBeEmpty(c.Project, "project", "auto mode")
			mustBeEmpty(c.ArRepo, "ar_repo", "auto mode")
		case "manual":
			mustBeSet(c.Project, "project", "Manual mode")
			mustBeSet(c.Region, "region", "Manual mode")
			mustBeSet(c.ArRepo, "ar_repo", "Manual mode")
		}
	}
	return problems
}

// cloudsPlanModifier replaces the project when clouds truly change, and keeps
// the state's value when they only look different: see sameCloud.
type cloudsPlanModifier struct{}

func (cloudsPlanModifier) Description(context.Context) string {
	return "Changing clouds replaces the resource."
}

func (m cloudsPlanModifier) MarkdownDescription(ctx context.Context) string {
	return m.Description(ctx)
}

func (cloudsPlanModifier) PlanModifySet(ctx context.Context, req planmodifier.SetRequest, resp *planmodifier.SetResponse) {
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() || req.StateValue.Equal(req.ConfigValue) {
		return
	}
	if req.ConfigValue.IsUnknown() {
		resp.RequiresReplace = true
		return
	}
	state := cloudsIn(ctx, req.StateValue, &resp.Diagnostics)
	config := cloudsIn(ctx, req.ConfigValue, &resp.Diagnostics)
	if len(config) == len(req.ConfigValue.Elements()) && sameClouds(state, config) {
		resp.PlanValue = req.StateValue
		return
	}
	resp.RequiresReplace = true
}

func (m *projectModel) setupRequest(ctx context.Context, diags *diag.Diagnostics) client.SetupRequest {
	req := client.SetupRequest{
		// Building is nbo_deployment's job, so variables can exist first.
		SkipFirstBuild:          true,
		Name:                    m.Name.ValueString(),
		Repo:                    m.RepoURL.ValueString(),
		ProductionBranch:        m.Branch.ValueString(),
		Framework:               m.Framework.ValueString(),
		Spa:                     m.Spa.ValueBool(),
		BuildCommand:            m.BuildCommand.ValueString(),
		OutputDir:               m.OutputDir.ValueString(),
		IgnoredBuildStepCommand: m.IgnoredBuildStepCommand.ValueString(),
		RootDirectory:           m.RootDirectory.ValueString(),
	}
	for _, c := range cloudsIn(ctx, m.Clouds, diags) {
		req.Clouds = append(req.Clouds, client.Cloud{
			Target:    c.Target.ValueString(),
			ClusterID: c.ClusterID.ValueString(),
			Mode:      c.Mode.ValueString(),
			Region:    c.Region.ValueString(),
			Project:   c.Project.ValueString(),
			ArRepo:    c.ArRepo.ValueString(),
		})
	}
	// clouds is a set, so its order comes from Terraform's hashing, but NBO gives
	// the first cloud crons and first traffic.
	sort.SliceStable(req.Clouds, func(i, j int) bool {
		a, b := req.Clouds[i], req.Clouds[j]
		if a.Target != b.Target {
			return a.Target < b.Target
		}
		return a.ClusterID < b.ClusterID
	})
	return req
}

// fillFrom settles every value the plan left to NBO.
func (m *projectModel) fillFrom(s *client.ProjectSummary) {
	m.ID = types.StringValue(s.Project.ID)
	m.Stages = stagesMap(s)
	m.Address = types.StringValue(s.DomainURL)
	if m.DeployKeyPublic.IsUnknown() {
		m.DeployKeyPublic = types.StringNull()
	}
	if m.OutputDir.IsUnknown() {
		m.OutputDir = types.StringNull()
		if s.Git != nil {
			m.OutputDir = optString(s.Git.OutputDir)
		}
	}
	if m.PollingEnabled.IsUnknown() {
		m.PollingEnabled = types.BoolValue(s.Project.PollingEnabled)
	}
	if m.SpeedInsights.IsUnknown() {
		m.SpeedInsights = types.BoolValue(s.Project.SpeedInsights)
	}
	if m.SpeedInsightsInject.IsUnknown() {
		m.SpeedInsightsInject = types.BoolValue(s.Project.SpeedInsightsInject)
	}
	if m.SpeedInsightsSampleRate.IsUnknown() {
		m.SpeedInsightsSampleRate = types.Int64Value(s.Project.SpeedInsightsSampleRate)
	}
}

func (m *projectModel) settings() client.ProjectSettings {
	return client.ProjectSettings{
		PollingEnabled:          m.PollingEnabled.ValueBoolPointer(),
		SpeedInsights:           m.SpeedInsights.ValueBoolPointer(),
		SpeedInsightsInject:     m.SpeedInsightsInject.ValueBoolPointer(),
		SpeedInsightsSampleRate: m.SpeedInsightsSampleRate.ValueInt64Pointer(),
	}
}

func (r *projectResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	setup := plan.setupRequest(ctx, &resp.Diagnostics)
	var token types.String
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("git_token_wo"), &token)...)
	if resp.Diagnostics.HasError() {
		return
	}
	setup.Credential = plan.credentialToSend(token)
	summary, err := r.client.SetupProject(ctx, setup)
	if err != nil {
		resp.Diagnostics.AddError("Could not create the project", scrubToken(err, token).Error())
		return
	}

	// The project exists from here on: state keeps it whatever happens next,
	// so a later apply can't make a second one.
	plan.fillFrom(summary)
	keyErr := plan.readDeployKey(ctx, r.client, summary.Project.ID)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	if keyErr != nil {
		resp.Diagnostics.AddError("The project was created, but its deploy key could not be read", keyErr.Error())
		return
	}
	if resp.Diagnostics.HasError() {
		return
	}

	if patch := settingsPatch(plan.settings(), settingsOf(summary.Project)); !patch.Empty() {
		if _, err := r.client.UpdateProjectSettings(ctx, summary.Project.ID, patch); err != nil {
			resp.Diagnostics.AddError("The project was created, but its settings were not applied", err.Error())
			return
		}
	}

	final, err := waitForSetup(ctx, r.client, summary.Project.ID, setupTimeout, pollInterval)
	if err != nil && plan.GitCredential.ValueString() == credentialDeployKey && final != nil && (final.Project.SetupStatus == client.SetupWaitingForKey || final.Project.SetupStatus == client.SetupNeedsSetup) {
		// Expected: NBO can't read the repository until the key is added.
		resp.Diagnostics.AddWarning(
			"Add the deploy key to the repository",
			fmt.Sprintf("Project %s is waiting for its deploy key: %s\n\nAdd deploy_key_public to the repository as a read-only deploy key. NBO finds the key by itself (it checks on every poll for an hour, then every 10 minutes for 7 days), or run `nbo-server project retry %s` on the NBO server to finish at once.", summary.Project.ID, final.Project.SetupError, summary.Project.ID),
		)
		err = nil
	}
	if err != nil {
		resp.Diagnostics.AddError(
			"Project setup did not finish",
			fmt.Sprintf("Project %s exists and stays in state: %s\n\nThe next apply replaces it.", summary.Project.ID, err),
		)
		return
	}
	// A production project may have no address yet; nbo_deployment gives it one,
	// and the next refresh reads it.
	plan.Address = types.StringValue(final.DomainURL)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *projectResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state projectModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	summary, err := r.client.ProjectSummary(ctx, state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Could not read the project", err.Error())
		return
	}

	// clouds records how the project was set up. Filling it from the live
	// environments would turn a cloud added in the dashboard into a plan to
	// replace the project, so NBO's answer is only used after an import.
	clouds := state.Clouds
	state.projectData = projectDataFrom(ctx, summary, &resp.Diagnostics)
	if !clouds.IsNull() {
		state.Clouds = clouds
	}

	// After an import these are null, and would show as changes.
	if state.DeleteCloudResources.IsNull() {
		state.DeleteCloudResources = types.BoolValue(false)
	}
	if err := state.refreshCredential(ctx, r.client, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Could not read the project's git credential", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// gitConfig is the whole config PUT /projects/{id}/git replaces.
func (m *projectModel) gitConfig() client.GitConfig {
	return client.GitConfig{
		Repo:                    m.RepoURL.ValueString(),
		ProductionBranch:        m.Branch.ValueString(),
		Framework:               m.Framework.ValueString(),
		BuildCommand:            m.BuildCommand.ValueString(),
		OutputDir:               m.OutputDir.ValueString(),
		Spa:                     m.Spa.ValueBool(),
		IgnoredBuildStepCommand: m.IgnoredBuildStepCommand.ValueString(),
		RootDirectory:           m.RootDirectory.ValueString(),
	}
}

// settleOutputDir does what setup does for a value left out, since the PUT
// route doesn't: "dist" for a static site, nothing otherwise.
func (m *projectModel) settleOutputDir() {
	if !m.OutputDir.IsUnknown() {
		return
	}
	m.OutputDir = types.StringNull()
	if m.Framework.ValueString() == "static" {
		m.OutputDir = types.StringValue("dist")
	}
}

// outputDirPlanModifier keeps the state's output_dir when config leaves it out,
// unless framework changes: then the old value no longer applies.
type outputDirPlanModifier struct{}

func (outputDirPlanModifier) Description(context.Context) string {
	return "Keeps the output folder unless the framework changes."
}

func (m outputDirPlanModifier) MarkdownDescription(ctx context.Context) string {
	return m.Description(ctx)
}

func (outputDirPlanModifier) PlanModifyString(ctx context.Context, req planmodifier.StringRequest, resp *planmodifier.StringResponse) {
	if req.State.Raw.IsNull() || !req.PlanValue.IsUnknown() || req.ConfigValue.IsUnknown() {
		return
	}
	var planned, current types.String
	resp.Diagnostics.Append(req.Plan.GetAttribute(ctx, path.Root("framework"), &planned)...)
	resp.Diagnostics.Append(req.State.GetAttribute(ctx, path.Root("framework"), &current)...)
	if planned.Equal(current) {
		resp.PlanValue = req.StateValue
	}
}

func (r *projectResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	plan.settleOutputDir()
	var token types.String
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("git_token_wo"), &token)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// Nothing rebuilds here: new build settings apply to the next build.
	credential := plan.credentialChange(&state, token)
	if git := plan.gitConfig(); git != state.gitConfig() || credential != nil {
		var err error
		if credential != nil {
			err = r.client.UpdateProjectGitWithCredential(ctx, state.ID.ValueString(), git, *credential)
		} else {
			err = r.client.UpdateProjectGit(ctx, state.ID.ValueString(), git)
		}
		if err != nil {
			resp.Diagnostics.AddError("Could not update the project's build settings", scrubToken(err, token).Error())
			return
		}
	}
	if credential != nil && credential.Kind == credentialDeployKey && plan.repoMoved(&state) {
		if err := plan.renewDeployKey(ctx, r.client, state.ID.ValueString()); err != nil {
			resp.Diagnostics.AddError("Could not make a new deploy key", err.Error())
			return
		}
	}
	if err := plan.readDeployKey(ctx, r.client, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Could not read the project's deploy key", err.Error())
		return
	}
	if patch := settingsPatch(plan.settings(), state.settings()); !patch.Empty() {
		if _, err := r.client.UpdateProjectSettings(ctx, state.ID.ValueString(), patch); err != nil {
			resp.Diagnostics.AddError("Could not update the project", err.Error())
			return
		}
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *projectResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state projectModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteProject(ctx, state.ID.ValueString(), state.DeleteCloudResources.ValueBool())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Could not delete the project", err.Error())
	}
}

func (r *projectResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
