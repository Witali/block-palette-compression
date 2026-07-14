"use strict";

const assert = require("node:assert/strict");
const {
  encodeBlockPaletteFile,
  decodeBlockPaletteFile,
} = require("../src/palette/block-palette-format.js");
const {
  MAGIC,
  VERSION,
  encodePatternDictionaryFile,
  encodeSmallestRandomAccessFile,
  openRandomAccessImageFile,
  openPatternDictionaryFile,
} = require("../src/palette/block-pattern-dictionary.js");

test("dictionary references and sparse deltas preserve every decoded pixel", () => {
  const image = createRepeatedPatternImage();
  const expected = decodeBlockPaletteFile(encodeBlockPaletteFile(image));
  const encoded = encodePatternDictionaryFile(expected, {
    forceDictionarySize: 2,
    maxDictionarySize: 2,
    checkpointLog2: 2,
  });
  const accessor = openPatternDictionaryFile(encoded.bytes);

  assert.equal(String.fromCharCode(...encoded.bytes.slice(0, 4)), MAGIC);
  assert.equal(accessor.version, VERSION);
  assert.equal(accessor.dictionarySize, 2);
  assert.ok(encoded.stats.referencedBlocks > 0);

  assertEveryPixelMatches(accessor, expected);
  assert.throws(() => accessor.getPixel(-1, 0), /x coordinate/);
  assert.throws(() => accessor.getPixel(0, image.height), /y coordinate/);
});

test("automatic selection keeps the raw random-access stream when a dictionary is larger", () => {
  const image = createNoisyPatternImage();
  const expected = decodeBlockPaletteFile(encodeBlockPaletteFile(image));
  const encoded = encodeSmallestRandomAccessFile(expected, {
    maxDictionarySize: 4,
    checkpointLog2: 2,
  });
  const accessor = openRandomAccessImageFile(encoded.bytes);

  assert.equal(encoded.format, "bpal");
  assert.equal(accessor.format, "bpal");
  assert.equal(encoded.bytes.length, encodeBlockPaletteFile(expected).length);
  assert.equal(encoded.stats.encodedPixelBits, encoded.stats.originalPixelBits);
  assertEveryPixelMatches(accessor, expected);
});

test("direct-color blocks remain independently addressable without a pixel payload", () => {
  const palette = [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
  ];
  const image = {
    width: 3,
    height: 3,
    blockSize: 2,
    localColorCount: 4,
    globalColorCount: 4,
    paletteCount: 1,
    paletteColorBits: 16,
    palette,
    blockPaletteIndices: new Uint16Array([
      0, 1, 2, 3,
      1, 2, 3, 0,
      2, 3, 0, 1,
      3, 0, 1, 2,
    ]),
    pixelIndices: new Uint8Array([
      0, 1, 0,
      2, 3, 2,
      0, 1, 0,
    ]),
  };
  const expected = decodeBlockPaletteFile(encodeBlockPaletteFile(image));
  const encoded = encodePatternDictionaryFile(expected);
  const accessor = openPatternDictionaryFile(encoded.bytes);

  assert.equal(accessor.directPixelColors, true);
  assert.equal(accessor.dictionarySize, 0);
  assert.equal(encoded.stats.encodedPixelBits, 0);
  assertEveryPixelMatches(accessor, expected);
});

test("run-delta blocks preserve independently addressed pixels", () => {
  const image = createRunPatternImage();
  const expected = decodeBlockPaletteFile(encodeBlockPaletteFile(image));
  const encoded = encodePatternDictionaryFile(expected, {
    forceDictionarySize: 1,
    maxDictionarySize: 1,
    checkpointLog2: 2,
  });
  const accessor = openPatternDictionaryFile(encoded.bytes);

  assert.ok(encoded.stats.runLengthBlocks > 0);
  assertEveryPixelMatches(accessor, expected);
});

test("transformed dictionary references preserve asymmetric rotated blocks", () => {
  const image = createTransformedPatternImage();
  const expected = decodeBlockPaletteFile(encodeBlockPaletteFile(image));
  const encoded = encodePatternDictionaryFile(expected, {
    forceDictionarySize: 1,
    maxDictionarySize: 1,
    checkpointLog2: 1,
  });
  const accessor = openPatternDictionaryFile(encoded.bytes);

  assert.ok(encoded.stats.transformedBlocks > 0);
  assertEveryPixelMatches(accessor, expected);
});

test("rejects truncated and invalid pattern-dictionary files", () => {
  const expected = decodeBlockPaletteFile(encodeBlockPaletteFile(createRepeatedPatternImage()));
  const encoded = encodePatternDictionaryFile(expected, {
    forceDictionarySize: 1,
    maxDictionarySize: 1,
  }).bytes;
  const invalidMagic = encoded.slice();

  invalidMagic[0] = 0;

  assert.throws(() => openPatternDictionaryFile(invalidMagic), /Invalid BPDI magic/);
  assert.throws(() => openPatternDictionaryFile(encoded.slice(0, -1)), /file size does not match/);
});

