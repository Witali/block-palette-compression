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

test("defaults to 64 shared palettes with 64 colors each", () => {
  assert.match(
    html,
    /<select id="global-color-count" name="globalColorCount">[\s\S]*?<option value="64" selected data-i18n="block\.global64">/
  );
  assert.match(
    html,
    /<select id="palette-count" name="paletteCount">[\s\S]*?<option value="64" selected data-i18n="block\.paletteCount64">/
  );
});

test("offers researched quality presets immediately after the image selector", () => {
  const imageIndex = html.indexOf('id="image-url"');
  const presetIndex = html.indexOf('id="quality-preset"');
  const blockSizeIndex = html.indexOf('id="block-size"');

  assert.ok(imageIndex >= 0);
  assert.ok(presetIndex > imageIndex);
  assert.ok(blockSizeIndex > presetIndex);
  assert.match(
    html,
    /<select id="quality-preset" name="qualityPreset">\s*<option value="" selected data-i18n="block\.presetNone">/
  );

  for (const value of ["1.5", "2", "2.5", "3", "4", "5", "6", "8"]) {
    assert.match(html, new RegExp(`<option value="${value.replace(".", "\\.")}">${value} bpp</option>`));
  }

  assert.match(source, /qualityPresetSelect\.addEventListener\("change", applyQualityPreset\)/);
  assert.match(source, /"1\.5": \{ blockSize: 4, localColorCount: 2, globalColorCount: 8, paletteCount: 2 \}/);
  assert.match(source, /"2": \{ blockSize: 4, localColorCount: 2, globalColorCount: 128, paletteCount: 2 \}/);
  assert.match(source, /"2\.5": \{ blockSize: 8, localColorCount: 4, globalColorCount: 64, paletteCount: 32 \}/);
  assert.match(source, /"3": \{ blockSize: 8, localColorCount: 4, globalColorCount: 256, paletteCount: 64 \}/);
  assert.match(source, /"4": \{ blockSize: 8, localColorCount: 8, globalColorCount: 128, paletteCount: 16 \}/);
  assert.match(source, /"5": \{ blockSize: 16, localColorCount: 16, globalColorCount: 256, paletteCount: 64 \}/);
  assert.match(source, /"6": \{ blockSize: 8, localColorCount: 16, globalColorCount: 128, paletteCount: 32 \}/);
  assert.match(source, /"8": \{ blockSize: 4, localColorCount: 8, globalColorCount: 256, paletteCount: 64 \}/);
  assert.match(source, /paletteColorBitsSelect\.value = "24"/);
  assert.match(source, /colorSpaceSelect\.value = "rgb"/);
  assert.match(source, /diversityInput\.value = "0"/);
  assert.match(source, /refinementPassesSelect\.value = "4"/);
  assert.match(source, /qualityPresetSelect\.disabled = busy/);
});

test("offers zero to four refinement passes and defaults to one", () => {
  assert.match(html, /<select id="refinement-passes" name="refinementPasses">/);

  for (const count of [0, 1, 2, 3, 4]) {
    assert.match(html, new RegExp(`<option value="${count}"(?: selected)?>${count}</option>`));
  }

  assert.match(html, /<option value="1" selected>1<\/option>/);
  assert.match(source, /const refinementPassesSelect = document\.getElementById\("refinement-passes"\)/);
  assert.match(source, /refinementPasses: Number\(refinementPassesSelect\.value\)/);
  assert.match(source, /refinementPassesSelect\.disabled = busy/);
  assert.match(source, /refinementPasses: result\.refinementPasses/);
  assert.match(source, /refinementIterations: result\.refinementIterations/);
  assert.match(optimizerSource, /refinementPasses: searchOptions\.refinementPasses === undefined/);
});

