"use strict";

importScripts("./palette-quantizer.js?v=progress-1");
importScripts("./block-palette-codec.js?v=iterative-refinement-1");
importScripts("./block-palette-webgl-codec.js?v=block-palette-3");

self.addEventListener("message", (event) => {
  const { pixels, width, height, settings } = event.data;
  const startedAt = performance.now();

  try {
    const result = self.BlockPaletteWebGLCodec.compressImageWebGL(
      new Uint8ClampedArray(pixels),
      width,
      height,
      {
        ...settings,
        onProgress: (progress) => self.postMessage({ type: "progress", progress }),
      }
    );

    result.durationMs = performance.now() - startedAt;
    self.postMessage(result, [
      result.pixels.buffer,
      result.blockPaletteSelectors.buffer,
      result.blockPaletteIndices.buffer,
      result.pixelIndices.buffer,
    ]);
  } catch (error) {
    self.postMessage({ error: error && error.message ? error.message : String(error) });
  }
});
