#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import createASTCModule from "../vendor/astc-encoder-wasm/astcenc.mjs";

const require = createRequire(import.meta.url);
const BpalTextureDecoder = require("../src/decoders/bpal-texture.js");
const BlockPaletteFormat = require("../src/palette/block-palette-format.js");
const DctImageFormat = require("../src/dct/dct-format.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRECTORY = path.join(ROOT, "assets", "scenes", "barcelona");
const OUTPUT_DIRECTORY = path.join(ROOT, "native", "win32-directx-viewer", "assets");
const SCENE_HEADER_BYTES = 96;
const MATERIAL_RECORD_BYTES = 192;
const DRAW_RECORD_BYTES = 16;
const VERTEX_BYTES = 32;
const TEXTURE_STREAM_HEADER_BYTES = 80;
const EXCLUDED_FRAME_OBJECTS = new Set(["tree_scatter_plane"]);

const gltf = JSON.parse(fs.readFileSync(path.join(SOURCE_DIRECTORY, "scene.gltf"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_DIRECTORY, "manifest.json"), "utf8"));
const geometry = fs.readFileSync(path.join(SOURCE_DIRECTORY, gltf.buffers[0].uri));

fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

const nativeScene = buildNativeScene();
fs.writeFileSync(path.join(OUTPUT_DIRECTORY, "barcelona.dxscene"), nativeScene);
await buildTextureStreams();
buildShaderSource();

process.stdout.write(
  `Built Win32 scene assets: ${nativeScene.byteLength} scene bytes and ` +
  `${manifest.textureCount} source textures in three directly sampled codec sets.\n`,
);

function buildNativeScene() {
  const materials = gltf.materials.map((material) => convertMaterial(material));
  const vertices = [];
  const indices = [];
  const draws = [];
  const bounds = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
  const scene = gltf.scenes[gltf.scene || 0];

  for (const rootNode of scene.nodes) {
    visitNode(rootNode, identityMatrix(), false);
  }

  if (!vertices.length || !indices.length || !draws.length) {
    throw new Error("The glTF scene did not contain renderable triangle geometry");
  }
  if (!Number.isFinite(bounds.min[0])) throw new Error("Could not calculate scene bounds");

  const totalBytes = SCENE_HEADER_BYTES +
    materials.length * MATERIAL_RECORD_BYTES +
    draws.length * DRAW_RECORD_BYTES +
    vertices.length * 4 +
    indices.length * 4;
  const output = Buffer.alloc(totalBytes);
  let offset = 0;

  output.write("DXSC", offset, 4, "ascii"); offset += 4;
  output.writeUInt32LE(1, offset); offset += 4;
  output.writeUInt32LE(vertices.length / 8, offset); offset += 4;
  output.writeUInt32LE(indices.length, offset); offset += 4;
  output.writeUInt32LE(draws.length, offset); offset += 4;
  output.writeUInt32LE(materials.length, offset); offset += 4;
  for (const value of [...bounds.min, ...bounds.max]) {
    output.writeFloatLE(value, offset); offset += 4;
  }
  for (const codec of ["bpal", "dct", "astc"]) {
    output.writeBigUInt64LE(BigInt(manifest.codecTotals[codec]), offset); offset += 8;
  }
  offset = SCENE_HEADER_BYTES;

  for (const material of materials) {
    writeFixedString(output, offset, 64, material.name); offset += 64;
    writeFixedString(output, offset, 48, material.baseTexture); offset += 48;
    writeFixedString(output, offset, 48, material.bumpTexture); offset += 48;
    for (const component of material.baseColor) {
      output.writeFloatLE(component, offset); offset += 4;
    }
    output.writeFloatLE(material.roughness, offset); offset += 4;
    output.writeFloatLE(material.metalness, offset); offset += 4;
    output.writeUInt32LE(material.flags, offset); offset += 4;
    output.writeFloatLE(material.alphaCutoff, offset); offset += 4;
  }

  for (const draw of draws) {
    output.writeUInt32LE(draw.firstIndex, offset); offset += 4;
    output.writeUInt32LE(draw.indexCount, offset); offset += 4;
    output.writeUInt32LE(draw.materialIndex, offset); offset += 4;
    output.writeUInt32LE(0, offset); offset += 4;
  }

  for (const value of vertices) {
    output.writeFloatLE(value, offset); offset += 4;
  }
  for (const value of indices) {
    output.writeUInt32LE(value, offset); offset += 4;
  }
  if (offset !== output.length) throw new Error(`Scene binary length mismatch: ${offset} != ${output.length}`);
  return output;

  function visitNode(nodeIndex, parentMatrix, parentExcluded) {
    const node = gltf.nodes[nodeIndex];
    const world = multiplyMatrices(parentMatrix, nodeMatrix(node));
    const excluded = parentExcluded || EXCLUDED_FRAME_OBJECTS.has(node.name);

    if (node.mesh !== undefined) appendMesh(gltf.meshes[node.mesh], world, excluded);
    for (const child of node.children || []) visitNode(child, world, excluded);
  }

  function appendMesh(mesh, world, excluded) {
    const normalTransform = createNormalMatrix(world);
    const reverseWinding = matrixDeterminant3(world) < 0;

    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4) throw new Error(`Unsupported glTF primitive mode in ${mesh.name || "mesh"}`);
      const positions = readAccessor(primitive.attributes.POSITION);
      const normals = primitive.attributes.NORMAL === undefined ? null : readAccessor(primitive.attributes.NORMAL);
      const textureCoordinates = primitive.attributes.TEXCOORD_0 === undefined
        ? null
        : readAccessor(primitive.attributes.TEXCOORD_0);
      const vertexStart = vertices.length / 8;

      for (let index = 0; index < positions.length; index += 1) {
        const position = transformPosition(world, positions[index]);
        const normal = normals ? normalize3(transformDirection(normalTransform, normals[index])) : [0, 1, 0];
        const uv = textureCoordinates ? textureCoordinates[index] : [0, 0];
        vertices.push(position[0], position[1], position[2], normal[0], normal[1], normal[2], uv[0], uv[1]);
        if (!excluded) expandBounds(bounds, position);
      }

      const localIndices = primitive.indices === undefined
        ? Array.from({ length: positions.length }, (_, index) => index)
        : readAccessor(primitive.indices).map((entry) => entry[0]);
      if (localIndices.length % 3 !== 0) throw new Error("Triangle index count is not divisible by three");
      const firstIndex = indices.length;

      for (let index = 0; index < localIndices.length; index += 3) {
        const a = vertexStart + localIndices[index];
        const b = vertexStart + localIndices[index + 1];
        const c = vertexStart + localIndices[index + 2];
        indices.push(a, reverseWinding ? c : b, reverseWinding ? b : c);
      }
      draws.push({
        firstIndex,
        indexCount: localIndices.length,
        materialIndex: primitive.material ?? 0,
      });
    }
  }
}

