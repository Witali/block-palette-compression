"use strict";

const assert = require("node:assert/strict");
const { VERSION, encodeBlockPaletteFile } = require("../src/palette/block-palette-format.js");
const {
  decode,
  createMipLevels,
  createShaderTextureData,
  createCompactShaderTextureData,
  createMipmappedShaderTextureData,
} = require("../src/decoders/bpal-texture.js");

test("decodes a BPAL file into uploadable RGBA texture pixels", () => {
  const bytes = encodeBlockPaletteFile({
    width: 2,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 2,
    paletteColorBits: 24,
    paletteMode: "explicit",
    palette: [
      { r: 12, g: 34, b: 56 },
      { r: 210, g: 180, b: 90 },
    ],
    blockPaletteIndices: new Uint16Array([0, 1]),
    pixelIndices: new Uint8Array([0, 1, 1, 0]),
  });
  const texture = decode(bytes);

  assert.equal(texture.width, 2);
  assert.equal(texture.height, 2);
  assert.equal(texture.version, VERSION);
  assert.equal(texture.localColorCount, 2);
  assert.equal(texture.globalColorCount, 2);
  assert.equal(texture.paletteMode, "explicit");
  assert.ok(texture.pixels instanceof Uint8ClampedArray);
  assert.deepEqual(Array.from(texture.pixels), [
    12, 34, 56, 255,
    210, 180, 90, 255,
    210, 180, 90, 255,
    12, 34, 56, 255,
  ]);
});

test("rejects a non-BPAL texture file", () => {
  assert.throws(
    () => decode(new Uint8Array([0, 1, 2, 3, 4, 5])),
    /Invalid BPAL magic/
  );
});

test("packs BPAL double indices into WebGL shader atlases", () => {
  const bytes = encodeBlockPaletteFile({
    width: 2,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 2,
    paletteColorBits: 24,
    paletteMode: "explicit",
    palette: [
      { r: 12, g: 34, b: 56 },
      { r: 210, g: 180, b: 90 },
    ],
    blockPaletteIndices: new Uint16Array([0, 1]),
    pixelIndices: new Uint8Array([0, 1, 1, 0]),
  });
  const shaderTexture = createShaderTextureData(decode(bytes), 4);

  assert.deepEqual(
    [shaderTexture.pixelAtlas.width, shaderTexture.pixelAtlas.height],
    [4, 1]
  );
  assert.deepEqual(Array.from(shaderTexture.pixelAtlas.data), [0, 1, 1, 0]);
  assert.deepEqual(
    Array.from(shaderTexture.blockPaletteAtlas.data.slice(0, 8)),
    [0, 0, 0, 255, 1, 0, 0, 255]
  );
  assert.deepEqual(
    Array.from(shaderTexture.paletteAtlas.data.slice(0, 8)),
    [12, 34, 56, 255, 210, 180, 90, 255]
  );
});

test("bit-packs BPAL indices and palette colors for WebGL2 integer textures", () => {
  const texture = decode(encodeBlockPaletteFile({
    width: 2,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 2,
    paletteColorBits: 24,
    paletteMode: "explicit",
    palette: [
      { r: 12, g: 34, b: 56 },
      { r: 210, g: 180, b: 90 },
    ],
    blockPaletteIndices: new Uint16Array([0, 1]),
    pixelIndices: new Uint8Array([0, 1, 1, 0]),
  }));
  const compact = createCompactShaderTextureData(texture, 4);

  assert.equal(compact.compact, true);
  assert.equal(compact.localIndexBits, 1);
  assert.equal(compact.globalIndexBits, 1);
  assert.equal(compact.paletteColorBits, 24);
  assert.ok(compact.pixelAtlas.data instanceof Uint32Array);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => readPackedValue(
      compact.pixelAtlas.data,
      index,
      compact.localIndexBits
    )),
    [0, 1, 1, 0]
  );
  assert.deepEqual(
    Array.from({ length: 2 }, (_, index) => readPackedValue(
      compact.blockPaletteAtlas.data,
      index,
      compact.globalIndexBits
    )),
    [0, 1]
  );
  assert.equal(
    readPackedValue(compact.paletteAtlas.data, 0, 24),
    12 | 34 << 8 | 56 << 16
  );
  assert.equal(
    compact.gpuBytes,
    compact.pixelAtlas.data.byteLength +
      compact.paletteSelectorAtlas.data.byteLength +
      compact.blockPaletteAtlas.data.byteLength +
      compact.paletteAtlas.data.byteLength
  );
});

