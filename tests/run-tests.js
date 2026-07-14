"use strict";

async function runTests() {
  require("./i18n.test.js");
  require("./bpal-viewer-page.test.js");
  require("./cube-default-texture.test.js");
  require("./cube-grid-layout.test.js");
  require("./cube-wheel-zoom.test.js");
  require("./palette-quantizer.test.js");
  require("./block-palette-codec.test.js");
  require("./block-palette-format.test.js");
  require("./adaptive-block-format.test.js");
  require("./adaptive-block-webgl2.test.js");
  require("./block-pattern-dictionary.test.js");
  require("./block-pattern-dictionary-webgl2.test.js");
  require("./bplm-format.test.js");
  require("./bplm-compression-page.test.js");
  require("./bplm-webgl-pages.test.js");
  require("./bpal-texture-decoder.test.js");
  require("./block-palette-optimizer.test.js");
  require("./block-palette-webgl-codec.test.js");
  require("./native-cli-find-settings.test.js");
  await require("./pwa.test.js");
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
