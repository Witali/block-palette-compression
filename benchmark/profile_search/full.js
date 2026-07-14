"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const codec = require("../../src/palette/block-palette-codec.js");

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_ROOT = path.join(ROOT, "benchmark/work/sources");
const OUTPUT_ROOT = path.join(ROOT, "benchmark/work/bpal-profile-search/full");
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
const PROFILES = [
  profile(1.5, 4, 2, 8, 2, 24, "k-means-uniform", 0, "uniform"),
  profile(1.5, 4, 2, 8, 2, 24, "k-means", 1, "diversity-1"),
  profile(1.5, 4, 2, 8, 2, 24, "k-means", 0, "baseline"),
  profile(1.5, 4, 2, 8, 2, 16, "k-means-uniform", 0, "rgb565-uniform"),
  profile(1.5, 4, 2, 8, 2, 16, "k-means", 1, "rgb565-diversity-1"),
  profile(8, 4, 8, 256, 64, 24, "k-means", 0, "baseline"),
  profile(8, 4, 8, 256, 64, 24, "k-means", 0.5, "diversity-0_5"),
  profile(8, 4, 8, 256, 64, 24, "k-medians", 0, "k-medians"),
  profile(8, 4, 8, 256, 64, 24, "k-means", 1, "diversity-1"),
  profile(8, 4, 8, 128, 128, 24, "k-means", 0, "structure-128x128"),
  profile(8, 4, 8, 256, 32, 24, "k-means", 0, "structure-256x32"),
  profile(2, 4, 2, 128, 2, 24, "k-medians", 0),
  profile(2.5, 8, 4, 64, 32, 24, "k-medians", 0),
  profile(3, 8, 4, 256, 64, 24, "k-means", 0),
  profile(4, 8, 8, 64, 64, 24, "k-means", 0),
  profile(5, 16, 16, 128, 128, 24, "k-means", 0),
  profile(6, 8, 16, 64, 128, 24, "k-means", 1),
  profile(2, 4, 2, 128, 1, 24, "k-medians", 0, "runner-up"),
  profile(2.5, 8, 4, 128, 4, 24, "k-medians", 0, "runner-up"),
  profile(3, 8, 4, 128, 128, 24, "k-means", 0, "runner-up"),
  profile(4, 8, 8, 128, 16, 24, "k-means", 0, "runner-up"),
  profile(5, 16, 16, 256, 64, 24, "k-means", 0, "runner-up"),
  profile(6, 8, 16, 128, 32, 24, "k-means", 1, "runner-up"),
  profile(2, 4, 2, 128, 2, 24, "k-means", 0, "policy-alt"),
  profile(2.5, 8, 4, 64, 32, 24, "k-means", 0, "policy-alt"),
  profile(6, 8, 16, 128, 32, 24, "k-means", 0, "policy-alt"),
];

if (process.argv[2] === "--worker") {
  runWorker(Number(process.argv[3]), Number(process.argv[4]));
} else if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    "Usage: node benchmark/profile_search/full.js [--jobs N] [--targets LIST]\n" +
    "Runs or resumes full-resolution profiles and writes ignored artifacts under benchmark/work.\n" +
    "LIST is a comma-separated set such as 1.5,8.\n"
  );
} else {
  runMain().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

async function runMain() {
  const concurrency = parseConcurrency();
  const profileIndexes = selectProfileIndexes();
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  validateSources();
  const jobs = [];
  for (const profileIndex of profileIndexes) {
    for (let sourceIndex = 0; sourceIndex < SOURCE_IDS.length; sourceIndex += 1) {
      const outputPath = rgbaPath(profileIndex, sourceIndex);
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size !== WIDTH * HEIGHT * 4) {
        jobs.push({ profileIndex, sourceIndex });
      }
    }
  }
  process.stdout.write(
    `Found ${profileIndexes.length * SOURCE_IDS.length - jobs.length} completed jobs; ` +
    `running ${jobs.length} jobs with concurrency ${concurrency}\n`
  );
  await runPool(jobs, concurrency);
  writeReport(concurrency, profileIndexes);
}

