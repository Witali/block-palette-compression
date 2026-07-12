"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BlockPaletteFormat = require("../src/palette/block-palette-format.js");
const BplmFormat = require("../src/palette/bplm-format.js");
const english = require("../src/i18n/en.js");
const russian = require("../src/i18n/ru.js");

const root = path.resolve(__dirname, "..");
const viewerHtml = fs.readFileSync(path.join(root, "bpal-viewer.html"), "utf8");
const viewerSource = fs.readFileSync(path.join(root, "src", "pages", "bpal-viewer-page.js"), "utf8");

test("lists every bundled BPAL and BPLM image in the viewer", () => {
  const assetNames = fs.readdirSync(path.join(root, "assets", "bpal"))
    .filter((name) => /\.(?:bpal|bplm)$/i.test(name))
    .sort();
  const listedNames = Array.from(
    viewerHtml.matchAll(/<option value="\.\/assets\/bpal\/([^"]+\.(?:bpal|bplm))"(?: selected)?>/g),
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

test("decodes every bundled block-palette viewer image", () => {
  const assetDirectory = path.join(root, "assets", "bpal");

  for (const name of fs.readdirSync(assetDirectory)) {
    if (/\.(?:bpal|bplm)$/i.test(name)) {
      const bytes = fs.readFileSync(path.join(assetDirectory, name));
      const image = name.toLowerCase().endsWith(".bplm")
        ? BplmFormat.decodeBplmFile(bytes)
        : BlockPaletteFormat.decodeBlockPaletteFile(bytes);

      assert.ok(image.width > 0, name);
      assert.ok(image.height > 0, name);
    }
  }
});

test("shows BPAL parameters in compression-settings order", () => {
  assert.match(viewerSource, /localColors: decoded\.localColorCount/);
  assert.match(viewerSource, /decoded\.storage\.totalBytes \* 8 \/ \(decoded\.width \* decoded\.height\)/);

  for (const catalog of [english, russian]) {
    const status = catalog["viewer.bpalStatus"];
    const positions = ["{blockSize}", "{localColors}", "{colors}", "{bitsPerPixel}"]
      .map((parameter) => status.indexOf(parameter));

    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  }
});

test("switches between reconstructed BPLM mip levels", () => {
  assert.match(viewerHtml, /id="mip-previous"[^>]*disabled/);
  assert.match(viewerHtml, /id="mip-next"[^>]*disabled/);
  assert.match(viewerHtml, /accept="\.bpal,\.bplm,image\/\*"/);
  assert.match(viewerSource, /BplmFormat\.decodeBplmFile\(bytes\)/);
  assert.match(viewerSource, /BplmFormat\.reconstructBplmMipPixels\(image, mipIndex\)/);
  assert.match(viewerSource, /showBplmMip\(state\.mipIndex - 1\)/);
  assert.match(viewerSource, /showBplmMip\(state\.mipIndex \+ 1\)/);
});

test("loads BPLM dependencies before the viewer page", () => {
  const decoderIndex = viewerHtml.indexOf("src/decoders/bpal-texture.js");
  const formatIndex = viewerHtml.indexOf("src/palette/bplm-format.js");
  const pageIndex = viewerHtml.indexOf("src/pages/bpal-viewer-page.js");

  assert.ok(decoderIndex >= 0);
  assert.ok(formatIndex > decoderIndex);
  assert.ok(pageIndex > formatIndex);
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
