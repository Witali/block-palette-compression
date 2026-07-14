"use strict";

const params = new URLSearchParams(window.location.search);
const presets = Object.freeze({
  "1.5": { blockSize: 4, localColorCount: 2, globalColorCount: 8, paletteCount: 2 },
  "2": { blockSize: 4, localColorCount: 2, globalColorCount: 128, paletteCount: 2 },
  "2.5": { blockSize: 8, localColorCount: 4, globalColorCount: 64, paletteCount: 32 },
  "3": { blockSize: 8, localColorCount: 4, globalColorCount: 256, paletteCount: 64 },
  "4": { blockSize: 8, localColorCount: 8, globalColorCount: 128, paletteCount: 16 },
  "5": { blockSize: 16, localColorCount: 16, globalColorCount: 256, paletteCount: 64 },
  "6": { blockSize: 8, localColorCount: 16, globalColorCount: 128, paletteCount: 32 },
  "8": { blockSize: 4, localColorCount: 8, globalColorCount: 256, paletteCount: 64 },
});
const presetName = Object.hasOwn(presets, params.get("preset")) ? params.get("preset") : "5";
const sourceUrl = params.get("source") || "../assets/stone-texture-wic.jpg";
const maximumSide = readIntegerParameter("side", 512, 64, 2048);
const runCount = readIntegerParameter("runs", 11, 1, 25);
const warmupCount = readIntegerParameter("warmup", 2, 0, 10);
const refinementPasses = readIntegerParameter("refinement", 4, 0, 16);
const settings = {
  ...presets[presetName],
  paletteColorBits: 24,
  colorSpace: "rgb",
  clusteringMethod: "k-means",
  dithering: "none",
  diversity: 0,
  refinementPasses,
  webglFallback: false,
};
const statusElement = document.getElementById("status");
const resultElement = document.getElementById("result");

runBenchmark().catch((error) => {
  statusElement.textContent = "Benchmark failed.";
  resultElement.textContent = error && error.stack ? error.stack : String(error);
});

async function runBenchmark() {
  const imageData = await loadImageData(sourceUrl, maximumSide);
  const measured = [];

  for (let run = 0; run < warmupCount + runCount; run += 1) {
    const warmup = run < warmupCount;
    const measuredRun = run - warmupCount + 1;

    statusElement.textContent = warmup
      ? `GPU warmup ${run + 1}/${warmupCount}`
      : `Measured run ${measuredRun}/${runCount}`;

    const result = await runCodec(imageData, settings);

    if (!warmup) {
      measured.push(result);
    }
  }

  const first = measured[0];
  const consistent = measured.every((result) =>
    result.encodedStateHash === first.encodedStateHash &&
    result.pixelHash === first.pixelHash &&
    result.meanSquaredError === first.meanSquaredError
  );
  const summary = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    renderer: getWebGLRenderer(),
    sourceUrl,
    preset: presetName,
    width: first.width,
    height: first.height,
    maximumSide,
    warmupCount,
    runCount,
    settings,
    total: summarize(measured.map((result) => result.totalMilliseconds)),
    stages: summarizeStages(measured),
    output: {
      consistent,
      encodedStateHash: first.encodedStateHash,
      pixelHash: first.pixelHash,
      meanSquaredError: first.meanSquaredError,
      psnrDb: psnr(first.meanSquaredError),
      payloadBits: first.payloadBits,
      bitsPerPixel: first.bitsPerPixel,
      algorithm: first.algorithm,
      acceleratedStages: first.acceleratedStages,
    },
    runs: measured.map((result) => ({
      totalMilliseconds: result.totalMilliseconds,
      stages: result.stages,
    })),
  };

  window.__benchmarkResult = summary;
  statusElement.textContent = "Benchmark complete.";
  resultElement.textContent = JSON.stringify(summary, null, 2);
}

async function loadImageData(url, maximumDimension) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }

  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, maximumDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return context.getImageData(0, 0, width, height);
}

function runCodec(imageData, codecSettings) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("./webgl2-compression-benchmark-worker.js?v=19");
    const source = new Uint8ClampedArray(imageData.data);

    worker.addEventListener("message", (event) => {
      worker.terminate();

      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }

      resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(`Benchmark worker: ${event.message}`));
    });
    worker.postMessage({
      pixels: source.buffer,
      width: imageData.width,
      height: imageData.height,
      settings: codecSettings,
    }, [source.buffer]);
  });
}

function summarizeStages(results) {
  const stageNames = new Set();

  for (const result of results) {
    for (const stage of Object.keys(result.stages)) {
      stageNames.add(stage);
    }
  }

  return Object.fromEntries(Array.from(stageNames).map((stage) => [
    stage,
    summarize(results.map((result) => result.stages[stage] || 0)),
  ]));
}

function summarize(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return {
    medianMilliseconds: percentile(sorted, 0.5),
    meanMilliseconds: mean,
    bestMilliseconds: sorted[0],
    p90Milliseconds: percentile(sorted, 0.9),
    standardDeviationMilliseconds: Math.sqrt(variance),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 1) {
    return sorted[0];
  }

  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;

  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function psnr(meanSquaredError) {
  return meanSquaredError === 0
    ? Infinity
    : 10 * Math.log10(255 * 255 / meanSquaredError);
}

function readIntegerParameter(name, fallback, minimum, maximum) {
  const value = Number(params.get(name));

  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function getWebGLRenderer() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
  });

  if (!gl) {
    return "WebGL2 unavailable";
  }

  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");

  return debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
}
