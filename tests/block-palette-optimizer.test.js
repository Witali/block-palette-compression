"use strict";

const assert = require("node:assert/strict");
const {
  calculateBitsPerPixelRange,
  findBalancedBlockPaletteSettings,
  paretoFrontier,
  selectHighestQualityCandidate,
} = require("../src/palette/block-palette-optimizer.js");
const { compressImage } = require("../src/palette/block-palette-codec.js");

test("searches profiles and returns a non-dominated balanced setting", () => {
  const source = new Uint8ClampedArray(16 * 16 * 4);

  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const offset = (y * 16 + x) * 4;

      source[offset] = x * 17;
      source[offset + 1] = y * 17;
      source[offset + 2] = (x + y) * 8;
      source[offset + 3] = 255;
    }
  }

  const profiles = [
    { blockSize: 4, localColorCount: 8, globalColorCount: 32, paletteColorBits: 24 },
    { blockSize: 8, localColorCount: 4, globalColorCount: 16, paletteColorBits: 24 },
    { blockSize: 8, localColorCount: 4, globalColorCount: 16, paletteColorBits: 16 },
    { blockSize: 16, localColorCount: 2, globalColorCount: 8, paletteColorBits: 16 },
  ];
  const progress = [];
  const result = findBalancedBlockPaletteSettings(source, 16, 16, {
    profiles,
    colorSpace: "rgb",
    dithering: "none",
    diversity: 0,
  }, (entry) => progress.push(entry));
  const explicitMedoids = findBalancedBlockPaletteSettings(source, 16, 16, {
    profiles,
    colorSpace: "rgb",
    clusteringMethod: "k-medoids",
    dithering: "none",
    diversity: 0,
  });

  assert.equal(result.candidates.length, profiles.length);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.rmse),
    explicitMedoids.candidates.map((candidate) => candidate.rmse)
  );
  assert.equal(progress.length, profiles.length);
  assert.deepEqual(progress.map((entry) => entry.completed), [1, 2, 3, 4]);
  assert.ok(result.frontier.includes(result.frontier.find((candidate) => (
    candidate.settings.blockSize === result.settings.blockSize &&
    candidate.settings.localColorCount === result.settings.localColorCount &&
    candidate.settings.globalColorCount === result.settings.globalColorCount &&
    candidate.settings.paletteColorBits === result.settings.paletteColorBits
  ))));
  assert.ok(!result.candidates.some((candidate) => (
    candidate.fileBytes < result.selected.fileBytes &&
    candidate.rmse < result.selected.rmse
  )));
});

test("removes settings dominated by both file size and error", () => {
  const best = { fileBytes: 100, rmse: 4 };
  const smaller = { fileBytes: 80, rmse: 8 };
  const dominated = { fileBytes: 120, rmse: 9 };
  const frontier = paretoFrontier([best, smaller, dominated]);

  assert.deepEqual(frontier, [smaller, best]);
});

test("calculates midpoint bpp ranges from adjacent preset targets", () => {
  const targets = [1.5, 2, 2.5, 3, 4, 5, 6, 8];

  assert.deepEqual(calculateBitsPerPixelRange(3, targets), {
    minimum: 2.75,
    maximum: 3.5,
  });
  assert.deepEqual(calculateBitsPerPixelRange(1.5, targets), {
    minimum: 1.25,
    maximum: 1.75,
  });
  assert.deepEqual(calculateBitsPerPixelRange(8, targets), {
    minimum: 7,
    maximum: 9,
  });
});

test("selects minimum RMSE within a bpp range and uses bpp distance as a tie-breaker", () => {
  const candidates = [
    { fileBytes: 90, bitsPerPixel: 2.9, rmse: 5 },
    { fileBytes: 130, bitsPerPixel: 3.4, rmse: 3 },
    { fileBytes: 110, bitsPerPixel: 3.1, rmse: 3 },
  ];

  assert.equal(selectHighestQualityCandidate(candidates, 3), candidates[2]);
});

