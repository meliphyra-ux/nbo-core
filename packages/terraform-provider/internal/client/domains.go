// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"net/http"
	"net/url"
)

// DNSRecord is a record NBO or Cloud Run asks the owner to create.
type DNSRecord struct {
	Type  string `json:"type"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Domain is a project's domain (domain-routes.ts DomainView). Record is what
// the edge needs; MappingRecords is what a Cloud Run domain mapping needs.
type Domain struct {
	ID             string      `json:"id"`
	Host           string      `json:"host"`
	Status         string      `json:"status"`
	Serving        string      `json:"serving"`
	MappingRecords []DNSRecord `json:"mappingRecords"`
	Stage          string      `json:"stage"`
	Record         DNSRecord   `json:"record"`
}

// Domains reads a project's domains.
func (c *Client) Domains(ctx context.Context, projectID string) ([]Domain, error) {
	var out struct {
		Domains []Domain `json:"domains"`
	}
	if err := c.do(ctx, http.MethodGet, projectPath(projectID)+"/domains", nil, &out); err != nil {
		return nil, err
	}
	return out.Domains, nil
}

// AddDomain adds a custom domain to a stage ("" is Production).
func (c *Client) AddDomain(ctx context.Context, projectID, host, stage string) (*Domain, error) {
	body := struct {
		Host  string `json:"host"`
		Stage string `json:"stage,omitempty"`
	}{host, stage}
	var out Domain
	if err := c.do(ctx, http.MethodPost, projectPath(projectID)+"/domains", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteDomain removes a domain.
func (c *Client) DeleteDomain(ctx context.Context, projectID, domainID string) error {
	return c.do(ctx, http.MethodDelete, projectPath(projectID)+"/domains/"+url.PathEscape(domainID), nil, nil)
}
