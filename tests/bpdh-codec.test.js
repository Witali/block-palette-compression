"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { compressHybridImage } = require("../src/hybrid/bpdh-codec.js");
const dct420 = require("../src/hybrid/dct420.js");
const {
  MAGIC,
  VERSION,
  HEADER_BYTES,
  MODE_BPAL,
  MODE_DCT,
  encodeBpdhFile,
  decodeBpdhFile,
  sampleBpdhPixel,
} = require("../src/hybrid/bpdh-format.js");

test("selects BPAL for a sharp two-color block and DCT for a smooth block", () => {
  const width = 32;
  const height = 16;
  const source = createMixedSource(width, height);
  const settings = {
    mode: "auto",
    targetBitsPerPixel: 12,
    dctQualities: [70, 90],
    bpal: {
      localColorCount: 2,
      globalColorCount: 8,
      paletteCount: 1,
      refinementPasses: 0,
    },
  };
  const result = compressHybridImage(source, width, height, settings);
  const encoded = encodeBpdhFile(result);
  const decoded = decodeBpdhFile(encoded);
  const repeated = encodeBpdhFile(compressHybridImage(source, width, height, settings));

  assert.equal(String.fromCharCode(...encoded.slice(0, 4)), MAGIC);
  assert.equal(decoded.version, VERSION);
  assert.deepEqual(Array.from(result.modes), [MODE_BPAL, MODE_DCT]);
  assert.equal(result.bpalBlockCount, 1);
  assert.equal(result.dctBlockCount, 1);
  assert.equal(result.storage.modeMapBytes, 1);
  assert.equal(result.storage.withinTarget, true);
  assert.ok(result.psnr > 40);
  assert.equal(encoded.length, result.storage.totalBytes);
  assert.deepEqual(Array.from(repeated), Array.from(encoded));
  assert.deepEqual(Array.from(decoded.modes), Array.from(result.modes));
  assert.deepEqual(Array.from(decoded.pixels), Array.from(result.pixels));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const expected = Array.from(decoded.pixels.slice(offset, offset + 4));
      const first = sampleBpdhPixel(decoded, x, y);
      const second = sampleBpdhPixel(decoded, x, y);

      assert.deepEqual([first.r, first.g, first.b, first.a], expected);
      assert.deepEqual(second, first);
    }
  }
});

test("round-trips a pure DCT image with partial edge macroblocks", () => {
  const width = 19;
  const height = 17;
  const source = createGradientSource(width, height);
  const result = compressHybridImage(source, width, height, {
    mode: "dct",
    targetBitsPerPixel: 30,
    dctQuality: 85,
    bpal: {
      localColorCount: 2,
      globalColorCount: 8,
      paletteCount: 1,
    },
  });
  const encoded = encodeBpdhFile(result);
  const decoded = decodeBpdhFile(encoded);

  assert.equal(result.bpalBlockCount, 0);
  assert.equal(result.dctBlockCount, 4);
  assert.equal(result.storage.paletteBytes, 0);
  assert.equal(result.storage.modeMapBytes, 0);
  assert.equal(result.storage.quantizationTableBytes, 128);
  assert.deepEqual(Array.from(decoded.pixels), Array.from(result.pixels));
});

test("round-trips a pure sparse BPAL payload without DCT tables", () => {
  const width = 17;
  const height = 9;
  const source = createTwoColorSource(width, height);
  const result = compressHybridImage(source, width, height, {
    mode: "bpal",
    targetBitsPerPixel: 10,
    bpal: {
      localColorCount: 2,
      globalColorCount: 8,
      paletteCount: 1,
      refinementPasses: 0,
    },
  });
  const encoded = encodeBpdhFile(result);
  const decoded = decodeBpdhFile(encoded);

  assert.equal(result.dctBlockCount, 0);
  assert.equal(result.storage.quantizationTableBytes, 0);
  assert.equal(result.storage.modeMapBytes, 0);
  assert.deepEqual(Array.from(decoded.pixels), Array.from(result.pixels));
});

test("rejects invalid BPDH magic and truncated section data", () => {
  const source = createGradientSource(16, 16);
  const encoded = encodeBpdhFile(compressHybridImage(source, 16, 16, {
    mode: "dct",
    targetBitsPerPixel: 20,
    dctQuality: 70,
  }));
  const invalidMagic = encoded.slice();

  invalidMagic[0] = 0;

  assert.throws(() => decodeBpdhFile(invalidMagic), /Invalid BPDH magic/);
  assert.throws(
    () => decodeBpdhFile(encoded.slice(0, -1)),
    /file size does not match/
  );
  assert.ok(encoded.length > HEADER_BYTES);
});

test("keeps the normative fixed-point DCT reconstruction byte-exact", () => {
  const width = 16;
  const height = 16;
  const source = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;

      source[offset] = (x * 17 + y * 3) & 255;
      source[offset + 1] = (x * 5 + y * 11) & 255;
      source[offset + 2] = (x * 13 + y * 7) & 255;
      source[offset + 3] = 255;
    }
  }

  const tables = dct420.createQuantizationTables(70);
  const blocks = dct420.quantizeMacroblock(
    dct420.transformMacroblock(source, width, height, 0, 0),
    tables
  );
  const reconstructed = dct420.decodeMacroblock(blocks, tables);
  const coefficientHash = sha256(blocks.flatMap((block) => Array.from(block)).join(","));
  const pixelHash = sha256(Buffer.from(reconstructed));

  assert.equal(
    coefficientHash,
    "77af8a036bc17220ec891b9d0a2478e7a3d388c3b7d5937ee58491fa9bba6912"
  );
  assert.equal(
    pixelHash,
    "d962facfc7087ffea2f14016ab68f6bff48318da2e5651f259a7efbd992b2218"
  );
});

function createMixedSource(width, height) {
  const values = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;

      if (x < 16) {
        const bright = (x + y) % 2 === 1;

        values[offset] = bright ? 255 : 0;
        values[offset + 1] = bright ? 32 : 0;
        values[offset + 2] = bright ? 32 : 0;
      } else {
        const value = Math.round((x - 16) * 255 / 15);

        values[offset] = value;
        values[offset + 1] = value;
        values[offset + 2] = value;
      }

      values[offset + 3] = 255;
    }
  }

  return values;
}

function createGradientSource(width, height) {
  const values = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;

      values[offset] = Math.round(x * 255 / Math.max(1, width - 1));
      values[offset + 1] = Math.round(y * 255 / Math.max(1, height - 1));
      values[offset + 2] = Math.round((x + y) * 255 / Math.max(1, width + height - 2));
      values[offset + 3] = 255;
    }
  }

  return values;
}

function createTwoColorSource(width, height) {
  const values = new Uint8ClampedArray(width * height * 4);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const first = pixel % 2 === 0;

    values[offset] = first ? 20 : 220;
    values[offset + 1] = first ? 40 : 180;
    values[offset + 2] = first ? 60 : 140;
    values[offset + 3] = 255;
  }

  return values;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
