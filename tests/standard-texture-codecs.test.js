"use strict";

const assert = require("node:assert/strict");
const codecs = require("../src/texture/standard-texture-codecs.js");

test("lists every standard two-dimensional ASTC footprint", () => {
  assert.deepEqual(codecs.ASTC_PROFILES, [
    "4x4", "5x4", "5x5", "6x5", "6x6", "8x5", "8x6",
    "8x8", "10x5", "10x6", "10x8", "10x10", "12x10", "12x12",
  ]);
});

test("encodes and decodes valid BC1 four-color blocks", () => {
  const source = gradientBlock();
  const encoded = codecs.encodeBc1Block(source, "thorough");
  const description = codecs.inspectBc1Block(encoded);
  const decoded = codecs.decodeBc1Block(encoded);

  assert.equal(encoded.byteLength, 8);
  assert.equal(description.mode, "four-color");
  assert.equal(description.selectors.length, 16);
  assert.equal(decoded.byteLength, 64);
  assert.ok(codecs.computeRgbSquaredError(source, decoded) > 0);
});

test("encodes BC7 mode 6 with a legal anchor index", () => {
  const source = gradientBlock();
  const encoded = codecs.encodeBc7Mode6Block(source, "thorough");
  const description = codecs.inspectBc7Mode6Block(encoded);
  const decoded = codecs.decodeBc7Mode6Block(encoded);

  assert.equal(encoded.byteLength, 16);
  assert.equal(encoded[0] & 0x7F, 1 << 6);
  assert.equal(description.mode, 6);
  assert.ok(description.selectors[0] < 8);
  assert.equal(description.selectors.length, 16);
  assert.equal(decoded.byteLength, 64);
});

test("pads partial BC images with edge texels and returns the source extent", () => {
  const width = 7;
  const height = 5;
  const source = image(width, height);
  const bc1 = codecs.encodeBc1Image(source, width, height, { quality: "fast" });
  const bc7 = codecs.encodeBc7Image(source, width, height, { quality: "balanced" });

  assert.deepEqual([bc1.blocksX, bc1.blocksY, bc1.payload.byteLength], [2, 2, 32]);
  assert.deepEqual([bc7.blocksX, bc7.blocksY, bc7.payload.byteLength], [2, 2, 64]);
  assert.equal(bc1.decoded.byteLength, source.byteLength);
  assert.equal(bc7.decoded.byteLength, source.byteLength);
});

test("wraps BC1 and BC7 payloads in standard DDS headers", () => {
  const bc1 = codecs.createDdsFile("bc1", new Uint8Array(8), 4, 4);
  const bc7 = codecs.createDdsFile("bc7", new Uint8Array(16), 4, 4);
  const bc1View = new DataView(bc1.buffer);
  const bc7View = new DataView(bc7.buffer);

  assert.equal(ascii(bc1, 0, 4), "DDS ");
  assert.equal(ascii(bc1, 84, 4), "DXT1");
  assert.equal(bc1.byteLength, 136);
  assert.equal(ascii(bc7, 84, 4), "DX10");
  assert.equal(bc7View.getUint32(128, true), 98);
  assert.equal(bc7.byteLength, 164);
  assert.equal(bc1View.getUint32(16, true), 4);
});

test("wraps ASTC payloads in the standard 16-byte container header", () => {
  const file = codecs.createAstcFile(new Uint8Array(16), 320, 180, "6x6");
  assert.deepEqual(Array.from(file.slice(0, 7)), [0x13, 0xAB, 0xA1, 0x5C, 6, 6, 1]);
  assert.deepEqual(Array.from(file.slice(7, 10)), [64, 1, 0]);
  assert.deepEqual(Array.from(file.slice(10, 13)), [180, 0, 0]);
  assert.equal(file.byteLength, 32);
});

function gradientBlock() {
  const pixels = new Uint8ClampedArray(64);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const offset = (y * 4 + x) * 4;
      pixels[offset] = x * 60 + y * 10;
      pixels[offset + 1] = y * 65;
      pixels[offset + 2] = (x + y) * 30;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function image(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = index * 17 % 256;
    pixels[index * 4 + 1] = index * 7 % 256;
    pixels[index * 4 + 2] = index * 31 % 256;
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
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
