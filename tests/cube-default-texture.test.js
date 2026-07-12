"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BlockPaletteFormat = require("../src/palette/block-palette-format.js");

const root = path.resolve(__dirname, "..");
const defaultTextureName = "stone-texture-wic-2.38bpp.bpal";
const defaultTextureUrl = `assets/bpal/${defaultTextureName}`;
const cubeHtml = fs.readFileSync(path.join(root, "cube.html"), "utf8");
const cubeSource = fs.readFileSync(path.join(root, "src", "pages", "cube-page.js"), "utf8");
const samplerSource = fs.readFileSync(path.join(root, "src", "pages", "cube-bpal-sampler-page.js"), "utf8");

test("uses the bundled WIC BPAL texture on both cube pages", () => {
  assert.match(cubeSource, new RegExp(escapeRegExp(defaultTextureUrl)));
  assert.match(samplerSource, new RegExp(escapeRegExp(defaultTextureUrl)));
  assert.match(cubeSource, /await loadDefaultBpalTexture\(\)/);
  assert.match(samplerSource, /await loadDefaultBpalTexture\(\)/);
});

test("enables shader BPAL sampling by default on the cube page", () => {
  assert.match(cubeHtml, /<input id="bpal-shader-texture" type="checkbox" checked disabled>/);
  assert.match(cubeSource, /setBpalShaderTextureEnabled\(bpalShaderTextureInput\.checked\)/);
});

test("decodes the default cube BPAL texture", () => {
  const bytes = fs.readFileSync(path.join(root, "assets", "bpal", defaultTextureName));
  const decoded = BlockPaletteFormat.decodeBlockPaletteFile(bytes);

  assert.equal(decoded.width, 1100);
  assert.equal(decoded.height, 734);
  assert.equal(decoded.blockSize, 8);
  assert.equal(decoded.localColorCount, 4);
  assert.equal(decoded.globalColorCount, 64);
});

test("does not recompress a JPEG for the default BPAL sampler texture", () => {
  const samplerHtml = fs.readFileSync(path.join(root, "cube-bpal-sampler.html"), "utf8");

  assert.doesNotMatch(samplerSource, /BlockPaletteCodec|compressImage|loadImagePixels/);
  assert.doesNotMatch(samplerHtml, /palette-quantizer\.js|block-palette-codec\.js/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
