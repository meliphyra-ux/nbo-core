// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"nbo/terraform-provider/internal/client"
)

// This file is what the resources that take a stage share: the stage
// attribute, and how a stage and a set of values travel to NBO.

const productionStage = "production"

// stageAttribute is the optional stage a resource belongs to. Left out it is
// Production, and it reads back as "production", so the state of a resource
// made before environments existed (no stage) doesn't plan a replacement.
func stageAttribute(description string) schema.StringAttribute {
	return schema.StringAttribute{
		Optional:      true,
		Computed:      true,
		Description:   description + ` Left out, this is "production". Changing it replaces the resource.`,
		PlanModifiers: []planmodifier.String{stageModifier{}},
	}
}

// stageModifier fills the default and replaces the resource when its stage
// really changes.
type stageModifier struct{}

func (stageModifier) Description(context.Context) string {
	return `Defaults to "production"; changing the stage replaces the resource.`
}

func (m stageModifier) MarkdownDescription(ctx context.Context) string { return m.Description(ctx) }

func (stageModifier) PlanModifyString(_ context.Context, req planmodifier.StringRequest, resp *planmodifier.StringResponse) {
	if req.ConfigValue.IsUnknown() {
		// Not known yet: whether it differs from the state can't be told.
		resp.RequiresReplace = !req.State.Raw.IsNull()
		return
	}
	want := productionStage
	if !req.ConfigValue.IsNull() {
		want = req.ConfigValue.ValueString()
	}
	resp.PlanValue = types.StringValue(want)
	if req.State.Raw.IsNull() {
		return
	}
	had := productionStage
	if !req.StateValue.IsNull() && !req.StateValue.IsUnknown() {
		had = req.StateValue.ValueString()
	}
	resp.RequiresReplace = had != want
}

// apiStage is the stage a request names: "" for Production, which NBO takes
// as the default.
func apiStage(s types.String) string {
	if !isSet(s) || s.ValueString() == productionStage {
		return ""
	}
	return s.ValueString()
}

// stageValue is the stage as the resource shows it.
func stageValue(s string) types.String {
	if s == "" {
		return types.StringValue(productionStage)
	}
	return types.StringValue(s)
}

// stageEnvironments are the clouds of a stage ("" or production is the
// summary's own list).
func stageEnvironments(s *client.ProjectSummary, stage string) ([]client.Environment, bool) {
	if stage == "" || stage == productionStage {
		return s.Environments, true
	}
	for _, st := range s.Stages {
		if st.Name == stage {
			return st.Environments, true
		}
	}
	return nil, false
}

// stageNameFor is the name of the stage with this id, or "".
func stageNameFor(s *client.ProjectSummary, id string) string {
	for _, st := range s.Stages {
		if st.ID == id {
			return st.Name
		}
	}
	return ""
}

// stagesMap lists a project's environments by name, valued by id.
func stagesMap(s *client.ProjectSummary) types.Map {
	elements := map[string]string{}
	for _, st := range s.Stages {
		elements[st.Name] = st.ID
	}
	m, _ := types.MapValueFrom(context.Background(), types.StringType, elements)
	return m
}

// The rules of stages.ts validateStageName.
var stageNamePattern = regexp.MustCompile(`^[a-z]([-a-z0-9]{0,14}[a-z0-9])?$`)
var stageFnPart = regexp.MustCompile(`(^|-)fn(-|$)`)

// stageNameProblem is why name can't be a custom environment's, or "".
func stageNameProblem(name string) string {
	switch {
	case !stageNamePattern.MatchString(name):
		return "an environment name is 1 to 16 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen"
	case name == "production" || name == "preview" || name == "development":
		return `"` + name + `" is a built-in environment`
	case strings.HasPrefix(name, "pv-"):
		return `environment names starting with "pv-" are reserved`
	case stageFnPart.MatchString(name):
		return `environment names can't contain "fn" as a part between hyphens`
	}
	return ""
}

type stageNameValidator struct{}

func (stageNameValidator) Description(context.Context) string {
	return "1 to 16 lowercase letters, digits and hyphens; not a built-in name."
}

func (v stageNameValidator) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}

func (stageNameValidator) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if !isSet(req.ConfigValue) {
		return
	}
	if problem := stageNameProblem(req.ConfigValue.ValueString()); problem != "" {
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid environment name", problem)
	}
}

// valuesOf reads a map of strings; nil when it is null or unknown.
func valuesOf(ctx context.Context, m types.Map) (map[string]string, error) {
	if !isSet(m) {
		return nil, nil
	}
	out := map[string]string{}
	if diags := m.ElementsAs(ctx, &out, false); diags.HasError() {
		return nil, errors.New("values must be a map of strings")
	}
	return out, nil
}

// redactValues removes every value from text headed for a diagnostic. NBO
// tries not to echo values, but nothing sent with a deploy may reach a plan or
// a log if it does.
func redactValues(text string, values map[string]string) string {
	// Longest first, so a value that contains another is hidden whole.
	list := make([]string, 0, len(values))
	for _, v := range values {
		if v != "" {
			list = append(list, v)
		}
	}
	sort.Slice(list, func(i, j int) bool { return len(list[i]) > len(list[j]) })
	for _, v := range list {
		text = strings.ReplaceAll(text, v, "(value)")
	}
	return text
}

// scrubError is err with the values removed from its text.
func scrubError(err error, values map[string]string) error {
	if err == nil || len(values) == 0 {
		return err
	}
	return errors.New(redactValues(err.Error(), values))
}

// importedState recognises the state an import leaves for a deployment: its
// triggers are the empty map nothing else produces. What import can't know
// must not rebuild.
func importedState(ctx context.Context, state tfsdk.State) bool {
	if state.Raw.IsNull() {
		return false
	}
	var triggers types.Map
	if diags := state.GetAttribute(ctx, path.Root("triggers"), &triggers); diags.HasError() {
		return false
	}
	return importedTriggers(triggers)
}
