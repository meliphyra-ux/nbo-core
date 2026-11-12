# 0004: The Terraform provider is written in Go

Date: 2026-11-07. Status: accepted (Claude's call, the maintainer chose to skip questions).

## Context

The platform moved from Go to TypeScript on 2026-10-30, and the project's rules say everything lives in TypeScript under `packages/`. Terraform talks to providers over a gRPC plugin protocol. Its supported framework, `terraform-plugin-framework`, exists only in Go. The TypeScript route, CDK for Terraform, is a way to write configurations and doesn't produce a provider.

## Decision

`packages/terraform-provider` is a standalone Go module, the one exception to the TypeScript rule. It has no `package.json`, so pnpm and turbo ignore it, and `.dockerignore` keeps it out of the image. It depends on NBO only through the HTTP API.

## Cost

A second toolchain for one package. `pnpm test` doesn't run its tests: use `go test ./...` in that folder. The provider re-declares the API's shapes by hand, so a changed route needs a matching change there, and `PUT /projects/{id}/git` replaces the whole config, so a new field there must be added to `client.GitConfig` too.
