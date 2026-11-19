// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Store } from "../store/store.js";
import type { Router } from "./router.js";
import type { V2 } from "../v2.js";
import { registerConnectionRoutes } from "../clouds/connection-routes.js";
import { registerBuildRoutes } from "../builds/build-routes.js";
import { registerDomainRoutes } from "../domains/domain-routes.js";
import { registerStageRoutes } from "../stages/stage-routes.js";
import { registerRevalidateRoutes } from "../stages/revalidate-routes.js";
import { registerProtectionRoutes } from "../protection/protection-routes.js";
import { registerProjectRoutes } from "./v2-project-routes.js";
import { registerTrafficRoutes } from "./v2-traffic-routes.js";
import { registerLifecycleRoutes } from "./v2-lifecycle-routes.js";

export {
  busiest,
  environmentSummaries,
  environmentView,
  type BuildSummary,
  type EnvironmentSummary,
  type EnvironmentView,
  type ProjectSummary,
} from "./project-summary.js";

export function registerV2Routes(router: Router, store: Store, v2: V2): void {
  registerConnectionRoutes(router, store, v2);
  registerBuildRoutes(router, store, v2.artifacts);
  registerDomainRoutes(router, store, v2);
  registerStageRoutes(router, store, v2);
  registerRevalidateRoutes(router, store, v2);
  registerProtectionRoutes(router, store, v2);
  registerProjectRoutes(router, store, v2);
  registerTrafficRoutes(router, store, v2);
  registerLifecycleRoutes(router, store, v2);
}