test("limits target-bpp optimization to the midpoint range", () => {
  const source = new Uint8ClampedArray([
    0, 0, 0, 255, 85, 85, 85, 255,
    170, 170, 170, 255, 255, 255, 255, 255,
  ]);
  const profiles = [
    { blockSize: 2, localColorCount: 2, globalColorCount: 4, paletteColorBits: 16 },
    { blockSize: 2, localColorCount: 2, globalColorCount: 8, paletteColorBits: 24 },
  ];
  const initial = findBalancedBlockPaletteSettings(source, 2, 2, {
    profiles,
    colorSpace: "rgb",
    clusteringMethod: "k-medians",
  });
  const target = initial.candidates[0].bitsPerPixel;
  const epsilon = 0.01;
  const optimized = findBalancedBlockPaletteSettings(source, 2, 2, {
    profiles,
    colorSpace: "rgb",
    clusteringMethod: "k-medians",
    targetBitsPerPixel: target,
    bitsPerPixelTargets: [target - epsilon, target, target + epsilon],
  });

  assert.ok(optimized.matchingCandidates.length >= 1);
  assert.ok(optimized.matchingCandidates.every((candidate) => (
    candidate.bitsPerPixel >= optimized.bitsPerPixelRange.minimum &&
    candidate.bitsPerPixel <= optimized.bitsPerPixelRange.maximum
  )));
  assert.equal(
    optimized.selected.rmse,
    Math.min(...optimized.matchingCandidates.map((candidate) => candidate.rmse))
  );
  assert.equal(
    optimized.selected.psnr,
    optimized.selected.rmse === 0
      ? Infinity
      : 20 * Math.log10(255 / optimized.selected.rmse)
  );
});

test("keeps the selected palette color format for every search candidate", () => {
  const source = new Uint8ClampedArray([
    0, 0, 0, 255, 85, 85, 85, 255,
    170, 170, 170, 255, 255, 255, 255, 255,
  ]);
  const optimized = findBalancedBlockPaletteSettings(source, 2, 2, {
    profiles: [
      { blockSize: 2, localColorCount: 2, globalColorCount: 8, paletteColorBits: 16 },
      { blockSize: 2, localColorCount: 2, globalColorCount: 8, paletteColorBits: 24 },
    ],
    paletteColorBits: 24,
    colorSpace: "rgb",
    clusteringMethod: "k-medians",
  });

  assert.equal(optimized.candidates.length, 1);
  assert.equal(optimized.settings.paletteColorBits, 24);
  assert.ok(optimized.candidates.every((candidate) => (
    candidate.settings.paletteColorBits === 24
  )));
});

test("measures candidate bpp for the full image while evaluating preview quality", () => {
  const source = new Uint8ClampedArray([
    0, 0, 0, 255, 85, 85, 85, 255,
    170, 170, 170, 255, 255, 255, 255, 255,
  ]);
  const profile = {
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 8,
    paletteColorBits: 24,
  };
  const optimized = findBalancedBlockPaletteSettings(source, 2, 2, {
    profiles: [profile],
    colorSpace: "rgb",
    clusteringMethod: "k-medians",
    storageWidth: 16,
    storageHeight: 8,
  });

  assert.equal(optimized.selected.bitsPerPixel, 4);
  assert.equal(optimized.selected.payloadBytes, 64);
});

test("optimizes using explicit-palette storage and the current BPAL header", () => {
  const source = new Uint8ClampedArray([
    0, 0, 0, 255, 85, 85, 85, 255,
    170, 170, 170, 255, 255, 255, 255, 255,
  ]);
  const profile = {
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 8,
    paletteColorBits: 24,
  };
  const options = {
    profiles: [profile],
    colorSpace: "rgb",
    clusteringMethod: "k-medians",
  };
  const optimized = findBalancedBlockPaletteSettings(source, 2, 2, options);
  const compressed = compressImage(source, 2, 2, { ...profile, ...options });

  assert.equal(compressed.paletteMode, "explicit");
  assert.equal(compressed.clusteringMethod, "k-medians");
  assert.equal(compressed.storage.globalPaletteBits, 8 * 24);
  assert.equal(optimized.selected.fileBytes, compressed.storage.totalBytes + 14);
});

test("settings search omits redundant pixel indices in direct blocks", () => {
  const source = new Uint8ClampedArray([
    0, 0, 0, 255, 85, 85, 85, 255,
    170, 170, 170, 255, 255, 255, 255, 255,
  ]);
  const profile = {
    blockSize: 2,
    localColorCount: 4,
    globalColorCount: 8,
    paletteColorBits: 24,
  };
  const optimized = findBalancedBlockPaletteSettings(source, 2, 2, {
    profiles: [profile],
    colorSpace: "rgb",
    clusteringMethod: "k-medians",
  });
  const compressed = compressImage(source, 2, 2, {
    ...profile,
    colorSpace: "rgb",
    clusteringMethod: "k-medians",
  });

  assert.equal(compressed.storage.pixelDataBits, 0);
  assert.equal(optimized.selected.fileBytes, compressed.storage.totalBytes + 14);
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
