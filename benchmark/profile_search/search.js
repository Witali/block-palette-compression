"use strict";

const fs = require("node:fs");
const path = require("node:path");
const codec = require("../../src/palette/block-palette-codec.js");

const ROOT = path.resolve(__dirname, "../..");
const WORK = path.join(ROOT, "benchmark/work/bpal-profile-search");
const SOURCE_ROOT = path.join(ROOT, "benchmark/work/sources");
const TARGETS = [2, 2.5, 3, 4, 5, 6];
const SOURCE_SIZE = 1024;
const CROP_SIZE = 256;
const REFERENCE_PIXELS = SOURCE_SIZE * SOURCE_SIZE;
const DEFAULT_SOURCE = "clic-01-alexander-shustov-73";
const VALIDATION_SOURCES = [
  DEFAULT_SOURCE,
  "clic-02-casey-fyfe-999",
  "clic-05-clem-onojeghuo-33741",
  "clic-06-jeremy-cai-1174",
];
const POLICY_SOURCES = [DEFAULT_SOURCE, "clic-06-jeremy-cai-1174"];

const command = process.argv[2];
if (command === "screen") {
  screen(process.argv[3] || DEFAULT_SOURCE);
} else if (command === "validate") {
  validate(process.argv[3] || DEFAULT_SOURCE);
} else if (command === "policy") {
  policy();
} else {
  process.stdout.write(
    "Usage:\n" +
    "  node benchmark/profile_search/search.js screen [SOURCE_ID]\n" +
    "  node benchmark/profile_search/search.js validate [SCREEN_SOURCE_ID]\n" +
    "  node benchmark/profile_search/search.js policy\n"
  );
  process.exitCode = command === "--help" || command === "-h" ? 0 : 1;
}

function screen(sourceId) {
  fs.mkdirSync(WORK, { recursive: true });
  const source = loadCrop(sourceId);
  const byKey = new Map();
  for (const target of TARGETS) {
    for (const blockSize of [4, 8, 16, 32, 64]) {
      for (const localColorCount of [2, 4, 8, 16]) {
        for (const globalColorCount of [8, 16, 32, 64, 128, 256]) {
          for (const paletteCount of [1, 2, 4, 8, 16, 32, 64, 128]) {
            for (const paletteColorBits of [16, 24]) {
              if (localColorCount > globalColorCount || localColorCount > blockSize * blockSize) {
                continue;
              }
              const candidateSettings = {
                blockSize,
                localColorCount,
                globalColorCount,
                paletteCount,
                paletteColorBits,
              };
              const payloadBpp = calculateBpp(candidateSettings);
              if (payloadBpp > target || payloadBpp < target - 0.25) {
                continue;
              }
              const key = settingsKey(candidateSettings);
              const entry = byKey.get(key) || {
                key,
                settings: candidateSettings,
                payloadBpp,
                targets: [],
              };
              entry.targets.push(target);
              byKey.set(key, entry);
            }
          }
        }
      }
    }
  }

  const candidates = Array.from(byKey.values()).sort((left, right) =>
    Math.min(...left.targets) - Math.min(...right.targets) || right.payloadBpp - left.payloadBpp
  );
  process.stdout.write(`Screening ${candidates.length} candidates on ${sourceId}\n`);
  for (let index = 0; index < candidates.length; index += 1) {
    scoreCandidate(candidates[index], source, 1);
    printProgress(index, candidates.length, candidates[index]);
  }

  const winners = {};
  for (const target of TARGETS) {
    winners[target] = candidates
      .filter((candidate) => candidate.targets.includes(target))
      .sort(compareQuality)
      .slice(0, 12);
  }
  writeJson(`screen-${sourceId}.json`, {
    generatedAt: new Date().toISOString(),
    stage: "structural screen",
    sourceId,
    cropSize: CROP_SIZE,
    referenceSize: [SOURCE_SIZE, SOURCE_SIZE],
    refinementPasses: 1,
    candidates,
    winners,
  });
  printWinners(winners, 3);
}

