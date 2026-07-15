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