function convertMaterial(material) {
  const pbr = material.pbrMetallicRoughness || {};
  const assignment = manifest.materials[material.name] || {};
  const name = material.name || "material";
  const lowerName = name.toLowerCase();
  let baseColor = [...(pbr.baseColorFactor || [1, 1, 1, 1])];
  let flags = material.doubleSided ? 1 : 0;
  let alphaCutoff = 0;

  if (lowerName.includes("glass")) {
    baseColor = [0.58, 0.74, 0.76, 0.34];
    flags |= 2;
  } else if (lowerName === "water") {
    baseColor = [0.2, 0.45, 0.48, 0.74];
    flags |= 2;
  } else if (lowerName === "candle_flame") {
    baseColor = [1, 0.72, 0.34, 1];
    flags |= 2 | 4 | 8;
    alphaCutoff = 0.08;
  }
  if (assignment.baseColor) flags |= 16;
  if (assignment.bump) flags |= 32;

  return {
    name,
    baseTexture: assignment.baseColor || "",
    bumpTexture: assignment.bump || "",
    baseColor,
    roughness: pbr.roughnessFactor ?? 1,
    metalness: pbr.metallicFactor ?? 0,
    flags,
    alphaCutoff,
  };
}

async function buildTextureStreams() {
  const textureEntries = new Map(manifest.textures.map((texture) => [texture.id, texture]));
  const identifiers = new Set(textureEntries.keys());

  const wasmBinary = fs.readFileSync(path.join(ROOT, "vendor", "astc-encoder-wasm", "astcenc.wasm"));
  const astcModule = await createASTCModule({ wasmBinary });

  fs.rmSync(path.join(OUTPUT_DIRECTORY, "textures"), { recursive: true, force: true });
  fs.rmSync(path.join(OUTPUT_DIRECTORY, "streams"), { recursive: true, force: true });

  for (const codec of ["bpal", "dct", "astc"]) {
    const codecDirectory = path.join(OUTPUT_DIRECTORY, "streams", codec);
    fs.mkdirSync(codecDirectory, { recursive: true });
    let completed = 0;

    for (const identifier of [...identifiers].sort()) {
      const texture = textureEntries.get(identifier);
      if (!texture) throw new Error(`Unknown texture identifier: ${identifier}`);
      const variant = texture.variants[codec];
      fs.writeFileSync(
        path.join(codecDirectory, `${identifier}.dxtx`),
        await createTextureStream(codec, variant.color, astcModule),
      );
      if (variant.alpha) {
        fs.writeFileSync(
          path.join(codecDirectory, `${identifier}-alpha.dxtx`),
          await createTextureStream(codec, variant.alpha, astcModule),
        );
      }
      completed += 1;
      process.stdout.write(`\r${codec.toUpperCase()}: ${completed}/${identifiers.size} direct GPU streams`);
    }
    process.stdout.write("\n");
  }
}