test("keeps multi-palette selectors compact and separate from color indices", () => {
  const texture = decode(encodeBlockPaletteFile({
    width: 4,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 2,
    paletteCount: 2,
    paletteColorBits: 24,
    paletteMode: "explicit",
    palette: [
      { r: 255, g: 0, b: 0 },
      { r: 128, g: 0, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 0, g: 0, b: 128 },
    ],
    blockPaletteSelectors: new Uint8Array([0, 1]),
    blockPaletteIndices: new Uint16Array([0, 1, 0, 1]),
    pixelIndices: new Uint8Array([0, 1, 0, 1, 1, 0, 1, 0]),
  }));
  const regular = createShaderTextureData(texture, 16);
  const compact = createCompactShaderTextureData(texture, 16);

  assert.equal(texture.paletteCount, 2);
  assert.deepEqual(Array.from(regular.paletteSelectorAtlas.data), [0, 1]);
  assert.equal(compact.paletteIndexBits, 1);
  assert.equal(compact.globalIndexBits, 1);
  assert.deepEqual(
    Array.from({ length: 2 }, (_, index) => readPackedValue(
      compact.paletteSelectorAtlas.data,
      index,
      compact.paletteIndexBits
    )),
    [0, 1]
  );
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => readPackedValue(
      compact.blockPaletteAtlas.data,
      index,
      compact.globalIndexBits
    )),
    [0, 1, 0, 1]
  );
});

test("rejects BPAL shader atlases larger than the WebGL texture limit", () => {
  assert.throws(
    () => createShaderTextureData({
      width: 3,
      height: 2,
      blockSize: 2,
      blocksX: 2,
      localColorCount: 2,
      pixelIndices: new Uint8Array(6),
      blockPaletteIndices: new Uint16Array(4),
      palette: [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }],
    }, 2),
    /exceeds the WebGL texture size limit/
  );
});

test("builds independently indexed BPAL mip levels for shader filtering", () => {
  const bytes = encodeBlockPaletteFile({
    width: 4,
    height: 4,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 2,
    paletteColorBits: 24,
    paletteMode: "explicit",
    palette: [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
    ],
    blockPaletteIndices: new Uint16Array([
      0, 1, 0, 1,
      0, 1, 0, 1,
    ]),
    pixelIndices: new Uint8Array([
      0, 0, 1, 1,
      0, 0, 1, 1,
      1, 1, 0, 0,
      1, 1, 0, 0,
    ]),
  });
  const mipmapped = createMipmappedShaderTextureData(decode(bytes), 64);

  assert.equal(mipmapped.mipCount, 3);
  assert.deepEqual(
    mipmapped.levels.map((level) => [level.width, level.height]),
    [[4, 4], [2, 2], [1, 1]]
  );
  assert.deepEqual(
    mipmapped.levels.map((level) => level.pixelOffset),
    [0, 16, 16]
  );
  assert.ok(mipmapped.pixelAtlas.data.length >= 16);
  assert.ok(mipmapped.blockPaletteAtlas.data.length >= 13 * 4);
  assert.equal(
    mipmapped.gpuBytes,
    mipmapped.pixelAtlas.data.byteLength +
      mipmapped.paletteSelectorAtlas.data.byteLength +
      mipmapped.blockPaletteAtlas.data.byteLength +
      mipmapped.paletteAtlas.data.byteLength
  );
});

test("limits mip block colors and uses direct indices when every pixel can have a color", () => {
  const palette = Array.from({ length: 16 }, (_, index) => ({
    r: index * 17,
    g: index * 17,
    b: index * 17,
  }));
  const texture = decode(encodeBlockPaletteFile({
    width: 8,
    height: 8,
    blockSize: 8,
    localColorCount: 16,
    globalColorCount: 16,
    paletteColorBits: 24,
    paletteMode: "explicit",
    palette,
    blockPaletteIndices: Uint16Array.from({ length: 16 }, (_, index) => index),
    pixelIndices: Uint8Array.from({ length: 64 }, (_, index) => index % 16),
  }));
  const levels = createMipLevels(texture);

  assert.deepEqual(
    levels.map((level) => level.blockSize),
    [8, 4, 2, 1]
  );
  assert.deepEqual(
    levels.map((level) => level.localColorCount),
    [16, 16, 4, 1]
  );
  for (const level of levels.slice(1)) {
    assert.ok(level.directGlobalIndices instanceof Uint16Array);
    assert.equal(level.pixelIndices, undefined);
    assert.equal(level.blockPaletteIndices, undefined);
  }
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

function readPackedValue(words, valueIndex, bitsPerValue) {
  const bitOffset = valueIndex * bitsPerValue;
  const wordIndex = Math.floor(bitOffset / 32);
  const wordBit = bitOffset % 32;
  let value = words[wordIndex] >>> wordBit;

  if (wordBit + bitsPerValue > 32) {
    value |= words[wordIndex + 1] << (32 - wordBit);
  }

  return value & (2 ** bitsPerValue - 1);
}
