// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Command terraform-provider-nbo is the Terraform provider for NBO.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"nbo/terraform-provider/internal/provider"
)

// version is set at release time with -ldflags.
var version = "dev"

func main() {
	debug := flag.Bool("debug", false, "run with support for debuggers such as delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/nbo/nbo",
		Debug:   *debug,
	})
	if err != nil {
		log.Fatal(err)
	}
}
