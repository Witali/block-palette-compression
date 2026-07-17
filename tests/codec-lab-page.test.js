"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const page = read("codec-lab.html");
const styles = read("codec-lab.css");
const script = read("src/pages/codec-lab-page.js");
const encoderRuntime = read("src/encoders/codec-encoder-runtime.js");
const home = read("index.html");
const serviceWorker = read("service-worker.js");

test("combines BPAL, DCTBS2, and BPDH behind one format selector", () => {
  assert.match(page, /id="codec-format"/);
  for (const format of ["bpal", "dct", "bpdh"]) {
    assert.match(page, new RegExp(`value="${format}"`));
    assert.match(page, new RegExp(`data-format-panel="${format}"`));
    assert.match(script, new RegExp(`${format}: create[A-Z][A-Za-z]+Adapter\\(\\)`));
  }
  assert.match(script, /panel\.hidden = panel\.dataset\.formatPanel !== state\.format/);
});

test("uses one comparison and coordinate inspector for every codec", () => {
  assert.equal((page.match(/id="source-canvas"/g) || []).length, 1);
  assert.equal((page.match(/id="result-canvas"/g) || []).length, 1);
  assert.equal((page.match(/id="difference-canvas"/g) || []).length, 1);
  assert.match(page, /id="show-difference" type="checkbox" disabled/);
  assert.match(page, /src\/pages\/codec-comparison-view\.js/);
  assert.match(script, /new root\.CodecComparisonView/);
  assert.match(script, /differenceCanvas: elements\.differenceCanvas/);
  assert.match(script, /differenceToggle: elements\.showDifference/);
  assert.match(script, /onSelect: \(x, y\) => renderInspector\(x, y\)/);
  assert.match(script, /const adapter = currentAdapter\(\)/);
  assert.match(script, /adapter\.sample\(result, px, py\)/);
  assert.match(script, /adapter\.inspect\(result, px, py\)/);
  assert.match(script, /const blockSize = image\.blockSize \|\| image\.codingUnitSize/);
  assert.match(page, /id="structure-flow"/);
  assert.match(page, /id="block-details-body"/);
  assert.match(page, /<details id="inspector" class="storage-section lab-disclosure lab-inspector">/);
  assert.doesNotMatch(page, /id="block-details"/);
  assert.doesNotMatch(page, /data-i18n="hybrid\.blockDetailsTitle"/);
  assert.doesNotMatch(script, /blockDetailsSummary/);
  assert.match(page, /class="pixel-inspector pixel-inspector-grid"/);
  assert.match(script, /const sampled = normalizeColor\(adapter\.sample\(result, px, py\)\)/);
  assert.match(script, /a: color\.a \?\? 255/);
  assert.match(script, /cell\.textContent = formatCoefficient\(value\)/);
  assert.match(script, /function formatCoefficient\(value\)[\s\S]*?toPrecision\(4\)/);
  assert.match(script, /figure\.classList\.toggle\("is-wide", matrix\.width > 8\)/);
});

