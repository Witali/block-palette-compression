"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const page = read("bpdh.html");
const pageScript = read("src/pages/bpdh-page.js");
const worker = read("src/hybrid/bpdh-worker.js");
const home = read("index.html");
const serviceWorker = read("service-worker.js");
const sharedStyles = read("block-palette.css");

test("provides a dedicated BPDH compression page", () => {
  assert.match(page, /id="target-bpp"/);
  assert.match(page, /id="codec-mode"/);
  assert.match(page, /id="dct-search"/);
  assert.match(page, /id="storage-bpal"/);
  assert.match(page, /id="storage-dct"/);
  assert.match(page, /id="mode-canvas"/);
  assert.match(page, /id="pixel-match"/);
});

test("loads deterministic BPDH decoding before the page controller", () => {
  const dctIndex = page.indexOf("src/hybrid/dct420.js");
  const formatIndex = page.indexOf("src/hybrid/bpdh-format.js");
  const controllerIndex = page.indexOf("src/pages/bpdh-page.js");

  assert.ok(dctIndex >= 0 && dctIndex < formatIndex);
  assert.ok(formatIndex < controllerIndex);
  assert.match(pageScript, /format\.decodeBpdhFile\(state\.encoded\)/);
  assert.match(pageScript, /format\.sampleBpdhPixel\(decoded, x, y\)/);
  assert.match(pageScript, /verifyCoordinateSample/);
});

test("runs the hybrid encoder outside the UI thread", () => {
  assert.match(pageScript, /new Worker\("\.\/src\/hybrid\/bpdh-worker\.js/);
  assert.match(worker, /importScripts\(/);
  assert.match(worker, /block-palette-codec\.js/);
  assert.match(worker, /bpdh-codec\.js/);
  assert.match(worker, /compressHybridImage/);
  assert.match(worker, /encodeBpdhFile/);
});

test("links and caches the BPDH page", () => {
  assert.match(home, /href="\.\/bpdh\.html"/);

  for (const file of [
    "./bpdh.html",
    "./bpdh.css",
    "./src/hybrid/bpdh-worker.js",
    "./src/pages/bpdh-page.js",
  ]) {
    assert.ok(serviceWorker.includes(`"${file}"`), file);
  }
});

test("copies the BPAL preview toolbar and synchronized zoom controls", () => {
  assert.match(page, /id="source-viewport" class="canvas-viewport"/);
  assert.match(page, /id="result-viewport" class="canvas-viewport"/);
  assert.match(page, /id="zoom-out"[^>]*disabled/);
  assert.match(page, /id="zoom-in"[^>]*disabled/);
  assert.match(page, /id="actual-size"[^>]*aria-pressed="false"[^>]*disabled/);
  assert.match(page, /id="fit-image"[^>]*aria-pressed="true"[^>]*disabled/);
  assert.match(page, /id="smooth-scaling" type="checkbox" checked/);
  assert.match(pageScript, /zoomOutButton\.addEventListener\("click", \(\) => setZoom\(state\.zoom \/ ZOOM_FACTOR\)\)/);
  assert.match(pageScript, /zoomInButton\.addEventListener\("click", \(\) => setZoom\(state\.zoom \* ZOOM_FACTOR\)\)/);
  assert.match(pageScript, /actualSizeButton\.addEventListener\("click", showActualSize\)/);
  assert.match(pageScript, /fitImageButton\.addEventListener\("click", fitImage\)/);
  assert.match(pageScript, /sourceViewport\.addEventListener\("scroll"/);
  assert.match(pageScript, /resultViewport\.addEventListener\("scroll"/);
  assert.match(pageScript, /function synchronizeScroll\(source, target\)/);
  assert.match(pageScript, /state\.imageWidth \* state\.zoom/);
});

test("supports Ctrl-wheel, dragging, and two-finger pinch in either preview", () => {
  assert.match(sharedStyles, /\.canvas-viewport \{[\s\S]*?touch-action: none;/);
  assert.match(pageScript, /viewport\.addEventListener\("pointerdown", startViewportPointer\)/);
  assert.match(pageScript, /if \(!event\.ctrlKey \|\| !state\.imageWidth/);
  assert.match(pageScript, /state\.zoom \* Math\.exp\(-pixelDelta \* 0\.002\)/);
  assert.match(pageScript, /drag\.viewport\.scrollLeft = drag\.scrollLeft - deltaX/);
  assert.match(pageScript, /drag\.viewport\.scrollTop = drag\.scrollTop - deltaY/);
  assert.match(pageScript, /touches: new Map\(\)/);
  assert.match(pageScript, /pinch: null/);
  assert.match(pageScript, /startViewportPinch\(viewport\)/);
  assert.match(pageScript, /state\.pinch\.startZoom \* distance \/ state\.pinch\.startDistance/);
  assert.match(pageScript, /selectPixelFromPointer\(event\)/);
  assert.doesNotMatch(pageScript, /resultCanvas\.addEventListener\("click"/);
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
