"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pageFiles = [
  "index.html",
  "block-palette.html",
  "bpal-viewer.html",
  "dct-compression.html",
  "bpdh.html",
  "codec-lab.html",
  "cube.html",
  "cube-bpal-sampler.html",
];
const styleFiles = [
  "home.css",
  "block-palette.css",
  "bpal-viewer.css",
  "dct-compression.css",
  "bpdh.css",
  "codec-lab.css",
  "style.css",
  "bpal-sampler.css",
  "i18n.css",
];

test("defines one shared three-size interface type scale", () => {
  const scale = read("typography.css");
  assert.match(scale, /--font-size-sm:\s*12px/);
  assert.match(scale, /--font-size-md:\s*14px/);
  assert.match(scale, /--font-size-lg:\s*18px/);

  for (const page of pageFiles) {
    assert.match(read(page), /href="\.\/typography\.css\?v=type-scale-1"/, page);
  }
  assert.match(read("service-worker.js"), /"\.\/typography\.css"/);
});

test("does not use sub-12px interface fonts outside the scaled SVG diagram", () => {
  for (const file of styleFiles) {
    const source = read(file).replace(/font:\s*850 0\.36px\/1 ui-monospace, Consolas, monospace;/, "");
    const declarations = source.matchAll(/font-size:\s*([\d.]+)px|font:\s*[^;\n]*?([\d.]+)px\//g);
    for (const match of declarations) {
      const size = Number(match[1] || match[2]);
      assert.ok(size >= 20, `${file} still contains an unscaled ${size}px font`);
    }
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
