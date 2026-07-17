#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const DctImageFormat = require("../src/dct/dct-format.js");
const { GpuJpegDecoder } = require("../src/decoders/gpu-jpeg.js");
const FLAG_OPTIONS = new Set(["auto-quality", "dct-library", "progress", "json", "help"]);

const HELP = `DCTBS2 canonical JavaScript command-line encoder

This tool calls src/dct/dct-format.js directly, so its codec algorithms are the
same ones used by the web encoder.

Usage:
  node tools/dctbs2-cli.js encode <input> <output.dctbs2> [options]
  node tools/dctbs2-cli.js decode <input.dctbs2> <output.ppm|output.rgb|output.rgba>
  node tools/dctbs2-cli.js info <input.dctbs2> [--json]
  node tools/dctbs2-cli.js pixel <input.dctbs2> <x> <y> [--json]
  node tools/dctbs2-cli.js presets [--json]

Input formats:
  JPEG (.jpg/.jpeg), binary PPM P6 (.ppm/.pnm), RGB24 (.rgb), RGBA32 (.rgba)
  Raw RGB/RGBA input requires --width and --height.

Encoder options:
  --preset <0.75|1|1.5|2|3|4.5|6|7.5|9>     default: 4.5
  --quality <1..100>                          default: 100
  --auto-quality                              use the web encoder's quality search
  --sample-mcu-count <n>                      quality-search sample count
  --finalist-count <n>                        full-image quality finalists
  --component-budget <fixed|fast|expanded>    default follows the JS codec
  --component-allocation <Y,Cb,Cr>            explicit bytes per MCU
  --coefficient-coding <name>                 any DctImageFormat coding key
  --zigzag-order <true|false>                 default: true
  --chroma-subsampling <4:2:0|4:2:2>          default: 4:2:0
  --split-luma-8x8 <true|false>               default follows the preset

Prototype-library options:
  --dct-library
  --library-size <1..63>
  --library-components <y,cb,cr>
  --library-reference-coding <auto|sidecar>
  --library-frequency-split <0|0.25|0.5|1>
  --library-cluster-samples <64..65536>
  --library-candidate-count <1..16>

JPEG options:
  --jpeg-dct-import <true|false>               default: true for JPEG
  --direct-jpeg-coefficients <true|false>      default: true when compatible

Other options:
  --input-format <jpeg|ppm|rgb|rgba>            override extension detection
  --width <pixels> --height <pixels>           required for raw RGB/RGBA
  --progress                                   print encoding progress to stderr
  --json                                       machine-readable command result
  --help
`;

