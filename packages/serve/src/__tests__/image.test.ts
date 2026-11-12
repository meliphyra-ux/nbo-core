// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createRouter } from "@nbo/router";
import { createStore } from "@nbo/isrcache";
import type { Resolver } from "@nbo/funcproxy";
import type { ServeState, ImagesConfig } from "../serve.js";
import { handleImage, loadImagesConfig } from "../image.js";
import { createFakeCacheService } from "./fake-cache-service.js";

async function testPNG(width: number, height: number, transparent: boolean): Promise<Buffer> {
  const channels = transparent ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (transparent) {
        raw[i] = 200;
        raw[i + 1] = 50;
        raw[i + 2] = 50;
        raw[i + 3] = x < width / 2 ? 0 : 255;
      } else {
        raw[i] = 50;
        raw[i + 1] = 100;
        raw[i + 2] = 200;
      }
    }
  }
  return sharp(raw, { raw: { width, height, channels: channels as 3 | 4 } })
    .png()
    .toBuffer();
}

function testImagesConfig(): ImagesConfig {
  return {
    widths: [100, 200],
    formats: ["image/webp"],
    qualities: [75],
    localPatterns: [{ pathname: "^/[a-z]+\\.png$" }],
    remotePatterns: [{ protocol: "https", hostname: "^cdn\\.acme\\.com$", pathname: "^/img/.*$" }],
    minimumCacheTTLSec: 3600,
    allowSvg: false,
  };
}

function newTestImageServer(cfg: ImagesConfig, resolveCache?: Resolver): ServeState {
  return {
    nboDir: "",
    index: new Map(),
    router: createRouter({ version: 1 }, "never"),
    resolveCache,
    prerenders: [],
    images: cfg,
    regenInFlight: new Set(),
  };
}

