// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"nbo/terraform-provider/internal/client"
)

// This file is the logic shared by the nbo_project resource and data source:
// what they read from NBO, and waiting for setup.

// pollInterval is how often a wait checks NBO.
var pollInterval = 5 * time.Second

// projectData is what the resource and the data source have in common.
type projectData struct {
	ID                      types.String `tfsdk:"id"`
	Address                 types.String `tfsdk:"address"`
	Name                    types.String `tfsdk:"name"`
	RepoURL                 types.String `tfsdk:"repo_url"`
	Branch                  types.String `tfsdk:"branch"`
	Framework               types.String `tfsdk:"framework"`
	Spa                     types.Bool   `tfsdk:"spa"`
	BuildCommand            types.String `tfsdk:"build_command"`
	OutputDir               types.String `tfsdk:"output_dir"`
	IgnoredBuildStepCommand types.String `tfsdk:"ignored_build_step_command"`
	RootDirectory           types.String `tfsdk:"root_directory"`
	Clouds                  types.Set    `tfsdk:"clouds"`
	PollingEnabled          types.Bool   `tfsdk:"polling_enabled"`
	SpeedInsights           types.Bool   `tfsdk:"speed_insights"`
	SpeedInsightsInject     types.Bool   `tfsdk:"speed_insights_inject"`
	SpeedInsightsSampleRate types.Int64  `tfsdk:"speed_insights_sample_rate"`
	Stages                  types.Map    `tfsdk:"stages"`
}

// cloudModel is one entry of clouds.
type cloudModel struct {
	Target    types.String `tfsdk:"target"`
	ClusterID types.String `tfsdk:"cluster_id"`
	Mode      types.String `tfsdk:"mode"`
	Region    types.String `tfsdk:"region"`
	Project   types.String `tfsdk:"project"`
	ArRepo    types.String `tfsdk:"ar_repo"`
}

var cloudObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"target":     types.StringType,
	"cluster_id": types.StringType,
	"mode":       types.StringType,
	"region":     types.StringType,
	"project":    types.StringType,
	"ar_repo":    types.StringType,
}}

// projectDataFrom is a project as NBO reports it. NBO doesn't say which Cloud
// Run mode made an environment, so a cloud built here has no mode: see sameCloud.
func projectDataFrom(ctx context.Context, s *client.ProjectSummary, diags *diag.Diagnostics) projectData {
	data := projectData{
		ID:                      types.StringValue(s.Project.ID),
		Address:                 types.StringValue(s.DomainURL),
		Name:                    types.StringValue(s.Project.Name),
		PollingEnabled:          types.BoolValue(s.Project.PollingEnabled),
		SpeedInsights:           types.BoolValue(s.Project.SpeedInsights),
		SpeedInsightsInject:     types.BoolValue(s.Project.SpeedInsightsInject),
		SpeedInsightsSampleRate: types.Int64Value(s.Project.SpeedInsightsSampleRate),
		Spa:                     types.BoolValue(false),
	}
	if s.Git != nil {
		data.RepoURL = types.StringValue(s.Git.Repo)
		data.Branch = types.StringValue(s.Git.ProductionBranch)
		data.Framework = types.StringValue(s.Git.Framework)
		data.Spa = types.BoolValue(s.Git.Spa)
		data.BuildCommand = types.StringValue(s.Git.BuildCommand)
		data.OutputDir = optString(s.Git.OutputDir)
		data.IgnoredBuildStepCommand = optString(s.Git.IgnoredBuildStepCommand)
		data.RootDirectory = optString(s.Git.RootDirectory)
	}
	clouds := make([]cloudModel, 0, len(s.Environments))
	for _, env := range s.Environments {
		clouds = append(clouds, cloudFromEnvironment(env))
	}
	set, d := types.SetValueFrom(ctx, cloudObjectType, clouds)
	diags.Append(d...)
	data.Clouds = set
	data.Stages = stagesMap(s)
	return data
}

func cloudFromEnvironment(env client.Environment) cloudModel {
	cloud := cloudModel{Target: types.StringValue(env.Target)}
	if env.Target == "cloudrun" {
		cloud.Region = optString(env.Config.Region)
		cloud.Project = optString(env.Config.Project)
		cloud.ArRepo = optString(env.Config.ArRepo)
		return cloud
	}
	cloud.ClusterID = optString(env.ClusterID)
	return cloud
}

// cloudsIn reads a clouds set, leaving out entries not known yet.
func cloudsIn(ctx context.Context, set types.Set, diags *diag.Diagnostics) []cloudModel {
	var clouds []cloudModel
	for _, element := range set.Elements() {
		object, ok := element.(types.Object)
		if !ok || object.IsUnknown() || object.IsNull() {
			continue
		}
		var cloud cloudModel
		diags.Append(object.As(ctx, &cloud, basetypes.ObjectAsOptions{})...)
		clouds = append(clouds, cloud)
	}
	return clouds
}

