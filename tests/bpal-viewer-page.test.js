"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BlockPaletteFormat = require("../src/palette/block-palette-format.js");
const english = require("../src/i18n/en.js");
const russian = require("../src/i18n/ru.js");

const root = path.resolve(__dirname, "..");
const viewerHtml = fs.readFileSync(path.join(root, "bpal-viewer.html"), "utf8");

test("lists every bundled BPAL image in the viewer", () => {
  const assetNames = fs.readdirSync(path.join(root, "assets", "bpal"))
    .filter((name) => name.toLowerCase().endsWith(".bpal"))
    .sort();
  const listedNames = Array.from(
    viewerHtml.matchAll(/<option value="\.\/assets\/bpal\/([^"]+\.bpal)"(?: selected)?>/g),
    (match) => match[1],
  ).sort();

  assert.deepEqual(listedNames, assetNames);
});

test("selects the Alaska BPAL image by default", () => {
  assert.match(
    viewerHtml,
    /<option value="\.\/assets\/bpal\/landscape-alaska\.bpal" selected>/,
  );
});

test("decodes every bundled viewer image", () => {
  const assetDirectory = path.join(root, "assets", "bpal");

  for (const name of fs.readdirSync(assetDirectory)) {
    if (name.toLowerCase().endsWith(".bpal")) {
      const bytes = fs.readFileSync(path.join(assetDirectory, name));
      const image = BlockPaletteFormat.decodeBlockPaletteFile(bytes);

      assert.ok(image.width > 0, name);
      assert.ok(image.height > 0, name);
    }
  }
});

test("shows block colors and total file bits per pixel", () => {
  const viewerSource = fs.readFileSync(path.join(root, "src", "pages", "bpal-viewer-page.js"), "utf8");

  assert.match(viewerSource, /localColors: decoded\.localColorCount/);
  assert.match(viewerSource, /decoded\.storage\.totalBytes \* 8 \/ \(decoded\.width \* decoded\.height\)/);

  for (const catalog of [english, russian]) {
    assert.match(catalog["viewer.bpalStatus"], /\{localColors\}/);
    assert.match(catalog["viewer.bpalStatus"], /\{bitsPerPixel\}/);
  }
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
