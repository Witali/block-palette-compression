#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const recordFiles = String(args.records).split(",").map((file) => path.resolve(file.trim()));
const records = recordFiles.flatMap(readJsonLines);
const groups = aggregate(records);
const presets = ["0.75", "1", "1.5", "2", "3", "4.5", "6"];
const modes = ["baseline", "header3", "sidecar32", "sidecar32q"];
const rows = [];

for (const preset of presets) {
  const baseline = finalize(groups.get(`${preset}\0baseline`));
  for (const mode of modes) {
    const result = finalize(groups.get(`${preset}\0${mode}`));
    rows.push({
      preset,
      mode,
      ...result,
      psnrDelta: result.psnr - baseline.psnr,
    });
  }
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpus: {
    imageCount: new Set(records.map((record) => record.imageId)).size,
    width: records[0].width,
    height: records[0].height,
    datasetCounts: countUniqueByDataset(records),
  },
  comparison: "Pooled RGB PSNR at identical fixed MCU payload; library and sidecar bytes excluded from selection",
  rows,
};

fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(summary, null, 2)}\n`);
fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
fs.writeFileSync(path.resolve(args.report), renderMarkdown(summary));
console.log(`Wrote ${path.resolve(args.output)}`);
console.log(`Wrote ${path.resolve(args.report)}`);

function aggregate(source) {
  const groups = new Map();
  for (const record of source) {
    const key = `${record.preset}\0${record.mode}`;
    const group = groups.get(key) || {
      mode: record.mode,
      preset: record.preset,
      images: 0,
      squaredErrorRgb: 0,
      rgbSampleCount: 0,
      yBlocks: 0,
      yReferencedBlocks: 0,
      libraryBytes: 0,
      encodedBytes: 0,
      encodeMilliseconds: 0,
      librarySize: record.librarySize,
    };
    group.images += 1;
    group.squaredErrorRgb += record.squaredErrorRgb;
    group.rgbSampleCount += record.rgbSampleCount;
    group.yBlocks += record.yBlocks;
    group.yReferencedBlocks += record.yReferencedBlocks;
    group.libraryBytes += record.libraryBytes;
    group.encodedBytes += record.encodedBytes;
    group.encodeMilliseconds += record.encodeMilliseconds;
    groups.set(key, group);
  }
  return groups;
}

function finalize(group) {
  if (!group) {
    throw new RangeError("Missing benchmark group");
  }
  const mse = group.squaredErrorRgb / group.rgbSampleCount;
  return {
    imageCount: group.images,
    psnr: 10 * Math.log10(255 * 255 / mse),
    referencePercent: group.yBlocks ? group.yReferencedBlocks * 100 / group.yBlocks : 0,
    averageUsesPerPrototype: group.librarySize
      ? group.yReferencedBlocks / group.images / group.librarySize : 0,
    averageLibraryBytes: group.libraryBytes / group.images,
    averageEncodedBytes: group.encodedBytes / group.images,
    averageEncodeMilliseconds: group.encodeMilliseconds / group.images,
  };
}

function renderMarkdown(summary) {
  const labels = {
    baseline: "Baseline",
    header3: "Header library K=3",
    sidecar32: "Sidecar library K=32",
    sidecar32q: "Spectral-split sidecar K=32 (25%)",
  };
  const lines = [
    "# Large-texture DCT prototype-library benchmark",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    `Corpus: ${summary.corpus.imageCount} deterministic ${summary.corpus.width}x${summary.corpus.height} ` +
      `center crops (${Object.entries(summary.corpus.datasetCounts).map(([name, count]) => `${name} ${count}`).join(", ")}).`,
    "",
    "The comparison uses identical fixed MCU payloads. Prototype records and the sidecar index stream are intentionally excluded from the selection criterion; their cost can be amortized or evaluated separately.",
    "",
    "The sidecar mode keeps existing DCT profiles unchanged. It stores directly addressed per-block library indices outside the MCU records: 5 bits for 16 prototypes plus raw mode, or 6 bits for 32 prototypes plus raw mode.",
    "",
    "| Payload bpp | Mode | PSNR RGB | Delta vs baseline | Referenced Y blocks | Mean uses / prototype / image |",
    "| ---: | :--- | ---: | ---: | ---: | ---: |",
  ];
  for (const row of summary.rows) {
    lines.push(
      `| ${row.preset} | ${labels[row.mode]} | ${row.psnr.toFixed(3)} dB | ` +
      `${formatSigned(row.psnrDelta, 3)} dB | ${row.referencePercent.toFixed(2)}% | ` +
      `${row.averageUsesPerPrototype.toFixed(1)} |`
    );
  }
  lines.push(
    "",
    "## Selected profile",
    "",
    "For each payload, select the higher-PSNR result between the regular K=32 sidecar library and the 25% spectral-split K=32 sidecar library. The existing baseline and three-entry header library remain independent formats.",
    "",
    "| Payload bpp | Selected library mode | PSNR delta | Referenced Y blocks |",
    "| ---: | :--- | ---: | ---: |"
  );
  for (const preset of ["0.75", "1", "1.5", "2", "3", "4.5", "6"]) {
    const candidates = summary.rows.filter((row) => row.preset === preset &&
      ["sidecar32", "sidecar32q"].includes(row.mode));
    candidates.sort((left, right) => right.psnr - left.psnr);
    const best = candidates[0];
    lines.push(`| ${preset} | ${labels[best.mode]} | ${formatSigned(best.psnrDelta, 3)} dB | ${best.referencePercent.toFixed(2)}% |`);
  }
  lines.push(
    "",
    "## Prototype-count pilot",
    "",
    "A balanced 12-image pilot compared 3, 8, 16, and 32 sidecar prototypes before the full run. K=32 was the best regular sidecar size at every sampled rate. Its PSNR gains over baseline were +0.125, +0.142, and +0.332 dB at 1, 3, and 6 bpp, versus +0.088, +0.107, and +0.283 dB for K=16. The full 200-image run therefore uses K=32.",
    "",
    "## Reproduction",
    "",
    "```text",
    "python tools/prepare_dct_large_texture_corpus.py --selection-manifest .tmp/dct-exponent-corpus-128/manifest.json --source-root .benchmark-corpus --output-dir .tmp/dct-library-corpus-512 --crop-size 512 --dtd-count 100",
    "node tools/dct_large_library_benchmark.js --corpus .tmp/dct-library-corpus-512 --baseline .tmp/dct-exponent-final.json --records .tmp/dct-large-full.jsonl --modes baseline,header3,sidecar32,sidecar32q --candidate-count 4 --cluster-samples 4096",
    "node tools/summarize_dct_large_library_benchmark.js --records .tmp/dct-large-full.jsonl --output .tmp/dct-large-library-200.json --report benchmark/results/dct-large-library-200.md",
    "```"
  );
  return `${lines.join("\n")}\n`;
}

function countUniqueByDataset(source) {
  const ids = new Map();
  for (const record of source) {
    ids.set(record.imageId, record.dataset);
  }
  const counts = {};
  for (const dataset of ids.values()) {
    counts[dataset] = (counts[dataset] || 0) + 1;
  }
  return counts;
}

function formatSigned(value, digits) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function readJsonLines(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    parsed[argv[index].replace(/^--/, "")] = argv[index + 1];
  }
  if (!parsed.records || !parsed.output || !parsed.report) {
    throw new RangeError("--records, --output, and --report are required");
  }
  return parsed;
}