function main(argv) {
  const parsed = parseArguments(argv);
  const command = parsed.positionals.shift();

  if (!command || command === "help" || parsed.options.help) {
    process.stdout.write(HELP);
    return;
  }

  switch (command.toLowerCase()) {
    case "encode":
      encodeCommand(parsed.positionals, parsed.options);
      break;
    case "decode":
      decodeCommand(parsed.positionals, parsed.options);
      break;
    case "info":
      infoCommand(parsed.positionals, parsed.options);
      break;
    case "pixel":
      pixelCommand(parsed.positionals, parsed.options);
      break;
    case "presets":
      presetsCommand(parsed.positionals, parsed.options);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function encodeCommand(positionals, options) {
  requirePositionals("encode", positionals, 2);
  const inputPath = positionals[0];
  const outputPath = positionals[1];
  const image = readInputImage(inputPath, options);
  const codecOptions = createCodecOptions(options);
  const autoQuality = booleanOption(options, "auto-quality", false);
  const jpegImport = image.jpeg
    ? booleanOption(options, "jpeg-dct-import", true)
    : booleanOption(options, "jpeg-dct-import", false);

  if (jpegImport && autoQuality) {
    throw new Error("Automatic quality search cannot be combined with direct JPEG DCT import");
  }
  if (jpegImport && codecOptions.dctLibrary) {
    throw new Error("Prototype libraries cannot be combined with direct JPEG DCT import");
  }
  if (jpegImport && !image.jpeg) {
    throw new Error("Direct JPEG DCT import requires JPEG input");
  }

  let encoded;
  let search = null;
  if (jpegImport) {
    encoded = DctImageFormat.importJpegDctFile(image.jpeg, {
      ...codecOptions,
      referencePixels: image.pixels,
      directJpegCoefficients: booleanOption(options, "direct-jpeg-coefficients", true),
    });
  } else if (autoQuality) {
    search = DctImageFormat.findBestDctQuality(
      image.pixels,
      image.width,
      image.height,
      codecOptions
    );
    encoded = search.encoded;
  } else {
    encoded = DctImageFormat.encodeDctFile(
      image.pixels,
      image.width,
      image.height,
      codecOptions
    );
  }

  finishProgress(options);
  fs.writeFileSync(outputPath, asBuffer(encoded));
  const info = DctImageFormat.inspectDctFile(encoded);
  const result = {
    command: "encode",
    input: path.resolve(inputPath),
    output: path.resolve(outputPath),
    importMode: jpegImport ? "jpeg-dct" : "rgba",
    bytes: encoded.byteLength,
    ...(search ? {
      selectedQuality: search.quality,
      searchCandidateCount: search.candidateCount,
      squaredError: search.error,
    } : {}),
    ...summarizeInfo(info),
  };
  printResult(result, options, formatEncodeResult);
}

function decodeCommand(positionals, options) {
  requirePositionals("decode", positionals, 2);
  const inputPath = positionals[0];
  const outputPath = positionals[1];
  const decoded = DctImageFormat.decodeDctFile(readBytes(inputPath));
  writeDecodedImage(outputPath, decoded);
  printResult({
    command: "decode",
    input: path.resolve(inputPath),
    output: path.resolve(outputPath),
    width: decoded.width,
    height: decoded.height,
  }, options, (result) =>
    `Decoded ${result.width}x${result.height} to ${result.output}`
  );
}

function infoCommand(positionals, options) {
  requirePositionals("info", positionals, 1);
  const info = summarizeInfo(DctImageFormat.inspectDctFile(readBytes(positionals[0])));
  printResult(info, options, formatInfo);
}

function pixelCommand(positionals, options) {
  requirePositionals("pixel", positionals, 3);
  const x = integerValue(positionals[1], "x", 0);
  const y = integerValue(positionals[2], "y", 0);
  const rgba = DctImageFormat.sampleDctFilePixel(readBytes(positionals[0]), x, y);
  printResult({ x, y, ...rgba }, options, (result) =>
    `${result.x},${result.y}: rgba(${result.r}, ${result.g}, ${result.b}, ${result.a})`
  );
}

function presetsCommand(positionals, options) {
  requirePositionals("presets", positionals, 0);
  const presets = Object.entries(DctImageFormat.PRESETS).map(([key, preset]) => ({
    preset: key,
    bpp: preset.bpp,
    bytesPerMcu: preset.bytesPerMcu,
    yBytes: preset.yBytes,
    cbBytes: preset.cbBytes,
    crBytes: preset.crBytes,
  }));
  if (booleanOption(options, "json", false)) {
    process.stdout.write(`${JSON.stringify(presets, null, 2)}\n`);
    return;
  }
  for (const preset of presets) {
    process.stdout.write(
      `${preset.preset} bpp: ${preset.bytesPerMcu} B/MCU ` +
      `(Y ${preset.yBytes}, Cb ${preset.cbBytes}, Cr ${preset.crBytes})\n`
    );
  }
}

function createCodecOptions(options) {
  const codecOptions = {
    preset: stringOption(options, "preset", "4.5"),
    quality: integerOption(options, "quality", DctImageFormat.DEFAULT_QUALITY, 1, 100),
  };
  copyStringOption(options, codecOptions, "component-budget", "componentBudget");
  copyStringOption(options, codecOptions, "coefficient-coding", "coefficientCoding");
  copyStringOption(options, codecOptions, "chroma-subsampling", "chromaSubsampling");
  copyIntegerOption(options, codecOptions, "sample-mcu-count", "sampleMcuCount", 1);
  copyIntegerOption(options, codecOptions, "finalist-count", "finalistCount", 1);
  copyIntegerOption(options, codecOptions, "library-size", "librarySize", 1, 63);
  copyIntegerOption(options, codecOptions, "library-cluster-samples", "libraryClusterSamples", 64, 65536);
  copyIntegerOption(options, codecOptions, "library-candidate-count", "libraryCandidateCount", 1, 16);
  copyNumberOption(options, codecOptions, "library-frequency-split", "libraryFrequencySplit");
  copyStringOption(options, codecOptions, "library-reference-coding", "libraryReferenceCoding");

  if (hasOption(options, "zigzag-order")) {
    codecOptions.zigzagOrder = booleanOption(options, "zigzag-order", true);
  }
  if (hasOption(options, "split-luma-8x8")) {
    codecOptions.splitLuma8x8 = booleanOption(options, "split-luma-8x8", true);
  }
  if (hasOption(options, "dct-library")) {
    codecOptions.dctLibrary = booleanOption(options, "dct-library", true);
  }
  if (hasOption(options, "library-components")) {
    codecOptions.libraryComponents = String(options["library-components"])
      .split(",")
      .map((component) => component.trim())
      .filter(Boolean);
  }
  if (hasOption(options, "component-allocation")) {
    const parts = String(options["component-allocation"])
      .split(",")
      .map((value) => integerValue(value.trim(), "component allocation", 1));
    if (parts.length !== 3) {
      throw new Error("Component allocation must contain Y,Cb,Cr byte counts");
    }
    codecOptions.componentAllocation = {
      yBytes: parts[0],
      cbBytes: parts[1],
      crBytes: parts[2],
    };
  }
  if (booleanOption(options, "progress", false)) {
    codecOptions.onProgress = (progress) => printProgress(progress);
  }
  return codecOptions;
}

function readInputImage(filename, options) {
  const bytes = readBytes(filename);
  const requestedFormat = stringOption(options, "input-format", "").toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  const jpeg = requestedFormat === "jpeg" || requestedFormat === "jpg" ||
    [".jpg", ".jpeg", ".jpe"].includes(extension) || isJpeg(bytes);

  if (jpeg) {
    const parsed = GpuJpegDecoder.parse(bytes);
    const decoded = DctImageFormat.decodeJpegDctPixels(parsed);
    return { ...decoded, jpeg: parsed };
  }
  if (requestedFormat === "ppm" || [".ppm", ".pnm"].includes(extension) || isPpm(bytes)) {
    return parsePpm(bytes);
  }
  if (requestedFormat === "rgb" || extension === ".rgb") {
    return parseRawPixels(bytes, options, 3);
  }
  if (requestedFormat === "rgba" || extension === ".rgba") {
    return parseRawPixels(bytes, options, 4);
  }
  throw new Error("Unsupported input image; use JPEG, PPM P6, RGB24, or RGBA32");
}

function parsePpm(bytes) {
  let offset = 0;
  const readToken = () => {
    while (offset < bytes.length) {
      const byte = bytes[offset];
      if (byte === 35) {
        while (offset < bytes.length && bytes[offset] !== 10 && bytes[offset] !== 13) offset += 1;
      } else if (byte <= 32) {
        offset += 1;
      } else {
        break;
      }
    }
    const start = offset;
    while (offset < bytes.length && bytes[offset] > 32 && bytes[offset] !== 35) offset += 1;
    if (start === offset) throw new Error("Truncated PPM header");
    return Buffer.from(bytes.subarray(start, offset)).toString("ascii");
  };

  if (readToken() !== "P6") throw new Error("Only binary PPM P6 input is supported");
  const width = integerValue(readToken(), "PPM width", 1);
  const height = integerValue(readToken(), "PPM height", 1);
  const maximum = integerValue(readToken(), "PPM maximum", 1, 255);
  if (maximum !== 255) throw new Error("PPM input must use an 8-bit maximum value of 255");
  if (offset >= bytes.length || bytes[offset] > 32) throw new Error("Invalid PPM pixel separator");
  if (bytes[offset] === 13 && bytes[offset + 1] === 10) offset += 2;
  else offset += 1;

  const expected = width * height * 3;
  if (bytes.length - offset !== expected) throw new Error("PPM pixel payload has the wrong size");
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let source = offset, target = 0; source < bytes.length; source += 3, target += 4) {
    pixels[target] = bytes[source];
    pixels[target + 1] = bytes[source + 1];
    pixels[target + 2] = bytes[source + 2];
    pixels[target + 3] = 255;
  }
  return { width, height, pixels, jpeg: null };
}

function parseRawPixels(bytes, options, channels) {
  const width = integerOption(options, "width", undefined, 1);
  const height = integerOption(options, "height", undefined, 1);
  if (width === undefined || height === undefined) {
    throw new Error("Raw RGB/RGBA input requires --width and --height");
  }
  if (bytes.length !== width * height * channels) {
    throw new Error("Raw pixel payload does not match --width and --height");
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let source = 0, target = 0; source < bytes.length; source += channels, target += 4) {
    pixels[target] = bytes[source];
    pixels[target + 1] = bytes[source + 1];
    pixels[target + 2] = bytes[source + 2];
    pixels[target + 3] = channels === 4 ? bytes[source + 3] : 255;
  }
  return { width, height, pixels, jpeg: null };
}

function writeDecodedImage(filename, decoded) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".rgba") {
    fs.writeFileSync(filename, asBuffer(decoded.pixels));
    return;
  }
  const rgb = Buffer.alloc(decoded.width * decoded.height * 3);
  for (let source = 0, target = 0; source < decoded.pixels.length; source += 4, target += 3) {
    rgb[target] = decoded.pixels[source];
    rgb[target + 1] = decoded.pixels[source + 1];
    rgb[target + 2] = decoded.pixels[source + 2];
  }
  if (extension === ".rgb") {
    fs.writeFileSync(filename, rgb);
    return;
  }
  fs.writeFileSync(filename, Buffer.concat([
    Buffer.from(`P6\n${decoded.width} ${decoded.height}\n255\n`, "ascii"),
    rgb,
  ]));
}

