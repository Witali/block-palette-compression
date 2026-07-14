"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const codec = require("../../src/palette/block-palette-codec.js");

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_ROOT = path.join(ROOT, "benchmark/work/sources");
const OUTPUT_ROOT = path.join(ROOT, "benchmark/work/centroid-comparison");
const WIDTH = 1024;
const HEIGHT = 1024;
const SOURCE_IDS = [
  "clic-01-alexander-shustov-73",
  "clic-02-casey-fyfe-999",
  "clic-03-juskteez-vu-1041",
  "clic-04-davide-ragusa-716",
  "clic-05-clem-onojeghuo-33741",
  "clic-06-jeremy-cai-1174",
  "clic-07-michael-durana-82941",
  "clic-08-zugr-108",
];
const STRUCTURES = [
  structure(1.5, 4, 2, 8, 2),
  structure(2, 4, 2, 128, 2),
  structure(2.5, 8, 4, 64, 32),
  structure(3, 8, 4, 256, 64),
];
const METHODS = ["k-means", "k-medoids"];

if (process.argv[2] === "--worker") {
  runWorker(Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]));
} else if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    "Usage: node benchmark/profile_search/compare_centers.js [--jobs N] [--targets LIST]\n" +
    "Compares weighted K-means with source-snapped K-medoids on the prepared CLIC corpus.\n"
  );
} else {
  runMain().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

async function runMain() {
  const concurrency = parseConcurrency();
  const structureIndexes = selectStructureIndexes();

  validateSources();
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

  const jobs = [];
  for (const structureIndex of structureIndexes) {
    for (let sourceIndex = 0; sourceIndex < SOURCE_IDS.length; sourceIndex += 1) {
      for (let methodIndex = 0; methodIndex < METHODS.length; methodIndex += 1) {
        jobs.push({ structureIndex, methodIndex, sourceIndex });
      }
    }
  }

  const records = await runPool(jobs, concurrency);
  const report = buildReport(records, concurrency, structureIndexes);
  const reportPath = path.join(OUTPUT_ROOT, "report.json");

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  process.stdout.write(`\nSaved ${path.relative(ROOT, reportPath)}\n`);
}

async function runPool(jobs, concurrency) {
  const records = [];
  let nextIndex = 0;
  let completed = 0;

  async function runNext() {
    while (nextIndex < jobs.length) {
      const job = jobs[nextIndex];

      nextIndex += 1;
      const record = await spawnWorker(job);
      records.push(record);
      completed += 1;
      process.stdout.write(
        `[${completed}/${jobs.length}] ${record.targetBpp} bpp ${record.method} ` +
        `${record.sourceId}: ${record.psnrRgb.toFixed(3)} dB, ` +
        `${record.elapsedMilliseconds.toFixed(0)} ms\n`
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, runNext));
  return records;
}

function spawnWorker(job) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      [
        __filename,
        "--worker",
        String(job.structureIndex),
        String(job.methodIndex),
        String(job.sourceIndex),
      ],
      { cwd: ROOT, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker failed (${code}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`Invalid worker output: ${stdout}\n${error}`));
      }
    });
  });
}