// sameCloud decides whether a cloud in state already is what config asks for.
// NBO fills in what config may leave out, so plain equality would plan a
// replacement of a project that is fine:
//   - with one cluster connected, NBO picks it when config names none;
//   - after an import, a Cloud Run cloud has the region, project and registry
//     NBO resolved and no mode, so only what config spells out is compared.
func sameCloud(state, config cloudModel) bool {
	if !state.Target.Equal(config.Target) {
		return false
	}
	if state.Target.ValueString() != "cloudrun" {
		return config.ClusterID.IsNull() || state.ClusterID.Equal(config.ClusterID)
	}
	if !state.Mode.IsNull() {
		return state == config
	}
	return matchesIfSet(state.Region, config.Region) && matchesIfSet(state.Project, config.Project) && matchesIfSet(state.ArRepo, config.ArRepo)
}

func matchesIfSet(state, config types.String) bool {
	return config.IsNull() || state.Equal(config)
}

// sameClouds pairs every cloud in state with one in config.
func sameClouds(state, config []cloudModel) bool {
	if len(state) != len(config) {
		return false
	}
	taken := make([]bool, len(config))
	for _, s := range state {
		found := false
		for i, c := range config {
			if !taken[i] && sameCloud(s, c) {
				taken[i], found = true, true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// settingsPatch is what must be sent for have to become want.
func settingsPatch(want, have client.ProjectSettings) client.ProjectSettings {
	var patch client.ProjectSettings
	patch.PollingEnabled = changed(want.PollingEnabled, have.PollingEnabled)
	patch.SpeedInsights = changed(want.SpeedInsights, have.SpeedInsights)
	patch.SpeedInsightsInject = changed(want.SpeedInsightsInject, have.SpeedInsightsInject)
	patch.SpeedInsightsSampleRate = changed(want.SpeedInsightsSampleRate, have.SpeedInsightsSampleRate)
	return patch
}

func changed[T comparable](want, have *T) *T {
	if want == nil || (have != nil && *want == *have) {
		return nil
	}
	return want
}

func settingsOf(p client.Project) client.ProjectSettings {
	return client.ProjectSettings{
		PollingEnabled:          &p.PollingEnabled,
		SpeedInsights:           &p.SpeedInsights,
		SpeedInsightsInject:     &p.SpeedInsightsInject,
		SpeedInsightsSampleRate: &p.SpeedInsightsSampleRate,
	}
}

// setupTimeout bounds the wait for setup, which is finite but runs cloud commands.
var setupTimeout = 15 * time.Minute

// setupOutcome reads a summary: finished or not, and if so, what went wrong.
func setupOutcome(s *client.ProjectSummary) (bool, error) {
	switch s.Project.SetupStatus {
	case client.SetupReady:
		return true, nil
	case client.SetupNeedsSetup:
		return true, fmt.Errorf("setup failed: %s", s.Project.SetupError)
	case client.SetupWaitingForKey:
		return true, fmt.Errorf("setup is waiting for the deploy key: %s", s.Project.SetupError)
	}
	return false, nil
}

// waitForSetup follows a new project until its clouds are ready, and returns
// the last summary.
func waitForSetup(ctx context.Context, c *client.Client, id string, timeout, interval time.Duration) (*client.ProjectSummary, error) {
	var last *client.ProjectSummary
	err := poll(ctx, timeout, interval, func(ctx context.Context) (bool, error) {
		s, err := c.ProjectSummary(ctx, id)
		if err != nil {
			return false, err
		}
		last = s
		return setupOutcome(s)
	})
	return last, err
}

// poll calls check until it is done, and returns its error. Without done, an
// error doesn't end the wait, since the work carries on at NBO regardless;
// NBO refusing the request, or something that isn't NBO answering, does.
func poll(ctx context.Context, timeout, interval time.Duration, check func(context.Context) (bool, error)) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var lastErr error
	for {
		done, err := check(ctx)
		if done {
			return err
		}
		if err != nil && isFinal(err) {
			return err
		}
		// A request cut off by the deadline says less than the error before it.
		if ctx.Err() == nil {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return waitEnded(ctx, timeout, lastErr)
		case <-time.After(interval):
		}
	}
}

func waitEnded(ctx context.Context, timeout time.Duration, lastErr error) error {
	message := fmt.Sprintf("stopped waiting after %s; the work may still finish, see GET /projects/{id}/summary", timeout)
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		message = "stopped waiting because Terraform was cancelled; the work may still finish, see GET /projects/{id}/summary"
	}
	if lastErr != nil {
		return fmt.Errorf("%s. Last error: %w", message, lastErr)
	}
	return errors.New(message)
}

func isFinal(err error) bool {
	if errors.Is(err, client.ErrNotAPI) {
		return true
	}
	var apiErr *client.APIError
	return errors.As(err, &apiErr) && apiErr.Status >= http.StatusBadRequest && apiErr.Status < http.StatusInternalServerError
}

// normalizeDir is the control-plane's rule for a root directory
// (webhooks.ts normalizeDir): "./web/" is stored as "web".
func normalizeDir(dir string) string {
	dir = strings.ReplaceAll(dir, `\`, "/")
	for strings.HasPrefix(dir, "./") {
		dir = strings.TrimPrefix(dir, "./")
	}
	return strings.TrimRight(dir, "/")
}
