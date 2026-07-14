"use strict";

const assert = require("node:assert/strict");
const {
  BLOCK_SIZES,
  encodeAdaptiveBlockFile,
  openAdaptiveBlockFile,
} = require("../src/palette/adaptive-block-format.js");
const {
  MAX_WORD_READS,
  SAMPLER_GLSL,
  FRAGMENT_SHADER,
  createAdaptiveBlockGpuData,
  uploadAdaptiveBlockGpuTexture,
  bindAdaptiveBlockSamplerUniforms,
  sampleAdaptiveBlockGpuData,
} = require("../src/palette/adaptive-block-webgl2.js");

test("R32UI shader atlas matches random access for every adaptive pixel", () => {
  const candidates = BLOCK_SIZES.map((blockSize, mode) => createCandidate(blockSize, mode));
  const encoded = encodeAdaptiveBlockFile(
    candidates,
    Uint8Array.from([0, 1, 2, 3, 2, 0])
  );
  const accessor = openAdaptiveBlockFile(encoded.bytes);
  const gpu = createAdaptiveBlockGpuData(encoded.bytes, 128);
  let maximumReads = 0;

  assert.equal(gpu.format, "bpav-webgl2");
  assert.ok(gpu.wordAtlas.data instanceof Uint32Array);
  assert.equal(gpu.wordAtlas.data.byteLength, gpu.gpuBytes);
  assert.equal(gpu.maximumWordReadsPerPixel, MAX_WORD_READS);

  for (let y = 0; y < accessor.height; y += 1) {
    for (let x = 0; x < accessor.width; x += 1) {
      const expected = accessor.getPixel(x, y);
      const actual = sampleAdaptiveBlockGpuData(gpu, x, y);

      maximumReads = Math.max(maximumReads, actual.reads);
      assert.deepEqual(
        [actual.r, actual.g, actual.b, actual.a],
        [expected.r, expected.g, expected.b, expected.a],
        `R32UI pixel ${x},${y}`
      );
    }
  }
  assert.ok(maximumReads <= MAX_WORD_READS);
});

