"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  encodeBlockPaletteFile,
  decodeBlockPaletteFile,
} = require("../src/palette/block-palette-format.js");
const {
  encodePatternDictionaryFile,
  openPatternDictionaryFile,
} = require("../src/palette/block-pattern-dictionary.js");
const {
  GLSL_SOURCE,
  MAX_CHECKPOINT_SCAN,
  MAX_POSITION_SEARCH_STEPS,
  MAX_BITMAP_WORDS,
  createShaderData,
  samplePackedPixel,
} = require("../src/palette/block-pattern-dictionary-webgl2.js");

test("packs a representative bitmap-delta BPDI file for identical random pixel lookup", () => {
  const root = path.resolve(__dirname, "..");
  const baseline = decodeBlockPaletteFile(fs.readFileSync(
    path.join(root, "assets", "bpal", "clipart-apple.bpal")
  ));
  const encoded = encodePatternDictionaryFile(baseline);
  const cpuAccessor = openPatternDictionaryFile(encoded.bytes);
  const gpuData = createShaderData(encoded.bytes, 256);
  const queries = createQueries(baseline.width, baseline.height, 4096);

  assert.ok(encoded.stats.bitmapDeltaBlocks > 0);
  assert.ok(encoded.stats.rawBlocks > 0);
  assert.ok(encoded.stats.runLengthBlocks > 0);
  assert.ok(
    encoded.stats.referencedBlocks -
      encoded.stats.bitmapDeltaBlocks -
      encoded.stats.transformedBlocks -
      encoded.stats.exactBlocks > 0
  );
  assert.equal(gpuData.layout.checkpointInterval, 16);
  assert.equal(gpuData.wordAtlas.data[0], 0x42504449);

  assertQueriesMatch(baseline, cpuAccessor, gpuData, queries);
});

test("GPU-packed transform and bitmap paths match exhaustive CPU and JS decoding", () => {
  for (const [image, expectedStat] of [
    [createTransformedPatternImage(), "transformedBlocks"],
    [createBitmapDeltaImage(), "bitmapDeltaBlocks"],
  ]) {
    const baseline = decodeBlockPaletteFile(encodeBlockPaletteFile(image));
    const encoded = encodePatternDictionaryFile(baseline, {
      forceDictionarySize: 1,
      maxDictionarySize: 1,
    });
    const cpuAccessor = openPatternDictionaryFile(encoded.bytes);
    const gpuData = createShaderData(encoded.bytes, 64);
    const queries = [];

    assert.ok(encoded.stats[expectedStat] > 0);

    for (let y = 0; y < baseline.height; y += 1) {
      for (let x = 0; x < baseline.width; x += 1) {
        queries.push([x, y]);
      }
    }

    assertQueriesMatch(baseline, cpuAccessor, gpuData, queries);
  }
});

test("GLSL helper uses compile-time bounded tag, position, and bitmap loops", () => {
  assert.equal(MAX_CHECKPOINT_SCAN, 15);
  assert.equal(MAX_POSITION_SEARCH_STEPS, 12);
  assert.equal(MAX_BITMAP_WORDS, 128);
  assert.match(GLSL_SOURCE, /index < BPDI_MAX_CHECKPOINT_SCAN/);
  assert.match(GLSL_SOURCE, /step < BPDI_MAX_POSITION_SEARCH_STEPS/);
  assert.match(GLSL_SOURCE, /word < BPDI_MAX_BITMAP_WORDS/);
  assert.match(GLSL_SOURCE, /rank \+= bpdiPopCount\(/);
  assert.match(GLSL_SOURCE, /bpdiTransformPosition/);
  assert.doesNotMatch(GLSL_SOURCE, /index < int\(tag\.z\)/);
  assert.doesNotMatch(GLSL_SOURCE, /while\s*\(/);
});

function assertQueriesMatch(baseline, cpuAccessor, gpuData, queries) {
  for (const [x, y] of queries) {
    const jsPixel = cpuAccessor.getPixel(x, y);
    const packedPixel = samplePackedPixel(gpuData, x, y);
    const offset = (y * baseline.width + x) * 4;
    const expected = Array.from(baseline.pixels.slice(offset, offset + 4));

    assert.deepEqual(
      [jsPixel.r, jsPixel.g, jsPixel.b, jsPixel.a],
      expected,
      `CPU/JS pixel ${x},${y}`
    );
    assert.deepEqual(
      [packedPixel.r, packedPixel.g, packedPixel.b, packedPixel.a],
      expected,
      `R32UI-packed pixel ${x},${y}`
    );
  }
}

function createQueries(width, height, requestedCount) {
  const queries = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), Math.floor(height / 2)],
  ];
  let random = 0x243f6a88;

  while (queries.length < requestedCount) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const x = random % width;
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const y = random % height;

    queries.push([x, y]);
  }

  return queries.slice(0, requestedCount);
}

function createTransformedPatternImage() {
  const blockSize = 4;
  const width = 8;
  const height = 4;
  const pattern = [
    0, 1, 0, 0,
    0, 1, 1, 0,
    0, 0, 1, 0,
    0, 0, 0, 0,
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

  return createImage(width, height, blockSize, pixelIndices);
}

function createBitmapDeltaImage() {
  const blockSize = 4;
  const blockCount = 16;
  const width = blockSize * blockCount;
  const height = blockSize;
  const basePattern = [
    0, 1, 2, 3,
    0, 1, 2, 3,
    0, 1, 2, 3,
    0, 1, 2, 3,
  ];
  const deltaPattern = basePattern.slice();
  const pixelIndices = new Uint8Array(width * height);

  for (const position of [5, 6, 9, 10, 13, 14]) {
    deltaPattern[position] = deltaPattern[position] === 1 ? 2 : 1;
  }

  for (let block = 0; block < blockCount; block += 1) {
    const pattern = block < 9 ? basePattern : deltaPattern;

    for (let position = 0; position < blockSize * blockSize; position += 1) {
      const x = block * blockSize + position % blockSize;
      const y = Math.floor(position / blockSize);

      pixelIndices[y * width + x] = pattern[position];
    }
  }

  return createImage(width, height, blockSize, pixelIndices);
}

function createImage(width, height, blockSize, pixelIndices) {
  const blockCount = Math.ceil(width / blockSize) * Math.ceil(height / blockSize);

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
    blockPaletteIndices: Uint16Array.from(
      { length: blockCount * 4 },
      (_, index) => index % 4
    ),
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
