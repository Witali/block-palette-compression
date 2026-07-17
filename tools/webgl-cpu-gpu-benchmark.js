"use strict";

const BENCHMARK_IMAGES = [
  { name: "stone texture", url: "../assets/stone-texture-wic.jpg" },
  { name: "landscape photo", url: "../assets/benchmark-jpegs/landscape-alaska.jpg" },
  { name: "clipart", url: "../assets/benchmark-jpegs/clipart-apple.jpg" },
];
const WORKER_URL = "../src/palette/block-palette-worker.js?v=shared-encoder-runtime-1";
const params = new URLSearchParams(window.location.search);
const maximumSide = readIntegerParameter("side", 256, 64, 1024);
const runCount = readIntegerParameter("runs", 3, 1, 10);
const refinementPasses = readIntegerParameter("refinement", 1, 0, 16);
const selectedImageIndex = params.has("image")
  ? readIntegerParameter("image", 0, 0, BENCHMARK_IMAGES.length - 1)
  : null;
const benchmarkImages = selectedImageIndex === null
  ? BENCHMARK_IMAGES
  : [BENCHMARK_IMAGES[selectedImageIndex]];
const settings = {
  blockSize: 8,
  localColorCount: 8,
  globalColorCount: 128,
  paletteCount: 16,
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
  const results = [];

  for (let imageIndex = 0; imageIndex < benchmarkImages.length; imageIndex += 1) {
    const image = benchmarkImages[imageIndex];
    const imageData = await loadImageData(image.url, maximumSide);
    const algorithmOrder = createAlternatingOrder(runCount);
    const durations = { cpu: [], gpu: [] };
    let cpuReference = null;
    let gpuReference = null;

    for (let runIndex = 0; runIndex < algorithmOrder.length; runIndex += 1) {
      const algorithm = algorithmOrder[runIndex];

      statusElement.textContent = [
        `Image ${imageIndex + 1}/${benchmarkImages.length}: ${image.name}`,
        `run ${runIndex + 1}/${algorithmOrder.length}`,
        algorithm.toUpperCase(),
      ].join(" · ");

      const result = await runCodec(algorithm, imageData, settings);

      durations[algorithm].push(result.durationMs);

      if (algorithm === "cpu" && !cpuReference) {
        cpuReference = result;
      } else if (algorithm === "gpu" && !gpuReference) {
        gpuReference = result;
      }
    }

    const comparison = compareResults(cpuReference, gpuReference);
    const cpuMedianMs = median(durations.cpu);
    const gpuMedianMs = median(durations.gpu);

    results.push({
      image: image.name,
      width: imageData.width,
      height: imageData.height,
      bitsPerPixel: cpuReference.storage.bitsPerPixel,
      cpuMedianMs,
      gpuMedianMs,
      speedup: cpuMedianMs / gpuMedianMs,
      cpuRunsMs: durations.cpu,
      gpuRunsMs: durations.gpu,
      cpuMse: cpuReference.meanSquaredError,
      gpuMse: gpuReference.meanSquaredError,
      cpuPsnrDb: psnr(cpuReference.meanSquaredError),
      gpuPsnrDb: psnr(gpuReference.meanSquaredError),
      differentPixelBytes: comparison.differentPixelBytes,
      differentPixels: comparison.differentPixels,
      maximumPixelDelta: comparison.maximumPixelDelta,
      cpuGpuMse: comparison.cpuGpuMse,
      cpuGpuPsnrDb: psnr(comparison.cpuGpuMse),
      encodedStateEqual: comparison.encodedStateEqual,
      gpuAlgorithm: gpuReference.algorithm,
      acceleratedStages: gpuReference.acceleratedStages,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    renderer: getWebGLRenderer(),
    maximumSide,
    runCount,
    selectedImageIndex,
    settings,
    results,
    aggregate: {
      medianSpeedup: median(results.map((result) => result.speedup)),
      allPixelsEqual: results.every((result) => result.differentPixelBytes === 0),
      allEncodedStateEqual: results.every((result) => result.encodedStateEqual),
    },
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

function runCodec(algorithm, imageData, codecSettings) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);
    const source = new Uint8ClampedArray(imageData.data);

    worker.addEventListener("message", (event) => {
      if (event.data.type === "progress") {
        return;
      }

      worker.terminate();

      if (event.data.error) {
        reject(new Error(`${algorithm.toUpperCase()}: ${event.data.error}`));
        return;
      }

      resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(`${algorithm.toUpperCase()} worker: ${event.message}`));
    });
    worker.postMessage({
      pixels: source.buffer,
      width: imageData.width,
      height: imageData.height,
      settings: {
        ...codecSettings,
        algorithm: algorithm === "gpu" ? "webgl" : "cpu",
      },
    }, [source.buffer]);
  });
}

function compareResults(cpu, gpu) {
  let differentPixelBytes = 0;
  let differentPixels = 0;
  let maximumPixelDelta = 0;
  let squaredError = 0;

  for (let offset = 0; offset < cpu.pixels.length; offset += 4) {
    let pixelDiffers = false;

    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(cpu.pixels[offset + channel] - gpu.pixels[offset + channel]);

      squaredError += delta * delta;

      if (delta !== 0) {
        differentPixelBytes += 1;
        pixelDiffers = true;
        maximumPixelDelta = Math.max(maximumPixelDelta, delta);
      }
    }

    if (pixelDiffers) {
      differentPixels += 1;
    }
  }

  return {
    differentPixelBytes,
    differentPixels,
    maximumPixelDelta,
    cpuGpuMse: squaredError / (cpu.width * cpu.height * 3),
    encodedStateEqual: typedArraysEqual(cpu.blockPaletteSelectors, gpu.blockPaletteSelectors) &&
      typedArraysEqual(cpu.blockPaletteIndices, gpu.blockPaletteIndices) &&
      typedArraysEqual(cpu.pixelIndices, gpu.pixelIndices) &&
      palettesEqual(cpu.palette, gpu.palette),
  };
}

function typedArraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function palettesEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].r !== right[index].r ||
      left[index].g !== right[index].g ||
      left[index].b !== right[index].b
    ) {
      return false;
    }
  }

  return true;
}

function createAlternatingOrder(repetitions) {
  const order = [];

  for (let run = 0; run < repetitions; run += 1) {
    if (run % 2 === 0) {
      order.push("cpu", "gpu");
    } else {
      order.push("gpu", "cpu");
    }
  }

  return order;
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function psnr(meanSquaredError) {
  return meanSquaredError === 0
    ? Infinity
    : 10 * Math.log10(255 * 255 / meanSquaredError);
}

function readIntegerParameter(name, fallback, minimum, maximum) {
  const value = Number(params.get(name));

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    return fallback;
  }

  return value;
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
