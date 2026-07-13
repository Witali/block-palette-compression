"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "block-palette.html"), "utf8");
const source = fs.readFileSync(path.join(root, "src", "pages", "block-palette-page.js"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "src", "palette", "block-palette-worker.js"), "utf8");
const optimizerSource = fs.readFileSync(path.join(root, "src", "palette", "block-palette-optimizer.js"), "utf8");
const css = fs.readFileSync(path.join(root, "block-palette.css"), "utf8");

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

test("offers power-of-two shared palette counts and applies them to compression", () => {
  assert.match(html, /<select id="palette-count" name="paletteCount">/);

  for (const count of [1, 2, 4, 8, 16, 32, 64, 128]) {
    assert.match(html, new RegExp(`<option value="${count}"`));
  }

  assert.match(source, /paletteCount: Number\(paletteCountSelect\.value\)/);
  assert.match(source, /result\.blockPaletteSelectors\[state\.selectedBlock\]/);
  assert.match(source, /paletteBase \+ globalIndex/);
  assert.match(source, /result\.storage\.blockPaletteSelectorBits \+ result\.storage\.blockPaletteBits/);
});

test("enables four-pass iterative refinement by default and lets users disable it", () => {
  assert.match(
    html,
    /<input id="iterative-refinement" name="iterativeRefinement" type="checkbox" checked>/
  );
  assert.match(source, /const iterativeRefinementInput = document\.getElementById\("iterative-refinement"\)/);
  assert.match(source, /refinementPasses: iterativeRefinementInput\.checked \? 4 : 0/);
  assert.match(source, /iterativeRefinementInput\.disabled = busy/);
  assert.match(optimizerSource, /refinementPasses: searchOptions\.refinementPasses === undefined/);
});

test("shows RGB PSNR for the reconstructed image", () => {
  assert.match(
    html,
    /data-i18n="common\.psnr"[^>]*data-i18n-title="common\.psnrTitle"[^>]*>PSNR RGB<\/span><strong id="metric-psnr">/
  );
  assert.match(source, /const metricPsnr = document\.getElementById\("metric-psnr"\)/);
  assert.match(source, /10 \* Math\.log10\(\(255 \* 255\) \/ mse\)/);
  assert.match(source, /return mse === 0 \? Infinity/);
  assert.match(source, /metricPsnr\.textContent = formatPsnr\(result\.meanSquaredError\)/);
  assert.match(source, /psnr: calculatePsnr\(result\.meanSquaredError\)/);
});

test("pans both compression previews by dragging", () => {
  assert.match(source, /for \(const viewport of \[sourceViewport, resultViewport\]\)/);
  assert.match(source, /viewport\.addEventListener\("pointerdown", startViewportDrag\)/);
  assert.match(source, /drag\.viewport\.scrollLeft = drag\.scrollLeft - deltaX/);
  assert.match(source, /drag\.viewport\.scrollTop = drag\.scrollTop - deltaY/);
  assert.match(source, /synchronizeScroll\(/);
  assert.match(source, /const DRAG_DELAY_MS = 140/);
  assert.match(source, /event\.timeStamp - drag\.startedAt >= DRAG_DELAY_MS/);
  assert.match(source, /distance < DRAG_THRESHOLD/);
  assert.match(source, /viewport === resultViewport && isPointerInsideResultCanvas\(event\)/);
  assert.match(source, /selectBlockFromPointer\(event\)/);
  assert.doesNotMatch(source, /resultCanvas\.addEventListener\("click"/);
});

test("highlights the selected block even when the grid is hidden", () => {
  assert.match(source, /if \(showGridInput\.checked\) \{/);
  assert.doesNotMatch(source, /if \(!result \|\| !showGridInput\.checked\)/);
  assert.match(source, /context\.fillStyle = "rgba\(41, 182, 255, 0\.24\)"/);
  assert.match(source, /context\.strokeStyle = "#7ddcff"/);
});

test("shows real compression stages in a cancellable modal progress dialog", () => {
  assert.match(html, /<dialog id="progress-dialog"/);
  assert.match(html, /<progress id="progress-bar" max="100" value="0">/);
  assert.match(html, /id="progress-cluster-count"/);
  assert.match(source, /event\.data\.type === "progress"/);
  assert.match(source, /progressDialog\.showModal\(\)/);
  assert.match(source, /function cancelProcessing\(\)/);
  assert.match(workerSource, /type: "progress", progress/);
  assert.match(css, /\.progress-dialog::backdrop/);
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
