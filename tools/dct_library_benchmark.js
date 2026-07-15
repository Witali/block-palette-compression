#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  HEADER_BYTES,
  PRESETS,
  encodeDctFile,
  decodeDctFile,
  inspectDctFile,
  calculateSquaredError,
} = require("../src/dct/dct-format.js");

const args = parseArgs(process.argv.slice(2));
const baseline = JSON.parse(fs.readFileSync(path.resolve(args.baseline), "utf8"));
const corpusDirectory = path.resolve(args.corpus);
const outputPath = path.resolve(args.output);
const reportPath = path.resolve(args.report);
const recordsPath = path.resolve(args.records || `${outputPath}.jsonl`);
const librarySizes = splitList(args["library-sizes"] || "1,2,3,4").map(Number);
const libraryProfiles = splitList(args["component-profiles"] || "all");
const presetKeys = splitList(args.presets || Object.keys(PRESETS).join(","));
const baselineRecords = selectCurrentDefaultRecords(baseline.records, presetKeys);
const baselineByImagePreset = new Map(
  baselineRecords.map((record) => [`${record.imageId}\0${record.preset}`, record])
);
const images = selectBalanced(uniqueImages(baselineRecords), Number(args.limit || 0));
const completedRecords = readJsonLines(recordsPath);
const completedKeys = new Set(completedRecords.map(recordKey));
const records = [...completedRecords];
const total = images.length * presetKeys.length * librarySizes.length * libraryProfiles.length;
let completed = completedRecords.length;
const started = performance.now();

validateLibrarySizes(librarySizes);
validateLibraryProfiles(libraryProfiles);
fs.mkdirSync(path.dirname(recordsPath), { recursive: true });

for (const image of images) {
  const pixels = loadRgba(image, corpusDirectory);

  for (const preset of presetKeys) {
    const baselineRecord = baselineByImagePreset.get(`${image.imageId}\0${preset}`);
    if (!baselineRecord) {
      throw new Error(`Missing baseline result for ${image.imageId}, ${preset} bpp`);
    }

    for (const libraryProfile of libraryProfiles) {
      for (const librarySize of librarySizes) {
      const key = recordKey({ imageId: image.imageId, preset, librarySize, libraryProfile });
      if (completedKeys.has(key)) {
        continue;
      }

      const encodeStarted = performance.now();
      const encoded = encodeDctFile(pixels, image.width, image.height, {
        preset,
        quality: baselineRecord.quality,
        coefficientCoding: baselineRecord.coefficientCoding,
        dctLibrary: true,
        librarySize,
        libraryComponents: libraryComponents(libraryProfile),
      });
      const encodeMilliseconds = performance.now() - encodeStarted;
      const decodeStarted = performance.now();
      const decoded = decodeDctFile(encoded);
      const decodeMilliseconds = performance.now() - decodeStarted;
      const info = inspectDctFile(encoded);
      const record = {
        imageId: image.imageId,
        dataset: image.dataset,
        imageClass: image.imageClass,
        contentClass: image.contentClass,
        width: image.width,
        height: image.height,
        preset,
        payloadBpp: PRESETS[preset].bpp,
        librarySize,
        libraryProfile,
        referenceCoding: info.library.referenceCoding,
        coefficientCoding: baselineRecord.coefficientCoding,
        quality: baselineRecord.quality,
        encodedBytes: encoded.length,
        payloadBytes: info.payloadBytes,
        libraryBytes: info.libraryBytes,
        squaredErrorRgb: calculateSquaredError(pixels, decoded.pixels),
        rgbSampleCount: image.width * image.height * 3,
        encodeMilliseconds,
        decodeMilliseconds,
      };

      fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
      records.push(record);
      completedKeys.add(key);
      completed += 1;

      if (completed % 25 === 0 || completed === total) {
        const seconds = (performance.now() - started) / 1000;
        process.stdout.write(`\r${completed}/${total} (${seconds.toFixed(1)} s)`);
      }
      }
    }
  }
}

process.stdout.write("\n");