function summarizeInfo(info) {
  return {
    version: info.version,
    width: info.width,
    height: info.height,
    preset: info.key,
    bpp: info.bpp,
    totalBpp: info.totalBpp,
    quality: info.quality,
    autoQuality: info.autoQuality,
    mcuColumns: info.mcuColumns,
    mcuRows: info.mcuRows,
    mcuCount: info.mcuCount,
    bytesPerMcu: info.bytesPerMcu,
    yBytes: info.yBytes,
    cbBytes: info.cbBytes,
    crBytes: info.crBytes,
    componentAllocationAdaptive: info.componentAllocationAdaptive,
    chromaSubsampling: info.chromaSubsampling,
    splitLuma8x8: info.splitLuma8x8,
    coefficientCoding: info.coefficientCodingKey,
    zigzagOrder: info.zigzagOrder,
    libraryEnabled: info.libraryEnabled,
    libraryBytes: info.libraryBytes,
    payloadBytes: info.payloadBytes,
    searchCandidateCount: info.searchCandidateCount,
  };
}

function formatEncodeResult(result) {
  return `Encoded ${result.width}x${result.height}, ${result.bytes} bytes, ` +
    `${result.totalBpp.toFixed(4)} bpp, quality ${result.quality}, ` +
    `Y${result.yBytes}+Cb${result.cbBytes}+Cr${result.crBytes}, ` +
    `${result.coefficientCoding}, ${result.importMode}`;
}

