// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
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
	_ resource.ResourceWithConfigure      = &domainResource{}
	_ resource.ResourceWithImportState    = &domainResource{}
	_ resource.ResourceWithValidateConfig = &domainResource{}
)

type domainResource struct {
	resourceBase
}

func newDomainResource() resource.Resource {
	return &domainResource{}
}

type domainModel struct {
	ID        types.String `tfsdk:"id"`
	ProjectID types.String `tfsdk:"project_id"`
	Host      types.String `tfsdk:"host"`
	Stage     types.String `tfsdk:"stage"`
	Status    types.String `tfsdk:"status"`
	Serving   types.String `tfsdk:"serving"`
	Records   types.List   `tfsdk:"records"`
}

type recordModel struct {
	Type  types.String `tfsdk:"type"`
	Name  types.String `tfsdk:"name"`
	Value types.String `tfsdk:"value"`
}

var recordObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"type":  types.StringType,
	"name":  types.StringType,
	"value": types.StringType,
}}

func (r *domainResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_domain"
}

func (r *domainResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	computed := func(description string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, Description: description}
	}
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	resp.Schema = schema.Schema{
		Description: "A custom domain of a project. Terraform doesn't wait for it to become active, since that depends on the DNS records in records.",
		Attributes: map[string]schema.Attribute{
			"id":         computed("The domain's id."),
			"project_id": schema.StringAttribute{Required: true, Description: "The project. Changing it replaces the domain.", PlanModifiers: replace},
			"host":       schema.StringAttribute{Required: true, Description: "The domain name, in lowercase. Changing it replaces the domain.", PlanModifiers: replace},
			"stage":      stageAttribute("The environment the domain serves. Custom environments need the public edge."),
			"status":     computed("Where the domain is on its way to active."),
			"serving":    computed(`Who answers for the host: "edge" or "cloudrun".`),
			"records": schema.ListNestedAttribute{
				Computed:    true,
				Description: "The DNS records to create. Unknown at the first plan, so use records[0] for an edge domain. A Cloud Run domain has none until ownership is verified, so its DNS record cannot be made in the same run.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"type":  computed("The record type."),
						"name":  computed("The record name."),
						"value": computed("The record value."),
					},
				},
			},
		},
	}
}

// normalizeHost is the control-plane's rule for a host (domains.ts
// normalizeDomainHost), without the checks NBO reports itself.
func normalizeHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
}

func (r *domainResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config domainModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() || !isSet(config.Host) {
		return
	}
	// NBO stores the plain form, which would show as a change forever.
	if host := config.Host.ValueString(); normalizeHost(host) != host {
		resp.Diagnostics.AddAttributeError(path.Root("host"), "host is not in plain form", fmt.Sprintf("Write it as %q.", normalizeHost(host)))
	}
}

// domainRecords is what to put in DNS: a Cloud Run mapping's own records,
// otherwise the edge's one. A domain moved to the edge may still keep a
// mapping, whose records no longer apply.
func domainRecords(d *client.Domain) []client.DNSRecord {
	if d.Serving == "cloudrun" {
		return d.MappingRecords
	}
	return []client.DNSRecord{d.Record}
}

func (m *domainModel) fillFrom(ctx context.Context, d *client.Domain, diags *diag.Diagnostics) {
	m.ID = types.StringValue(d.ID)
	m.Host = types.StringValue(d.Host)
	m.Status = types.StringValue(d.Status)
	m.Serving = types.StringValue(d.Serving)
	if d.Stage != "" {
		m.Stage = types.StringValue(d.Stage)
	} else if !isSet(m.Stage) {
		m.Stage = stageValue("")
	}
	records := []recordModel{}
	for _, record := range domainRecords(d) {
		records = append(records, recordModel{types.StringValue(record.Type), types.StringValue(record.Name), types.StringValue(record.Value)})
	}
	list, listDiags := types.ListValueFrom(ctx, recordObjectType, records)
	diags.Append(listDiags...)
	m.Records = list
}

// findDomain looks a domain up by host, which can't change and survives the
// domain being removed and added again: nil when there is none, or when the
// project is gone.
func findDomain(ctx context.Context, c *client.Client, projectID, host string) (*client.Domain, error) {
	domains, err := c.Domains(ctx, projectID)
	if client.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	for i := range domains {
		if domains[i].Host == host {
			return &domains[i], nil
		}
	}
	return nil, nil
}

func (r *domainResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan domainModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	domain, err := r.client.AddDomain(ctx, plan.ProjectID.ValueString(), plan.Host.ValueString(), apiStage(plan.Stage))
	if err != nil {
		resp.Diagnostics.AddError("Could not add the domain", err.Error())
		return
	}
	plan.fillFrom(ctx, domain, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *domainResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state domainModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	domain, err := findDomain(ctx, r.client, state.ProjectID.ValueString(), state.Host.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Could not read the domain", err.Error())
		return
	}
	if domain == nil {
		resp.State.RemoveResource(ctx)
		return
	}
	state.fillFrom(ctx, domain, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Update is never called: every attribute either replaces the domain or is
// computed.
func (r *domainResource) Update(context.Context, resource.UpdateRequest, *resource.UpdateResponse) {
}

func (r *domainResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state domainModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteDomain(ctx, state.ProjectID.ValueString(), state.ID.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Could not remove the domain", err.Error())
	}
}

func (r *domainResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	projectID, host, ok := splitImportID(req.ID)
	if !ok {
		resp.Diagnostics.AddError("Invalid import id", fmt.Sprintf("Expected <project id>/<host>, got %q.", req.ID))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project_id"), projectID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("host"), host)...)
}
