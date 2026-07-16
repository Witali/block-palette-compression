#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outputDirectory = path.join(root, "src", "shaders");
const cubeTemplatePath = path.join(outputDirectory, "cube-webgl2.frag.glsl");
const presets = Object.freeze([
  { key: "0.75", file: "dctbs2-0_75bpp.frag.glsl", mode: 750, mcu: 24, y: 12, cb: 6, cr: 6 },
  { key: "1", file: "dctbs2-1bpp.frag.glsl", mode: 1000, mcu: 32, y: 16, cb: 8, cr: 8 },
  { key: "1.5", file: "dctbs2-1_5bpp.frag.glsl", mode: 1500, mcu: 48, y: 24, cb: 12, cr: 12 },
  { key: "2", file: "dctbs2-2bpp.frag.glsl", mode: 2000, mcu: 64, y: 32, cb: 16, cr: 16 },
  { key: "3", file: "dctbs2-3bpp.frag.glsl", mode: 3000, mcu: 96, y: 64, cb: 16, cr: 16 },
  { key: "4.5", file: "dctbs2-4_5bpp.frag.glsl", mode: 4500, mcu: 144, y: 96, cb: 24, cr: 24 },
  { key: "6", file: "dctbs2-6bpp.frag.glsl", mode: 6000, mcu: 192, y: 128, cb: 32, cr: 32 },
  { key: "7.5", file: "dctbs2-7_5bpp.frag.glsl", mode: 7500, mcu: 240, y: 160, cb: 40, cr: 40 },
  { key: "9", file: "dctbs2-9bpp.frag.glsl", mode: 9000, mcu: 288, y: 192, cb: 48, cr: 48 },
]);
const cubePresets = Object.freeze(presets.filter((preset) => Number(preset.key) <= 6));
const lumaQuantization = Object.freeze([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);
const chromaQuantization = Object.freeze([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]);

function buildScan(profile, width, height) {
  const positions = [];
  for (let v = 0; v < height; v += 1) {
    for (let u = 0; u < width; u += 1) {
      if (u !== 0 || v !== 0) {
        positions.push({ position: v * width + u, u, v });
      }
    }
  }
  positions.sort((left, right) => {
    const scoreDifference = scanScore(profile, left.u, left.v) -
      scanScore(profile, right.u, right.v);
    return scoreDifference || left.u + left.v - right.u - right.v ||
      left.v - right.v || left.u - right.u;
  });
  return positions.map((entry) => entry.position);
}

function scanScore(profile, u, v) {
  if (profile === 1) return u + v * 2.4;
  if (profile === 2) return u * 2.4 + v;
  if (profile === 3) return Math.max(u, v) * 1.45 + Math.abs(u - v) * 0.1;
  return u + v + ((u + v) % 2 === 0 ? v : u) * 0.001;
}

function allScans(width, height) {
  return Array.from({ length: 4 }, (_, profile) => buildScan(profile, width, height)).flat();
}

function buildSkipScan(profile, width, height) {
  const positions = [];
  for (let v = 0; v < height; v += 1) {
    for (let u = 0; u < width; u += 1) {
      if (u === 0 && v === 0) continue;
      const normalizedU = width > 1 ? u / (width - 1) : 0;
      const normalizedV = height > 1 ? v / (height - 1) : 0;
      positions.push({
        position: v * width + u,
        u,
        v,
        score: skipScanScore(profile, normalizedU, normalizedV),
      });
    }
  }
  positions.sort((left, right) => left.score - right.score ||
    left.u + left.v - right.u - right.v || left.v - right.v || left.u - right.u);
  return positions.map((entry) => entry.position);
}

function skipScanScore(profile, u, v) {
  const radius = Math.sqrt(u * u + v * v);
  if (profile === 1) return 0.22 * u * u + 2.1 * v * v;
  if (profile === 2) return 2.1 * u * u + 0.22 * v * v;
  if (profile === 3) {
    return Math.min(0.18 * u * u + 2.4 * v * v, 2.4 * u * u + 0.18 * v * v);
  }
  if (profile === 4) return 0.72 * radius * radius + 1.35 * Math.abs(u - v);
  if (profile === 5) {
    return 0.72 * radius * radius + 0.55 * Math.min(u, v) + 0.08 * Math.abs(u - v);
  }
  if (profile === 6) return Math.abs(radius - 0.34) + 0.18 * radius;
  if (profile === 7) return Math.abs(radius - 0.52) + 0.10 * Math.min(u, v);
  return radius * radius;
}

function allSkipScans(width, height) {
  return Array.from({ length: 8 }, (_, profile) => buildSkipScan(profile, width, height)).flat();
}

function glslIntArray(name, values) {
  const lines = [];
  for (let index = 0; index < values.length; index += 20) {
    lines.push(`    ${values.slice(index, index + 20).join(", ")}`);
  }
  return `const int ${name}[${values.length}] = int[${values.length}](\n${lines.join(",\n")}\n);`;
}

function cubeShaderFile(preset) {
  return `cube-webgl2-dctbs2-${preset.key.replace(".", "_")}bpp.frag.glsl`;
}

function trimmedScans(width, height, count) {
  return Array.from(
    { length: 4 },
    (_, profile) => buildScan(profile, width, height).slice(0, count)
  ).flat();
}

function renderCubeIntArray(name, values) {
  const lines = [];
  for (let index = 0; index < values.length; index += 17) {
    lines.push(`  ${values.slice(index, index + 17).join(", ")}`);
  }
  return `const int ${name}[${values.length}] = int[${values.length}](\n${lines.join(",\n")}\n);`;
}

function groupedFiveCount(recordBytes) {
  return Math.floor((recordBytes * 8 - 27) / 5);
}

function renderWordExtract(wordBit, bitCount) {
  const mask = (2 ** bitCount - 1).toString();
  if (wordBit + bitCount <= 32) {
    return `(currentWord >> ${32 - wordBit - bitCount}u) & ${mask}u`;
  }
  return `((currentWord << ${wordBit + bitCount - 32}u) | ` +
    `(nextWord >> ${64 - wordBit - bitCount}u)) & ${mask}u`;
}

function renderUnrolledComponentDecoder(options) {
  const {
    functionName,
    scanName,
    coefficientCount,
    width,
    chroma,
  } = options;
  const firstEnd = Math.floor((coefficientCount + 5) / 6);
  const secondEnd = Math.floor((coefficientCount + 1) / 2);
  const coefficientsByWord = new Map();

  for (let index = 0; index < coefficientCount; index += 1) {
    const bitOffset = 27 + index * 5;
    const wordIndex = Math.floor(bitOffset / 32);
    const entries = coefficientsByWord.get(wordIndex) || [];
    entries.push({ index, wordBit: bitOffset % 32 });
    coefficientsByWord.set(wordIndex, entries);
  }

  const maximumWord = Math.max(...coefficientsByWord.keys());
  const lines = [
    `float ${functionName}(int recordOffset, int localX, int localY) {`,
    "  uint headerWord = dctWordAt(recordOffset);",
    "  int profile = int(headerWord >> 28u);",
    "  int dcScaleIndex = int((headerWord >> 24u) & 15u);",
    "  int dc = dctSigned10((headerWord >> 14u) & 1023u);",
    "  float scale0 = exp2(float((headerWord >> 11u) & 7u));",
    "  float scale1 = exp2(float((headerWord >> 8u) & 7u));",
    "  float scale2 = exp2(float((headerWord >> 5u) & 7u));",
    "  float sum = 0.0;",
    "  float correction = 0.0;",
    "",
    "  addDctCompensated(",
    `    float(dc) * exp2(float(dcScaleIndex)) * dctQuantizationStep(0, ${chroma}) *`,
    `      dctBasis(0, localX, ${width}) * dctBasis(0, localY, 16),`,
    "    sum,",
    "    correction",
    "  );",
    "",
    "  uint currentWord = headerWord;",
    "  uint nextWord = dctWordAt(recordOffset + 4);",
  ];

  for (let wordIndex = 0; wordIndex <= maximumWord; wordIndex += 1) {
    if (wordIndex > 0) {
      lines.push("  currentWord = nextWord;");
      if (wordIndex < maximumWord) {
        lines.push(`  nextWord = dctWordAt(recordOffset + ${(wordIndex + 1) * 4});`);
      }
    }

    for (const { index, wordBit } of coefficientsByWord.get(wordIndex) || []) {
      const scale = index < firstEnd ? "scale0" : index < secondEnd ? "scale1" : "scale2";
      const positionShift = width === 16 ? 4 : 3;
      const positionMask = width - 1;
      lines.push(
        "  {",
        `    int position = ${scanName}[profile * ${coefficientCount} + ${index}];`,
        `    int stored = dctSigned5(${renderWordExtract(wordBit, 5)});`,
        "    addDctCompensated(",
        `      float(stored) * ${scale} * dctQuantizationStep(position, ${chroma}) *`,
        `        dctBasis(position & ${positionMask}, localX, ${width}) *`,
        `        dctBasis(position >> ${positionShift}, localY, 16),`,
        "      sum,",
        "      correction",
        "    );",
        "  }"
      );
    }
  }

  lines.push("", "  return sum + 128.0;", "}");
  return lines.join("\n");
}

function renderCubeProfileDecoder(preset) {
  const yCount = groupedFiveCount(preset.y);
  const chromaCount = groupedFiveCount(preset.cb);
  return `// <dctbs2-profile-decoder>
// Generated baseline grouped-5-front decoder: fixed record sizes, no format branches.
int dctSigned10(uint raw) {
  return (raw & 512u) == 0u ? int(raw) : int(raw) - 1024;
}

int dctSigned5(uint raw) {
  return (raw & 16u) == 0u ? int(raw) : int(raw) - 32;
}

void addDctCompensated(float value, inout float sum, inout float correction) {
  float adjusted = value - correction;
  float next = sum + adjusted;
  correction = (next - sum) - adjusted;
  sum = next;
}

${renderUnrolledComponentDecoder({
    functionName: "sampleDctLumaRecord",
    scanName: "DCT_SCAN_Y",
    coefficientCount: yCount,
    width: 16,
    chroma: "false",
  })}

${renderUnrolledComponentDecoder({
    functionName: "sampleDctChromaRecord",
    scanName: "DCT_SCAN_C",
    coefficientCount: chromaCount,
    width: 8,
    chroma: "true",
  })}
// </dctbs2-profile-decoder>`;
}

function renderCubeFragmentShader(preset) {
  const yCount = groupedFiveCount(preset.y);
  const chromaCount = groupedFiveCount(preset.cb);
  const yScan = renderCubeIntArray("DCT_SCAN_Y", trimmedScans(16, 16, yCount));
  const chromaScan = renderCubeIntArray("DCT_SCAN_C", trimmedScans(8, 16, chromaCount));
  let source = fs.readFileSync(cubeTemplatePath, "utf8").replace(/\r\n?/g, "\n");

  source = source
    .replace(" * WebGL2 compact BPAL fragment stage.",
      ` * Generated WebGL2 compact cube fragment stage for DCTBS2 ${preset.key} bpp.`)
    .replace(/const int DCT_MCU_BYTES = \d+;/, `const int DCT_MCU_BYTES = ${preset.mcu};`)
    .replace(/const int DCT_Y_BYTES = \d+;/, `const int DCT_Y_BYTES = ${preset.y};`)
    .replace(/const int DCT_CB_BYTES = \d+;/, `const int DCT_CB_BYTES = ${preset.cb};`)
    .replace(/const int DCT_Y_AC_COUNT = \d+;/, `const int DCT_Y_AC_COUNT = ${yCount};`)
    .replace(/const int DCT_C_AC_COUNT = \d+;/, `const int DCT_C_AC_COUNT = ${chromaCount};`)
    .replace(/\/\/ Four deterministic significance profiles,[\s\S]*?(?=const int DCT_SCAN_Y)/,
      `// Four deterministic significance scans trimmed for ${preset.key} bpp records.\n`)
    .replace(/const int DCT_SCAN_Y\[\d+\] = int\[\d+\]\([\s\S]*?\);/, yScan)
    .replace(/const int DCT_SCAN_C\[\d+\] = int\[\d+\]\([\s\S]*?\);/, chromaScan)
    .replace(/\/\/ <dctbs2-profile-decoder>[\s\S]*?\/\/ <\/dctbs2-profile-decoder>/,
      renderCubeProfileDecoder(preset));

  return source;
}

function renderVertexShader() {
  return `#version 300 es

layout(location = 0) in vec2 aPosition;
out vec2 vTexCoord;

void main() {
    vTexCoord = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
}

function renderFragmentShader(preset) {
  const y16Scans = glslIntArray("SCAN_Y16", allScans(16, 16));
  const y8Scans = glslIntArray("SCAN_Y8", allScans(8, 8));
  const chromaScans = glslIntArray("SCAN_C", allScans(8, 16));
  const y16SkipScans = glslIntArray("SKIP_SCAN_Y16", allSkipScans(16, 16));
  const y8SkipScans = glslIntArray("SKIP_SCAN_Y8", allSkipScans(8, 8));
  const chromaSkipScans = glslIntArray("SKIP_SCAN_C", allSkipScans(8, 16));
  const lumaTable = glslIntArray("QUANT_Y", lumaQuantization);
  const chromaTable = glslIntArray("QUANT_C", chromaQuantization);
  return `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

// Generated by tools/generate-dctbs2-shaders.js.
// Direct random-access decoder for the current 64-byte-header DCTBS2 v2 format.
uniform highp usampler2D uDctData;
uniform int uDataTexWidth;
uniform bool uFlipY;

in vec2 vTexCoord;
out vec4 outColor;

const float PI = 3.1415926535897932384626433832795;
const int HEADER_SIZE = 64;
const int LIBRARY_HEADER_SIZE = 32;
const uint EXPECTED_MODE = ${preset.mode}u;
const uint EXPECTED_MCU_BYTES = ${preset.mcu}u;
const uint EXPECTED_Y_BYTES = ${preset.y}u;
const uint EXPECTED_CB_BYTES = ${preset.cb}u;
const uint EXPECTED_CR_BYTES = ${preset.cr}u;
const bool ALLOW_SPLIT_LUMA = ${Number(preset.key) >= 3 ? "true" : "false"};
const uint FLAG_SPLIT_LUMA = 2u;
const uint FLAG_LIBRARY = 4u;

${lumaTable}

${chromaTable}

${y16Scans}

${y8Scans}

${chromaScans}

${y16SkipScans}

${y8SkipScans}

${chromaSkipScans}

uint byteAt(int byteOffset) {
    int texelIndex = byteOffset >> 2;
    ivec2 coordinate = ivec2(texelIndex % uDataTexWidth, texelIndex / uDataTexWidth);
    uvec4 texel = texelFetch(uDctData, coordinate, 0);
    int lane = byteOffset & 3;
    return lane == 0 ? texel.r : lane == 1 ? texel.g : lane == 2 ? texel.b : texel.a;
}

uint u32le(int byteOffset) {
    int texelIndex = byteOffset >> 2;
    ivec2 coordinate = ivec2(texelIndex % uDataTexWidth, texelIndex / uDataTexWidth);
    uvec4 bytes = texelFetch(uDctData, coordinate, 0);
    return bytes.r | (bytes.g << 8u) | (bytes.b << 16u) | (bytes.a << 24u);
}

uint readSidecarBits(int byteOffset, int bitOffset, int bitCount) {
    int absoluteBit = (byteOffset << 3) + bitOffset;
    int wordByteOffset = (absoluteBit >> 5) << 2;
    uint wordBit = uint(absoluteBit & 31);
    uint value = u32le(wordByteOffset) >> wordBit;
    if (int(wordBit) + bitCount > 32) {
        value |= u32le(wordByteOffset + 4) << (32u - wordBit);
    }
    return value & ((1u << uint(bitCount)) - 1u);
}

uint componentWordAt(int byteOffset) {
    int texelIndex = byteOffset >> 2;
    ivec2 coordinate = ivec2(texelIndex % uDataTexWidth, texelIndex / uDataTexWidth);
    uvec4 bytes = texelFetch(uDctData, coordinate, 0);
    return (bytes.r << 24u) | (bytes.g << 16u) | (bytes.b << 8u) | bytes.a;
}

uint readComponentBits(int byteOffset, int bitOffset, int bitCount) {
    int absoluteBit = (byteOffset << 3) + bitOffset;
    int wordByteOffset = (absoluteBit >> 5) << 2;
    uint wordBit = uint(absoluteBit & 31);
    uint value = componentWordAt(wordByteOffset) << wordBit;
    if (int(wordBit) + bitCount > 32) {
        value |= componentWordAt(wordByteOffset + 4) >> (32u - wordBit);
    }
    uint mask = (1u << uint(bitCount)) - 1u;
    return (value >> uint(32 - bitCount)) & mask;
}

int readSignedComponentBits(int byteOffset, int bitOffset, int bitCount) {
    uint raw = readComponentBits(byteOffset, bitOffset, bitCount);
    uint sign = 1u << uint(bitCount - 1);
    return (raw & sign) == 0u ? int(raw) : int(raw) - int(1u << uint(bitCount));
}

int ceilDiv(int value, int divisor) {
    return (value + divisor - 1) / divisor;
}

int sidecarBits(int prototypeCount) {
    if (prototypeCount <= 0) return 0;
    int bits = 0;
    int maximumValue = prototypeCount;
    for (int index = 0; index < 6; ++index) {
        if (maximumValue == 0) break;
        bits += 1;
        maximumValue >>= 1;
    }
    return bits;
}

bool headerReferenceVersion(int version) {
    return version >= 2 && version <= 5;
}

bool sidecarReferenceVersion(int version) {
    return version >= 6 && version <= 9;
}

int frequencyQuarters(int version) {
    if (version == 3 || version == 7) return 1;
    if (version == 4 || version == 8) return 2;
    if (version == 5 || version == 9) return 4;
    return 0;
}

int componentWidth(int kind) {
    return kind == 0 ? 16 : 8;
}

int componentHeight(int kind) {
    return kind == 1 ? 8 : 16;
}

int scanLength(int kind) {
    return componentWidth(kind) * componentHeight(kind) - 1;
}

int scanPosition(int kind, int profile, int index) {
    if (kind == 0) return SCAN_Y16[profile * 255 + index];
    if (kind == 1) return SCAN_Y8[profile * 63 + index];
    return SCAN_C[profile * 127 + index];
}

int skipScanPosition(int kind, int profile, int index) {
    if (kind == 0) return SKIP_SCAN_Y16[profile * 255 + index];
    if (kind == 1) return SKIP_SCAN_Y8[profile * 63 + index];
    return SKIP_SCAN_C[profile * 127 + index];
}

int groupCount(int coding) {
    if (coding == 1 || coding == 3 || coding == 4) return 2;
    return coding == 2 || coding == 5 || coding == 6 ? 3 : 0;
}

int mantissaBits(int coding) {
    return coding == 0 ? 6 : 5;
}

int acCount(int recordBytes, int kind, int coding, bool tailReference) {
    int groups = groupCount(coding);
    int count = (recordBytes * 8 - 18 - groups * 3) / mantissaBits(coding);
    return min(scanLength(kind), max(0, count - (tailReference ? 1 : 0)));
}

int resolveLibraryIndex(
    int recordOffset,
    int recordBytes,
    int kind,
    int coding,
    int libraryVersion,
    int sidecarIndex
) {
    int packedProfile = int(byteAt(recordOffset) >> 4u);
    if (headerReferenceVersion(libraryVersion)) return packedProfile >> 2;
    if (sidecarReferenceVersion(libraryVersion)) return sidecarIndex;
    if (libraryVersion == 1) {
        int count = acCount(recordBytes, kind, coding, true);
        int referenceBit = 18 + groupCount(coding) * 3 + count * mantissaBits(coding);
        return int(readComponentBits(recordOffset, referenceBit, mantissaBits(coding)));
    }
    return 0;
}

int groupedScaleIndex(int recordOffset, int coding, int count, int coefficientIndex) {
    if (coding == 0) return int(byteAt(recordOffset) & 15u);
    int group = 0;
    if (coding == 1 || coding == 3 || coding == 4) {
        group = coefficientIndex < count / 2 ? 0 : 1;
    } else {
        int firstEnd = ceilDiv(count, 6);
        int secondEnd = ceilDiv(count, 2);
        group = coefficientIndex < firstEnd ? 0 : coefficientIndex < secondEnd ? 1 : 2;
    }
    return int(readComponentBits(recordOffset, 18 + group * 3, 3));
}

int skipTokenCount(int recordBytes, int kind, int coding) {
    int payloadBits = recordBytes * 8 - 18;
    if (coding == 3) return payloadBits / 8;
    if (recordBytes == 32) return 32;
    if (recordBytes == 24) return 24;
    if (recordBytes == 16) return kind == 0 ? 15 : 14;
    int tokenCount = payloadBits / 7;
    int coarseCount = (tokenCount + 1) / 2;
    if (coarseCount * 8 + (tokenCount - coarseCount) * 6 > payloadBits) tokenCount -= 1;
    return tokenCount;
}

int skipCoarseCount(int recordBytes, int kind, int coding, int tokenCount) {
    if (coding == 3) return tokenCount;
    if (recordBytes == 32) return 16;
    if (recordBytes == 24) return kind == 0 ? 12 : 11;
    if (recordBytes == 16) return kind == 0 ? 7 : 8;
    return (tokenCount + 1) / 2;
}

float basis1D(int frequency, int coordinate, int size) {
    float alpha = frequency == 0 ? sqrt(1.0 / float(size)) : sqrt(2.0 / float(size));
    return alpha * cos(PI * float((2 * coordinate + 1) * frequency) / float(2 * size));
}

float quantizationStep(int position, int kind, int quality) {
    int width = componentWidth(kind);
    int height = componentHeight(kind);
    int u = position % width;
    int v = position / width;
    int tableX = min(7, int(floor(float(u * 7) / float(max(1, width - 1)) + 0.5)));
    int tableY = min(7, int(floor(float(v * 7) / float(max(1, height - 1)) + 0.5)));
    float qualityScale = quality < 50 ? 50.0 / float(quality) : 2.0 - float(quality) * 0.02;
    float dimensionScale = sqrt(float(width * height) / 64.0);
    int tableValue = kind == 2 ? QUANT_C[tableY * 8 + tableX] : QUANT_Y[tableY * 8 + tableX];
    return max(1.0, float(tableValue) * qualityScale * dimensionScale);
}

void addCompensated(float value, inout float sum, inout float correction) {
    float adjusted = value - correction;
    float next = sum + adjusted;
    correction = (next - sum) - adjusted;
    sum = next;
}

int readSignedSidecarBits(int byteOffset, int bitOffset, int bitCount) {
    uint raw = readSidecarBits(byteOffset, bitOffset, bitCount);
    uint sign = 1u << uint(bitCount - 1);
    return (raw & sign) == 0u ? int(raw) : int(raw) - int(1u << uint(bitCount));
}

bool maskedTailPosition(uint maskLow, uint maskHigh, int position) {
    int bit = position - 1;
    return bit < 32 ? ((maskLow >> uint(bit)) & 1u) != 0u :
        ((maskHigh >> uint(bit - 32)) & 1u) != 0u;
}

float sampleMaskedTailRecord(
    int recordOffset,
    int recordBytes,
    int localX,
    int localY,
    int quality
) {
    int dcBits = recordBytes == 24 ? 9 : recordBytes == 32 || recordBytes == 40 ? 8 : 10;
    int acBits = recordBytes == 16 ? 6 : recordBytes == 24 ? 7 : 8;
    int maxAc = recordBytes == 16 ? 9 : recordBytes == 24 ? 17 :
        recordBytes == 32 ? 23 : recordBytes == 40 ? 31 : recordBytes == 48 ? 38 : -1;
    if (maxAc < 0) return 0.0;
    uint maskLow = u32le(recordOffset);
    uint rawMaskHigh = u32le(recordOffset + 4);
    uint maskHigh = rawMaskHigh & 0x3fffffffu;
    int scaleIndex = int(rawMaskHigh >> 30u);
    int explicitCount = bitCount(maskLow) + bitCount(maskHigh);
    if (explicitCount > maxAc) return 0.0;
    int tailCount = maxAc - explicitCount;
    int tailStart = 64 - tailCount;
    for (int position = 1; position <= 62; ++position) {
        if (position >= tailStart && maskedTailPosition(maskLow, maskHigh, position)) return 0.0;
    }

    int bitOffset = 0;
    int dc = readSignedSidecarBits(recordOffset + 8, bitOffset, dcBits);
    bitOffset += dcBits;
    float scale = exp2(float(scaleIndex));
    float sum = 0.0;
    float correction = 0.0;
    addCompensated(
        float(dc) * scale * quantizationStep(0, 1, quality) *
            basis1D(0, localX, 8) * basis1D(0, localY, 8),
        sum,
        correction
    );
    for (int position = 1; position < 64; ++position) {
        bool storedPosition = position >= tailStart ||
            (position <= 62 && maskedTailPosition(maskLow, maskHigh, position));
        if (!storedPosition) continue;
        int stored = readSignedSidecarBits(recordOffset + 8, bitOffset, acBits);
        bitOffset += acBits;
        int u = position & 7;
        int v = position >> 3;
        addCompensated(
            float(stored) * scale * quantizationStep(position, 1, quality) *
                basis1D(u, localX, 8) * basis1D(v, localY, 8),
            sum,
            correction
        );
    }
    return sum;
}

float sampleRecord(
    int recordOffset,
    int recordBytes,
    int kind,
    int localX,
    int localY,
    int quality,
    int coding,
    int libraryVersion,
    int libraryIndex
) {
    if (coding == 6 && kind == 1) {
        return libraryVersion == 0
            ? sampleMaskedTailRecord(recordOffset, recordBytes, localX, localY, quality)
            : 0.0;
    }
    uint header = byteAt(recordOffset);
    int packedProfile = int(header >> 4u);
    int packedScale = int(header & 15u);
    bool skipRecord = coding >= 3 && coding <= 5 && (packedScale & 8) != 0;
    int profile = skipRecord ? packedProfile :
        headerReferenceVersion(libraryVersion) ? packedProfile & 3 : packedProfile;
    int dcScaleIndex = packedScale & 7;
    if (profile < 0 || profile >= (skipRecord ? 8 : 4) ||
        (!skipRecord && packedScale >= 8) || (skipRecord && libraryVersion != 0)) return 0.0;

    int width = componentWidth(kind);
    int height = componentHeight(kind);
    bool tailReference = libraryVersion == 1;
    int count = acCount(recordBytes, kind, coding, tailReference);
    int groups = groupCount(coding);
    int valueBits = mantissaBits(coding);
    int valuesStart = 18 + groups * 3;
    int dc = readSignedComponentBits(recordOffset, 8, 10);
    float sum = 0.0;
    float correction = 0.0;
    addCompensated(
        float(dc) * exp2(float(dcScaleIndex)) * quantizationStep(0, kind, quality) *
            basis1D(0, localX, width) * basis1D(0, localY, height),
        sum,
        correction
    );

    if (skipRecord) {
        int tokenCount = skipTokenCount(recordBytes, kind, coding);
        int coarseCount = skipCoarseCount(recordBytes, kind, coding, tokenCount);
        int bitOffset = 18;
        int scanIndex = 0;
        for (int tokenIndex = 0; tokenIndex < 32; ++tokenIndex) {
            if (tokenIndex >= tokenCount) break;
            if (scanIndex < 0 || scanIndex >= scanLength(kind)) return 0.0;
            bool fine = coding != 3 && tokenIndex >= coarseCount;
            int tokenValueBits = fine ? 4 : 6;
            int scaleIndex = fine ? (dcScaleIndex >= 3 ? 1 : 0) : dcScaleIndex;
            int stored = readSignedComponentBits(recordOffset, bitOffset, tokenValueBits);
            bitOffset += tokenValueBits;
            int skip = int(readComponentBits(recordOffset, bitOffset, 2));
            bitOffset += 2;
            int position = skipScanPosition(kind, profile, scanIndex);
            int u = position % width;
            int v = position / width;
            addCompensated(
                float(stored) * exp2(float(scaleIndex)) * quantizationStep(position, kind, quality) *
                    basis1D(u, localX, width) * basis1D(v, localY, height),
                sum,
                correction
            );
            scanIndex += skip + 1;
        }
        return sum;
    }

    int quarters = libraryIndex > 0 ? frequencyQuarters(libraryVersion) : 0;
    int requestedHigh = (count * quarters + 2) / 4;
    int highCount = min(scanLength(kind) - count, requestedHigh);
    int lowCount = count - highCount;

    for (int index = 0; index < 256; ++index) {
        if (index >= count) break;
        int scanIndex = index < lowCount ? index : count + index - lowCount;
        int position = scanPosition(kind, profile, scanIndex);
        int u = position % width;
        int v = position / width;
        int stored = readSignedComponentBits(recordOffset, valuesStart + index * valueBits, valueBits);
        int scaleIndex = groupedScaleIndex(recordOffset, coding, count, index);
        if (scaleIndex < 0 || scaleIndex >= 8) continue;
        addCompensated(
            float(stored) * exp2(float(scaleIndex)) * quantizationStep(position, kind, quality) *
                basis1D(u, localX, width) * basis1D(v, localY, height),
            sum,
            correction
        );
    }
    return sum;
}

float sampleWithPrototype(
    int recordOffset,
    int recordBytes,
    int prototypeBase,
    int prototypeCount,
    int sidecarIndex,
    int kind,
    int localX,
    int localY,
    int quality,
    int coding,
    int libraryVersion
) {
    int libraryIndex = resolveLibraryIndex(
        recordOffset, recordBytes, kind, coding, libraryVersion, sidecarIndex
    );
    if (libraryIndex < 0 || libraryIndex > prototypeCount) return 128.0;
    float centered = sampleRecord(
        recordOffset, recordBytes, kind, localX, localY, quality, coding,
        libraryVersion, libraryIndex
    );
    if (libraryIndex > 0) {
        int prototypeOffset = prototypeBase + (libraryIndex - 1) * recordBytes;
        centered += sampleRecord(
            prototypeOffset, recordBytes, kind, localX, localY, quality, coding, 0, 0
        );
    }
    return centered + 128.0;
}

int readSidecarReference(int referenceBase, int referenceBits, int referenceIndex) {
    return referenceBits == 0 ? 0 : int(readSidecarBits(
        referenceBase, referenceIndex * referenceBits, referenceBits
    ));
}

ivec2 imageSizeFromHeader() {
    return ivec2(int(u32le(16)), int(u32le(20)));
}

ivec2 uvToPixel(ivec2 imageSize) {
    vec2 uv = clamp(vTexCoord, vec2(0.0), vec2(0.99999994));
    ivec2 pixel = ivec2(floor(uv * vec2(imageSize)));
    if (uFlipY) pixel.y = imageSize.y - 1 - pixel.y;
    return clamp(pixel, ivec2(0), imageSize - 1);
}

vec3 yCbCrToRgb(float y, float cb, float cr) {
    cb -= 128.0;
    cr -= 128.0;
    vec3 rgb = vec3(
        y + 1.402 * cr,
        y - 0.344136 * cb - 0.714136 * cr,
        y + 1.772 * cb
    );
    return clamp(rgb / 255.0, 0.0, 1.0);
}

bool validMainHeader(uint flags) {
    return u32le(0) == 0x42544344u && u32le(4) == 0x00003253u &&
        u32le(8) == 2u && u32le(12) == EXPECTED_MODE &&
        u32le(32) == EXPECTED_MCU_BYTES && u32le(36) == EXPECTED_Y_BYTES &&
        u32le(40) == EXPECTED_CB_BYTES && u32le(44) == EXPECTED_CR_BYTES &&
        (flags & ~0x00000f07u) == 0u && ((flags >> 8u) & 15u) <= 6u &&
        (((flags & FLAG_LIBRARY) == 0u) || ((flags >> 8u) & 15u) != 6u) &&
        (ALLOW_SPLIT_LUMA || (flags & FLAG_SPLIT_LUMA) == 0u);
}

void main() {
    uint flags = u32le(52);
    if (!validMainHeader(flags)) {
        outColor = vec4(1.0, 0.0, 1.0, 1.0);
        return;
    }

    ivec2 size = imageSizeFromHeader();
    ivec2 pixel = uvToPixel(size);
    int mcuColumns = int(u32le(24));
    int mcuRows = int(u32le(28));
    int mcuCount = mcuColumns * mcuRows;
    int mcuIndex = (pixel.y >> 4) * mcuColumns + (pixel.x >> 4);
    int mcuOffset = HEADER_SIZE + mcuIndex * int(EXPECTED_MCU_BYTES);
    int quality = int(u32le(48));
    int coding = int((flags >> 8u) & 15u);
    bool splitLuma = (flags & FLAG_SPLIT_LUMA) != 0u;

    int libraryVersion = 0;
    int yPrototypeCount = 0;
    int cbPrototypeCount = 0;
    int crPrototypeCount = 0;
    int yReferenceBase = 0;
    int cbReferenceBase = 0;
    int crReferenceBase = 0;
    int yReferenceBits = 0;
    int cbReferenceBits = 0;
    int crReferenceBits = 0;
    int yPrototypeBase = 0;
    int cbPrototypeBase = 0;
    int crPrototypeBase = 0;

    if ((flags & FLAG_LIBRARY) != 0u) {
        int libraryBase = HEADER_SIZE + int(u32le(56));
        if (u32le(libraryBase) != 0x4c544344u ||
            u32le(libraryBase + 4) != 0x00314249u) {
            outColor = vec4(1.0, 0.0, 1.0, 1.0);
            return;
        }
        libraryVersion = int(u32le(libraryBase + 8));
        yPrototypeCount = int(u32le(libraryBase + 12));
        cbPrototypeCount = int(u32le(libraryBase + 16));
        crPrototypeCount = int(u32le(libraryBase + 20));
        bool sidecar = sidecarReferenceVersion(libraryVersion);
        yReferenceBits = sidecar ? sidecarBits(yPrototypeCount) : 0;
        cbReferenceBits = sidecar ? sidecarBits(cbPrototypeCount) : 0;
        crReferenceBits = sidecar ? sidecarBits(crPrototypeCount) : 0;
        int yReferenceCount = mcuCount * (splitLuma ? 4 : 1);
        int yReferenceBytes = ceilDiv(yReferenceCount * yReferenceBits, 8);
        int cbReferenceBytes = ceilDiv(mcuCount * cbReferenceBits, 8);
        int crReferenceBytes = ceilDiv(mcuCount * crReferenceBits, 8);
        yReferenceBase = libraryBase + LIBRARY_HEADER_SIZE;
        cbReferenceBase = yReferenceBase + yReferenceBytes;
        crReferenceBase = cbReferenceBase + cbReferenceBytes;
        yPrototypeBase = crReferenceBase + crReferenceBytes;
        int yRecordBytes = splitLuma ? int(EXPECTED_Y_BYTES) / 4 : int(EXPECTED_Y_BYTES);
        cbPrototypeBase = yPrototypeBase + yPrototypeCount * yRecordBytes;
        crPrototypeBase = cbPrototypeBase + cbPrototypeCount * int(EXPECTED_CB_BYTES);
    }

    ivec2 local = pixel & 15;
    int yRecordOffset = mcuOffset;
    int yRecordBytes = int(EXPECTED_Y_BYTES);
    int yKind = 0;
    int yReferenceOrdinal = mcuIndex;
    ivec2 yLocal = local;
    if (splitLuma) {
        int block = (local.y >> 3) * 2 + (local.x >> 3);
        yRecordBytes /= 4;
        yRecordOffset += block * yRecordBytes;
        yKind = 1;
        yReferenceOrdinal = mcuIndex * 4 + block;
        yLocal &= 7;
    }
    int ySidecarIndex = readSidecarReference(
        yReferenceBase, yReferenceBits, yReferenceOrdinal
    );
    int cbSidecarIndex = readSidecarReference(
        cbReferenceBase, cbReferenceBits, mcuIndex
    );
    int crSidecarIndex = readSidecarReference(
        crReferenceBase, crReferenceBits, mcuIndex
    );

    float y = sampleWithPrototype(
        yRecordOffset, yRecordBytes, yPrototypeBase, yPrototypeCount, ySidecarIndex,
        yKind, yLocal.x, yLocal.y, quality, coding, libraryVersion
    );
    float cb = sampleWithPrototype(
        mcuOffset + int(EXPECTED_Y_BYTES), int(EXPECTED_CB_BYTES),
        cbPrototypeBase, cbPrototypeCount, cbSidecarIndex,
        2, local.x >> 1, local.y, quality, coding, libraryVersion
    );
    float cr = sampleWithPrototype(
        mcuOffset + int(EXPECTED_Y_BYTES + EXPECTED_CB_BYTES), int(EXPECTED_CR_BYTES),
        crPrototypeBase, crPrototypeCount, crSidecarIndex,
        2, local.x >> 1, local.y, quality, coding, libraryVersion
    );
    outColor = vec4(yCbCrToRgb(y, cb, cr), 1.0);
}
`;
}

function generatedFiles() {
  return new Map([
    ["dctbs2-fullscreen.vert.glsl", renderVertexShader()],
    ...presets.map((preset) => [preset.file, renderFragmentShader(preset)]),
    ...cubePresets.map((preset) => [cubeShaderFile(preset), renderCubeFragmentShader(preset)]),
  ]);
}

function writeGeneratedFiles() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [file, source] of generatedFiles()) {
    fs.writeFileSync(path.join(outputDirectory, file), source);
    console.log(`Wrote src/shaders/${file}`);
  }
}

if (require.main === module) {
  writeGeneratedFiles();
}

module.exports = {
  buildScan,
  buildSkipScan,
  cubePresets,
  cubeShaderFile,
  generatedFiles,
  presets,
  renderCubeFragmentShader,
  renderFragmentShader,
  renderVertexShader,
};
