"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BlockPaletteFormat = require("../src/palette/block-palette-format.js");
const BplmFormat = require("../src/palette/bplm-format.js");
const BpdhFormat = require("../src/hybrid/bpdh-format.js");
const english = require("../src/i18n/en.js");
const russian = require("../src/i18n/ru.js");
const {
  createBpalManifest,
  createBpdhManifest,
} = require("../tools/generate-bpal-manifest.js");
const BpalExampleCatalog = require("../src/pages/bpal-example-catalog.js");

const root = path.resolve(__dirname, "..");
const viewerHtml = fs.readFileSync(path.join(root, "bpal-viewer.html"), "utf8");
const viewerSource = fs.readFileSync(path.join(root, "src", "pages", "bpal-viewer-page.js"), "utf8");
const viewerCss = fs.readFileSync(path.join(root, "bpal-viewer.css"), "utf8");
const pagesWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");

test("generates every bundled BPAL, BPLM, and BPDH image for the viewer", () => {
  const assetNames = fs.readdirSync(path.join(root, "assets", "bpal"))
    .filter((name) => /\.(?:bpal|bplm)$/i.test(name))
    .sort();
  const bpdhAssetNames = fs.readdirSync(path.join(root, "assets", "bpdh"))
    .filter((name) => /\.bpdh$/i.test(name))
    .sort();
  const manifest = createBpalManifest(path.join(root, "assets", "bpal"));
  const bpdhManifest = createBpdhManifest(path.join(root, "assets", "bpdh"));

  assert.deepEqual(manifest.files, assetNames);
  assert.deepEqual(bpdhManifest.files, bpdhAssetNames);
  assert.equal(manifest.default, "stone-texture-wic.bplm");
  assert.equal(bpdhManifest.default, "landscape-alaska.bpdh");
  assert.ok(viewerHtml.indexOf('id="example-type"') < viewerHtml.indexOf('id="example-image"'));
  assert.match(viewerHtml, /<option value="bpal"[^>]*>BPAL \/ BPLM<\/option>/);
  assert.match(viewerHtml, /<option value="bpdh"[^>]*>BPDH<\/option>/);
  assert.match(viewerHtml, /<select id="example-image" disabled><\/select>/);
  assert.match(viewerSource, /BpalExampleCatalog\.loadManifestForType\(type\)/);
  assert.match(viewerSource, /BpalExampleCatalog\.populateSelectForType\(/);
  assert.match(viewerSource, /loadBundledExamplesForType\(exampleTypeSelect\.value\)/);
  assert.match(viewerHtml, /src="\.\/src\/pages\/bpal-example-catalog\.js\?v=image-viewer-1"/);
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

test("validates bundled BPDH manifest names in the shared catalog", () => {
  const manifest = createBpdhManifest(path.join(root, "assets", "bpdh"));
  const validated = BpalExampleCatalog.validateManifestForType(manifest, "bpdh");

  assert.deepEqual(validated, manifest);
  assert.equal(BpalExampleCatalog.CATALOGS.bpdh.manifestUrl, "./assets/bpdh/manifest.json");
  assert.equal(BpalExampleCatalog.CATALOGS.bpdh.assetDirectory, "./assets/bpdh/");
  assert.throws(
    () => BpalExampleCatalog.validateManifestForType({ ...manifest, files: ["../outside.bpdh"] }, "bpdh"),
    /Invalid bundled BPDH manifest entries/,
  );
  assert.throws(
    () => BpalExampleCatalog.validateManifestForType({ ...manifest, files: ["image.bpal"] }, "bpdh"),
    /Invalid bundled BPDH manifest entries/,
  );
});

test("generates both image manifests before uploading the Pages artifact", () => {
  const generateIndex = pagesWorkflow.indexOf("npm run generate:image-manifests");
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
  assert.match(viewerSource, /palettes: decoded\.paletteCount/);
  assert.match(viewerSource, /decoded\.storage\.totalBytes \* 8 \/ \(decoded\.width \* decoded\.height\)/);

  for (const catalog of [english, russian]) {
    const status = catalog["viewer.bpalStatus"];
    const positions = ["{blockSize}", "{localColors}", "{palettes}", "{colors}", "{bitsPerPixel}"]
      .map((parameter) => status.indexOf(parameter));

    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  }
});

test("switches between reconstructed BPLM mip levels", () => {
  assert.match(viewerHtml, /id="mip-previous"[^>]*disabled/);
  assert.match(viewerHtml, /id="mip-next"[^>]*disabled/);
  assert.match(viewerHtml, /accept="\.bpal,\.bplm,\.bpdh,image\/\*"/);
  assert.match(viewerSource, /BplmFormat\.decodeBplmFile\(bytes\)/);
  assert.match(viewerSource, /BplmFormat\.reconstructBplmMipPixels\(image, mipIndex\)/);
  assert.match(viewerSource, /showBplmMip\(state\.mipIndex - 1\)/);
  assert.match(viewerSource, /showBplmMip\(state\.mipIndex \+ 1\)/);
});

test("loads BPLM and BPDH dependencies before the viewer page", () => {
  const decoderIndex = viewerHtml.indexOf("src/decoders/bpal-texture.js");
  const formatIndex = viewerHtml.indexOf("src/palette/bplm-format.js");
  const dctIndex = viewerHtml.indexOf("src/hybrid/dct420.js");
  const bpdhIndex = viewerHtml.indexOf("src/hybrid/bpdh-format.js");
  const catalogIndex = viewerHtml.indexOf("src/pages/bpal-example-catalog.js");
  const pageIndex = viewerHtml.indexOf("src/pages/bpal-viewer-page.js");

  assert.ok(decoderIndex >= 0);
  assert.ok(formatIndex > decoderIndex);
  assert.ok(dctIndex > formatIndex);
  assert.ok(bpdhIndex > dctIndex);
  assert.ok(catalogIndex > bpdhIndex);
  assert.ok(pageIndex > catalogIndex);
});

test("decodes every bundled BPDH viewer image", () => {
  const assetDirectory = path.join(root, "assets", "bpdh");

  for (const name of fs.readdirSync(assetDirectory)) {
    if (/\.bpdh$/i.test(name)) {
      const image = BpdhFormat.decodeBpdhFile(fs.readFileSync(path.join(assetDirectory, name)));

      assert.ok(image.width > 0, name);
      assert.ok(image.height > 0, name);
    }
  }
});

test("names the generalized viewer in both languages", () => {
  assert.match(viewerHtml, /<title data-i18n="viewer\.title">Image Viewer<\/title>/);
  assert.equal(english["home.viewer.title"], "Image Viewer");
  assert.equal(english["viewer.title"], "Image Viewer");
  assert.equal(russian["home.viewer.title"], "Просмотр изображений");
  assert.equal(russian["viewer.title"], "Просмотр изображений");
});

test("recognizes and renders BPDH hybrid images", () => {
  assert.match(viewerSource, /BpdhFormat\.isBpdhFile\(bytes\)/);
  assert.match(viewerSource, /lowerName\.endsWith\("\.bpdh"\)/);
  assert.match(viewerSource, /function loadBpdh\(bytes, fileName\)/);
  assert.match(viewerSource, /BpdhFormat\.decodeBpdhFile\(bytes\)/);
  assert.match(viewerSource, /bpalBlocks: decoded\.bpalBlockCount/);
  assert.match(viewerSource, /dctBlocks: decoded\.dctBlockCount/);
  assert.match(viewerSource, /type: "bpdh"/);
  assert.match(viewerSource, /"viewer\.bpdhStatus"/);

  for (const catalog of [english, russian]) {
    const status = catalog["viewer.bpdhStatus"];

    assert.match(status, /\{codingUnitSize\}/);
    assert.match(status, /\{bpalBlocks\}/);
    assert.match(status, /\{dctBlocks\}/);
    assert.match(status, /\{bitsPerPixel\}/);
  }
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

test("lets users choose smooth or pixelated viewer scaling", () => {
  assert.match(viewerHtml, /<input id="smooth-scaling" type="checkbox" checked>/);
  assert.match(viewerHtml, /data-i18n="viewer\.smoothing"/);
  assert.match(viewerHtml, /data-i18n-title="viewer\.smoothingTitle"/);
  assert.match(viewerSource, /smoothScalingInput\.addEventListener\("change", updateImageRendering\)/);
  assert.match(viewerSource, /stage\.classList\.toggle\("is-pixelated", !smoothScalingInput\.checked\)/);
  assert.doesNotMatch(viewerSource, /is-magnified/);
  assert.match(viewerCss, /\.image-stage\.is-pixelated canvas \{\s*image-rendering: pixelated;/);
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
