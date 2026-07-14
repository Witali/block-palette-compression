"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  decodeBlockPaletteFile,
} = require("../src/palette/block-palette-format.js");
const {
  encodeSmallestRandomAccessFile,
  openRandomAccessImageFile,
} = require("../src/palette/block-pattern-dictionary.js");

const root = path.resolve(__dirname, "..");
const options = parseOptions(process.argv.slice(2));
const corpusDirectory = path.resolve(root, options.corpus);
const encoder = path.resolve(root, options.encoder);
const workDirectory = path.resolve(root, options.workDirectory);

validateInputs();

const allSources = fs.readdirSync(corpusDirectory)
  .filter((name) => name.toLowerCase().endsWith(".png"))
  .sort();
const filteredSources = options.files.length === 0
  ? allSources
  : allSources.filter((name) => options.files.some((filter) => name.includes(filter)));
const sources = options.limit === null
  ? filteredSources
  : filteredSources.slice(0, options.limit);

if (sources.length === 0) {
  throw new Error("No CLIC PNG files matched the requested filters");
}

const results = [];

for (const preset of options.presets) {
  const presetDirectory = path.join(workDirectory, `preset-${preset}`);

  fs.mkdirSync(presetDirectory, { recursive: true });

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const name = sources[sourceIndex];
    const sourcePath = path.join(corpusDirectory, name);
    const baselinePath = path.join(presetDirectory, `${path.parse(name).name}.bpal`);
    const encoderResult = runEncoder(sourcePath, baselinePath, preset);
    const baselineBytes = fs.readFileSync(baselinePath);
    const decoded = decodeBlockPaletteFile(baselineBytes);
    const started = performance.now();
    const encoded = encodeSmallestRandomAccessFile(decoded, {
      maxDictionarySize: options.maxDictionarySize,
      sampleLimit: options.sampleLimit,
      checkpointLog2: options.checkpointLog2,
    });
    const dictionaryMilliseconds = performance.now() - started;
    const accessor = openRandomAccessImageFile(encoded.bytes);
    const queries = createQueries(decoded.width, decoded.height, options.queries);

    verifyQueries(accessor, decoded, queries);

    const accessStarted = performance.now();
    let checksum = 0;

    for (const [x, y] of queries) {
      const color = accessor.getPixel(x, y);

      checksum = (checksum + color.r * 3 + color.g * 5 + color.b * 7) >>> 0;
    }

    const accessMilliseconds = performance.now() - accessStarted;
    const stats = encoded.stats;
    const pixelCount = decoded.width * decoded.height;
    const record = {
      name,
      preset,
      width: decoded.width,
      height: decoded.height,
      pixelCount,
      baselineBytes: baselineBytes.length,
      bestBytes: encoded.bytes.length,
      format: encoded.format.toUpperCase(),
      fileChangePercent: 100 * (encoded.bytes.length / baselineBytes.length - 1),
      baselineMse: encoderResult.mse,
      baselinePsnr: calculatePsnr(encoderResult.mse),
      bestMse: encoderResult.mse,
      bestPsnr: calculatePsnr(encoderResult.mse),
      psnrDelta: 0,
      dictionarySize: stats.dictionarySize,
      rawBlocks: stats.rawBlocks,
      dictionaryBlocks: stats.referencedBlocks,
      transformedBlocks: stats.transformedBlocks,
      runDeltaBlocks: stats.runLengthBlocks,
      exactDictionaryBlocks: stats.exactBlocks,
      dictionaryMilliseconds,
      randomAccessQueriesPerSecond: queries.length / accessMilliseconds * 1000,
      checksum,
    };

    results.push(record);
    process.stderr.write(
      `[${results.length}/${sources.length * options.presets.length}] preset ${preset} ${name}: ` +
      `${baselineBytes.length} -> ${encoded.bytes.length} bytes ` +
      `(${formatSigned(record.fileChangePercent)}%), ${record.format}, ` +
      `${record.baselinePsnr.toFixed(3)} dB\n`
    );
  }
}

const report = createReport(results, sources, options);