function validate(screenSourceId) {
  fs.mkdirSync(WORK, { recursive: true });
  const screenReport = readJson(`screen-${screenSourceId}.json`);
  const candidates = new Map();
  for (const [targetText, winners] of Object.entries(screenReport.winners)) {
    for (const winner of winners.slice(0, 3)) {
      addCandidate(candidates, winner.settings, Number(targetText), "screen-top-3");
    }
  }
  const jobs = Array.from(candidates.values());
  const sources = new Map(VALIDATION_SOURCES.map((sourceId) => [sourceId, loadCrop(sourceId)]));
  process.stdout.write(`Validating ${jobs.length} candidates on ${sources.size} crops\n`);
  for (let candidateIndex = 0; candidateIndex < jobs.length; candidateIndex += 1) {
    const candidate = jobs[candidateIndex];
    candidate.images = [];
    for (const [sourceId, source] of sources) {
      const image = scoreSettings(candidate.settings, source, basePolicy(1));
      candidate.images.push({ sourceId, ...image });
      process.stdout.write(
        `[${candidateIndex + 1}/${jobs.length}] ${candidate.key} ${sourceId}: ` +
        `${image.psnr.toFixed(3)} dB, ${image.elapsedMilliseconds.toFixed(0)} ms\n`
      );
    }
    aggregateImages(candidate);
  }

  const winners = {};
  for (const target of TARGETS) {
    winners[target] = jobs
      .filter((candidate) => candidate.targets.includes(target))
      .sort(compareAggregateQuality);
  }
  writeJson("validate.json", {
    generatedAt: new Date().toISOString(),
    stage: "cross-image crop validation",
    sourceIds: VALIDATION_SOURCES,
    cropSize: CROP_SIZE,
    referenceSize: [SOURCE_SIZE, SOURCE_SIZE],
    refinementPasses: 1,
    candidates: jobs,
    winners,
  });
  printWinners(winners, 5, true);
}

function policy() {
  fs.mkdirSync(WORK, { recursive: true });
  const validation = readJson("validate.json");
  const policies = [];
  for (const colorSpace of ["rgb", "oklab"]) {
    for (const clusteringMethod of ["k-means", "k-means-uniform", "k-medians"]) {
      addPolicy(policies, { colorSpace, clusteringMethod, diversity: 0, dithering: "none" });
    }
  }
  for (const diversity of [0.5, 1]) {
    addPolicy(policies, { colorSpace: "rgb", clusteringMethod: "k-means", diversity, dithering: "none" });
  }
  for (const dithering of ["pattern-2x2", "pattern", "floyd-steinberg"]) {
    addPolicy(policies, { colorSpace: "rgb", clusteringMethod: "k-means", diversity: 0, dithering });
  }

  const sources = new Map(POLICY_SOURCES.map((sourceId) => [sourceId, loadCrop(sourceId)]));
  const results = {};
  for (const target of TARGETS) {
    const structural = validation.winners[target][0];
    results[target] = [];
    for (const candidatePolicy of policies) {
      const entry = { ...candidatePolicy, images: [] };
      for (const [sourceId, source] of sources) {
        const image = scoreSettings(structural.settings, source, {
          ...candidatePolicy,
          paletteMode: "explicit",
          refinementPasses: 1,
        });
        entry.images.push({ sourceId, ...image });
      }
      aggregateImages(entry);
      results[target].push(entry);
      process.stdout.write(
        `${target} bpp ${entry.key}: ${entry.aggregatePsnr.toFixed(3)} dB\n`
      );
    }
    results[target].sort(compareAggregateQuality);
  }

  writeJson("policy.json", {
    generatedAt: new Date().toISOString(),
    stage: "encoder policy validation",
    sourceIds: POLICY_SOURCES,
    cropSize: CROP_SIZE,
    refinementPasses: 1,
    structuralSettings: Object.fromEntries(
      TARGETS.map((target) => [target, validation.winners[target][0]])
    ),
    results,
  });
  process.stdout.write("\nPolicy winners\n");
  for (const target of TARGETS) {
    process.stdout.write(
      `${target} bpp: ${results[target][0].key}, ${results[target][0].aggregatePsnr.toFixed(3)} dB\n`
    );
  }
}

function scoreCandidate(candidate, source, refinementPasses) {
  const result = scoreSettings(candidate.settings, source, basePolicy(refinementPasses));
  candidate.mse = result.mse;
  candidate.psnr = result.psnr;
  candidate.elapsedMilliseconds = result.elapsedMilliseconds;
}

function scoreSettings(candidateSettings, source, policySettings) {
  const started = process.hrtime.bigint();
  const result = codec.compressImage(source, CROP_SIZE, CROP_SIZE, {
    ...candidateSettings,
    ...policySettings,
  });
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    mse: result.meanSquaredError,
    psnr: psnr(result.meanSquaredError),
    elapsedMilliseconds,
  };
}