async function runPool(jobs, concurrency) {
  let nextIndex = 0;
  let completed = 0;
  async function runNext() {
    while (nextIndex < jobs.length) {
      const job = jobs[nextIndex];
      nextIndex += 1;
      const record = await spawnWorker(job);
      completed += 1;
      process.stdout.write(
        `[${completed}/${jobs.length}] ${record.outputId} ${record.sourceId}: ` +
        `${record.psnrRgb.toFixed(3)} dB, ${record.elapsedMilliseconds.toFixed(0)} ms\n`
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, runNext));
}

function spawnWorker(job) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      [__filename, "--worker", String(job.profileIndex), String(job.sourceIndex)],
      { cwd: ROOT, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker ${job.profileIndex}:${job.sourceIndex} failed (${code}): ${stderr}`));
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

function runWorker(profileIndex, sourceIndex) {
  const candidate = PROFILES[profileIndex];
  const sourceId = SOURCE_IDS[sourceIndex];
  if (!candidate || !sourceId) {
    throw new Error("Worker requires valid profile and source indices");
  }
  const sourceBuffer = fs.readFileSync(sourcePath(sourceId));
  const source = new Uint8ClampedArray(
    sourceBuffer.buffer,
    sourceBuffer.byteOffset,
    sourceBuffer.byteLength
  );
  const started = process.hrtime.bigint();
  const result = codec.compressImage(source, WIDTH, HEIGHT, candidate.settings);
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;
  const outputDir = path.join(OUTPUT_ROOT, candidate.outputId);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, `${sourceId}.rgba`),
    Buffer.from(result.pixels.buffer, result.pixels.byteOffset, result.pixels.byteLength)
  );
  const record = {
    profileIndex,
    sourceIndex,
    targetBpp: candidate.targetBpp,
    outputId: candidate.outputId,
    sourceId,
    mseRgb: result.meanSquaredError,
    psnrRgb: psnr(result.meanSquaredError),
    elapsedMilliseconds,
  };
  fs.writeFileSync(
    path.join(outputDir, `${sourceId}.json`),
    `${JSON.stringify(record, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function writeReport(concurrency, profileIndexes) {
  const completedProfiles = profileIndexes.map((profileIndex) => {
    const candidate = PROFILES[profileIndex];
    const images = SOURCE_IDS.map((sourceId, sourceIndex) => {
      const metadataPath = jsonPath(profileIndex, sourceIndex);
      if (fs.existsSync(metadataPath)) {
        return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      }
      const source = fs.readFileSync(sourcePath(sourceId));
      const decoded = fs.readFileSync(rgbaPath(profileIndex, sourceIndex));
      const mseRgb = calculateMseRgb(source, decoded);
      return {
        sourceId,
        mseRgb,
        psnrRgb: psnr(mseRgb),
        elapsedMilliseconds: null,
        resumed: true,
      };
    });
    const aggregateMseRgb = images.reduce((sum, image) => sum + image.mseRgb, 0) / images.length;
    return {
      ...candidate,
      images,
      aggregateMseRgb,
      aggregatePsnrRgb: psnr(aggregateMseRgb),
      totalElapsedMilliseconds: images.every((image) => image.elapsedMilliseconds !== null)
        ? images.reduce((sum, image) => sum + image.elapsedMilliseconds, 0)
        : null,
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    stage: "full-corpus final verification",
    dataset: "CLIC 2020 Professional Validation",
    sourceIds: SOURCE_IDS,
    width: WIDTH,
    height: HEIGHT,
    imageCount: SOURCE_IDS.length,
    channelsScored: "RGB",
    refinementPasses: 4,
    parallelProcesses: concurrency,
    profiles: completedProfiles,
  };
  fs.writeFileSync(
    path.join(OUTPUT_ROOT, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  process.stdout.write("\nAggregate results\n");
  for (const candidate of completedProfiles) {
    process.stdout.write(
      `${candidate.outputId}: ${candidate.payloadBpp.toFixed(6)} bpp, ` +
      `${candidate.aggregatePsnrRgb.toFixed(3)} dB\n`
    );
  }
}

function profile(
  targetBpp,
  blockSize,
  localColorCount,
  globalColorCount,
  paletteCount,
  paletteColorBits,
  clusteringMethod,
  diversity,
  variant = "winner"
) {
  const structural = { blockSize, localColorCount, globalColorCount, paletteCount, paletteColorBits };
  const targetName = String(targetBpp).replace(".", "_");
  return {
    targetBpp,
    variant,
    outputId: variant === "winner" ? targetName : `${targetName}-${variant}`,
    payloadBpp: calculateBpp(structural),
    settings: {
      ...structural,
      paletteMode: "explicit",
      colorSpace: "rgb",
      clusteringMethod,
      dithering: "none",
      diversity,
      refinementPasses: 4,
    },
  };
}

function calculateBpp(settings) {
  const blockPixels = settings.blockSize * settings.blockSize;
  return Math.log2(settings.localColorCount) +
    (Math.log2(settings.paletteCount) +
      settings.localColorCount * Math.log2(settings.globalColorCount)) / blockPixels +
    settings.paletteCount * settings.globalColorCount * settings.paletteColorBits / (WIDTH * HEIGHT);
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

function rgbaPath(profileIndex, sourceIndex) {
  return path.join(
    OUTPUT_ROOT,
    PROFILES[profileIndex].outputId,
    `${SOURCE_IDS[sourceIndex]}.rgba`
  );
}

function jsonPath(profileIndex, sourceIndex) {
  return rgbaPath(profileIndex, sourceIndex).replace(/\.rgba$/, ".json");
}

function calculateMseRgb(reference, candidate) {
  let squaredError = 0;
  for (let index = 0; index < reference.length; index += 4) {
    const red = reference[index] - candidate[index];
    const green = reference[index + 1] - candidate[index + 1];
    const blue = reference[index + 2] - candidate[index + 2];
    squaredError += red * red + green * green + blue * blue;
  }
  return squaredError / (WIDTH * HEIGHT * 3);
}

function parseConcurrency() {
  const index = process.argv.indexOf("--jobs");
  const value = index >= 0 ? Number(process.argv[index + 1]) : 8;
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error("--jobs must be an integer from 1 to 64");
  }
  return value;
}

function selectProfileIndexes() {
  const index = process.argv.indexOf("--targets");
  if (index < 0) {
    return PROFILES.map((_, profileIndex) => profileIndex);
  }
  const values = new Set(
    String(process.argv[index + 1] || "")
      .split(",")
      .filter(Boolean)
      .map(Number)
  );
  if (values.size === 0 || Array.from(values).some((value) => !Number.isFinite(value))) {
    throw new Error("--targets must be a comma-separated list of numbers");
  }
  const profileIndexes = PROFILES
    .map((candidate, profileIndex) => ({ candidate, profileIndex }))
    .filter(({ candidate }) => values.has(candidate.targetBpp))
    .map(({ profileIndex }) => profileIndex);
  if (profileIndexes.length === 0) {
    throw new Error("--targets did not match any profiles");
  }
  return profileIndexes;
}

function psnr(mse) {
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}
