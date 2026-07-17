"use strict";

importScripts("./palette-quantizer.js?v=k-medoids-default-1");
importScripts("./block-palette-codec.js?v=palette-256-1");

self.addEventListener("message", (event) => {
  const { pixels, width, height, settings } = event.data;
  const startedAt = performance.now();

  try {
    const useWebGL = settings && settings.algorithm === "webgl";
    const options = {
      ...settings,
      onProgress: (progress) => self.postMessage({ type: "progress", progress }),
    };

    if (useWebGL && !self.BlockPaletteWebGLAccelerator) {
      importScripts("./block-palette-webgl-accelerator.js?v=shared-encoder-runtime-1");
    }

    const result = useWebGL
      ? compressImageWithWebGL(
        new Uint8ClampedArray(pixels),
        width,
        height,
        options
      )
      : self.BlockPaletteCodec.compressImage(
        new Uint8ClampedArray(pixels),
        width,
        height,
        options
      );

    if (!useWebGL) {
      result.algorithm = "cpu";
      result.acceleratedStages = [];
    }
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

function compressImageWithWebGL(sourcePixels, width, height, settings) {
  const options = settings || {};
  let accelerator = null;

  try {
    accelerator = self.BlockPaletteWebGLAccelerator.createWebGLAccelerator(width, height);
    const result = self.BlockPaletteCodec.compressImage(sourcePixels, width, height, {
      ...options,
      accelerator,
    });
    const usesCpuErrorDiffusion = options.dithering === "floyd-steinberg";
    const refinementPasses = options.refinementPasses === undefined
      ? 4
      : Number(options.refinementPasses);
    const acceleratedStages = ["global-assignments"];

    if (!usesCpuErrorDiffusion) {
      acceleratedStages.push("block-encoding");
    }
    if (refinementPasses > 0) {
      acceleratedStages.push("refinement-assignments");
      if (!usesCpuErrorDiffusion) acceleratedStages.push("refinement-encoding");
    }

    result.algorithm = usesCpuErrorDiffusion ? "webgl-hybrid" : "webgl";
    result.acceleratedStages = acceleratedStages;
    return result;
  } catch (error) {
    if (options.webglFallback === false) throw error;

    const cpuOptions = { ...options };
    delete cpuOptions.accelerator;
    delete cpuOptions.webglFallback;
    const result = self.BlockPaletteCodec.compressImage(sourcePixels, width, height, cpuOptions);

    result.algorithm = "cpu-fallback";
    result.acceleratedStages = [];
    result.fallbackReason = error && error.message ? error.message : String(error);
    return result;
  } finally {
    if (accelerator) accelerator.dispose();
  }
}
