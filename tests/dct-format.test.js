"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { GpuJpegDecoder } = require("../src/decoders/gpu-jpeg.js");
const {
  HEADER_BYTES,
  PRESETS,
  encodeDctFile,
  importJpegDctFile,
  decodeDctFile,
  sampleDctFilePixel,
  inspectDctFile,
  inspectDctMcu,
  findBestDctQuality,
} = require("../src/dct/dct-format.js");

const root = path.resolve(__dirname, "..");

test("stores every DCT preset as fixed independently addressed MCU records", () => {
  const width = 19;
  const height = 17;
  const source = makePixels(width, height);

  for (const [presetKey, preset] of Object.entries(PRESETS)) {
    const encoded = encodeDctFile(source, width, height, { preset: presetKey, quality: 72 });
    const info = inspectDctFile(encoded);

    assert.equal(info.mcuCount, 4);
    assert.equal(info.bytesPerMcu, preset.bytesPerMcu);
    assert.equal(encoded.length, HEADER_BYTES + 4 * preset.bytesPerMcu);
    assert.equal(info.bpp, preset.bpp);
  }
});

test("covers every rate from the preserved reference converter", () => {
  assert.equal(Object.keys(PRESETS).length, 9);

  for (const preset of ["0.75", "1", "1.5", "2", "3", "4.5", "6", "7.5", "9"]) {
    assert.ok(PRESETS[preset], `missing ${preset} bpp`);
  }

  assert.deepEqual(PRESETS["3"], {
    modeCode: 3000,
    bpp: 3,
    bytesPerMcu: 96,
    yBytes: 64,
    cbBytes: 16,
    crBytes: 16,
  });
  assert.deepEqual(PRESETS["6"], {
    modeCode: 6000,
    bpp: 6,
    bytesPerMcu: 192,
    yBytes: 128,
    cbBytes: 32,
    crBytes: 32,
  });
  assert.deepEqual(PRESETS["7.5"], {
    modeCode: 7500,
    bpp: 7.5,
    bytesPerMcu: 240,
    yBytes: 160,
    cbBytes: 40,
    crBytes: 40,
  });
  assert.deepEqual(PRESETS["9"], {
    modeCode: 9000,
    bpp: 9,
    bytesPerMcu: 288,
    yBytes: 192,
    cbBytes: 48,
    crBytes: 48,
  });
});

test("keeps DC outside the AC mask and maps mask bit zero to AC1", () => {
  const constant = encodeDctFile(makeConstantPixels(16, 16, 192), 16, 16, {
    preset: "6",
    quality: 97,
    coefficientCoding: "masked-tail-8x8",
  });
  const constantView = new DataView(constant.buffer, constant.byteOffset + HEADER_BYTES);
  const constantBlock = inspectDctMcu(constant, 0).components.y.blocks[0];

  assert.equal(constantView.getUint32(0, true), 0, "DC must not consume mask bit zero");
  assert.equal(constantView.getUint32(4, true) & 0x3fffffff, 0);
  assert.equal(constantBlock.encodingMode, "masked-tail");
  assert.equal(constantBlock.explicitAcCount, 0);
  assert.equal(constantBlock.tailAcCount, 23);
  assert.equal(constantBlock.tailStart, 41);
  assert.equal(constantBlock.coefficientCount, 24);

  const ac1 = encodeDctFile(makeHorizontalAc1Pixels(16, 16), 16, 16, {
    preset: "6",
    quality: 97,
    coefficientCoding: "masked-tail-8x8",
  });
  const ac1View = new DataView(ac1.buffer, ac1.byteOffset + HEADER_BYTES);
  assert.equal(ac1View.getUint32(0, true) & 1, 1, "mask bit zero must select DCT[1] / AC1");
});