function formatInfo(info) {
  return [
    `DCTBS2 v${info.version}: ${info.width}x${info.height}, preset ${info.preset} bpp`,
    `MCU: ${info.mcuColumns}x${info.mcuRows}, ${info.bytesPerMcu} B each`,
    `Components: Y ${info.yBytes} B, Cb ${info.cbBytes} B, Cr ${info.crBytes} B, ${info.chromaSubsampling}`,
    `Coding: ${info.coefficientCoding}, zigzag ${info.zigzagOrder ? "on" : "off"}`,
    `Quality: ${info.quality}${info.autoQuality ? " (automatic)" : ""}`,
    `Prototype library: ${info.libraryEnabled ? `${info.libraryBytes} B` : "off"}`,
    `Payload: ${info.payloadBytes} B, total ${info.totalBpp.toFixed(4)} bpp`,
  ].join("\n");
}

function parseArguments(argv) {
  const positionals = [];
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equal = argument.indexOf("=");
    let key = argument.slice(2, equal < 0 ? undefined : equal);
    let value = equal < 0 ? undefined : argument.slice(equal + 1);
    if (key.startsWith("no-") && value === undefined) {
      key = key.slice(3);
      value = false;
    } else if (value === undefined && !FLAG_OPTIONS.has(key) &&
        index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      value = argv[index + 1];
      index += 1;
    } else if (value === undefined) {
      value = true;
    }
    options[key] = value;
  }
  return { positionals, options };
}

