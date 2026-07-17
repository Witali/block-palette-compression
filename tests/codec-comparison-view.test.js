"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/pages/codec-comparison-view.js"), "utf8");

test("provides one reusable two-image comparison controller", () => {
  assert.match(source, /class CodecComparisonView/);
  assert.match(source, /setSource\(imageData\)/);
  assert.match(source, /setResult\(imageData\)/);
  assert.match(source, /setOverlayRenderer\(renderer\)/);
  assert.match(source, /setSelectedPixel\(x, y, notify = false\)/);
  assert.match(source, /root\.CodecComparisonView = CodecComparisonView/);
});

test("keeps preview interaction identical for every codec adapter", () => {
  assert.match(source, /synchronizeScroll\(source, target\)/);
  assert.match(source, /if \(!event\.ctrlKey/);
  assert.match(source, /startPinch\(viewport\)/);
  assert.match(source, /selectOnRelease/);
  assert.match(source, /updateImageRendering\(\)/);
  assert.match(source, /setViewMode\("fit"\)/);
});
