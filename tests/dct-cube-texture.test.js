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
const shaderSource = read("src/shaders/cube-webgl2-dctbs2-1_5bpp.frag.glsl");
const compactRendererSource = read("src/core/textured-cube-webgl2.js");

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

test("keeps the packed DCTBS2 stream for low-memory shader decoding", () => {
  const shaderData = Dctbs2TextureDecoder.createShaderTextureData(bytes, 4096);

  assert.equal(shaderData.format, "dctbs2-rgba8ui");
  assert.equal(shaderData.decodeMode, "low-memory");
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

test("builds the minimal cached 4:2:2 component layout for fast sampling", () => {
  const info = DctImageFormat.inspectDctFile(bytes);
  const shaderData = Dctbs2TextureDecoder.createShaderTextureData(bytes, 4096, {
    decodeMode: "fast",
  });
  const logicalCacheBytes = info.mcuCount * 512;

  assert.equal(shaderData.format, "dctbs2-component-cache-rgba8ui");
  assert.equal(shaderData.decodeMode, "fast");
  assert.equal(shaderData.componentBytesPerMcu, 512);
  assert.equal(shaderData.componentYOffset, 0);
  assert.equal(shaderData.componentCbOffset, 256);
  assert.equal(shaderData.componentCrOffset, 384);
  assert.equal(shaderData.sourceBytes, bytes.length);
  assert.equal(shaderData.dataAtlas.width, 640);
  assert.equal(shaderData.dataAtlas.height, 635);
  assert.equal(shaderData.dataAtlas.mcusPerRow, 5);
  assert.equal(shaderData.dataAtlas.recordTexels, 128);
  assert.equal(shaderData.gpuBytes, 640 * 635 * 4);
  assert.equal(logicalCacheBytes, 3174 * 512);
  assert.ok(shaderData.dataAtlas.data.subarray(logicalCacheBytes).every((value) => value === 0));

  const directPixels = DctImageFormat.decodeDctFile(bytes).pixels;
  let maximumDelta = 0;
  let squaredError = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const cached = Dctbs2TextureDecoder.sampleShaderTexturePixel(shaderData, x, y);
      const offset = (y * info.width + x) * 4;

      [["r", 0], ["g", 1], ["b", 2]].forEach(([channel, channelOffset]) => {
        const delta = cached[channel] - directPixels[offset + channelOffset];
        maximumDelta = Math.max(maximumDelta, Math.abs(delta));
        squaredError += delta * delta;
      });
    }
  }

  const meanSquaredError = squaredError / (info.width * info.height * 3);
  const cachePsnr = 10 * Math.log10(255 * 255 / meanSquaredError);

  assert.ok(cachePsnr > 50, `component rounding PSNR must exceed 50 dB, got ${cachePsnr}`);
  assert.ok(maximumDelta <= 16, `component rounding delta must be bounded, got ${maximumDelta}`);

  for (let yStep = 0; yStep <= 4; yStep += 1) {
    for (let xStep = 0; xStep <= 4; xStep += 1) {
      const x = Math.floor((info.width - 1) * xStep / 4);
      const y = Math.floor((info.height - 1) * yStep / 4);
      const cached = Dctbs2TextureDecoder.sampleShaderTexturePixel(shaderData, x, y);

      assert.deepEqual(
        Dctbs2TextureDecoder.sampleShaderTexturePixel(shaderData, x, y),
        cached,
        `cached pixel ${x},${y} must be deterministic`
      );
      assert.ok([cached.r, cached.g, cached.b].every((channel) => channel >= 0 && channel <= 255));
    }
  }
});

test("builds the 384-byte 4:2:0 component cache used by new files", () => {
  const source = makePixels(32, 32);
  const encoded = DctImageFormat.encodeDctFile(source, 32, 32, {
    preset: "1.5",
    quality: 82,
    coefficientCoding: "grouped-5-front",
  });
  const shaderData = Dctbs2TextureDecoder.createShaderTextureData(encoded, 4096, {
    decodeMode: "fast",
  });

  assert.equal(shaderData.chroma420, true);
  assert.equal(shaderData.chromaHeight, 8);
  assert.equal(shaderData.componentBytesPerMcu, 384);
  assert.equal(shaderData.componentCbOffset, 256);
  assert.equal(shaderData.componentCrOffset, 320);
  assert.equal(shaderData.dataAtlas.recordTexels, 96);
  for (const [x, y] of [[0, 0], [1, 1], [15, 15], [31, 31]]) {
    const pixel = Dctbs2TextureDecoder.sampleShaderTexturePixel(shaderData, x, y);
    assert.ok([pixel.r, pixel.g, pixel.b].every((channel) => channel >= 0 && channel <= 255));
  }
});