function requirePositionals(command, positionals, count) {
  if (positionals.length !== count) {
    throw new Error(`${command} expects ${count} positional argument${count === 1 ? "" : "s"}`);
  }
}

function printResult(result, options, formatter) {
  const output = booleanOption(options, "json", false)
    ? JSON.stringify(result, null, 2)
    : formatter(result);
  process.stdout.write(`${output}\n`);
}

function printProgress(progress) {
  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  const percentage = total > 0 ? Math.min(100, Math.round(completed * 100 / total)) : 0;
  const stage = progress.stage || "encode";
  const quality = progress.quality === undefined ? "" : ` quality ${progress.quality}`;
  process.stderr.write(`\r${stage}${quality}: ${percentage}%`);
}

function finishProgress(options) {
  if (booleanOption(options, "progress", false)) process.stderr.write("\n");
}

function copyStringOption(source, target, sourceKey, targetKey) {
  if (hasOption(source, sourceKey)) target[targetKey] = String(source[sourceKey]);
}

function copyIntegerOption(source, target, sourceKey, targetKey, minimum, maximum) {
  if (hasOption(source, sourceKey)) {
    target[targetKey] = integerOption(source, sourceKey, undefined, minimum, maximum);
  }
}

function copyNumberOption(source, target, sourceKey, targetKey) {
  if (hasOption(source, sourceKey)) {
    const value = Number(source[sourceKey]);
    if (!Number.isFinite(value)) throw new Error(`${sourceKey} must be a number`);
    target[targetKey] = value;
  }
}

function hasOption(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key);
}

function stringOption(options, key, fallback) {
  return hasOption(options, key) ? String(options[key]) : fallback;
}

function booleanOption(options, key, fallback) {
  if (!hasOption(options, key)) return fallback;
  const value = options[key];
  if (value === true || value === false) return value;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${key} must be true or false`);
}

function integerOption(options, key, fallback, minimum, maximum) {
  if (!hasOption(options, key)) return fallback;
  return integerValue(options[key], key, minimum, maximum);
}

function integerValue(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || (minimum !== undefined && number < minimum) ||
      (maximum !== undefined && number > maximum)) {
    const range = maximum === undefined ? `at least ${minimum}` : `${minimum} through ${maximum}`;
    throw new Error(`${name} must be an integer ${range}`);
  }
  return number;
}

function readBytes(filename) {
  const buffer = fs.readFileSync(filename);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isJpeg(bytes) {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isPpm(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x36;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`dctbs2-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
