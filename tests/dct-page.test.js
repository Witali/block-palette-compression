"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const page = read("dct-compression.html");
const home = read("index.html");
const pageScript = read("src/pages/dct-compression-page.js");
const worker = read("src/dct/dct-worker.js");
const serviceWorker = read("service-worker.js");
const { PRESETS } = require("../src/dct/dct-format.js");

test("links the DCT compressor from the project home page", () => {
  assert.match(home, /href="\.\/dct-compression\.html"/);
  assert.match(home, /data-i18n="home\.dct\.title"/);
});

test("offers every fixed MCU rate from the preserved converter", () => {
  for (const preset of ["6", "4.5", "3", "2", "1.5", "1", "0.75"]) {
    assert.match(page, new RegExp(`<option value="${preset.replace(".", "\\.")}"`));
  }

  assert.equal(Object.keys(PRESETS).length, 7);
  assert.equal(PRESETS["6"].bytesPerMcu, 192);
  assert.match(pageScript, /Object\.entries\(codec\.PRESETS\)/);
  assert.match(pageScript, /presetSelect\.replaceChildren/);
  assert.match(page, /2 bpp · 64 B\/MCU/);
  assert.match(page, /0\.75 bpp · 24 B\/MCU/);
  assert.match(page, /dctbs_converter_with_edge_dictionary\.html/);
});

test("keeps direct coordinate sampling separate from full-image decoding", () => {
  const lookupStart = pageScript.indexOf("function readPixelAt");
  const lookupEnd = pageScript.indexOf("function updatePixelBounds", lookupStart);
  const lookup = pageScript.slice(lookupStart, lookupEnd);

  assert.match(lookup, /sampleDctFilePixel\(state\.encoded, px, py\)/);
  assert.match(lookup, /inspectDctMcu\(state\.encoded, mcuIndex\)/);
  assert.doesNotMatch(lookup, /decodeDctFile/);
});

test("runs DCT encoding and automatic quality search in a worker", () => {
  assert.match(pageScript, /new Worker\("\.\/src\/dct\/dct-worker\.js/);
  assert.match(worker, /findBestDctQuality/);
  assert.match(worker, /encodeDctFile/);
  assert.match(worker, /decodedPixels: decoded\.pixels\.buffer/);
  assert.match(worker, /\[encoded\.buffer, decoded\.pixels\.buffer\]/);
});

test("offers CPU Huffman JPEG DCT import without an RGB encoding pass", () => {
  assert.match(page, /id="jpeg-dct-import"/);
  assert.match(page, /data-i18n="dct\.jpegImport"/);
  assert.match(pageScript, /state\.sourceJpegBytes/);
  assert.match(pageScript, /jpegImportInput\.checked/);
  assert.match(worker, /GpuJpegDecoder\.parse\(data\.jpegBytes\)/);
  assert.match(worker, /importJpegDctFile\(jpeg, options\)/);
  assert.match(worker, /importMode: data\.jpegImport \? "jpeg-dct" : "rgba"/);
});

test("caches the DCT page and codec in the offline application shell", () => {
  assert.match(serviceWorker, /"\.\/dct-compression\.html"/);
  assert.match(serviceWorker, /"\.\/dct-compression\.css"/);
  assert.match(serviceWorker, /"\.\/src\/dct\/dct-format\.js"/);
  assert.match(serviceWorker, /"\.\/src\/dct\/dct-worker\.js"/);
  assert.match(serviceWorker, /"\.\/src\/decoders\/gpu-jpeg\.js"/);
  assert.match(serviceWorker, /"\.\/src\/pages\/dct-compression-page\.js"/);
});

function read(fileName) {
  return fs.readFileSync(path.join(root, fileName), "utf8");
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
