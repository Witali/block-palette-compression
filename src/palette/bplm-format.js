(function (root, factory) {
  "use strict";

  const blockPaletteFormat = typeof module === "object" && module.exports
    ? require("./block-palette-format.js")
    : root.BlockPaletteFormat;
  const textureDecoder = typeof module === "object" && module.exports
    ? require("../decoders/bpal-texture.js")
    : root.BpalTextureDecoder;
  const api = factory(blockPaletteFormat, textureDecoder);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BplmFormat = api;
})(typeof self !== "undefined" ? self : globalThis, function (blockPaletteFormat, textureDecoder) {
  "use strict";

  const MAGIC = [0x42, 0x50, 0x4c, 0x4d];
  const MAGIC_TEXT = "BPLM";
  const VERSION = 1;
  const HEADER_BYTES = 12;
  const LEVEL_HEADER_BYTES = 16;
  const MIN_BLOCK_SIZE = 1;

  function encodeBplmFile(image, options) {
    requireDependencies();

    const baseBytes = blockPaletteFormat.encodeBlockPaletteFile(image);
    const base = blockPaletteFormat.decodeBlockPaletteFile(baseBytes);
    const levels = textureDecoder.createMipLevels(base, options);

    if (levels.length > 255) {
      throw new RangeError("BPLM cannot contain more than 255 mip levels");
    }

    const encodedLevels = levels.slice(1).map((level) => encodeLevel(level, base));
    const totalBytes = HEADER_BYTES + baseBytes.length + encodedLevels.reduce(
      (sum, level) => sum + LEVEL_HEADER_BYTES + level.payload.length,
      0
    );
    const bytes = new Uint8Array(totalBytes);
    const view = new DataView(bytes.buffer);

    bytes.set(MAGIC, 0);
    view.setUint8(4, VERSION);
    view.setUint8(5, levels.length);
    view.setUint16(6, 0, true);
    view.setUint32(8, baseBytes.length, true);
    bytes.set(baseBytes, HEADER_BYTES);

    let offset = HEADER_BYTES + baseBytes.length;

    encodedLevels.forEach(({ level, payload }) => {
      view.setUint32(offset, level.width, true);
      view.setUint32(offset + 4, level.height, true);
      view.setUint16(offset + 8, level.blockSize, true);
      view.setUint16(offset + 10, 0, true);
      view.setUint32(offset + 12, payload.length, true);
      bytes.set(payload, offset + LEVEL_HEADER_BYTES);
      offset += LEVEL_HEADER_BYTES + payload.length;
    });

    return bytes;
  }

  function decodeBplmFile(input) {
    requireDependencies();

    const bytes = asUint8Array(input);

    if (bytes.length < HEADER_BYTES) {
      throw new RangeError("Truncated BPLM header");
    }

    if (!hasMagic(bytes)) {
      throw new RangeError("Invalid BPLM magic");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(4);
    const mipCount = view.getUint8(5);
    const reserved = view.getUint16(6, true);
    const baseByteLength = view.getUint32(8, true);

    if (version !== VERSION) {
      throw new RangeError(`Unsupported BPLM version: ${version}`);
    }

    if (mipCount < 1) {
      throw new RangeError("BPLM must contain a base mip level");
    }

    if (reserved !== 0) {
      throw new RangeError("Unsupported BPLM flags");
    }

    const baseEnd = HEADER_BYTES + baseByteLength;

    if (baseByteLength < 1 || baseEnd > bytes.length) {
      throw new RangeError("Truncated BPLM base image");
    }

    const base = blockPaletteFormat.decodeBlockPaletteFile(bytes.subarray(HEADER_BYTES, baseEnd));
    const levels = [createBaseLevel(base)];
    const levelStorage = [];
    let offset = baseEnd;

    for (let mip = 1; mip < mipCount; mip += 1) {
      if (offset + LEVEL_HEADER_BYTES > bytes.length) {
        throw new RangeError(`Truncated BPLM mip ${mip} header`);
      }

      const width = view.getUint32(offset, true);
      const height = view.getUint32(offset + 4, true);
      const blockSize = view.getUint16(offset + 8, true);
      const levelReserved = view.getUint16(offset + 10, true);
      const payloadBytes = view.getUint32(offset + 12, true);
      const previous = levels[mip - 1];

      if (levelReserved !== 0) {
        throw new RangeError(`Unsupported BPLM mip ${mip} flags`);
      }

      validateMipProgression(width, height, blockSize, previous, mip);

      const layout = getLevelLayout(
        width,
        height,
        blockSize,
        base.localColorCount,
        base.globalColorCount
      );

      if (payloadBytes !== layout.payloadBytes) {
        throw new RangeError(`BPLM mip ${mip} payload size does not match its header`);
      }

      const payloadOffset = offset + LEVEL_HEADER_BYTES;
      const payloadEnd = payloadOffset + payloadBytes;

      if (payloadEnd > bytes.length) {
        throw new RangeError(`Truncated BPLM mip ${mip} payload`);
      }

      const reader = new BitReader(bytes.subarray(payloadOffset, payloadEnd));
      let level;

      if (layout.direct) {
        const directGlobalIndices = new Uint16Array(width * height);

        for (let index = 0; index < directGlobalIndices.length; index += 1) {
          directGlobalIndices[index] = reader.read(base.globalIndexBits);
        }

        level = {
          width,
          height,
          blockSize,
          localColorCount: layout.localColorCount,
          blocksX: layout.blocksX,
          blocksY: layout.blocksY,
          direct: true,
          directGlobalIndices,
        };
      } else {
        const blockPaletteIndices = new Uint16Array(layout.blockPaletteEntryCount);
        const pixelIndices = new Uint8Array(width * height);

        for (let index = 0; index < blockPaletteIndices.length; index += 1) {
          blockPaletteIndices[index] = reader.read(base.globalIndexBits);
        }

        for (let index = 0; index < pixelIndices.length; index += 1) {
          pixelIndices[index] = reader.read(layout.localIndexBits);
        }

        level = {
          width,
          height,
          blockSize,
          localColorCount: layout.localColorCount,
          blocksX: layout.blocksX,
          blocksY: layout.blocksY,
          blockPaletteIndices,
          pixelIndices,
        };
      }

      levels.push(level);
      levelStorage.push({
        mip,
        headerBytes: LEVEL_HEADER_BYTES,
        payloadBytes,
        totalBytes: LEVEL_HEADER_BYTES + payloadBytes,
      });
      offset = payloadEnd;
    }

    if (offset !== bytes.length) {
      throw new RangeError("BPLM file size does not match its mip chain");
    }

    return {
      ...base,
      containerMagic: MAGIC_TEXT,
      containerVersion: version,
      mipCount,
      mipLevels: levels,
      bplmStorage: {
        headerBytes: HEADER_BYTES,
        baseBytes: baseByteLength,
        levels: levelStorage,
        totalBytes: bytes.length,
      },
    };
  }

  function isBplmFile(input) {
    try {
      return hasMagic(asUint8Array(input));
    } catch (error) {
      return false;
    }
  }

  function reconstructBplmMipPixels(image, mipIndex) {
    if (!image || !Array.isArray(image.mipLevels) || !Array.isArray(image.palette)) {
      throw new TypeError("Decoded BPLM image is invalid");
    }

    if (!Number.isInteger(mipIndex) || mipIndex < 0 || mipIndex >= image.mipLevels.length) {
      throw new RangeError(`BPLM mip index is out of range: ${mipIndex}`);
    }

    const level = image.mipLevels[mipIndex];
    const pixels = new Uint8ClampedArray(level.width * level.height * 4);

    for (let y = 0; y < level.height; y += 1) {
      for (let x = 0; x < level.width; x += 1) {
        const pixelIndex = y * level.width + x;
        let globalIndex;

        if (level.direct) {
          globalIndex = level.directGlobalIndices[pixelIndex];
        } else {
          const blockX = Math.floor(x / level.blockSize);
          const blockY = Math.floor(y / level.blockSize);
          const blockIndex = blockY * level.blocksX + blockX;
          const localIndex = level.pixelIndices[pixelIndex];

          globalIndex = level.blockPaletteIndices[
            blockIndex * level.localColorCount + localIndex
          ];
        }

        const color = image.palette[globalIndex];

        if (!color) {
          throw new RangeError(`BPLM mip ${mipIndex} references palette index ${globalIndex}`);
        }

        const target = pixelIndex * 4;

        pixels[target] = color.r;
        pixels[target + 1] = color.g;
        pixels[target + 2] = color.b;
        pixels[target + 3] = 255;
      }
    }

    return pixels;
  }

  function encodeLevel(level, base) {
    const layout = getLevelLayout(
      level.width,
      level.height,
      level.blockSize,
      base.localColorCount,
      base.globalColorCount
    );

    const payload = new Uint8Array(layout.payloadBytes);
    const writer = new BitWriter(payload);

    if (layout.direct) {
      validateIndexArray(
        level.directGlobalIndices,
        level.width * level.height,
        base.globalColorCount,
        "direct global"
      );

      for (const globalIndex of level.directGlobalIndices) {
        writer.write(globalIndex, base.globalIndexBits);
      }
    } else {
      validateIndexArray(
        level.blockPaletteIndices,
        layout.blockPaletteEntryCount,
        base.globalColorCount,
        "global palette"
      );
      validateIndexArray(
        level.pixelIndices,
        level.width * level.height,
        layout.localColorCount,
        "local pixel"
      );

      for (const globalIndex of level.blockPaletteIndices) {
        writer.write(globalIndex, base.globalIndexBits);
      }

      for (const localIndex of level.pixelIndices) {
        writer.write(localIndex, layout.localIndexBits);
      }
    }

    return { level, payload };
  }

  function createBaseLevel(base) {
    return {
      width: base.width,
      height: base.height,
      blockSize: base.blockSize,
      localColorCount: base.localColorCount,
      blocksX: base.blocksX,
      blocksY: base.blocksY,
      blockPaletteIndices: base.blockPaletteIndices,
      pixelIndices: base.pixelIndices,
    };
  }

  function getLevelLayout(width, height, blockSize, localColorCount, globalColorCount) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError("BPLM mip dimensions must be positive integers");
    }

    if (!isPowerOfTwo(blockSize) || blockSize < MIN_BLOCK_SIZE || blockSize > 64) {
      throw new RangeError("BPLM mip block size must be a power of two from 1 to 64");
    }

    const levelLocalColorCount = Math.min(localColorCount, blockSize * blockSize);
    const direct = levelLocalColorCount === blockSize * blockSize;
    const localIndexBits = direct ? 0 : Math.log2(levelLocalColorCount);
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const blockPaletteEntryCount = direct
      ? width * height
      : blocksX * blocksY * levelLocalColorCount;
    const payloadBits = direct
      ? width * height * Math.log2(globalColorCount)
      : blockPaletteEntryCount * Math.log2(globalColorCount) +
        width * height * localIndexBits;

    return {
      direct,
      localColorCount: levelLocalColorCount,
      localIndexBits,
      blocksX,
      blocksY,
      blockPaletteEntryCount,
      payloadBits,
      payloadBytes: Math.ceil(payloadBits / 8),
    };
  }

  function validateMipProgression(width, height, blockSize, previous, mip) {
    const expectedWidth = Math.max(1, Math.floor(previous.width / 2));
    const expectedHeight = Math.max(1, Math.floor(previous.height / 2));
    const expectedBlockSize = Math.max(MIN_BLOCK_SIZE, previous.blockSize / 2);

    if (width !== expectedWidth || height !== expectedHeight) {
      throw new RangeError(`BPLM mip ${mip} dimensions do not halve the previous level`);
    }

    if (blockSize !== expectedBlockSize) {
      throw new RangeError(`BPLM mip ${mip} block size does not halve the previous level`);
    }
  }

  function validateIndexArray(values, expectedLength, limit, name) {
    if (!values || values.length !== expectedLength) {
      throw new RangeError(`BPLM ${name} index count is invalid`);
    }

    for (const value of values) {
      if (!Number.isInteger(value) || value < 0 || value >= limit) {
        throw new RangeError(`BPLM ${name} index is out of range`);
      }
    }
  }

  function requireDependencies() {
    if (!blockPaletteFormat || typeof blockPaletteFormat.encodeBlockPaletteFile !== "function") {
      throw new Error("BPAL format codec is unavailable");
    }

    if (!textureDecoder || typeof textureDecoder.createMipLevels !== "function") {
      throw new Error("BPAL mipmap encoder is unavailable");
    }
  }

  function hasMagic(bytes) {
    return bytes.length >= MAGIC.length && MAGIC.every((value, index) => bytes[index] === value);
  }

  function asUint8Array(input) {
    if (input instanceof Uint8Array) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }

    throw new TypeError("BPLM input must be an ArrayBuffer or Uint8Array");
  }

  function isPowerOfTwo(value) {
    return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
  }

  class BitWriter {
    constructor(bytes) {
      this.bytes = bytes;
      this.bitOffset = 0;
    }

    write(value, bitCount) {
      if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bitCount) {
        throw new RangeError(`Value ${value} does not fit in ${bitCount} bits`);
      }

      for (let bit = bitCount - 1; bit >= 0; bit -= 1) {
        const byteIndex = Math.floor(this.bitOffset / 8);
        const bitInByte = 7 - this.bitOffset % 8;

        this.bytes[byteIndex] |= (Math.floor(value / 2 ** bit) % 2) << bitInByte;
        this.bitOffset += 1;
      }
    }
  }

  class BitReader {
    constructor(bytes) {
      this.bytes = bytes;
      this.bitOffset = 0;
    }

    read(bitCount) {
      if (this.bitOffset + bitCount > this.bytes.length * 8) {
        throw new RangeError("Truncated BPLM bit stream");
      }

      let value = 0;

      for (let bit = 0; bit < bitCount; bit += 1) {
        const byteIndex = Math.floor(this.bitOffset / 8);
        const bitInByte = 7 - this.bitOffset % 8;

        value = value * 2 + (this.bytes[byteIndex] >> bitInByte & 1);
        this.bitOffset += 1;
      }

      return value;
    }
  }

  return {
    MAGIC: MAGIC_TEXT,
    VERSION,
    HEADER_BYTES,
    LEVEL_HEADER_BYTES,
    encodeBplmFile,
    decodeBplmFile,
    isBplmFile,
    reconstructBplmMipPixels,
  };
});
