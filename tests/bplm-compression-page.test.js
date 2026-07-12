"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "block-palette.html"), "utf8");
const source = fs.readFileSync(path.join(root, "src", "pages", "block-palette-page.js"), "utf8");

test("offers BPLM export after compression", () => {
  assert.match(html, /<button id="download-bplm-button"[^>]*data-i18n="block\.saveBplm"[^>]*>/);
  assert.match(html, /data-i18n-title="block\.saveBplmTitle"/);
  assert.match(source, /downloadBplmButton\.disabled = false/);
  assert.match(source, /BplmFormat\.encodeBplmFile\(state\.result\)/);
  assert.match(source, /application\/vnd\.block-palette-mipmap/);
  assert.match(source, /\.bplm`/);
});

test("loads the BPLM dependencies before the compression page", () => {
  const decoderIndex = html.indexOf("src/decoders/bpal-texture.js");
  const formatIndex = html.indexOf("src/palette/bplm-format.js");
  const pageIndex = html.indexOf("src/pages/block-palette-page.js");

  assert.ok(decoderIndex >= 0);
  assert.ok(formatIndex > decoderIndex);
  assert.ok(pageIndex > formatIndex);
});

test("pans both compression previews by dragging", () => {
  assert.match(source, /for \(const viewport of \[sourceViewport, resultViewport\]\)/);
  assert.match(source, /viewport\.addEventListener\("pointerdown", startViewportDrag\)/);
  assert.match(source, /drag\.viewport\.scrollLeft = drag\.scrollLeft - deltaX/);
  assert.match(source, /drag\.viewport\.scrollTop = drag\.scrollTop - deltaY/);
  assert.match(source, /synchronizeScroll\(/);
  assert.match(source, /selectBlockUnlessDragging/);
  assert.match(source, /const DRAG_DELAY_MS = 140/);
  assert.match(source, /event\.timeStamp - drag\.startedAt >= DRAG_DELAY_MS/);
  assert.match(source, /distance < DRAG_THRESHOLD/);
  assert.match(source, /if \(drag\.active && drag\.moved && drag\.viewport === resultViewport\)/);
});

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
