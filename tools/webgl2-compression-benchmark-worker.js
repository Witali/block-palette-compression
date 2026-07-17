"use strict";

importScripts("../src/palette/palette-quantizer.js?v=progress-1");
importScripts("../src/palette/block-palette-codec.js?v=refinement-distance-cache-2");
importScripts("../src/palette/block-palette-webgl-accelerator.js?v=shared-encoder-runtime-1");

self.addEventListener("message", (event) => {
  const { pixels, width, height, settings } = event.data;
  const source = new Uint8ClampedArray(pixels);
  const stages = {};
  const startedAt = performance.now();
  let currentStage = "startup";
  let stageStartedAt = startedAt;
  let accelerator = null;

  function recordProgress(progress) {
    if (!progress || progress.stage === currentStage) {
      return;
    }

    const now = performance.now();

    stages[currentStage] = (stages[currentStage] || 0) + now - stageStartedAt;
    currentStage = progress.stage;
    stageStartedAt = now;
  }

  try {
    accelerator = self.BlockPaletteWebGLAccelerator.createWebGLAccelerator(width, height);
    const result = self.BlockPaletteCodec.compressImage(
      source,
      width,
      height,
      { ...settings, accelerator, onProgress: recordProgress }
    );
    result.algorithm = "webgl";
    result.acceleratedStages = ["global-assignments", "block-encoding"];
    if (Number(settings.refinementPasses || 0) > 0) {
      result.acceleratedStages.push("refinement-assignments", "refinement-encoding");
    }
    const finishedAt = performance.now();

    stages[currentStage] = (stages[currentStage] || 0) + finishedAt - stageStartedAt;

    self.postMessage({
      width,
      height,
      totalMilliseconds: finishedAt - startedAt,
      stages,
      encodedStateHash: hashEncodedState(result),
      pixelHash: hashBytes(result.pixels),
      meanSquaredError: result.meanSquaredError,
      payloadBits: result.storage.payloadBits,
      bitsPerPixel: result.storage.bitsPerPixel,
      algorithm: result.algorithm,
      acceleratedStages: result.acceleratedStages,
    });
  } catch (error) {
    self.postMessage({ error: error && error.stack ? error.stack : String(error) });
  } finally {
    if (accelerator) accelerator.dispose();
  }
});

function hashEncodedState(result) {
  let hash = 2166136261;

  hash = updateHash(hash, result.blockPaletteSelectors);
  hash = updateHash(hash, result.blockPaletteIndices);
  hash = updateHash(hash, result.pixelIndices);

  for (const color of result.palette) {
    hash = hashByte(hash, color.r);
    hash = hashByte(hash, color.g);
    hash = hashByte(hash, color.b);
  }

  return hash.toString(16).padStart(8, "0");
}

function hashBytes(values) {
  return updateHash(2166136261, values).toString(16).padStart(8, "0");
}

function updateHash(initial, values) {
  let hash = initial;

  if (values.BYTES_PER_ELEMENT === 1) {
    for (const value of values) {
      hash = hashByte(hash, value);
    }
  } else {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);

    for (const value of bytes) {
      hash = hashByte(hash, value);
    }
  }

  return hash;
}

function hashByte(hash, value) {
  return Math.imul((hash ^ value) >>> 0, 16777619) >>> 0;
}
