// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { validateReport } from "@nbo/validate";

// runValidate checks a .nbo/ directory, returning an exit code instead
// of calling process.exit directly so it stays testable without killing
// the test process. Warnings (problems a build stored before spec 1.0
// final may have) are printed and don't fail the run; --strict, which
// producers' tests and CI use on fresh builds, makes them errors.
export async function runValidate(args: string[]): Promise<number> {
  const strict = args.includes("--strict");
  const rest = args.filter((a) => a !== "--strict");
  if (rest.length < 1) {
    console.error("usage: nbo validate [--strict] <dir>");
    return 1;
  }
  const { errors, warnings } = validateReport(rest[0]!, { strict });
  for (const w of warnings) console.error(`warning: ${w.message}`);
  if (errors.length === 0) {
    console.log("ok");
    return 0;
  }
  for (const e of errors) console.error(e.message);
  return 1;
}