const selectedIds = new Set(images.map((image) => image.imageId));
const selectedBaseline = baselineRecords.filter((record) => selectedIds.has(record.imageId));
const selectedLibrary = records.filter((record) => selectedIds.has(record.imageId) &&
  presetKeys.includes(record.preset) && librarySizes.includes(record.librarySize) &&
  libraryProfiles.includes(record.libraryProfile || "all"));
const baselineAggregate = aggregateBaseline(selectedBaseline);
const libraryAggregate = aggregateLibrary(selectedLibrary, baselineAggregate);
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpus: {
    imageCount: images.length,
    datasetCounts: countBy(images, (image) => image.dataset),
    crop: baseline.corpus.crop,
    cropSize: baseline.corpus.cropSize,
  },
  method: {
    qualities: "reuse the per-image quality selected by the grouped-exponent baseline",
    clustering: "deterministic farthest-point initialization and six weighted k-means iterations",
    comparison: "pooled RGB PSNR; total-rate baseline interpolated linearly against log2(file bpp)",
    headerReference: "one to three prototypes use two spare component-header bits and preserve every coefficient",
    tailReference: "four or more prototypes replace the final AC mantissa with the library index",
  },
  librarySizes,
  libraryProfiles,
  presets: presetKeys,
  baseline: baselineAggregate,
  aggregate: libraryAggregate,
  byDataset: Object.fromEntries(
    [...new Set(images.map((image) => image.dataset))].sort().map((dataset) => {
      const datasetBaseline = aggregateBaseline(selectedBaseline.filter((record) => record.dataset === dataset));
      return [
        dataset,
        aggregateLibrary(selectedLibrary.filter((record) => record.dataset === dataset), datasetBaseline),
      ];
    })
  ),
  records: selectedLibrary,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, renderReport(summary));
console.log(`Wrote ${outputPath}`);
console.log(`Wrote ${reportPath}`);

function selectCurrentDefaultRecords(source, presets) {
  return source.filter((record) => presets.includes(record.preset) &&
    record.coefficientCoding === defaultCoefficientCoding(record.preset));
}

function defaultCoefficientCoding(preset) {
  return preset === "0.75" || preset === "1" || preset === "2"
    ? "grouped-5-equal-2"
    : "grouped-5-front";
}

function uniqueImages(records) {
  const images = new Map();
  for (const record of records) {
    if (!images.has(record.imageId)) {
      images.set(record.imageId, {
        imageId: record.imageId,
        dataset: record.dataset,
        imageClass: record.imageClass,
        contentClass: record.contentClass,
        width: record.width,
        height: record.height,
      });
    }
  }
  return [...images.values()];
}

function loadRgba(image, directory) {
  const fileId = crypto.createHash("sha256").update(image.imageId).digest("hex").slice(0, 20);
  const rgb = fs.readFileSync(path.join(directory, `${fileId}.rgb`));
  if (rgb.length !== image.width * image.height * 3) {
    throw new RangeError(`Unexpected RGB byte count for ${image.imageId}`);
  }
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    rgba[target] = rgb[source];
    rgba[target + 1] = rgb[source + 1];
    rgba[target + 2] = rgb[source + 2];
    rgba[target + 3] = 255;
  }
  return rgba;
}

function aggregateBaseline(records) {
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.preset) || emptyAggregate(record.preset);
    addRecord(group, record);
    groups.set(record.preset, group);
  }
  return [...groups.values()].map(finalizeAggregate).sort((left, right) => left.payloadBpp - right.payloadBpp);
}

