"use strict";

const fs = require("node:fs");
const path = require("node:path");
const codec = require("../src/palette/block-palette-codec.js");
const format = require("../src/palette/block-palette-format.js");

const [, , mode, ...args] = process.argv;

if (mode === "encode") {
  encode(args);
} else if (mode === "decode") {
  decode(args);
} else {
  fail("Usage: benchmark_bpal_adapter.js encode|decode ...");
}

function encode(args) {
  if (args.length !== 6) {
    fail("encode requires: input.rgba width height settings-json output.bpal metadata.json");
  }

  const [inputPath, widthText, heightText, settingsText, outputPath, metadataPath] = args;
  const width = parseDimension(widthText, "width");
  const height = parseDimension(heightText, "height");
  const source = fs.readFileSync(inputPath);

  if (source.length !== width * height * 4) {
    fail(`RGBA input has ${source.length} bytes; expected ${width * height * 4}`);
  }

  const settings = JSON.parse(settingsText);
  const pixels = new Uint8ClampedArray(
    source.buffer,
    source.byteOffset,
    source.byteLength
  );
  const result = codec.compressImage(pixels, width, height, settings);
  const encoded = format.encodeBlockPaletteFile(result);

  ensureParent(outputPath);
  ensureParent(metadataPath);
  fs.writeFileSync(outputPath, encoded);
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    width,
    height,
    fileBytes: encoded.length,
    headerBytes: format.HEADER_BYTES,
    payloadBytes: encoded.length - format.HEADER_BYTES,
    activeGlobalColorCount: result.activeGlobalColorCount,
    resultColorCount: result.resultColorCount,
    settings,
  }, null, 2)}\n`);
}

function decode(args) {
  if (args.length !== 2) {
    fail("decode requires: input.bpal output.rgba");
  }

  const [inputPath, outputPath] = args;
  const decoded = format.decodeBlockPaletteFile(fs.readFileSync(inputPath));

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
