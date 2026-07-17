(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.StandardTextureCodecs = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const ASTC_PROFILES = Object.freeze([
    "4x4", "5x4", "5x5", "6x5", "6x6", "8x5", "8x6",
    "8x8", "10x5", "10x6", "10x8", "10x10", "12x10", "12x12",
  ]);
  const BC7_WEIGHTS = Object.freeze([0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]);
  const BC_QUALITY_PASSES = Object.freeze({ fast: 1, balanced: 3, thorough: 6 });
  const DDS_HEADER_BYTES = 128;
  const DDS_DX10_HEADER_BYTES = 20;

  function encodeBc1Image(pixels, width, height, options = {}) {
    validateImage(pixels, width, height);
    const quality = normalizeQuality(options.quality);
    const blocksX = Math.ceil(width / 4);
    const blocksY = Math.ceil(height / 4);
    const payload = new Uint8Array(blocksX * blocksY * 8);
    const decoded = new Uint8ClampedArray(width * height * 4);

    for (let blockY = 0; blockY < blocksY; blockY += 1) {
      for (let blockX = 0; blockX < blocksX; blockX += 1) {
        const block = readBlock4x4(pixels, width, height, blockX, blockY);
        const encoded = encodeBc1Block(block, quality);
        const blockIndex = blockY * blocksX + blockX;
        payload.set(encoded, blockIndex * 8);
        writeDecodedBlock(decoded, width, height, blockX, blockY, decodeBc1Block(encoded));
      }
    }

    return {
      payload,
      decoded,
      blocksX,
      blocksY,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 8,
      quality,
    };
  }

  function encodeBc7Image(pixels, width, height, options = {}) {
    validateImage(pixels, width, height);
    const quality = normalizeQuality(options.quality);
    const blocksX = Math.ceil(width / 4);
    const blocksY = Math.ceil(height / 4);
    const payload = new Uint8Array(blocksX * blocksY * 16);
    const decoded = new Uint8ClampedArray(width * height * 4);

    for (let blockY = 0; blockY < blocksY; blockY += 1) {
      for (let blockX = 0; blockX < blocksX; blockX += 1) {
        const block = readBlock4x4(pixels, width, height, blockX, blockY);
        const encoded = encodeBc7Mode6Block(block, quality);
        const blockIndex = blockY * blocksX + blockX;
        payload.set(encoded, blockIndex * 16);
        writeDecodedBlock(decoded, width, height, blockX, blockY, decodeBc7Mode6Block(encoded));
      }
    }

    return {
      payload,
      decoded,
      blocksX,
      blocksY,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 16,
      quality,
      mode: 6,
    };
  }

  function encodeBc1Block(pixels, quality = "balanced") {
    const endpoints = principalEndpoints(pixels, 3);
    let color0 = packRgb565(endpoints.high);
    let color1 = packRgb565(endpoints.low);

    if (color0 <= color1) {
      [color0, color1] = [color1, color0];
      if (color0 === color1) {
        color0 = Math.min(0xFFFF, color0 + 1);
        if (color0 <= color1) color1 = Math.max(0, color1 - 1);
      }
    }

    let best = evaluateBc1Endpoints(pixels, color0, color1);
    const passes = BC_QUALITY_PASSES[normalizeQuality(quality)];
    for (let pass = 0; pass < passes; pass += 1) {
      let changed = false;
      for (const endpointName of ["color0", "color1"]) {
        for (const delta of [-2048, 2048, -32, 32, -1, 1]) {
          const candidate0 = endpointName === "color0" ? clamp(best.color0 + delta, 0, 0xFFFF) : best.color0;
          const candidate1 = endpointName === "color1" ? clamp(best.color1 + delta, 0, 0xFFFF) : best.color1;
          if (candidate0 <= candidate1) continue;
          const trial = evaluateBc1Endpoints(pixels, candidate0, candidate1);
          if (trial.error < best.error) {
            best = trial;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }

    const encoded = new Uint8Array(8);
    encoded[0] = best.color0 & 0xFF;
    encoded[1] = best.color0 >>> 8;
    encoded[2] = best.color1 & 0xFF;
    encoded[3] = best.color1 >>> 8;
    let selectors = 0;
    for (let index = 0; index < 16; index += 1) selectors |= best.selectors[index] << (index * 2);
    new DataView(encoded.buffer).setUint32(4, selectors >>> 0, true);
    return encoded;
  }

  function decodeBc1Block(block) {
    if (!(block instanceof Uint8Array) || block.byteLength < 8) throw new TypeError("BC1 block must contain 8 bytes");
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const color0 = view.getUint16(0, true);
    const color1 = view.getUint16(2, true);
    const palette = bc1Palette(color0, color1);
    const selectors = view.getUint32(4, true);
    const pixels = new Uint8ClampedArray(64);
    for (let index = 0; index < 16; index += 1) {
      const color = palette[(selectors >>> (index * 2)) & 3];
      pixels.set(color, index * 4);
    }
    return pixels;
  }

  function inspectBc1Block(block) {
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const color0 = view.getUint16(0, true);
    const color1 = view.getUint16(2, true);
    const packedSelectors = view.getUint32(4, true);
    return {
      format: "BC1",
      mode: color0 > color1 ? "four-color" : "three-color + transparent",
      color0,
      color1,
      endpoints: [unpackRgb565(color0), unpackRgb565(color1)],
      palette: bc1Palette(color0, color1).map((color) => ({ r: color[0], g: color[1], b: color[2], a: color[3] })),
      selectors: Array.from({ length: 16 }, (_, index) => (packedSelectors >>> (index * 2)) & 3),
      bytes: new Uint8Array(block),
    };
  }

  function encodeBc7Mode6Block(pixels, quality = "balanced") {
    const endpoints = principalEndpoints(pixels, 4);
    let low = quantizeMode6Endpoint(endpoints.low);
    let high = quantizeMode6Endpoint(endpoints.high);
    let selectors = assignBc7Selectors(pixels, low.color, high.color);
    const passes = BC_QUALITY_PASSES[normalizeQuality(quality)];

    for (let pass = 0; pass < passes; pass += 1) {
      const fitted = fitEndpoints(pixels, selectors, BC7_WEIGHTS);
      const nextLow = quantizeMode6Endpoint(fitted.low);
      const nextHigh = quantizeMode6Endpoint(fitted.high);
      const nextSelectors = assignBc7Selectors(pixels, nextLow.color, nextHigh.color);
      if (arraysEqual(selectors, nextSelectors) && arraysEqual(low.color, nextLow.color) && arraysEqual(high.color, nextHigh.color)) break;
      low = nextLow;
      high = nextHigh;
      selectors = nextSelectors;
    }

    if (selectors[0] >= 8) {
      [low, high] = [high, low];
      selectors = selectors.map((selector) => 15 - selector);
    }

    const encoded = new Uint8Array(16);
    let bitOffset = 0;
    bitOffset = writeBits(encoded, 1 << 6, 7, bitOffset);
    for (let component = 0; component < 4; component += 1) {
      bitOffset = writeBits(encoded, low.stored[component], 7, bitOffset);
      bitOffset = writeBits(encoded, high.stored[component], 7, bitOffset);
    }
    bitOffset = writeBits(encoded, low.pbit, 1, bitOffset);
    bitOffset = writeBits(encoded, high.pbit, 1, bitOffset);
    for (let index = 0; index < 16; index += 1) {
      bitOffset = writeBits(encoded, selectors[index], index === 0 ? 3 : 4, bitOffset);
    }
    if (bitOffset !== 128) throw new Error(`BC7 mode 6 block used ${bitOffset} bits`);
    return encoded;
  }

  function decodeBc7Mode6Block(block) {
    const description = inspectBc7Mode6Block(block);
    const pixels = new Uint8ClampedArray(64);
    const palette = bc7Palette(description.endpoints[0], description.endpoints[1]);
    for (let index = 0; index < 16; index += 1) pixels.set(palette[description.selectors[index]], index * 4);
    return pixels;
  }

  function inspectBc7Mode6Block(block) {
    if (!(block instanceof Uint8Array) || block.byteLength < 16) throw new TypeError("BC7 block must contain 16 bytes");
    let bitOffset = 0;
    const modePrefix = readBits(block, 7, bitOffset); bitOffset += 7;
    if (modePrefix !== (1 << 6)) throw new RangeError("Only BC7 mode 6 blocks are supported by this decoder");
    const stored = [new Array(4), new Array(4)];
    for (let component = 0; component < 4; component += 1) {
      stored[0][component] = readBits(block, 7, bitOffset); bitOffset += 7;
      stored[1][component] = readBits(block, 7, bitOffset); bitOffset += 7;
    }
    const pbits = [readBits(block, 1, bitOffset), readBits(block, 1, bitOffset + 1)];
    bitOffset += 2;
    const selectors = [];
    for (let index = 0; index < 16; index += 1) {
      const bits = index === 0 ? 3 : 4;
      selectors.push(readBits(block, bits, bitOffset));
      bitOffset += bits;
    }
    const endpoints = stored.map((endpoint, endpointIndex) => endpoint.map((value) => (value << 1) | pbits[endpointIndex]));
    const palette = bc7Palette(endpoints[0], endpoints[1]);
    return {
      format: "BC7",
      mode: 6,
      endpoints: endpoints.map((color) => ({ r: color[0], g: color[1], b: color[2], a: color[3] })),
      palette: palette.map((color) => ({ r: color[0], g: color[1], b: color[2], a: color[3] })),
      storedEndpoints: stored,
      pbits,
      selectors,
      bytes: new Uint8Array(block),
    };
  }

  function createDdsFile(format, payload, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError("DDS dimensions must be positive integers");
    if (!(payload instanceof Uint8Array)) throw new TypeError("DDS payload must be a Uint8Array");
    const normalized = String(format).toLowerCase();
    if (normalized !== "bc1" && normalized !== "bc7") throw new RangeError(`Unsupported DDS codec: ${format}`);
    const hasDx10 = normalized === "bc7";
    const file = new Uint8Array(DDS_HEADER_BYTES + (hasDx10 ? DDS_DX10_HEADER_BYTES : 0) + payload.byteLength);
    const view = new DataView(file.buffer);
    writeAscii(file, 0, "DDS ");
    view.setUint32(4, 124, true);
    view.setUint32(8, 0x00081007, true);
    view.setUint32(12, height, true);
    view.setUint32(16, width, true);
    view.setUint32(20, payload.byteLength, true);
    view.setUint32(28, 1, true);
    view.setUint32(76, 32, true);
    view.setUint32(80, 4, true);
    writeAscii(file, 84, hasDx10 ? "DX10" : "DXT1");
    view.setUint32(108, 0x1000, true);
    if (hasDx10) {
      view.setUint32(128, 98, true);
      view.setUint32(132, 3, true);
      view.setUint32(140, 1, true);
    }
    file.set(payload, DDS_HEADER_BYTES + (hasDx10 ? DDS_DX10_HEADER_BYTES : 0));
    return file;
  }

  function createAstcFile(payload, width, height, profile) {
    if (!(payload instanceof Uint8Array)) throw new TypeError("ASTC payload must be a Uint8Array");
    if (!ASTC_PROFILES.includes(profile)) throw new RangeError(`Unsupported ASTC profile: ${profile}`);
    const [blockWidth, blockHeight] = profile.split("x").map(Number);
    const file = new Uint8Array(16 + payload.byteLength);
    file.set([0x13, 0xAB, 0xA1, 0x5C, blockWidth, blockHeight, 1], 0);
    writeUint24(file, 7, width);
    writeUint24(file, 10, height);
    writeUint24(file, 13, 1);
    file.set(payload, 16);
    return file;
  }

  function extractBlock(file, headerBytes, blockBytes, blockIndex) {
    if (!(file instanceof Uint8Array)) throw new TypeError("Encoded file must be a Uint8Array");
    const offset = headerBytes + blockIndex * blockBytes;
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || offset + blockBytes > file.byteLength) throw new RangeError("Block index is outside the encoded file");
    return file.slice(offset, offset + blockBytes);
  }

  function computeRgbSquaredError(source, decoded) {
    if (source.length !== decoded.length) throw new RangeError("Image buffers must have equal length");
    let error = 0;
    for (let offset = 0; offset < source.length; offset += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = source[offset + channel] - decoded[offset + channel];
        error += delta * delta;
      }
    }
    return error;
  }

  function evaluateBc1Endpoints(pixels, color0, color1) {
    const palette = bc1Palette(color0, color1);
    const selectors = new Uint8Array(16);
    let error = 0;
    for (let index = 0; index < 16; index += 1) {
      let bestError = Infinity;
      for (let selector = 0; selector < 4; selector += 1) {
        const candidate = palette[selector];
        const dr = pixels[index * 4] - candidate[0];
        const dg = pixels[index * 4 + 1] - candidate[1];
        const db = pixels[index * 4 + 2] - candidate[2];
        const candidateError = dr * dr + dg * dg + db * db;
        if (candidateError < bestError) {
          bestError = candidateError;
          selectors[index] = selector;
        }
      }
      error += bestError;
    }
    return { color0, color1, selectors, error };
  }

  function bc1Palette(color0, color1) {
    const a = unpackRgb565(color0);
    const b = unpackRgb565(color1);
    const palette = [
      [a.r, a.g, a.b, 255],
      [b.r, b.g, b.b, 255],
    ];
    if (color0 > color1) {
      palette.push(
        [Math.floor((2 * a.r + b.r) / 3), Math.floor((2 * a.g + b.g) / 3), Math.floor((2 * a.b + b.b) / 3), 255],
        [Math.floor((a.r + 2 * b.r) / 3), Math.floor((a.g + 2 * b.g) / 3), Math.floor((a.b + 2 * b.b) / 3), 255]
      );
    } else {
      palette.push(
        [Math.floor((a.r + b.r) / 2), Math.floor((a.g + b.g) / 2), Math.floor((a.b + b.b) / 2), 255],
        [0, 0, 0, 0]
      );
    }
    return palette;
  }

  function principalEndpoints(pixels, components) {
    const mean = new Array(components).fill(0);
    for (let index = 0; index < 16; index += 1) {
      for (let component = 0; component < components; component += 1) mean[component] += pixels[index * 4 + component];
    }
    for (let component = 0; component < components; component += 1) mean[component] /= 16;
    const covariance = Array.from({ length: components }, () => new Array(components).fill(0));
    for (let index = 0; index < 16; index += 1) {
      for (let a = 0; a < components; a += 1) {
        const da = pixels[index * 4 + a] - mean[a];
        for (let b = 0; b < components; b += 1) covariance[a][b] += da * (pixels[index * 4 + b] - mean[b]);
      }
    }
    let axis = new Array(components).fill(1 / Math.sqrt(components));
    for (let pass = 0; pass < 8; pass += 1) {
      const next = covariance.map((row) => row.reduce((sum, value, index) => sum + value * axis[index], 0));
      const length = Math.hypot(...next);
      if (length < 1e-8) break;
      axis = next.map((value) => value / length);
    }
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = 0; index < 16; index += 1) {
      let projection = 0;
      for (let component = 0; component < components; component += 1) projection += (pixels[index * 4 + component] - mean[component]) * axis[component];
      minimum = Math.min(minimum, projection);
      maximum = Math.max(maximum, projection);
    }
    if (!Number.isFinite(minimum) || maximum - minimum < 1e-5) {
      const color = [...mean];
      while (color.length < 4) color.push(255);
      return { low: color, high: color };
    }
    const low = mean.map((value, index) => clamp(Math.round(value + axis[index] * minimum), 0, 255));
    const high = mean.map((value, index) => clamp(Math.round(value + axis[index] * maximum), 0, 255));
    while (low.length < 4) low.push(255);
    while (high.length < 4) high.push(255);
    return { low, high };
  }

  function quantizeMode6Endpoint(color) {
    let best = null;
    for (const pbit of [0, 1]) {
      const quantized = color.map((value) => clamp(Math.round((value - pbit) / 2), 0, 127));
      const reconstructed = quantized.map((value) => (value << 1) | pbit);
      const error = reconstructed.reduce((sum, value, index) => sum + (value - color[index]) ** 2, 0);
      if (!best || error < best.error) best = { stored: quantized, color: reconstructed, pbit, error };
    }
    return best;
  }

  function assignBc7Selectors(pixels, low, high) {
    const palette = bc7Palette(asColor(low), asColor(high));
    const selectors = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
      let bestError = Infinity;
      for (let selector = 0; selector < 16; selector += 1) {
        let error = 0;
        for (let component = 0; component < 4; component += 1) {
          const delta = pixels[index * 4 + component] - palette[selector][component];
          error += delta * delta;
        }
        if (error < bestError) {
          bestError = error;
          selectors[index] = selector;
        }
      }
    }
    return selectors;
  }

  function fitEndpoints(pixels, selectors, weights) {
    let aa = 0;
    let ab = 0;
    let bb = 0;
    for (const selector of selectors) {
      const b = weights[selector] / 64;
      const a = 1 - b;
      aa += a * a;
      ab += a * b;
      bb += b * b;
    }
    const determinant = aa * bb - ab * ab;
    if (Math.abs(determinant) < 1e-8) return principalEndpoints(pixels, 4);
    const low = [];
    const high = [];
    for (let component = 0; component < 4; component += 1) {
      let ap = 0;
      let bp = 0;
      for (let index = 0; index < 16; index += 1) {
        const b = weights[selectors[index]] / 64;
        const a = 1 - b;
        const value = pixels[index * 4 + component];
        ap += a * value;
        bp += b * value;
      }
      low.push(clamp(Math.round((ap * bb - bp * ab) / determinant), 0, 255));
      high.push(clamp(Math.round((bp * aa - ap * ab) / determinant), 0, 255));
    }
    return { low, high };
  }

  function bc7Palette(lowColor, highColor) {
    const low = Array.isArray(lowColor) ? lowColor : [lowColor.r, lowColor.g, lowColor.b, lowColor.a];
    const high = Array.isArray(highColor) ? highColor : [highColor.r, highColor.g, highColor.b, highColor.a];
    return BC7_WEIGHTS.map((weight) => low.map((value, component) => (value * (64 - weight) + high[component] * weight + 32) >> 6));
  }

  function readBlock4x4(pixels, width, height, blockX, blockY) {
    const block = new Uint8Array(64);
    for (let localY = 0; localY < 4; localY += 1) {
      for (let localX = 0; localX < 4; localX += 1) {
        const sourceX = Math.min(width - 1, blockX * 4 + localX);
        const sourceY = Math.min(height - 1, blockY * 4 + localY);
        const sourceOffset = (sourceY * width + sourceX) * 4;
        const targetOffset = (localY * 4 + localX) * 4;
        block.set(pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
    return block;
  }

  function writeDecodedBlock(target, width, height, blockX, blockY, block) {
    for (let localY = 0; localY < 4; localY += 1) {
      const y = blockY * 4 + localY;
      if (y >= height) continue;
      for (let localX = 0; localX < 4; localX += 1) {
        const x = blockX * 4 + localX;
        if (x >= width) continue;
        const sourceOffset = (localY * 4 + localX) * 4;
        target.set(block.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4);
      }
    }
  }

  function packRgb565(color) {
    const r = Math.round(color[0] * 31 / 255);
    const g = Math.round(color[1] * 63 / 255);
    const b = Math.round(color[2] * 31 / 255);
    return (r << 11) | (g << 5) | b;
  }

  function unpackRgb565(value) {
    const r5 = (value >>> 11) & 31;
    const g6 = (value >>> 5) & 63;
    const b5 = value & 31;
    return {
      r: (r5 << 3) | (r5 >>> 2),
      g: (g6 << 2) | (g6 >>> 4),
      b: (b5 << 3) | (b5 >>> 2),
      a: 255,
    };
  }

  function writeBits(bytes, value, bitCount, bitOffset) {
    for (let bit = 0; bit < bitCount; bit += 1) {
      if ((value >>> bit) & 1) bytes[(bitOffset + bit) >>> 3] |= 1 << ((bitOffset + bit) & 7);
    }
    return bitOffset + bitCount;
  }

  function readBits(bytes, bitCount, bitOffset) {
    let value = 0;
    for (let bit = 0; bit < bitCount; bit += 1) value |= ((bytes[(bitOffset + bit) >>> 3] >>> ((bitOffset + bit) & 7)) & 1) << bit;
    return value >>> 0;
  }

  function writeAscii(bytes, offset, text) {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  }

  function writeUint24(bytes, offset, value) {
    bytes[offset] = value & 0xFF;
    bytes[offset + 1] = (value >>> 8) & 0xFF;
    bytes[offset + 2] = (value >>> 16) & 0xFF;
  }

  function validateImage(pixels, width, height) {
    if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray)) throw new TypeError("Pixels must be RGBA bytes");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError("Image dimensions must be positive integers");
    if (pixels.length !== width * height * 4) throw new RangeError("RGBA byte count does not match image dimensions");
  }

  function normalizeQuality(quality) {
    return Object.hasOwn(BC_QUALITY_PASSES, quality) ? quality : "balanced";
  }

  function asColor(color) {
    return { r: color[0], g: color[1], b: color[2], a: color[3] };
  }

  function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  return Object.freeze({
    ASTC_PROFILES,
    BC7_WEIGHTS,
    DDS_HEADER_BYTES,
    DDS_DX10_HEADER_BYTES,
    encodeBc1Image,
    encodeBc7Image,
    encodeBc1Block,
    decodeBc1Block,
    inspectBc1Block,
    encodeBc7Mode6Block,
    decodeBc7Mode6Block,
    inspectBc7Mode6Block,
    createDdsFile,
    createAstcFile,
    extractBlock,
    computeRgbSquaredError,
  });
});
