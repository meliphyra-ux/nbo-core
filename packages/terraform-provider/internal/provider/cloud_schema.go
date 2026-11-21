// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
)

// cloudNestedObject is one entry of a clouds set, for nbo_project and nbo_stage.
func cloudNestedObject() schema.NestedAttributeObject {
	return schema.NestedAttributeObject{
		Attributes: map[string]schema.Attribute{
			"target": schema.StringAttribute{
				Required:    true,
				Description: `"kubernetes", "cloudrun" or "lambda" (AWS Lambda, in the AWS connection's region).`,
				Validators:  []validator.String{stringvalidator.OneOf("kubernetes", "cloudrun", "lambda")},
			},
			"cluster_id": schema.StringAttribute{
				Optional:    true,
				Description: "Kubernetes: the connected cluster's id (kc_...). May be left out when one cluster is connected.",
			},
			"mode": schema.StringAttribute{
				Optional:    true,
				Description: `Cloud Run: "auto" or "manual".`,
				Validators:  []validator.String{stringvalidator.OneOf("auto", "manual")},
			},
			"region": schema.StringAttribute{
				Optional:    true,
				Description: "Cloud Run: the region. Required with manual mode.",
			},
			"project": schema.StringAttribute{
				Optional:    true,
				Description: "Cloud Run, manual mode: the Google Cloud project.",
			},
			"ar_repo": schema.StringAttribute{
				Optional:    true,
				Description: "Cloud Run, manual mode: the Artifact Registry repository.",
			},
		},
	}
}
