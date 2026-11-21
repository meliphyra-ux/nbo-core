// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The build sandbox runs this inside the build's container after the build command; NBO_PRODUCE holds the job
// (produce-output.js) as JSON.
import { produceOutput } from "./produce-output.js";

let failure;
try {
  const job = JSON.parse(process.env.NBO_PRODUCE ?? "{}");
  failure = await produceOutput({ ...job, env: process.env, log: (text) => process.stdout.write(text) });
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
}
if (failure) {
  // The sandbox reads this line as the build's error.
  process.stdout.write(`\nnbo-produce-failed: ${failure.split("\n")[0]}\n`);
  process.exitCode = 3;
}
