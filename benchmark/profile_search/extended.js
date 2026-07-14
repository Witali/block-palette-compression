"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const codec = require("../../src/palette/block-palette-codec.js");

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_ROOT = path.join(ROOT, "benchmark/work/sources");
const OUTPUT_ROOT = path.join(ROOT, "benchmark/work/bpal-profile-search/extended");
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
const TARGETS = [
  { value: 1.5, minimum: 1.25 },
  { value: 8, minimum: 6 },
];
const POLICY_FINALISTS = { "1.5": 2, "8": 3 };
const STRUCTURAL_VALUES = {
  blockSize: [4, 8, 16, 32, 64],
  localColorCount: [2, 4, 8, 16],
  globalColorCount: [8, 16, 32, 64, 128, 256],
  paletteCount: [1, 2, 4, 8, 16, 32, 64, 128],
  paletteColorBits: [16, 24],
};

if (!isMainThread) {
  runWorkerLoop();
} else {
  runMain().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

async function runMain() {
  const command = process.argv[2];
  const concurrency = parseConcurrency();
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

  if (command === "screen") {
    await screen(concurrency);
  } else if (command === "validate") {
    await validate(concurrency);
  } else if (command === "policy") {
    await policy(concurrency);
  } else {
    process.stdout.write(
      "Usage:\n" +
      "  node benchmark/profile_search/extended.js screen [--jobs N]\n" +
      "  node benchmark/profile_search/extended.js validate [--jobs N]\n" +
      "  node benchmark/profile_search/extended.js policy [--jobs N]\n"
    );
    process.exitCode = command === "--help" || command === "-h" ? 0 : 1;
  }
}

async function screen(concurrency) {
  validateSources([DEFAULT_SOURCE]);
  const candidates = buildStructuralCandidates();
  const jobs = candidates.map((candidate) => ({
    id: candidate.key,
    label: `${candidate.key} ${candidate.payloadBpp.toFixed(6)} bpp`,
    sourceId: DEFAULT_SOURCE,
    cropSize: CROP_SIZE,
    settings: { ...candidate.settings, ...basePolicy() },
  }));

  process.stdout.write(
    `Screening ${candidates.length} structures for 1.5 and 8 bpp with ${concurrency} workers\n`
  );
  const scores = await runJobs(jobs, concurrency);
  for (const candidate of candidates) {
    Object.assign(candidate, scores.get(candidate.key));
  }

  const winners = Object.fromEntries(TARGETS.map(({ value }) => [
    value,
    candidates
      .filter((candidate) => candidate.targets.includes(value))
      .sort(compareQuality)
      .slice(0, 16),
  ]));
  writeJson("screen.json", {
    generatedAt: new Date().toISOString(),
    stage: "extended structural screen",
    targetRanges: TARGETS,
    sourceId: DEFAULT_SOURCE,
    cropSize: CROP_SIZE,
    referenceSize: [SOURCE_SIZE, SOURCE_SIZE],
    refinementPasses: 1,
    parallelWorkers: concurrency,
    structuralValues: STRUCTURAL_VALUES,
    candidateCount: candidates.length,
    candidates,
    winners,
  });
  printWinners(winners, 8);
}

async function validate(concurrency) {
  validateSources(VALIDATION_SOURCES);
  const report = readJson("screen.json");
  const candidates = new Map();
  for (const [targetText, winners] of Object.entries(report.winners)) {
    for (const winner of winners.slice(0, 10)) {
      const entry = candidates.get(winner.key) || {
        key: winner.key,
        settings: winner.settings,
        payloadBpp: winner.payloadBpp,
        targets: [],
      };
      entry.targets.push(Number(targetText));
      candidates.set(entry.key, entry);
    }
  }

  const entries = Array.from(candidates.values());
  const jobs = entries.flatMap((candidate) => VALIDATION_SOURCES.map((sourceId) => ({
    id: `${candidate.key}|${sourceId}`,
    label: `${candidate.key} ${sourceId}`,
    sourceId,
    cropSize: CROP_SIZE,
    settings: { ...candidate.settings, ...basePolicy() },
  })));
  process.stdout.write(
    `Validating ${entries.length} structures on ${VALIDATION_SOURCES.length} crops ` +
    `with ${concurrency} workers\n`
  );
  const scores = await runJobs(jobs, concurrency);
  for (const candidate of entries) {
    candidate.images = VALIDATION_SOURCES.map((sourceId) => ({
      sourceId,
      ...scores.get(`${candidate.key}|${sourceId}`),
    }));
    aggregateImages(candidate);
  }

  const winners = Object.fromEntries(TARGETS.map(({ value }) => [
    value,
    entries.filter((candidate) => candidate.targets.includes(value)).sort(compareAggregateQuality),
  ]));
  writeJson("validate.json", {
    generatedAt: new Date().toISOString(),
    stage: "extended cross-image validation",
    sourceIds: VALIDATION_SOURCES,
    cropSize: CROP_SIZE,
    referenceSize: [SOURCE_SIZE, SOURCE_SIZE],
    refinementPasses: 1,
    parallelWorkers: concurrency,
    candidates: entries,
    winners,
  });
  printWinners(winners, 10, true);
}

async function policy(concurrency) {
  validateSources(POLICY_SOURCES);
  const validation = readJson("validate.json");
  const policies = buildPolicies();
  const entries = [];

  for (const { value: target } of TARGETS) {
    for (const structural of validation.winners[target].slice(0, POLICY_FINALISTS[target])) {
      for (const candidatePolicy of policies) {
        entries.push({
          target,
          key: `${structural.key}|${candidatePolicy.key}`,
          structuralKey: structural.key,
          settings: structural.settings,
          payloadBpp: structural.payloadBpp,
          policy: candidatePolicy,
        });
      }
    }
  }

  const jobs = entries.flatMap((entry) => POLICY_SOURCES.map((sourceId) => ({
    id: `${entry.key}|${sourceId}`,
    label: `${entry.target} bpp ${entry.key} ${sourceId}`,
    sourceId,
    cropSize: CROP_SIZE,
    settings: {
      ...entry.settings,
      ...entry.policy,
      paletteMode: "explicit",
      refinementPasses: 1,
    },
  })));
  process.stdout.write(
    `Testing ${entries.length} structure-policy combinations on ${POLICY_SOURCES.length} crops ` +
    `with ${concurrency} workers\n`
  );
  const scores = await runJobs(jobs, concurrency);
  for (const entry of entries) {
    entry.images = POLICY_SOURCES.map((sourceId) => ({
      sourceId,
      ...scores.get(`${entry.key}|${sourceId}`),
    }));
    aggregateImages(entry);
  }

  const winners = Object.fromEntries(TARGETS.map(({ value }) => [
    value,
    entries.filter((entry) => entry.target === value).sort(compareAggregateQuality),
  ]));
  writeJson("policy.json", {
    generatedAt: new Date().toISOString(),
    stage: "extended encoder-policy validation",
    sourceIds: POLICY_SOURCES,
    cropSize: CROP_SIZE,
    refinementPasses: 1,
    parallelWorkers: concurrency,
    structuralFinalistsPerTarget: POLICY_FINALISTS,
    policies,
    winners,
  });
  printWinners(winners, 12, true);
}

function buildStructuralCandidates() {
  const candidates = new Map();
  for (const { value: target, minimum } of TARGETS) {
    for (const blockSize of STRUCTURAL_VALUES.blockSize) {
      for (const localColorCount of STRUCTURAL_VALUES.localColorCount) {
        for (const globalColorCount of STRUCTURAL_VALUES.globalColorCount) {
          for (const paletteCount of STRUCTURAL_VALUES.paletteCount) {
            for (const paletteColorBits of STRUCTURAL_VALUES.paletteColorBits) {
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
              if (payloadBpp > target || payloadBpp < minimum) {
                continue;
              }
              const key = settingsKey(candidateSettings);
              const entry = candidates.get(key) || {
                key,
                settings: candidateSettings,
                payloadBpp,
                targets: [],
              };
              entry.targets.push(target);
              candidates.set(key, entry);
            }
          }
        }
      }
    }
  }
  addTargetedLargePalettes(candidates);
  return Array.from(candidates.values()).sort((left, right) =>
    Math.min(...left.targets) - Math.min(...right.targets) || right.payloadBpp - left.payloadBpp
  );
}

function addTargetedLargePalettes(candidates) {
  const targeted = [
    [1.5, 8, 2, 1024, 4, 16],
    [1.5, 8, 2, 1024, 8, 16],
    [1.5, 8, 2, 1024, 4, 24],
    [1.5, 8, 2, 4096, 1, 16],
    [1.5, 8, 2, 4096, 1, 24],
    [8, 8, 16, 1024, 16, 24],
    [8, 8, 16, 1024, 32, 16],
    [8, 8, 16, 1024, 32, 24],
    [8, 8, 16, 1024, 64, 16],
    [8, 8, 16, 4096, 1, 16],
    [8, 8, 16, 4096, 1, 24],
    [8, 8, 16, 4096, 2, 16],
    [8, 8, 16, 4096, 2, 24],
    [8, 8, 16, 4096, 4, 16],
    [8, 8, 16, 4096, 4, 24],
    [8, 8, 16, 4096, 8, 16],
    [8, 8, 16, 4096, 8, 24],
  ];

  for (const [target, blockSize, localColorCount, globalColorCount, paletteCount, paletteColorBits]
    of targeted) {
    const candidateSettings = {
      blockSize,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
    };
    const payloadBpp = calculateBpp(candidateSettings);
    if (payloadBpp > target) {
      continue;
    }
    const key = settingsKey(candidateSettings);
    candidates.set(key, {
      key,
      settings: candidateSettings,
      payloadBpp,
      targets: [target],
      targetedLargePalette: true,
    });
  }
}

function buildPolicies() {
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
  return policies;
}

function addPolicy(policies, policySettings) {
  policies.push({
    ...policySettings,
    key: [
      policySettings.colorSpace,
      policySettings.clusteringMethod,
      policySettings.diversity,
      policySettings.dithering,
    ].join(":"),
  });
}

function basePolicy() {
  return {
    paletteMode: "explicit",
    colorSpace: "rgb",
    clusteringMethod: "k-means",
    diversity: 0,
    dithering: "none",
    refinementPasses: 1,
  };
}

function runWorkerLoop() {
  const sourceCache = new Map();
  parentPort.on("message", (job) => {
    if (job === null) {
      parentPort.close();
      return;
    }
    const cacheKey = `${job.sourceId}:${job.cropSize}`;
    let source = sourceCache.get(cacheKey);
    if (!source) {
      source = loadCrop(job.sourceId, job.cropSize);
      sourceCache.set(cacheKey, source);
    }
    const started = process.hrtime.bigint();
    const result = codec.compressImage(source, job.cropSize, job.cropSize, job.settings);
    const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;
    parentPort.postMessage({
      id: job.id,
      label: job.label,
      score: {
        mse: result.meanSquaredError,
        psnr: psnr(result.meanSquaredError),
        elapsedMilliseconds,
      },
    });
  });
  parentPort.postMessage({ ready: true });
}

function runJobs(jobs, concurrency) {
  if (jobs.length === 0) {
    return Promise.resolve(new Map());
  }
  const workerCount = Math.min(concurrency, jobs.length);
  const scores = new Map();
  let completed = 0;
  let nextIndex = 0;

  return Promise.all(Array.from({ length: workerCount }, () => new Promise((resolve, reject) => {
    const worker = new Worker(__filename);
    worker.on("message", (message) => {
      if (!message.ready) {
        scores.set(message.id, message.score);
        completed += 1;
        process.stdout.write(
          `[${completed}/${jobs.length}] ${message.label}: ` +
          `${message.score.psnr.toFixed(3)} dB, ${message.score.elapsedMilliseconds.toFixed(0)} ms\n`
        );
      }
      if (nextIndex < jobs.length) {
        worker.postMessage(jobs[nextIndex]);
        nextIndex += 1;
      } else {
        worker.postMessage(null);
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Scoring worker exited with code ${code}`));
      }
    });
  }))).then(() => scores);
}

function aggregateImages(entry) {
  entry.aggregateMse = entry.images.reduce((sum, image) => sum + image.mse, 0) / entry.images.length;
  entry.aggregatePsnr = psnr(entry.aggregateMse);
  entry.totalElapsedMilliseconds = entry.images.reduce(
    (sum, image) => sum + image.elapsedMilliseconds,
    0
  );
}

function calculateBpp(settings) {
  const blockPixels = settings.blockSize * settings.blockSize;
  return Math.log2(settings.localColorCount) +
    (Math.log2(settings.paletteCount) +
      settings.localColorCount * Math.log2(settings.globalColorCount)) / blockPixels +
    settings.paletteCount * settings.globalColorCount * settings.paletteColorBits / REFERENCE_PIXELS;
}

function settingsKey(settings) {
  return [
    settings.blockSize,
    settings.localColorCount,
    settings.globalColorCount,
    settings.paletteCount,
    settings.paletteColorBits,
  ].join(":");
}

function loadCrop(sourceId, cropSize) {
  const sourcePath = path.join(SOURCE_ROOT, sourceId, "source.rgba");
  const source = fs.readFileSync(sourcePath);
  const left = Math.floor((SOURCE_SIZE - cropSize) / 2);
  const top = Math.floor((SOURCE_SIZE - cropSize) / 2);
  const output = new Uint8ClampedArray(cropSize * cropSize * 4);
  for (let y = 0; y < cropSize; y += 1) {
    const sourceStart = ((top + y) * SOURCE_SIZE + left) * 4;
    output.set(source.subarray(sourceStart, sourceStart + cropSize * 4), y * cropSize * 4);
  }
  return output;
}

function validateSources(sourceIds) {
  for (const sourceId of sourceIds) {
    const sourcePath = path.join(SOURCE_ROOT, sourceId, "source.rgba");
    if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size !== SOURCE_SIZE * SOURCE_SIZE * 4) {
      throw new Error(`Missing or invalid prepared source: ${sourcePath}`);
    }
  }
}

function compareQuality(left, right) {
  return left.mse - right.mse || right.payloadBpp - left.payloadBpp;
}

function compareAggregateQuality(left, right) {
  return left.aggregateMse - right.aggregateMse || right.payloadBpp - left.payloadBpp;
}

function printWinners(winners, limit, aggregate = false) {
  process.stdout.write("\nWinners\n");
  for (const { value: target } of TARGETS) {
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
  const filePath = path.join(OUTPUT_ROOT, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing previous-stage report: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(OUTPUT_ROOT, name), `${JSON.stringify(value, null, 2)}\n`);
}

function parseConcurrency() {
  const index = process.argv.indexOf("--jobs");
  const value = index >= 0 ? Number(process.argv[index + 1]) : 8;
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error("--jobs must be an integer from 1 to 64");
  }
  return value;
}

function psnr(mse) {
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}
