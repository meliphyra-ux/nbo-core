// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createStore, type Store } from "../../store/store.js";
import { createCloudTeardown } from "../cloud-teardown.js";
import { fakeAws, KEY_ID, SECRET } from "./aws-fixture.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

async function connectedStore(): Promise<Store> {
  const s = createStore(join(await mkdtemp(join(tmpdir(), "teardown-lambda-")), "test.db"));
  s.setSecretKey(randomBytes(32));
  s.saveAwsConnection(
    { region: "eu-west-1", accountId: "123456789012", repository: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/nbo" },
    { accessKeyId: KEY_ID, secretAccessKey: SECRET },
  );
  stores.push(s);
  return s;
}

// One stage's app, its function, Production's app of the same project, a
// sibling app whose name starts like this app's functions, and another
// project's app of the same stage name.
const app = "pabc-s-staging-lm";
const production = "pabc-lambda";
const sibling = "pabc-s-staging-lm-fn-x-lm";
const otherProject = "pdef-s-staging-lm";
// Lambda names carry the nbo- prefix (lambdaName); an unprefixed function is not NBO's.
const names = [
  app,
  `${app}-fn-ssr`,
  production,
  `${production}-fn-ssr`,
  sibling,
  `${sibling}-fn-ssr`,
  otherProject,
].map((n) => `nbo-${n}`);
names.push(app, `${app}-fn-ssr`);

describe("cloud teardown (Lambda)", () => {
  it("deletes only this app's functions, roles and image tags", async () => {
    const s = await connectedStore();
    const aws = fakeAws((line) => {
      if (line.startsWith("lambda list-functions"))
        return JSON.stringify({ Functions: names.map((FunctionName) => ({ FunctionName })) });
      if (line.startsWith("ecr list-images"))
        return JSON.stringify({
          imageIds: [
            ...names.map((n) => ({ imageDigest: "sha256:1", imageTag: `${n}_0123456789ab-l01234567` })),
            { imageDigest: "sha256:2", imageTag: `${app}_fedcba987654-l76543210` },
            { imageDigest: "sha256:4", imageTag: `nbo-${app}_fedcba987654-l76543210` },
            { imageDigest: "sha256:3" },
          ],
        });
      return undefined;
    });
    await createCloudTeardown(aws.run, { store: s }).remove({
      target: "lambda",
      appName: app,
      config: { region: "eu-west-1" },
      scope: "app",
      keep: [production, sibling],
    });
    const lines = aws.lines();
    expect(lines.filter((l) => l.startsWith("lambda delete-function"))).toEqual([
      `lambda delete-function --function-name nbo-${app} --output json`,
      `lambda delete-function --function-name nbo-${app}-fn-ssr --output json`,
    ]);
    expect(lines.filter((l) => l.startsWith("iam delete-role "))).toEqual([
      `iam delete-role --role-name nbo-${app} --output json`,
      `iam delete-role --role-name nbo-${app}-fn-ssr --output json`,
    ]);
    expect(lines.filter((l) => l.startsWith("ecr batch-delete-image"))).toEqual([
      `ecr batch-delete-image --repository-name nbo --image-ids imageTag=nbo-${app}_0123456789ab-l01234567 imageTag=nbo-${app}-fn-ssr_0123456789ab-l01234567 imageTag=nbo-${app}_fedcba987654-l76543210 --output json`,
    ]);
    for (const c of aws.calls) {
      expect(c.args.join(" ")).not.toContain(SECRET);
      expect(c.env).toMatchObject({
        AWS_ACCESS_KEY_ID: KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET,
        AWS_REGION: "eu-west-1",
      });
    }
  });

  it("deletes nothing in ECR when the app has no image tags, and treats a function already gone as removed", async () => {
    const s = await connectedStore();
    const aws = fakeAws((line) => {
      if (line.startsWith("lambda list-functions"))
        return JSON.stringify({ Functions: [{ FunctionName: `nbo-${app}` }] });
      if (line.startsWith("ecr list-images")) return JSON.stringify({ imageIds: [] });
      if (line.startsWith("lambda delete-function"))
        return new Error(
          "An error occurred (ResourceNotFoundException) when calling the DeleteFunction operation: Function not found",
        );
      return undefined;
    });
    await createCloudTeardown(aws.run, { store: s }).remove({ target: "lambda", appName: app, config: {} });
    expect(aws.lines().some((l) => l.startsWith("ecr batch-delete-image"))).toBe(false);
    expect(aws.lines()).toContain(`iam delete-role --role-name nbo-${app} --output json`);
  });

  it("fails without an AWS connection, and keeps the key pair out of an error", async () => {
    const none = createStore(join(await mkdtemp(join(tmpdir(), "teardown-lambda-")), "test.db"));
    stores.push(none);
    await expect(
      createCloudTeardown(fakeAws().run, { store: none }).remove({ target: "lambda", appName: app, config: {} }),
    ).rejects.toThrow("Lambda: AWS is not connected");
    const s = await connectedStore();
    const aws = fakeAws((line) =>
      line.startsWith("lambda list-functions") ? new Error(`AccessDenied for ${KEY_ID} ${SECRET}`) : undefined,
    );
    const err = await createCloudTeardown(aws.run, { store: s })
      .remove({ target: "lambda", appName: app, config: {} })
      .catch((e: Error) => e);
    expect(String(err)).toContain("Lambda:");
    expect(String(err)).not.toContain(SECRET);
    expect(String(err)).not.toContain(KEY_ID);
  });
});
