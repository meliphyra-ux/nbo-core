// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"net/http"
	"net/url"
)

// EnvVar is a variable as NBO lists it. Value is nil for a secret, and for a
// name declared without a value: NBO never returns a secret. Inherited marks a
// workspace variable in a project's list. Stage is a stage name, or "*" for
// every stage.
type EnvVar struct {
	Name      string  `json:"name"`
	Value     *string `json:"value"`
	Secret    bool    `json:"secret"`
	Inherited bool    `json:"inherited"`
	Stage     string  `json:"stage"`
}

// envPath is a variable list's address: projectID "" is the workspace.
func envPath(projectID string) string {
	if projectID == "" {
		return "/workspace/env"
	}
	return projectPath(projectID) + "/env"
}

// envVarPath is one variable's address, in a stage ("" is Production).
func envVarPath(projectID, stage, name string) string {
	path := envPath(projectID) + "/" + url.PathEscape(name)
	if stage != "" {
		path += "?stage=" + url.QueryEscape(stage)
	}
	return path
}

// ListEnv reads a project's variables, or the workspace's for projectID "".
// The list holds every stage's rows.
func (c *Client) ListEnv(ctx context.Context, projectID string) ([]EnvVar, error) {
	var out []EnvVar
	if err := c.do(ctx, http.MethodGet, envPath(projectID), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetEnv creates or replaces a variable of a stage ("" is Production, "*" is
// every stage). A nil value declares the name without a value, which is how
// names are kept while NBO stores no values.
func (c *Client) SetEnv(ctx context.Context, projectID, stage, name string, value *string, secret bool) error {
	body := struct {
		Value  *string `json:"value,omitempty"`
		Secret bool    `json:"secret"`
	}{value, secret}
	return c.do(ctx, http.MethodPut, envVarPath(projectID, stage, name), body, nil)
}

// DeleteEnv removes a variable of a stage.
func (c *Client) DeleteEnv(ctx context.Context, projectID, stage, name string) error {
	return c.do(ctx, http.MethodDelete, envVarPath(projectID, stage, name), nil, nil)
}

// StoresEnvValues reports whether NBO keeps variable values (GET
// /workspace/settings). When it does not, a name can be declared without one.
func (c *Client) StoresEnvValues(ctx context.Context) (bool, error) {
	var out struct {
		StoreEnvValues bool `json:"storeEnvValues"`
	}
	if err := c.do(ctx, http.MethodGet, "/workspace/settings", nil, &out); err != nil {
		return false, err
	}
	return out.StoreEnvValues, nil
}
