#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  HEADER_BYTES,
  PRESETS,
  calculateSquaredError,
  decodeDctFile,
  encodeDctFile,
  inspectDctFile,
} = require("../src/dct/dct-format.js");

const args = parseArgs(process.argv.slice(2));
const corpusDirectory = path.resolve(args.corpus);
const manifest = JSON.parse(fs.readFileSync(path.join(corpusDirectory, "manifest.json"), "utf8"));
const prior = args.baseline ? JSON.parse(fs.readFileSync(path.resolve(args.baseline), "utf8")) : null;
const presets = splitList(args.presets || Object.keys(PRESETS).join(","));
const modes = splitList(args.modes || "baseline,header3,sidecar3,sidecar8,sidecar16,sidecar32");
const images = selectBalanced(manifest.images, Number(args.limit || 0));
const recordsPath = path.resolve(args.records);
const completedRecords = readJsonLines(recordsPath);
const completed = new Set(completedRecords.map(recordKey));
const qualityByImagePreset = new Map();
const total = images.length * presets.length * modes.length;
let finished = completedRecords.length;

if (prior) {
  for (const record of prior.records || []) {
    if (record.coefficientCoding === defaultCoding(record.preset)) {
      qualityByImagePreset.set(`${record.imageId}\0${record.preset}`, record.quality);
    }
  }
}

fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
for (const image of images) {
  const pixels = loadRgba(image);
  for (const preset of presets) {
    for (const mode of modes) {
      const key = recordKey({ imageId: image.id, preset, mode });
      if (completed.has(key)) {
        continue;
      }
      const quality = qualityByImagePreset.get(`${image.id}\0${preset}`) || fallbackQuality(preset);
      const options = modeOptions(mode, preset, quality);
      const encodeStarted = performance.now();
      const encoded = encodeDctFile(pixels, image.width, image.height, options);
      const encodeMilliseconds = performance.now() - encodeStarted;
      const decodeStarted = performance.now();
      const decoded = decodeDctFile(encoded);
      const decodeMilliseconds = performance.now() - decodeStarted;
      const info = inspectDctFile(encoded);
      const references = countYReferences(encoded, info);
      const record = {
        imageId: image.id,
        dataset: image.dataset,
        imageClass: image.imageClass,
        contentClass: image.contentClass,
        width: image.width,
        height: image.height,
        preset,
        payloadBpp: PRESETS[preset].bpp,
        mode,
        quality,
        coefficientCoding: defaultCoding(preset),
        encodedBytes: encoded.length,
        payloadBytes: info.payloadBytes,
        libraryBytes: info.libraryBytes,
        librarySize: info.libraryEnabled ? info.library.y.count : 0,
        referenceCoding: info.libraryEnabled ? info.library.referenceCoding : "none",
        frequencySplit: info.libraryEnabled ? info.library.frequencySplit : 0,
        yBlocks: references.total,
        yReferencedBlocks: references.referenced,
        yReferenceHistogram: references.histogram,
        squaredErrorRgb: calculateSquaredError(pixels, decoded.pixels),
        rgbSampleCount: image.width * image.height * 3,
        encodeMilliseconds,
        decodeMilliseconds,
      };
      fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
      completed.add(key);
      finished += 1;
      if (finished % 10 === 0 || finished === total) {
        process.stdout.write(`\r${finished}/${total}`);
      }
    }
  }
}
process.stdout.write("\n");

function modeOptions(mode, preset, quality) {
  const options = { preset, quality, coefficientCoding: defaultCoding(preset) };
  if (mode === "baseline") {
    return options;
  }
  if (mode === "header3") {
    return { ...options, dctLibrary: true, librarySize: 3, libraryComponents: ["y"] };
  }
  const match = /^sidecar(3|8|16|32)(q|h|f)?$/.exec(mode);
  if (!match) {
    throw new RangeError(`Unknown large-library benchmark mode: ${mode}`);
  }
  const split = match[2] === "q" ? 0.25 : match[2] === "h" ? 0.5 : match[2] === "f" ? 1 : 0;
  return {
    ...options,
    dctLibrary: true,
    librarySize: Number(match[1]),
    libraryComponents: ["y"],
    libraryReferenceCoding: "sidecar",
    libraryFrequencySplit: split,
    libraryClusterSamples: Number(args["cluster-samples"] || 2048),
    libraryCandidateCount: Number(args["candidate-count"] || 2),
  };
}

function countYReferences(bytes, info) {
  if (!info.libraryEnabled || info.library.y.count === 0) {
    return { total: 0, referenced: 0, histogram: [] };
  }
  const blocksPerMcu = info.splitLuma8x8 ? 4 : 1;
  const blockBytes = info.splitLuma8x8 ? info.yBytes / 4 : info.yBytes;
  const total = info.mcuCount * blocksPerMcu;
  const histogram = Array(info.library.y.count + 1).fill(0);
  for (let index = 0; index < total; index += 1) {
    let libraryIndex;
    if (info.library.referenceCoding === "sidecar") {
      libraryIndex = readPackedReference(bytes, info.library.y.reference, index);
    } else {
      const mcu = Math.floor(index / blocksPerMcu);
      const block = index % blocksPerMcu;
      libraryIndex = (bytes[HEADER_BYTES + mcu * info.bytesPerMcu + block * blockBytes] >>> 6) & 3;
    }
    histogram[libraryIndex] += 1;
  }
  return { total, referenced: total - histogram[0], histogram };
}

function readPackedReference(bytes, reference, index) {
  const bitOffset = reference.offset * 8 + index * reference.bits;
  let value = 0;
  for (let bit = 0; bit < reference.bits; bit += 1) {
    const position = bitOffset + bit;
    value |= ((bytes[position >> 3] >> (position & 7)) & 1) << bit;
  }
  return value;
}

function loadRgba(image) {
  const rgb = fs.readFileSync(path.join(corpusDirectory, image.file));
  if (rgb.length !== image.width * image.height * 3) {
    throw new RangeError(`Unexpected RGB byte count for ${image.id}`);
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

function selectBalanced(source, limit) {
  if (!limit || limit >= source.length) {
    return source;
  }
  const groups = new Map();
  for (const image of source) {
    const group = groups.get(image.dataset) || [];
    group.push(image);
    groups.set(image.dataset, group);
  }
  const selected = [];
  const names = [...groups.keys()].sort();
  for (let index = 0; selected.length < limit; index += 1) {
    let added = false;
    for (const name of names) {
      const group = groups.get(name);
      if (index < group.length) {
        selected.push(group[index]);
        added = true;
        if (selected.length === limit) {
          break;
        }
      }
    }
    if (!added) {
      break;
    }
  }
  return selected;
}

function defaultCoding(preset) {
  return preset === "0.75" || preset === "1" || preset === "2"
    ? "grouped-5-equal-2" : "grouped-5-front";
}

function fallbackQuality(preset) {
  return preset === "0.75" || preset === "1" ? 97 : 100;
}

function recordKey(record) {
  return `${record.imageId}\0${record.preset}\0${record.mode}`;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function splitList(value) {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new RangeError(`Unexpected argument: ${key}`);
    }
    parsed[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!parsed.corpus || !parsed.records) {
    throw new RangeError("--corpus and --records are required");
  }
  return parsed;
}