async function createTextureStream(codec, relativePath, astcModule) {
  const source = Buffer.from(fs.readFileSync(path.join(SOURCE_DIRECTORY, relativePath)));

  if (codec === "bpal") {
    const decoded = BlockPaletteFormat.decodeBlockPaletteFile(new Uint8Array(source));
    const sourceBytes = align(source.length, 4);
    const payload = Buffer.alloc(sourceBytes + decoded.palette.length * 4);
    source.copy(payload);
    decoded.palette.forEach((color, index) => {
      payload.writeUInt32LE(
        (color.r | color.g << 8 | color.b << 16 | 255 << 24) >>> 0,
        sourceBytes + index * 4,
      );
    });
    const selectorBitOffset = decoded.packedPalettes
      ? (BlockPaletteFormat.HEADER_BYTES + decoded.storage.packedPaletteBytes) * 8
      : BlockPaletteFormat.HEADER_BYTES * 8 +
        decoded.paletteCount * decoded.globalColorCount *
          (decoded.channelMode === "scalar" ? 8 : decoded.paletteColorBits);
    const blockPaletteBitOffset = selectorBitOffset +
      decoded.blockCount * decoded.paletteIndexBits;
    const pixelIndexBitOffset = blockPaletteBitOffset +
      decoded.blockCount * decoded.localColorCount * decoded.globalIndexBits;
    return createTextureContainer(1, decoded.width, decoded.height, payload, [
      decoded.blockSize,
      decoded.blocksX,
      decoded.localColorCount,
      decoded.globalColorCount,
      decoded.localIndexBits,
      decoded.globalIndexBits,
      decoded.paletteIndexBits,
      decoded.paletteColorBits,
      selectorBitOffset,
      blockPaletteBitOffset,
      pixelIndexBitOffset,
      sourceBytes,
      decoded.paletteCount,
      decoded.directPixelColors ? 1 : 0,
    ]);
  }

  if (codec === "dct") {
    const info = DctImageFormat.inspectDctFile(new Uint8Array(source));
    if (
      info.bytesPerMcu !== 96 || info.yBytes !== 64 || info.cbBytes !== 16 ||
      info.crBytes !== 16 || info.splitLuma8x8 || !info.chroma420 ||
      info.coefficientCodingKey !== "grouped-5-front" || info.libraryEnabled
    ) {
      throw new Error(
        `${relativePath} is not the fixed 3 bpp grouped-5-front stream required by the Direct3D shader`,
      );
    }
    const payload = Buffer.alloc(align(source.length, 4));
    source.copy(payload);
    return createTextureContainer(2, info.width, info.height, payload, [
      info.mcuColumns,
      info.quality,
      info.bytesPerMcu,
      info.yBytes,
      info.cbBytes,
      info.crBytes,
      readUint32Le(source, 52),
      0, 0, 0, 0, 0, 0, 0,
    ]);
  }

  if (codec === "astc") {
    const decoded = await decodeTexture(codec, relativePath, astcModule);
    const blockWidth = 6;
    const blockHeight = 6;
    const blocksX = Math.ceil(decoded.width / blockWidth);
    const blocksY = Math.ceil(decoded.height / blockHeight);
    const payload = Buffer.alloc(blocksX * blocksY * 16);

    for (let blockY = 0; blockY < blocksY; blockY += 1) {
      for (let blockX = 0; blockX < blocksX; blockX += 1) {
        const sums = [0, 0, 0, 0];
        let count = 0;
        for (let y = blockY * blockHeight; y < Math.min(decoded.height, (blockY + 1) * blockHeight); y += 1) {
          for (let x = blockX * blockWidth; x < Math.min(decoded.width, (blockX + 1) * blockWidth); x += 1) {
            const pixel = (y * decoded.width + x) * 4;
            for (let channel = 0; channel < 4; channel += 1) sums[channel] += decoded.pixels[pixel + channel];
            count += 1;
          }
        }
        const offset = (blockY * blocksX + blockX) * 16;
        payload[offset] = 0xfc;
        payload[offset + 1] = 0xfd;
        payload.fill(0xff, offset + 2, offset + 8);
        for (let channel = 0; channel < 4; channel += 1) {
          payload.writeUInt16LE(Math.round(sums[channel] / count) * 257, offset + 8 + channel * 2);
        }
      }
    }
    return createTextureContainer(3, decoded.width, decoded.height, payload, [
      blockWidth,
      blockHeight,
      blocksX,
      blocksY,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  }

  throw new RangeError(`Unsupported codec: ${codec}`);
}

function createTextureContainer(codec, width, height, payload, parameters) {
  if (parameters.length !== 14 || payload.length % 4 !== 0) {
    throw new Error("Invalid native texture stream layout");
  }
  const output = Buffer.alloc(TEXTURE_STREAM_HEADER_BYTES + payload.length);
  output.write("DXTX", 0, 4, "ascii");
  output.writeUInt32LE(1, 4);
  output.writeUInt32LE(codec, 8);
  output.writeUInt32LE(width, 12);
  output.writeUInt32LE(height, 16);
  output.writeUInt32LE(payload.length, 20);
  parameters.forEach((value, index) => output.writeUInt32LE(value >>> 0, 24 + index * 4));
  payload.copy(output, TEXTURE_STREAM_HEADER_BYTES);
  return output;
}

function buildShaderSource() {
  const template = fs.readFileSync(
    path.join(ROOT, "native", "win32-directx-viewer", "scene.hlsl.in"),
    "utf8",
  );
  const source = fs.readFileSync(
    path.join(ROOT, "src", "shaders", "cube-webgl2-dctbs2-3bpp.frag.glsl"),
    "utf8",
  );
  const tables = ["DCT_SCAN_Y", "DCT_SCAN_C420"].map((name) => {
    const expression = new RegExp(
      `const int ${name}\\[(\\d+)\\] = int\\[\\d+\\]\\(\\s*([\\s\\S]*?)\\s*\\);`,
    );
    const match = source.match(expression);
    if (!match) throw new Error(`Could not extract ${name} from the generated DCT shader`);
    const values = match[2].split(",").map((value) => Number(value.trim()));
    if (values.length !== Number(match[1]) || values.some((value) => !Number.isInteger(value))) {
      throw new Error(`Invalid ${name} table`);
    }
    const lines = [];
    for (let index = 0; index < values.length; index += 17) {
      lines.push(`    ${values.slice(index, index + 17).join(", ")}`);
    }
    return `static const int ${name}[${values.length}] = {\n${lines.join(",\n")}\n};`;
  });
  const generated = template.replace("__DCT_SCAN_TABLES__", tables.join("\n\n"));
  if (generated.includes("__DCT_SCAN_TABLES__")) throw new Error("HLSL template expansion failed");
  fs.writeFileSync(path.join(OUTPUT_DIRECTORY, "scene.hlsl"), generated);
}

async function decodeTexture(codec, relativePath, astcModule) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(SOURCE_DIRECTORY, relativePath)));
  if (codec === "bpal") return BpalTextureDecoder.decode(bytes);
  if (codec === "dct") return DctImageFormat.decodeDctFile(bytes);
  if (codec !== "astc") throw new RangeError(`Unsupported codec: ${codec}`);

  if (bytes.length < 16 || bytes[0] !== 0x13 || bytes[1] !== 0xAB || bytes[2] !== 0xA1 || bytes[3] !== 0x5C) {
    throw new RangeError(`Invalid ASTC file: ${relativePath}`);
  }
  const width = readUint24(bytes, 7);
  const height = readUint24(bytes, 10);
  const restored = astcModule.decompressImage(
    bytes.subarray(16),
    width,
    height,
    `${bytes[4]}x${bytes[5]}`,
  );
  if (!restored.success) throw new Error(restored.error || `ASTC decompression failed: ${relativePath}`);
  return { width, height, pixels: new Uint8ClampedArray(restored.data) };
}

