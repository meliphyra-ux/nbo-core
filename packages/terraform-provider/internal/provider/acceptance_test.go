// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

package provider

import (
	"fmt"
	"os"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

// It needs TF_ACC=1, a terraform binary, and a real NBO in dev mode with
// NBO_ENDPOINT, NBO_TOKEN and NBO_ACC_REPO_URL (a public static-site
// repository) set. NBO_ACC_BUILD_COMMAND replaces the default build command,
// for example to build without running the repository's own code. It creates
// and destroys a project.
func TestAccProject(t *testing.T) {
	repo := os.Getenv("NBO_ACC_REPO_URL")
	if os.Getenv("TF_ACC") != "" && repo == "" {
		t.Skip("set NBO_ACC_REPO_URL to run this test")
	}
	build := os.Getenv("NBO_ACC_BUILD_COMMAND")
	if build == "" {
		build = "npm install && npm run build"
	}
	config := fmt.Sprintf(`
resource "nbo_project" "test" {
  name          = "tf-acc-project"
  repo_url      = %q
  branch        = "main"
  framework     = "static"
  build_command = %q

  clouds = [{ target = "kubernetes" }]
}

resource "nbo_env_var" "test" {
  project_id = nbo_project.test.id
  name       = "TF_ACC_GREETING"
  value      = "hello"
}

resource "nbo_deployment" "test" {
  project_id = nbo_project.test.id
  triggers   = { greeting = nbo_env_var.test.value }

  depends_on = [nbo_env_var.test]
}

data "nbo_project" "test" {
  name = nbo_project.test.name
}
`, repo, build)

	resource.Test(t, resource.TestCase{
		ProtoV6ProviderFactories: map[string]func() (tfprotov6.ProviderServer, error){
			"nbo": providerserver.NewProtocol6WithError(New("test")()),
		},
		Steps: []resource.TestStep{
			{
				Config: config,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrSet("nbo_project.test", "id"),
					resource.TestCheckResourceAttr("nbo_deployment.test", "status", "succeeded"),
					resource.TestCheckResourceAttrSet("nbo_deployment.test", "commit"),
					resource.TestCheckResourceAttrPair("data.nbo_project.test", "id", "nbo_project.test", "id"),
				),
			},
			{
				ResourceName:      "nbo_project.test",
				ImportState:       true,
				ImportStateVerify: true,
				// clouds comes from the live environments after an import, so it
				// has no value for what config left out; it is compared at plan time.
				ImportStateVerifyIgnore: []string{"clouds"},
			},
		},
	})
}
