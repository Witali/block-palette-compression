"use strict";

const assert = require("node:assert/strict");
const BlockPaletteFormat = require("../src/palette/block-palette-format.js");
const BplmFormat = require("../src/palette/bplm-format.js");
const BpalTextureDecoder = require("../src/decoders/bpal-texture.js");
const { compressImage } = require("../src/palette/block-palette-codec.js");

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

test("stores palette selectors throughout a multi-palette mip chain", () => {
  const source = new Uint8ClampedArray(8 * 8 * 4);

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const offset = (y * 8 + x) * 4;
      const blueBlock = x >= 4;

      source[offset] = blueBlock ? 0 : 255;
      source[offset + 1] = (x + y) % 2 === 0 ? 0 : 64;
      source[offset + 2] = blueBlock ? 255 : 0;
      source[offset + 3] = 255;
    }
  }

  const image = compressImage(source, 8, 8, {
    blockSize: 4,
    localColorCount: 2,
    globalColorCount: 2,
    paletteCount: 2,
    colorSpace: "rgb",
  });
  const decoded = BplmFormat.decodeBplmFile(BplmFormat.encodeBplmFile(image));
  const shaderTexture = BpalTextureDecoder.createMipmappedShaderTextureData(decoded, 64);

  assert.equal(decoded.paletteCount, 2);
  assert.equal(decoded.paletteIndexBits, 1);
  assert.ok(shaderTexture.paletteSelectorAtlas.data instanceof Uint8Array);
  assert.deepEqual(
    shaderTexture.levels.map((level) => level.paletteSelectorOffset),
    [0, 4, 8, 8]
  );
  assert.deepEqual(BplmFormat.reconstructBplmMipPixels(decoded, 0), image.pixels);

  for (const level of decoded.mipLevels.filter((candidate) => !candidate.direct)) {
    assert.equal(level.blockPaletteSelectors.length, level.blocksX * level.blocksY);
    assert.ok(Array.from(level.blockPaletteSelectors).every((index) => index < 2));
    assert.ok(Array.from(level.blockPaletteIndices).every((index) => index < 2));
  }

  decoded.mipLevels.forEach((_level, mipIndex) => {
    assert.equal(
      BplmFormat.reconstructBplmMipPixels(decoded, mipIndex).length,
      decoded.mipLevels[mipIndex].width * decoded.mipLevels[mipIndex].height * 4
    );
  });
});

test("reconstructs regular and direct BPLM mip levels into RGBA pixels", () => {
  const decoded = BplmFormat.decodeBplmFile(BplmFormat.encodeBplmFile(createFixture()));

  decoded.mipLevels.forEach((level, mip) => {
    const pixels = BplmFormat.reconstructBplmMipPixels(decoded, mip);

    assert.ok(pixels instanceof Uint8ClampedArray);
    assert.equal(pixels.length, level.width * level.height * 4);
    assert.ok(Array.from({ length: level.width * level.height }, (_, pixel) =>
      pixels[pixel * 4 + 3] === 255
    ).every(Boolean));
  });

  assert.deepEqual(
    BplmFormat.reconstructBplmMipPixels(decoded, 0),
    decoded.pixels
  );
  assert.equal(decoded.mipLevels.at(-1).direct, true);
});

test("rejects invalid BPLM mip selections", () => {
  const decoded = BplmFormat.decodeBplmFile(BplmFormat.encodeBplmFile(createFixture()));

  assert.throws(() => BplmFormat.reconstructBplmMipPixels(decoded, -1), /out of range/);
  assert.throws(() => BplmFormat.reconstructBplmMipPixels(decoded, decoded.mipCount), /out of range/);
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