test("switches Demo Cube between fast and low-memory DCTBS2 sampling", () => {
  assert.match(cubeHtml, /<select id="texture-format">/);
  assert.match(cubeHtml, /<option value="dct"[^>]*>DCTBS2 · 1\.5 bpp<\/option>/);
  assert.match(cubeHtml, /<select id="dct-decode-mode" disabled>/);
  assert.match(cubeHtml, /<option value="fast" selected/);
  assert.match(cubeHtml, /<option value="low-memory"/);
  assert.match(cubeHtml, /src="\.\/src\/decoders\/dctbs2-texture\.js\?v=dct-cache-1"/);
  assert.match(cubeSource, /loadBundledDctTexture\(\)/);
  assert.match(cubeSource, /createShaderTextureData\([\s\S]*\{ decodeMode \}/);
  assert.match(cubeSource, /loadDctShaderTexture\(shaderTextureData\)/);
  assert.match(cubeSource, /setDctShaderTextureEnabled\(true\)/);
  assert.match(rendererSource, /gl\.RGBA8UI/);
  assert.match(rendererSource, /gl\.RGBA_INTEGER/);
  assert.match(rendererSource, /gl\.activeTexture\(gl\.TEXTURE7\)/);
  assert.match(shaderSource, /uniform highp usampler2D uDctData/);
  assert.match(shaderSource, /uniform highp int uDctDecodeMode/);
  assert.match(shaderSource, /sampleDctLumaRecord\(/);
  assert.match(shaderSource, /sampleDctChroma420Record\(/);
  assert.match(shaderSource, /sampleDctChroma422Record\(/);
  assert.match(shaderSource, /fetchCachedDctColor\(/);
  assert.match(shaderSource, /uDctCacheRecordTexels/);
  assert.match(shaderSource, /uDctChroma420/);
  assert.match(shaderSource, /fetchDctColor\(/);
  assert.match(shaderSource, /uUseDctTexture > 0\.5/);
  assert.match(compactRendererSource, /cube-webgl2-dctbs2-1_5bpp\.frag\.glsl/);
});

test("uses an unrolled 1.5 bpp decoder with rolling 32-bit words", () => {
  const decoder = shaderSource.match(
    /\/\/ <dctbs2-profile-decoder>([\s\S]*?)\/\/ <\/dctbs2-profile-decoder>/
  );

  assert.ok(decoder, "missing generated profile decoder");
  assert.match(shaderSource, /uint dctWordAt\(/);
  assert.match(shaderSource, /uint mask = \(1u << uint\(bitCount\)\) - 1u/);
  assert.doesNotMatch(shaderSource, /for \(int bit = 0; bit < 16/);
  assert.doesNotMatch(decoder[1], /for \(/);
  assert.doesNotMatch(decoder[1], /profile < 0|dcScaleIndex < 0|libraryVersion|splitLuma/);
  assert.match(decoder[1], /uint currentWord = headerWord/);
  assert.match(decoder[1], /currentWord = nextWord/);
  assert.equal((decoder[1].match(/int position = DCT_SCAN_Y/g) || []).length, 33);
  assert.equal((decoder[1].match(/int position = DCT_SCAN_C/g) || []).length, 26);
});

test("keeps the cube shader significance scans synchronized with DCTBS2", () => {
  const yScan = parseShaderArray("DCT_SCAN_Y");
  const chroma422Scan = parseShaderArray("DCT_SCAN_C422");
  const chroma420Scan = parseShaderArray("DCT_SCAN_C420");
  const expectedY = Array.from(
    { length: 4 },
    (_, profile) => buildScan(profile, 16, 16).slice(0, 33)
  ).flat();
  const expectedChroma422 = Array.from(
    { length: 4 },
    (_, profile) => buildScan(profile, 8, 16).slice(0, 13)
  ).flat();
  const expectedChroma420 = Array.from(
    { length: 4 },
    (_, profile) => buildScan(profile, 8, 8).slice(0, 13)
  ).flat();

  assert.deepEqual(yScan, expectedY);
  assert.deepEqual(chroma422Scan, expectedChroma422);
  assert.deepEqual(chroma420Scan, expectedChroma420);
});

function makePixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = (x * 17 + y * 3) & 255;
      pixels[offset + 1] = (x * 5 + y * 19) & 255;
      pixels[offset + 2] = (x * 11 + y * 13) & 255;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

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
