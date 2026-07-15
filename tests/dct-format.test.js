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
  assert.equal(Object.keys(PRESETS).length, 7);

  for (const preset of ["0.75", "1", "1.5", "2", "3", "4.5", "6"]) {
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
});

test("imports JPEG Huffman coefficients without an RGB encoder input", () => {
  const jpegBytes = fs.readFileSync(path.join(root, "assets/benchmark-jpegs/clipart-apple.jpg"));
  const jpeg = GpuJpegDecoder.parse(jpegBytes);
  const first = importJpegDctFile(jpeg, { preset: "1.5", quality: 72 });
  const second = importJpegDctFile(jpeg, { preset: "1.5", quality: 72 });
  const info = inspectDctFile(first);
  const decoded = decodeDctFile(first);

  assert.deepEqual(first, second);
  assert.equal(info.width, jpeg.width);
  assert.equal(info.height, jpeg.height);
  assert.equal(info.bytesPerMcu, PRESETS["1.5"].bytesPerMcu);

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
  assert.ok(mcu.components.y.scale >= 1 && mcu.components.y.scale <= 8);
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

test("rejects truncated files, invalid modes, and invalid coordinates", () => {
  const source = makePixels(16, 16);
  const encoded = encodeDctFile(source, 16, 16, { preset: "2", quality: 75 });
  const invalidMode = encoded.slice();

  invalidMode[12] = 0;
  invalidMode[13] = 0;
  invalidMode[14] = 0;
  invalidMode[15] = 0;

  assert.throws(() => inspectDctFile(encoded.slice(0, -1)), /Invalid DCTBS2 layout/);
  assert.throws(() => inspectDctFile(invalidMode), /Unsupported DCTBS2/);
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

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
