#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: summarize_dct_exponent_benchmark.js RESULT.json");
}

const summary = JSON.parse(fs.readFileSync(input, "utf8"));
const selectedByPreset = new Map();
for (const preset of summary.presets) {
  const rows = summary.aggregate.filter((row) => row.preset === preset);
  const legacy = rows.find((row) => row.coefficientCoding === "legacy");
  rows.sort((left, right) => right.psnrRgb - left.psnrRgb);
  selectedByPreset.set(preset, rows[0].coefficientCoding);
  console.log(`${preset} bpp; legacy ${legacy.psnrRgb.toFixed(4)} dB`);
  for (const row of rows) {
    console.log([
      row.coefficientCoding.padEnd(24),
      `${row.psnrRgb.toFixed(4)} dB`,
      `delta ${(row.psnrRgb - legacy.psnrRgb).toFixed(4)} dB`,
      `wins ${row.winsVsLegacy}/${row.imageCount}`,
    ].join("; "));
  }
}

for (const [dataset, aggregate] of Object.entries(summary.byDataset || {})) {
  console.log(`dataset ${dataset}`);
  for (const preset of summary.presets) {
    const coding = selectedByPreset.get(preset);
    const legacy = aggregate.find((row) => row.preset === preset && row.coefficientCoding === "legacy");
    const selected = aggregate.find((row) => row.preset === preset && row.coefficientCoding === coding);
    console.log(
      `${preset} bpp; ${coding}; ${selected.psnrRgb.toFixed(4)} dB; ` +
      `delta ${(selected.psnrRgb - legacy.psnrRgb).toFixed(4)} dB; ` +
      `wins ${selected.winsVsLegacy}/${selected.imageCount}`
    );
  }
}
