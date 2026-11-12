// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Package client holds every HTTP call the provider makes to NBO's
// control-plane. Add a resource's routes in their own file next to
// projects.go, each as a typed method built on Client.do.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// A DELETE with cloud resources waits for the clouds to finish, so the limit
// only guards against a server that never answers.
const requestTimeout = 15 * time.Minute

// Client talks to one NBO control-plane with one API token.
type Client struct {
	endpoint string
	token    string
	http     *http.Client
}

// New returns a Client. endpoint is the API root, for example
// http://localhost:8081.
func New(endpoint, token string) *Client {
	return &Client{
		endpoint: strings.TrimRight(endpoint, "/"),
		token:    token,
		http:     &http.Client{Timeout: requestTimeout},
	}
}

// ErrNotAPI means the answer was not NBO's API: usually a 404 or a page
// from an endpoint with a path, such as an old /api/controlplane one.
var ErrNotAPI = errors.New("NBO answered with something that isn't its API. Check that endpoint is NBO's own address, such as http://localhost:8081, with no path.")

// APIError is an answer from NBO other than success. Message is NBO's own
// words when the body carried them.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("NBO answered %d: %s", e.Status, e.Message)
}

// IsNotFound reports whether err is NBO saying the object doesn't exist.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

// do sends one request. in, when not nil, is sent as JSON; out, when not nil,
// receives the JSON answer.
func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		encoded, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("encoding the request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, body)
	if err != nil {
		return errors.New(c.scrub(err.Error()))
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return errors.New(c.scrub(err.Error()))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return errors.New(c.scrub(err.Error()))
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return c.apiError(resp.StatusCode, raw)
	}
	if out == nil {
		if len(bytes.TrimSpace(raw)) > 0 && !json.Valid(raw) {
			return ErrNotAPI
		}
		return nil
	}
	if json.Unmarshal(raw, out) != nil {
		return ErrNotAPI
	}
	return nil
}

func (c *Client) apiError(status int, raw []byte) error {
	// Not IsNotFound, even on a 404: that means an object is gone, and a page
	// from the wrong address says nothing about objects.
	if !json.Valid(raw) {
		return ErrNotAPI
	}
	if status == http.StatusUnauthorized {
		return &APIError{Status: status, Message: "the token is invalid or revoked"}
	}
	var parsed struct {
		Error string `json:"error"`
	}
	message := fmt.Sprintf("unexpected answer (%s)", http.StatusText(status))
	if json.Unmarshal(raw, &parsed) == nil && parsed.Error != "" {
		message = c.scrub(parsed.Error)
	}
	return &APIError{Status: status, Message: message}
}

// scrub removes the token from text headed for an error, whatever produced it.
func (c *Client) scrub(text string) string {
	if c.token == "" {
		return text
	}
	return strings.ReplaceAll(text, c.token, "(token)")
}
