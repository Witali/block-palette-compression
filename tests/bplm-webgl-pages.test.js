"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cubeHtml = read("cube.html");
const samplerHtml = read("cube-bpal-sampler.html");
const cubeSource = read("src/pages/cube-page.js");
const samplerSource = read("src/pages/cube-bpal-sampler-page.js");
const rendererSource = read("src/core/textured-cube.js");
const samplerShader = read("src/shaders/cube-bpal-sampler.frag.glsl");
const compactVertexShader = read("src/shaders/cube-webgl2.vert.glsl");
const compactFragmentShader = read("src/shaders/cube-webgl2.frag.glsl");
const compactRendererSource = read("src/core/textured-cube-webgl2.js");

test("accepts BPLM uploads on both WebGL pages", () => {
  for (const html of [cubeHtml, samplerHtml]) {
    assert.match(html, /accept="\.bpal,\.bplm,application\/octet-stream"/);
    assert.match(html, /id="bpal-example" disabled/);
    assert.match(html, /src="\.\/src\/palette\/bplm-format\.js\?v=multi-palette-1"/);
    assert.match(html, /src="\.\/src\/pages\/bpal-example-catalog\.js\?v=1"/);
  }

  for (const source of [cubeSource, samplerSource]) {
    assert.match(source, /BplmFormat\.isBplmFile\(bytes\)/);
    assert.match(source, /BplmFormat\.decodeBplmFile\(bytes\)/);
  }
});

test("passes per-level block settings and direct indices to the mip shader", () => {
  assert.match(rendererSource, /level\.blockSize,\s*level\.localColorCount,\s*level\.direct \? 1 : 0/);
  assert.match(samplerShader, /uniform vec4 uBpalMipBlockInfo0/);
  assert.match(samplerShader, /if \(blockInfo\.w > 0\.5\)/);
  assert.match(samplerShader, /fetchGlobalIndex\(info\.w \+ linearPixel\)/);
  assert.match(samplerShader, /blockIndex \* blockInfo\.z \+ localIndex/);
  assert.match(rendererSource, /level\.paletteSelectorOffset/);
  assert.match(samplerShader, /mipPaletteSelectorOffset\(mip\) \+ blockIndex/);
  assert.match(samplerShader, /paletteIndex \* uBpalGlobalColorCount/);
});

test("uses stored BPLM mip levels in the programmable sampler", () => {
  assert.match(
    samplerSource,
    /createMipmappedShaderTextureData\(\s*decoded,\s*gl\.getParameter\(gl\.MAX_TEXTURE_SIZE\)/
  );
  assert.match(samplerSource, /format: decoded\.containerMagic \|\| "BPAL"/);
});

test("binds each cube's own BPAL texture resource before drawing it", () => {
  assert.match(rendererSource, /createBpalTextureResource\(shaderData\)/);
  assert.match(rendererSource, /bindInstanceTextureResource\(instance\.textureResource\)/);
  assert.match(rendererSource, /deleteBpalTextureResource\(resource\)/);
});

test("keeps Demo Cube BPAL resources shader-only without decoded RGBA textures", () => {
  assert.match(rendererSource, /discardColorTexture\(\)/);
  assert.match(rendererSource, /this\.texture = this\.fallbackTexture/);
  assert.match(cubeSource, /createBpalTextureResource\(data\.shaderTextureData\)/);
  assert.doesNotMatch(cubeSource, /loadTexturePixels\(decoded\.pixels/);
});

test("keeps the programmable BPAL sampler shader-only without decoded RGBA textures", () => {
  assert.match(samplerSource, /renderer\.discardColorTexture\(\)/);
  assert.doesNotMatch(samplerSource, /renderer\.loadTexturePixels\(/);
  assert.match(samplerSource, /RGBA not uploaded/);
});

test("uses packed R32UI bitstreams in the optional WebGL2 renderer", () => {
  assert.match(compactRendererSource, /compactBpal: true/);
  assert.match(compactVertexShader, /#version 300 es/);
  assert.match(compactFragmentShader, /uniform highp usampler2D uBpalPixelIndices/);
  assert.match(compactFragmentShader, /fetchPackedValue\(/);
  assert.match(compactFragmentShader, /texelFetch\(/);
  assert.match(compactFragmentShader, /uBpalPaletteSelectors/);
  assert.match(compactFragmentShader, /uBpalPaletteIndexBits/);
  assert.match(rendererSource, /gl\.R32UI/);
  assert.match(rendererSource, /gl\.RED_INTEGER/);
});

function read(fileName) {
  return fs.readFileSync(path.join(root, fileName), "utf8");
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