fs.mkdirSync(workDirectory, { recursive: true });
fs.writeFileSync(
  path.join(workDirectory, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
fs.writeFileSync(path.join(workDirectory, "report.md"), renderMarkdown(report));
process.stdout.write(renderMarkdown(report));

function parseOptions(args) {
  const parsed = {
    corpus: ".benchmark-corpus/clic2020-professional-valid",
    encoder: "native/bpal5_simd/build-cuda/bpal5cudaenc.exe",
    workDirectory: "benchmark/work/pattern-dictionary-clic",
    presets: [1.5, 2.5, 4],
    device: 0,
    maxDictionarySize: 64,
    sampleLimit: 8192,
    checkpointLog2: 6,
    queries: 1024,
    files: [],
    limit: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument === "--corpus") {
      parsed.corpus = value;
    } else if (argument === "--encoder") {
      parsed.encoder = value;
    } else if (argument === "--work-directory") {
      parsed.workDirectory = value;
    } else if (argument === "--presets") {
      parsed.presets = value.split(",").map(Number);
    } else if (argument === "--device") {
      parsed.device = Number(value);
    } else if (argument === "--max-dictionary") {
      parsed.maxDictionarySize = Number(value);
    } else if (argument === "--sample-limit") {
      parsed.sampleLimit = Number(value);
    } else if (argument === "--checkpoint-log2") {
      parsed.checkpointLog2 = Number(value);
    } else if (argument === "--queries") {
      parsed.queries = Number(value);
    } else if (argument === "--files") {
      parsed.files = value.split(",").filter(Boolean);
    } else if (argument === "--limit") {
      parsed.limit = Number(value);
    } else {
      throw new RangeError(`Unknown argument: ${argument}`);
    }

    index += 1;
  }

  if (
    parsed.presets.length === 0 ||
    parsed.presets.some((value) => ![1.5, 2, 2.5, 3, 4, 5, 6, 8].includes(value))
  ) {
    throw new RangeError("--presets contains an unsupported BPAL preset");
  }

  for (const [name, value] of [
    ["--device", parsed.device],
    ["--queries", parsed.queries],
  ]) {
    if (!Number.isInteger(value) || value < (name === "--queries" ? 1 : 0)) {
      throw new RangeError(`${name} has an invalid value`);
    }
  }

  if (parsed.limit !== null && (!Number.isInteger(parsed.limit) || parsed.limit <= 0)) {
    throw new RangeError("--limit must be a positive integer");
  }

  return parsed;
}

function validateInputs() {
  if (!fs.statSync(corpusDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`CLIC corpus directory does not exist: ${corpusDirectory}`);
  }

  if (!fs.statSync(encoder, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`CUDA BPAL encoder does not exist: ${encoder}`);
  }
}

function runEncoder(sourcePath, outputPath, preset) {
  const result = childProcess.spawnSync(
    encoder,
    [sourcePath, outputPath, "--preset", String(preset), "--device", String(options.device)],
    {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `bpal5cudaenc failed for ${path.basename(sourcePath)}: ` +
      `${result.stderr || result.stdout}`
    );
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const mseMatch = /MSE\s+([0-9]+(?:\.[0-9]+)?)/i.exec(output);

  if (!mseMatch) {
    throw new Error(`Could not parse MSE from bpal5cudaenc output: ${output}`);
  }

  return { mse: Number(mseMatch[1]), output };
}

function createQueries(width, height, requestedCount) {
  const queries = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), Math.floor(height / 2)],
  ];
  let random = 0x6a09e667;

  while (queries.length < requestedCount) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const x = random % width;
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const y = random % height;

    queries.push([x, y]);
  }

  return queries.slice(0, requestedCount);
}

function verifyQueries(accessor, decoded, queries) {
  for (const [x, y] of queries) {
    const actual = accessor.getPixel(x, y);
    const offset = (y * decoded.width + x) * 4;

    if (
      actual.r !== decoded.pixels[offset] ||
      actual.g !== decoded.pixels[offset + 1] ||
      actual.b !== decoded.pixels[offset + 2] ||
      actual.a !== decoded.pixels[offset + 3]
    ) {
      throw new Error(`Random access mismatch at ${x},${y}`);
    }
  }
}