function readAccessor(accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  if (accessor.sparse) throw new Error("Sparse glTF accessors are not supported");
  const view = gltf.bufferViews[accessor.bufferView];
  const componentCount = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 })[accessor.type];
  const componentBytes = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 })[accessor.componentType];
  if (!componentCount || !componentBytes) throw new Error(`Unsupported accessor layout: ${accessor.type}/${accessor.componentType}`);
  const stride = view.byteStride || componentCount * componentBytes;
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const dataView = new DataView(geometry.buffer, geometry.byteOffset, geometry.byteLength);
  const values = [];

  for (let element = 0; element < accessor.count; element += 1) {
    const entry = [];
    for (let component = 0; component < componentCount; component += 1) {
      entry.push(readComponent(dataView, start + element * stride + component * componentBytes, accessor));
    }
    values.push(entry);
  }
  return values;
}

function readComponent(view, offset, accessor) {
  let value;
  switch (accessor.componentType) {
    case 5120: value = view.getInt8(offset); break;
    case 5121: value = view.getUint8(offset); break;
    case 5122: value = view.getInt16(offset, true); break;
    case 5123: value = view.getUint16(offset, true); break;
    case 5125: value = view.getUint32(offset, true); break;
    case 5126: return view.getFloat32(offset, true);
    default: throw new Error(`Unsupported component type: ${accessor.componentType}`);
  }
  if (!accessor.normalized) return value;
  if (accessor.componentType === 5120) return Math.max(value / 127, -1);
  if (accessor.componentType === 5121) return value / 255;
  if (accessor.componentType === 5122) return Math.max(value / 32767, -1);
  if (accessor.componentType === 5123) return value / 65535;
  return value;
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function nodeMatrix(node) {
  if (node.matrix) return [...node.matrix];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiplyMatrices(a, b) {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let inner = 0; inner < 4; inner += 1) {
        result[column * 4 + row] += a[inner * 4 + row] * b[column * 4 + inner];
      }
    }
  }
  return result;
}

