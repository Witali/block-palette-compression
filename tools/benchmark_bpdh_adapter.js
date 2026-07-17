"use strict";

const fs = require("node:fs");
const path = require("node:path");
const codec = require("../src/hybrid/bpdh-codec.js");
const format = require("../src/hybrid/bpdh-format.js");

const [, , mode, ...args] = process.argv;

if (mode === "encode") {
  encode(args);
} else if (mode === "decode") {
  decode(args);
} else {
  fail("Usage: benchmark_bpdh_adapter.js encode|decode ...");
}

function encode(args) {
  if (args.length !== 6) {
    fail("encode requires: input.rgba width height settings-json output.bpdh metadata.json");
  }

  const [inputPath, widthText, heightText, settingsText, outputPath, metadataPath] = args;
  const width = parseDimension(widthText, "width");
  const height = parseDimension(heightText, "height");
  const source = fs.readFileSync(inputPath);

  if (source.length !== width * height * 4) {
    fail(`RGBA input has ${source.length} bytes; expected ${width * height * 4}`);
  }

  const settings = JSON.parse(settingsText);
  const pixels = new Uint8ClampedArray(source.buffer, source.byteOffset, source.byteLength);
  const result = codec.compressHybridImage(pixels, width, height, settings);
  const encoded = format.encodeBpdhFile(result);

  ensureParent(outputPath);
  ensureParent(metadataPath);
  fs.writeFileSync(outputPath, encoded);
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    width,
    height,
    fileBytes: encoded.length,
    headerBytes: format.HEADER_BYTES,
    payloadBytes: result.storage.payloadBytes,
    payloadBitsPerPixel: result.storage.bitsPerPixel,
    storage: {
      paletteBytes: result.storage.paletteBytes,
      quantizationTableBytes: result.storage.quantizationTableBytes,
      modeMapBytes: result.storage.modeMapBytes,
      bpalBytes: result.storage.bpalBytes,
      bpalBits: result.storage.bpalBits,
      dctBytes: result.storage.dctBytes,
      dctBits: result.storage.dctBits,
      paddingBits: result.storage.paddingBits,
    },
    bpalBlocks: result.bpalBlockCount,
    dctBlocks: result.dctBlockCount,
    dctQuality: result.dctQuality,
    psnrRgb: result.psnr,
    withinTarget: result.storage.withinTarget,
    settings,
  }, null, 2)}\n`);
}

function decode(args) {
  if (args.length !== 2) {
    fail("decode requires: input.bpdh output.rgba");
  }

  const [inputPath, outputPath] = args;
  const decoded = format.decodeBpdhFile(fs.readFileSync(inputPath));

  ensureParent(outputPath);
  fs.writeFileSync(
    outputPath,
    Buffer.from(decoded.pixels.buffer, decoded.pixels.byteOffset, decoded.pixels.byteLength)
  );
}

function parseDimension(value, name) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${name} must be a positive integer`);
  }

  return parsed;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