function aggregateImages(entry) {
  entry.aggregateMse = entry.images.reduce((sum, image) => sum + image.mse, 0) / entry.images.length;
  entry.aggregatePsnr = psnr(entry.aggregateMse);
  entry.totalElapsedMilliseconds = entry.images.reduce(
    (sum, image) => sum + image.elapsedMilliseconds,
    0
  );
}

function addCandidate(candidates, candidateSettings, target, reason) {
  const key = settingsKey(candidateSettings);
  const entry = candidates.get(key) || {
    key,
    settings: candidateSettings,
    payloadBpp: calculateBpp(candidateSettings),
    targets: [],
    reason: [],
  };
  if (!entry.targets.includes(target)) entry.targets.push(target);
  if (!entry.reason.includes(reason)) entry.reason.push(reason);
  candidates.set(key, entry);
}

function addPolicy(policies, candidatePolicy) {
  candidatePolicy.key = [
    candidatePolicy.colorSpace,
    candidatePolicy.clusteringMethod,
    candidatePolicy.diversity,
    candidatePolicy.dithering,
  ].join(":");
  policies.push(candidatePolicy);
}

function basePolicy(refinementPasses) {
  return {
    paletteMode: "explicit",
    colorSpace: "rgb",
    clusteringMethod: "k-means",
    dithering: "none",
    diversity: 0,
    refinementPasses,
  };
}

function settings(blockSize, localColorCount, globalColorCount, paletteCount, paletteColorBits) {
  return { blockSize, localColorCount, globalColorCount, paletteCount, paletteColorBits };
}

function settingsKey(candidateSettings) {
  return [
    candidateSettings.blockSize,
    candidateSettings.localColorCount,
    candidateSettings.globalColorCount,
    candidateSettings.paletteCount,
    candidateSettings.paletteColorBits,
  ].join(":");
}

function calculateBpp(candidateSettings) {
  const blockPixels = candidateSettings.blockSize * candidateSettings.blockSize;
  return Math.log2(candidateSettings.localColorCount) +
    (Math.log2(candidateSettings.paletteCount) +
      candidateSettings.localColorCount * Math.log2(candidateSettings.globalColorCount)) / blockPixels +
    candidateSettings.paletteCount * candidateSettings.globalColorCount *
      candidateSettings.paletteColorBits / REFERENCE_PIXELS;
}

function loadCrop(sourceId) {
  const sourcePath = path.join(SOURCE_ROOT, sourceId, "source.rgba");
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing prepared source: ${sourcePath}`);
  }
  return cropCenter(fs.readFileSync(sourcePath), SOURCE_SIZE, SOURCE_SIZE, CROP_SIZE, CROP_SIZE);
}

function cropCenter(buffer, width, height, cropWidth, cropHeight) {
  const left = Math.floor((width - cropWidth) / 2);
  const top = Math.floor((height - cropHeight) / 2);
  const output = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y += 1) {
    const sourceStart = ((top + y) * width + left) * 4;
    output.set(buffer.subarray(sourceStart, sourceStart + cropWidth * 4), y * cropWidth * 4);
  }
  return output;
}

function compareQuality(left, right) {
  return left.mse - right.mse || right.payloadBpp - left.payloadBpp;
}

function compareAggregateQuality(left, right) {
  return left.aggregateMse - right.aggregateMse ||
    (right.payloadBpp || 0) - (left.payloadBpp || 0);
}

function psnr(mse) {
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}

function printProgress(index, total, candidate) {
  process.stdout.write(
    `[${index + 1}/${total}] ${candidate.key} ${candidate.payloadBpp.toFixed(6)} bpp ` +
    `${candidate.psnr.toFixed(3)} dB ${candidate.elapsedMilliseconds.toFixed(0)} ms\n`
  );
}

function printWinners(winners, limit, aggregate = false) {
  process.stdout.write("\nWinners\n");
  for (const target of TARGETS) {
    process.stdout.write(`${target} bpp\n`);
    for (const candidate of winners[target].slice(0, limit)) {
      const score = aggregate ? candidate.aggregatePsnr : candidate.psnr;
      process.stdout.write(
        `  ${candidate.key} ${candidate.payloadBpp.toFixed(6)} bpp ${score.toFixed(3)} dB\n`
      );
    }
  }
}

function readJson(name) {
  const filePath = path.join(WORK, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing previous-stage report: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(WORK, name), `${JSON.stringify(value, null, 2)}\n`);
}
