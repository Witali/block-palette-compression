(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BlockPaletteFormat = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MAGIC = [0x42, 0x50, 0x41, 0x4c];
  const MAGIC_TEXT = "BPAL";
  const VERSION = 5;
  const MAGIC_BYTES = 4;
  const BIT_FIELD_HEADER_BITS = 80;
  const HEADER_BYTES = MAGIC_BYTES + BIT_FIELD_HEADER_BITS / 8;
  const MAX_DIMENSION = 1 << 24;
  const CHANNEL_MODE_CODES = { rgb: 0, scalar: 1 };
  const FLAG_PACKED_PALETTES = 1;
  const PACKED_PALETTE_HEADER_BYTES = 4;
  const PACKED_PALETTE_DIRECTORY_ENTRY_BYTES = 4;

  function encodeBlockPaletteFile(image) {
    const metadata = validateImage(image);
    const layout = getBlockPaletteFileLayout(metadata);
    const bytes = new Uint8Array(layout.totalBytes);

    bytes.set(MAGIC, 0);

    const writer = new BitWriter(bytes, MAGIC_BYTES * 8);

    writer.write(VERSION, 4);
    writer.write(metadata.width - 1, 24);
    writer.write(metadata.height - 1, 24);
    writer.write(metadata.blockSizeExponent - 1, 3);
    writer.write(metadata.localIndexBits - 1, 2);
    writer.write(metadata.globalIndexBits - 1, 4);
    writer.write(metadata.paletteColorBits === 24 ? 1 : 0, 1);
    writer.write(metadata.paletteMode === "vector" ? 1 : 0, 1);
    writer.write(metadata.paletteMode === "vector" ? metadata.paletteVectorCount - 1 : 0, 9);
    writer.write(metadata.vectorColorSpace === "oklab" ? 1 : 0, 1);
    writer.write(metadata.paletteIndexBits, 3);
    writer.write(CHANNEL_MODE_CODES[metadata.channelMode], 2);
    writer.write(layout.packedPalettes ? FLAG_PACKED_PALETTES : 0, 2);

    if (layout.packedPalettes) {
      writePackedPaletteSection(writer, layout.palettePacking);
    } else {
      const storedColors = metadata.paletteMode === "vector"
        ? metadata.paletteVectors.flatMap((vector) => [vector.start, vector.end])
        : metadata.palette;

      for (const color of storedColors) {
        if (metadata.channelMode === "scalar") {
          writer.write(color.r, 8);
        } else if (metadata.paletteColorBits === 16) {
          writer.write(packRgb565(color), 16);
        } else {
          writer.write(color.r, 8);
          writer.write(color.g, 8);
          writer.write(color.b, 8);
        }
      }
    }

    for (const paletteIndex of metadata.blockPaletteSelectors) {
      writer.write(paletteIndex, metadata.paletteIndexBits);
    }

    const storedBlockPaletteIndices = metadata.directPixelColors
      ? createDirectBlockPaletteIndices(metadata)
      : metadata.blockPaletteIndices;

    for (const globalIndex of storedBlockPaletteIndices) {
      writer.write(globalIndex, metadata.globalIndexBits);
    }

    if (!metadata.directPixelColors) {
      for (const localIndex of metadata.pixelIndices) {
        writer.write(localIndex, metadata.localIndexBits);
      }
    }

    return bytes;
  }

  function decodeBlockPaletteFile(input) {
    const bytes = asUint8Array(input);

    if (bytes.length < MAGIC_BYTES + 1) {
      throw new RangeError("Truncated BPAL header");
    }

    for (let index = 0; index < MAGIC.length; index += 1) {
      if (bytes[index] !== MAGIC[index]) {
        throw new RangeError("Invalid BPAL magic");
      }
    }

    const reader = new BitReader(bytes, MAGIC_BYTES * 8);
    const version = reader.read(4);

    if (version === VERSION) {
      return decodeVersion5(bytes, reader, version);
    }

    throw new RangeError(`Unsupported BPAL version: ${version}`);
  }

  function decodeVersion5(bytes, reader, version) {
    if (bytes.length < HEADER_BYTES) {
      throw new RangeError(`Truncated BPAL v${version} header`);
    }

    const width = reader.read(24) + 1;
    const height = reader.read(24) + 1;
    const blockSizeExponent = reader.read(3) + 1;
    const localIndexBits = reader.read(2) + 1;
    const globalIndexBits = reader.read(4) + 1;
    const paletteColorBits = reader.read(1) === 1 ? 24 : 16;
    const paletteMode = reader.read(1) === 1 ? "vector" : "explicit";
    const storedVectorCount = reader.read(9) + 1;
    const vectorColorSpace = reader.read(1) === 1
      ? "oklab"
      : "rgb";
    const paletteIndexBits = reader.read(3);
    const channelModeCode = reader.read(2);
    const reserved = reader.read(2);
    const channelMode = Object.keys(CHANNEL_MODE_CODES).find(
      (name) => CHANNEL_MODE_CODES[name] === channelModeCode
    );
    const paletteVectorCount = paletteMode === "vector" ? storedVectorCount : 0;
    const paletteCount = 2 ** paletteIndexBits;
    const blockSize = 2 ** blockSizeExponent;
    const localColorCount = 2 ** localIndexBits;
    const globalColorCount = 2 ** globalIndexBits;

    if ((reserved & ~FLAG_PACKED_PALETTES) !== 0) {
      throw new RangeError(`Unsupported BPAL v${version} flags`);
    }
    validateChannelMode(channelMode, paletteMode);
    const packedPalettes = (reserved & FLAG_PACKED_PALETTES) !== 0;
    if (packedPalettes && (paletteMode !== "explicit" || channelMode !== "rgb")) {
      throw new RangeError("Packed BPAL palettes require explicit RGB mode");
    }

    validateMetadata({
      width,
      height,
      blockSize,
      localColorCount,
      globalColorCount,
      paletteColorBits,
      paletteCount,
    });
    validatePaletteVectorCount(paletteMode, paletteVectorCount, globalColorCount);
    validatePaletteModeCount(paletteMode, paletteCount);

    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const blockCount = blocksX * blocksY;
    const directPixelColors = version === VERSION && localColorCount === blockSize * blockSize;
    const packedPaletteBytes = packedPalettes
      ? readUint32Be(bytes, HEADER_BYTES)
      : 0;
    const layout = calculateLayout(
      width,
      height,
      blockCount,
      localColorCount,
      globalColorCount,
      paletteColorBits,
      paletteCount,
      paletteMode,
      paletteVectorCount,
      BIT_FIELD_HEADER_BITS,
      directPixelColors,
      channelMode,
      packedPaletteBytes
    );

    if (bytes.length !== layout.totalBytes) {
      throw new RangeError("BPAL file size does not match its header");
    }

    let palette;
    let paletteVectors = [];

    if (packedPalettes) {
      palette = readPackedPaletteSection(
        bytes,
        reader,
        paletteCount,
        globalColorCount,
        paletteColorBits,
        packedPaletteBytes
      );
    } else if (paletteMode === "vector") {
      paletteVectors = new Array(paletteVectorCount);

      for (let index = 0; index < paletteVectorCount; index += 1) {
        paletteVectors[index] = {
          start: readColor(reader, paletteColorBits),
          end: readColor(reader, paletteColorBits),
        };
      }

      palette = interpolatePaletteVectors(paletteVectors, globalColorCount, vectorColorSpace);
    } else {
      palette = new Array(paletteCount * globalColorCount);

      for (let index = 0; index < palette.length; index += 1) {
        palette[index] = readStoredColor(reader, paletteColorBits, channelMode);
      }
    }

    const blockPaletteSelectors = new Uint8Array(blockCount);

    for (let index = 0; index < blockPaletteSelectors.length; index += 1) {
      blockPaletteSelectors[index] = reader.read(paletteIndexBits);
    }

    const blockPaletteIndices = new Uint16Array(blockCount * localColorCount);

    for (let index = 0; index < blockPaletteIndices.length; index += 1) {
      blockPaletteIndices[index] = reader.read(globalIndexBits);
    }

    const pixelIndices = new Uint8Array(width * height);

    if (directPixelColors) {
      fillDirectPixelIndices(pixelIndices, width, height, blockSize);
    } else {
      for (let index = 0; index < pixelIndices.length; index += 1) {
        pixelIndices[index] = reader.read(localIndexBits);
      }
    }

    const pixels = reconstructPixels(
      width,
      height,
      blockSize,
      blocksX,
      localColorCount,
      globalColorCount,
      palette,
      blockPaletteSelectors,
      blockPaletteIndices,
      pixelIndices
    );

    return {
      magic: MAGIC_TEXT,
      version,
      width,
      height,
      blockSize,
      blocksX,
      blocksY,
      blockCount,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
      channelMode,
      paletteMode,
      vectorColorSpace,
      paletteVectorCount,
      paletteVectors,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      directPixelColors,
      palette,
      blockPaletteSelectors,
      blockPaletteIndices,
      pixelIndices,
      pixels,
      storage: layout,
      packedPalettes,
    };
  }

  function getBlockPaletteFileLayout(image) {
    const blockCount = image.blockCount === undefined
      ? Math.ceil(image.width / image.blockSize) * Math.ceil(image.height / image.blockSize)
      : image.blockCount;
    const paletteCount = image.paletteCount || 1;

    const palettePacking = image.paletteMode !== "vector" &&
        (image.channelMode || "rgb") === "rgb" && Array.isArray(image.palette)
      ? createPackedPalettePlan(image.paletteCount === paletteCount
        ? image
        : { ...image, paletteCount })
      : null;
    const rawPaletteColorBits = (image.channelMode || "rgb") === "scalar"
      ? 8
      : image.paletteColorBits;
    const rawPaletteBytes = (image.paletteMode === "vector"
      ? (image.paletteVectorCount || 0) * 2
      : paletteCount * image.globalColorCount) * rawPaletteColorBits / 8;
    const selectedPacking = palettePacking && palettePacking.byteCount < rawPaletteBytes
      ? palettePacking
      : null;
    const layout = calculateLayout(
      image.width,
      image.height,
      blockCount,
      image.localColorCount,
      image.globalColorCount,
      image.paletteColorBits,
      paletteCount,
      image.paletteMode || "explicit",
      image.paletteVectorCount || 0,
      BIT_FIELD_HEADER_BITS,
      image.localColorCount === image.blockSize * image.blockSize,
      image.channelMode || "rgb",
      selectedPacking ? selectedPacking.byteCount : 0
    );
    layout.packedPalettes = Boolean(selectedPacking);
    layout.palettePacking = selectedPacking;
    return layout;
  }

  function calculateLayout(
    width,
    height,
    blockCount,
    localColorCount,
    globalColorCount,
    paletteColorBits,
    paletteCount,
    paletteMode,
    paletteVectorCount,
    bitFieldHeaderBits,
    directPixelColors,
    channelMode,
    packedPaletteBytes = 0
  ) {
    const localIndexBits = Math.log2(localColorCount);
    const globalIndexBits = Math.log2(globalColorCount);
    const paletteIndexBits = Math.log2(paletteCount);
    const storedColorCount = paletteMode === "vector"
      ? paletteVectorCount * 2
      : paletteCount * globalColorCount;
    const storedColorBits = channelMode === "scalar"
      ? 8
      : paletteColorBits;
    const globalPaletteBits = packedPaletteBytes > 0
      ? packedPaletteBytes * 8
      : storedColorCount * storedColorBits;
    const blockPaletteSelectorBits = blockCount * paletteIndexBits;
    const blockPaletteBits = blockCount * localColorCount * globalIndexBits;
    const pixelDataBits = directPixelColors ? 0 : width * height * localIndexBits;
    const payloadBits = globalPaletteBits + blockPaletteSelectorBits + blockPaletteBits + pixelDataBits;
    const payloadBytes = Math.ceil(payloadBits / 8);

    return {
      magicBytes: MAGIC_BYTES,
      bitFieldHeaderBits,
      headerBytes: MAGIC_BYTES + bitFieldHeaderBits / 8,
      globalPaletteBits,
      blockPaletteSelectorBits,
      blockPaletteBits,
      pixelDataBits,
      directPixelColors,
      payloadBits,
      payloadBytes,
      paddingBits: payloadBytes * 8 - payloadBits,
      totalBytes: MAGIC_BYTES + bitFieldHeaderBits / 8 + payloadBytes,
      packedPalettes: packedPaletteBytes > 0,
      packedPaletteBytes,
    };
  }

  function validateImage(image) {
    if (!image || typeof image !== "object") {
      throw new TypeError("BPAL image must be an object");
    }

    const paletteCount = Number(image.paletteCount || 1);

    validateMetadata({ ...image, paletteCount });

    const blockSizeExponent = Math.log2(image.blockSize);
    const localIndexBits = Math.log2(image.localColorCount);
    const globalIndexBits = Math.log2(image.globalColorCount);
    const blocksX = Math.ceil(image.width / image.blockSize);
    const blocksY = Math.ceil(image.height / image.blockSize);
    const blockCount = blocksX * blocksY;
    const paletteIndexBits = Math.log2(paletteCount);
    const paletteMode = image.paletteMode || "explicit";
    const channelMode = image.channelMode || "rgb";
    const vectorColorSpace = image.vectorColorSpace || "rgb";
    const paletteVectorCount = paletteMode === "vector"
      ? Number(image.paletteVectorCount || image.paletteVectors && image.paletteVectors.length)
      : 0;
    const directPixelColors = image.localColorCount === image.blockSize * image.blockSize;

    const storedPaletteColorCount = paletteCount * image.globalColorCount;

    if (paletteMode === "explicit" && (!Array.isArray(image.palette) || image.palette.length < storedPaletteColorCount)) {
      throw new RangeError("BPAL palette is shorter than paletteCount * globalColorCount");
    }

    validatePaletteVectorCount(paletteMode, paletteVectorCount, image.globalColorCount);
    validatePaletteModeCount(paletteMode, paletteCount);
    validateVectorColorSpace(vectorColorSpace);
    validateChannelMode(channelMode, paletteMode);

    if (paletteMode === "vector") {
      if (!Array.isArray(image.paletteVectors) || image.paletteVectors.length !== paletteVectorCount) {
        throw new RangeError("BPAL paletteVectors length does not match paletteVectorCount");
      }

      for (let index = 0; index < image.paletteVectors.length; index += 1) {
        const vector = image.paletteVectors[index];

        validateColor(vector && vector.start, `${index} start`);
        validateColor(vector && vector.end, `${index} end`);
      }
    }

    validateIndexArray(
      image.blockPaletteSelectors || new Uint8Array(blockCount),
      blockCount,
      paletteCount,
      "blockPaletteSelectors"
    );
    validateIndexArray(
      image.blockPaletteIndices,
      blockCount * image.localColorCount,
      image.globalColorCount,
      "blockPaletteIndices"
    );
    validateIndexArray(
      image.pixelIndices,
      image.width * image.height,
      image.localColorCount,
      "pixelIndices"
    );

    if (paletteMode === "explicit") {
      for (let index = 0; index < storedPaletteColorCount; index += 1) {
        validateColor(image.palette[index], index);
      }
    }

    return {
      width: image.width,
      height: image.height,
      blockSize: image.blockSize,
      blockSizeExponent,
      blocksX,
      blocksY,
      blockCount,
      localColorCount: image.localColorCount,
      globalColorCount: image.globalColorCount,
      paletteCount,
      paletteColorBits: image.paletteColorBits,
      channelMode,
      paletteMode,
      vectorColorSpace,
      paletteVectorCount,
      paletteVectors: image.paletteVectors || [],
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      directPixelColors,
      palette: image.palette,
      blockPaletteSelectors: image.blockPaletteSelectors || new Uint8Array(blockCount),
      blockPaletteIndices: image.blockPaletteIndices,
      pixelIndices: image.pixelIndices,
    };
  }

  function createDirectBlockPaletteIndices(image) {
    const directIndices = new Uint16Array(image.blockCount * image.localColorCount);

    for (let blockY = 0; blockY < image.blocksY; blockY += 1) {
      for (let blockX = 0; blockX < image.blocksX; blockX += 1) {
        const blockIndex = blockY * image.blocksX + blockX;
        const blockOffset = blockIndex * image.localColorCount;
        const paddingIndex = image.blockPaletteIndices[blockOffset];

        for (let localY = 0; localY < image.blockSize; localY += 1) {
          for (let localX = 0; localX < image.blockSize; localX += 1) {
            const localPosition = localY * image.blockSize + localX;
            const x = blockX * image.blockSize + localX;
            const y = blockY * image.blockSize + localY;

            directIndices[blockOffset + localPosition] = x < image.width && y < image.height
              ? image.blockPaletteIndices[
                blockOffset + image.pixelIndices[y * image.width + x]
              ]
              : paddingIndex;
          }
        }
      }
    }

    return directIndices;
  }

  function fillDirectPixelIndices(pixelIndices, width, height, blockSize) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixelIndices[y * width + x] = y % blockSize * blockSize + x % blockSize;
      }
    }
  }

  function createPackedPalettePlan(image) {
    const records = [];
    let recordsByteCount = 0;

    for (let paletteIndex = 0; paletteIndex < image.paletteCount; paletteIndex += 1) {
      const colors = image.palette.slice(
        paletteIndex * image.globalColorCount,
        (paletteIndex + 1) * image.globalColorCount
      ).map((color) => image.paletteColorBits === 16
        ? unpackRgb565(packRgb565(color))
        : createColor(color.r, color.g, color.b));
      const minimum = [255, 255, 255];
      const maximum = [0, 0, 0];

      colors.forEach((color) => {
        [color.r, color.g, color.b].forEach((value, channel) => {
          minimum[channel] = Math.min(minimum[channel], value);
          maximum[channel] = Math.max(maximum[channel], value);
        });
      });
      const widths = minimum.map((value, channel) =>
        bitsRequired(maximum[channel] - value)
      );
      const residualBits = image.globalColorCount * widths.reduce((sum, value) => sum + value, 0);
      const deltaBytes = 5 + Math.ceil(residualBits / 8);
      const rawBytes = 1 + image.globalColorCount * image.paletteColorBits / 8;
      const useDelta = deltaBytes < rawBytes;
      const byteCount = useDelta ? deltaBytes : rawBytes;

      records.push({
        offset: recordsByteCount,
        colors,
        minimum,
        widths,
        useDelta,
        byteCount,
      });
      recordsByteCount += byteCount;
    }

    return {
      byteCount: PACKED_PALETTE_HEADER_BYTES +
        image.paletteCount * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES + recordsByteCount,
      paletteColorBits: image.paletteColorBits,
      records,
    };
  }

  function writePackedPaletteSection(writer, plan) {
    writeUint32Be(writer, plan.byteCount);
    plan.records.forEach((record) => writeUint32Be(writer, record.offset));

    plan.records.forEach((record) => {
      if (!record.useDelta) {
        writer.write(0, 8);
        record.colors.forEach((color) => {
          if (plan.paletteColorBits === 16) {
            writer.write(packRgb565(color), 16);
          } else {
            writer.write(color.r, 8);
            writer.write(color.g, 8);
            writer.write(color.b, 8);
          }
        });
        return;
      }

      writer.write(0x80 | record.widths[0], 8);
      writer.write(record.widths[1] << 4 | record.widths[2], 8);
      writer.write(record.minimum[0], 8);
      writer.write(record.minimum[1], 8);
      writer.write(record.minimum[2], 8);
      record.colors.forEach((color) => {
        writer.write(color.r - record.minimum[0], record.widths[0]);
        writer.write(color.g - record.minimum[1], record.widths[1]);
        writer.write(color.b - record.minimum[2], record.widths[2]);
      });
      writer.bitOffset = Math.ceil(writer.bitOffset / 8) * 8;
    });
  }

  function readPackedPaletteSection(
    bytes,
    reader,
    paletteCount,
    globalColorCount,
    paletteColorBits,
    sectionByteCount
  ) {
    const directoryOffset = HEADER_BYTES + PACKED_PALETTE_HEADER_BYTES;
    const recordsOffset = directoryOffset + paletteCount * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES;
    const sectionEnd = HEADER_BYTES + sectionByteCount;
    const palette = [];

    if (
      sectionByteCount < PACKED_PALETTE_HEADER_BYTES +
        paletteCount * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES ||
      sectionEnd > bytes.length ||
      readUint32Be(bytes, HEADER_BYTES) !== sectionByteCount
    ) {
      throw new RangeError("Invalid packed BPAL palette section");
    }

    for (let paletteIndex = 0; paletteIndex < paletteCount; paletteIndex += 1) {
      const relativeOffset = readUint32Be(
        bytes,
        directoryOffset + paletteIndex * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES
      );
      const nextRelativeOffset = paletteIndex + 1 < paletteCount
        ? readUint32Be(
          bytes,
          directoryOffset + (paletteIndex + 1) * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES
        )
        : sectionEnd - recordsOffset;
      const recordOffset = recordsOffset + relativeOffset;
      const recordEnd = recordsOffset + nextRelativeOffset;

      if (
        (paletteIndex === 0 && relativeOffset !== 0) ||
        nextRelativeOffset <= relativeOffset ||
        recordOffset >= sectionEnd || recordEnd > sectionEnd
      ) {
        throw new RangeError("Invalid packed BPAL palette directory");
      }

      if (bytes[recordOffset] === 0) {
        const stride = paletteColorBits / 8;
        if (recordEnd - recordOffset !== 1 + globalColorCount * stride) {
          throw new RangeError("Invalid raw BPAL palette record");
        }
        const recordReader = new BitReader(bytes, (recordOffset + 1) * 8);
        for (let index = 0; index < globalColorCount; index += 1) {
          palette.push(readColor(recordReader, paletteColorBits));
        }
        continue;
      }

      if (recordEnd - recordOffset < 5) {
        throw new RangeError("Truncated delta BPAL palette record");
      }
      const redBits = bytes[recordOffset] & 15;
      const greenBits = bytes[recordOffset + 1] >> 4;
      const blueBits = bytes[recordOffset + 1] & 15;
      const widths = [redBits, greenBits, blueBits];
      const minimum = [
        bytes[recordOffset + 2],
        bytes[recordOffset + 3],
        bytes[recordOffset + 4],
      ];
      const expectedBytes = 5 + Math.ceil(
        globalColorCount * widths.reduce((sum, value) => sum + value, 0) / 8
      );
      if (
        (bytes[recordOffset] & 0xf0) !== 0x80 ||
        widths.some((value) => value > 8) ||
        recordEnd - recordOffset !== expectedBytes
      ) {
        throw new RangeError("Invalid delta BPAL palette record");
      }
      const residualReader = new BitReader(bytes, (recordOffset + 5) * 8);
      for (let index = 0; index < globalColorCount; index += 1) {
        const channels = widths.map((width, channel) =>
          minimum[channel] + residualReader.read(width)
        );
        if (channels.some((value) => value > 255)) {
          throw new RangeError("Invalid BPAL palette residual");
        }
        palette.push(createColor(channels[0], channels[1], channels[2]));
      }
    }
    reader.bitOffset = sectionEnd * 8;
    return palette;
  }

  function bitsRequired(value) {
    return value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
  }

  function writeUint32Be(writer, value) {
    writer.write(Math.floor(value / 2 ** 24) & 255, 8);
    writer.write(Math.floor(value / 2 ** 16) & 255, 8);
    writer.write(Math.floor(value / 2 ** 8) & 255, 8);
    writer.write(value & 255, 8);
  }

  function readUint32Be(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) {
      throw new RangeError("Truncated BPAL 32-bit field");
    }
    return bytes[offset] * 2 ** 24 + bytes[offset + 1] * 2 ** 16 +
      bytes[offset + 2] * 2 ** 8 + bytes[offset + 3];
  }

  function sampleBlockPaletteFilePixel(input, x, y) {
    const bytes = asUint8Array(input);
    if (bytes.length < HEADER_BYTES || MAGIC.some((value, index) => bytes[index] !== value)) {
      throw new RangeError("Invalid or truncated BPAL file");
    }
    const header = new BitReader(bytes, MAGIC_BYTES * 8);
    const version = header.read(4);
    const width = header.read(24) + 1;
    const height = header.read(24) + 1;
    const blockSize = 2 ** (header.read(3) + 1);
    const localIndexBits = header.read(2) + 1;
    const globalIndexBits = header.read(4) + 1;
    const paletteColorBits = header.read(1) === 1 ? 24 : 16;
    const paletteMode = header.read(1);
    header.read(9);
    header.read(1);
    const paletteIndexBits = header.read(3);
    const channelModeCode = header.read(2);
    const flags = header.read(2);
    const channelMode = Object.keys(CHANNEL_MODE_CODES).find(
      (name) => CHANNEL_MODE_CODES[name] === channelModeCode
    );
    const localColorCount = 2 ** localIndexBits;
    const globalColorCount = 2 ** globalIndexBits;
    const paletteCount = 2 ** paletteIndexBits;
    const packedPalettes = (flags & FLAG_PACKED_PALETTES) !== 0;

    if (
      version !== VERSION || paletteMode !== 0 ||
      channelMode === undefined ||
      (flags & ~FLAG_PACKED_PALETTES) !== 0 ||
      (packedPalettes && channelMode !== "rgb") ||
      !Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || x >= width || y < 0 || y >= height
    ) {
      throw new RangeError("Unsupported BPAL file or invalid pixel coordinate");
    }
    const storedColorBits = channelMode === "scalar" ? 8 : paletteColorBits;

    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const blockCount = blocksX * blocksY;
    const paletteSectionBytes = packedPalettes ? readUint32Be(bytes, HEADER_BYTES) : 0;
    if (
      packedPalettes &&
      (paletteSectionBytes < PACKED_PALETTE_HEADER_BYTES +
        paletteCount * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES ||
        HEADER_BYTES + paletteSectionBytes > bytes.length)
    ) {
      throw new RangeError("Invalid packed BPAL palette section");
    }
    const selectorBitOffset = packedPalettes
      ? (HEADER_BYTES + paletteSectionBytes) * 8
      : HEADER_BYTES * 8 + paletteCount * globalColorCount * storedColorBits;
    const blockPaletteBitOffset = selectorBitOffset + blockCount * paletteIndexBits;
    const pixelIndexBitOffset = blockPaletteBitOffset +
      blockCount * localColorCount * globalIndexBits;
    const blockIndex = Math.floor(y / blockSize) * blocksX + Math.floor(x / blockSize);
    const paletteIndex = readBitsAt(
      bytes,
      selectorBitOffset + blockIndex * paletteIndexBits,
      paletteIndexBits
    );
    const localIndex = localColorCount === blockSize * blockSize
      ? y % blockSize * blockSize + x % blockSize
      : readBitsAt(
        bytes,
        pixelIndexBitOffset + (y * width + x) * localIndexBits,
        localIndexBits
      );
    const globalIndex = readBitsAt(
      bytes,
      blockPaletteBitOffset +
        (blockIndex * localColorCount + localIndex) * globalIndexBits,
      globalIndexBits
    );

    if (paletteIndex >= paletteCount || localIndex >= localColorCount || globalIndex >= globalColorCount) {
      throw new RangeError("Invalid BPAL random-access index");
    }

    if (!packedPalettes) {
      const colorValue = readBitsAt(
        bytes,
        HEADER_BYTES * 8 +
          (paletteIndex * globalColorCount + globalIndex) * storedColorBits,
        storedColorBits
      );
      return channelMode === "scalar"
        ? createColor(colorValue, colorValue, colorValue)
        : paletteColorBits === 16
        ? unpackRgb565(colorValue)
        : createColor(colorValue >> 16, colorValue >> 8 & 255, colorValue & 255);
    }

    const directoryOffset = HEADER_BYTES + PACKED_PALETTE_HEADER_BYTES;
    const recordsOffset = directoryOffset +
      paletteCount * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES;
    const sectionEnd = HEADER_BYTES + paletteSectionBytes;
    const relativeOffset = readUint32Be(
      bytes,
      directoryOffset + paletteIndex * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES
    );
    const nextRelativeOffset = paletteIndex + 1 < paletteCount
      ? readUint32Be(
        bytes,
        directoryOffset + (paletteIndex + 1) * PACKED_PALETTE_DIRECTORY_ENTRY_BYTES
      )
      : sectionEnd - recordsOffset;
    const recordOffset = recordsOffset + relativeOffset;
    const recordEnd = recordsOffset + nextRelativeOffset;
    if (nextRelativeOffset <= relativeOffset || recordOffset >= sectionEnd || recordEnd > sectionEnd) {
      throw new RangeError("Invalid BPAL random-access palette directory");
    }
    if (bytes[recordOffset] === 0) {
      const stride = paletteColorBits / 8;
      const entryOffset = recordOffset + 1 + globalIndex * stride;
      if (
        recordEnd - recordOffset !== 1 + globalColorCount * stride ||
        entryOffset + stride > recordEnd
      ) {
        throw new RangeError("Truncated BPAL random-access palette record");
      }
      return paletteColorBits === 16
        ? unpackRgb565(bytes[entryOffset] << 8 | bytes[entryOffset + 1])
        : createColor(bytes[entryOffset], bytes[entryOffset + 1], bytes[entryOffset + 2]);
    }
    if (recordOffset + 5 > sectionEnd || (bytes[recordOffset] & 0xf0) !== 0x80) {
      throw new RangeError("Invalid BPAL random-access delta palette");
    }
    const widths = [
      bytes[recordOffset] & 15,
      bytes[recordOffset + 1] >> 4,
      bytes[recordOffset + 1] & 15,
    ];
    if (widths.some((value) => value > 8)) {
      throw new RangeError("Invalid BPAL random-access residual width");
    }
    const expectedRecordBytes = 5 + Math.ceil(
      globalColorCount * widths.reduce((sum, value) => sum + value, 0) / 8
    );
    if (recordEnd - recordOffset !== expectedRecordBytes) {
      throw new RangeError("Invalid BPAL random-access delta palette size");
    }
    const residualBitOffset = (recordOffset + 5) * 8 +
      globalIndex * widths.reduce((sum, value) => sum + value, 0);
    let channelBitOffset = residualBitOffset;
    const channels = widths.map((widthBits, channel) => {
      const value = bytes[recordOffset + 2 + channel] +
        readBitsAt(bytes, channelBitOffset, widthBits);
      channelBitOffset += widthBits;
      return value;
    });
    if (channels.some((value) => value > 255)) {
      throw new RangeError("Invalid BPAL random-access palette residual");
    }
    return createColor(channels[0], channels[1], channels[2]);
  }

  function readBitsAt(bytes, bitOffset, bitCount) {
    return new BitReader(bytes, bitOffset).read(bitCount);
  }

  function validatePaletteVectorCount(paletteMode, paletteVectorCount, globalColorCount) {
    if (paletteMode !== "explicit" && paletteMode !== "vector") {
      throw new RangeError(`Unsupported BPAL palette mode: ${paletteMode}`);
    }

    if (
      paletteMode === "vector" &&
      (!Number.isInteger(paletteVectorCount) || paletteVectorCount < 1 || paletteVectorCount > Math.min(512, globalColorCount / 2))
    ) {
      throw new RangeError("BPAL paletteVectorCount is out of range");
    }
  }

  function validatePaletteModeCount(paletteMode, paletteCount) {
    if (paletteMode === "vector" && paletteCount !== 1) {
      throw new RangeError("BPAL vector palettes only support paletteCount 1");
    }
  }

  function validateVectorColorSpace(vectorColorSpace) {
    if (vectorColorSpace !== "rgb" && vectorColorSpace !== "oklab") {
      throw new RangeError(`Unsupported BPAL vector color space: ${vectorColorSpace}`);
    }
  }

  function validateChannelMode(channelMode, paletteMode) {
    if (!Object.prototype.hasOwnProperty.call(CHANNEL_MODE_CODES, channelMode)) {
      throw new RangeError(`Unsupported BPAL channel mode: ${channelMode}`);
    }
    if (paletteMode === "vector" && channelMode !== "rgb") {
      throw new RangeError("BPAL vector palettes require RGB channel mode");
    }
  }

  function validateMetadata(image) {
    if (!Number.isInteger(image.width) || image.width < 1 || image.width > MAX_DIMENSION) {
      throw new RangeError(`BPAL width must be from 1 to ${MAX_DIMENSION}`);
    }

    if (!Number.isInteger(image.height) || image.height < 1 || image.height > MAX_DIMENSION) {
      throw new RangeError(`BPAL height must be from 1 to ${MAX_DIMENSION}`);
    }

    if (!isPowerOfTwo(image.blockSize) || image.blockSize < 2 || image.blockSize > 64) {
      throw new RangeError("BPAL blockSize must be a power of two from 2 to 64");
    }

    if (!isPowerOfTwo(image.localColorCount) || image.localColorCount < 2 || image.localColorCount > 16) {
      throw new RangeError("BPAL localColorCount must be a power of two from 2 to 16");
    }

    if (!isPowerOfTwo(image.globalColorCount) || image.globalColorCount < 2 || image.globalColorCount > 256) {
      throw new RangeError("BPAL globalColorCount must be a power of two from 2 to 256");
    }

    if (!isPowerOfTwo(image.paletteCount) || image.paletteCount < 1 || image.paletteCount > 128) {
      throw new RangeError("BPAL paletteCount must be a power of two from 1 to 128");
    }

    if (image.localColorCount > image.globalColorCount) {
      throw new RangeError("BPAL localColorCount cannot exceed globalColorCount");
    }

    if (image.localColorCount > image.blockSize * image.blockSize) {
      throw new RangeError("BPAL localColorCount cannot exceed the number of pixels in a block");
    }

    if (image.paletteColorBits !== 16 && image.paletteColorBits !== 24) {
      throw new RangeError("BPAL paletteColorBits must be either 16 or 24");
    }
  }

  function validateIndexArray(values, expectedLength, limit, name) {
    if (!values || typeof values.length !== "number" || values.length !== expectedLength) {
      throw new RangeError(`BPAL ${name} length does not match image metadata`);
    }

    for (const value of values) {
      if (!Number.isInteger(value) || value < 0 || value >= limit) {
        throw new RangeError(`BPAL ${name} contains an out-of-range index`);
      }
    }
  }

  function validateColor(color, index) {
    if (!color || !isByte(color.r) || !isByte(color.g) || !isByte(color.b)) {
      throw new RangeError(`BPAL palette color ${index} is invalid`);
    }
  }

  function reconstructPixels(
    width,
    height,
    blockSize,
    blocksX,
    localColorCount,
    globalColorCount,
    palette,
    blockPaletteSelectors,
    blockPaletteIndices,
    pixelIndices
  ) {
    const pixels = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        const blockX = Math.floor(x / blockSize);
        const blockY = Math.floor(y / blockSize);
        const blockIndex = blockY * blocksX + blockX;
        const paletteOffset = blockIndex * localColorCount;
        const globalIndex = blockPaletteSelectors[blockIndex] * globalColorCount +
          blockPaletteIndices[paletteOffset + pixelIndices[pixel]];
        const color = palette[globalIndex];
        const offset = pixel * 4;

        pixels[offset] = color.r;
        pixels[offset + 1] = color.g;
        pixels[offset + 2] = color.b;
        pixels[offset + 3] = 255;
      }
    }

    return pixels;
  }

  function packRgb565(color) {
    const red = Math.round(color.r * 31 / 255);
    const green = Math.round(color.g * 63 / 255);
    const blue = Math.round(color.b * 31 / 255);

    return (red << 11) | (green << 5) | blue;
  }

  function unpackRgb565(value) {
    return createColor(
      Math.round((value >> 11 & 31) * 255 / 31),
      Math.round((value >> 5 & 63) * 255 / 63),
      Math.round((value & 31) * 255 / 31)
    );
  }

  function readColor(reader, paletteColorBits) {
    return paletteColorBits === 16
      ? unpackRgb565(reader.read(16))
      : createColor(reader.read(8), reader.read(8), reader.read(8));
  }

  function readStoredColor(reader, paletteColorBits, channelMode) {
    if (channelMode === "scalar") {
      const value = reader.read(8);
      return createColor(value, value, value);
    }
    return readColor(reader, paletteColorBits);
  }

  function interpolatePaletteVectors(vectors, globalColorCount, vectorColorSpace) {
    const palette = [];
    const colorsPerVector = Math.floor(globalColorCount / vectors.length);
    const extraColors = globalColorCount % vectors.length;

    for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex += 1) {
      const vector = vectors[vectorIndex];
      const colorCount = colorsPerVector + (vectorIndex < extraColors ? 1 : 0);
      const start = vectorColorSpace === "oklab"
        ? srgbToOklab(vector.start.r, vector.start.g, vector.start.b)
        : [vector.start.r, vector.start.g, vector.start.b];
      const end = vectorColorSpace === "oklab"
        ? srgbToOklab(vector.end.r, vector.end.g, vector.end.b)
        : [vector.end.r, vector.end.g, vector.end.b];

      for (let colorIndex = 0; colorIndex < colorCount; colorIndex += 1) {
        const ratio = colorCount <= 1 ? 0 : colorIndex / (colorCount - 1);
        const point = [
          start[0] + (end[0] - start[0]) * ratio,
          start[1] + (end[1] - start[1]) * ratio,
          start[2] + (end[2] - start[2]) * ratio,
        ];
        const channels = vectorColorSpace === "oklab"
          ? oklabToSrgb(point[0], point[1], point[2])
          : point;

        palette.push(createColor(
          clampByte(Math.round(channels[0])),
          clampByte(Math.round(channels[1])),
          clampByte(Math.round(channels[2]))
        ));
      }
    }

    return palette;
  }

  function srgbToOklab(red, green, blue) {
    const redLinear = srgbByteToLinear(red);
    const greenLinear = srgbByteToLinear(green);
    const blueLinear = srgbByteToLinear(blue);
    const l = Math.cbrt(0.4122214708 * redLinear + 0.5363325363 * greenLinear + 0.0514459929 * blueLinear);
    const m = Math.cbrt(0.2119034982 * redLinear + 0.6806995451 * greenLinear + 0.1073969566 * blueLinear);
    const s = Math.cbrt(0.0883024619 * redLinear + 0.2817188376 * greenLinear + 0.6299787005 * blueLinear);

    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function oklabToSrgb(lightness, greenRed, blueYellow) {
    const lRoot = lightness + 0.3963377774 * greenRed + 0.2158037573 * blueYellow;
    const mRoot = lightness - 0.1055613458 * greenRed - 0.0638541728 * blueYellow;
    const sRoot = lightness - 0.0894841775 * greenRed - 1.291485548 * blueYellow;
    const l = lRoot ** 3;
    const m = mRoot ** 3;
    const s = sRoot ** 3;

    return [
      linearToSrgbByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linearToSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linearToSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }

  function srgbByteToLinear(value) {
    const normalized = clampByte(value) / 255;

    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  }

  function linearToSrgbByte(value) {
    const linear = Math.max(0, Math.min(1, value));
    const normalized = linear <= 0.0031308
      ? linear * 12.92
      : 1.055 * linear ** (1 / 2.4) - 0.055;

    return normalized * 255;
  }

  function clampByte(value) {
    return Math.max(0, Math.min(255, value));
  }

  function createColor(red, green, blue) {
    return {
      r: red,
      g: green,
      b: blue,
      hex: `#${toHex(red)}${toHex(green)}${toHex(blue)}`,
    };
  }

  function toHex(value) {
    return value.toString(16).padStart(2, "0");
  }

  function asUint8Array(input) {
    if (input instanceof Uint8Array) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }

    throw new TypeError("BPAL input must be an ArrayBuffer or Uint8Array");
  }

  function isPowerOfTwo(value) {
    return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
  }

  function isByte(value) {
    return Number.isInteger(value) && value >= 0 && value <= 255;
  }

  class BitWriter {
    constructor(bytes, bitOffset) {
      this.bytes = bytes;
      this.bitOffset = bitOffset;
    }

    write(value, bitCount) {
      if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bitCount) {
        throw new RangeError(`Value ${value} does not fit in ${bitCount} bits`);
      }

      if (this.bitOffset + bitCount > this.bytes.length * 8) {
        throw new RangeError("BPAL output buffer is too small");
      }

      for (let bit = bitCount - 1; bit >= 0; bit -= 1) {
        const byteIndex = Math.floor(this.bitOffset / 8);
        const bitInByte = 7 - this.bitOffset % 8;
        const bitValue = Math.floor(value / 2 ** bit) % 2;

        this.bytes[byteIndex] |= bitValue << bitInByte;
        this.bitOffset += 1;
      }
    }
  }

  class BitReader {
    constructor(bytes, bitOffset) {
      this.bytes = bytes;
      this.bitOffset = bitOffset;
    }

    read(bitCount) {
      if (this.bitOffset + bitCount > this.bytes.length * 8) {
        throw new RangeError("Truncated BPAL bit stream");
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
    encodeBlockPaletteFile,
    decodeBlockPaletteFile,
    sampleBlockPaletteFilePixel,
    getBlockPaletteFileLayout,
  };
});
