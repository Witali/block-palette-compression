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
const webStreamDirectory = path.join(sourceDirectory, "streams");
const originalDirectory = path.join(nativeDirectory, "assets", "original");
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDirectory, "manifest.json"), "utf8"));
const webShader = fs.readFileSync(path.join(sourceDirectory, "scene-texture-samplers.glsl"), "utf8");
const dctQuantY = parseShaderIntArray("SCENE_DCT_QUANT_Y");
const dctQuantC = parseShaderIntArray("SCENE_DCT_QUANT_C");
const dctScanY = parseShaderIntArray("DCT_SCAN_Y");
const dctScanC420 = parseShaderIntArray("DCT_SCAN_C420");

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

test("shares byte-identical packed streams with the WebGL2 viewer", () => {
  const nativeFiles = walk(streamDirectory).map((file) => path.relative(streamDirectory, file));
  const webFiles = walk(webStreamDirectory).map((file) => path.relative(webStreamDirectory, file));

  assert.deepEqual(webFiles.sort(), nativeFiles.sort());
  for (const relativePath of nativeFiles) {
    assert.deepEqual(
      fs.readFileSync(path.join(webStreamDirectory, relativePath)),
      fs.readFileSync(path.join(streamDirectory, relativePath)),
    );
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
      assert.equal(info.quality, 88);
      assert.equal(info.yBytes, 64);
      assert.equal(info.cbBytes, 16);
      assert.equal(info.crBytes, 16);
      assert.equal(info.splitLuma8x8, false);
      assert.equal(info.chroma420, true);
      assert.equal(info.coefficientCodingKey, "grouped-5-front");
      assert.equal(info.libraryEnabled, false);

      const streamName = `${texture.id}${relativePath === texture.variants.dct.alpha ? "-alpha" : ""}.dxtx`;
      const stream = readStream(path.join(streamDirectory, "dct", streamName));
      assert.equal(stream.parameters[1], info.quality);
      assert.deepEqual(stream.payload.subarray(0, bytes.length), bytes);
    }
  }
});

test("direct DCT stream sampling matches the canonical pixel decoder", () => {
  for (const texture of manifest.textures) {
    const source = fs.readFileSync(path.join(sourceDirectory, texture.variants.dct.color));
    const stream = readStream(path.join(streamDirectory, "dct", `${texture.id}.dxtx`));
    const points = [
      [0, 0],
      [Math.min(15, stream.width - 1), Math.min(15, stream.height - 1)],
    ];

    for (const [x, y] of points) {
      const expected = DctImageFormat.sampleDctFilePixel(source, x, y);
      const actual = sampleDirectDct(stream, x, y);
      for (const channel of ["r", "g", "b"]) {
        assert.ok(
          Math.abs(actual[channel] - expected[channel]) <= 1,
          `${texture.id} (${x}, ${y}) ${channel}: ${actual[channel]} != ${expected[channel]}`,
        );
      }
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

function sampleDirectDct(stream, x, y) {
  const p = stream.parameters;
  const localX = x & 15;
  const localY = y & 15;
  const mcuIndex = Math.floor(y / 16) * p[0] + Math.floor(x / 16);
  const mcuOffset = 64 + mcuIndex * p[2];
  const component = (offset, px, py, width, height, chroma, acCount) => (
    sampleDirectDctComponent(stream, offset, px, py, width, height, chroma, acCount)
  );
  const luma = component(mcuOffset, localX, localY, 16, 16, false, 97);
  const cb = component(mcuOffset + p[3], localX >> 1, localY >> 1, 8, 8, true, 20) - 128;
  const cr = component(mcuOffset + p[3] + p[4], localX >> 1, localY >> 1, 8, 8, true, 20) - 128;
  return {
    r: clampByte(luma + 1.402 * cr),
    g: clampByte(luma - 0.344136 * cb - 0.714136 * cr),
    b: clampByte(luma + 1.772 * cb),
  };
}

function sampleDirectDctComponent(stream, offset, x, y, width, height, chroma, acCount) {
  const word = stream.payload.readUInt32BE(offset);
  const profile = word >>> 28;
  const storedProfile = stream.parameters[6] & 16 ? profile : profile + 1;
  const dc = signedBits(word >>> 14 & 1023, 10);
  const scales = [word >>> 11 & 7, word >>> 8 & 7, word >>> 5 & 7].map((value) => 2 ** value);
  let sum = dc * 2 ** (word >>> 24 & 15) *
    dctQuantizationStep(0, chroma, width, height, stream.parameters[1]) *
    dctBasis(0, x, width) * dctBasis(0, y, height);
  let correction = 0;
  const firstEnd = Math.ceil(acCount / 6);
  const secondEnd = Math.ceil(acCount / 2);
  const scan = width === 16 ? dctScanY : dctScanC420;

  for (let index = 0; index < acCount; index += 1) {
    const position = scan[storedProfile * acCount + index];
    const stored = signedBits(readBitsMsb(stream.payload, offset * 8 + 27 + index * 5, 5), 5);
    const group = index < firstEnd ? 0 : index < secondEnd ? 1 : 2;
    const value = stored * scales[group] *
      dctQuantizationStep(position, chroma, width, height, stream.parameters[1]) *
      dctBasis(position % width, x, width) *
      dctBasis(Math.floor(position / width), y, height);
    const adjusted = value - correction;
    const next = sum + adjusted;
    correction = next - sum - adjusted;
    sum = next;
  }
  return sum + 128;
}

function dctBasis(frequency, coordinate, size) {
  const normalization = frequency === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
  return normalization * Math.cos(Math.PI * (2 * coordinate + 1) * frequency / (2 * size));
}

function dctQuantizationStep(position, chroma, width, height, quality) {
  const u = position % width;
  const v = Math.floor(position / width);
  const tableX = Math.min(7, Math.floor(u * 7 / Math.max(1, width - 1) + 0.5));
  const tableY = Math.min(7, Math.floor(v * 7 / Math.max(1, height - 1) + 0.5));
  const qualityScale = quality < 50 ? 50 / quality : 2 - quality * 0.02;
  const dimensionScale = Math.sqrt(width * height / 64);
  const table = chroma ? dctQuantC : dctQuantY;
  return Math.max(1, table[tableY * 8 + tableX] * qualityScale * dimensionScale);
}

function signedBits(value, bitCount) {
  const sign = 2 ** (bitCount - 1);
  return value & sign ? value - 2 ** bitCount : value;
}

function clampByte(value) {
  const rounded = value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
  return Math.max(0, Math.min(255, rounded));
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

function parseShaderIntArray(name) {
  const match = webShader.match(new RegExp(
    `const int ${name}\\[\\d+\\] = int\\[\\d+\\]\\(\\s*([\\s\\S]*?)\\s*\\);`,
  ));
  assert.ok(match, `${name} is missing from the generated WebGL shader`);
  return match[1].split(",").map((value) => Number(value.trim()));
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