test("fills masked records with a non-overlapping implicit AC tail", () => {
  const encoded = encodeDctFile(makePixels(16, 16), 16, 16, {
    preset: "9",
    quality: 97,
    coefficientCoding: "masked-tail-8x8",
  });
  const mcu = inspectDctMcu(encoded, 0);

  assert.equal(mcu.components.y.blocks.length, 4);
  for (const block of mcu.components.y.blocks) {
    assert.equal(block.encodingMode, "masked-tail");
    assert.equal(block.coefficientCount, 39);
    assert.equal(block.explicitAcCount + block.tailAcCount, 38);
    assert.equal(block.tailStart, 64 - block.tailAcCount);
  }
  assert.equal(encoded[HEADER_BYTES + 47] & 0xfc, 0, "48-byte reserve bits must stay zero");

  const invalidOverlap = encodeDctFile(makeConstantPixels(16, 16, 192), 16, 16, {
    preset: "6",
    quality: 97,
    coefficientCoding: "masked-tail-8x8",
  }).slice();
  invalidOverlap[HEADER_BYTES + 7] |= 1 << 5;
  assert.throws(() => inspectDctMcu(invalidOverlap, 0), /overlaps the implicit tail/);
});

test("uses four independent luma blocks at high rates and reads legacy files", () => {
  const source = makePixels(16, 16);
  const split = encodeDctFile(source, 16, 16, {
    preset: "6",
    quality: 97,
    coefficientCoding: "grouped-5-front",
  });
  const legacy = encodeDctFile(source, 16, 16, {
    preset: "6",
    quality: 97,
    splitLuma8x8: false,
    coefficientCoding: "grouped-5-front",
  });
  const splitInfo = inspectDctFile(split);
  const legacyInfo = inspectDctFile(legacy);
  const splitMcu = inspectDctMcu(split, 0);

  assert.equal(splitInfo.splitLuma8x8, true);
  assert.equal(legacyInfo.splitLuma8x8, false);
  assert.equal(split.length, legacy.length);
  assert.equal(splitMcu.components.y.blocks.length, 4);
  assert.equal(
    splitMcu.components.y.coefficientCount,
    splitMcu.components.y.blocks.reduce((total, block) => total + block.coefficientCount, 0)
  );

  const isolatedLookup = split.slice();
  const yBlockBytes = PRESETS["6"].yBytes / 4;
  isolatedLookup[HEADER_BYTES + yBlockBytes] = 0xf0;
  assert.doesNotThrow(() => sampleDctFilePixel(isolatedLookup, 0, 0));
  assert.throws(() => sampleDctFilePixel(isolatedLookup, 8, 0), /Invalid DCT component profile/);

  for (const file of [split, legacy]) {
    const decoded = decodeDctFile(file);
    for (const [x, y] of [[0, 0], [8, 0], [0, 8], [15, 15]]) {
      const sampled = sampleDctFilePixel(file, x, y);
      const offset = (y * 16 + x) * 4;
      assert.deepEqual(
        [sampled.r, sampled.g, sampled.b, sampled.a],
        Array.from(decoded.pixels.slice(offset, offset + 4))
      );
    }
  }
});

test("imports JPEG Huffman coefficients without an RGB encoder input", () => {
  const jpegBytes = fs.readFileSync(path.join(root, "assets/benchmark-jpegs/clipart-apple.jpg"));
  const jpeg = GpuJpegDecoder.parse(jpegBytes);
  const first = importJpegDctFile(jpeg, { preset: "6", quality: 72 });
  const second = importJpegDctFile(jpeg, { preset: "6", quality: 72 });
  const info = inspectDctFile(first);
  const decoded = decodeDctFile(first);

  assert.deepEqual(first, second);
  assert.equal(info.width, jpeg.width);
  assert.equal(info.height, jpeg.height);
  assert.equal(info.bytesPerMcu, PRESETS["6"].bytesPerMcu);
  assert.equal(info.splitLuma8x8, true);

  for (const [x, y] of [
    [0, 0],
    [Math.floor(info.width / 2), Math.floor(info.height / 2)],
    [info.width - 1, info.height - 1],
  ]) {
    const sampled = sampleDctFilePixel(first, x, y);
    const offset = (y * info.width + x) * 4;

    assert.deepEqual(
      [sampled.r, sampled.g, sampled.b, sampled.a],
      Array.from(decoded.pixels.slice(offset, offset + 4)),
      `imported JPEG pixel ${x},${y}`
    );
  }
});

