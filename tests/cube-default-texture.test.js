"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BplmFormat = require("../src/palette/bplm-format.js");

const root = path.resolve(__dirname, "..");
const defaultTextureName = "stone-texture-wic.bplm";
const cubeHtml = fs.readFileSync(path.join(root, "cube.html"), "utf8");
const samplerHtml = fs.readFileSync(path.join(root, "cube-bpal-sampler.html"), "utf8");
const cubeSource = fs.readFileSync(path.join(root, "src", "pages", "cube-page.js"), "utf8");
const samplerSource = fs.readFileSync(path.join(root, "src", "pages", "cube-bpal-sampler-page.js"), "utf8");

test("loads the manifest-selected BPAL texture on both cube pages", () => {
  for (const html of [cubeHtml, samplerHtml]) {
    assert.match(html, /<select id="bpal-example" disabled><\/select>/);
    assert.match(html, /src="\.\/src\/pages\/bpal-example-catalog\.js\?v=1"/);
  }

  for (const source of [cubeSource, samplerSource]) {
    assert.match(source, /await initializeBundledBpalTexture\(\)/);
    assert.match(source, /BpalExampleCatalog\.loadManifest\(\)/);
    assert.match(source, /BpalExampleCatalog\.populateSelect\(bpalExampleSelect, manifest\)/);
    assert.match(source, /bpalExampleSelect\.addEventListener\("change"/);
    assert.match(source, /loadBundledBpalTexture\(example\.url, example\.name\)/);
  }
});

test("uses shader-only BPAL sampling on the cube page", () => {
  assert.doesNotMatch(cubeHtml, /id="bpal-shader-texture"/);
  assert.match(cubeSource, /setBpalShaderTextureEnabled\(true\)/);
  assert.match(cubeSource, /discardColorTexture\(\)/);
  assert.doesNotMatch(cubeSource, /loadTexturePixels\(decoded\.pixels/);
});

test("switches Demo Cube between WebGL1 and compact WebGL2 rendering", () => {
  assert.match(cubeHtml, /<input id="webgl2-compact" type="checkbox" checked>/);
  assert.match(cubeHtml, /src="\.\/src\/core\/textured-cube-webgl2\.js\?v=multi-palette-1"/);
  assert.match(cubeSource, /get\("renderer"\) !== "webgl1"/);
  assert.match(cubeSource, /url\.searchParams\.set\("renderer", "webgl1"\)/);
  assert.match(cubeSource, /CompactTexturedCubeRenderer\.create\(gl\)/);
  assert.match(cubeSource, /createCompactShaderTextureData\(/);
});

test("creates one independently switchable texture resource per cube", () => {
  assert.match(cubeHtml, /<input id="per-cube-textures" type="checkbox" checked disabled>/);
  assert.match(cubeSource, /Array\.from\(\{ length: count - 1 \}/);
  assert.match(cubeSource, /setCubeTextureInstances\(\[primaryTextureResource, \.\.\.createdResources\]\)/);
  assert.match(cubeSource, /setCubeTextureInstances\(Array\.from\(/);
  assert.match(cubeSource, /cubeMotionState\.perCubeTextures = perCubeTexturesInput\.checked/);
});

test("decodes the default cube BPLM texture and its stored mip chain", () => {
  const bytes = fs.readFileSync(path.join(root, "assets", "bpal", defaultTextureName));
  const decoded = BplmFormat.decodeBplmFile(bytes);

  assert.equal(decoded.width, 1100);
  assert.equal(decoded.height, 734);
  assert.equal(decoded.blockSize, 16);
  assert.equal(decoded.localColorCount, 4);
  assert.equal(decoded.globalColorCount, 256);
  assert.equal(decoded.mipCount, 11);
  assert.deepEqual(decoded.mipLevels.slice(0, 5).map((level) => level.blockSize), [16, 8, 4, 2, 1]);
  assert.equal(decoded.mipLevels[3].direct, true);
});

test("does not recompress a JPEG for the default BPAL sampler texture", () => {
  const samplerHtml = fs.readFileSync(path.join(root, "cube-bpal-sampler.html"), "utf8");

  assert.doesNotMatch(samplerSource, /BlockPaletteCodec|compressImage|loadImagePixels/);
  assert.doesNotMatch(samplerHtml, /palette-quantizer\.js|block-palette-codec\.js/);
});

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
