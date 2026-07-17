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
  calculateSquaredError,
  getCachedDctEncodingResult,
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
    assert.equal(info.chroma420, true);
    assert.equal(info.chromaSubsampling, "4:2:0");
    assert.equal(info.chromaHeight, 8);
  }
});

test("writes 4:2:0 by default and keeps legacy 4:2:2 files readable", () => {
  const width = 19;
  const height = 17;
  const source = makePixels(width, height);
  const encoded420 = encodeDctFile(source, width, height, { preset: "1.5", quality: 82 });
  const encoded422 = encodeDctFile(source, width, height, {
    preset: "1.5",
    quality: 82,
    chromaSubsampling: "4:2:2",
  });
  const info420 = inspectDctFile(encoded420);
  const info422 = inspectDctFile(encoded422);

  assert.equal(new DataView(encoded420.buffer, encoded420.byteOffset).getUint32(52, true) & 8, 8);
  assert.equal(new DataView(encoded422.buffer, encoded422.byteOffset).getUint32(52, true) & 8, 0);
  assert.equal(info420.chromaSubsampling, "4:2:0");
  assert.equal(info420.chromaHeight, 8);
  assert.equal(info422.chromaSubsampling, "4:2:2");
  assert.equal(info422.chromaHeight, 16);
  assert.equal(encoded420.length, encoded422.length, "subsampling must not change fixed MCU size");

  const red = new Uint8ClampedArray(16 * 16 * 4);
  for (let offset = 0; offset < red.length; offset += 4) {
    red[offset] = 255;
    red[offset + 3] = 255;
  }
  const decodedRed = decodeDctFile(encodeDctFile(red, 16, 16, {
    preset: "9",
    quality: 100,
    coefficientCoding: "grouped-5-front",
  })).pixels;
  assert.ok(decodedRed[0] > 180 && decodedRed[1] < 80 && decodedRed[2] < 80);

  for (const encoded of [encoded420, encoded422]) {
    const decoded = decodeDctFile(encoded);
    for (const [x, y] of [[0, 0], [1, 1], [8, 8], [18, 16]]) {
      const sampled = sampleDctFilePixel(encoded, x, y);
      const offset = (y * width + x) * 4;
      assert.deepEqual(
        [sampled.r, sampled.g, sampled.b, sampled.a],
        Array.from(decoded.pixels.slice(offset, offset + 4))
      );
    }
  }
  assert.throws(
    () => encodeDctFile(source, width, height, { chromaSubsampling: "4:1:1" }),
    /Unsupported DCT chroma subsampling/
  );
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

  const ac2 = encodeDctFile(makeVerticalAc1Pixels(16, 16), 16, 16, {
    preset: "6",
    quality: 97,
    coefficientCoding: "masked-tail-8x8",
  });
  const ac2View = new DataView(ac2.buffer, ac2.byteOffset + HEADER_BYTES);
  assert.equal(ac2View.getUint32(0, true) & 2, 2, "mask bit one must select DCT[8] / AC2");
  assert.equal(inspectDctFile(ac2).zigzagOrder, true);

  const legacyOrder = encodeDctFile(makeVerticalAc1Pixels(16, 16), 16, 16, {
    preset: "6",
    quality: 97,
    coefficientCoding: "masked-tail-8x8",
    zigzagOrder: false,
  });
  const legacyView = new DataView(
    legacyOrder.buffer,
    legacyOrder.byteOffset + HEADER_BYTES
  );
  assert.equal(legacyView.getUint32(0, true) & (1 << 7), 1 << 7);
  assert.equal(inspectDctFile(legacyOrder).zigzagOrder, false);
  assert.equal(decodeDctFile(legacyOrder).pixels.length, 16 * 16 * 4);
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
  for (const component of [mcu.components.cb, mcu.components.cr]) {
    assert.equal(component.encodingMode, "masked-tail");
    assert.equal(component.coefficientCount, 39);
    assert.equal(component.explicitAcCount + component.tailAcCount, 38);
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

test("uses two implicit low-frequency AC values to fit 39 AC slots in 48 bytes", () => {
  const encoded = encodeDctFile(makePixels(16, 16), 16, 16, {
    preset: "9",
    quality: 97,
    coefficientCoding: "masked-tail-implicit2-48",
  });
  const info = inspectDctFile(encoded);
  const mcu = inspectDctMcu(encoded, 0);

  assert.equal(info.coefficientCodingKey, "masked-tail-implicit2-48");
  for (const block of mcu.components.y.blocks) {
    assert.equal(block.encodingMode, "masked-tail-implicit2");
    assert.equal(block.implicitAcCount, 2);
    assert.equal(block.coefficientCount, 40);
    assert.equal(block.implicitAcCount + block.explicitAcCount + block.tailAcCount, 39);
    assert.equal(block.tailStart, 64 - block.tailAcCount);
  }
  for (const component of [mcu.components.cb, mcu.components.cr]) {
    assert.equal(component.encodingMode, "masked-tail-implicit2");
    assert.equal(component.implicitAcCount, 2);
    assert.equal(component.coefficientCount, 40);
  }

  const decoded = decodeDctFile(encoded);
  assert.equal(decoded.pixels.length, 16 * 16 * 4);

  const implicitAc1 = encodeDctFile(makeHorizontalAc1Pixels(16, 16), 16, 16, {
    preset: "9",
    quality: 97,
    coefficientCoding: "masked-tail-implicit2-48",
  });
  for (let byte = 0; byte < 7; byte += 1) {
    assert.equal(implicitAc1[HEADER_BYTES + byte], 0, "DCT[1] must not consume a mask bit");
  }
  assert.equal(implicitAc1[HEADER_BYTES + 7] & 0x0f, 0);
  assert.notEqual(implicitAc1[HEADER_BYTES + 9], 0, "implicit DCT[1] value must be stored");

  const groupedFallback = encodeDctFile(makePixels(16, 16), 16, 16, {
    preset: "6",
    quality: 97,
    coefficientCoding: "grouped-5-front",
  });
  const implicitFallback = encodeDctFile(makePixels(16, 16), 16, 16, {
    preset: "6",
    quality: 97,
    coefficientCoding: "masked-tail-implicit2-48",
  });
  assert.deepEqual(
    implicitFallback.slice(HEADER_BYTES),
    groupedFallback.slice(HEADER_BYTES),
    "non-48-byte records must keep grouped payload semantics"
  );
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

test("maps matching JPEG 4:2:0 blocks directly and retains transformed fallbacks", () => {
  const jpegBytes = fs.readFileSync(path.join(root, "assets/stone-texture-small.jpg"));
  const jpeg = GpuJpegDecoder.parse(jpegBytes);
  const direct = importJpegDctFile(jpeg, {
    preset: "6",
    quality: 72,
    coefficientCoding: "grouped-5-front",
  });
  const transformed = importJpegDctFile(jpeg, {
    preset: "6",
    quality: 72,
    coefficientCoding: "grouped-5-front",
    directJpegCoefficients: false,
  });

  assert.notDeepEqual(direct, transformed);
  assert.equal(decodeDctFile(direct).width, jpeg.width);
  assert.equal(decodeDctFile(direct).height, jpeg.height);

  const merged = importJpegDctFile(jpeg, { preset: "2", quality: 72 });
  const mergedFallback = importJpegDctFile(jpeg, {
    preset: "2",
    quality: 72,
    directJpegCoefficients: false,
  });
  assert.deepEqual(merged, mergedFallback);

  const chroma422 = importJpegDctFile(jpeg, {
    preset: "6",
    quality: 72,
    chromaSubsampling: "4:2:2",
  });
  const chroma422Fallback = importJpegDctFile(jpeg, {
    preset: "6",
    quality: 72,
    chromaSubsampling: "4:2:2",
    directJpegCoefficients: false,
  });
  assert.deepEqual(chroma422, chroma422Fallback);
});

test("reuses the selected JPEG import preview after high-rate comparison", () => {
  const jpegBytes = fs.readFileSync(path.join(root, "assets/benchmark-jpegs/clipart-apple.jpg"));
  const jpeg = GpuJpegDecoder.parse(jpegBytes);
  const reference = decodeDctFile(importJpegDctFile(jpeg, {
    preset: "6",
    quality: 72,
    coefficientCoding: "grouped-5-front",
  })).pixels;
  const encoded = importJpegDctFile(jpeg, {
    preset: "6",
    quality: 72,
    referencePixels: reference,
  });
  const cached = getCachedDctEncodingResult(encoded);

  assert.ok(cached);
  assert.deepEqual(cached.decoded.pixels, decodeDctFile(encoded).pixels);
  assert.equal(
    cached.squaredError,
    calculateSquaredError(reference, cached.decoded.pixels)
  );
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
  assert.equal(mcu.components.y.coefficients.length, 256);
  assert.equal(mcu.components.cb.coefficients.length, 64);
  assert.equal(mcu.components.cr.coefficients.length, 64);
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
  const expectedLumaTailSlots = {
    "0.75": 1,
    "1": 1,
    "1.5": 1,
    "2": 2,
    "3": 2,
    "4.5": 1,
  };

  for (const [preset, coefficientCodingKey] of Object.entries(expected)) {
    const encoded = encodeDctFile(source, 16, 16, {
      preset,
      quality: 92,
      componentBudget: "fixed",
    });
    const info = inspectDctFile(encoded);
    const mcu = inspectDctMcu(encoded, 0);
    const lumaRecords = mcu.components.y.blocks || [mcu.components.y];

    assert.equal(info.coefficientCodingKey, coefficientCodingKey);
    if (preset === "0.75") {
      assert.ok(lumaRecords.every((record) => record.encodingMode === "skip-rle"));
    } else {
      assert.ok(lumaRecords.every((record) => record.encodingMode === "dual-scale-skip"));
    }
    assert.ok(lumaRecords.every((record) => record.tailAcCount === expectedLumaTailSlots[preset]));
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

test("uses spare skip-record bits for beneficial fine AC coefficients", () => {
  const width = 16;
  const height = 16;
  const source = new Uint8ClampedArray(width * height * 4);
  let randomState = 0x6d2b79f5;

  for (let offset = 0; offset < source.length; offset += 4) {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    source[offset] = randomState & 255;
    source[offset + 1] = randomState >>> 8 & 255;
    source[offset + 2] = randomState >>> 16 & 255;
    source[offset + 3] = 255;
  }

  const skipBlocks = [];
  for (const preset of ["0.75", "1", "1.5", "2", "3", "4.5"]) {
    const encoded = encodeDctFile(source, width, height, {
      preset,
      quality: 100,
      componentBudget: "fixed",
    });
    const components = inspectDctMcu(encoded, 0).components;
    for (const component of Object.values(components)) {
      const records = component.blocks || [component];
      skipBlocks.push(...records.filter((block) => block.tailAcCount !== undefined));
    }
  }

  assert.ok(skipBlocks.length > 0);
  assert.ok(skipBlocks.every((block) => block.tailAcCount > 0));
  assert.ok(skipBlocks.some((block) => block.tailStoredCoefficientCount > 0));
});

test("selects the best fixed-size Y/C allocation without regressing RGB quality", () => {
  const width = 16;
  const height = 16;
  const source = makePixels(width, height);

  for (const preset of ["0.75", "1", "1.5", "2", "3"]) {
    const fixed = encodeDctFile(source, width, height, {
      preset,
      quality: 88,
      componentBudget: "fixed",
    });
    const fast = encodeDctFile(source, width, height, {
      preset,
      quality: 88,
      componentBudget: "fast",
    });
    const expanded = encodeDctFile(source, width, height, {
      preset,
      quality: 88,
      componentBudget: "expanded",
    });
    const fixedError = calculateSquaredError(source, decodeDctFile(fixed).pixels);
    const fastError = calculateSquaredError(source, decodeDctFile(fast).pixels);
    const expandedError = calculateSquaredError(source, decodeDctFile(expanded).pixels);
    const info = inspectDctFile(expanded);

    assert.equal(fixed.byteLength, fast.byteLength);
    assert.equal(fast.byteLength, expanded.byteLength);
    assert.ok(fastError <= fixedError, `${preset} bpp fast adaptive allocation regressed`);
    assert.ok(expandedError <= fastError, `${preset} bpp expanded allocation regressed`);
    assert.equal(info.yBytes + info.cbBytes + info.crBytes, info.bytesPerMcu);
    assert.ok(info.yBytes >= 3 && info.cbBytes >= 3 && info.crBytes >= 3);
    if (info.splitLuma8x8) assert.equal(info.yBytes % 4, 0);
  }
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
    const legacyMasked = encodeDctFile(source, 16, 16, {
      preset,
      quality: 97,
      coefficientCoding: "masked-tail-8x8",
      zigzagOrder: false,
    });
    const implicit = preset === "9" ? encodeDctFile(source, 16, 16, {
      preset,
      quality: 97,
      coefficientCoding: "masked-tail-implicit2-48",
    }) : null;
    const legacyImplicit = preset === "9" ? encodeDctFile(source, 16, 16, {
      preset,
      quality: 97,
      coefficientCoding: "masked-tail-implicit2-48",
      zigzagOrder: false,
    }) : null;
    const automatic = encodeDctFile(source, 16, 16, { preset, quality: 97 });
    const groupedError = calculateRgbError(source, decodeDctFile(grouped).pixels);
    const maskedError = calculateRgbError(source, decodeDctFile(masked).pixels);
    const legacyMaskedError = calculateRgbError(
      source, decodeDctFile(legacyMasked).pixels
    );
    const implicitError = implicit
      ? calculateRgbError(source, decodeDctFile(implicit).pixels) : Infinity;
    const legacyImplicitError = legacyImplicit
      ? calculateRgbError(source, decodeDctFile(legacyImplicit).pixels) : Infinity;
    const automaticError = calculateRgbError(source, decodeDctFile(automatic).pixels);
    const expected = [
      ["grouped-5-front", groupedError],
      ["masked-tail-8x8", maskedError],
      ["masked-tail-8x8", legacyMaskedError],
      ["masked-tail-implicit2-48", implicitError],
      ["masked-tail-implicit2-48", legacyImplicitError],
    ].reduce((best, candidate) => candidate[1] < best[1] ? candidate : best);

    assert.equal(automaticError, expected[1]);
    assert.equal(inspectDctFile(automatic).coefficientCodingKey, expected[0]);
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
  assert.equal(info.zigzagOrder, false);
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
    componentBudget: "fixed",
    sampleMcuCount: 4,
    onProgress: (entry) => fastProgress.push(entry),
  });
  const exhaustive = findBestDctQuality(source, width, height, {
    preset: "1.5",
    componentBudget: "fixed",
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
      componentBudget: "fixed",
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
  unsupportedFlags[52] |= 32;
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

function makeVerticalAc1Pixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.round(128 + 96 * Math.cos(Math.PI * (2 * (y & 7) + 1) / 16));
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