test("samples every reconstructed pixel without decoding the complete image", () => {
  const width = 21;
  const height = 18;
  const source = makePixels(width, height);
  const encoded = encodeDctFile(source, width, height, { preset: "1", quality: 68 });
  const decoded = decodeDctFile(encoded);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sampled = sampleDctFilePixel(encoded, x, y);
      const offset = (y * width + x) * 4;

      assert.deepEqual(
        [sampled.r, sampled.g, sampled.b, sampled.a],
        Array.from(decoded.pixels.slice(offset, offset + 4)),
        `pixel ${x},${y}`
      );
    }
  }
});

test("encodes DCT files deterministically and exposes bounded MCU metadata", () => {
  const source = makePixels(16, 16);
  const first = encodeDctFile(source, 16, 16, { preset: "1.5", quality: 74 });
  const second = encodeDctFile(source, 16, 16, { preset: "1.5", quality: 74 });
  const mcu = inspectDctMcu(first, 0);

  assert.deepEqual(first, second);
  assert.equal(mcu.byteOffset, HEADER_BYTES);
  assert.equal(mcu.bytes, 48);
  assert.deepEqual(Object.keys(mcu.components), ["y", "cb", "cr"]);
  assert.ok(mcu.components.y.coefficientCount > mcu.components.cb.coefficientCount);
  assert.ok(mcu.components.y.scale >= 1 && mcu.components.y.scale <= 128);
});

test("uses adaptive skip coding by default while preserving grouped and legacy files", () => {
  const source = makeAlternatingPixels(16, 16);
  const expected = {
    "0.75": "skip-rle-equal-2",
    "1": "dual-scale-skip-equal-2",
    "1.5": "dual-scale-skip-front",
    "2": "dual-scale-skip-equal-2",
    "3": "dual-scale-skip-front",
    "4.5": "dual-scale-skip-front",
  };

  for (const [preset, coefficientCodingKey] of Object.entries(expected)) {
    const encoded = encodeDctFile(source, 16, 16, { preset, quality: 92 });
    const info = inspectDctFile(encoded);
    const mcu = inspectDctMcu(encoded, 0);
    const lumaRecords = mcu.components.y.blocks || [mcu.components.y];

    assert.equal(info.coefficientCodingKey, coefficientCodingKey);
    if (preset === "0.75") {
      assert.ok(lumaRecords.every((record) => record.encodingMode === "skip-rle"));
    } else {
      assert.ok(lumaRecords.every((record) => record.encodingMode === "dual-scale-skip"));
    }
  }

  const grouped = encodeDctFile(source, 16, 16, {
    preset: "1.5",
    quality: 92,
    coefficientCoding: "grouped-5-front",
  });
  assert.equal(inspectDctFile(grouped).coefficientCodingKey, "grouped-5-front");
  assert.equal(inspectDctMcu(grouped, 0).components.y.encodingMode, "grouped");

  const legacy = encodeDctFile(source, 16, 16, {
    preset: "1.5",
    quality: 92,
    coefficientCoding: "legacy",
  });
  assert.equal(inspectDctFile(legacy).coefficientCodingKey, "legacy");
  assert.equal(inspectDctMcu(legacy, 0).components.y.groupScaleIndices.length, 1);

  const library = encodeDctFile(source, 16, 16, {
    preset: "6",
    quality: 92,
    dctLibrary: true,
    librarySize: 1,
  });
  assert.equal(inspectDctFile(library).coefficientCodingKey, "grouped-5-front");
});

