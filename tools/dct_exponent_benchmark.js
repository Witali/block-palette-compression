#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  COEFFICIENT_CODINGS,
  PRESETS,
  encodeDctFile,
  decodeDctFile,
  calculateSquaredError,
} = require("../src/dct/dct-format.js");

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(args.manifest);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestDirectory = path.dirname(manifestPath);
const codingKeys = splitList(args.profiles || COEFFICIENT_CODINGS.map((item) => item.key).join(","));
const presetKeys = splitList(args.presets || Object.keys(PRESETS).join(","));
const qualities = splitList(args.qualities || "97").map(Number);
const images = selectBalanced(manifest.images, Number(args.limit || manifest.images.length));
const records = [];
const total = images.length * codingKeys.length * presetKeys.length;
let completed = 0;
const started = performance.now();

for (const image of images) {
  const pixels = loadRgba(path.join(manifestDirectory, image.file), image.width, image.height);

  for (const coefficientCoding of codingKeys) {
    for (const preset of presetKeys) {
      let best = null;

      for (const quality of qualities) {
        const encodeStarted = performance.now();
        const encoded = encodeDctFile(pixels, image.width, image.height, {
          preset,
          quality,
          coefficientCoding,
        });
        const encodeMilliseconds = performance.now() - encodeStarted;
        const decodeStarted = performance.now();
        const decoded = decodeDctFile(encoded);
        const decodeMilliseconds = performance.now() - decodeStarted;
        const squaredErrorRgb = calculateSquaredError(pixels, decoded.pixels);
        const candidate = {
          quality,
          encodedBytes: encoded.length,
          squaredErrorRgb,
          encodeMilliseconds,
          decodeMilliseconds,
        };

        if (!best || candidate.squaredErrorRgb < best.squaredErrorRgb ||
            (candidate.squaredErrorRgb === best.squaredErrorRgb && candidate.quality > best.quality)) {
          best = candidate;
        }
      }

      const rgbSampleCount = image.width * image.height * 3;
      records.push({
        imageId: image.id,
        dataset: image.dataset,
        imageClass: image.imageClass,
        contentClass: image.contentClass,
        width: image.width,
        height: image.height,
        coefficientCoding,
        preset,
        bpp: PRESETS[preset].bpp,
        rgbSampleCount,
        psnrRgb: psnr(best.squaredErrorRgb / rgbSampleCount),
        ...best,
      });

      completed += 1;
      if (completed % 25 === 0 || completed === total) {
        const elapsed = (performance.now() - started) / 1000;
        process.stdout.write(`\r${completed}/${total} (${elapsed.toFixed(1)} s)`);
      }
    }
  }
}

process.stdout.write("\n");
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpus: {
    imageCount: images.length,
    datasetCounts: countBy(images, (image) => image.dataset),
    crop: manifest.crop,
    cropSize: manifest.cropSize,
  },
  method: {
    qualities,
    selection: "lowest exact RGB squared error per image among listed qualities",
    aggregation: "pooled RGB PSNR",
  },
  profiles: codingKeys.map((key) => COEFFICIENT_CODINGS.find((item) => item.key === key)),
  presets: presetKeys,
  aggregate: aggregateRecords(records),
  byDataset: Object.fromEntries(
    [...new Set(images.map((image) => image.dataset))].sort().map((dataset) => [
      dataset,
      aggregateRecords(records.filter((record) => record.dataset === dataset)),
    ])
  ),
  records,
};

fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`Wrote ${args.output}`);

function aggregateRecords(source) {
  const groups = new Map();

  for (const record of source) {
    const key = `${record.coefficientCoding}\0${record.preset}`;
    const group = groups.get(key) || {
      coefficientCoding: record.coefficientCoding,
      preset: record.preset,
      bpp: record.bpp,
      imageCount: 0,
      squaredErrorRgb: 0,
      rgbSampleCount: 0,
      encodedBytes: 0,
      encodeMilliseconds: 0,
      decodeMilliseconds: 0,
      qualityCounts: {},
      winsVsLegacy: 0,
    };

    group.imageCount += 1;
    group.squaredErrorRgb += record.squaredErrorRgb;
    group.rgbSampleCount += record.rgbSampleCount;
    group.encodedBytes += record.encodedBytes;
    group.encodeMilliseconds += record.encodeMilliseconds;
    group.decodeMilliseconds += record.decodeMilliseconds;
    group.qualityCounts[record.quality] = (group.qualityCounts[record.quality] || 0) + 1;
    groups.set(key, group);
  }

  const legacy = new Map(
    source.filter((record) => record.coefficientCoding === "legacy")
      .map((record) => [`${record.imageId}\0${record.preset}`, record])
  );
  for (const record of source) {
    if (record.coefficientCoding === "legacy") {
      continue;
    }
    const baseline = legacy.get(`${record.imageId}\0${record.preset}`);
    if (baseline && record.squaredErrorRgb < baseline.squaredErrorRgb) {
      groups.get(`${record.coefficientCoding}\0${record.preset}`).winsVsLegacy += 1;
    }
  }

  return [...groups.values()].map((group) => ({
    ...group,
    mseRgb: group.squaredErrorRgb / group.rgbSampleCount,
    psnrRgb: psnr(group.squaredErrorRgb / group.rgbSampleCount),
  })).sort((left, right) => left.bpp - right.bpp ||
    left.coefficientCoding.localeCompare(right.coefficientCoding));
}

function loadRgba(filePath, width, height) {
  const rgb = fs.readFileSync(filePath);
  if (rgb.length !== width * height * 3) {
    throw new RangeError(`Unexpected RGB byte count in ${filePath}`);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    rgba[target] = rgb[source];
    rgba[target + 1] = rgb[source + 1];
    rgba[target + 2] = rgb[source + 2];
    rgba[target + 3] = 255;
  }
  return rgba;
}

function selectBalanced(images, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit >= images.length) {
    return images;
  }
  const groups = new Map();
  for (const image of images) {
    const group = groups.get(image.dataset) || [];
    group.push(image);
    groups.set(image.dataset, group);
  }
  const selected = [];
  let index = 0;
  while (selected.length < limit) {
    for (const dataset of [...groups.keys()].sort()) {
      const image = groups.get(dataset)[index];
      if (image) {
        selected.push(image);
        if (selected.length === limit) {
          break;
        }
      }
    }
    index += 1;
  }
  return selected;
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function psnr(mse) {
  return mse === 0 ? null : 10 * Math.log10(255 * 255 / mse);
}

function splitList(value) {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key.startsWith("--") || values[index + 1] === undefined) {
      throw new Error(`Expected --name value, received ${key}`);
    }
    parsed[key.slice(2)] = values[index + 1];
  }
  if (!parsed.manifest || !parsed.output) {
    throw new Error("Usage: dct_exponent_benchmark.js --manifest FILE --output FILE [options]");
  }
  return parsed;
}
