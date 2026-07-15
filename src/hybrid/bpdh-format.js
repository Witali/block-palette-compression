(function (root, factory) {
  "use strict";

  const dct420 = typeof module === "object" && module.exports
    ? require("./dct420.js")
    : root.Dct420;
  const api = factory(dct420);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BpdhFormat = api;
})(typeof self !== "undefined" ? self : globalThis, function (dct420) {
  "use strict";

  const MAGIC = "BPDH";
  const MAGIC_BYTES = new Uint8Array([0x42, 0x50, 0x44, 0x48]);
  const VERSION = 1;
  const HEADER_BYTES = 48;
  const CODING_UNIT_SIZE = 16;
  const CODING_UNIT_EXPONENT = 4;
  const MODE_BPAL = 0;
  const MODE_DCT = 1;
  const FLAG_BPAL = 1;
  const FLAG_DCT = 2;
  const QUANTIZATION_TABLE_BYTES = 128;
  const ZIG_ZAG = [
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
  ];

  function encodeBpdhFile(image) {
    const metadata = validateImage(image);
    const layout = calculateLayout(metadata);
    const bytes = new Uint8Array(layout.totalBytes);
    const view = new DataView(bytes.buffer);

    bytes.set(MAGIC_BYTES, 0);
    bytes[4] = VERSION;
    bytes[5] = layout.flags;
    bytes[6] = CODING_UNIT_EXPONENT;
    bytes[7] = 0;
    view.setUint32(8, metadata.width, true);
    view.setUint32(12, metadata.height, true);
    bytes[16] = metadata.localIndexBits;
    bytes[17] = metadata.globalIndexBits;
    bytes[18] = metadata.paletteIndexBits;
    bytes[19] = metadata.paletteColorBits;
    view.setUint32(20, layout.paletteBytes, true);
    view.setUint32(24, layout.modeMapBytes, true);
    view.setUint32(28, layout.bpalBytes, true);
    view.setUint32(32, layout.bpalBits, true);
    view.setUint32(36, layout.quantizationTableBytes, true);
    view.setUint32(40, layout.dctBytes, true);
    view.setUint32(44, layout.dctBits, true);

    writePalette(bytes, layout.paletteOffset, metadata, layout);
    writeQuantizationTables(bytes, layout.quantizationTableOffset, metadata, layout);
    writeModeMap(bytes, layout.modeMapOffset, metadata, layout);
    writeBpalPayload(bytes, layout.bpalOffset, metadata, layout);
    writeDctPayload(bytes, layout.dctOffset, metadata, layout);

    return bytes;
  }

  function decodeBpdhFile(input) {
    const bytes = asUint8Array(input);

    if (bytes.length < HEADER_BYTES) {
      throw new RangeError("BPDH file is shorter than its header");
    }

    for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
      if (bytes[index] !== MAGIC_BYTES[index]) {
        throw new Error("Invalid BPDH magic");
      }
    }

    if (bytes[4] !== VERSION) {
      throw new Error(`Unsupported BPDH version: ${bytes[4]}`);
    }

    if (bytes[6] !== CODING_UNIT_EXPONENT || bytes[7] !== 0) {
      throw new Error("Unsupported BPDH coding-unit metadata");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = bytes[5];
    const hasBpal = (flags & FLAG_BPAL) !== 0;
    const hasDct = (flags & FLAG_DCT) !== 0;

    if ((flags & ~(FLAG_BPAL | FLAG_DCT)) !== 0 || (!hasBpal && !hasDct)) {
      throw new Error("Invalid BPDH mode flags");
    }

    const width = view.getUint32(8, true);
    const height = view.getUint32(12, true);
    const localIndexBits = bytes[16];
    const globalIndexBits = bytes[17];
    const paletteIndexBits = bytes[18];
    const paletteColorBits = bytes[19];

    validateDecodedMetadata(
      width,
      height,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      paletteColorBits
    );

    const localColorCount = 2 ** localIndexBits;
    const globalColorCount = 2 ** globalIndexBits;
    const paletteCount = 2 ** paletteIndexBits;
    const blocksX = Math.ceil(width / CODING_UNIT_SIZE);
    const blocksY = Math.ceil(height / CODING_UNIT_SIZE);
    const blockCount = blocksX * blocksY;
    const declared = {
      paletteBytes: view.getUint32(20, true),
      modeMapBytes: view.getUint32(24, true),
      bpalBytes: view.getUint32(28, true),
      bpalBits: view.getUint32(32, true),
      quantizationTableBytes: view.getUint32(36, true),
      dctBytes: view.getUint32(40, true),
      dctBits: view.getUint32(44, true),
    };
    const sectionBytes = declared.paletteBytes + declared.quantizationTableBytes +
      declared.modeMapBytes + declared.bpalBytes + declared.dctBytes;

    if (HEADER_BYTES + sectionBytes !== bytes.length) {
      throw new RangeError("BPDH file size does not match its section lengths");
    }

    const offsets = calculateSectionOffsets(declared);
    const modes = readModes(
      bytes,
      offsets.modeMapOffset,
      declared.modeMapBytes,
      blockCount,
      hasBpal,
      hasDct
    );
    const bpalBlockCount = countMode(modes, MODE_BPAL);
    const dctBlockCount = blockCount - bpalBlockCount;

    if ((hasBpal && bpalBlockCount === 0) || (hasDct && dctBlockCount === 0)) {
      throw new Error("BPDH mode flags do not match the mode map");
    }

    const expectedPaletteBytes = hasBpal
      ? paletteCount * globalColorCount * paletteColorBits / 8
      : 0;
    const expectedModeMapBytes = hasBpal && hasDct ? Math.ceil(blockCount / 8) : 0;
    const expectedQuantizationTableBytes = hasDct ? QUANTIZATION_TABLE_BYTES : 0;
    const expectedBpalBits = calculateBpalBits({
      width,
      height,
      blocksX,
      modes,
      localColorCount,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
    });

    if (
      declared.paletteBytes !== expectedPaletteBytes ||
      declared.modeMapBytes !== expectedModeMapBytes ||
      declared.quantizationTableBytes !== expectedQuantizationTableBytes ||
      declared.bpalBits !== expectedBpalBits ||
      declared.bpalBytes !== Math.ceil(expectedBpalBits / 8) ||
      declared.dctBytes !== Math.ceil(declared.dctBits / 8)
    ) {
      throw new RangeError("BPDH section layout is inconsistent with its metadata");
    }

    const palette = readPalette(
      bytes,
      offsets.paletteOffset,
      hasBpal ? paletteCount * globalColorCount : 0,
      paletteColorBits
    );
    const quantizationTables = readQuantizationTables(
      bytes,
      offsets.quantizationTableOffset,
      hasDct
    );
    const blockPaletteSelectors = new Uint8Array(blockCount);
    const blockPaletteIndices = new Uint16Array(blockCount * localColorCount);
    const pixelIndices = new Uint8Array(width * height);

    readBpalPayload(
      bytes,
      offsets.bpalOffset,
      declared.bpalBits,
      {
        width,
        height,
        blocksX,
        blocksY,
        modes,
        localColorCount,
        localIndexBits,
        globalColorCount,
        globalIndexBits,
        paletteCount,
        paletteIndexBits,
        blockPaletteSelectors,
        blockPaletteIndices,
        pixelIndices,
      }
    );

    const dctBlocks = readDctPayload(
      bytes,
      offsets.dctOffset,
      declared.dctBits,
      modes
    );
    const pixels = reconstructPixels({
      width,
      height,
      blocksX,
      blocksY,
      modes,
      localColorCount,
      globalColorCount,
      palette,
      blockPaletteSelectors,
      blockPaletteIndices,
      pixelIndices,
      quantizationTables,
      dctBlocks,
    });
    const layout = createLayoutResult({
      ...declared,
      ...offsets,
      flags,
      blockCount,
      bpalBlockCount,
      dctBlockCount,
      width,
      height,
    });

    return {
      magic: MAGIC,
      version: VERSION,
      width,
      height,
      codingUnitSize: CODING_UNIT_SIZE,
      blocksX,
      blocksY,
      blockCount,
      modes,
      bpalBlockCount,
      dctBlockCount,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      palette,
      blockPaletteSelectors,
      blockPaletteIndices,
      pixelIndices,
      quantizationTables,
      dctBlocks,
      pixels,
      storage: layout,
    };
  }

  function getBpdhFileLayout(image) {
    return calculateLayout(validateImage(image));
  }

  function isBpdhFile(input) {
    try {
      const bytes = asUint8Array(input);

      return bytes.length >= MAGIC_BYTES.length && MAGIC_BYTES.every(
        (value, index) => bytes[index] === value
      );
    } catch (error) {
      return false;
    }
  }

  function sampleBpdhPixel(image, x, y) {
    if (!image || typeof image !== "object") {
      throw new TypeError("BPDH sampler requires a decoded image");
    }

    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) {
      throw new RangeError("BPDH sample coordinates are outside the image");
    }

    const blocksX = image.blocksX || Math.ceil(image.width / CODING_UNIT_SIZE);
    const blockX = Math.floor(x / CODING_UNIT_SIZE);
    const blockY = Math.floor(y / CODING_UNIT_SIZE);
    const blockIndex = blockY * blocksX + blockX;

    if (image.modes[blockIndex] === MODE_DCT) {
      const blockPixels = dct420.decodeMacroblock(
        image.dctBlocks[blockIndex],
        image.quantizationTables
      );
      const localX = x % CODING_UNIT_SIZE;
      const localY = y % CODING_UNIT_SIZE;
      const offset = (localY * CODING_UNIT_SIZE + localX) * 4;

      return {
        r: blockPixels[offset],
        g: blockPixels[offset + 1],
        b: blockPixels[offset + 2],
        a: 255,
      };
    }

    const localColorCount = image.localColorCount;
    const globalColorCount = image.globalColorCount;
    const localIndex = image.pixelIndices[y * image.width + x];
    const globalIndex = image.blockPaletteIndices[blockIndex * localColorCount + localIndex];
    const paletteBase = image.blockPaletteSelectors[blockIndex] * globalColorCount;
    const color = image.palette[paletteBase + globalIndex];

    return { r: color.r, g: color.g, b: color.b, a: 255 };
  }

  function calculateLayout(metadata) {
    const bpalBlockCount = countMode(metadata.modes, MODE_BPAL);
    const dctBlockCount = metadata.blockCount - bpalBlockCount;
    const hasBpal = bpalBlockCount > 0;
    const hasDct = dctBlockCount > 0;
    const flags = (hasBpal ? FLAG_BPAL : 0) | (hasDct ? FLAG_DCT : 0);
    const paletteBytes = hasBpal
      ? metadata.paletteCount * metadata.globalColorCount * metadata.paletteColorBits / 8
      : 0;
    const quantizationTableBytes = hasDct ? QUANTIZATION_TABLE_BYTES : 0;
    const modeMapBytes = hasBpal && hasDct ? Math.ceil(metadata.blockCount / 8) : 0;
    const bpalBits = calculateBpalBits(metadata);
    const bpalBytes = Math.ceil(bpalBits / 8);
    let dctBits = 0;

    for (let blockIndex = 0; blockIndex < metadata.blockCount; blockIndex += 1) {
      if (metadata.modes[blockIndex] === MODE_DCT) {
        dctBits += getDctMacroblockBitLength(metadata.dctBlocks[blockIndex]);
      }
    }

    const dctBytes = Math.ceil(dctBits / 8);
    const declared = {
      paletteBytes,
      modeMapBytes,
      bpalBytes,
      bpalBits,
      quantizationTableBytes,
      dctBytes,
      dctBits,
    };
    const offsets = calculateSectionOffsets(declared);

    validateUint32Fields(declared);

    return createLayoutResult({
      ...declared,
      ...offsets,
      flags,
      blockCount: metadata.blockCount,
      bpalBlockCount,
      dctBlockCount,
      width: metadata.width,
      height: metadata.height,
    });
  }

  function createLayoutResult(layout) {
    const totalBytes = layout.dctOffset + layout.dctBytes;
    const payloadBytes = totalBytes - HEADER_BYTES;
    const meaningfulPayloadBits = layout.paletteBytes * 8 +
      layout.quantizationTableBytes * 8 +
      (layout.bpalBlockCount > 0 && layout.dctBlockCount > 0 ? layout.blockCount : 0) +
      layout.bpalBits + layout.dctBits;

    return {
      headerBytes: HEADER_BYTES,
      flags: layout.flags,
      paletteOffset: layout.paletteOffset,
      paletteBytes: layout.paletteBytes,
      quantizationTableOffset: layout.quantizationTableOffset,
      quantizationTableBytes: layout.quantizationTableBytes,
      modeMapOffset: layout.modeMapOffset,
      modeMapBytes: layout.modeMapBytes,
      bpalOffset: layout.bpalOffset,
      bpalBits: layout.bpalBits,
      bpalBytes: layout.bpalBytes,
      dctOffset: layout.dctOffset,
      dctBits: layout.dctBits,
      dctBytes: layout.dctBytes,
      blockCount: layout.blockCount,
      bpalBlockCount: layout.bpalBlockCount,
      dctBlockCount: layout.dctBlockCount,
      meaningfulPayloadBits,
      payloadBytes,
      payloadBits: payloadBytes * 8,
      paddingBits: payloadBytes * 8 - meaningfulPayloadBits,
      totalBytes,
      bitsPerPixel: payloadBytes * 8 / (layout.width * layout.height),
      fileBitsPerPixel: totalBytes * 8 / (layout.width * layout.height),
    };
  }

  function calculateSectionOffsets(layout) {
    const paletteOffset = HEADER_BYTES;
    const quantizationTableOffset = paletteOffset + layout.paletteBytes;
    const modeMapOffset = quantizationTableOffset + layout.quantizationTableBytes;
    const bpalOffset = modeMapOffset + layout.modeMapBytes;
    const dctOffset = bpalOffset + layout.bpalBytes;

    return {
      paletteOffset,
      quantizationTableOffset,
      modeMapOffset,
      bpalOffset,
      dctOffset,
    };
  }

  function calculateBpalBits(metadata) {
    let bits = 0;

    for (let blockIndex = 0; blockIndex < metadata.modes.length; blockIndex += 1) {
      if (metadata.modes[blockIndex] !== MODE_BPAL) {
        continue;
      }

      const blockX = blockIndex % metadata.blocksX;
      const blockY = Math.floor(blockIndex / metadata.blocksX);
      const pixelCount = blockPixelCount(metadata.width, metadata.height, blockX, blockY);

      bits += metadata.paletteIndexBits;
      bits += metadata.localColorCount * metadata.globalIndexBits;
      bits += pixelCount * metadata.localIndexBits;
    }

    return bits;
  }

  function getDctMacroblockBitLength(blocks) {
    validateDctMacroblock(blocks);

    let bits = 0;

    for (const block of blocks) {
      bits += signedExpGolombBitLength(block[0]);
      let runLength = 0;

      for (let zigZagIndex = 1; zigZagIndex < 64; zigZagIndex += 1) {
        const value = block[ZIG_ZAG[zigZagIndex]];

        if (value === 0) {
          runLength += 1;
          continue;
        }

        bits += 1 + unsignedExpGolombBitLength(runLength) + signedExpGolombBitLength(value);
        runLength = 0;
      }

      bits += 1;
    }

    return bits;
  }

  function writePalette(bytes, offset, metadata, layout) {
    if (layout.paletteBytes === 0) {
      return;
    }

    let cursor = offset;

    for (const color of metadata.palette) {
      if (metadata.paletteColorBits === 16) {
        const packed = packRgb565(color);

        bytes[cursor] = packed >> 8;
        bytes[cursor + 1] = packed & 255;
        cursor += 2;
      } else {
        bytes[cursor] = color.r;
        bytes[cursor + 1] = color.g;
        bytes[cursor + 2] = color.b;
        cursor += 3;
      }
    }
  }

  function writeQuantizationTables(bytes, offset, metadata, layout) {
    if (layout.quantizationTableBytes === 0) {
      return;
    }

    bytes.set(metadata.quantizationTables.luma, offset);
    bytes.set(metadata.quantizationTables.chroma, offset + 64);
  }

  function writeModeMap(bytes, offset, metadata, layout) {
    if (layout.modeMapBytes === 0) {
      return;
    }

    for (let blockIndex = 0; blockIndex < metadata.blockCount; blockIndex += 1) {
      bytes[offset + Math.floor(blockIndex / 8)] |=
        metadata.modes[blockIndex] << (7 - blockIndex % 8);
    }
  }

  function writeBpalPayload(bytes, offset, metadata, layout) {
    if (layout.bpalBits === 0) {
      return;
    }

    const payload = new Uint8Array(layout.bpalBytes);
    const writer = new BitWriter(payload);

    for (let blockIndex = 0; blockIndex < metadata.blockCount; blockIndex += 1) {
      if (metadata.modes[blockIndex] !== MODE_BPAL) {
        continue;
      }

      writer.write(metadata.blockPaletteSelectors[blockIndex], metadata.paletteIndexBits);

      const blockPaletteOffset = blockIndex * metadata.localColorCount;

      for (let localIndex = 0; localIndex < metadata.localColorCount; localIndex += 1) {
        writer.write(
          metadata.blockPaletteIndices[blockPaletteOffset + localIndex],
          metadata.globalIndexBits
        );
      }

      const blockX = blockIndex % metadata.blocksX;
      const blockY = Math.floor(blockIndex / metadata.blocksX);
      const startX = blockX * CODING_UNIT_SIZE;
      const startY = blockY * CODING_UNIT_SIZE;
      const endX = Math.min(startX + CODING_UNIT_SIZE, metadata.width);
      const endY = Math.min(startY + CODING_UNIT_SIZE, metadata.height);

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          writer.write(metadata.pixelIndices[y * metadata.width + x], metadata.localIndexBits);
        }
      }
    }

    if (writer.offset !== layout.bpalBits) {
      throw new Error("BPDH BPAL writer produced an unexpected bit length");
    }

    bytes.set(payload, offset);
  }

  function writeDctPayload(bytes, offset, metadata, layout) {
    if (layout.dctBits === 0) {
      return;
    }

    const payload = new Uint8Array(layout.dctBytes);
    const writer = new BitWriter(payload);

    for (let blockIndex = 0; blockIndex < metadata.blockCount; blockIndex += 1) {
      if (metadata.modes[blockIndex] === MODE_DCT) {
        writeDctMacroblock(writer, metadata.dctBlocks[blockIndex]);
      }
    }

    if (writer.offset !== layout.dctBits) {
      throw new Error("BPDH DCT writer produced an unexpected bit length");
    }

    bytes.set(payload, offset);
  }

  function writeDctMacroblock(writer, blocks) {
    for (const block of blocks) {
      writeSignedExpGolomb(writer, block[0]);
      let runLength = 0;

      for (let zigZagIndex = 1; zigZagIndex < 64; zigZagIndex += 1) {
        const value = block[ZIG_ZAG[zigZagIndex]];

        if (value === 0) {
          runLength += 1;
          continue;
        }

        writer.writeBit(0);
        writeUnsignedExpGolomb(writer, runLength);
        writeSignedExpGolomb(writer, value);
        runLength = 0;
      }

      writer.writeBit(1);
    }
  }

  function readPalette(bytes, offset, colorCount, paletteColorBits) {
    const palette = [];
    let cursor = offset;

    for (let index = 0; index < colorCount; index += 1) {
      if (paletteColorBits === 16) {
        palette.push(unpackRgb565(bytes[cursor] << 8 | bytes[cursor + 1]));
        cursor += 2;
      } else {
        palette.push({
          r: bytes[cursor],
          g: bytes[cursor + 1],
          b: bytes[cursor + 2],
        });
        cursor += 3;
      }
    }

    return palette;
  }

  function readQuantizationTables(bytes, offset, hasDct) {
    if (!hasDct) {
      return null;
    }

    return {
      luma: bytes.slice(offset, offset + 64),
      chroma: bytes.slice(offset + 64, offset + 128),
    };
  }

  function readModes(bytes, offset, byteLength, blockCount, hasBpal, hasDct) {
    const modes = new Uint8Array(blockCount);

    if (hasBpal && hasDct) {
      if (byteLength !== Math.ceil(blockCount / 8)) {
        throw new RangeError("BPDH mode-map length is invalid");
      }

      for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
        modes[blockIndex] = bytes[offset + Math.floor(blockIndex / 8)] >>
          (7 - blockIndex % 8) & 1;
      }
    } else if (hasDct) {
      modes.fill(MODE_DCT);
    }

    return modes;
  }

  function readBpalPayload(bytes, offset, bitLength, metadata) {
    if (bitLength === 0) {
      return;
    }

    const reader = new BitReader(bytes.subarray(offset, offset + Math.ceil(bitLength / 8)), bitLength);

    for (let blockIndex = 0; blockIndex < metadata.modes.length; blockIndex += 1) {
      if (metadata.modes[blockIndex] !== MODE_BPAL) {
        continue;
      }

      metadata.blockPaletteSelectors[blockIndex] = reader.read(metadata.paletteIndexBits);

      if (metadata.blockPaletteSelectors[blockIndex] >= metadata.paletteCount) {
        throw new RangeError("BPDH BPAL selector is outside the shared palettes");
      }

      const blockPaletteOffset = blockIndex * metadata.localColorCount;

      for (let localIndex = 0; localIndex < metadata.localColorCount; localIndex += 1) {
        const globalIndex = reader.read(metadata.globalIndexBits);

        if (globalIndex >= metadata.globalColorCount) {
          throw new RangeError("BPDH BPAL index is outside the shared palette");
        }

        metadata.blockPaletteIndices[blockPaletteOffset + localIndex] = globalIndex;
      }

      const blockX = blockIndex % metadata.blocksX;
      const blockY = Math.floor(blockIndex / metadata.blocksX);
      const startX = blockX * CODING_UNIT_SIZE;
      const startY = blockY * CODING_UNIT_SIZE;
      const endX = Math.min(startX + CODING_UNIT_SIZE, metadata.width);
      const endY = Math.min(startY + CODING_UNIT_SIZE, metadata.height);

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const localIndex = reader.read(metadata.localIndexBits);

          if (localIndex >= metadata.localColorCount) {
            throw new RangeError("BPDH pixel index is outside its local palette");
          }

          metadata.pixelIndices[y * metadata.width + x] = localIndex;
        }
      }
    }

    if (reader.offset !== bitLength) {
      throw new RangeError("BPDH BPAL payload has trailing or missing bits");
    }
  }

  function readDctPayload(bytes, offset, bitLength, modes) {
    const dctBlocks = Array(modes.length).fill(null);

    if (bitLength === 0) {
      return dctBlocks;
    }

    const reader = new BitReader(bytes.subarray(offset, offset + Math.ceil(bitLength / 8)), bitLength);

    for (let blockIndex = 0; blockIndex < modes.length; blockIndex += 1) {
      if (modes[blockIndex] === MODE_DCT) {
        dctBlocks[blockIndex] = readDctMacroblock(reader);
      }
    }

    if (reader.offset !== bitLength) {
      throw new RangeError("BPDH DCT payload has trailing or missing bits");
    }

    return dctBlocks;
  }

  function readDctMacroblock(reader) {
    const blocks = [];

    for (let blockIndex = 0; blockIndex < dct420.BLOCKS_PER_MACROBLOCK; blockIndex += 1) {
      const block = new Int16Array(64);
      const dc = readSignedExpGolomb(reader);

      if (dc < -32768 || dc > 32767) {
        throw new RangeError("BPDH DCT DC coefficient is invalid");
      }

      block[0] = dc;

      let zigZagIndex = 1;

      while (true) {
        const endOfBlock = reader.readBit();

        if (endOfBlock === 1) {
          break;
        }

        const runLength = readUnsignedExpGolomb(reader);

        zigZagIndex += runLength;

        if (zigZagIndex >= 64) {
          throw new RangeError("BPDH DCT zero run exceeds its block");
        }

        const value = readSignedExpGolomb(reader);

        if (value === 0 || value < -32768 || value > 32767) {
          throw new RangeError("BPDH DCT AC coefficient is invalid");
        }

        block[ZIG_ZAG[zigZagIndex]] = value;
        zigZagIndex += 1;
      }

      blocks.push(block);
    }

    return blocks;
  }

  function reconstructPixels(metadata) {
    const pixels = new Uint8ClampedArray(metadata.width * metadata.height * 4);

    for (let blockIndex = 0; blockIndex < metadata.modes.length; blockIndex += 1) {
      const blockX = blockIndex % metadata.blocksX;
      const blockY = Math.floor(blockIndex / metadata.blocksX);
      const startX = blockX * CODING_UNIT_SIZE;
      const startY = blockY * CODING_UNIT_SIZE;
      const endX = Math.min(startX + CODING_UNIT_SIZE, metadata.width);
      const endY = Math.min(startY + CODING_UNIT_SIZE, metadata.height);

      if (metadata.modes[blockIndex] === MODE_DCT) {
        const blockPixels = dct420.decodeMacroblock(
          metadata.dctBlocks[blockIndex],
          metadata.quantizationTables
        );

        for (let y = startY; y < endY; y += 1) {
          for (let x = startX; x < endX; x += 1) {
            const targetOffset = (y * metadata.width + x) * 4;
            const sourceOffset = ((y - startY) * CODING_UNIT_SIZE + x - startX) * 4;

            pixels.set(blockPixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
          }
        }

        continue;
      }

      const paletteBase = metadata.blockPaletteSelectors[blockIndex] * metadata.globalColorCount;
      const blockPaletteOffset = blockIndex * metadata.localColorCount;

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const pixelIndex = y * metadata.width + x;
          const localIndex = metadata.pixelIndices[pixelIndex];
          const globalIndex = metadata.blockPaletteIndices[blockPaletteOffset + localIndex];
          const color = metadata.palette[paletteBase + globalIndex];
          const outputOffset = pixelIndex * 4;

          pixels[outputOffset] = color.r;
          pixels[outputOffset + 1] = color.g;
          pixels[outputOffset + 2] = color.b;
          pixels[outputOffset + 3] = 255;
        }
      }
    }

    return pixels;
  }

  function validateImage(image) {
    if (!image || typeof image !== "object") {
      throw new TypeError("BPDH image must be an object");
    }

    const width = Number(image.width);
    const height = Number(image.height);
    const localColorCount = Number(image.localColorCount);
    const globalColorCount = Number(image.globalColorCount);
    const paletteCount = Number(image.paletteCount);
    const paletteColorBits = Number(image.paletteColorBits);

    if (!Number.isInteger(width) || width < 1 || width > 0xffffffff) {
      throw new RangeError("BPDH width must be a positive uint32");
    }

    if (!Number.isInteger(height) || height < 1 || height > 0xffffffff) {
      throw new RangeError("BPDH height must be a positive uint32");
    }

    validatePowerOfTwo(localColorCount, 2, 256, "localColorCount");
    validatePowerOfTwo(globalColorCount, 2, 4096, "globalColorCount");
    validatePowerOfTwo(paletteCount, 1, 128, "paletteCount");

    if (paletteColorBits !== 16 && paletteColorBits !== 24) {
      throw new RangeError("BPDH paletteColorBits must be 16 or 24");
    }

    const blocksX = Math.ceil(width / CODING_UNIT_SIZE);
    const blocksY = Math.ceil(height / CODING_UNIT_SIZE);
    const blockCount = blocksX * blocksY;

    if (!(image.modes instanceof Uint8Array) || image.modes.length !== blockCount) {
      throw new TypeError("BPDH modes must contain one byte per coding unit");
    }

    for (const mode of image.modes) {
      if (mode !== MODE_BPAL && mode !== MODE_DCT) {
        throw new RangeError("BPDH mode must select BPAL or DCT");
      }
    }

    const localIndexBits = Math.log2(localColorCount);
    const globalIndexBits = Math.log2(globalColorCount);
    const paletteIndexBits = Math.log2(paletteCount);
    const bpalBlockCount = countMode(image.modes, MODE_BPAL);
    const dctBlockCount = blockCount - bpalBlockCount;

    if (bpalBlockCount > 0) {
      const storedColorCount = paletteCount * globalColorCount;

      if (!Array.isArray(image.palette) || image.palette.length !== storedColorCount) {
        throw new RangeError("BPDH palette length does not match its metadata");
      }

      image.palette.forEach(validateColor);
      validateIndexArray(image.blockPaletteSelectors, blockCount, paletteCount, "blockPaletteSelectors");
      validateIndexArray(
        image.blockPaletteIndices,
        blockCount * localColorCount,
        globalColorCount,
        "blockPaletteIndices"
      );
      validateIndexArray(image.pixelIndices, width * height, localColorCount, "pixelIndices");
    }

    if (dctBlockCount > 0) {
      validateQuantizationTables(image.quantizationTables);

      if (!Array.isArray(image.dctBlocks) || image.dctBlocks.length !== blockCount) {
        throw new TypeError("BPDH dctBlocks must contain one slot per coding unit");
      }

      for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
        if (image.modes[blockIndex] === MODE_DCT) {
          validateDctMacroblock(image.dctBlocks[blockIndex]);
        }
      }
    }

    return {
      width,
      height,
      codingUnitSize: CODING_UNIT_SIZE,
      blocksX,
      blocksY,
      blockCount,
      modes: image.modes,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      palette: image.palette || [],
      blockPaletteSelectors: image.blockPaletteSelectors || new Uint8Array(blockCount),
      blockPaletteIndices: image.blockPaletteIndices || new Uint16Array(blockCount * localColorCount),
      pixelIndices: image.pixelIndices || new Uint8Array(width * height),
      quantizationTables: image.quantizationTables || null,
      dctBlocks: image.dctBlocks || Array(blockCount).fill(null),
    };
  }

  function validateDecodedMetadata(
    width,
    height,
    localIndexBits,
    globalIndexBits,
    paletteIndexBits,
    paletteColorBits
  ) {
    if (width < 1 || height < 1) {
      throw new RangeError("BPDH dimensions must be positive");
    }

    if (localIndexBits < 1 || localIndexBits > 8) {
      throw new RangeError("BPDH local index width is invalid");
    }

    if (globalIndexBits < 1 || globalIndexBits > 12) {
      throw new RangeError("BPDH global index width is invalid");
    }

    if (paletteIndexBits > 7) {
      throw new RangeError("BPDH palette index width is invalid");
    }

    if (paletteColorBits !== 16 && paletteColorBits !== 24) {
      throw new RangeError("BPDH palette color width is invalid");
    }
  }

  function validateDctMacroblock(blocks) {
    if (!Array.isArray(blocks) || blocks.length !== dct420.BLOCKS_PER_MACROBLOCK) {
      throw new TypeError("BPDH DCT macroblock must contain six blocks");
    }

    for (const block of blocks) {
      if (!(block instanceof Int16Array) || block.length !== 64) {
        throw new TypeError("BPDH DCT blocks must contain 64 signed coefficients");
      }
    }
  }

  function validateQuantizationTables(tables) {
    if (
      !tables ||
      !(tables.luma instanceof Uint8Array) || tables.luma.length !== 64 ||
      !(tables.chroma instanceof Uint8Array) || tables.chroma.length !== 64
    ) {
      throw new TypeError("BPDH requires 64-byte luma and chroma quantization tables");
    }

    for (const table of [tables.luma, tables.chroma]) {
      for (const value of table) {
        if (value === 0) {
          throw new RangeError("BPDH quantization table entries must be nonzero");
        }
      }
    }
  }

  function validateIndexArray(values, expectedLength, limit, name) {
    if (!values || typeof values.length !== "number" || values.length !== expectedLength) {
      throw new RangeError(`BPDH ${name} length is invalid`);
    }

    for (const value of values) {
      if (!Number.isInteger(value) || value < 0 || value >= limit) {
        throw new RangeError(`BPDH ${name} contains an invalid index`);
      }
    }
  }

  function validateColor(color) {
    if (!color || !isByte(color.r) || !isByte(color.g) || !isByte(color.b)) {
      throw new TypeError("BPDH palette colors must contain byte RGB values");
    }
  }

  function validatePowerOfTwo(value, minimum, maximum, name) {
    if (!Number.isInteger(value) || value < minimum || value > maximum || !isPowerOfTwo(value)) {
      throw new RangeError(`BPDH ${name} must be a power of two from ${minimum} to ${maximum}`);
    }
  }

  function validateUint32Fields(layout) {
    for (const [name, value] of Object.entries(layout)) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`BPDH ${name} exceeds the uint32 header field`);
      }
    }
  }

  function blockPixelCount(width, height, blockX, blockY) {
    return Math.max(0, Math.min(CODING_UNIT_SIZE, width - blockX * CODING_UNIT_SIZE)) *
      Math.max(0, Math.min(CODING_UNIT_SIZE, height - blockY * CODING_UNIT_SIZE));
  }

  function countMode(modes, requestedMode) {
    let count = 0;

    for (const mode of modes) {
      if (mode === requestedMode) {
        count += 1;
      }
    }

    return count;
  }

  function unsignedExpGolombBitLength(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Exp-Golomb values must be nonnegative safe integers");
    }

    return 2 * Math.floor(Math.log2(value + 1)) + 1;
  }

  function signedExpGolombBitLength(value) {
    return unsignedExpGolombBitLength(signedToUnsigned(value));
  }

  function writeUnsignedExpGolomb(writer, value) {
    const encoded = value + 1;
    const leadingZeroBits = Math.floor(Math.log2(encoded));

    writer.write(0, leadingZeroBits);
    writer.write(encoded, leadingZeroBits + 1);
  }

  function writeSignedExpGolomb(writer, value) {
    writeUnsignedExpGolomb(writer, signedToUnsigned(value));
  }

  function readUnsignedExpGolomb(reader) {
    let leadingZeroBits = 0;

    while (reader.readBit() === 0) {
      leadingZeroBits += 1;

      if (leadingZeroBits > 52) {
        throw new RangeError("BPDH Exp-Golomb value is too large");
      }
    }

    const suffix = reader.read(leadingZeroBits);
    return 2 ** leadingZeroBits + suffix - 1;
  }

  function readSignedExpGolomb(reader) {
    const value = readUnsignedExpGolomb(reader);

    return value % 2 === 1 ? (value + 1) / 2 : -value / 2;
  }

  function signedToUnsigned(value) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Signed Exp-Golomb values must be safe integers");
    }

    return value > 0 ? value * 2 - 1 : -value * 2;
  }

  function packRgb565(color) {
    const red = Math.round(color.r * 31 / 255);
    const green = Math.round(color.g * 63 / 255);
    const blue = Math.round(color.b * 31 / 255);

    return red << 11 | green << 5 | blue;
  }

  function unpackRgb565(value) {
    return {
      r: Math.round((value >> 11 & 31) * 255 / 31),
      g: Math.round((value >> 5 & 63) * 255 / 63),
      b: Math.round((value & 31) * 255 / 31),
    };
  }

  function asUint8Array(input) {
    if (input instanceof Uint8Array) {
      return input;
    }

    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }

    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    throw new TypeError("BPDH input must be an ArrayBuffer or byte array");
  }

  function isPowerOfTwo(value) {
    return value > 0 && (value & value - 1) === 0;
  }

  function isByte(value) {
    return Number.isInteger(value) && value >= 0 && value <= 255;
  }

  class BitWriter {
    constructor(bytes) {
      this.bytes = bytes;
      this.offset = 0;
    }

    writeBit(value) {
      if (this.offset >= this.bytes.length * 8) {
        throw new RangeError("BPDH bit writer exceeded its output buffer");
      }

      if (value) {
        this.bytes[Math.floor(this.offset / 8)] |= 1 << (7 - this.offset % 8);
      }

      this.offset += 1;
    }

    write(value, bitCount) {
      if (!Number.isSafeInteger(value) || value < 0 || !Number.isInteger(bitCount) || bitCount < 0) {
        throw new RangeError("BPDH bit writer received an invalid value");
      }

      if (bitCount === 0) {
        if (value !== 0) {
          throw new RangeError("BPDH cannot write a nonzero value with zero bits");
        }
        return;
      }

      if (value >= 2 ** bitCount) {
        throw new RangeError("BPDH value does not fit its bit field");
      }

      for (let bit = bitCount - 1; bit >= 0; bit -= 1) {
        this.writeBit(Math.floor(value / 2 ** bit) % 2);
      }
    }
  }

  class BitReader {
    constructor(bytes, bitLength) {
      this.bytes = bytes;
      this.bitLength = bitLength;
      this.offset = 0;
    }

    readBit() {
      if (this.offset >= this.bitLength) {
        throw new RangeError("BPDH bitstream ended unexpectedly");
      }

      const value = this.bytes[Math.floor(this.offset / 8)] >> (7 - this.offset % 8) & 1;

      this.offset += 1;
      return value;
    }

    read(bitCount) {
      if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 52) {
        throw new RangeError("BPDH bit reader received an invalid width");
      }

      let value = 0;

      for (let bit = 0; bit < bitCount; bit += 1) {
        value = value * 2 + this.readBit();
      }

      return value;
    }
  }

  return {
    MAGIC,
    VERSION,
    HEADER_BYTES,
    CODING_UNIT_SIZE,
    MODE_BPAL,
    MODE_DCT,
    encodeBpdhFile,
    decodeBpdhFile,
    isBpdhFile,
    getBpdhFileLayout,
    getDctMacroblockBitLength,
    sampleBpdhPixel,
  };
});
