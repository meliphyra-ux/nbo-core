// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package client

import (
	"context"
	"net/http"
)

// SetTraffic sets a stage's split (stage "" is Production). weights maps
// environment ids to percent; NBO leaves any environment not listed as it was.
func (c *Client) SetTraffic(ctx context.Context, projectID, stage string, weights map[string]int64) error {
	body := struct {
		Stage   string           `json:"stage,omitempty"`
		Weights map[string]int64 `json:"weights"`
	}{stage, weights}
	return c.do(ctx, http.MethodPut, projectPath(projectID)+"/traffic", body, nil)
}
