"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const page = read("codec-lab.html");
const styles = read("codec-lab.css");
const script = read("src/pages/codec-lab-page.js");
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
  assert.match(page, /src\/pages\/codec-comparison-view\.js/);
  assert.match(script, /new root\.CodecComparisonView/);
  assert.match(script, /onSelect: \(x, y\) => renderInspector\(x, y\)/);
  assert.match(script, /const adapter = currentAdapter\(\)/);
  assert.match(script, /adapter\.sample\(result, px, py\)/);
  assert.match(script, /adapter\.inspect\(result, px, py\)/);
  assert.match(script, /const blockSize = image\.blockSize \|\| image\.codingUnitSize/);
  assert.match(page, /id="structure-flow"/);
  assert.match(page, /id="block-details-body"/);
});

test("keeps encoding in format-specific workers", () => {
  assert.match(script, /src\/palette\/block-palette-worker\.js/);
  assert.match(script, /src\/dct\/dct-worker\.js/);
  assert.match(script, /src\/hybrid\/bpdh-worker\.js/);
  assert.match(script, /function runWorker\(/);
  assert.match(page, /id="progress-dialog"/);
  assert.match(page, /id="progress-cancel"/);
});

test("styles the unified settings, comparison, structure, and inspector", () => {
  assert.match(styles, /\.format-picker/);
  assert.match(styles, /\.format-picker select option \{[\s\S]*?background: #171d25;[\s\S]*?color: #eef3f8;/);
  assert.match(styles, /\.lab-header \{[\s\S]*?width: 100%;[\s\S]*?justify-content: stretch;/);
  assert.match(styles, /\.lab-controls \{[\s\S]*?width: 100%;[\s\S]*?justify-self: stretch;/);
  assert.match(styles, /\.format-settings/);
  assert.match(styles, /\.lab-comparison/);
  assert.match(styles, /\.lab-structure-flow/);
  assert.match(styles, /\.lab-block-details-body/);
  assert.match(styles, /\.lab-coefficient-matrix/);
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
