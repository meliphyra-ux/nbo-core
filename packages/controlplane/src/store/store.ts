// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import {
  ErrNotFound,
  ErrDuplicateName,
  ErrInvalidEnvironmentConfig,
  ErrInvalidGitConfig,
  ErrInvalidEnvVar,
} from "./errors.js";
import { cronsSchema, attachCronMethods } from "../deploys/cron.js";
import { gitSchema, attachGitMethods } from "../git/git.js";
import { connectionsSchema, attachConnectionMethods } from "../clouds/connections.js";
import { envVarsSchema, attachEnvMethods } from "../variables/env-vars.js";
import { migrate, legacyTablesInUse } from "./migrate.js";
import { serverSettingsSchema, attachServerSettingsMethods } from "./server-settings.js";
import { domainsSchema, attachDomainMethods } from "../domains/domains.js";
import { relaysSchema, attachRelayMethods } from "../edge/relays.js";
import { revalidateTokensSchema, attachRevalidateTokenMethods } from "../variables/revalidate-tokens.js";
import { protectionSchema, attachProtectionMethods } from "../protection/protection.js";
import { apiTokensSchema, attachApiTokenMethods } from "../http/api-tokens.js";
import { stagesSchema, attachStageMethods } from "../stages/stages.js";
import { attachGitHeadMethods } from "../git/git-heads.js";
import { gitCredentialsSchema, attachGitCredentialMethods } from "../git/git-credentials.js";
import { linkSchema, attachLinkMethods } from "../link/link-store.js";
import { ephemeralCertsSchema, attachEphemeralCertMethods } from "../domains/ephemeral-certs.js";
import { baseSchema } from "./store-rows.js";
import { projectMethods } from "./store-projects.js";
import { environmentMethods } from "./store-environments.js";
import { deploymentMethods } from "./store-deployments.js";
import type { Store } from "./store-types.js";

export { ErrNotFound, ErrDuplicateName, ErrInvalidEnvironmentConfig, ErrInvalidGitConfig, ErrInvalidEnvVar };

export { baseSchema };
export type {
  SetupStatus,
  Project,
  ProjectPatch,
  Environment,
  Deployment,
  TransferStatus,
  Transfer,
  Store,
} from "./store-types.js";

// createStore opens (creating if absent) the SQLite database at path
// and runs the schema. Fails immediately with a clear error if path's
// parent directory doesn't exist, rather than letting the driver's
// own cryptic "unable to open database file" surface on the first
// real query.
// options.artifactsDir is the artifact store's directory: deleting a
// project also deletes its builds' stored output there.
export function createStore(path: string, options?: { secretKey?: Buffer; artifactsDir?: string }): Store {
  const dir = dirname(path);
  try {
    statSync(dir);
  } catch {
    throw new Error(`controlplane: database directory "${dir}" does not exist`);
  }

  const db = new DatabaseSync(path);
  try {
    migrate(db, [
      baseSchema,
      cronsSchema,
      gitSchema,
      connectionsSchema,
      envVarsSchema,
      serverSettingsSchema,
      domainsSchema,
      relaysSchema,
      apiTokensSchema,
      stagesSchema,
      ephemeralCertsSchema,
      revalidateTokensSchema,
      protectionSchema,
      gitCredentialsSchema,
      linkSchema,
    ]);
  } catch (err) {
    // A refused database (ErrStrandedSettings) is not left open.
    db.close();
    throw err;
  }

  const store = {
    close() {
      db.close();
    },

    legacyTablesInUse(): string[] {
      return legacyTablesInUse(db);
    },

    ...projectMethods(db, options),
    ...environmentMethods(db),
    ...deploymentMethods(db),
  };

  // attachCronMethods/attachGitMethods mutate store in place (adding
  // the methods cron.ts/git.ts implement) and return it — kept in their
  // own files to avoid a circular import with this one.
  const attached = attachRevalidateTokenMethods(
    db,
    attachGitHeadMethods(
      db,
      attachEphemeralCertMethods(
        db,
        attachStageMethods(
          db,
          attachApiTokenMethods(
            db,
            attachRelayMethods(
              db,
              attachDomainMethods(
                db,
                attachServerSettingsMethods(
                  db,
                  attachEnvMethods(
                    db,
                    attachConnectionMethods(
                      db,
                      attachGitMethods(db, attachCronMethods(db, store as Store)),
                      options?.secretKey,
                    ),
                    options?.secretKey,
                  ),
                  options?.secretKey,
                ),
              ),
              options?.secretKey,
            ),
          ),
        ),
      ),
    ),
    options?.secretKey,
  );
  return attachProtectionMethods(
    db,
    attachLinkMethods(db, attachGitCredentialMethods(db, attached, options?.secretKey), options?.secretKey),
  );
}
