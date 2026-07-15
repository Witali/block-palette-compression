"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BplmFormat = require("../src/palette/bplm-format.js");
const BpdhFormat = require("../src/hybrid/bpdh-format.js");
const BpdhTextureDecoder = require("../src/decoders/bpdh-texture.js");

const root = path.resolve(__dirname, "..");
const defaultTextureName = "stone-texture-wic.bplm";
const cubeHtml = fs.readFileSync(path.join(root, "cube.html"), "utf8");
const samplerHtml = fs.readFileSync(path.join(root, "cube-bpal-sampler.html"), "utf8");
const cubeSource = fs.readFileSync(path.join(root, "src", "pages", "cube-page.js"), "utf8");
const samplerSource = fs.readFileSync(path.join(root, "src", "pages", "cube-bpal-sampler-page.js"), "utf8");
const cubeFragmentShader = fs.readFileSync(path.join(root, "src", "shaders", "cube.frag.glsl"), "utf8");
const compactVertexShader = fs.readFileSync(
  path.join(root, "src", "shaders", "cube-webgl2.vert.glsl"),
  "utf8"
);
const compactFragmentShader = fs.readFileSync(
  path.join(root, "src", "shaders", "cube-webgl2-dctbs2-1_5bpp.frag.glsl"),
  "utf8"
);