test("selects the lower-error high-rate coding without regressing RGB quality", () => {
  const source = makePixels(16, 16);

  for (const preset of ["6", "7.5", "9"]) {
    const grouped = encodeDctFile(source, 16, 16, {
      preset,
      quality: 97,
      coefficientCoding: "grouped-5-front",
    });
    const masked = encodeDctFile(source, 16, 16, {
      preset,
      quality: 97,
      coefficientCoding: "masked-tail-8x8",
    });
    const automatic = encodeDctFile(source, 16, 16, { preset, quality: 97 });
    const groupedError = calculateRgbError(source, decodeDctFile(grouped).pixels);
    const maskedError = calculateRgbError(source, decodeDctFile(masked).pixels);
    const automaticError = calculateRgbError(source, decodeDctFile(automatic).pixels);

    assert.equal(automaticError, Math.min(groupedError, maskedError));
    assert.equal(
      inspectDctFile(automatic).coefficientCodingKey,
      maskedError < groupedError ? "masked-tail-8x8" : "grouped-5-front"
    );
  }

  const tied = encodeDctFile(makeConstantPixels(16, 16, 128), 16, 16, {
    preset: "9",
    quality: 97,
  });
  assert.equal(inspectDctFile(tied).coefficientCodingKey, "grouped-5-front");
});

test("keeps the grouped fallback when skip coding does not reduce block error", () => {
  const source = new Uint8ClampedArray(16 * 16 * 4);
  for (let offset = 0; offset < source.length; offset += 4) {
    source[offset] = 128;
    source[offset + 1] = 128;
    source[offset + 2] = 128;
    source[offset + 3] = 255;
  }

  for (const preset of ["0.75", "1", "1.5", "2", "3", "4.5"]) {
    const encoded = encodeDctFile(source, 16, 16, { preset, quality: 92 });
    const mcu = inspectDctMcu(encoded, 0);
    const records = mcu.components.y.blocks || [mcu.components.y];
    assert.ok(records.every((record) => record.encodingMode === "grouped"));
  }
});

test("stores deterministic clustered DCT prototypes without losing coordinate access", () => {
  const width = 32;
  const height = 24;
  const source = makePixels(width, height);
  const options = {
    preset: "3",
    quality: 92,
    dctLibrary: true,
    librarySize: 3,
  };
  const first = encodeDctFile(source, width, height, options);
  const second = encodeDctFile(source, width, height, options);
  const info = inspectDctFile(first);
  const decoded = decodeDctFile(first);
  const mcu = inspectDctMcu(first, 0);

  assert.deepEqual(first, second);
  assert.equal(info.libraryEnabled, true);
  assert.equal(info.library.referenceCoding, "header");
  assert.equal(info.library.y.count, 3);
  assert.equal(info.library.cb.count, 3);
  assert.equal(info.library.cr.count, 3);
  assert.equal(first.length, HEADER_BYTES + info.payloadBytes + info.libraryBytes);
  assert.ok(mcu.components.y.blocks.every((block) => block.libraryIndex >= 0 && block.libraryIndex <= 3));

  for (const [x, y] of [[0, 0], [9, 7], [16, 15], [31, 23]]) {
    const sampled = sampleDctFilePixel(first, x, y);
    const offset = (y * width + x) * 4;
    assert.deepEqual(
      [sampled.r, sampled.g, sampled.b, sampled.a],
      Array.from(decoded.pixels.slice(offset, offset + 4)),
      `prototype-library pixel ${x},${y}`
    );
  }

  const tailReference = encodeDctFile(source, width, height, {
    ...options,
    librarySize: 4,
  });
  assert.equal(inspectDctFile(tailReference).library.referenceCoding, "tail");
});

