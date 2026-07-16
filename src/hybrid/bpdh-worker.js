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
    const mode = request.settings && request.settings.mode || "auto";
    const reportProgress = (progress) => {
      self.postMessage({ type: "progress", progress });
    };
    const reportCodecProgress = (progress) => {
      reportProgress(normalizeCodecProgress(progress, mode));
    };
    const result = self.BpdhCodec.compressHybridImage(
      sourcePixels,
      request.width,
      request.height,
      {
        ...(request.settings || {}),
        onProgress: reportCodecProgress,
        onBpalProgress(progress) {
          reportProgress({
            ...progress,
            stage: `bpal-${progress.stage || "compressing"}`,
            progress: Math.min(
              mode === "bpal" ? 0.95 : 0.5,
              Number(progress.progress || 0) * (mode === "bpal" ? 0.95 : 0.5)
            ),
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

function normalizeCodecProgress(progress, mode) {
  if (!progress || mode !== "auto") {
    return progress;
  }

  const normalized = { ...progress };
  const value = Number(progress.progress || 0);

  if (progress.stage === "transforming-dct") {
    normalized.progress = 0.5 + clamp((value - 0.15) / 0.4, 0, 1) * 0.2;
  } else if (progress.stage === "evaluating-dct") {
    normalized.progress = 0.7 + clamp((value - 0.55) / 0.4, 0, 1) * 0.25;
  }

  return normalized;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
