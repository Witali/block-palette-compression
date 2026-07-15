"use strict";

importScripts(
  "../palette/palette-quantizer.js",
  "../palette/block-palette-codec.js",
  "./dct420.js",
  "./bpdh-format.js",
  "./bpdh-codec.js"
);

self.addEventListener("message", (event) => {
  try {
    const request = event.data || {};
    const sourcePixels = new Uint8ClampedArray(request.pixels);
    const startedAt = performance.now();
    const reportProgress = (progress) => {
      self.postMessage({ type: "progress", progress });
    };
    const result = self.BpdhCodec.compressHybridImage(
      sourcePixels,
      request.width,
      request.height,
      {
        ...(request.settings || {}),
        onProgress: reportProgress,
        onBpalProgress(progress) {
          reportProgress({
            ...progress,
            stage: `bpal-${progress.stage || "compressing"}`,
            progress: Math.min(0.5, Number(progress.progress || 0) * 0.5),
          });
        },
      }
    );
    const encoded = self.BpdhFormat.encodeBpdhFile(result);

    self.postMessage({
      type: "complete",
      file: encoded.buffer,
      metrics: {
        durationMs: performance.now() - startedAt,
        psnr: result.psnr,
        meanSquaredError: result.meanSquaredError,
        targetBitsPerPixel: result.targetBitsPerPixel,
        withinTarget: result.storage.withinTarget,
        dctQuality: result.dctQuality,
      },
    }, [encoded.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error && error.message ? error.message : String(error),
    });
  }
});
