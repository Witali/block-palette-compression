"use strict";

const assert = require("node:assert/strict");
const { compressImage } = require("../src/palette/block-palette-codec.js");
const {
  MAGIC,
  VERSION,
  HEADER_BYTES,
  encodeBlockPaletteFile,
  decodeBlockPaletteFile,
  sampleBlockPaletteFilePixel,
  getBlockPaletteFileLayout,
} = require("../src/palette/block-palette-format.js");

test("round-trips an explicit RGB888 block-palette image through BPAL v5", () => {
  const values = [];

  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      values.push([x * 45, y * 80, (x + y) * 30, 255]);
    }
  }

  const result = compressImage(pixels(values), 5, 3, {
    blockSize: 4,
    localColorCount: 4,
    globalColorCount: 8,
    paletteColorBits: 24,
    colorSpace: "rgb",
  });
  const encoded = encodeBlockPaletteFile(result);
  const decoded = decodeBlockPaletteFile(encoded);
  const layout = getBlockPaletteFileLayout(result);

  assert.equal(String.fromCharCode(...encoded.slice(0, 4)), MAGIC);
  assert.equal(decoded.version, VERSION);
  assert.equal(decoded.width, result.width);
  assert.equal(decoded.height, result.height);
  assert.equal(decoded.blockSize, result.blockSize);
  assert.equal(decoded.localColorCount, result.localColorCount);
  assert.equal(decoded.globalColorCount, result.globalColorCount);
  assert.equal(decoded.paletteColorBits, result.paletteColorBits);
  assert.equal(decoded.paletteMode, "explicit");
  assert.deepEqual(Array.from(decoded.blockPaletteIndices), Array.from(result.blockPaletteIndices));
  assert.deepEqual(Array.from(decoded.pixelIndices), Array.from(result.pixelIndices));
  assert.deepEqual(Array.from(decoded.pixels), Array.from(result.pixels));
  assert.equal(encoded.length, layout.totalBytes);
});

test("stores scalar palette entries in eight bits", () => {
  const image = {
    width: 2,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 4,
    paletteColorBits: 24,
    channelMode: "scalar",
    palette: [
      { r: 17, g: 91, b: 203 },
      { r: 240, g: 0, b: 0 },
      { r: 0, g: 0, b: 0 },
      { r: 0, g: 0, b: 0 },
    ],
    blockPaletteIndices: new Uint16Array([0, 1]),
    pixelIndices: new Uint8Array([0, 1, 1, 0]),
  };
  const layout = getBlockPaletteFileLayout(image);
  const encoded = encodeBlockPaletteFile(image);
  const decoded = decodeBlockPaletteFile(encoded);

  assert.equal(layout.globalPaletteBits, 32);
  assert.equal(layout.packedPalettes, false);
  assert.equal(layout.totalBytes, 19);
  assert.equal(encoded[13] & 0x0f, 4);
  assert.equal(decoded.channelMode, "scalar");
  assert.deepEqual(decoded.palette[0], { r: 17, g: 17, b: 17, hex: "#111111" });
  assert.deepEqual(sampleBlockPaletteFilePixel(encoded, 0, 0), decoded.palette[0]);
  assert.deepEqual(sampleBlockPaletteFilePixel(encoded, 1, 0), decoded.palette[1]);
  assert.deepEqual(Array.from(decoded.pixels.slice(0, 8)), [
    17, 17, 17, 255, 240, 240, 240, 255,
  ]);
  const invalidPackedScalar = encoded.slice();
  invalidPackedScalar[13] |= 1;
  assert.throws(
    () => decodeBlockPaletteFile(invalidPackedScalar),
    /Packed BPAL palettes require explicit RGB mode/
  );
});

