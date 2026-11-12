// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnvVars, deployTimeEnvVars, checkRequired } from "../env.js";

const savedEnvKeys: string[] = [];
const savedEnvValues = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnvValues.has(name)) {
    savedEnvValues.set(name, process.env[name]);
    savedEnvKeys.push(name);
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const name of savedEnvKeys.splice(0)) {
    const original = savedEnvValues.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  savedEnvValues.clear();
});

async function writeManifestEnv(env?: Record<string, unknown>, bindings?: Record<string, unknown>[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deploy-env-"));
  const manifest: Record<string, unknown> = { specVersion: "1.0" };
  if (env) manifest.env = env;
  if (bindings) manifest.bindings = bindings;
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

describe("mergeEnvVars", () => {
  it("lets extra override base on conflict", () => {
    const base = { A: "1", B: "2" };
    const extra = { B: "override", C: "3" };
    expect(mergeEnvVars(base, extra)).toEqual({ A: "1", B: "override", C: "3" });
  });
});

describe("deployTimeEnvVars", () => {
  it("fails naming a missing required name", async () => {
    const dir = await writeManifestEnv({ required: ["DATABASE_URL"] });
    setEnv("DATABASE_URL", undefined);

    await expect(deployTimeEnvVars(dir)).rejects.toThrow(/DATABASE_URL/);
  });

  it("includes a set required name", async () => {
    const dir = await writeManifestEnv({ required: ["DATABASE_URL"] });
    setEnv("DATABASE_URL", "postgres://x");

    const vars = await deployTimeEnvVars(dir);
    expect(vars.DATABASE_URL).toBe("postgres://x");
  });

  it("leaves an unset optional name absent, not an error", async () => {
    const dir = await writeManifestEnv({ optional: ["FEATURE_FLAG"] });
    setEnv("FEATURE_FLAG", undefined);

    const vars = await deployTimeEnvVars(dir);
    expect("FEATURE_FLAG" in vars).toBe(false);
  });

  it("resolves a binding to its uppercase NAME_URL", async () => {
    const dir = await writeManifestEnv(undefined, [{ name: "db", type: "postgres" }]);
    setEnv("DB_URL", "postgres://real");

    const vars = await deployTimeEnvVars(dir);
    expect(vars.DB_URL).toBe("postgres://real");
  });

  it("fails a missing binding value the same as a missing required name", async () => {
    const dir = await writeManifestEnv(undefined, [{ name: "db", type: "postgres" }]);
    setEnv("DB_URL", undefined);

    await expect(deployTimeEnvVars(dir)).rejects.toThrow(/DB_URL/);
  });

  it("reports every missing name at once", async () => {
    const dir = await writeManifestEnv({ required: ["A", "B"] });
    setEnv("A", undefined);
    setEnv("B", undefined);

    await expect(deployTimeEnvVars(dir)).rejects.toThrow(/A.*B|B.*A/);
  });

  it("merges the ISR-specific names in as optional", async () => {
    const dir = await writeManifestEnv();
    setEnv("NBO_ISRCACHE_URL", "https://cache.example.com");
    setEnv("NBO_PRERENDER_BYPASS", undefined);

    const vars = await deployTimeEnvVars(dir);
    expect(vars.NBO_ISRCACHE_URL).toBe("https://cache.example.com");
  });
  it("takes no values from process.env when given an empty source", async () => {
    const dir = await writeManifestEnv({ optional: ["SECRET_X"] });
    setEnv("SECRET_X", "leak");
    setEnv("NBO_ISRCACHE_URL", "https://leak.example.com");

    const vars = await deployTimeEnvVars(dir, { source: {} });
    expect(vars).toEqual({});
  });

  it("reads from the given source instead of process.env", async () => {
    const dir = await writeManifestEnv({ required: ["A"] });
    setEnv("A", "from-process");

    expect(await deployTimeEnvVars(dir, { source: { A: "from-source" } })).toEqual({ A: "from-source" });
  });

  it("still fails a required name missing from the source, and says NBO does not pass its environment", async () => {
    const dir = await writeManifestEnv({ required: ["DATABASE_URL"] });
    setEnv("DATABASE_URL", "postgres://leak");

    await expect(deployTimeEnvVars(dir, { source: {} })).rejects.toThrow(
      new Error(
        "deploy: missing required env/binding value(s): DATABASE_URL - NBO does not pass its own environment to apps; set them with PUT /projects/{id}/env/{name} or Terraform's nbo_env_var",
      ),
    );
  });
});

describe("deployTimeEnvVars with delivered user variables", () => {
  it("neither reads nor requires names the user's variables deliver", async () => {
    const dir = await writeManifestEnv({ required: ["A"], optional: ["B"] }, [{ name: "db", type: "postgres" }]);
    expect(await deployTimeEnvVars(dir, { source: { A: "nbo", B: "nbo", DB_URL: "nbo" }, delivered: ["A", "B", "DB_URL"] })).toEqual({});
    await expect(deployTimeEnvVars(dir, { source: {}, delivered: ["A", "B"] })).rejects.toThrow(/DB_URL/);
  });
});

describe("checkRequired", () => {
  it("names every missing required name and binding, pointing at the API and Terraform", async () => {
    const dir = await writeManifestEnv({ required: ["A", "B"] }, [{ name: "db", type: "postgres" }]);
    await expect(checkRequired(dir, new Set(["B"]))).rejects.toThrow(
      new Error("deploy: missing required environment variable(s): A, DB_URL - set them with PUT /projects/{id}/env/{name} or Terraform's nbo_env_var"),
    );
    await expect(checkRequired(dir, new Set(["A", "B", "DB_URL"]))).resolves.toBeUndefined();
  });
});