function createRepeatedPatternImage() {
  const width = 32;
  const height = 16;
  const blockSize = 4;
  const localColorCount = 4;
  const blocksX = width / blockSize;
  const blocksY = height / blockSize;
  const blockCount = blocksX * blocksY;
  const palette = Array.from({ length: 8 }, (_, index) => ({
    r: index * 36,
    g: index * 36,
    b: index * 36,
  }));
  const blockPaletteIndices = new Uint16Array(blockCount * localColorCount);
  const pixelIndices = new Uint8Array(width * height);

  for (let blockY = 0; blockY < blocksY; blockY += 1) {
    for (let blockX = 0; blockX < blocksX; blockX += 1) {
      const block = blockY * blocksX + blockX;
      const reversed = block % 2 === 1;
      const horizontal = block % 3 === 0;
      const blockOffset = block * localColorCount;

      blockPaletteIndices[blockOffset] = reversed ? 7 : 0;
      blockPaletteIndices[blockOffset + 1] = reversed ? 0 : 7;
      blockPaletteIndices[blockOffset + 2] = 2;
      blockPaletteIndices[blockOffset + 3] = 5;

      for (let localY = 0; localY < blockSize; localY += 1) {
        for (let localX = 0; localX < blockSize; localX += 1) {
          const x = blockX * blockSize + localX;
          const y = blockY * blockSize + localY;
          const bright = horizontal ? localY >= 2 : localX >= 2;

          pixelIndices[y * width + x] = Number(bright) ^ Number(reversed);
        }
      }
    }
  }

  return {
    width,
    height,
    blockSize,
    localColorCount,
    globalColorCount: palette.length,
    paletteCount: 1,
    paletteColorBits: 24,
    palette,
    blockPaletteIndices,
    pixelIndices,
  };
}

function createNoisyPatternImage() {
  const width = 16;
  const height = 16;
  const blockSize = 4;
  const localColorCount = 4;
  const blockCount = width / blockSize * (height / blockSize);
  const palette = Array.from({ length: 8 }, (_, index) => ({
    r: index * 31,
    g: 255 - index * 23,
    b: index * 17,
  }));
  const blockPaletteIndices = new Uint16Array(blockCount * localColorCount);
  const pixelIndices = new Uint8Array(width * height);

  for (let block = 0; block < blockCount; block += 1) {
    for (let local = 0; local < localColorCount; local += 1) {
      blockPaletteIndices[block * localColorCount + local] = local;
    }
  }

  let random = 0x12345678;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      pixelIndices[y * width + x] = random >>> 30;
    }
  }

  return {
    width,
    height,
    blockSize,
    localColorCount,
    globalColorCount: palette.length,
    paletteCount: 1,
    paletteColorBits: 24,
    palette,
    blockPaletteIndices,
    pixelIndices,
  };
}

function createRunPatternImage() {
  const width = 64;
  const height = 4;
  const blockSize = 4;
  const localColorCount = 4;
  const blockCount = width / blockSize;
  const palette = [
    { r: 0, g: 0, b: 0 },
    { r: 85, g: 85, b: 85 },
    { r: 170, g: 170, b: 170 },
    { r: 255, g: 255, b: 255 },
  ];
  const permutations = [
    [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1],
    [0, 3, 1, 2], [0, 3, 2, 1], [1, 0, 2, 3], [1, 0, 3, 2],
    [1, 2, 0, 3], [1, 2, 3, 0], [1, 3, 0, 2], [1, 3, 2, 0],
    [2, 0, 1, 3], [2, 0, 3, 1], [2, 1, 0, 3], [2, 1, 3, 0],
  ];
  const blockPaletteIndices = new Uint16Array(blockCount * localColorCount);
  const pixelIndices = new Uint8Array(width * height);

  for (let block = 0; block < blockCount; block += 1) {
    for (let local = 0; local < localColorCount; local += 1) {
      blockPaletteIndices[block * localColorCount + local] = local;
    }

    for (let position = 0; position < blockSize * blockSize; position += 1) {
      const x = block * blockSize + position % blockSize;
      const y = Math.floor(position / blockSize);

      pixelIndices[y * width + x] = permutations[block][Math.floor(position / 4)];
    }
  }

  return {
    width,
    height,
    blockSize,
    localColorCount,
    globalColorCount: palette.length,
    paletteCount: 1,
    paletteColorBits: 24,
    palette,
    blockPaletteIndices,
    pixelIndices,
  };
}

function createTransformedPatternImage() {
  const blockSize = 4;
  const width = blockSize * 2;
  const height = blockSize;
  const pattern = [
    0, 1, 2, 3,
    1, 3, 0, 2,
    3, 2, 1, 0,
    2, 0, 3, 1,
  ];
  const pixelIndices = new Uint8Array(width * height);

  for (let y = 0; y < blockSize; y += 1) {
    for (let x = 0; x < blockSize; x += 1) {
      pixelIndices[y * width + x] = pattern[y * blockSize + x];
      pixelIndices[y * width + blockSize + x] = pattern[
        (blockSize - 1 - x) * blockSize + y
      ];
    }
  }

  return {
    width,
    height,
    blockSize,
    localColorCount: 4,
    globalColorCount: 4,
    paletteCount: 1,
    paletteColorBits: 24,
    palette: [
      { r: 0, g: 0, b: 0 },
      { r: 85, g: 85, b: 85 },
      { r: 170, g: 170, b: 170 },
      { r: 255, g: 255, b: 255 },
    ],
    blockPaletteIndices: new Uint16Array([0, 1, 2, 3, 0, 1, 2, 3]),
    pixelIndices,
  };
}

function assertEveryPixelMatches(accessor, expected) {
  for (let y = 0; y < expected.height; y += 1) {
    for (let x = 0; x < expected.width; x += 1) {
      const actual = accessor.getPixel(x, y);
      const offset = (y * expected.width + x) * 4;

      assert.deepEqual(
        [actual.r, actual.g, actual.b, actual.a],
        Array.from(expected.pixels.slice(offset, offset + 4)),
        `pixel ${x},${y}`
      );
    }
  }
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
