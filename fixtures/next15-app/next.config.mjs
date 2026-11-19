// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Next.js before 16 has no adapter API: NBO reads .next/ after the build instead.
const nextConfig = {
  // Pinned so building the same commit twice gives the same .nbo/ content id.
  generateBuildId: async () => process.env.NBO_BUILD_ID || null,
};

export default nextConfig;