test("omits pixel indices when every block pixel has its own color entry", () => {
  const values = Array.from({ length: 15 }, (_, index) => [
    index * 17,
    255 - index * 13,
    index * 7,
    255,
  ]);
  const result = compressImage(pixels(values), 5, 3, {
    blockSize: 4,
    localColorCount: 16,
    globalColorCount: 16,
    paletteColorBits: 24,
    colorSpace: "rgb",
  });
  const layout = getBlockPaletteFileLayout(result);
  const encoded = encodeBlockPaletteFile(result);
  const decoded = decodeBlockPaletteFile(encoded);
  const expectedPixelIndices = [];

  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      expectedPixelIndices.push(y % 4 * 4 + x % 4);
    }
  }

  assert.equal(layout.directPixelColors, true);
  assert.equal(layout.pixelDataBits, 0);
  assert.equal(layout.payloadBits, 512);
  assert.equal(encoded.length, HEADER_BYTES + 64);
  assert.equal(encoded[13] & 0x0f, 0);
  assert.equal(decoded.directPixelColors, true);
  assert.deepEqual(Array.from(decoded.pixelIndices), expectedPixelIndices);
  assert.deepEqual(Array.from(decoded.pixels), Array.from(result.pixels));
});

test("packs adjacent BPAL payload sections without byte alignment", () => {
  const source = pixels([
    [123, 201, 77, 255], [123, 201, 77, 255],
    [123, 201, 77, 255], [123, 201, 77, 255],
  ]);
  const result = compressImage(source, 2, 2, {
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 4,
    paletteColorBits: 16,
    colorSpace: "rgb",
  });
  const layout = getBlockPaletteFileLayout(result);
  const encoded = encodeBlockPaletteFile(result);
  const decoded = decodeBlockPaletteFile(encoded);

  assert.equal(layout.globalPaletteBits, 64);
  assert.equal(layout.blockPaletteBits, 4);
  assert.equal(layout.pixelDataBits, 4);
  assert.equal(layout.payloadBits, 72);
  assert.equal(layout.payloadBytes, 9);
  assert.equal(layout.headerBytes, HEADER_BYTES);
  assert.equal(layout.totalBytes, 23);
  assert.deepEqual(Array.from(decoded.pixels), Array.from(result.pixels));
});

test("continues to reconstruct legacy RGB-vector palettes", () => {
  const image = createLegacyVectorImage("rgb");
  const layout = getBlockPaletteFileLayout(image);
  const encoded = encodeBlockPaletteFile(image);
  const decoded = decodeBlockPaletteFile(encoded);

  assert.equal(decoded.paletteMode, "vector");
  assert.equal(decoded.vectorColorSpace, "rgb");
  assert.equal(decoded.paletteVectorCount, 1);
  assert.deepEqual(decoded.paletteVectors, image.paletteVectors);
  assert.equal(layout.globalPaletteBits, 2 * 24);
  assert.deepEqual(Array.from(decoded.pixels), [
    0, 0, 0, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255,
  ]);
});

