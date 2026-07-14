"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const [encoderPath, decoderPath, repositoryRoot] = process.argv.slice(2);

if (!encoderPath || !decoderPath || !repositoryRoot) {
  throw new Error("Usage: verify-js-compat.js <bpal5enc> <bpal5dec> <repository-root>");
}

const codec = require(path.join(repositoryRoot, "src/palette/block-palette-codec.js"));
const format = require(path.join(repositoryRoot, "src/palette/block-palette-format.js"));
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bpal5-c-compat-"));

function run(executable, arguments_) {
  const result = childProcess.spawnSync(executable, arguments_, {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error([
      `${path.basename(executable)} exited with code ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }

  return result;
}

function makeImage(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = (x * 17 + y * 3) & 255;
      rgba[offset + 1] = (x * 5 + y * 29) & 255;
      rgba[offset + 2] = ((x ^ y) * 31 + x * 2) & 255;
      rgba[offset + 3] = 255;
    }
  }

  return rgba;
}

function rgbaToRgb(rgba) {
  const rgb = Buffer.alloc(rgba.length / 4 * 3);

  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
  }

  return rgb;
}

function writePpm(filePath, width, height, rgba) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  fs.writeFileSync(filePath, Buffer.concat([header, rgbaToRgb(rgba)]));
}

function readPpm(filePath) {
  const bytes = fs.readFileSync(filePath);
  let offset = 0;

  function token() {
    while (offset < bytes.length) {
      if (bytes[offset] === 35) {
        while (offset < bytes.length && bytes[offset] !== 10) offset += 1;
      } else if (bytes[offset] <= 32) {
        offset += 1;
      } else {
        break;
      }
    }

    const start = offset;
    while (offset < bytes.length && bytes[offset] > 32 && bytes[offset] !== 35) offset += 1;
    return bytes.subarray(start, offset).toString("ascii");
  }

  assert.equal(token(), "P6");
  const width = Number(token());
  const height = Number(token());
  assert.equal(Number(token()), 255);
  assert.ok(offset < bytes.length && bytes[offset] <= 32, "Missing PPM header separator");
  offset += 1;
  const pixels = bytes.subarray(offset);
  assert.equal(pixels.length, width * height * 3);
  return { width, height, pixels };
}

function assertDecodedRgb(ppm, decoded) {
  assert.equal(ppm.width, decoded.width);
  assert.equal(ppm.height, decoded.height);
  assert.deepEqual(ppm.pixels, rgbaToRgb(decoded.pixels));
}

try {
  const width = 23;
  const height = 15;
  const rgba = makeImage(width, height);
  const sourcePpmPath = path.join(temporaryDirectory, "source.ppm");
  const cBpalPath = path.join(temporaryDirectory, "from-c.bpal");
  const cPresetBpalPath = path.join(temporaryDirectory, "from-c-preset.bpal");
  const cDecodedPpmPath = path.join(temporaryDirectory, "from-c.ppm");
  const cRgb565BpalPath = path.join(temporaryDirectory, "from-c-rgb565-128.bpal");
  const cRgb565DecodedPpmPath = path.join(temporaryDirectory, "from-c-rgb565-128.ppm");
  const jsBpalPath = path.join(temporaryDirectory, "from-js.bpal");
  const jsDecodedPpmPath = path.join(temporaryDirectory, "from-js.ppm");

  writePpm(sourcePpmPath, width, height, rgba);
  run(encoderPath, [
    sourcePpmPath,
    cBpalPath,
    "--block", "4",
    "--local", "16",
    "--global", "16",
    "--palettes", "4",
    "--iterations", "4",
    "--refine", "2",
  ]);

  const cDecodedByJs = format.decodeBlockPaletteFile(fs.readFileSync(cBpalPath));
  assert.equal(cDecodedByJs.version, 5);
  assert.equal(cDecodedByJs.paletteMode, "explicit");
  assert.equal(cDecodedByJs.paletteCount, 4);
  assert.equal(cDecodedByJs.localColorCount, 16);
  assert.equal(cDecodedByJs.directPixelColors, true);
  assert.equal(cDecodedByJs.storage.pixelDataBits, 0);
  assert.equal(cDecodedByJs.width, width);
  assert.equal(cDecodedByJs.height, height);

  run(encoderPath, [
    sourcePpmPath,
    cPresetBpalPath,
    "--block", "8",
    "--preset", "1.5",
    "--iterations", "1",
    "--refine", "0",
  ]);
  const cPresetDecodedByJs = format.decodeBlockPaletteFile(fs.readFileSync(cPresetBpalPath));
  assert.equal(cPresetDecodedByJs.blockSize, 8);
  assert.equal(cPresetDecodedByJs.localColorCount, 2);
  assert.equal(cPresetDecodedByJs.globalColorCount, 8);
  assert.equal(cPresetDecodedByJs.paletteCount, 2);
  assert.equal(cPresetDecodedByJs.paletteColorBits, 24);

  run(decoderPath, [cBpalPath, cDecodedPpmPath]);
  assertDecodedRgb(readPpm(cDecodedPpmPath), cDecodedByJs);

  run(encoderPath, [
    sourcePpmPath,
    cRgb565BpalPath,
    "--block", "4",
    "--local", "4",
    "--global", "8",
    "--palettes", "128",
    "--rgb565",
    "--iterations", "2",
    "--refine", "1",
  ]);
  const cRgb565DecodedByJs = format.decodeBlockPaletteFile(fs.readFileSync(cRgb565BpalPath));
  assert.equal(cRgb565DecodedByJs.paletteCount, 128);
  assert.equal(cRgb565DecodedByJs.paletteIndexBits, 7);
  assert.equal(cRgb565DecodedByJs.paletteColorBits, 16);
  run(decoderPath, [cRgb565BpalPath, cRgb565DecodedPpmPath]);
  assertDecodedRgb(readPpm(cRgb565DecodedPpmPath), cRgb565DecodedByJs);

  const jsCompressed = codec.compressImage(rgba, width, height, {
    blockSize: 4,
    localColorCount: 4,
    globalColorCount: 8,
    paletteCount: 4,
    paletteColorBits: 24,
    paletteMode: "explicit",
    colorSpace: "rgb",
    clusteringMethod: "k-means",
    dithering: "none",
    diversity: 0,
    refinementPasses: 1,
  });
  fs.writeFileSync(jsBpalPath, format.encodeBlockPaletteFile(jsCompressed));
  run(decoderPath, [jsBpalPath, jsDecodedPpmPath]);

  const jsDecodedByJs = format.decodeBlockPaletteFile(fs.readFileSync(jsBpalPath));
  assertDecodedRgb(readPpm(jsDecodedPpmPath), jsDecodedByJs);
  process.stdout.write("C/JavaScript BPAL v5 compatibility passed\n");
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
