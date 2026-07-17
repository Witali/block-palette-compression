#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import createASTCModule from "../vendor/astc-encoder-wasm/astcenc.mjs";
import StandardTextureCodecs from "../src/texture/standard-texture-codecs.js";

import BlockPaletteCodec from "../src/palette/block-palette-codec.js";
import BlockPaletteFormat from "../src/palette/block-palette-format.js";
import DctImageFormat from "../src/dct/dct-format.js";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const [, , jobPath, outputDirectory] = process.argv;

if (!jobPath || !outputDirectory) {
  throw new Error("Usage: node tools/encode-scene-textures.mjs jobs.json output-directory");
}

const jobs = JSON.parse(fs.readFileSync(jobPath, "utf8"));
const destination = path.resolve(outputDirectory);
fs.mkdirSync(destination, { recursive: true });

const wasmBinary = fs.readFileSync(path.join(ROOT, "vendor/astc-encoder-wasm/astcenc.wasm"));
const astcModule = await createASTCModule({ wasmBinary });
const textures = [];

for (const [index, job] of jobs.textures.entries()) {
  const pixels = new Uint8ClampedArray(fs.readFileSync(job.rgba));
  const expectedLength = job.width * job.height * 4;
  if (pixels.length !== expectedLength) {
    throw new RangeError(`${job.source}: expected ${expectedLength} RGBA bytes, received ${pixels.length}`);
  }

  process.stdout.write(`[${index + 1}/${jobs.textures.length}] ${job.source}: BPAL... `);
  const bpal = encodeBpal(pixels, job.width, job.height);
  const bpalPath = `${job.id}.bpal`;
  fs.writeFileSync(path.join(destination, bpalPath), bpal);

  process.stdout.write("DCTBS2... ");
  const dct = DctImageFormat.encodeDctFile(pixels, job.width, job.height, {
    preset: "3",
    quality: 88,
    coefficientCoding: "grouped-5-front",
    chromaSubsampling: "4:2:0",
    componentBudget: "fixed",
    splitLuma8x8: false,
  });
  const dctPath = `${job.id}.dctbs2`;
  fs.writeFileSync(path.join(destination, dctPath), dct);

  process.stdout.write("ASTC... ");
  const astcCompression = astcModule.compressImage(
    pixels,
    job.width,
    job.height,
    "6x6",
    "medium",
  );
  if (!astcCompression.success) {
    throw new Error(astcCompression.error || `ASTC encoding failed for ${job.source}`);
  }
  const astc = StandardTextureCodecs.createAstcFile(
    new Uint8Array(astcCompression.data),
    job.width,
    job.height,
    "6x6",
  );
  const astcPath = `${job.id}.astc`;
  fs.writeFileSync(path.join(destination, astcPath), astc);

  const variants = {
    bpal: { color: `textures/${bpalPath}`, bytes: bpal.byteLength },
    dct: { color: `textures/${dctPath}`, bytes: dct.byteLength },
    astc: { color: `textures/${astcPath}`, bytes: astc.byteLength },
  };

  if (job.hasAlpha) {
    const alphaPixels = createAlphaImage(pixels);
    const alphaBpal = encodeBpal(alphaPixels, job.width, job.height, {
      globalColorCount: 64,
      localColorCount: 4,
    });
    const alphaBpalPath = `${job.id}-alpha.bpal`;
    fs.writeFileSync(path.join(destination, alphaBpalPath), alphaBpal);
    variants.bpal.alpha = `textures/${alphaBpalPath}`;
    variants.bpal.bytes += alphaBpal.byteLength;

    const alphaDct = DctImageFormat.encodeDctFile(alphaPixels, job.width, job.height, {
      preset: "3",
      quality: 88,
      coefficientCoding: "grouped-5-front",
      chromaSubsampling: "4:2:0",
      componentBudget: "fixed",
      splitLuma8x8: false,
    });
    const alphaDctPath = `${job.id}-alpha.dctbs2`;
    fs.writeFileSync(path.join(destination, alphaDctPath), alphaDct);
    variants.dct.alpha = `textures/${alphaDctPath}`;
    variants.dct.bytes += alphaDct.byteLength;
  }

  textures.push({
    id: job.id,
    source: job.source,
    sourceWidth: job.sourceWidth,
    sourceHeight: job.sourceHeight,
    width: job.width,
    height: job.height,
    hasAlpha: job.hasAlpha,
    variants,
  });
  process.stdout.write("done\n");
}

const codecTotals = Object.fromEntries(["bpal", "dct", "astc"].map((codec) => [
  codec,
  textures.reduce((sum, texture) => sum + texture.variants[codec].bytes, 0),
]));
const manifest = {
  version: 1,
  scene: jobs.scene,
  source: jobs.source,
  textureCount: textures.length,
  maxDimension: jobs.maxDimension,
  codecs: {
    bpal: { label: "BPAL", settings: "8x8 blocks, 8 local / 256 global colors" },
    dct: { label: "DCTBS2", settings: "3 bpp, quality 88, 4:2:0" },
    astc: { label: "ASTC", settings: "6x6 blocks, medium quality" },
  },
  codecTotals,
  materials: jobs.materials,
  textures,
};

fs.writeFileSync(
  path.join(path.dirname(destination), "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(`Encoded ${textures.length} textures with ${astcModule.getVersion()}\n`);

function encodeBpal(pixels, width, height, overrides = {}) {
  const encoded = BlockPaletteCodec.compressImage(pixels, width, height, {
    blockSize: 8,
    localColorCount: 8,
    globalColorCount: 256,
    paletteCount: 1,
    paletteColorBits: 24,
    paletteMode: "explicit",
    colorSpace: "oklab",
    clusteringMethod: "k-means-uniform",
    dithering: "none",
    diversity: 0,
    refinementPasses: 1,
    ...overrides,
  });
  return BlockPaletteFormat.encodeBlockPaletteFile(encoded);
}

function createAlphaImage(pixels) {
  const alpha = new Uint8ClampedArray(pixels.length);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const value = pixels[offset + 3];
    alpha[offset] = value;
    alpha[offset + 1] = value;
    alpha[offset + 2] = value;
    alpha[offset + 3] = 255;
  }
  return alpha;
}