test("loads the manifest-selected BPAL texture on the sampler page", () => {
  assert.match(samplerHtml, /<select id="bpal-example" disabled><\/select>/);
  assert.match(samplerHtml, /src="\.\/src\/pages\/bpal-example-catalog\.js\?v=1"/);
  assert.match(samplerSource, /await initializeBundledBpalTexture\(\)/);
  assert.match(samplerSource, /BpalExampleCatalog\.loadManifest\(\)/);
  assert.match(samplerSource, /BpalExampleCatalog\.populateSelect\(bpalExampleSelect, manifest\)/);
  assert.match(samplerSource, /bpalExampleSelect\.addEventListener\("change"/);
  assert.match(samplerSource, /loadBundledBpalTexture\(example\.url, example\.name\)/);
});

test("switches Demo Cube between BPAL, DCTBS2, and BPDH textures", () => {
  assert.ok(cubeHtml.indexOf('id="texture-format"') < cubeHtml.indexOf('id="bpal-example"'));
  assert.match(cubeHtml, /<option value="bpal"[^>]*>BPAL \/ BPLM<\/option>/);
  assert.match(cubeHtml, /<option value="dct"[^>]*>DCTBS2 · 1\.5 bpp<\/option>/);
  assert.match(cubeHtml, /<option value="bpdh"[^>]*>BPDH<\/option>/);
  assert.match(cubeHtml, /accept="\.bpal,\.bplm,\.bpdh,application\/octet-stream"/);
  assert.match(cubeHtml, /src="\.\/src\/pages\/bpal-example-catalog\.js\?v=image-viewer-1"/);
  assert.match(cubeSource, /BpalExampleCatalog\.loadManifestForType\(type\)/);
  assert.match(cubeSource, /BpalExampleCatalog\.populateSelectForType\(/);
  assert.match(cubeSource, /textureFormatSelect\.addEventListener\("change"/);
  assert.match(cubeSource, /textureFormatSelect\.value === "bpdh" \? "bpdh" : "bpal"/);
  assert.match(cubeSource, /loadBundledBpalTexture\(example\.url, example\.name\)/);
});

test("uses shader-only BPAL sampling on the cube page", () => {
  assert.doesNotMatch(cubeHtml, /id="bpal-shader-texture"/);
  assert.match(cubeSource, /setBpalShaderTextureEnabled\(true\)/);
  assert.match(cubeSource, /discardColorTexture\(\)/);
  assert.doesNotMatch(cubeSource, /loadTexturePixels\(decoded\.pixels/);
});

test("uses coordinate-based BPDH shader sampling without an RGBA upload", () => {
  assert.match(cubeHtml, /src="\.\/src\/decoders\/bpdh-texture\.js\?v=bpdh-cube-1"/);
  assert.match(cubeSource, /BpdhFormat\.parseBpdhFile\(bytes\)/);
  assert.match(cubeSource, /BpdhTextureDecoder\.createShaderTextureData\(/);
  assert.match(cubeSource, /loadBpdhShaderTexture\(textureData\.bpdhShaderTextureData\)/);
  assert.doesNotMatch(cubeSource, /loadTexturePixels\(/);

  for (const shader of [cubeFragmentShader, compactFragmentShader]) {
    assert.match(shader, /uniform float uUseBpdhTexture/);
    assert.match(shader, /vec3 fetchBpdhColor\(/);
    assert.match(shader, /vec3 sampleBpdhTexture\(/);
    assert.match(shader, /sampleBpdhChroma\(/);
  }
});

test("keeps cached BPDH shader samples deterministic for both block modes", () => {
  const bytes = fs.readFileSync(path.join(root, "assets", "bpdh", "landscape-alaska.bpdh"));
  const parsed = BpdhFormat.parseBpdhFile(bytes);
  const texture = BpdhTextureDecoder.createShaderTextureData(parsed, 4096);

  assert.equal(parsed.pixels, null);
  assert.ok(texture.gpuBytes < parsed.width * parsed.height * 4);

  for (const mode of [BpdhFormat.MODE_BPAL, BpdhFormat.MODE_DCT]) {
    const blockIndex = parsed.modes.indexOf(mode);
    const x = Math.min(parsed.width - 1, blockIndex % parsed.blocksX * 16 + 7);
    const y = Math.min(parsed.height - 1, Math.floor(blockIndex / parsed.blocksX) * 16 + 7);

    assert.ok(blockIndex >= 0);
    assert.deepEqual(
      BpdhTextureDecoder.sampleShaderTexturePixel(texture, x, y),
      BpdhFormat.sampleBpdhPixel(parsed, x, y),
    );
  }

  for (let yStep = 0; yStep <= 4; yStep += 1) {
    for (let xStep = 0; xStep <= 4; xStep += 1) {
      const x = Math.floor((parsed.width - 1) * xStep / 4);
      const y = Math.floor((parsed.height - 1) * yStep / 4);

      assert.deepEqual(
        BpdhTextureDecoder.sampleShaderTexturePixel(texture, x, y),
        BpdhFormat.sampleBpdhPixel(parsed, x, y),
      );
    }
  }
});

test("switches Demo Cube between WebGL1 and compact WebGL2 rendering", () => {
  assert.match(cubeHtml, /<input id="webgl2-compact" type="checkbox" checked>/);
  assert.match(cubeHtml, /src="\.\/src\/core\/textured-cube-webgl2\.js\?v=cube-flat-1"/);
  assert.match(cubeSource, /get\("renderer"\) !== "webgl1"/);
  assert.match(cubeSource, /url\.searchParams\.set\("renderer", "webgl1"\)/);
  assert.match(cubeSource, /CompactTexturedCubeRenderer\.create\(gl, rendererOptions\)/);
  assert.match(cubeSource, /createCompactShaderTextureData\(/);
});

test("removes height-map relief from Demo Cube", () => {
  assert.doesNotMatch(cubeHtml, /height-strength|cube\.relief|relief-control/);
  assert.doesNotMatch(cubeSource, /heightStrength|setHeightStrength/);
  assert.match(cubeSource, /relief: false, tessellationSegments: 1/);
  assert.match(cubeSource, /materialMaps: false/);

  for (const shader of [cubeFragmentShader, compactFragmentShader]) {
    assert.doesNotMatch(shader, /uHeightTexture|uHeightStrength|uHeightTexelSize/);
    assert.doesNotMatch(shader, /applyHeightNormal|reliefTexCoord/);
  }

  assert.doesNotMatch(compactVertexShader, /aTangent|aBitangent|vTangent|vBitangent/);
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
