// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { renderEnvVarsFile } from "@nbo/deploy";

// gcloud reads --env-vars-file with a YAML 1.1 loader: every key and
// value must come back as the exact same string.
describe("Cloud Run env-vars file under a YAML 1.1 parser", () => {
  it("round-trips names and values YAML 1.1 would otherwise retype", () => {
    const vars: Record<string, string> = {
      YES: "NO",
      ON: "off",
      NULL: "null",
      Y: "n",
      TRUE: "~",
      OCTAL: "0755",
      SEXAGESIMAL: "1:30",
      EMPTY: "",
      QUOTES: `"a" 'b'`,
      BACKSLASH: "C:\\x\\",
      MULTI: "l1\nl2\r\n\tl3",
      SYNTAX: "a: b # c - [d] {e} &f *g !h | >",
      UNICODE: "héllo 日本 😀",
      BREAKS: "a\u2028b\u2029c\u0085d\u007fe\ufefff",
    };
    const parsed = parse(renderEnvVarsFile(vars), { version: "1.1" }) as Record<string, unknown>;
    expect(parsed).toEqual(vars);
    for (const v of Object.values(parsed)) expect(typeof v).toBe("string");
  });
});