function transformPosition(matrix, value) {
  return [
    matrix[0] * value[0] + matrix[4] * value[1] + matrix[8] * value[2] + matrix[12],
    matrix[1] * value[0] + matrix[5] * value[1] + matrix[9] * value[2] + matrix[13],
    matrix[2] * value[0] + matrix[6] * value[1] + matrix[10] * value[2] + matrix[14],
  ];
}

function createNormalMatrix(matrix) {
  const a = matrix[0], b = matrix[4], c = matrix[8];
  const d = matrix[1], e = matrix[5], f = matrix[9];
  const g = matrix[2], h = matrix[6], i = matrix[10];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inverse = [
    (e * i - f * h), (c * h - b * i), (b * f - c * e),
    (f * g - d * i), (a * i - c * g), (c * d - a * f),
    (d * h - e * g), (b * g - a * h), (a * e - b * d),
  ].map((value) => value / determinant);
  return [
    inverse[0], inverse[3], inverse[6],
    inverse[1], inverse[4], inverse[7],
    inverse[2], inverse[5], inverse[8],
  ];
}

function transformDirection(matrix, value) {
  return [
    matrix[0] * value[0] + matrix[1] * value[1] + matrix[2] * value[2],
    matrix[3] * value[0] + matrix[4] * value[1] + matrix[5] * value[2],
    matrix[6] * value[0] + matrix[7] * value[1] + matrix[8] * value[2],
  ];
}

function matrixDeterminant3(matrix) {
  return matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6]) -
    matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2]) +
    matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
}

function normalize3(value) {
  const length = Math.hypot(...value) || 1;
  return value.map((component) => component / length);
}

function expandBounds(bounds, position) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], position[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], position[axis]);
  }
}

function writeFixedString(buffer, offset, length, text) {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length >= length) throw new Error(`Fixed string is too long: ${text}`);
  encoded.copy(buffer, offset);
}

function readUint24(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}

function readUint32Le(bytes, offset) {
  return bytes[offset] |
    bytes[offset + 1] << 8 |
    bytes[offset + 2] << 16 |
    bytes[offset + 3] << 24;
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
