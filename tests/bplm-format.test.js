"use strict";

const assert = require("node:assert/strict");
const BlockPaletteFormat = require("../src/palette/block-palette-format.js");
const BplmFormat = require("../src/palette/bplm-format.js");
const BpalTextureDecoder = require("../src/decoders/bpal-texture.js");

test("stores a complete mip chain that shares the base BPAL palette", () => {
  const image = createFixture();
  const baseBytes = BlockPaletteFormat.encodeBlockPaletteFile(image);
  const encoded = BplmFormat.encodeBplmFile(image);
  const decoded = BplmFormat.decodeBplmFile(encoded);

  assert.equal(decoded.containerMagic, "BPLM");
  assert.equal(decoded.containerVersion, 1);
  assert.equal(decoded.bplmStorage.baseBytes, baseBytes.length);
  assert.equal(decoded.mipCount, 4);
  assert.deepEqual(
    decoded.mipLevels.map((level) => [level.width, level.height]),
    [[8, 8], [4, 4], [2, 2], [1, 1]]
  );
  assert.deepEqual(
    decoded.mipLevels.map((level) => level.blockSize),
    [8, 4, 2, 1]
  );
  assert.ok(decoded.mipLevels.filter((level) => level.blockSize > 1).every((level) =>
    Array.from(level.blockPaletteIndices).every((index) => index < image.globalColorCount)
  ));
  assert.ok(decoded.mipLevels.filter((level) => level.blockSize > 1).every((level) =>
    Array.from(level.pixelIndices).every((index) => index < image.localColorCount)
  ));
  assert.ok(decoded.mipLevels[3].directGlobalIndices instanceof Uint16Array);
  assert.equal(decoded.mipLevels[3].pixelIndices, undefined);
  assert.equal(decoded.mipLevels[3].blockPaletteIndices, undefined);
});

test("uses stored BPLM levels when building WebGL shader atlases", () => {
  const decoded = BplmFormat.decodeBplmFile(BplmFormat.encodeBplmFile(createFixture()));
  const texture = BpalTextureDecoder.createMipmappedShaderTextureData(decoded, 64);

  assert.equal(texture.mipCount, decoded.mipCount);
  assert.deepEqual(
    texture.levels.map((level) => level.blockSize),
    [8, 4, 2, 1]
  );
  assert.deepEqual(
    texture.levels.map((level) => level.pixelOffset),
    [0, 64, 80, 84]
  );
});

test("identifies BPLM files without accepting BPAL files", () => {
  const image = createFixture();

  assert.equal(BplmFormat.isBplmFile(BplmFormat.encodeBplmFile(image)), true);
  assert.equal(BplmFormat.isBplmFile(BlockPaletteFormat.encodeBlockPaletteFile(image)), false);
});

test("rejects invalid and truncated BPLM containers", () => {
  const encoded = BplmFormat.encodeBplmFile(createFixture());
  const invalidMagic = encoded.slice();
  const invalidVersion = encoded.slice();

  invalidMagic[0] = 0;
  invalidVersion[4] = 2;

  assert.throws(() => BplmFormat.decodeBplmFile(invalidMagic), /Invalid BPLM magic/);
  assert.throws(() => BplmFormat.decodeBplmFile(invalidVersion), /Unsupported BPLM version/);
  assert.throws(() => BplmFormat.decodeBplmFile(encoded.slice(0, -1)), /Truncated BPLM mip/);
});

function createFixture() {
  const width = 8;
  const height = 8;
  const pixelIndices = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixelIndices[y * width + x] = (x + y) % 2;
    }
  }

  return {
    width,
    height,
    blockSize: 8,
    localColorCount: 2,
    globalColorCount: 4,
    paletteColorBits: 24,
    paletteMode: "explicit",
    palette: [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 0, b: 255 },
    ],
    blockPaletteIndices: new Uint16Array([0, 1]),
    pixelIndices,
  };
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
