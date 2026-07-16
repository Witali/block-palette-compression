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
  assert.match(page, /four 8×8 luma transforms at high rates/);
});

test("embeds a DCTBS2 layout diagram synchronized with the target rate", () => {
  assert.match(page, /id="dct-layout-rate-chart"/);
  assert.match(page, /id="dct-layout-mcu-bar"/);
  assert.match(page, /id="dct-layout-spatial"/);
  assert.match(page, /class="dct-layout-path"/);
  assert.match(page, /data-i18n="dct\.layoutDiagramTitle"/);
  assert.match(pageScript, /function renderDctLayoutDiagram\(\)/);
  assert.match(pageScript, /profile\.bytesPerMcu \/ maxBytes \* 100/);
  assert.match(pageScript, /const splitLuma = selected\.bpp >= 3/);
  assert.match(pageScript, /createDctLayoutBlock\("y", `Y 8×8 · \$\{block\}`\)/);

  const presetHandler = pageScript.slice(
    pageScript.indexOf('presetSelect.addEventListener("change"'),
    pageScript.indexOf('qualityInput.addEventListener("input"')
  );
  assert.match(presetHandler, /renderDctLayoutDiagram\(\)/);
});

test("keeps direct coordinate sampling separate from full-image decoding", () => {
  const lookupStart = pageScript.indexOf("function readPixelAt");
  const lookupEnd = pageScript.indexOf("function updatePixelBounds", lookupStart);
  const lookup = pageScript.slice(lookupStart, lookupEnd);

  assert.match(lookup, /sampleDctFilePixel\(state\.encoded, px, py\)/);
  assert.match(lookup, /inspectDctMcu\(state\.encoded, mcuIndex\)/);
  assert.doesNotMatch(lookup, /decodeDctFile/);
});

test("zooms both previews around the pointer with Ctrl and the mouse wheel", () => {
  assert.equal((page.match(/data-i18n-title="dct\.zoomWheelTitle"/g) || []).length, 2);
  assert.match(pageScript, /viewport\.addEventListener\("wheel", zoomFromWheel, \{ passive: false \}\)/);
  assert.match(pageScript, /if \(!event\.ctrlKey \|\| !state\.sourceImageData\)/);
  assert.match(pageScript, /Math\.exp\(-pixelDelta \* 0\.002\)/);
  assert.match(pageScript, /setZoom\(nextZoom, viewport, event\.clientX, event\.clientY\)/);
  assert.match(pageScript, /x: \(anchorClientX - stageBounds\.left\) \/ state\.zoom/);
  assert.match(pageScript, /synchronizeScroll\(/);
});

test("runs DCT encoding and automatic quality search in a worker", () => {
  assert.match(pageScript, /new Worker\("\.\/src\/dct\/dct-worker\.js/);
  assert.match(worker, /dct-format\.js\?v=dct-page-14/);
  assert.match(worker, /findBestDctQuality/);
  assert.match(worker, /encodeDctFile/);
  assert.match(worker, /decodedPixels: decoded\.pixels\.buffer/);
  assert.match(worker, /\[encoded\.buffer, decoded\.pixels\.buffer\]/);
  assert.match(worker, /onProgress: postProgress/);
  assert.match(pageScript, /sampleMcuCount: 32/);
  assert.match(pageScript, /searching \? "dct\.progressSearching" : "dct\.progressEncoding"/);
});

test("offers separately versioned 3-, 16-, and 32-entry DCT prototype libraries", () => {
  assert.match(page, /id="dct-prototype-library"/);
  assert.match(page, /data-i18n="dct\.prototypeLibrary"/);
  assert.match(page, /value="sidecar16"/);
  assert.match(page, /value="sidecar32"/);
  assert.match(page, /value="sidecar32-spectral"/);
  assert.match(pageScript, /libraryReferenceCoding: "sidecar"/);
  assert.match(pageScript, /libraryFrequencySplit: 0\.25/);
  assert.match(pageScript, /libraryCandidateCount: 4/);
  assert.match(pageScript, /dctLibrary: !jpegImport && libraryOptions !== null/);
  assert.match(worker, /dctLibrary: Boolean\(data\.dctLibrary\)/);
  assert.match(worker, /libraryReferenceCoding: data\.libraryReferenceCoding/);
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