test("uses source-snapped K-medoids as the default clustering method", () => {
  assert.match(
    html,
    /<option value="k-medoids" selected data-i18n="block\.kmedoids">K-medoids · source colors<\/option>/
  );
  assert.doesNotMatch(html, /<option value="k-means" selected/);
  assert.match(source, /clusteringMethodSelect\.value = "k-medoids"/);
  assert.match(source, /if \(value === "k-medoids"\) \{\s*return t\("block\.kmedoids"\);/);
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
  assert.match(source, /viewport\.addEventListener\("pointerdown", startViewportPointer\)/);
  assert.match(source, /function startViewportPointer\(event\)[\s\S]*?startViewportDrag\(event\)/);
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

test("offers the viewer zoom controls for both compression previews", () => {
  assert.match(html, /id="zoom-out"[^>]*disabled/);
  assert.match(html, /id="zoom-in"[^>]*disabled/);
  assert.match(html, /id="actual-size"[^>]*aria-pressed="false"[^>]*disabled/);
  assert.match(html, /id="fit-image"[^>]*aria-pressed="true"[^>]*disabled/);
  assert.match(source, /viewMode: "fit"/);
  assert.match(source, /zoomOutButton\.addEventListener\("click", \(\) => setZoom\(state\.zoom \/ ZOOM_FACTOR\)\)/);
  assert.match(source, /zoomInButton\.addEventListener\("click", \(\) => setZoom\(state\.zoom \* ZOOM_FACTOR\)\)/);
  assert.match(source, /actualSizeButton\.addEventListener\("click", showActualSize\)/);
  assert.match(source, /fitImageButton\.addEventListener\("click", fitImage\)/);
  assert.match(source, /setViewMode\("actual"\)/);
  assert.match(source, /setViewMode\("fit"\)/);
  assert.match(source, /setViewMode\("custom"\)/);
  assert.match(source, /state\.imageWidth \* state\.zoom/);
  assert.doesNotMatch(source, /displayBaseScale/);
  assert.match(css, /#actual-size\[aria-pressed="true"\]/);
  assert.match(css, /#fit-image\[aria-pressed="true"\]/);
});

test("pinch-zooms either compression preview on touch devices", () => {
  assert.match(css, /\.canvas-viewport \{[\s\S]*?touch-action: none;/);
  assert.match(source, /touches: new Map\(\)/);
  assert.match(source, /pinch: null/);
  assert.match(source, /viewport\.addEventListener\("pointerdown", startViewportPointer\)/);
  assert.match(source, /if \(event\.pointerType === "touch"\) \{\s*startViewportTouch\(event\)/);
  assert.match(source, /startViewportPinch\(viewport\)/);
  assert.match(source, /state\.pinch\.startZoom \* distance \/ state\.pinch\.startDistance/);
  assert.match(
    source,
    /setZoom\(nextZoom, state\.pinch\.viewport, center\.x, center\.y, false, \{/
  );
  assert.match(source, /function getTouchDistance\(first, second\)/);
  assert.match(source, /function getTouchCenter\(first, second\)/);
});

test("highlights the selected block even when the grid is hidden", () => {
  assert.match(source, /if \(showGridInput\.checked\) \{/);
  assert.doesNotMatch(source, /if \(!result \|\| !showGridInput\.checked\)/);
  assert.match(source, /context\.fillStyle = "rgba\(41, 182, 255, 0\.24\)"/);
  assert.match(source, /context\.strokeStyle = "#7ddcff"/);
});

test("hides the block grid by default and vertically aligns its control", () => {
  assert.match(html, /<input id="show-grid" type="checkbox">/);
  assert.doesNotMatch(html, /<input id="show-grid" type="checkbox" checked>/);
  assert.match(css, /\.result-caption label \{[\s\S]*?display: inline-flex;[\s\S]*?align-items: center;/);
  assert.match(css, /\.result-caption input \{[^}]*margin: 0;/);
});

test("aligns preview headers and keeps zoom controls compact", () => {
  assert.match(css, /figcaption \{[\s\S]*?height: 52px;[\s\S]*?padding: 8px 14px;/);
  assert.match(css, /\.result-caption > :first-child \{[^}]*text-overflow: ellipsis;/);
  assert.match(css, /\.result-caption-controls \{[^}]*flex-wrap: nowrap;/);
  assert.match(
    css,
    /\.zoom-controls button \{[^}]*min-width: 30px;[^}]*min-height: 30px;[^}]*height: 30px;/
  );
  assert.match(css, /@media \(max-width: 820px\) \{\s*\.comparison \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /@media \(max-width: 430px\) \{[\s\S]*?figcaption \{ height: auto; \}/);
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
