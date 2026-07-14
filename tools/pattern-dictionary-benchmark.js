"use strict";

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
const assetDirectory = path.join(root, "assets", "bpal");
const options = parseOptions(process.argv.slice(2));
const allFiles = fs.readdirSync(assetDirectory)
  .filter((name) => name.toLowerCase().endsWith(".bpal"))
  .sort();
const files = options.files.length === 0
  ? allFiles
  : allFiles.filter((name) => options.files.some((filter) => name.includes(filter)));

if (files.length === 0) {
  throw new Error("No BPAL files matched the requested filters");
}

const results = [];

for (const name of files) {
  const sourcePath = path.join(assetDirectory, name);
  const sourceBytes = fs.readFileSync(sourcePath);
  const decoded = decodeBlockPaletteFile(sourceBytes);
  const started = performance.now();
  const encoded = encodeSmallestRandomAccessFile(decoded, {
    maxDictionarySize: options.maxDictionarySize,
    sampleLimit: options.sampleLimit,
    checkpointLog2: options.checkpointLog2,
  });
  const encodeMilliseconds = performance.now() - started;
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

  results.push({
    name,
    width: decoded.width,
    height: decoded.height,
    sourceBytes: sourceBytes.length,
    encodedBytes: encoded.bytes.length,
    format: encoded.format.toUpperCase(),
    fileChangePercent: 100 * (encoded.bytes.length / sourceBytes.length - 1),
    originalPixelBits: stats.originalPixelBits,
    encodedPixelBits: stats.encodedPixelBits,
    pixelChangePercent: stats.originalPixelBits === 0
      ? 0
      : 100 * (stats.encodedPixelBits / stats.originalPixelBits - 1),
    dictionarySize: stats.selected ? stats.dictionarySize : 0,
    rawBlocks: stats.rawBlocks,
    referencedBlocks: stats.referencedBlocks,
    transformedBlocks: stats.transformedBlocks,
    bitmapDeltaBlocks: stats.bitmapDeltaBlocks,
    runLengthBlocks: stats.runLengthBlocks,
    exactBlocks: stats.exactBlocks,
    totalEdits: stats.totalEdits,
    encodeMilliseconds,
    randomAccessQueries: queries.length,
    randomAccessMilliseconds: accessMilliseconds,
    randomAccessQueriesPerSecond: queries.length / accessMilliseconds * 1000,
    checksum,
    quality: "byte-identical decoded RGB at every verified coordinate",
  });

  console.error(
    `${name}: ${sourceBytes.length} -> ${encoded.bytes.length} bytes, ` +
    `${formatSigned(results.at(-1).fileChangePercent)}%, ${encoded.format.toUpperCase()}, ` +
    `K=${results.at(-1).dictionarySize}`
  );
}

printMarkdown(results, options);

function parseOptions(args) {
  const parsed = {
    maxDictionarySize: 64,
    sampleLimit: 8192,
    checkpointLog2: 4,
    queries: 4096,
    files: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument === "--max-dictionary") {
      parsed.maxDictionarySize = Number(value);
      index += 1;
    } else if (argument === "--sample-limit") {
      parsed.sampleLimit = Number(value);
      index += 1;
    } else if (argument === "--checkpoint-log2") {
      parsed.checkpointLog2 = Number(value);
      index += 1;
    } else if (argument === "--queries") {
      parsed.queries = Number(value);
      index += 1;
    } else if (argument === "--files") {
      parsed.files = value.split(",").filter(Boolean);
      index += 1;
    } else {
      throw new RangeError(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isInteger(parsed.queries) || parsed.queries <= 0) {
    throw new RangeError("--queries must be a positive integer");
  }

  return parsed;
}

function createQueries(width, height, requestedCount) {
  const queries = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), Math.floor(height / 2)],
  ];
  let random = 0x9e3779b9;

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
      throw new Error(`Random access mismatch in ${x},${y}`);
    }
  }
}

function printMarkdown(rows, settings) {
  const sourceBytes = sum(rows, "sourceBytes");
  const encodedBytes = sum(rows, "encodedBytes");
  const originalPixelBits = sum(rows, "originalPixelBits");
  const encodedPixelBits = sum(rows, "encodedPixelBits");

  console.log("# BPDI pattern-dictionary benchmark");
  console.log("");
  console.log(
    `Settings: maximum dictionary ${settings.maxDictionarySize}, sample limit ` +
    `${settings.sampleLimit}, checkpoint interval ${2 ** settings.checkpointLog2} blocks.`
  );
  console.log("");
  console.log(
    "Every reported random-access query matched the RGB pixel decoded from the source BPAL. " +
    "The exact dictionary representation therefore preserves source-relative MSE and PSNR."
  );
  console.log("");
  console.log("| File | BPAL bytes | Best bytes | Format | File change | Pixel stream change | K | Dictionary refs | Transformed refs | Bitmap deltas | Run-delta blocks | Blocks | Exact refs | Encode ms | Random px/s |");
  console.log("| --- | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

  for (const row of rows) {
    console.log(
      `| ${row.name} | ${row.sourceBytes} | ${row.encodedBytes} | ${row.format} | ` +
      `${formatSigned(row.fileChangePercent)}% | ${formatSigned(row.pixelChangePercent)}% | ` +
      `${row.dictionarySize} | ${row.referencedBlocks} | ${row.transformedBlocks} | ` +
      `${row.bitmapDeltaBlocks} | ${row.runLengthBlocks} | ` +
      `${row.rawBlocks + row.referencedBlocks + row.runLengthBlocks} | ${row.exactBlocks} | ` +
      `${row.encodeMilliseconds.toFixed(1)} | ` +
      `${Math.round(row.randomAccessQueriesPerSecond)} |`
    );
  }

  console.log("");
  console.log(
    `Aggregate: ${sourceBytes} -> ${encodedBytes} bytes ` +
    `(${formatSigned(100 * (encodedBytes / sourceBytes - 1))}%), pixel-index sections ` +
    `${formatSigned(100 * (encodedPixelBits / originalPixelBits - 1))}%.`
  );
  console.log("");
  console.log("```json");
  console.log(JSON.stringify({ settings, aggregate: {
    sourceBytes,
    encodedBytes,
    fileChangePercent: 100 * (encodedBytes / sourceBytes - 1),
    originalPixelBits,
    encodedPixelBits,
    pixelChangePercent: 100 * (encodedPixelBits / originalPixelBits - 1),
  }, results: rows }, null, 2));
  console.log("```");
}

function sum(rows, property) {
  return rows.reduce((total, row) => total + row[property], 0);
}

function formatSigned(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}