function runWorker(structureIndex, methodIndex, sourceIndex) {
  const candidate = STRUCTURES[structureIndex];
  const method = METHODS[methodIndex];
  const sourceId = SOURCE_IDS[sourceIndex];

  if (!candidate || !method || !sourceId) {
    throw new Error("Worker requires valid structure, method, and source indices");
  }

  const sourceBuffer = fs.readFileSync(sourcePath(sourceId));
  const source = new Uint8ClampedArray(
    sourceBuffer.buffer,
    sourceBuffer.byteOffset,
    sourceBuffer.byteLength
  );
  const started = process.hrtime.bigint();
  const result = codec.compressImage(source, WIDTH, HEIGHT, {
    ...candidate.settings,
    clusteringMethod: method,
  });
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;
  const colorMetrics = calculateColorMetrics(source, result.pixels, result.palette);
  const record = {
    targetBpp: candidate.targetBpp,
    payloadBpp: candidate.payloadBpp,
    method,
    sourceId,
    mseRgb: result.meanSquaredError,
    psnrRgb: psnr(result.meanSquaredError),
    meanErrorRgb: colorMetrics.meanErrorRgb,
    meanErrorMagnitude: colorMetrics.meanErrorMagnitude,
    sourcePaletteMatches: colorMetrics.sourcePaletteMatches,
    activePaletteColors: colorMetrics.activePaletteColors,
    refinementAcceptedPasses: result.refinementAcceptedPasses,
    elapsedMilliseconds,
  };

  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function calculateColorMetrics(source, output, palette) {
  const errorSums = [0, 0, 0];
  const sourceColors = new Set();
  let pixelCount = 0;

  for (let offset = 0; offset < source.length; offset += 4) {
    if (source[offset + 3] === 0) {
      continue;
    }
    sourceColors.add((source[offset] << 16) | (source[offset + 1] << 8) | source[offset + 2]);
    errorSums[0] += output[offset] - source[offset];
    errorSums[1] += output[offset + 1] - source[offset + 1];
    errorSums[2] += output[offset + 2] - source[offset + 2];
    pixelCount += 1;
  }

  const active = palette.filter((color) => color.count > 0);
  const matches = active.filter((color) => (
    sourceColors.has((color.r << 16) | (color.g << 8) | color.b)
  )).length;
  const meanErrorRgb = errorSums.map((sum) => sum / pixelCount);

  return {
    meanErrorRgb,
    meanErrorMagnitude: Math.hypot(...meanErrorRgb),
    sourcePaletteMatches: matches,
    activePaletteColors: active.length,
  };
}

function buildReport(records, concurrency, structureIndexes) {
  const comparisons = structureIndexes.map((structureIndex) => {
    const structure = STRUCTURES[structureIndex];
    const methods = METHODS.map((method) => {
      const images = records
        .filter((record) => record.targetBpp === structure.targetBpp && record.method === method)
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
      const aggregateMseRgb = mean(images.map((image) => image.mseRgb));
      const meanErrorRgb = [0, 1, 2].map((channel) => (
        mean(images.map((image) => image.meanErrorRgb[channel]))
      ));
      const sourcePaletteMatches = sum(images.map((image) => image.sourcePaletteMatches));
      const activePaletteColors = sum(images.map((image) => image.activePaletteColors));

      return {
        method,
        aggregateMseRgb,
        aggregatePsnrRgb: psnr(aggregateMseRgb),
        meanErrorRgb,
        meanErrorMagnitude: Math.hypot(...meanErrorRgb),
        sourcePaletteMatchRatio: sourcePaletteMatches / activePaletteColors,
        meanElapsedMilliseconds: mean(images.map((image) => image.elapsedMilliseconds)),
        meanAcceptedRefinementPasses: mean(
          images.map((image) => image.refinementAcceptedPasses)
        ),
        images,
      };
    });
    const means = methods[0];
    const medoids = methods[1];

    return {
      ...structure,
      methods,
      medoidDelta: {
        psnrDb: medoids.aggregatePsnrRgb - means.aggregatePsnrRgb,
        msePercent: (medoids.aggregateMseRgb / means.aggregateMseRgb - 1) * 100,
        meanErrorMagnitude: medoids.meanErrorMagnitude - means.meanErrorMagnitude,
        sourcePaletteMatchPercentagePoints:
          (medoids.sourcePaletteMatchRatio - means.sourcePaletteMatchRatio) * 100,
        elapsedPercent:
          (medoids.meanElapsedMilliseconds / means.meanElapsedMilliseconds - 1) * 100,
      },
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    dataset: "CLIC 2020 Professional Validation",
    width: WIDTH,
    height: HEIGHT,
    imageCount: SOURCE_IDS.length,
    refinementPasses: 4,
    parallelProcesses: concurrency,
    comparisons,
  };
}

function printReport(report) {
  process.stdout.write("\nAggregate center comparison\n");
  process.stdout.write(
    "Target  Method      PSNR dB  Mean bias  Source colors  Mean ms\n" +
    "------  ----------  -------  ---------  -------------  -------\n"
  );
  for (const comparison of report.comparisons) {
    for (const method of comparison.methods) {
      process.stdout.write(
        `${String(comparison.targetBpp).padStart(6)}  ${method.method.padEnd(10)}  ` +
        `${method.aggregatePsnrRgb.toFixed(3).padStart(7)}  ` +
        `${method.meanErrorMagnitude.toFixed(4).padStart(9)}  ` +
        `${(method.sourcePaletteMatchRatio * 100).toFixed(2).padStart(12)}%  ` +
        `${method.meanElapsedMilliseconds.toFixed(0).padStart(7)}\n`
      );
    }
  }
}

function structure(targetBpp, blockSize, localColorCount, globalColorCount, paletteCount) {
  const settings = {
    blockSize,
    localColorCount,
    globalColorCount,
    paletteCount,
    paletteColorBits: 24,
    paletteMode: "explicit",
    colorSpace: "rgb",
    dithering: "none",
    diversity: 0,
    refinementPasses: 4,
  };

  return { targetBpp, payloadBpp: calculateBpp(settings), settings };
}

function calculateBpp(settings) {
  return Math.log2(settings.localColorCount) +
    (Math.log2(settings.paletteCount) +
      settings.localColorCount * Math.log2(settings.globalColorCount)) /
      (settings.blockSize * settings.blockSize) +
    settings.paletteCount * settings.globalColorCount * settings.paletteColorBits /
      (WIDTH * HEIGHT);
}

function parseConcurrency() {
  const index = process.argv.indexOf("--jobs");
  const value = index >= 0 ? Number(process.argv[index + 1]) : 8;

  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error("--jobs must be an integer from 1 to 64");
  }
  return value;
}

function selectStructureIndexes() {
  const index = process.argv.indexOf("--targets");

  if (index < 0) {
    return STRUCTURES.map((_, structureIndex) => structureIndex);
  }

  const targets = new Set(String(process.argv[index + 1] || "").split(",").map(Number));
  const selected = STRUCTURES
    .map((candidate, structureIndex) => ({ candidate, structureIndex }))
    .filter(({ candidate }) => targets.has(candidate.targetBpp))
    .map(({ structureIndex }) => structureIndex);

  if (selected.length === 0) {
    throw new Error("--targets did not match 1.5, 2, 2.5, or 3");
  }
  return selected;
}

function validateSources() {
  for (const sourceId of SOURCE_IDS) {
    const candidate = sourcePath(sourceId);

    if (!fs.existsSync(candidate) || fs.statSync(candidate).size !== WIDTH * HEIGHT * 4) {
      throw new Error(`Missing or invalid prepared source: ${candidate}`);
    }
  }
}

function sourcePath(sourceId) {
  return path.join(SOURCE_ROOT, sourceId, "source.rgba");
}

function mean(values) {
  return sum(values) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function psnr(mse) {
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}
