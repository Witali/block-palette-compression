(function (root, factory) {
  "use strict";

  const adaptiveBlockFormat = typeof module === "object" && module.exports
    ? require("./adaptive-block-format.js")
    : root.AdaptiveBlockFormat;
  const api = factory(adaptiveBlockFormat);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AdaptiveBlockWebGL2 = api;
})(typeof self !== "undefined" ? self : globalThis, function (adaptiveBlockFormat) {
  "use strict";

  const HEADER_BYTES = 32;
  const TILE_SIZE = 64;
  const DIRECTORY_OFFSET_MASK = 0x3fffffff;
  const MAX_WORD_READS = 8;

  const SAMPLER_GLSL = `
uniform highp usampler2D uBpavWords;
uniform highp ivec2 uBpavWordTextureSize;
uniform highp uvec2 uBpavImageSize;
uniform highp uint uBpavDirectoryStartWords;
uniform highp uint uBpavBlockStreamStartBytes;
uniform highp uint uBpavPixelStreamStartBytes;
uniform highp uvec4 uBpavPaletteStartBytes;
uniform highp uint uBpavLocalIndexBits;
uniform highp uint uBpavGlobalIndexBits;
uniform highp uint uBpavPaletteIndexBits;
uniform highp uint uBpavLocalColorCount;
uniform highp uint uBpavGlobalColorCount;
uniform highp uint uBpavPaletteColorBits;

uint bpavLoadWord(uint wordIndex) {
  uint width = uint(uBpavWordTextureSize.x);
  ivec2 coordinate = ivec2(int(wordIndex % width), int(wordIndex / width));
  return texelFetch(uBpavWords, coordinate, 0).r;
}

uint bpavByteSwap(uint value) {
  return
    (value >> 24u) |
    ((value >> 8u) & 0x0000ff00u) |
    ((value << 8u) & 0x00ff0000u) |
    (value << 24u);
}

uint bpavBitMask(uint bitCount) {
  return bitCount == 0u ? 0u : (1u << bitCount) - 1u;
}

uint bpavReadPacked(uint bitOffset, uint bitCount) {
  uint wordIndex = bitOffset >> 5u;
  uint bitInWord = bitOffset & 31u;
  uint first = bpavByteSwap(bpavLoadWord(wordIndex));

  if (bitInWord + bitCount <= 32u) {
    return (first >> (32u - bitInWord - bitCount)) & bpavBitMask(bitCount);
  }

  uint firstBits = 32u - bitInWord;
  uint secondBits = bitCount - firstBits;
  uint second = bpavByteSwap(bpavLoadWord(wordIndex + 1u));
  return
    ((first & bpavBitMask(firstBits)) << secondBits) |
    (second >> (32u - secondBits));
}

uvec4 bpavReadColor(uint bitOffset) {
  if (uBpavPaletteColorBits == 16u) {
    uint value = bpavReadPacked(bitOffset, 16u);
    uint red = ((value >> 11u) & 31u) * 255u + 15u;
    uint green = ((value >> 5u) & 63u) * 255u + 31u;
    uint blue = (value & 31u) * 255u + 15u;
    return uvec4(red / 31u, green / 63u, blue / 31u, 255u);
  }

  uint value = bpavReadPacked(bitOffset, 24u);
  return uvec4(value >> 16u, (value >> 8u) & 255u, value & 255u, 255u);
}

uvec4 bpavSample(ivec2 coordinate) {
  uvec2 pixel = uvec2(coordinate);
  uint tilesX = (uBpavImageSize.x + 63u) >> 6u;
  uvec2 tileCoordinate = pixel >> 6u;
  uint tile = tileCoordinate.y * tilesX + tileCoordinate.x;
  uint directory = bpavLoadWord(uBpavDirectoryStartWords + tile);
  uint mode = directory >> 30u;
  uint blockOffset = directory & 0x3fffffffu;
  uint blockSize = 4u << mode;
  uvec2 tileOrigin = tileCoordinate << 6u;
  uint tileWidth = min(64u, uBpavImageSize.x - tileOrigin.x);
  uint tileBlocksX = (tileWidth + blockSize - 1u) / blockSize;
  uvec2 localPixel = pixel - tileOrigin;
  uvec2 localBlock = localPixel / blockSize;
  uint block = localBlock.y * tileBlocksX + localBlock.x;
  uint descriptorBits =
    uBpavPaletteIndexBits + uBpavLocalColorCount * uBpavGlobalIndexBits;
  uint descriptorStart =
    (uBpavBlockStreamStartBytes + blockOffset) * 8u + block * descriptorBits;
  uint pixelIndex = pixel.y * uBpavImageSize.x + pixel.x;
  uint localIndex = bpavReadPacked(
    uBpavPixelStreamStartBytes * 8u + pixelIndex * uBpavLocalIndexBits,
    uBpavLocalIndexBits
  );
  uint selector = uBpavPaletteIndexBits == 0u
    ? 0u
    : bpavReadPacked(descriptorStart, uBpavPaletteIndexBits);
  uint globalIndex = bpavReadPacked(
    descriptorStart + uBpavPaletteIndexBits + localIndex * uBpavGlobalIndexBits,
    uBpavGlobalIndexBits
  );
  uint colorIndex = selector * uBpavGlobalColorCount + globalIndex;
  uint colorOffset = uBpavPaletteStartBytes[int(mode)] * 8u +
    colorIndex * uBpavPaletteColorBits;
  return bpavReadColor(colorOffset);
}
`;

  const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
${SAMPLER_GLSL}
out vec4 outputColor;

void main() {
  ivec2 coordinate = ivec2(gl_FragCoord.xy);
  outputColor = vec4(bpavSample(coordinate)) / 255.0;
}
`;

  function createAdaptiveBlockGpuData(input, maxTextureSize) {
    requireFormat();
    const bytes = asUint8Array(input);
    const accessor = adaptiveBlockFormat.openAdaptiveBlockFile(bytes);
    const textureLimit = Number(maxTextureSize);

    if (!Number.isInteger(textureLimit) || textureLimit < 1) {
      throw new RangeError("WebGL maximum texture size must be a positive integer");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const localIndexBits = view.getUint8(6);
    const globalIndexBits = view.getUint8(7);
    const paletteIndexBits = view.getUint8(8);
    const paletteColorBits = view.getUint8(9);
    const modeMask = view.getUint8(10);
    const blockStreamBytes = view.getUint32(20, true);
    const localColorCount = 2 ** localIndexBits;
    const globalColorCount = 2 ** globalIndexBits;
    const paletteCount = 2 ** paletteIndexBits;
    const paletteBytesPerMode = paletteCount * globalColorCount * paletteColorBits / 8;
    const usedModes = [];

    for (let mode = 0; mode < 4; mode += 1) {
      if ((modeMask & (1 << mode)) !== 0) {
        usedModes.push(mode);
      }
    }

    const paletteSectionBytes = align4(usedModes.length * paletteBytesPerMode);
    const directoryStartBytes = HEADER_BYTES + paletteSectionBytes;
    const blockStreamStartBytes = directoryStartBytes + accessor.tileCount * 4;
    const pixelStreamStartBytes = blockStreamStartBytes + blockStreamBytes;
    const paletteStartBytes = new Uint32Array(4);
    let paletteRank = 0;

    for (let mode = 0; mode < 4; mode += 1) {
      if ((modeMask & (1 << mode)) !== 0) {
        paletteStartBytes[mode] = HEADER_BYTES + paletteRank * paletteBytesPerMode;
        paletteRank += 1;
      }
    }

    const sourceWords = new Uint32Array(bytes.length / 4);

    for (let word = 0; word < sourceWords.length; word += 1) {
      sourceWords[word] = view.getUint32(word * 4, true);
    }

    const atlasWidth = Math.min(textureLimit, sourceWords.length);
    const atlasHeight = Math.ceil(sourceWords.length / atlasWidth);

    if (atlasHeight > textureLimit) {
      throw new RangeError("BPAV word atlas exceeds the WebGL texture size limit");
    }

    const words = new Uint32Array(atlasWidth * atlasHeight);

    words.set(sourceWords);

    return {
      format: "bpav-webgl2",
      words,
      wordAtlas: {
        width: atlasWidth,
        height: atlasHeight,
        data: words,
      },
      width: accessor.width,
      height: accessor.height,
      localColorCount,
      globalColorCount,
      paletteCount,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      paletteColorBits,
      directoryStartWords: directoryStartBytes / 4,
      blockStreamStartBytes,
      pixelStreamStartBytes,
      paletteStartBytes,
      gpuBytes: words.byteLength,
      maximumWordReadsPerPixel: MAX_WORD_READS,
    };
  }

  function uploadAdaptiveBlockGpuTexture(gl, data, textureUnit) {
    validateGpuData(data);
    validateWebGL2(gl);
    const unit = normalizeTextureUnit(textureUnit);
    const texture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32UI,
      data.wordAtlas.width,
      data.wordAtlas.height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      data.wordAtlas.data
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    return { texture, textureUnit: unit, data };
  }

  function bindAdaptiveBlockSamplerUniforms(gl, program, data, textureUnit) {
    validateGpuData(data);
    validateWebGL2(gl);
    const unit = normalizeTextureUnit(textureUnit);
    const locations = {};

    for (const name of [
      "uBpavWords",
      "uBpavWordTextureSize",
      "uBpavImageSize",
      "uBpavDirectoryStartWords",
      "uBpavBlockStreamStartBytes",
      "uBpavPixelStreamStartBytes",
      "uBpavPaletteStartBytes",
      "uBpavLocalIndexBits",
      "uBpavGlobalIndexBits",
      "uBpavPaletteIndexBits",
      "uBpavLocalColorCount",
      "uBpavGlobalColorCount",
      "uBpavPaletteColorBits",
    ]) {
      locations[name] = gl.getUniformLocation(program, name);
    }

    setUniform(gl, locations.uBpavWords, "uniform1i", unit);
    setUniform(
      gl,
      locations.uBpavWordTextureSize,
      "uniform2i",
      data.wordAtlas.width,
      data.wordAtlas.height
    );
    setUniform(gl, locations.uBpavImageSize, "uniform2ui", data.width, data.height);
    setUniform(gl, locations.uBpavDirectoryStartWords, "uniform1ui", data.directoryStartWords);
    setUniform(gl, locations.uBpavBlockStreamStartBytes, "uniform1ui", data.blockStreamStartBytes);
    setUniform(gl, locations.uBpavPixelStreamStartBytes, "uniform1ui", data.pixelStreamStartBytes);
    if (locations.uBpavPaletteStartBytes !== null) {
      gl.uniform4uiv(locations.uBpavPaletteStartBytes, data.paletteStartBytes);
    }
    setUniform(gl, locations.uBpavLocalIndexBits, "uniform1ui", data.localIndexBits);
    setUniform(gl, locations.uBpavGlobalIndexBits, "uniform1ui", data.globalIndexBits);
    setUniform(gl, locations.uBpavPaletteIndexBits, "uniform1ui", data.paletteIndexBits);
    setUniform(gl, locations.uBpavLocalColorCount, "uniform1ui", data.localColorCount);
    setUniform(gl, locations.uBpavGlobalColorCount, "uniform1ui", data.globalColorCount);
    setUniform(gl, locations.uBpavPaletteColorBits, "uniform1ui", data.paletteColorBits);

    return locations;
  }

  function sampleAdaptiveBlockGpuData(data, x, y) {
    validateGpuData(data);
    validateCoordinate(x, data.width, "x");
    validateCoordinate(y, data.height, "y");
    const reads = { count: 0 };
    const tilesX = Math.ceil(data.width / TILE_SIZE);
    const tileX = Math.floor(x / TILE_SIZE);
    const tileY = Math.floor(y / TILE_SIZE);
    const tile = tileY * tilesX + tileX;
    const directory = loadWord(data, data.directoryStartWords + tile, reads);
    const mode = directory >>> 30;
    const blockOffset = directory & DIRECTORY_OFFSET_MASK;
    const blockSize = 4 << mode;
    const tileOriginX = tileX * TILE_SIZE;
    const tileOriginY = tileY * TILE_SIZE;
    const tileWidth = Math.min(TILE_SIZE, data.width - tileOriginX);
    const tileBlocksX = Math.ceil(tileWidth / blockSize);
    const localBlockX = Math.floor((x - tileOriginX) / blockSize);
    const localBlockY = Math.floor((y - tileOriginY) / blockSize);
    const block = localBlockY * tileBlocksX + localBlockX;
    const descriptorBits = data.paletteIndexBits +
      data.localColorCount * data.globalIndexBits;
    const descriptorStart =
      (data.blockStreamStartBytes + blockOffset) * 8 + block * descriptorBits;
    const pixelIndex = y * data.width + x;
    const localIndex = readPacked(
      data,
      data.pixelStreamStartBytes * 8 + pixelIndex * data.localIndexBits,
      data.localIndexBits,
      reads
    );
    const selector = data.paletteIndexBits === 0
      ? 0
      : readPacked(data, descriptorStart, data.paletteIndexBits, reads);
    const globalIndex = readPacked(
      data,
      descriptorStart + data.paletteIndexBits + localIndex * data.globalIndexBits,
      data.globalIndexBits,
      reads
    );
    const colorIndex = selector * data.globalColorCount + globalIndex;
    const color = readColor(
      data,
      data.paletteStartBytes[mode] * 8 + colorIndex * data.paletteColorBits,
      reads
    );

    if (reads.count > MAX_WORD_READS) {
      throw new Error(`BPAV shader path exceeded ${MAX_WORD_READS} word reads`);
    }
    return { ...color, reads: reads.count };
  }

  function readColor(data, bitOffset, reads) {
    if (data.paletteColorBits === 16) {
      const value = readPacked(data, bitOffset, 16, reads);
      return {
        r: Math.floor(((value >> 11 & 31) * 255 + 15) / 31),
        g: Math.floor(((value >> 5 & 63) * 255 + 31) / 63),
        b: Math.floor(((value & 31) * 255 + 15) / 31),
        a: 255,
      };
    }
    const value = readPacked(data, bitOffset, 24, reads);
    return {
      r: Math.floor(value / 0x10000),
      g: Math.floor(value / 0x100) & 255,
      b: value & 255,
      a: 255,
    };
  }

  function readPacked(data, bitOffset, bitCount, reads) {
    const wordIndex = Math.floor(bitOffset / 32);
    const bitInWord = bitOffset % 32;
    const first = byteSwap(loadWord(data, wordIndex, reads));

    if (bitInWord + bitCount <= 32) {
      return unsignedExtract(first, bitInWord, bitCount);
    }

    const firstBits = 32 - bitInWord;
    const second = byteSwap(loadWord(data, wordIndex + 1, reads));
    return unsignedExtract(first, bitInWord, firstBits) * 2 ** (bitCount - firstBits) +
      unsignedExtract(second, 0, bitCount - firstBits);
  }

  function loadWord(data, wordIndex, reads) {
    const x = wordIndex % data.wordAtlas.width;
    const y = Math.floor(wordIndex / data.wordAtlas.width);

    if (y >= data.wordAtlas.height) {
      throw new RangeError("BPAV shader word index is outside the atlas");
    }
    reads.count += 1;
    return data.wordAtlas.data[y * data.wordAtlas.width + x] >>> 0;
  }

  function byteSwap(value) {
    return (
      (value >>> 24) |
      (value >>> 8 & 0x0000ff00) |
      (value << 8 & 0x00ff0000) |
      (value << 24)
    ) >>> 0;
  }

  function unsignedExtract(word, bitOffset, bitCount) {
    if (bitCount === 0) {
      return 0;
    }
    const shift = 32 - bitOffset - bitCount;
    return Math.floor(word / 2 ** shift) % 2 ** bitCount;
  }

  function validateGpuData(data) {
    if (!data || data.format !== "bpav-webgl2" ||
        !data.wordAtlas || !(data.wordAtlas.data instanceof Uint32Array) ||
        !Number.isInteger(data.width) || !Number.isInteger(data.height)) {
      throw new TypeError("BPAV WebGL2 data is invalid");
    }
  }

  function validateWebGL2(gl) {
    if (!gl || typeof gl.texImage2D !== "function" ||
        typeof gl.uniform1ui !== "function" || gl.R32UI === undefined ||
        gl.RED_INTEGER === undefined) {
      throw new Error("BPAV sampling requires WebGL2 integer textures");
    }
  }

  function setUniform(gl, location, method, ...values) {
    if (location !== null) {
      gl[method](location, ...values);
    }
  }

  function normalizeTextureUnit(value) {
    const unit = value === undefined ? 0 : Number(value);

    if (!Number.isInteger(unit) || unit < 0) {
      throw new RangeError("BPAV texture unit must be a non-negative integer");
    }
    return unit;
  }

  function validateCoordinate(value, limit, name) {
    if (!Number.isInteger(value) || value < 0 || value >= limit) {
      throw new RangeError(`Invalid BPAV ${name} coordinate`);
    }
  }

  function requireFormat() {
    if (!adaptiveBlockFormat ||
        typeof adaptiveBlockFormat.openAdaptiveBlockFile !== "function") {
      throw new Error("BPAV format decoder is unavailable");
    }
  }

  function asUint8Array(input) {
    if (input instanceof Uint8Array) {
      return input;
    }
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    throw new TypeError("BPAV input must be an ArrayBuffer or Uint8Array");
  }

  function align4(value) {
    return Math.ceil(value / 4) * 4;
  }

  return {
    MAX_WORD_READS,
    SAMPLER_GLSL,
    FRAGMENT_SHADER,
    createAdaptiveBlockGpuData,
    uploadAdaptiveBlockGpuTexture,
    bindAdaptiveBlockSamplerUniforms,
    sampleAdaptiveBlockGpuData,
  };
});