test("keeps 16- and 32-entry sidecar libraries separate and directly addressable", () => {
  const width = 64;
  const height = 64;
  const source = makePixels(width, height);
  const options = {
    preset: "3",
    quality: 100,
    dctLibrary: true,
    librarySize: 32,
    libraryComponents: ["y"],
    libraryReferenceCoding: "sidecar",
    libraryFrequencySplit: 0.25,
    libraryClusterSamples: 64,
    libraryCandidateCount: 4,
  };
  const first = encodeDctFile(source, width, height, options);
  const second = encodeDctFile(source, width, height, options);
  const info = inspectDctFile(first);
  const decoded = decodeDctFile(first);

  assert.deepEqual(first, second);
  assert.equal(info.library.referenceCoding, "sidecar");
  assert.equal(info.library.frequencySplit, 0.25);
  assert.equal(info.library.y.count, 32);
  assert.equal(info.library.y.reference.bits, 6);
  assert.equal(info.library.cb.count, 0);
  assert.equal(info.library.cr.count, 0);

  for (const [x, y] of [[0, 0], [17, 29], [47, 33], [63, 63]]) {
    const sampled = sampleDctFilePixel(first, x, y);
    const offset = (y * width + x) * 4;
    assert.deepEqual(
      [sampled.r, sampled.g, sampled.b, sampled.a],
      Array.from(decoded.pixels.slice(offset, offset + 4)),
      `sidecar-library pixel ${x},${y}`
    );
  }

  const sixteen = encodeDctFile(source, width, height, { ...options, librarySize: 16 });
  assert.equal(inspectDctFile(sixteen).library.y.reference.bits, 5);
});

test("rejects invalid DCT prototype libraries and out-of-range references", () => {
  const source = makePixels(16, 16);
  const encoded = encodeDctFile(source, 16, 16, {
    preset: "1.5",
    quality: 92,
    dctLibrary: true,
    librarySize: 1,
  });
  const invalidReference = encoded.slice();

  invalidReference[HEADER_BYTES] = invalidReference[HEADER_BYTES] & 0x3f | 0xc0;

  assert.throws(() => inspectDctFile(encoded.slice(0, -1)), /Invalid DCTBS2 layout/);
  assert.throws(() => sampleDctFilePixel(invalidReference, 0, 0), /library index/);
});

test("decodes the extended quantizer range", () => {
  const source = makePixels(16, 16);
  const encoded = encodeDctFile(source, 16, 16, { preset: "2", quality: 75 });
  const extendedScale = encoded.slice();

  extendedScale[HEADER_BYTES] = (extendedScale[HEADER_BYTES] & 0xf0) | 4;

  assert.doesNotThrow(() => decodeDctFile(extendedScale));
  assert.equal(inspectDctMcu(extendedScale, 0).components.y.scale, 16);
});

test("finds an automatic quality and records the measured search", () => {
  const width = 16;
  const height = 16;
  const source = makePixels(width, height);
  const result = findBestDctQuality(source, width, height, { preset: "0.75", sampleMcuCount: 1 });
  const info = inspectDctFile(result.encoded);

  assert.ok(result.quality >= 1 && result.quality <= 100);
  assert.ok(result.candidateCount >= 19);
  assert.equal(info.autoQuality, true);
  assert.equal(info.quality, result.quality);
  assert.equal(info.searchCandidateCount, result.candidateCount);
  assert.deepEqual(result.decoded.pixels, decodeDctFile(result.encoded).pixels);
});

test("uses one full-image quality finalist by default", () => {
  const width = 32;
  const height = 32;
  const source = makePixels(width, height);
  const fastProgress = [];
  const fast = findBestDctQuality(source, width, height, {
    preset: "1.5",
    sampleMcuCount: 4,
    onProgress: (entry) => fastProgress.push(entry),
  });
  const exhaustive = findBestDctQuality(source, width, height, {
    preset: "1.5",
    sampleMcuCount: 4,
    finalistCount: 3,
  });
  const fullProgress = fastProgress.filter((entry) => entry.stage === "full");

  assert.equal(exhaustive.candidateCount, fast.candidateCount + 2);
  assert.ok(exhaustive.error <= fast.error);
  assert.ok(fullProgress.some((entry) => entry.phaseTotal === 4));
  assert.equal(fullProgress.at(-1).completed, fullProgress.at(-1).total);
  assert.throws(() => findBestDctQuality(source, width, height, {
    preset: "1.5",
    finalistCount: 0,
  }), /finalist count/);
});