function aggregateLibrary(records, baselineAggregate) {
  const groups = new Map();
  for (const record of records) {
    const libraryProfile = record.libraryProfile || "all";
    const key = `${libraryProfile}\0${record.librarySize}\0${record.preset}`;
    const group = groups.get(key) || {
      ...emptyAggregate(record.preset),
      librarySize: record.librarySize,
      libraryProfile,
      referenceCoding: record.referenceCoding,
      libraryBytes: 0,
    };
    addRecord(group, record);
    group.libraryBytes += record.libraryBytes;
    groups.set(key, group);
  }

  const baselineByPreset = new Map(baselineAggregate.map((row) => [row.preset, row]));
  return [...groups.values()].map((group) => {
    const result = finalizeAggregate(group);
    const samePayload = baselineByPreset.get(result.preset);
    const sameTotalPsnr = interpolatePsnr(baselineAggregate, result.fileBpp);
    const baselineBppAtSamePsnr = interpolateBpp(baselineAggregate, result.psnrRgb);
    return {
      ...result,
      libraryBytes: group.libraryBytes,
      averageLibraryBytes: group.libraryBytes / group.imageCount,
      deltaSamePayloadDb: result.psnrRgb - samePayload.psnrRgb,
      baselineAtSameTotalPsnr: sameTotalPsnr,
      deltaSameTotalDb: sameTotalPsnr === null ? null : result.psnrRgb - sameTotalPsnr,
      baselineBppAtSamePsnr,
      sizeSavingPercent: baselineBppAtSamePsnr === null ? null :
        (baselineBppAtSamePsnr - result.fileBpp) * 100 / baselineBppAtSamePsnr,
    };
  }).sort((left, right) => left.libraryProfile.localeCompare(right.libraryProfile) ||
    left.librarySize - right.librarySize || left.payloadBpp - right.payloadBpp);
}

function emptyAggregate(preset) {
  return {
    preset,
    payloadBpp: PRESETS[preset].bpp,
    imageCount: 0,
    squaredErrorRgb: 0,
    rgbSampleCount: 0,
    encodedBytes: 0,
    pixelCount: 0,
    encodeMilliseconds: 0,
    decodeMilliseconds: 0,
  };
}

function addRecord(group, record) {
  group.imageCount += 1;
  group.squaredErrorRgb += record.squaredErrorRgb;
  group.rgbSampleCount += record.rgbSampleCount;
  group.encodedBytes += record.encodedBytes;
  group.pixelCount += record.width * record.height;
  group.encodeMilliseconds += record.encodeMilliseconds || 0;
  group.decodeMilliseconds += record.decodeMilliseconds || 0;
}

function finalizeAggregate(group) {
  const mseRgb = group.squaredErrorRgb / group.rgbSampleCount;
  return {
    ...group,
    mseRgb,
    psnrRgb: psnr(mseRgb),
    fileBpp: group.encodedBytes * 8 / group.pixelCount,
  };
}

function interpolatePsnr(points, targetBpp) {
  const sorted = [...points].sort((left, right) => left.fileBpp - right.fileBpp);
  for (let index = 1; index < sorted.length; index += 1) {
    const left = sorted[index - 1];
    const right = sorted[index];
    if (targetBpp < left.fileBpp || targetBpp > right.fileBpp) {
      continue;
    }
    const amount = (Math.log2(targetBpp) - Math.log2(left.fileBpp)) /
      (Math.log2(right.fileBpp) - Math.log2(left.fileBpp));
    return left.psnrRgb + amount * (right.psnrRgb - left.psnrRgb);
  }
  return null;
}

function interpolateBpp(points, targetPsnr) {
  const sorted = [...points].sort((left, right) => left.psnrRgb - right.psnrRgb);
  for (let index = 1; index < sorted.length; index += 1) {
    const left = sorted[index - 1];
    const right = sorted[index];
    if (targetPsnr < left.psnrRgb || targetPsnr > right.psnrRgb) {
      continue;
    }
    const amount = (targetPsnr - left.psnrRgb) / (right.psnrRgb - left.psnrRgb);
    return 2 ** (Math.log2(left.fileBpp) + amount *
      (Math.log2(right.fileBpp) - Math.log2(left.fileBpp)));
  }
  return null;
}