test("keeps encoding in format-specific workers", () => {
  assert.match(encoderRuntime, /src\/palette\/block-palette-worker\.js/);
  assert.match(encoderRuntime, /src\/dct\/dct-worker\.js/);
  assert.match(encoderRuntime, /src\/hybrid\/bpdh-worker\.js/);
  assert.match(script, /root\.CodecEncoderRuntime\.createWorker\(format\)/);
  assert.match(script, /function runWorker\(/);
  assert.match(page, /id="progress-dialog"/);
  assert.match(page, /id="progress-cancel"/);
});

test("shows a format-specific expandable binary layout reference", () => {
  assert.match(page, /<details id="format-guide" class="storage-section lab-disclosure lab-format-guide">/);
  assert.match(page, /id="format-guide-summary"/);
  assert.match(page, /id="format-guide-body"/);
  assert.match(page, /data-i18n="lab\.formatGuideTitle"/);
  assert.match(script, /formatGuide: createBpalFormatGuide/);
  assert.match(script, /formatGuide: createDctFormatGuide/);
  assert.match(script, /formatGuide: createBpdhFormatGuide/);
  assert.match(script, /function renderFormatGuide\(\)[\s\S]*?renderFileMap\(guide\.sections\)[\s\S]*?renderHeaderTable\(guide\.header\)[\s\S]*?renderPackingList\(guide\.packing\)/);
  assert.match(script, /guideHeaderField\("bits 32–35", 4, "version", "5"\)/);
  assert.match(script, /guideHeaderField\("52–55 B", 32, "flags"/);
  assert.match(script, /guideHeaderField\("44–47 B", 32, "dctBits"/);
  assert.match(script, /guideBit\("mask AC1…AC32", 32/);
  assert.match(script, /guideBit\("unit 0", 1, "map", "0 \/ 1"\)/);
  assert.match(script, /function updateFormatUi\(\)[\s\S]*?renderFormatGuide\(\)/);
  assert.match(script, /function markSettingsChanged\(\)[\s\S]*?renderFormatGuide\(\)/);
  assert.match(styles, /\.lab-disclosure > summary/);
  assert.match(styles, /\.lab-format-table/);
  assert.match(styles, /\.lab-bit-strip/);
  assert.match(styles, /\.lab-file-segment\.is-dct/);
});

test("shows selected and shared BPAL palettes only in BPAL mode", () => {
  assert.match(page, /id="bpal-palette-sections" class="lab-bpal-palettes"/);
  assert.match(page, /id="lab-bpal-block-palette" class="block-palette"/);
  assert.match(page, /id="lab-bpal-global-palette" class="global-palette"/);
  assert.match(page, /data-i18n="block\.selectedPalette"/);
  assert.match(page, /data-i18n="block\.sharedPalette"/);
  assert.match(script, /elements\.bpalPaletteSections\.hidden = state\.format !== "bpal"/);
  assert.match(script, /if \(state\.format === "bpal"\) renderBpalPalettes\(result\.raw, px, py\)/);
  assert.match(script, /function renderBpalPalettes\(image, selectedX, selectedY\)/);
  assert.match(script, /function renderBpalGlobalPalettes\(image\)/);
  assert.match(script, /className = "block-swatch"/);
  assert.match(script, /className = "shared-palette-group"/);
  assert.match(script, /className = `global-swatch\$\{pixelCount === 0 \? " is-unused" : ""\}`/);
  assert.match(styles, /\.lab-bpal-palettes\[hidden\] \{[\s\S]*?display: none;/);
});

test("keeps the BPAL quality preset synchronized with its component fields", () => {
  assert.match(script, /elements\.bpalBlockSize\.addEventListener\("change", \(\) => \{[\s\S]*?updateBpalLocalColorOptions\(\);[\s\S]*?syncBpalPresetFromSettings\(\);/);
  assert.match(script, /\[elements\.bpalLocalColors, elements\.bpalGlobalColors, elements\.bpalPaletteCount\]/);
  assert.match(script, /control\.addEventListener\("change", syncBpalPresetFromSettings\)/);
  assert.match(script, /function syncBpalPresetFromSettings\(\)[\s\S]*?Object\.entries\(QUALITY_PRESETS\)\.find/);
  assert.match(script, /preset\.blockSize === blockSize[\s\S]*?preset\.localColorCount === localColorCount[\s\S]*?preset\.globalColorCount === globalColorCount[\s\S]*?preset\.paletteCount === paletteCount/);
  assert.match(script, /elements\.bpalQualityPreset\.value = match \? match\[0\] : ""/);
});

test("previews a changed source immediately and converts only after the encode button is pressed", () => {
  const startup = script.slice(0, script.indexOf("function collectElements"));
  const bindings = script.slice(script.indexOf("function bindEvents"), script.indexOf("function selectInitialFormat"));
  const upload = script.slice(script.indexOf("function handleUpload"), script.indexOf("function processCurrentFormat"));
  const formatUi = script.slice(script.indexOf("function updateFormatUi"), script.indexOf("function currentAdapter"));

  assert.doesNotMatch(startup, /loadUrl\(|loadBlob\(|processCurrentFormat\(/);
  assert.match(bindings, /controls\.addEventListener\("submit"[\s\S]*?processSelection\(\)/);
  assert.match(bindings, /imageUrl\.addEventListener\("change"[\s\S]*?previewSelectedSource\(t\("lab\.sourceChanged"\)\)/);
  assert.doesNotMatch(bindings, /processCurrentFormat\(/);
  assert.match(script, /async function processSelection\(\)[\s\S]*?await loadSelectedSource\(source\)[\s\S]*?await processCurrentFormat\(\)/);
  assert.match(script, /async function previewSelectedSource\(message\)[\s\S]*?markSourceChanged\(message\)[\s\S]*?await loadSelectedSource\(selectedSource\(\)\)/);
  assert.match(script, /async function loadSelectedSource\(source\)[\s\S]*?await loadBlob\([\s\S]*?await loadUrl\(/);
  assert.doesNotMatch(upload, /processCurrentFormat\(/);
  assert.match(upload, /localOption\.dataset\.pendingFile = "true"/);
  assert.match(upload, /await previewSelectedSource\(t\("lab\.fileSelected"/);
  assert.doesNotMatch(formatUi, /processCurrentFormat\(/);
  assert.match(formatUi, /resetMetrics\(false\)/);
});

test("styles the unified settings, comparison, structure, and inspector", () => {
  assert.match(styles, /\.format-picker/);
  assert.match(styles, /\.format-picker select option \{[\s\S]*?background: #171d25;[\s\S]*?color: #eef3f8;/);
  assert.match(styles, /\.lab-header \{[\s\S]*?width: 100%;[\s\S]*?justify-content: stretch;/);
  assert.match(styles, /\.lab-controls \{[\s\S]*?width: 100%;[\s\S]*?justify-self: stretch;/);
  assert.match(styles, /\.format-settings/);
  assert.match(styles, /column-gap: 14px;[\s\S]*?row-gap: 14px;/);
  assert.match(styles, /color: #aab5c2;[\s\S]*?font-size: var\(--font-size-sm\);[\s\S]*?font-weight: 650;[\s\S]*?letter-spacing: 0\.035em;[\s\S]*?text-transform: uppercase;/);
  assert.match(styles, /\.format-settings > label\.check-option > span \{[\s\S]*?letter-spacing: normal;[\s\S]*?text-transform: none;/);
  assert.match(styles, /\.format-settings select,[\s\S]*?\.format-settings input \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;/);
  assert.match(styles, /\.lab-comparison/);
  assert.match(styles, /\.lab-difference-canvas \{[\s\S]*?z-index: 1;/);
  assert.match(styles, /\.lab-difference-canvas\[hidden\] \{[\s\S]*?display: none;/);
  assert.match(styles, /\.lab-structure-flow/);
  assert.match(styles, /\.lab-block-details-body/);
  assert.match(styles, /\.lab-inspector-body \{[\s\S]*?padding: 18px;[\s\S]*?border-top: 1px solid #303a46;/);
  assert.doesNotMatch(styles, /\.lab-block-details-body \{[^}]*padding:/);
  assert.match(styles, /\.lab-coefficient-matrix/);
  assert.match(styles, /\.lab-coefficient-grid span \{[\s\S]*?font: 750 var\(--font-size-sm\)\/1 ui-monospace/);
  assert.match(styles, /\.lab-matrix-list \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.lab-coefficient-matrix\.is-wide \{[\s\S]*?grid-column: span 2;/);
  assert.match(styles, /@media \(max-width: 1500px\)[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test("links and caches the unified laboratory", () => {
  assert.match(home, /href="\.\/codec-lab\.html"/);
  assert.match(home, /data-i18n="home\.lab\.title"/);
  assert.match(serviceWorker, /"\.\/codec-lab\.html"/);
  assert.match(serviceWorker, /"\.\/codec-lab\.css"/);
  assert.match(serviceWorker, /"\.\/src\/pages\/codec-comparison-view\.js"/);
  assert.match(serviceWorker, /"\.\/src\/pages\/codec-lab-page\.js"/);
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