test("production GLSL sampler has bounded direct lookup without traversal", () => {
  assert.match(SAMPLER_GLSL, /uniform highp usampler2D uBpavWords/);
  assert.match(SAMPLER_GLSL, /texelFetch\(uBpavWords/);
  assert.match(SAMPLER_GLSL, /uint directory = bpavLoadWord/);
  assert.match(SAMPLER_GLSL, /uint mode = directory >> 30u/);
  assert.match(SAMPLER_GLSL, /uint blockOffset = directory & 0x3fffffffu/);
  assert.match(SAMPLER_GLSL, /uvec4 bpavSample\(ivec2 coordinate\)/);
  assert.doesNotMatch(SAMPLER_GLSL, /\b(?:for|while)\s*\(/);
  assert.match(FRAGMENT_SHADER, /^#version 300 es/);
  assert.match(FRAGMENT_SHADER, /vec4\(bpavSample\(coordinate\)\) \/ 255\.0/);
});

test("uploads one R32UI atlas and binds all BPAV shader uniforms", () => {
  const candidates = BLOCK_SIZES.map((blockSize, mode) => createCandidate(blockSize, mode));
  const encoded = encodeAdaptiveBlockFile(
    candidates,
    Uint8Array.from([0, 1, 2, 3, 2, 0])
  );
  const data = createAdaptiveBlockGpuData(encoded.bytes, 128);
  const gl = createMockWebGL2();
  const uploaded = uploadAdaptiveBlockGpuTexture(gl, data, 3);
  const locations = bindAdaptiveBlockSamplerUniforms(gl, { id: 7 }, data, 3);
  const imageCall = gl.calls.find((call) => call.name === "texImage2D");

  assert.equal(uploaded.textureUnit, 3);
  assert.equal(imageCall.args[2], gl.R32UI);
  assert.equal(imageCall.args[6], gl.RED_INTEGER);
  assert.equal(imageCall.args[7], gl.UNSIGNED_INT);
  assert.equal(imageCall.args[8], data.wordAtlas.data);
  assert.equal(locations.uBpavWords, "uBpavWords");
  assert.ok(gl.calls.some((call) =>
    call.name === "uniform1i" && call.args[0] === "uBpavWords" && call.args[1] === 3
  ));
  assert.ok(gl.calls.some((call) =>
    call.name === "uniform4uiv" && call.args[0] === "uBpavPaletteStartBytes"
  ));
});

test("RGB565 shader sampling matches scalar coordinate decoding", () => {
  const candidates = BLOCK_SIZES.map((blockSize, mode) =>
    createCandidate(blockSize, mode, { width: 63, height: 61, paletteColorBits: 16 })
  );
  const encoded = encodeAdaptiveBlockFile(candidates, Uint8Array.of(2));
  const accessor = openAdaptiveBlockFile(encoded.bytes);
  const gpu = createAdaptiveBlockGpuData(encoded.bytes, 64);

  for (const [x, y] of [[0, 0], [62, 0], [0, 60], [62, 60], [31, 29]]) {
    const expected = accessor.getPixel(x, y);
    const actual = sampleAdaptiveBlockGpuData(gpu, x, y);

    assert.deepEqual(
      [actual.r, actual.g, actual.b, actual.a],
      [expected.r, expected.g, expected.b, expected.a]
    );
  }
});

test("rejects atlases that exceed the device texture limit or lack WebGL2", () => {
  const candidates = BLOCK_SIZES.map((blockSize, mode) => createCandidate(blockSize, mode));
  const encoded = encodeAdaptiveBlockFile(
    candidates,
    Uint8Array.from([0, 1, 2, 3, 2, 0])
  );

  assert.throws(() => createAdaptiveBlockGpuData(encoded.bytes, 1), /texture size limit/);
  const data = createAdaptiveBlockGpuData(encoded.bytes, 128);
  assert.throws(() => uploadAdaptiveBlockGpuTexture({}, data, 0), /requires WebGL2/);
});

function createCandidate(blockSize, mode, options) {
  const settings = options || {};
  const width = settings.width || 130;
  const height = settings.height || 70;
  const localColorCount = 4;
  const globalColorCount = 8;
  const paletteCount = 2;
  const blocksX = Math.ceil(width / blockSize);
  const blocksY = Math.ceil(height / blockSize);
  const blockCount = blocksX * blocksY;
  const palette = Array.from({ length: paletteCount * globalColorCount }, (_, index) => ({
    r: (index * 31 + mode * 13) & 255,
    g: (index * 17 + mode * 29) & 255,
    b: (index * 47 + mode * 7) & 255,
  }));
  const blockPaletteSelectors = new Uint8Array(blockCount);
  const blockPaletteIndices = new Uint16Array(blockCount * localColorCount);
  const pixelIndices = new Uint8Array(width * height);

  for (let block = 0; block < blockCount; block += 1) {
    blockPaletteSelectors[block] = (block + mode) % paletteCount;
    for (let local = 0; local < localColorCount; local += 1) {
      blockPaletteIndices[block * localColorCount + local] =
        (block * 3 + local * 2 + mode) % globalColorCount;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixelIndices[y * width + x] = (x + y * 3 + mode) % localColorCount;
    }
  }

  return {
    width,
    height,
    blockSize,
    localColorCount,
    globalColorCount,
    paletteCount,
    paletteColorBits: settings.paletteColorBits || 24,
    palette,
    blockPaletteSelectors,
    blockPaletteIndices,
    pixelIndices,
  };
}

function createMockWebGL2() {
  const calls = [];
  const gl = {
    calls,
    TEXTURE0: 1000,
    TEXTURE_2D: 3553,
    R32UI: 33334,
    RED_INTEGER: 36244,
    UNSIGNED_INT: 5125,
    UNPACK_ALIGNMENT: 3317,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    CLAMP_TO_EDGE: 33071,
    NEAREST: 9728,
    createTexture() {
      return { id: 1 };
    },
    getUniformLocation(program, name) {
      calls.push({ name: "getUniformLocation", args: [program, name] });
      return name;
    },
  };
  for (const name of [
    "activeTexture",
    "bindTexture",
    "pixelStorei",
    "texImage2D",
    "texParameteri",
    "uniform1i",
    "uniform2i",
    "uniform1ui",
    "uniform2ui",
    "uniform4uiv",
  ]) {
    gl[name] = (...args) => calls.push({ name, args });
  }
  return gl;
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
