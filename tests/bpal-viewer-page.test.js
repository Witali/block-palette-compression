"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BlockPaletteFormat = require("../src/palette/block-palette-format.js");
const BplmFormat = require("../src/palette/bplm-format.js");
const english = require("../src/i18n/en.js");
const russian = require("../src/i18n/ru.js");
const { createBpalManifest } = require("../tools/generate-bpal-manifest.js");
const BpalExampleCatalog = require("../src/pages/bpal-example-catalog.js");

const root = path.resolve(__dirname, "..");
const viewerHtml = fs.readFileSync(path.join(root, "bpal-viewer.html"), "utf8");
const viewerSource = fs.readFileSync(path.join(root, "src", "pages", "bpal-viewer-page.js"), "utf8");
const pagesWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");

test("generates every bundled BPAL and BPLM image for the viewer", () => {
  const assetNames = fs.readdirSync(path.join(root, "assets", "bpal"))
    .filter((name) => /\.(?:bpal|bplm)$/i.test(name))
    .sort();
  const manifest = createBpalManifest(path.join(root, "assets", "bpal"));

  assert.deepEqual(manifest.files, assetNames);
  assert.equal(manifest.default, "stone-texture-wic.bplm");
  assert.match(viewerHtml, /<select id="example-image" disabled><\/select>/);
  assert.match(viewerSource, /BpalExampleCatalog\.loadManifest\(\)/);
  assert.match(viewerSource, /BpalExampleCatalog\.populateSelect\(exampleSelect, manifest\)/);
  assert.match(viewerHtml, /src="\.\/src\/pages\/bpal-example-catalog\.js\?v=1"/);
});

test("validates bundled BPAL manifest names in the shared catalog", () => {
  const manifest = createBpalManifest(path.join(root, "assets", "bpal"));
  const validated = BpalExampleCatalog.validateManifest(manifest);

  assert.deepEqual(validated, manifest);
  assert.notEqual(validated.files, manifest.files);
  assert.throws(
    () => BpalExampleCatalog.validateManifest({ ...manifest, files: ["../outside.bpal"] }),
    /Invalid bundled BPAL manifest entries/,
  );
  assert.throws(
    () => BpalExampleCatalog.validateManifest({ ...manifest, default: "missing.bplm" }),
    /Invalid default bundled BPAL image/,
  );
});

test("generates the BPAL manifest before uploading the Pages artifact", () => {
  const generateIndex = pagesWorkflow.indexOf("npm run generate:bpal-manifest");
  const uploadIndex = pagesWorkflow.indexOf("actions/upload-pages-artifact@v4");

  assert.ok(generateIndex >= 0);
  assert.ok(uploadIndex > generateIndex);
  assert.match(pagesWorkflow, /actions\/deploy-pages@v4/);
});

test("selects the WIC BPLM image by default", () => {
  const manifest = createBpalManifest(path.join(root, "assets", "bpal"));

  assert.equal(manifest.default, "stone-texture-wic.bplm");
  assert.equal(BpalExampleCatalog.validateManifest(manifest).default, manifest.default);
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
  const catalogIndex = viewerHtml.indexOf("src/pages/bpal-example-catalog.js");
  const pageIndex = viewerHtml.indexOf("src/pages/bpal-viewer-page.js");

  assert.ok(decoderIndex >= 0);
  assert.ok(formatIndex > decoderIndex);
  assert.ok(catalogIndex > formatIndex);
  assert.ok(pageIndex > catalogIndex);
});

test("selects fit by default and toggles between fit and actual size", () => {
  assert.match(viewerHtml, /id="fit-image"[^>]*aria-pressed="true"/);
  assert.match(viewerHtml, /id="actual-size"[^>]*aria-pressed="false"/);
  assert.match(viewerSource, /viewMode: "fit"/);
  assert.match(viewerSource, /actualSizeButton\.addEventListener\("click", showActualSize\)/);
  assert.match(viewerSource, /fitImageButton\.addEventListener\("click", fitImage\)/);
  assert.match(viewerSource, /setViewMode\("actual"\)/);
  assert.match(viewerSource, /setViewMode\("fit"\)/);
  assert.match(viewerSource, /setViewMode\("custom"\)/);
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
