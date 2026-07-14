"use strict";

const assert = require("node:assert/strict");
const {
  BLOCK_SIZES,
  MAX_GPU_READS,
  encodeAdaptiveBlockFile,
  openAdaptiveBlockFile,
} = require("../src/palette/adaptive-block-format.js");
const {
  openRandomAccessImageFile,
} = require("../src/palette/block-pattern-dictionary.js");

test("adaptive supertiles preserve every selected candidate pixel", () => {
  const candidates = BLOCK_SIZES.map((blockSize, mode) => createCandidate(blockSize, mode));
  const tileModes = Uint8Array.from([0, 1, 2, 3, 2, 0]);
  const encoded = encodeAdaptiveBlockFile(candidates, tileModes);
  const accessor = openAdaptiveBlockFile(encoded.bytes);
  const genericAccessor = openRandomAccessImageFile(encoded.bytes);

  assert.equal(accessor.format, "bpav");
  assert.deepEqual(accessor.usedBlockSizes, BLOCK_SIZES);
  assert.equal(encoded.bytes.length % 4, 0);
  assert.equal(encoded.bytes.length, encoded.stats.totalBytes);
  assert.equal(encoded.stats.deterministicLookup, true);

  for (let y = 0; y < accessor.height; y += 1) {
    for (let x = 0; x < accessor.width; x += 1) {
      const tile = Math.floor(y / 64) * accessor.tilesX + Math.floor(x / 64);
      const expected = getCandidatePixel(candidates[tileModes[tile]], x, y);
      const actual = accessor.getPixel(x, y);

      assert.deepEqual(actual, expected, `pixel ${x},${y}`);
      assert.deepEqual(genericAccessor.getPixel(x, y), expected, `generic pixel ${x},${y}`);
      assert.equal(accessor.getPixelIndex(x, y), candidates[tileModes[tile]].pixelIndices[y * accessor.width + x]);
    }
  }
});

test("shader-equivalent lookup is deterministic and bounded by eight reads", () => {
  const candidates = BLOCK_SIZES.map((blockSize, mode) => createCandidate(blockSize, mode));
  const tileModes = Uint8Array.from([3, 2, 1, 0, 1, 3]);
  const first = encodeAdaptiveBlockFile(candidates, tileModes);
  const second = encodeAdaptiveBlockFile(candidates, tileModes);
  const accessor = openAdaptiveBlockFile(first.bytes);
  let maximumReads = 0;

  assert.deepEqual(first.bytes, second.bytes);
  for (let y = 0; y < accessor.height; y += 1) {
    for (let x = 0; x < accessor.width; x += 1) {
      const scalar = accessor.getPixel(x, y);
      const gpu = accessor.getPixelGpuReference(x, y);

      maximumReads = Math.max(maximumReads, gpu.reads);
      assert.deepEqual(
        [gpu.r, gpu.g, gpu.b, gpu.a],
        [scalar.r, scalar.g, scalar.b, scalar.a],
        `GPU reference pixel ${x},${y}`
      );
    }
  }
  assert.ok(maximumReads <= MAX_GPU_READS);
  assert.equal(accessor.maximumGpuReadsPerPixel, MAX_GPU_READS);
});

test("single-mode RGB565 files retain O(1) coordinate lookup", () => {
  const candidates = BLOCK_SIZES.map((blockSize, mode) =>
    createCandidate(blockSize, mode, { width: 63, height: 61, paletteColorBits: 16 })
  );
  const encoded = encodeAdaptiveBlockFile(candidates, Uint8Array.of(2));
  const accessor = openAdaptiveBlockFile(encoded.bytes);

  assert.deepEqual(accessor.usedBlockSizes, [16]);
  for (const [x, y] of [[0, 0], [62, 0], [0, 60], [62, 60], [31, 29]]) {
    assert.deepEqual(accessor.getPixelGpuReference(x, y), {
      ...accessor.getPixel(x, y),
      reads: accessor.getPixelGpuReference(x, y).reads,
    });
  }
});

test("rejects invalid modes, directory offsets, and nonzero GPU padding", () => {
  const candidates = BLOCK_SIZES.map((blockSize, mode) => createCandidate(blockSize, mode));
  const encoded = encodeAdaptiveBlockFile(candidates, Uint8Array.from([0, 1, 2, 3, 2, 0]));

  assert.throws(
    () => encodeAdaptiveBlockFile(candidates, Uint8Array.of(0)),
    /tileModes length/
  );

  const invalidDirectory = encoded.bytes.slice();
  const paletteBytes = 4 * 2 * 8 * 3;
  const directoryStart = 32 + paletteBytes;

  invalidDirectory[directoryStart] ^= 1;
  assert.throws(() => openAdaptiveBlockFile(invalidDirectory), /supertile directory/);

  const invalidPadding = encoded.bytes.slice();
  const rawBytes = new DataView(
    invalidPadding.buffer,
    invalidPadding.byteOffset,
    invalidPadding.byteLength
  ).getUint32(24, true);

  if (rawBytes < invalidPadding.length) {
    invalidPadding[rawBytes] = 1;
    assert.throws(() => openAdaptiveBlockFile(invalidPadding), /padding must be zero/);
  }
  assert.throws(() => openAdaptiveBlockFile(encoded.bytes.slice(0, -1)), /file size/);
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

function getCandidatePixel(candidate, x, y) {
  const blocksX = Math.ceil(candidate.width / candidate.blockSize);
  const block = Math.floor(y / candidate.blockSize) * blocksX + Math.floor(x / candidate.blockSize);
  const local = candidate.pixelIndices[y * candidate.width + x];
  const selector = candidate.blockPaletteSelectors[block];
  const global = candidate.blockPaletteIndices[block * candidate.localColorCount + local];
  const color = candidate.palette[selector * candidate.globalColorCount + global];

  return { ...color, a: 255 };
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
