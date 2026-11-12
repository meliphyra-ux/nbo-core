// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"net/http"
	"net/url"
)

// Stage is an environment of a project (the dashboard's word; stage-routes.ts
// StageView). Production's Environments are also the summary's.
type Stage struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Kind         string        `json:"kind"`
	Branch       string        `json:"branch"`
	AutoDeploy   bool          `json:"autoDeploy"`
	Host         string        `json:"host"`
	URL          string        `json:"url"`
	Environments []Environment `json:"environments"`
}

// CreateStageRequest is the body of POST /projects/{id}/stages. AutoDeploy is
// left out when nil, and NBO then builds each new commit.
type CreateStageRequest struct {
	Name       string  `json:"name"`
	Branch     string  `json:"branch"`
	Clouds     []Cloud `json:"clouds"`
	AutoDeploy *bool   `json:"autoDeploy,omitempty"`
}

// UpdateStageRequest is the body of PATCH /projects/{id}/stages/{stageId}:
// only what is set is sent.
type UpdateStageRequest struct {
	Branch     *string `json:"branch,omitempty"`
	AutoDeploy *bool   `json:"autoDeploy,omitempty"`
}

func stagePath(projectID, stageID string) string {
	return projectPath(projectID) + "/stages/" + url.PathEscape(stageID)
}

// Stages reads a project's stages, built-ins first.
func (c *Client) Stages(ctx context.Context, projectID string) ([]Stage, error) {
	var out []Stage
	if err := c.do(ctx, http.MethodGet, projectPath(projectID)+"/stages", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateStage adds a custom environment. It builds nothing.
func (c *Client) CreateStage(ctx context.Context, projectID string, req CreateStageRequest) (*Stage, error) {
	var out Stage
	if err := c.do(ctx, http.MethodPost, projectPath(projectID)+"/stages", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateStage changes a custom environment's branch or auto-deploy.
func (c *Client) UpdateStage(ctx context.Context, projectID, stageID string, req UpdateStageRequest) (*Stage, error) {
	var out Stage
	if err := c.do(ctx, http.MethodPatch, stagePath(projectID, stageID), req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteStage removes a custom environment. With resources, NBO first deletes
// what each of its clouds runs.
func (c *Client) DeleteStage(ctx context.Context, projectID, stageID string, resources bool) error {
	path := stagePath(projectID, stageID)
	if resources {
		path += "?resources=true"
	}
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}