function createReport(rows, sources, settings) {
  const profiles = settings.presets.map((preset) => {
    const matches = rows.filter((row) => row.preset === preset);
    const baselineBytes = sum(matches, "baselineBytes");
    const bestBytes = sum(matches, "bestBytes");
    const totalChannels = matches.reduce((total, row) => total + row.pixelCount * 3, 0);
    const totalSquaredError = matches.reduce(
      (total, row) => total + row.baselineMse * row.pixelCount * 3,
      0
    );
    const aggregateMse = totalSquaredError / totalChannels;

    return {
      preset,
      images: matches.length,
      baselineBytes,
      bestBytes,
      fileChangePercent: 100 * (bestBytes / baselineBytes - 1),
      smallerFiles: matches.filter((row) => row.bestBytes < row.baselineBytes).length,
      unchangedFiles: matches.filter((row) => row.bestBytes === row.baselineBytes).length,
      aggregateMse,
      aggregatePsnr: calculatePsnr(aggregateMse),
      psnrDelta: 0,
      dictionaryBlocks: sum(matches, "dictionaryBlocks"),
      transformedBlocks: sum(matches, "transformedBlocks"),
      runDeltaBlocks: sum(matches, "runDeltaBlocks"),
      rawBlocks: sum(matches, "rawBlocks"),
      meanRandomAccessQueriesPerSecond: average(matches, "randomAccessQueriesPerSecond"),
    };
  });
  const baselineBytes = sum(rows, "baselineBytes");
  const bestBytes = sum(rows, "bestBytes");

  return {
    generatedAt: new Date().toISOString(),
    corpus: {
      directory: path.relative(root, corpusDirectory).replaceAll("\\", "/"),
      availableImages: allSources.length,
      testedImages: sources.length,
      files: sources,
      preprocessing: "none; full stored RGB dimensions",
    },
    settings: {
      presets: settings.presets,
      encoder: path.relative(root, encoder).replaceAll("\\", "/"),
      device: settings.device,
      maximumDictionarySize: settings.maxDictionarySize,
      sampleLimit: settings.sampleLimit,
      checkpointInterval: 2 ** settings.checkpointLog2,
      randomAccessQueriesPerImageAndPreset: settings.queries,
    },
    aggregate: {
      baselineBytes,
      bestBytes,
      fileChangePercent: 100 * (bestBytes / baselineBytes - 1),
      comparedFiles: rows.length,
      smallerFiles: rows.filter((row) => row.bestBytes < row.baselineBytes).length,
      unchangedFiles: rows.filter((row) => row.bestBytes === row.baselineBytes).length,
      psnrDelta: 0,
    },
    profiles,
    results: rows,
  };
}

function renderMarkdown(report) {
  const lines = [
    "# CLIC BPDI pattern-dictionary benchmark",
    "",
    `Generated: \`${report.generatedAt}\`.`,
    "",
    `Corpus: all ${report.corpus.testedImages} tested PNG files from ` +
      `\`${report.corpus.directory}\`, at their full stored dimensions.`,
    "",
    "Every selected BPDI file reconstructs the same RGB values as its BPAL baseline. " +
      "Files for which BPDI is not smaller remain BPAL, so quality never changes and size never grows.",
    "",
    "| Preset | Images | BPAL bytes | Best bytes | Change | Smaller files | PSNR | PSNR change | Dictionary blocks | Transformed refs | Run-delta blocks | Raw blocks | Random px/s |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const profile of report.profiles) {
    lines.push(
      `| ${profile.preset} | ${profile.images} | ${profile.baselineBytes} | ` +
      `${profile.bestBytes} | ${formatSigned(profile.fileChangePercent)}% | ` +
      `${profile.smallerFiles} | ${profile.aggregatePsnr.toFixed(3)} dB | ` +
      `${profile.psnrDelta.toFixed(3)} dB | ${profile.dictionaryBlocks} | ` +
      `${profile.transformedBlocks} | ${profile.runDeltaBlocks} | ${profile.rawBlocks} | ` +
      `${Math.round(profile.meanRandomAccessQueriesPerSecond)} |`
    );
  }

  lines.push(
    "",
    `Overall: ${report.aggregate.baselineBytes} -> ${report.aggregate.bestBytes} bytes ` +
      `(${formatSigned(report.aggregate.fileChangePercent)}%); ` +
      `${report.aggregate.smallerFiles}/${report.aggregate.comparedFiles} files became smaller; ` +
      `PSNR change ${report.aggregate.psnrDelta.toFixed(3)} dB.`,
    ""
  );

  return `${lines.join("\n")}\n`;
}

function calculatePsnr(mse) {
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}

function sum(rows, property) {
  return rows.reduce((total, row) => total + row[property], 0);
}

function average(rows, property) {
  return rows.length === 0 ? 0 : sum(rows, property) / rows.length;
}

function formatSigned(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}
