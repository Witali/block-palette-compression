"use strict";

importScripts("./palette-quantizer.js?v=src-layout-4");
importScripts("./block-palette-codec.js?v=refinement-distance-cache-1");
importScripts("./block-palette-optimizer.js?v=iterative-refinement-1");

self.addEventListener("message", (event) => {
  const { pixels, width, height, options } = event.data;

  try {
    const result = self.BlockPaletteOptimizer.findBalancedBlockPaletteSettings(
      new Uint8ClampedArray(pixels),
      width,
      height,
      options,
      (progress) => self.postMessage({ type: "progress", ...progress })
    );

    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error && error.message ? error.message : String(error),
    });
  }
});
