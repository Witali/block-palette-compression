"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const {
  PRESETS,
  decodeDctFile,
  encodeDctFile,
  inspectDctFile,
  sampleDctFilePixel,
} = require(path.join(root, "src", "dct", "dct-format.js"));

const executable = path.resolve(process.argv[2] || path.join(root, ".tmp", "dctcuda-build", "dctcuda.exe"));
if (!fs.existsSync(executable)) {
  throw new Error(`CUDA executable not found: ${executable}`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dctcuda-compat-"));
const width = 19;
const height = 17;
const rgba = makePixels(width, height);
const inputPpm = path.join(temporary, "input.ppm");
writePpm(inputPpm, rgba, width, height);
const representativePresets = [
  "0.75", "1", "1.5", "2", "3", "4.5", "6",
];

try {
  verifyPresetListing();
  for (const preset of representativePresets) {
    verifyPreset(preset);
  }
  console.log("ok - CUDA and JavaScript DCTBS2 codecs are bidirectionally compatible");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function verifyPresetListing() {
  const lines = run(["presets"]).trim().split(/\r?\n/);
  assert.equal(lines.shift(), "bpp\tbytes/MCU\tY\tCb\tCr");
  assert.equal(lines.length, Object.keys(PRESETS).length);

  for (const line of lines) {
    const [key, bytesPerMcu, yBytes, cbBytes, crBytes] = line.split("\t");
    const preset = PRESETS[key];
    assert.ok(preset, `unexpected CUDA preset ${key}`);
    assert.deepEqual(
      [Number(bytesPerMcu), Number(yBytes), Number(cbBytes), Number(crBytes)],
      [preset.bytesPerMcu, preset.yBytes, preset.cbBytes, preset.crBytes],
      `CUDA layout ${key}`
    );
  }
  console.log(`ok - CUDA lists all ${lines.length} DCTBS2 layouts`);
}

function verifyPreset(preset) {
  const cudaFile = path.join(temporary, `cuda-${preset}.dctbs2`);
  const cudaRepeatFile = path.join(temporary, `cuda-${preset}-repeat.dctbs2`);
  const cudaPpm = path.join(temporary, `cuda-${preset}.ppm`);
  const jsFile = path.join(temporary, `js-${preset}.dctbs2`);
  const jsPpm = path.join(temporary, `js-${preset}.ppm`);

  run(["encode", inputPpm, cudaFile, "--preset", preset, "--quality", "72"]);
  run(["encode", inputPpm, cudaRepeatFile, "--preset", preset, "--quality", "72"]);
  const cudaEncoded = fs.readFileSync(cudaFile);
  assert.deepEqual(cudaEncoded, fs.readFileSync(cudaRepeatFile), `deterministic CUDA preset ${preset}`);
  const cudaInfo = inspectDctFile(cudaEncoded);
  assert.equal(cudaInfo.key, preset);
  assert.equal(cudaInfo.quality, 72);

  const javascriptDecodedCuda = decodeDctFile(cudaEncoded);
  run(["decode", cudaFile, cudaPpm]);
  assertRgbMatchesRgba(readPpm(cudaPpm), javascriptDecodedCuda.pixels, `CUDA encode ${preset}`);

  const javascriptEncoded = encodeDctFile(rgba, width, height, { preset, quality: 72 });
  fs.writeFileSync(jsFile, javascriptEncoded);
  const javascriptDecodedJs = decodeDctFile(javascriptEncoded);
  run(["decode", jsFile, jsPpm]);
  assertRgbMatchesRgba(readPpm(jsPpm), javascriptDecodedJs.pixels, `JavaScript encode ${preset}`);

  for (const [x, y] of [[0, 0], [15, 8], [18, 16]]) {
    const sampled = sampleDctFilePixel(javascriptEncoded, x, y);
    const output = run(["pixel", jsFile, String(x), String(y)]);
    const match = /RGBA\(\d+,\d+\) = (\d+) (\d+) (\d+) (\d+)/.exec(output);
    assert.ok(match, `pixel output for ${preset}: ${output}`);
    assert.deepEqual(match.slice(1).map(Number), [sampled.r, sampled.g, sampled.b, sampled.a]);
  }

  const actualBpp = cudaEncoded.length * 8 / (width * height);
  console.log(`ok - preset ${preset}: ${cudaEncoded.length} bytes, ${actualBpp.toFixed(3)} actual bpp`);
}

function run(arguments_) {
  return childProcess.execFileSync(executable, arguments_, { encoding: "utf8" });
}

function makePixels(imageWidth, imageHeight) {
  const pixels = new Uint8ClampedArray(imageWidth * imageHeight * 4);
  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const offset = (y * imageWidth + x) * 4;
      pixels[offset] = (x * 17 + y * 3) & 255;
      pixels[offset + 1] = (x * 5 + y * 19) & 255;
      pixels[offset + 2] = (x * 11 + y * 13) & 255;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function writePpm(file, pixels, imageWidth, imageHeight) {
  const header = Buffer.from(`P6\n${imageWidth} ${imageHeight}\n255\n`, "ascii");
  const rgb = Buffer.alloc(imageWidth * imageHeight * 3);
  for (let source = 0, destination = 0; source < pixels.length; source += 4, destination += 3) {
    rgb[destination] = pixels[source];
    rgb[destination + 1] = pixels[source + 1];
    rgb[destination + 2] = pixels[source + 2];
  }
  fs.writeFileSync(file, Buffer.concat([header, rgb]));
}

function readPpm(file) {
  const bytes = fs.readFileSync(file);
  let offset = 0;
  const token = () => {
    while (offset < bytes.length && bytes[offset] <= 32) offset += 1;
    const start = offset;
    while (offset < bytes.length && bytes[offset] > 32) offset += 1;
    return bytes.subarray(start, offset).toString("ascii");
  };
  assert.equal(token(), "P6");
  const imageWidth = Number(token());
  const imageHeight = Number(token());
  assert.equal(token(), "255");
  assert.ok(bytes[offset] <= 32, "PPM header terminator");
  offset += 1;
  assert.equal(imageWidth, width);
  assert.equal(imageHeight, height);
  const rgb = bytes.subarray(offset);
  assert.equal(rgb.length, width * height * 3);
  return rgb;
}

function assertRgbMatchesRgba(rgb, expected, label) {
  let maximumDifference = 0;
  for (let rgbOffset = 0, rgbaOffset = 0; rgbOffset < rgb.length; rgbOffset += 3, rgbaOffset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      maximumDifference = Math.max(
        maximumDifference,
        Math.abs(rgb[rgbOffset + channel] - expected[rgbaOffset + channel])
      );
    }
  }
  assert.ok(maximumDifference <= 1, `${label} maximum channel difference is ${maximumDifference}`);
}
