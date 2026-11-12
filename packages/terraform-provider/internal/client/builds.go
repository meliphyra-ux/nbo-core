// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"net/http"
	"net/url"
)

// StartBuildRequest says what to build. Stage is an environment name, empty
// for Production. Values are the variable values of a deploy when NBO keeps
// names only; they must never be logged or put in an error.
type StartBuildRequest struct {
	Stage  string            `json:"stage,omitempty"`
	Values map[string]string `json:"values,omitempty"`
}

// StartBuild queues a full build of the stage's branch head. It replaces a
// build of the same stage still queued, and waits behind one running.
func (c *Client) StartBuild(ctx context.Context, projectID string, req StartBuildRequest) (*Build, error) {
	var in any
	if req.Stage != "" || len(req.Values) > 0 {
		in = req
	}
	var out Build
	if err := c.do(ctx, http.MethodPost, projectPath(projectID)+"/builds", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Build reads one build.
func (c *Client) Build(ctx context.Context, id string) (*Build, error) {
	var out Build
	if err := c.do(ctx, http.MethodGet, "/builds/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ProjectBuilds reads a project's builds, oldest first.
func (c *Client) ProjectBuilds(ctx context.Context, projectID string) ([]Build, error) {
	var out []Build
	if err := c.do(ctx, http.MethodGet, projectPath(projectID)+"/builds", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}
