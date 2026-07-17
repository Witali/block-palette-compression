"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BlockPaletteFormat = require("../src/palette/block-palette-format.js");
const DctImageFormat = require("../src/dct/dct-format.js");

const root = path.resolve(__dirname, "..");
const sourceDirectory = path.join(root, "assets", "scenes", "barcelona");
const nativeDirectory = path.join(root, "native", "win32-directx-viewer");
const streamDirectory = path.join(nativeDirectory, "assets", "streams");
const originalDirectory = path.join(nativeDirectory, "assets", "original");
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDirectory, "manifest.json"), "utf8"));

test("ships raw Direct3D streams instead of decoded texture caches", () => {
  const hlsl = fs.readFileSync(path.join(nativeDirectory, "assets", "scene.hlsl"), "utf8");
  const files = walk(streamDirectory);

  assert.ok(files.length > 0);
  assert.ok(files.every((file) => file.endsWith(".dxtx")));
  assert.equal(files.some((file) => file.endsWith(".dds")), false);
  assert.match(hlsl, /ByteAddressBuffer baseStream/);
  assert.match(hlsl, /SampleBpal/);
  assert.match(hlsl, /SampleDctComponent/);
  assert.match(hlsl, /SampleAstc/);

  for (const file of files) {
    const stream = readStream(file);
    assert.ok(stream.codec >= 1 && stream.codec <= 3);
    assert.ok(stream.width > 0 && stream.height > 0);
    assert.equal(stream.payload.length % 4, 0);
  }
});

test("ships original-resolution BC1 and BC7 textures without RGBA caches", () => {
  const main = fs.readFileSync(path.join(nativeDirectory, "main.cpp"), "utf8");
  const hlsl = fs.readFileSync(path.join(nativeDirectory, "assets", "scene.hlsl"), "utf8");

  assert.match(main, /DXGI_FORMAT_BC1_UNORM/);
  assert.match(main, /DXGI_FORMAT_BC7_UNORM/);
  assert.match(hlsl, /Texture2D<float4> baseStream/);
  for (const texture of manifest.textures) {
    const variant = texture.variants.original;
    const source = fs.readFileSync(path.join(sourceDirectory, variant.color));
    const native = fs.readFileSync(path.join(originalDirectory, path.basename(variant.color)));
    assert.deepEqual(native, source);
    assert.equal(variant.gpuFormat, texture.hasAlpha ? "BC7" : "BC1");
  }
});

test("native BPAL shader layout returns the canonical random-access colors", () => {
  const textureById = new Map(manifest.textures.map((texture) => [texture.id, texture]));
  const identifiers = textureIdentifiers();

  for (const identifier of identifiers) {
    const texture = textureById.get(identifier);
    verifyBpalVariant(identifier, texture.variants.bpal.color);
    if (texture.variants.bpal.alpha) {
      verifyBpalVariant(`${identifier}-alpha`, texture.variants.bpal.alpha);
    }
  }
});

test("scene DCT streams use the directly sampled fixed 3 bpp MCU layout", () => {
  for (const texture of manifest.textures) {
    for (const relativePath of [texture.variants.dct.color, texture.variants.dct.alpha].filter(Boolean)) {
      const bytes = fs.readFileSync(path.join(sourceDirectory, relativePath));
      const info = DctImageFormat.inspectDctFile(bytes);

      assert.equal(info.bytesPerMcu, 96);
      assert.equal(info.yBytes, 64);
      assert.equal(info.cbBytes, 16);
      assert.equal(info.crBytes, 16);
      assert.equal(info.splitLuma8x8, false);
      assert.equal(info.chroma420, true);
      assert.equal(info.coefficientCodingKey, "grouped-5-front");
      assert.equal(info.libraryEnabled, false);
    }
  }
});

test("native ASTC streams contain valid 6x6 void-extent blocks", () => {
  for (const identifier of textureIdentifiers()) {
    const stream = readStream(path.join(streamDirectory, "astc", `${identifier}.dxtx`));

    assert.equal(stream.codec, 3);
    assert.equal(stream.parameters[0], 6);
    assert.equal(stream.parameters[1], 6);
    assert.equal(stream.payload.subarray(0, 8).toString("hex"), "fcfdffffffffffff");
    assert.equal(stream.payload.length, stream.parameters[2] * stream.parameters[3] * 16);
  }
});

function verifyBpalVariant(streamName, sourcePath) {
  const source = fs.readFileSync(path.join(sourceDirectory, sourcePath));
  const stream = readStream(path.join(streamDirectory, "bpal", `${streamName}.dxtx`));
  const points = [
    [0, 0],
    [Math.floor(stream.width / 2), Math.floor(stream.height / 2)],
    [stream.width - 1, stream.height - 1],
  ];

  assert.equal(stream.codec, 1);
  for (const [x, y] of points) {
    const expected = BlockPaletteFormat.sampleBlockPaletteFilePixel(source, x, y);
    const actual = sampleNativeBpal(stream, x, y);
    assert.deepEqual(actual, [expected.r, expected.g, expected.b]);
  }
}

function sampleNativeBpal(stream, x, y) {
  const p = stream.parameters;
  const blockIndex = Math.floor(y / p[0]) * p[1] + Math.floor(x / p[0]);
  const localIndex = readBitsMsb(stream.payload, p[10] + (y * stream.width + x) * p[4], p[4]);
  const globalIndex = readBitsMsb(
    stream.payload,
    p[9] + (blockIndex * p[2] + localIndex) * p[5],
    p[5],
  );
  const paletteIndex = p[6] === 0
    ? 0
    : readBitsMsb(stream.payload, p[8] + blockIndex * p[6], p[6]);
  const packed = stream.payload.readUInt32LE(p[11] + (paletteIndex * p[3] + globalIndex) * 4);
  return [packed & 255, packed >> 8 & 255, packed >> 16 & 255];
}

function readBitsMsb(bytes, bitOffset, bitCount) {
  let value = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    const absolute = bitOffset + bit;
    value = value * 2 + (bytes[Math.floor(absolute / 8)] >> (7 - absolute % 8) & 1);
  }
  return value;
}

function readStream(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.ok(bytes.length >= 80);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "DXTX");
  assert.equal(bytes.readUInt32LE(4), 1);
  const dataBytes = bytes.readUInt32LE(20);
  assert.equal(bytes.length, 80 + dataBytes);
  return {
    codec: bytes.readUInt32LE(8),
    width: bytes.readUInt32LE(12),
    height: bytes.readUInt32LE(16),
    parameters: Array.from({ length: 14 }, (_, index) => bytes.readUInt32LE(24 + index * 4)),
    payload: bytes.subarray(80),
  };
}

function textureIdentifiers() {
  return manifest.textures.map((texture) => texture.id).sort();
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(filePath) : [filePath];
  });
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
