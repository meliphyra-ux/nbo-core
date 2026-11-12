// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// withBuildId makes Next's build id reproducible: when NBO_BUILD_ID is set
// and the site's own generateBuildId gives nothing (Next's default returns
// null, so it would pick a random id), the build id becomes NBO_BUILD_ID.
// A site's own non-null id still wins. Without NBO_BUILD_ID the config is
// returned untouched.
export function withBuildId(config, env = process.env) {
  const id = env.NBO_BUILD_ID;
  if (id === undefined || id === "") return config;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('NBO_BUILD_ID must be letters, digits, "-" or "_"');
  }
  const own = config.generateBuildId;
  config.generateBuildId = async () => {
    const mine = typeof own === "function" ? await own() : null;
    return mine ?? id;
  };
  return config;
}