describe("handleImage", () => {
  it("rejects a width not in the allowlist", async () => {
    const state = newTestImageServer(testImagesConfig());
    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=999&q=75"));
    expect(res.status).toBe(400);
  });

  it("rejects a quality not in the allowlist", async () => {
    const state = newTestImageServer(testImagesConfig());
    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=99"));
    expect(res.status).toBe(400);
  });

  it("rejects a url matching no pattern", async () => {
    const state = newTestImageServer(testImagesConfig());
    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fnot-listed.png&w=100&q=75"));
    expect(res.status).toBe(400);
  });

  // Guards the Review Focus's own named case: a naive substring check
  // on the hostname would let evil-cdn.acme.com.attacker.net through
  // just because it contains "cdn.acme.com". Anchored RE2 matching
  // must reject it.
  it("rejects a substring hostname match", async () => {
    const state = newTestImageServer(testImagesConfig());
    const url = encodeURIComponent("https://evil-cdn.acme.com.attacker.net/img/x.png");
    const res = await handleImage(state, new Request(`http://x/_nbo/image?url=${url}&w=100&q=75`));
    expect(res.status).toBe(400);
  });

  // Final review I3: Next allows every local path when localPatterns is
  // unset, and the Next producer before spec 1.0 final wrote [] for that.
  for (const [name, localPatterns] of [
    ["absent", undefined],
    ["empty (an older Next build's unset list)", []],
    ["a pattern with no pathname", [{}]],
  ] as const) {
    it(`allows any local path when localPatterns is ${name}`, async () => {
      const cfg = { ...testImagesConfig(), localPatterns: localPatterns as ImagesConfig["localPatterns"] };
      const state = newTestImageServer(cfg);
      state.nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
      await mkdir(join(state.nboDir, "static", "deep"), { recursive: true });
      await writeFile(join(state.nboDir, "static", "deep", "Photo-1.png"), await testPNG(400, 300, false));
      state.index.set("/deep/Photo-1.png", { file: "deep/Photo-1.png", contentType: "image/png", cache: "" });
      const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fdeep%2FPhoto-1.png&w=100&q=75"));
      expect(res.status).toBe(200);
    });
  }

  it("matches a remote pattern with no pathname against any path, and still checks the hostname", async () => {
    const cfg = { ...testImagesConfig(), remotePatterns: [{ protocol: "https", hostname: "^cdn\\.acme\\.com$" }] as ImagesConfig["remotePatterns"] };
    const state = newTestImageServer(cfg);
    const other = encodeURIComponent("https://other.example/anything.png");
    expect((await handleImage(state, new Request(`http://x/_nbo/image?url=${other}&w=100&q=75`))).status).toBe(400);
  });

  it("resizes a real local image", async () => {
    const state = newTestImageServer(testImagesConfig());
    state.nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await mkdir(join(state.nboDir, "static"), { recursive: true });
    await writeFile(join(state.nboDir, "static", "photo.png"), await testPNG(400, 300, false));
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });

    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res.status).toBe(200);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.width).toBe(100);
  });

  it("picks png for a transparent source and jpeg otherwise", async () => {
    const state = newTestImageServer(testImagesConfig());
    state.nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await mkdir(join(state.nboDir, "static"), { recursive: true });

    await writeFile(join(state.nboDir, "static", "photo.png"), await testPNG(400, 300, false));
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });
    const res1 = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res1.headers.get("content-type")).toBe("image/jpeg");

    await writeFile(join(state.nboDir, "static", "transparent.png"), await testPNG(400, 300, true));
    state.index.set("/transparent.png", { file: "transparent.png", contentType: "image/png", cache: "" });
    const res2 = await handleImage(state, new Request("http://x/_nbo/image?url=%2Ftransparent.png&w=100&q=75"));
    expect(res2.headers.get("content-type")).toBe("image/png");
  });

  // Final-review finding I7: a CMYK source's own 4th channel is K
  // (black), not alpha — metadata().hasAlpha is false for CMYK
  // regardless, confirmed directly — so the old hardcoded
  // channels[3] read it as an alpha channel and wrongly produced PNG
  // for an entirely opaque image.
  it("treats a CMYK source as opaque, never picking png for its own K channel", async () => {
    const state = newTestImageServer(testImagesConfig());
    state.nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await mkdir(join(state.nboDir, "static"), { recursive: true });

    const width = 20,
      height = 20;
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = 50;
      rgb[i * 3 + 1] = 100;
      rgb[i * 3 + 2] = 200;
    }
    const cmykBuffer = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .toColourspace("cmyk")
      .jpeg()
      .toBuffer();
    // Named .png to match testImagesConfig's own localPatterns —
    // sharp auto-detects the real format from the file's own magic
    // bytes, not its extension, so this still decodes as the real
    // CMYK JPEG it is.
    await writeFile(join(state.nboDir, "static", "cmyk.png"), cmykBuffer);
    state.index.set("/cmyk.png", { file: "cmyk.png", contentType: "image/jpeg", cache: "" });

    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fcmyk.png&w=100&q=75"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("a local url with no static entry is 404", async () => {
    const state = newTestImageServer(testImagesConfig());
    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res.status).toBe(404);
  });

  it("a non-image body is a clean 502, not a crash", async () => {
    const state = newTestImageServer(testImagesConfig());
    state.nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await mkdir(join(state.nboDir, "static"), { recursive: true });
    await writeFile(join(state.nboDir, "static", "photo.png"), "not an image");
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });

    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res.status).toBe(502);
  });

  it("a second identical request serves from the cache byte-for-byte", async () => {
    const cacheStore = createStore();
    const resolveCache: Resolver = () => createFakeCacheService(cacheStore);
    const state = newTestImageServer(testImagesConfig(), resolveCache);
    state.nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await mkdir(join(state.nboDir, "static"), { recursive: true });
    await writeFile(join(state.nboDir, "static", "photo.png"), await testPNG(400, 300, false));
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });

    const res1 = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res1.status).toBe(200);
    const body1 = Buffer.from(await res1.arrayBuffer());

    // Remove the source file entirely — a second request can only
    // succeed by actually serving the cached result, not by
    // re-reading and re-processing the source.
    await writeFile(join(state.nboDir, "static", "photo.png"), "corrupted");

    const res2 = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res2.status).toBe(200);
    const body2 = Buffer.from(await res2.arrayBuffer());
    expect(body2.equals(body1)).toBe(true);
  });

  it("works correctly with no cache service configured", async () => {
    const state = newTestImageServer(testImagesConfig(), undefined);
    state.nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await mkdir(join(state.nboDir, "static"), { recursive: true });
    await writeFile(join(state.nboDir, "static", "photo.png"), await testPNG(400, 300, false));
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });

    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res.status).toBe(200);
  });

  // The schema doesn't require these three fields, and Next can leave
  // qualities unset, so a manifest without them must give a clean answer.
  it("an images block without widths or qualities refuses every w and q with 400", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await writeFile(join(nboDir, "manifest.json"), JSON.stringify({ images: { localPatterns: [{ pathname: "^/[a-z]+\\.png$" }] } }));
    const state = newTestImageServer((await loadImagesConfig(nboDir))!);
    const noWidths = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(noWidths.status).toBe(400);
    expect(await noWidths.text()).toMatch(/widths/);
    state.images = { ...state.images!, widths: [100] };
    const noQualities = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(noQualities.status).toBe(400);
    expect(await noQualities.text()).toMatch(/qualities/);
  });

  it("an images block without minimumCacheTTLSec stores the image for 0 seconds", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await writeFile(join(nboDir, "manifest.json"), JSON.stringify({ images: { widths: [100], qualities: [75], localPatterns: [{ pathname: "^/[a-z]+\\.png$" }] } }));
    const cfg = await loadImagesConfig(nboDir);
    const fake = createFakeCacheService(createStore());
    const puts: { revalidateSec?: number; expireSec?: number }[] = [];
    const resolveCache: Resolver = () => async (request: Request) => {
      if (request.method === "PUT") puts.push((await request.clone().json()) as { revalidateSec?: number; expireSec?: number });
      return fake(request);
    };
    const state = newTestImageServer(cfg!, resolveCache);
    state.nboDir = nboDir;
    await mkdir(join(nboDir, "static"), { recursive: true });
    await writeFile(join(nboDir, "static", "photo.png"), await testPNG(400, 300, false));
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });

    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res.status).toBe(200);
    // The write runs in the background, after the answer.
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.revalidateSec).toBe(0);
    expect(puts[0]!.expireSec).toBe(0);
  });

  it("a failing image write is ignored: the image still answers 200", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await writeFile(join(nboDir, "manifest.json"), JSON.stringify({ images: { widths: [100], qualities: [75], localPatterns: [{ pathname: "^/[a-z]+\.png$" }] } }));
    const cfg = await loadImagesConfig(nboDir);
    let putTried = false;
    const resolveCache: Resolver = () => async (request: Request) => {
      if (request.method === "PUT") {
        putTried = true;
        throw new Error("cache down");
      }
      return new Response(null, { status: 404 });
    };
    const state = newTestImageServer(cfg!, resolveCache);
    state.nboDir = nboDir;
    await mkdir(join(nboDir, "static"), { recursive: true });
    await writeFile(join(nboDir, "static", "photo.png"), await testPNG(400, 300, false));
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });

    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(putTried).toBe(true));
  });

  it("an image's cache key starts with the build's content id", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    await writeFile(join(nboDir, "manifest.json"), JSON.stringify({ images: { widths: [100], qualities: [75], localPatterns: [{ pathname: "^/[a-z]+\.png$" }] } }));
    const cfg = await loadImagesConfig(nboDir);
    const fake = createFakeCacheService(createStore());
    const keys: string[] = [];
    const resolveCache: Resolver = () => async (request: Request) => {
      keys.push(decodeURIComponent(new URL(request.url).pathname.replace(/^\/entries\//, "")));
      return fake(request);
    };
    const state = newTestImageServer(cfg!, resolveCache);
    state.nboDir = nboDir;
    state.deploymentId = "abc";
    await mkdir(join(nboDir, "static"), { recursive: true });
    await writeFile(join(nboDir, "static", "photo.png"), await testPNG(400, 300, false));
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });

    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(keys).toHaveLength(2));
    expect(keys).toEqual(["abc.img:/photo.png:100:75", "abc.img:/photo.png:100:75"]);
  });

  it("stores a resized image for the manifest's minimumCacheTTLSec", async () => {
    const nboDir = await mkdtemp(join(tmpdir(), "serve-image-"));
    // The manifest's own field name, written as the writer writes it.
    const images = {
      widths: [100, 200],
      formats: ["image/webp"],
      qualities: [75],
      localPatterns: [{ pathname: "^/[a-z]+\\.png$" }],
      minimumCacheTTLSec: 3600,
      allowSvg: false,
    };
    await writeFile(join(nboDir, "manifest.json"), JSON.stringify({ images }));
    const cfg = await loadImagesConfig(nboDir);
    expect(cfg).toBeDefined();

    const cacheStore = createStore();
    const fake = createFakeCacheService(cacheStore);
    const puts: { revalidateSec?: number; expireSec?: number }[] = [];
    const resolveCache: Resolver = () => async (request: Request) => {
      if (request.method === "PUT") puts.push((await request.clone().json()) as { revalidateSec?: number; expireSec?: number });
      return fake(request);
    };
    const state = newTestImageServer(cfg!, resolveCache);
    state.nboDir = nboDir;
    await mkdir(join(nboDir, "static"), { recursive: true });
    await writeFile(join(nboDir, "static", "photo.png"), await testPNG(400, 300, false));
    state.index.set("/photo.png", { file: "photo.png", contentType: "image/png", cache: "" });

    const res = await handleImage(state, new Request("http://x/_nbo/image?url=%2Fphoto.png&w=100&q=75"));
    expect(res.status).toBe(200);
    // The write runs in the background, after the answer.
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.revalidateSec).toBe(3600);
    expect(puts[0]!.expireSec).toBe(3600);
  });
});
