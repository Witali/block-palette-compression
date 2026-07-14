(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AdaptiveBlockFormat = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MAGIC = "BPAV";
  const MAGIC_BYTES = [0x42, 0x50, 0x41, 0x56];
  const VERSION = 1;
  const HEADER_BYTES = 32;
  const TILE_SIZE = 64;
  const TILE_EXPONENT = 6;
  const BLOCK_SIZES = [4, 8, 16, 32];
  const DIRECTORY_BYTES = 4;
  const DIRECTORY_OFFSET_MASK = 0x3fffffff;
  const MAX_GPU_READS = 8;

  function encodeAdaptiveBlockFile(candidates, tileModes) {
    const metadata = validateCandidates(candidates, tileModes);
    const layout = calculateLayout(metadata, tileModes);
    const bytes = new Uint8Array(layout.totalBytes);
    const view = new DataView(bytes.buffer);

    bytes.set(MAGIC_BYTES, 0);
    view.setUint8(4, VERSION);
    view.setUint8(5, TILE_EXPONENT);
    view.setUint8(6, metadata.localIndexBits);
    view.setUint8(7, metadata.globalIndexBits);
    view.setUint8(8, metadata.paletteIndexBits);
    view.setUint8(9, metadata.paletteColorBits);
    view.setUint8(10, layout.modeMask);
    view.setUint8(11, 0);
    view.setUint32(12, metadata.width, true);
    view.setUint32(16, metadata.height, true);
    view.setUint32(20, layout.blockStreamBytes, true);
    view.setUint32(24, layout.rawBytes, true);
    view.setUint32(28, 0, true);

    const writer = new BitWriter(bytes, HEADER_BYTES * 8);

    for (const mode of layout.usedModes) {
      for (const color of candidates[mode].palette) {
        writeColor(writer, color, metadata.paletteColorBits);
      }
    }

    const directoryStart = writer.bitOffset / 8;
    const blockStreamStart = directoryStart + metadata.tileCount * DIRECTORY_BYTES;
    let blockOffset = 0;

    for (let tile = 0; tile < metadata.tileCount; tile += 1) {
      const mode = tileModes[tile];
      const directory = (mode << 30) | blockOffset;

      view.setUint32(directoryStart + tile * DIRECTORY_BYTES, directory >>> 0, true);
      writeTileBlocks(
        bytes,
        (blockStreamStart + blockOffset) * 8,
        candidates[mode],
        metadata,
        tile
      );
      blockOffset += layout.tileBlockBytes[tile];
    }

    if (blockOffset !== layout.blockStreamBytes) {
      throw new Error("Internal BPAV block-stream size mismatch");
    }

    const pixelWriter = new BitWriter(bytes, layout.pixelStreamStart * 8);

    for (let y = 0; y < metadata.height; y += 1) {
      for (let x = 0; x < metadata.width; x += 1) {
        const tile = Math.floor(y / TILE_SIZE) * metadata.tilesX + Math.floor(x / TILE_SIZE);
        const candidate = candidates[tileModes[tile]];
        const index = candidate.pixelIndices[y * metadata.width + x];

        pixelWriter.write(index, metadata.localIndexBits);
      }
    }

    if (Math.ceil(pixelWriter.bitOffset / 8) !== layout.rawBytes) {
      throw new Error("Internal BPAV pixel-stream size mismatch");
    }

    return {
      bytes,
      stats: {
        ...layout,
        maximumGpuReadsPerPixel: MAX_GPU_READS,
        deterministicLookup: true,
      },
    };
  }

  function openAdaptiveBlockFile(input) {
    const bytes = asUint8Array(input);

    if (bytes.length < HEADER_BYTES) {
      throw new RangeError("Truncated BPAV header");
    }
    for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
      if (bytes[index] !== MAGIC_BYTES[index]) {
        throw new RangeError("Invalid BPAV magic");
      }
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(4);
    const tileExponent = view.getUint8(5);
    const localIndexBits = view.getUint8(6);
    const globalIndexBits = view.getUint8(7);
    const paletteIndexBits = view.getUint8(8);
    const paletteColorBits = view.getUint8(9);
    const modeMask = view.getUint8(10);
    const flags = view.getUint8(11);
    const width = view.getUint32(12, true);
    const height = view.getUint32(16, true);
    const blockStreamBytes = view.getUint32(20, true);
    const rawBytes = view.getUint32(24, true);
    const reserved = view.getUint32(28, true);

    validateHeader({
      version,
      tileExponent,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      paletteColorBits,
      modeMask,
      flags,
      width,
      height,
      reserved,
    });

    const localColorCount = 2 ** localIndexBits;
    const globalColorCount = 2 ** globalIndexBits;
    const paletteCount = 2 ** paletteIndexBits;
    const tilesX = Math.ceil(width / TILE_SIZE);
    const tilesY = Math.ceil(height / TILE_SIZE);
    const tileCount = tilesX * tilesY;
    const usedModes = modesFromMask(modeMask);
    const paletteBytesPerMode = paletteCount * globalColorCount * paletteColorBits / 8;
    const palettesStart = HEADER_BYTES;
    const paletteSectionBytes = align4(usedModes.length * paletteBytesPerMode);
    const directoryStart = palettesStart + paletteSectionBytes;
    const blockStreamStart = directoryStart + tileCount * DIRECTORY_BYTES;
    const pixelStreamStart = blockStreamStart + blockStreamBytes;
    const pixelStreamBytes = Math.ceil(width * height * localIndexBits / 8);
    const expectedRawBytes = pixelStreamStart + pixelStreamBytes;
    const expectedBytes = align4(expectedRawBytes);

    if (rawBytes !== expectedRawBytes || bytes.length !== expectedBytes) {
      throw new RangeError("BPAV file size does not match its header");
    }
    for (let index = rawBytes; index < bytes.length; index += 1) {
      if (bytes[index] !== 0) {
        throw new RangeError("BPAV alignment padding must be zero");
      }
    }

    const modePaletteOffsets = new Uint32Array(BLOCK_SIZES.length);
    let paletteRank = 0;

    for (let mode = 0; mode < BLOCK_SIZES.length; mode += 1) {
      if ((modeMask & (1 << mode)) !== 0) {
        modePaletteOffsets[mode] = palettesStart + paletteRank * paletteBytesPerMode;
        paletteRank += 1;
      }
    }

    let expectedBlockOffset = 0;

    for (let tile = 0; tile < tileCount; tile += 1) {
      const entry = view.getUint32(directoryStart + tile * DIRECTORY_BYTES, true);
      const mode = entry >>> 30;
      const offset = entry & DIRECTORY_OFFSET_MASK;

      if ((modeMask & (1 << mode)) === 0 || offset !== expectedBlockOffset) {
        throw new RangeError("Invalid BPAV supertile directory");
      }
      expectedBlockOffset += tileBlockBytes(
        width,
        height,
        tilesX,
        tile,
        BLOCK_SIZES[mode],
        paletteIndexBits + localColorCount * globalIndexBits
      );
    }
    if (expectedBlockOffset !== blockStreamBytes) {
      throw new RangeError("BPAV block stream does not match its directory");
    }

    const layout = {
      directoryStart,
      blockStreamStart,
      pixelStreamStart,
      modePaletteOffsets,
      descriptorBits: paletteIndexBits + localColorCount * globalIndexBits,
    };

    function getPixelIndex(x, y) {
      validateCoordinate(x, width, "x");
      validateCoordinate(y, height, "y");
      return readBits(
        bytes,
        pixelStreamStart * 8 + (y * width + x) * localIndexBits,
        localIndexBits
      );
    }

    function getPixel(x, y) {
      validateCoordinate(x, width, "x");
      validateCoordinate(y, height, "y");
      return samplePixel(
        bytes,
        view,
        layout,
        x,
        y,
        width,
        height,
        tilesX,
        localColorCount,
        globalColorCount,
        paletteIndexBits,
        globalIndexBits,
        localIndexBits,
        paletteColorBits,
        readBits
      ).color;
    }

    function getPixelGpuReference(x, y) {
      validateCoordinate(x, width, "x");
      validateCoordinate(y, height, "y");
      const reads = { count: 0 };
      const result = samplePixel(
        bytes,
        view,
        layout,
        x,
        y,
        width,
        height,
        tilesX,
        localColorCount,
        globalColorCount,
        paletteIndexBits,
        globalIndexBits,
        localIndexBits,
        paletteColorBits,
        (source, bitOffset, bitCount) => readBitsGpu(source, bitOffset, bitCount, reads),
        reads
      );

      if (reads.count > MAX_GPU_READS) {
        throw new Error(`BPAV GPU reference exceeded ${MAX_GPU_READS} reads`);
      }
      return { ...result.color, reads: reads.count };
    }

    return {
      format: "bpav",
      magic: MAGIC,
      version,
      width,
      height,
      tileSize: TILE_SIZE,
      tilesX,
      tilesY,
      tileCount,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
      modeMask,
      usedBlockSizes: usedModes.map((mode) => BLOCK_SIZES[mode]),
      maximumGpuReadsPerPixel: MAX_GPU_READS,
      getPixel,
      getPixelIndex,
      getPixelGpuReference,
    };
  }

  function samplePixel(
    bytes,
    view,
    layout,
    x,
    y,
    width,
    height,
    tilesX,
    localColorCount,
    globalColorCount,
    paletteIndexBits,
    globalIndexBits,
    localIndexBits,
    paletteColorBits,
    packedReader,
    gpuReads
  ) {
    const tileX = Math.floor(x / TILE_SIZE);
    const tileY = Math.floor(y / TILE_SIZE);
    const tile = tileY * tilesX + tileX;
    let entry;

    if (gpuReads) {
      entry = loadU32LittleEndian(bytes, layout.directoryStart + tile * DIRECTORY_BYTES);
      gpuReads.count += 1;
    } else {
      entry = view.getUint32(layout.directoryStart + tile * DIRECTORY_BYTES, true);
    }

    const mode = entry >>> 30;
    const blockOffset = entry & DIRECTORY_OFFSET_MASK;
    const blockSize = BLOCK_SIZES[mode];
    const tileWidth = Math.min(TILE_SIZE, width - tileX * TILE_SIZE);
    const tileBlocksX = Math.ceil(tileWidth / blockSize);
    const blockX = Math.floor(x % TILE_SIZE / blockSize);
    const blockY = Math.floor(y % TILE_SIZE / blockSize);
    const block = blockY * tileBlocksX + blockX;
    const descriptorStart =
      (layout.blockStreamStart + blockOffset) * 8 + block * layout.descriptorBits;
    const localIndex = packedReader(
      bytes,
      layout.pixelStreamStart * 8 + (y * width + x) * localIndexBits,
      localIndexBits
    );
    const selector = paletteIndexBits === 0
      ? 0
      : packedReader(bytes, descriptorStart, paletteIndexBits);
    const globalIndex = packedReader(
      bytes,
      descriptorStart + paletteIndexBits + localIndex * globalIndexBits,
      globalIndexBits
    );
    const colorIndex = selector * globalColorCount + globalIndex;
    const color = readColor(
      bytes,
      layout.modePaletteOffsets[mode] * 8 + colorIndex * paletteColorBits,
      paletteColorBits,
      packedReader
    );

    return { color };
  }

  function calculateLayout(metadata, tileModes) {
    const modeMask = tileModes.reduce((mask, mode) => mask | (1 << mode), 0);
    const usedModes = modesFromMask(modeMask);
    const paletteBytesPerMode =
      metadata.paletteCount * metadata.globalColorCount * metadata.paletteColorBits / 8;
    const tileBlockBytes = new Uint32Array(metadata.tileCount);
    let blockStreamBytes = 0;

    for (let tile = 0; tile < metadata.tileCount; tile += 1) {
      const bytes = tileBlockBytesForMetadata(metadata, tile, BLOCK_SIZES[tileModes[tile]]);

      tileBlockBytes[tile] = bytes;
      blockStreamBytes += bytes;
    }
    if (blockStreamBytes > DIRECTORY_OFFSET_MASK) {
      throw new RangeError("BPAV block stream exceeds the 30-bit directory range");
    }

    const pixelStreamBytes = Math.ceil(
      metadata.width * metadata.height * metadata.localIndexBits / 8
    );
    const rawBytes =
      HEADER_BYTES +
      align4(usedModes.length * paletteBytesPerMode) +
      metadata.tileCount * DIRECTORY_BYTES +
      blockStreamBytes +
      pixelStreamBytes;

    return {
      modeMask,
      usedModes,
      paletteBytesPerMode,
      directoryBytes: metadata.tileCount * DIRECTORY_BYTES,
      tileBlockBytes,
      blockStreamBytes,
      pixelStreamBytes,
      pixelStreamStart: rawBytes - pixelStreamBytes,
      rawBytes,
      alignmentBytes: align4(rawBytes) - rawBytes,
      totalBytes: align4(rawBytes),
    };
  }

  function validateCandidates(candidates, tileModes) {
    if (!Array.isArray(candidates) || candidates.length !== BLOCK_SIZES.length) {
      throw new TypeError("BPAV candidates must contain modes B4, B8, B16, and B32");
    }
    if (!(tileModes instanceof Uint8Array) && !Array.isArray(tileModes)) {
      throw new TypeError("BPAV tileModes must be an array");
    }
    const usedModes = new Set(tileModes);
    if (usedModes.size === 0) {
      throw new RangeError("BPAV requires at least one supertile");
    }

    let reference = null;

    for (const mode of usedModes) {
      if (!Number.isInteger(mode) || mode < 0 || mode >= BLOCK_SIZES.length) {
        throw new RangeError("BPAV tile mode is out of range");
      }
      const candidate = candidates[mode];

      if (!candidate || typeof candidate !== "object") {
        throw new TypeError(`BPAV mode ${mode} is missing`);
      }
      validateCandidate(candidate, BLOCK_SIZES[mode]);
      if (reference === null) {
        reference = candidate;
      } else {
        for (const field of [
          "width",
          "height",
          "localColorCount",
          "globalColorCount",
          "paletteCount",
          "paletteColorBits",
        ]) {
          if (candidate[field] !== reference[field]) {
            throw new RangeError(`BPAV candidates disagree on ${field}`);
          }
        }
      }
    }

    const tilesX = Math.ceil(reference.width / TILE_SIZE);
    const tilesY = Math.ceil(reference.height / TILE_SIZE);
    const tileCount = tilesX * tilesY;

    if (tileModes.length !== tileCount) {
      throw new RangeError("BPAV tileModes length does not match the image dimensions");
    }

    return {
      width: reference.width,
      height: reference.height,
      localColorCount: reference.localColorCount,
      globalColorCount: reference.globalColorCount,
      paletteCount: reference.paletteCount,
      paletteColorBits: reference.paletteColorBits,
      localIndexBits: Math.log2(reference.localColorCount),
      globalIndexBits: Math.log2(reference.globalColorCount),
      paletteIndexBits: Math.log2(reference.paletteCount),
      tilesX,
      tilesY,
      tileCount,
    };
  }

  function validateCandidate(candidate, expectedBlockSize) {
    for (const field of ["width", "height", "blockSize", "localColorCount", "globalColorCount", "paletteCount"]) {
      if (!Number.isInteger(candidate[field]) || candidate[field] < 1) {
        throw new RangeError(`Invalid BPAV candidate ${field}`);
      }
    }
    if (candidate.blockSize !== expectedBlockSize) {
      throw new RangeError(`BPAV mode requires block size ${expectedBlockSize}`);
    }
    for (const field of ["localColorCount", "globalColorCount", "paletteCount"]) {
      if (!isPowerOfTwo(candidate[field])) {
        throw new RangeError(`BPAV ${field} must be a power of two`);
      }
    }
    if (candidate.localColorCount > 16 || candidate.globalColorCount > 4096 || candidate.paletteCount > 128) {
      throw new RangeError("BPAV palette settings exceed format limits");
    }
    if (candidate.localColorCount > candidate.globalColorCount ||
        candidate.localColorCount > candidate.blockSize * candidate.blockSize) {
      throw new RangeError("BPAV local palette does not fit the candidate mode");
    }
    if (candidate.paletteColorBits !== 16 && candidate.paletteColorBits !== 24) {
      throw new RangeError("BPAV palette colors must be RGB565 or RGB888");
    }

    const blocksX = Math.ceil(candidate.width / candidate.blockSize);
    const blocksY = Math.ceil(candidate.height / candidate.blockSize);
    const blockCount = blocksX * blocksY;
    const selectors = candidate.blockPaletteSelectors || new Uint8Array(blockCount);

    validateIndexArray(candidate.palette, candidate.paletteCount * candidate.globalColorCount, null, "palette");
    validateIndexArray(selectors, blockCount, candidate.paletteCount, "blockPaletteSelectors");
    validateIndexArray(
      candidate.blockPaletteIndices,
      blockCount * candidate.localColorCount,
      candidate.globalColorCount,
      "blockPaletteIndices"
    );
    validateIndexArray(
      candidate.pixelIndices,
      candidate.width * candidate.height,
      candidate.localColorCount,
      "pixelIndices"
    );
    for (const color of candidate.palette) {
      if (!color || ![color.r, color.g, color.b].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        throw new RangeError("Invalid BPAV palette color");
      }
    }
  }

  function validateHeader(header) {
    if (header.version !== VERSION) {
      throw new RangeError(`Unsupported BPAV version: ${header.version}`);
    }
    if (header.tileExponent !== TILE_EXPONENT || header.flags !== 0 || header.reserved !== 0) {
      throw new RangeError("Unsupported BPAV layout flags");
    }
    if (header.width < 1 || header.height < 1 || header.localIndexBits < 1 || header.localIndexBits > 4 ||
        header.globalIndexBits < 1 || header.globalIndexBits > 12 || header.paletteIndexBits > 7 ||
        (header.paletteColorBits !== 16 && header.paletteColorBits !== 24) ||
        header.modeMask < 1 || (header.modeMask & 0xf0) !== 0) {
      throw new RangeError("Invalid BPAV header fields");
    }
  }

  function writeTileBlocks(bytes, bitOffset, candidate, metadata, tile) {
    const writer = new BitWriter(bytes, bitOffset);
    const tileX = tile % metadata.tilesX;
    const tileY = Math.floor(tile / metadata.tilesX);
    const x = tileX * TILE_SIZE;
    const y = tileY * TILE_SIZE;
    const tileWidth = Math.min(TILE_SIZE, metadata.width - x);
    const tileHeight = Math.min(TILE_SIZE, metadata.height - y);
    const blocksX = Math.ceil(tileWidth / candidate.blockSize);
    const blocksY = Math.ceil(tileHeight / candidate.blockSize);
    const imageBlocksX = Math.ceil(metadata.width / candidate.blockSize);

    for (let blockY = 0; blockY < blocksY; blockY += 1) {
      for (let blockX = 0; blockX < blocksX; blockX += 1) {
        const imageBlockX = x / candidate.blockSize + blockX;
        const imageBlockY = y / candidate.blockSize + blockY;
        const block = imageBlockY * imageBlocksX + imageBlockX;
        const selector = candidate.blockPaletteSelectors
          ? candidate.blockPaletteSelectors[block]
          : 0;

        writer.write(selector, metadata.paletteIndexBits);
        for (let local = 0; local < metadata.localColorCount; local += 1) {
          writer.write(
            candidate.blockPaletteIndices[block * metadata.localColorCount + local],
            metadata.globalIndexBits
          );
        }
      }
    }
  }

  function tileBlockBytesForMetadata(metadata, tile, blockSize) {
    return tileBlockBytes(
      metadata.width,
      metadata.height,
      metadata.tilesX,
      tile,
      blockSize,
      metadata.paletteIndexBits + metadata.localColorCount * metadata.globalIndexBits
    );
  }

  function tileBlockBytes(width, height, tilesX, tile, blockSize, descriptorBits) {
    const tileX = tile % tilesX;
    const tileY = Math.floor(tile / tilesX);
    const tileWidth = Math.min(TILE_SIZE, width - tileX * TILE_SIZE);
    const tileHeight = Math.min(TILE_SIZE, height - tileY * TILE_SIZE);
    const blocks = Math.ceil(tileWidth / blockSize) * Math.ceil(tileHeight / blockSize);

    return Math.ceil(blocks * descriptorBits / 8);
  }

  function writeColor(writer, color, bits) {
    if (bits === 16) {
      const red = Math.round(color.r * 31 / 255);
      const green = Math.round(color.g * 63 / 255);
      const blue = Math.round(color.b * 31 / 255);

      writer.write((red << 11) | (green << 5) | blue, 16);
    } else {
      writer.write(color.r, 8);
      writer.write(color.g, 8);
      writer.write(color.b, 8);
    }
  }

  function readColor(bytes, bitOffset, bits, packedReader) {
    if (bits === 16) {
      const value = packedReader(bytes, bitOffset, 16);

      return {
        r: Math.round((value >> 11 & 31) * 255 / 31),
        g: Math.round((value >> 5 & 63) * 255 / 63),
        b: Math.round((value & 31) * 255 / 31),
        a: 255,
      };
    }
    const value = packedReader(bytes, bitOffset, 24);

    return {
      r: Math.floor(value / 0x10000),
      g: Math.floor(value / 0x100) & 255,
      b: value & 255,
      a: 255,
    };
  }

  function readBits(bytes, bitOffset, bitCount) {
    let value = 0;

    for (let bit = 0; bit < bitCount; bit += 1) {
      const offset = bitOffset + bit;
      value = value * 2 + (bytes[offset >> 3] >> (7 - (offset & 7)) & 1);
    }
    return value;
  }

  function readBitsGpu(bytes, bitOffset, bitCount, reads) {
    const wordIndex = Math.floor(bitOffset / 32);
    const bitInWord = bitOffset % 32;
    const first = loadU32BigEndian(bytes, wordIndex * 4);
    reads.count += 1;

    if (bitInWord + bitCount <= 32) {
      return unsignedExtract(first, bitInWord, bitCount);
    }

    const firstBits = 32 - bitInWord;
    const second = loadU32BigEndian(bytes, (wordIndex + 1) * 4);
    reads.count += 1;
    return unsignedExtract(first, bitInWord, firstBits) * 2 ** (bitCount - firstBits) +
      unsignedExtract(second, 0, bitCount - firstBits);
  }

  function unsignedExtract(word, bitOffset, bitCount) {
    if (bitCount === 0) {
      return 0;
    }
    const shift = 32 - bitOffset - bitCount;
    const divisor = 2 ** shift;
    return Math.floor(word / divisor) % 2 ** bitCount;
  }

  function loadU32BigEndian(bytes, byteOffset) {
    return (
      (bytes[byteOffset] || 0) * 0x1000000 +
      (bytes[byteOffset + 1] || 0) * 0x10000 +
      (bytes[byteOffset + 2] || 0) * 0x100 +
      (bytes[byteOffset + 3] || 0)
    );
  }

  function loadU32LittleEndian(bytes, byteOffset) {
    return (
      (bytes[byteOffset] || 0) +
      (bytes[byteOffset + 1] || 0) * 0x100 +
      (bytes[byteOffset + 2] || 0) * 0x10000 +
      (bytes[byteOffset + 3] || 0) * 0x1000000
    );
  }

  function validateIndexArray(values, length, limit, name) {
    if (!values || values.length !== length) {
      throw new RangeError(`BPAV ${name} length is invalid`);
    }
    if (limit !== null) {
      for (const value of values) {
        if (!Number.isInteger(value) || value < 0 || value >= limit) {
          throw new RangeError(`BPAV ${name} contains an invalid index`);
        }
      }
    }
  }

  function validateCoordinate(value, limit, name) {
    if (!Number.isInteger(value) || value < 0 || value >= limit) {
      throw new RangeError(`Invalid BPAV ${name} coordinate`);
    }
  }

  function modesFromMask(mask) {
    return BLOCK_SIZES.map((_, mode) => mode).filter((mode) => (mask & (1 << mode)) !== 0);
  }

  function isPowerOfTwo(value) {
    return value > 0 && (value & (value - 1)) === 0;
  }

  function align4(value) {
    return Math.ceil(value / 4) * 4;
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

  class BitWriter {
    constructor(bytes, bitOffset) {
      this.bytes = bytes;
      this.bitOffset = bitOffset;
    }

    write(value, bitCount) {
      if (!Number.isInteger(value) || value < 0 || value >= 2 ** bitCount) {
        throw new RangeError("BPAV bit value is out of range");
      }
      for (let shift = bitCount - 1; shift >= 0; shift -= 1) {
        const byte = this.bitOffset >> 3;
        const bit = 7 - (this.bitOffset & 7);
        this.bytes[byte] |= (value >> shift & 1) << bit;
        this.bitOffset += 1;
      }
    }
  }

  return {
    MAGIC,
    VERSION,
    HEADER_BYTES,
    TILE_SIZE,
    BLOCK_SIZES,
    MAX_GPU_READS,
    encodeAdaptiveBlockFile,
    openAdaptiveBlockFile,
  };
});
