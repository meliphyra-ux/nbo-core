// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { contentTypeFor } from "../content-type.js";

describe("contentTypeFor", () => {
  it("adds charset=utf-8 for html", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
  });

  it("adds charset=utf-8 for javascript", () => {
    expect(contentTypeFor("_assets/app.3f9a1c.js")).toBe("text/javascript; charset=utf-8");
  });

  it("does not add charset for binary types", () => {
    expect(contentTypeFor("logo.png")).toBe("image/png");
  });

  it("does not add charset for wasm", () => {
    expect(contentTypeFor("module.wasm")).toBe("application/wasm");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(contentTypeFor("data.unknownext")).toBe("application/octet-stream");
  });

  it("falls back to application/octet-stream for no extension", () => {
    expect(contentTypeFor("LICENSE")).toBe("application/octet-stream");
  });
});