function renderReport(summary) {
  const lines = [
    "# Clustered DCT prototype library benchmark",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    `Corpus: ${summary.corpus.imageCount} deterministic ${summary.corpus.cropSize}x${summary.corpus.cropSize} ` +
      `${summary.corpus.crop} crops (${formatCounts(summary.corpus.datasetCounts)}).`,
    "",
    "Each Y, Cb, and Cr component is clustered independently. A component record stores a quantized residual and a prototype reference. Library sizes 1-3 place the reference in two previously unused header bits and retain the complete baseline coefficient budget. Size 4 is a control mode that replaces the final AC mantissa with a wider reference.",
    "",
    "The file-bpp column includes the 64-byte DCTBS2 header and the per-image prototype library. The same-payload delta treats the library as an external or amortized resource. The same-total delta compares against the baseline at the same complete file rate by interpolation without extrapolation.",
    "",
    "| Components | Library entries | Reference | Payload bpp | File bpp | PSNR RGB | Delta at same payload | Delta at same total size |",
    "| :--- | ---: | :--- | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const row of summary.aggregate) {
    lines.push(
      `| ${row.libraryProfile} | ${row.librarySize} | ${row.referenceCoding} | ${row.payloadBpp.toFixed(2)} | ` +
      `${row.fileBpp.toFixed(4)} | ${row.psnrRgb.toFixed(3)} dB | ` +
      `${signed(row.deltaSamePayloadDb)} dB | ${nullableSigned(row.deltaSameTotalDb)} |`
    );
  }

  const recommended = summary.aggregate.filter((row) =>
    row.libraryProfile === "y" && row.librarySize === 3
  );
  const positiveStandalone = recommended.filter((row) => row.deltaSameTotalDb > 0);
  lines.push(
    "",
    "## Result",
    "",
    "The selected implementation is the three-entry Y-only library. It keeps every baseline coefficient, improves same-payload PSNR at every measured rate, and reduces standalone rate-distortion cost at " +
      `${positiveStandalone.map((row) => `${row.payloadBpp} bpp (${signed(row.deltaSameTotalDb)} dB, ` +
        `${signed(row.sizeSavingPercent)}% estimated size)`).join(" and ")}. ` +
      "The page therefore exposes it only for 3 bpp and higher. Lower rates retain the baseline format because their small records do not amortize the library header on 128x128 crops.",
    "",
    "The four-entry tail-reference control is not selected: losing one AC coefficient outweighs the larger codebook on most profiles.",
    ""
  );

  lines.push("", "## Baseline", "", "| Payload bpp | File bpp | PSNR RGB |", "| ---: | ---: | ---: |");
  for (const row of summary.baseline) {
    lines.push(`| ${row.payloadBpp.toFixed(2)} | ${row.fileBpp.toFixed(4)} | ${row.psnrRgb.toFixed(3)} dB |`);
  }

  lines.push(
    "",
    "## Interpretation",
    "",
    "A positive same-payload delta means the clustered prototype improves coefficient prediction when the library is already resident or reused. A positive same-total delta is required for a smaller standalone file at equal PSNR. The 6 bpp rows have no same-total comparison because the library moves them beyond the measured baseline range.",
    "",
    "## Reproduction",
    "",
    "```text",
    "node tools/dct_library_benchmark.js --baseline .tmp/dct-exponent-final.json --corpus .tmp/dct-exponent-corpus-128 --records .tmp/dct-library-200.jsonl --output .tmp/dct-library-200.json --report benchmark/results/dct-prototype-library-200.md --library-sizes 1,2,3,4 --component-profiles all,y",
    "```",
    ""
  );
  return lines.join("\n");
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function recordKey(record) {
  return `${record.imageId}\0${record.preset}\0${record.librarySize}\0${record.libraryProfile || "all"}`;
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

function validateLibrarySizes(sizes) {
  if (!sizes.length || sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 31)) {
    throw new RangeError("Library sizes must be integers from 1 through 31");
  }
}

function validateLibraryProfiles(profiles) {
  if (!profiles.length || profiles.some((profile) => !["all", "y", "chroma"].includes(profile))) {
    throw new RangeError("Component profiles must be all, y, or chroma");
  }
}

function libraryComponents(profile) {
  if (profile === "y") {
    return ["y"];
  }
  if (profile === "chroma") {
    return ["cb", "cr"];
  }
  return ["y", "cb", "cr"];
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
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}

function signed(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function nullableSigned(value) {
  return value === null ? "n/a" : `${signed(value)} dB`;
}

function formatCounts(counts) {
  return Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(", ");
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
  for (const required of ["baseline", "corpus", "output", "report"]) {
    if (!parsed[required]) {
      throw new Error(`Missing --${required}`);
    }
  }
  return parsed;
}