test("round-trips four global palettes and per-block palette selectors", () => {
  const palette = [];
  const paletteStarts = [
    [{ r: 255, g: 0, b: 0 }, { r: 128, g: 0, b: 0 }],
    [{ r: 0, g: 255, b: 0 }, { r: 0, g: 128, b: 0 }],
    [{ r: 0, g: 0, b: 255 }, { r: 0, g: 0, b: 128 }],
    [{ r: 255, g: 255, b: 0 }, { r: 128, g: 128, b: 0 }],
  ];

  for (const colors of paletteStarts) {
    palette.push(...colors, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 });
  }

  const image = {
    width: 4,
    height: 4,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 4,
    paletteCount: 4,
    paletteColorBits: 24,
    palette,
    blockPaletteSelectors: new Uint8Array([0, 1, 2, 3]),
    blockPaletteIndices: new Uint16Array([0, 1, 0, 1, 0, 1, 0, 1]),
    pixelIndices: new Uint8Array([
      0, 1, 0, 1,
      1, 0, 1, 0,
      0, 1, 0, 1,
      1, 0, 1, 0,
    ]),
  };
  const layout = getBlockPaletteFileLayout(image);
  const encoded = encodeBlockPaletteFile(image);
  const decoded = decodeBlockPaletteFile(encoded);

  assert.equal(decoded.version, VERSION);
  assert.equal(decoded.paletteCount, 4);
  assert.equal(decoded.paletteIndexBits, 2);
  assert.deepEqual(Array.from(decoded.blockPaletteSelectors), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(decoded.blockPaletteIndices), Array.from(image.blockPaletteIndices));
  assert.equal(layout.globalPaletteBits, 4 * 4 * 24);
  assert.equal(layout.blockPaletteSelectorBits, 4 * 2);
  assert.deepEqual(Array.from(decoded.pixels.slice(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(decoded.pixels.slice(2 * 4, 3 * 4)), [0, 255, 0, 255]);
  assert.deepEqual(Array.from(decoded.pixels.slice(8 * 4, 9 * 4)), [0, 0, 255, 255]);
  assert.deepEqual(Array.from(decoded.pixels.slice(10 * 4, 11 * 4)), [255, 255, 0, 255]);
});

test("round-trips 128 global palettes with seven-bit block selectors", () => {
  const paletteCount = 128;
  const blockCount = 128;
  const palette = Array.from({ length: paletteCount * 2 }, (_, index) => ({
    r: index & 255,
    g: index * 3 & 255,
    b: index * 7 & 255,
  }));
  const image = {
    width: 32,
    height: 16,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 2,
    paletteCount,
    paletteColorBits: 24,
    palette,
    blockPaletteSelectors: Uint8Array.from({ length: blockCount }, (_, index) => index),
    blockPaletteIndices: Uint16Array.from({ length: blockCount * 2 }, (_, index) => index % 2),
    pixelIndices: Uint8Array.from({ length: 32 * 16 }, (_, index) => index % 2),
  };
  const layout = getBlockPaletteFileLayout(image);
  const decoded = decodeBlockPaletteFile(encodeBlockPaletteFile(image));

  assert.equal(decoded.version, VERSION);
  assert.equal(decoded.paletteCount, 128);
  assert.equal(decoded.paletteIndexBits, 7);
  assert.deepEqual(
    Array.from(decoded.blockPaletteSelectors),
    Array.from(image.blockPaletteSelectors)
  );
  assert.equal(layout.blockPaletteSelectorBits, blockCount * 7);
});

test("rejects BPAL shared palettes larger than 256 colors", () => {
  const palette = Array.from({ length: 4096 }, (_, index) => ({
    r: index & 255,
    g: index >> 4 & 255,
    b: index >> 6 & 255,
  }));
  const image = {
    width: 2,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 4096,
    paletteColorBits: 24,
    palette,
    blockPaletteIndices: new Uint16Array([0, 4095]),
    pixelIndices: new Uint8Array([0, 1, 1, 0]),
  };
  assert.throws(
    () => encodeBlockPaletteFile(image),
    /BPAL globalColorCount must be a power of two from 2 to 256/
  );
});

test("losslessly packs narrow shared palettes into independent delta records", () => {
  const paletteCount = 8;
  const globalColorCount = 64;
  const palette = Array.from({ length: paletteCount * globalColorCount }, (_, index) => {
    const paletteIndex = Math.floor(index / globalColorCount);
    const local = index % globalColorCount;
    return {
      r: 20 + paletteIndex * 20 + (local & 15),
      g: 30 + paletteIndex * 10 + (local >> 2 & 15),
      b: 40 + paletteIndex * 8 + (local >> 1 & 15),
    };
  });
  const image = {
    width: 16,
    height: 16,
    blockSize: 4,
    localColorCount: 4,
    globalColorCount,
    paletteCount,
    paletteColorBits: 24,
    palette,
    blockPaletteSelectors: Uint8Array.from({ length: 16 }, (_, index) => index % paletteCount),
    blockPaletteIndices: Uint16Array.from({ length: 16 * 4 }, (_, index) => index % globalColorCount),
    pixelIndices: Uint8Array.from({ length: 16 * 16 }, (_, index) => index % 4),
  };
  const layout = getBlockPaletteFileLayout(image);
  const encoded = encodeBlockPaletteFile(image);
  const decoded = decodeBlockPaletteFile(encoded);

  assert.equal(layout.packedPalettes, true);
  assert.equal(encoded[13] & 1, 1);
  assert.ok(layout.packedPaletteBytes < paletteCount * globalColorCount * 3);
  assert.deepEqual(decoded.palette, palette.map((color) => ({
    ...color,
    hex: `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
  })));
  assert.deepEqual(Array.from(decoded.pixels), Array.from(reconstructWithSampler(encoded, image.width, image.height)));
});

test("uses the default single palette when calculating packed layout", () => {
  const globalColorCount = 64;
  const image = {
    width: 16,
    height: 16,
    blockSize: 4,
    localColorCount: 4,
    globalColorCount,
    paletteColorBits: 24,
    palette: Array.from({ length: globalColorCount }, (_, index) => ({
      r: 20 + (index & 15),
      g: 30 + (index >> 2 & 15),
      b: 40 + (index >> 1 & 15),
    })),
    blockPaletteIndices: Uint16Array.from({ length: 16 * 4 }, (_, index) =>
      index % globalColorCount
    ),
    pixelIndices: Uint8Array.from({ length: 16 * 16 }, (_, index) => index % 4),
  };
  const layout = getBlockPaletteFileLayout(image);
  const encoded = encodeBlockPaletteFile(image);

  assert.equal(layout.packedPalettes, true);
  assert.equal(layout.totalBytes, encoded.length);
  assert.equal(encoded[13] & 1, 1);
});

test("samples raw RGB565 BPAL pixels directly without decoding the image", () => {
  const image = {
    width: 2,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 4,
    paletteColorBits: 16,
    palette: [
      { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 }, { r: 255, g: 255, b: 255 },
    ],
    blockPaletteIndices: new Uint16Array([0, 1]),
    pixelIndices: new Uint8Array([0, 1, 1, 0]),
  };
  const encoded = encodeBlockPaletteFile(image);
  const decoded = decodeBlockPaletteFile(encoded);

  assert.equal(encoded[13] & 1, 0);
  assert.deepEqual(Array.from(decoded.pixels), Array.from(reconstructWithSampler(encoded, 2, 2)));
});

test("rejects invalid BPAL magic, versions, and lengths", () => {
  const image = {
    width: 2,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 8,
    paletteColorBits: 24,
    palette: Array.from({ length: 8 }, () => ({ r: 0, g: 0, b: 0 })),
    blockPaletteIndices: new Uint16Array([0, 1]),
    pixelIndices: new Uint8Array([0, 1, 1, 0]),
  };
  const encoded = encodeBlockPaletteFile(image);
  const invalidMagic = encoded.slice();

  invalidMagic[0] = 0;

  assert.throws(() => decodeBlockPaletteFile(invalidMagic), /Invalid BPAL magic/);

  for (const version of [1, 2, 3, 4, 6]) {
    const invalidVersion = encoded.slice();

    invalidVersion[4] = (invalidVersion[4] & 0x0f) | version << 4;
    assert.throws(
      () => decodeBlockPaletteFile(invalidVersion),
      new RegExp(`Unsupported BPAL version: ${version}`)
    );
  }

  assert.throws(() => decodeBlockPaletteFile(encoded.slice(0, -1)), /file size does not match/);
});

function pixels(values) {
  return new Uint8ClampedArray(values.flat());
}

function reconstructWithSampler(encoded, width, height) {
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = sampleBlockPaletteFilePixel(encoded, x, y);
      output.set([color.r, color.g, color.b, 255], (y * width + x) * 4);
    }
  }
  return output;
}

function createLegacyVectorImage(vectorColorSpace) {
  return {
    width: 2,
    height: 2,
    blockSize: 2,
    localColorCount: 2,
    globalColorCount: 8,
    paletteColorBits: 24,
    paletteMode: "vector",
    vectorColorSpace,
    paletteVectorCount: 1,
    paletteVectors: [{
      start: { r: 0, g: 0, b: 0, hex: "#000000" },
      end: { r: 255, g: 255, b: 255, hex: "#ffffff" },
    }],
    blockPaletteIndices: new Uint16Array([0, 7]),
    pixelIndices: new Uint8Array([0, 1, 1, 0]),
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