test("reports fixed-quality encoding progress with and without a prototype library", () => {
  const width = 32;
  const height = 16;
  const source = makePixels(width, height);

  for (const dctLibrary of [false, true]) {
    const progress = [];
    encodeDctFile(source, width, height, {
      preset: "2",
      quality: 75,
      dctLibrary,
      librarySize: 3,
      onProgress: (entry) => progress.push(entry),
    });

    assert.ok(progress.length >= 2);
    assert.equal(progress[0].stage, "encode");
    assert.equal(progress[0].completed, 0);
    assert.equal(progress[0].quality, 75);
    assert.equal(progress.at(-1).completed, progress.at(-1).total);
    assert.ok(progress.every((entry, index) =>
      index === 0 || entry.completed >= progress[index - 1].completed
    ));
  }
});

test("rejects truncated files, invalid modes, and invalid coordinates", () => {
  const source = makePixels(16, 16);
  const encoded = encodeDctFile(source, 16, 16, { preset: "2", quality: 75 });
  const invalidMode = encoded.slice();
  const unsupportedFlags = encoded.slice();
  const invalidCoefficientCoding = encoded.slice();
  const splitLowRate = encoded.slice();
  const maskedLibrary = encodeDctFile(source, 16, 16, {
    preset: "6",
    quality: 75,
    coefficientCoding: "masked-tail-8x8",
  }).slice();

  invalidMode[12] = 0;
  invalidMode[13] = 0;
  invalidMode[14] = 0;
  invalidMode[15] = 0;
  unsupportedFlags[52] |= 8;
  invalidCoefficientCoding[53] = 15;
  splitLowRate[52] |= 2;
  maskedLibrary[52] |= 4;

  assert.throws(() => inspectDctFile(encoded.slice(0, -1)), /Invalid DCTBS2 layout/);
  assert.throws(() => inspectDctFile(invalidMode), /Unsupported DCTBS2/);
  assert.throws(() => inspectDctFile(unsupportedFlags), /Invalid DCTBS2 layout/);
  assert.throws(() => inspectDctFile(invalidCoefficientCoding), /Invalid DCTBS2 layout/);
  assert.throws(() => inspectDctFile(splitLowRate), /Invalid DCTBS2 layout/);
  assert.throws(() => inspectDctFile(maskedLibrary), /Invalid DCTBS2 layout/);
  assert.throws(() => sampleDctFilePixel(encoded, 16, 0), /coordinate is out of range/);
  assert.throws(() => encodeDctFile(source, 16, 16, { preset: "4" }), /Unsupported DCT preset/);
});

function makePixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;

      pixels[offset] = x * 17 + y * 3 & 255;
      pixels[offset + 1] = x * 5 + y * 19 & 255;
      pixels[offset + 2] = x * 11 + y * 13 & 255;
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

function makeAlternatingPixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = (x + y) % 2 === 0 ? 0 : 255;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

function makeConstantPixels(width, height, value) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function makeHorizontalAc1Pixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.round(128 + 96 * Math.cos(Math.PI * (2 * (x & 7) + 1) / 16));
      const offset = (y * width + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function calculateRgbError(left, right) {
  let total = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    total += (left[offset] - right[offset]) ** 2;
    total += (left[offset + 1] - right[offset + 1]) ** 2;
    total += (left[offset + 2] - right[offset + 2]) ** 2;
  }
  return total;
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
