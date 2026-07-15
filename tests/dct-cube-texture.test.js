"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const DctImageFormat = require("../src/dct/dct-format.js");
const Dctbs2TextureDecoder = require("../src/decoders/dctbs2-texture.js");
const { buildScan } = require("../tools/generate-dctbs2-shaders.js");

const root = path.resolve(__dirname, "..");
const texturePath = path.join(
  root,
  "assets",
  "dct",
  "stone-texture-wic-1.5bpp.dctbs2"
);
const bytes = fs.readFileSync(texturePath);
const cubeHtml = read("cube.html");
const cubeSource = read("src/pages/cube-page.js");
const rendererSource = read("src/core/textured-cube.js");
const shaderSource = read("src/shaders/cube-webgl2.frag.glsl");

test("ships a directly addressable DCTBS2 stone texture", () => {
  const info = DctImageFormat.inspectDctFile(bytes);
  const center = DctImageFormat.sampleDctFilePixel(
    bytes,
    Math.floor(info.width / 2),
    Math.floor(info.height / 2)
  );

  assert.equal(info.version, 2);
  assert.equal(info.key, "1.5");
  assert.equal(info.width, 1100);
  assert.equal(info.height, 734);
  assert.equal(info.bytesPerMcu, 48);
  assert.equal(info.coefficientCodingKey, "grouped-5-front");
  assert.equal(info.libraryEnabled, false);
  assert.equal(info.splitLuma8x8, false);
  assert.ok(info.quality >= 1 && info.quality <= 100);
  assert.ok([center.r, center.g, center.b].every((channel) => channel >= 0 && channel <= 255));
});

test("packs the complete DCTBS2 file into an RGBA8UI atlas", () => {
  const shaderData = Dctbs2TextureDecoder.createShaderTextureData(bytes, 4096);

  assert.equal(shaderData.format, "dctbs2-rgba8ui");
  assert.equal(shaderData.width, 1100);
  assert.equal(shaderData.height, 734);
  assert.equal(shaderData.sourceBytes, bytes.length);
  assert.equal(shaderData.dataAtlas.width, 196);
  assert.equal(shaderData.dataAtlas.height, 195);
  assert.equal(shaderData.gpuBytes, 196 * 195 * 4);
  assert.deepEqual(
    shaderData.dataAtlas.data.subarray(0, bytes.length),
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  );
  assert.ok(shaderData.dataAtlas.data.subarray(bytes.length).every((value) => value === 0));
});

test("switches Demo Cube to fragment-shader DCTBS2 sampling", () => {
  assert.match(cubeHtml, /<select id="texture-format">/);
  assert.match(cubeHtml, /<option value="dct"[^>]*>DCTBS2 · 1\.5 bpp<\/option>/);
  assert.match(cubeHtml, /src="\.\/src\/decoders\/dctbs2-texture\.js\?v=dct-cube-2"/);
  assert.match(cubeSource, /loadBundledDctTexture\(\)/);
  assert.match(cubeSource, /createShaderTextureData\(/);
  assert.match(cubeSource, /loadDctShaderTexture\(shaderTextureData\)/);
  assert.match(cubeSource, /setDctShaderTextureEnabled\(true\)/);
  assert.match(rendererSource, /gl\.RGBA8UI/);
  assert.match(rendererSource, /gl\.RGBA_INTEGER/);
  assert.match(rendererSource, /gl\.activeTexture\(gl\.TEXTURE7\)/);
  assert.match(shaderSource, /uniform highp usampler2D uDctData/);
  assert.match(shaderSource, /sampleDctRecord\(/);
  assert.match(shaderSource, /fetchDctColor\(/);
  assert.match(shaderSource, /uUseDctTexture > 0\.5/);
});

test("keeps the cube shader significance scans synchronized with DCTBS2", () => {
  const yScan = parseShaderArray("DCT_SCAN_Y");
  const chromaScan = parseShaderArray("DCT_SCAN_C");
  const expectedY = Array.from(
    { length: 4 },
    (_, profile) => buildScan(profile, 16, 16).slice(0, 33)
  ).flat();
  const expectedChroma = Array.from(
    { length: 4 },
    (_, profile) => buildScan(profile, 8, 16).slice(0, 13)
  ).flat();

  assert.deepEqual(yScan, expectedY);
  assert.deepEqual(chromaScan, expectedChroma);
});

function parseShaderArray(name) {
  const match = shaderSource.match(new RegExp(
    `const int ${name}\\[\\d+\\] = int\\[\\d+\\]\\(([\\s\\S]*?)\\);`
  ));

  assert.ok(match, `Missing shader array ${name}`);
  return Array.from(match[1].matchAll(/\d+/g), (value) => Number(value[0]));
}

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
