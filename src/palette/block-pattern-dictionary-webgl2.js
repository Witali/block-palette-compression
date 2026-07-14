(function (root, factory) {
  "use strict";

  const blockPatternDictionary = typeof module === "object" && module.exports
    ? require("./block-pattern-dictionary.js")
    : root.BlockPatternDictionary;
  const api = factory(blockPatternDictionary);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BlockPatternDictionaryWebGl2 = api;
})(typeof self !== "undefined" ? self : globalThis, function (blockPatternDictionary) {
  "use strict";

  const HEADER_BYTES = 28;
  const MODE_DICTIONARY = 0;
  const MODE_RAW = 1;
  const MODE_RUNS = 2;
  const MODE_EXTENDED_DICTIONARY = 3;
  const TRANSFORM_BITS = 3;
  const MAX_CHECKPOINT_LOG2 = 4;
  const MAX_CHECKPOINT_SCAN = 15;
  const MAX_POSITION_SEARCH_STEPS = 12;
  const MAX_BITMAP_WORDS = 128;

  function createShaderData(input, maximumTextureWidth) {
    if (
      !blockPatternDictionary ||
      typeof blockPatternDictionary.openPatternDictionaryFile !== "function"
    ) {
      throw new Error("BPDI decoder is required for WebGL2 packing");
    }

    const bytes = asUint8Array(input);

    blockPatternDictionary.openPatternDictionaryFile(bytes);

    const textureLimit = maximumTextureWidth === undefined
      ? 4096
      : positiveInteger(maximumTextureWidth, "maximumTextureWidth");
    const layout = parseLayout(bytes);

    if (layout.checkpointLog2 > MAX_CHECKPOINT_LOG2) {
      throw new RangeError(
        `WebGL2 BPDI lookup requires checkpointLog2 <= ${MAX_CHECKPOINT_LOG2}`
      );
    }

    const wordCount = Math.ceil(bytes.length / 4);
    const width = Math.min(textureLimit, Math.max(1, wordCount));
    const height = Math.ceil(wordCount / width);

    if (height > textureLimit) {
      throw new RangeError("BPDI R32UI word atlas exceeds the WebGL texture limit");
    }

    const words = new Uint32Array(width * height);

    for (let index = 0; index < wordCount; index += 1) {
      const offset = index * 4;

      words[index] = (
        (bytes[offset] || 0) * 2 ** 24 +
        (bytes[offset + 1] || 0) * 2 ** 16 +
        (bytes[offset + 2] || 0) * 2 ** 8 +
        (bytes[offset + 3] || 0)
      ) >>> 0;
    }

    return {
      format: "bpdi-webgl2-r32ui",
      version: 3,
      layout,
      wordAtlas: { width, height, data: words, wordCount },
      gpuBytes: words.byteLength,
    };
  }

  function samplePackedPixel(shaderData, x, y) {
    const layout = validateShaderData(shaderData);

    validateCoordinate(x, layout.width, "x");
    validateCoordinate(y, layout.height, "y");

    const localIndex = samplePackedPixelIndex(shaderData, x, y);
    const blockX = Math.floor(x / layout.blockSize);
    const blockY = Math.floor(y / layout.blockSize);
    const blockIndex = blockY * layout.blocksX + blockX;
    const selector = layout.paletteIndexBits === 0
      ? 0
      : readPackedBits(
        shaderData,
        layout.selectorStart + blockIndex * layout.paletteIndexBits,
        layout.paletteIndexBits
      );
    const globalIndex = readPackedBits(
      shaderData,
      layout.blockPaletteStart +
        (blockIndex * layout.localColorCount + localIndex) * layout.globalIndexBits,
      layout.globalIndexBits
    );
    const colorIndex = selector * layout.globalColorCount + globalIndex;
    const colorOffset = layout.paletteStart + colorIndex * layout.paletteColorBits;

    if (layout.paletteColorBits === 16) {
      const value = readPackedBits(shaderData, colorOffset, 16);

      return {
        r: Math.floor(((value >> 11 & 31) * 255 + 15) / 31),
        g: Math.floor(((value >> 5 & 63) * 255 + 31) / 63),
        b: Math.floor(((value & 31) * 255 + 15) / 31),
        a: 255,
      };
    }

    return {
      r: readPackedBits(shaderData, colorOffset, 8),
      g: readPackedBits(shaderData, colorOffset + 8, 8),
      b: readPackedBits(shaderData, colorOffset + 16, 8),
      a: 255,
    };
  }

  function samplePackedPixelIndex(shaderData, x, y) {
    const layout = validateShaderData(shaderData);

    validateCoordinate(x, layout.width, "x");
    validateCoordinate(y, layout.height, "y");

    const blockX = Math.floor(x / layout.blockSize);
    const blockY = Math.floor(y / layout.blockSize);
    const blockIndex = blockY * layout.blocksX + blockX;
    const localPosition = y % layout.blockSize * layout.blockSize + x % layout.blockSize;

    if (layout.directPixelColors) {
      return localPosition;
    }

    if (layout.dictionarySize === 0) {
      return readPackedBits(
        shaderData,
        layout.payloadStart + (y * layout.width + x) * layout.localIndexBits,
        layout.localIndexBits
      );
    }

    const tag = readTag(shaderData, layout, blockIndex);
    const blockPayload = findBlockPayload(shaderData, layout, blockIndex);
    const editBits = layout.positionBits + layout.localIndexBits;

    if (tag.mode === MODE_RAW) {
      return readPackedBits(
        shaderData,
        blockPayload + localPosition * layout.localIndexBits,
        layout.localIndexBits
      );
    }

    if (tag.mode === MODE_RUNS) {
      const upperBound = findPositionUpperBound(
        shaderData,
        blockPayload + layout.localIndexBits,
        tag.editCount,
        editBits,
        layout.positionBits,
        localPosition
      );

      return upperBound === 0
        ? readPackedBits(shaderData, blockPayload, layout.localIndexBits)
        : readPackedBits(
          shaderData,
          blockPayload + layout.localIndexBits +
            (upperBound - 1) * editBits + layout.positionBits,
          layout.localIndexBits
        );
    }

    const extended = tag.mode === MODE_EXTENDED_DICTIONARY;
    const transform = extended
      ? readPackedBits(shaderData, blockPayload, TRANSFORM_BITS)
      : 0;
    const prototypePosition = transform === 0
      ? localPosition
      : transformPosition(localPosition, layout.blockSize, transform);
    let value = readPackedBits(
      shaderData,
      layout.dictionaryStart +
        (tag.prototypeIndex * layout.pixelsPerBlock + prototypePosition) *
          layout.localIndexBits,
      layout.localIndexBits
    );

    if (extended && transform === 0) {
      const bitmapStart = blockPayload + TRANSFORM_BITS;

      if (readPackedBits(shaderData, bitmapStart + localPosition, 1) !== 0) {
        const rank = bitmapRank(shaderData, bitmapStart, localPosition);

        value = readPackedBits(
          shaderData,
          bitmapStart + layout.pixelsPerBlock + rank * layout.localIndexBits,
          layout.localIndexBits
        );
      }

      return value;
    }

    const editsStart = blockPayload + (extended ? TRANSFORM_BITS : 0);
    const editIndex = findPositionLowerBound(
      shaderData,
      editsStart,
      tag.editCount,
      editBits,
      layout.positionBits,
      localPosition
    );

    if (editIndex < tag.editCount) {
      const editOffset = editsStart + editIndex * editBits;

      if (readPackedBits(shaderData, editOffset, layout.positionBits) === localPosition) {
        value = readPackedBits(
          shaderData,
          editOffset + layout.positionBits,
          layout.localIndexBits
        );
      }
    }

    return value;
  }

  function parseLayout(bytes) {
    if (bytes.length < HEADER_BYTES) {
      throw new RangeError("Truncated BPDI header");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = view.getUint8(5);
    const blockSize = 2 ** view.getUint8(6);
    const localIndexBits = view.getUint8(7);
    const globalIndexBits = view.getUint8(8);
    const paletteIndexBits = view.getUint8(9);
    const paletteColorBits = view.getUint8(10);
    const checkpointLog2 = view.getUint8(11);
    const width = view.getUint32(12, true);
    const height = view.getUint32(16, true);
    const dictionarySize = view.getUint16(20, true);
    const localColorCount = 2 ** localIndexBits;
    const globalColorCount = 2 ** globalIndexBits;
    const paletteCount = 2 ** paletteIndexBits;
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const blockCount = blocksX * blocksY;
    const pixelsPerBlock = blockSize * blockSize;
    const prototypeIndexBits = dictionarySize > 0 ? Math.log2(dictionarySize) : 0;
    const editCountBits = Math.ceil(Math.log2(pixelsPerBlock + 1));
    const tagBits = dictionarySize > 0
      ? 2 + prototypeIndexBits + editCountBits
      : 0;
    const groupCount = dictionarySize > 0
      ? Math.ceil(blockCount / 2 ** checkpointLog2)
      : 0;
    const paletteStart = HEADER_BYTES * 8;
    const selectorStart = paletteStart +
      paletteCount * globalColorCount * paletteColorBits;
    const blockPaletteStart = selectorStart + blockCount * paletteIndexBits;
    const dictionaryStart = blockPaletteStart +
      blockCount * localColorCount * globalIndexBits;
    const tagsStart = dictionaryStart +
      dictionarySize * pixelsPerBlock * localIndexBits;
    const directoryStart = tagsStart + blockCount * tagBits;
    const payloadStart = directoryStart + (dictionarySize > 0 ? (groupCount + 1) * 32 : 0);

    return {
      width,
      height,
      blockSize,
      blocksX,
      blocksY,
      blockCount,
      pixelsPerBlock,
      localColorCount,
      globalColorCount,
      paletteCount,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      paletteColorBits,
      dictionarySize,
      directPixelColors: (flags & 1) !== 0,
      checkpointLog2,
      checkpointInterval: 2 ** checkpointLog2,
      prototypeIndexBits,
      editCountBits,
      positionBits: Math.log2(pixelsPerBlock),
      tagBits,
      paletteStart,
      selectorStart,
      blockPaletteStart,
      dictionaryStart,
      tagsStart,
      directoryStart,
      payloadStart,
    };
  }

  function readTag(shaderData, layout, blockIndex) {
    let offset = layout.tagsStart + blockIndex * layout.tagBits;
    const mode = readPackedBits(shaderData, offset, 2);

    offset += 2;
    const prototypeIndex = readPackedBits(
      shaderData,
      offset,
      layout.prototypeIndexBits
    );

    offset += layout.prototypeIndexBits;

    return {
      mode,
      prototypeIndex,
      editCount: readPackedBits(shaderData, offset, layout.editCountBits),
    };
  }

  function findBlockPayload(shaderData, layout, blockIndex) {
    const group = Math.floor(blockIndex / layout.checkpointInterval);
    const firstBlock = group * layout.checkpointInterval;
    let relativeOffset = readPackedBits(
      shaderData,
      layout.directoryStart + group * 32,
      32
    );

    for (let index = 0; index < MAX_CHECKPOINT_SCAN; index += 1) {
      const precedingBlock = firstBlock + index;

      if (precedingBlock < blockIndex) {
        const tag = readTag(shaderData, layout, precedingBlock);

        relativeOffset += blockPayloadBits(
          shaderData,
          layout,
          tag,
          relativeOffset
        );
      }
    }

    return layout.payloadStart + relativeOffset;
  }

  function blockPayloadBits(shaderData, layout, tag, relativeOffset) {
    const editBits = layout.positionBits + layout.localIndexBits;

    if (tag.mode === MODE_RAW) {
      return layout.pixelsPerBlock * layout.localIndexBits;
    }

    if (tag.mode === MODE_RUNS) {
      return layout.localIndexBits + tag.editCount * editBits;
    }

    if (tag.mode === MODE_EXTENDED_DICTIONARY) {
      const transform = readPackedBits(
        shaderData,
        layout.payloadStart + relativeOffset,
        TRANSFORM_BITS
      );

      return transform === 0
        ? TRANSFORM_BITS + layout.pixelsPerBlock + tag.editCount * layout.localIndexBits
        : TRANSFORM_BITS + tag.editCount * editBits;
    }

    return tag.editCount * editBits;
  }

  function findPositionLowerBound(
    shaderData,
    start,
    count,
    stride,
    positionBits,
    target
  ) {
    let low = 0;
    let high = count;

    for (let step = 0; step < MAX_POSITION_SEARCH_STEPS; step += 1) {
      if (low < high) {
        const middle = Math.floor((low + high) / 2);
        const position = readPackedBits(
          shaderData,
          start + middle * stride,
          positionBits
        );

        if (position < target) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
    }

    return low;
  }

  function findPositionUpperBound(
    shaderData,
    start,
    count,
    stride,
    positionBits,
    target
  ) {
    let low = 0;
    let high = count;

    for (let step = 0; step < MAX_POSITION_SEARCH_STEPS; step += 1) {
      if (low < high) {
        const middle = Math.floor((low + high) / 2);
        const position = readPackedBits(
          shaderData,
          start + middle * stride,
          positionBits
        );

        if (position <= target) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
    }

    return low;
  }

  function bitmapRank(shaderData, bitmapStart, prefixBits) {
    let rank = 0;

    for (let word = 0; word < MAX_BITMAP_WORDS; word += 1) {
      const consumed = word * 32;

      if (consumed < prefixBits) {
        const count = Math.min(32, prefixBits - consumed);

        rank += popCount32(readPackedBits(shaderData, bitmapStart + consumed, count));
      }
    }

    return rank;
  }

  function transformPosition(position, blockSize, transform) {
    const x = position % blockSize;
    const y = Math.floor(position / blockSize);
    const last = blockSize - 1;

    switch (transform) {
      case 1: return (last - x) * blockSize + y;
      case 2: return (last - y) * blockSize + last - x;
      case 3: return x * blockSize + last - y;
      case 4: return y * blockSize + last - x;
      case 5: return (last - y) * blockSize + x;
      case 6: return x * blockSize + y;
      case 7: return (last - x) * blockSize + last - y;
      default: return position;
    }
  }

  function readPackedBits(shaderData, bitOffset, bitCount) {
    if (bitCount === 0) {
      return 0;
    }

    const wordIndex = Math.floor(bitOffset / 32);
    const bitInWord = bitOffset % 32;
    let value = (fetchWord(shaderData, wordIndex) << bitInWord) >>> 0;

    if (bitInWord !== 0) {
      value = (
        value |
        fetchWord(shaderData, wordIndex + 1) >>> (32 - bitInWord)
      ) >>> 0;
    }

    return bitCount === 32 ? value : value >>> (32 - bitCount);
  }

  function fetchWord(shaderData, wordIndex) {
    return wordIndex < shaderData.wordAtlas.wordCount
      ? shaderData.wordAtlas.data[wordIndex] >>> 0
      : 0;
  }

  function popCount32(value) {
    value >>>= 0;
    value -= value >>> 1 & 0x55555555;
    value = (value & 0x33333333) + (value >>> 2 & 0x33333333);

    return ((value + (value >>> 4) & 0x0f0f0f0f) * 0x01010101 >>> 24);
  }

  function validateShaderData(shaderData) {
    if (
      !shaderData ||
      shaderData.format !== "bpdi-webgl2-r32ui" ||
      !shaderData.layout ||
      !shaderData.wordAtlas ||
      !(shaderData.wordAtlas.data instanceof Uint32Array)
    ) {
      throw new TypeError("Invalid BPDI WebGL2 shader data");
    }

    return shaderData.layout;
  }

  function validateCoordinate(value, limit, name) {
    if (!Number.isInteger(value) || value < 0 || value >= limit) {
      throw new RangeError(`${name} coordinate is outside the image`);
    }
  }

  function positiveInteger(value, name) {
    const normalized = Number(value);

    if (!Number.isInteger(normalized) || normalized < 1) {
      throw new RangeError(`${name} must be a positive integer`);
    }

    return normalized;
  }

  function asUint8Array(input) {
    if (input instanceof Uint8Array) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }

    throw new TypeError("BPDI WebGL2 input must be an ArrayBuffer or Uint8Array");
  }

  const GLSL_SOURCE = `
#define BPDI_MODE_DICTIONARY 0u
#define BPDI_MODE_RAW 1u
#define BPDI_MODE_RUNS 2u
#define BPDI_MODE_EXTENDED_DICTIONARY 3u
#define BPDI_MAX_CHECKPOINT_SCAN 15
#define BPDI_MAX_POSITION_SEARCH_STEPS 12
#define BPDI_MAX_BITMAP_WORDS 128

struct BpdiLayout {
  uint width;
  uint height;
  uint blockSize;
  uint blocksX;
  uint pixelsPerBlock;
  uint localColorCount;
  uint globalColorCount;
  uint localIndexBits;
  uint globalIndexBits;
  uint paletteIndexBits;
  uint paletteColorBits;
  uint dictionarySize;
  uint directPixelColors;
  uint checkpointLog2;
  uint prototypeIndexBits;
  uint editCountBits;
  uint positionBits;
  uint tagBits;
  uint paletteStart;
  uint selectorStart;
  uint blockPaletteStart;
  uint dictionaryStart;
  uint tagsStart;
  uint directoryStart;
  uint payloadStart;
};

uniform highp usampler2D uBpdiWords;
uniform highp uvec2 uBpdiWordAtlasSize;
uniform BpdiLayout uBpdi;

uint bpdiFetchWord(uint wordIndex) {
  uvec2 coordinate = uvec2(
    wordIndex % uBpdiWordAtlasSize.x,
    wordIndex / uBpdiWordAtlasSize.x
  );
  return texelFetch(uBpdiWords, ivec2(coordinate), 0).r;
}

uint bpdiReadBits(uint bitOffset, uint bitCountValue) {
  if (bitCountValue == 0u) {
    return 0u;
  }
  uint wordIndex = bitOffset >> 5u;
  uint bitInWord = bitOffset & 31u;
  uint value = bpdiFetchWord(wordIndex) << bitInWord;
  if (bitInWord != 0u) {
    value |= bpdiFetchWord(wordIndex + 1u) >> (32u - bitInWord);
  }
  return bitCountValue == 32u ? value : value >> (32u - bitCountValue);
}

uvec3 bpdiReadTag(BpdiLayout bpdi, uint blockIndex) {
  uint offset = bpdi.tagsStart + blockIndex * bpdi.tagBits;
  uint mode = bpdiReadBits(offset, 2u);
  offset += 2u;
  uint prototypeIndex = bpdiReadBits(offset, bpdi.prototypeIndexBits);
  offset += bpdi.prototypeIndexBits;
  return uvec3(mode, prototypeIndex, bpdiReadBits(offset, bpdi.editCountBits));
}

uint bpdiBlockPayloadBits(BpdiLayout bpdi, uvec3 tag, uint relativeOffset) {
  uint editBits = bpdi.positionBits + bpdi.localIndexBits;
  if (tag.x == BPDI_MODE_RAW) {
    return bpdi.pixelsPerBlock * bpdi.localIndexBits;
  }
  if (tag.x == BPDI_MODE_RUNS) {
    return bpdi.localIndexBits + tag.z * editBits;
  }
  if (tag.x == BPDI_MODE_EXTENDED_DICTIONARY) {
    uint transform = bpdiReadBits(bpdi.payloadStart + relativeOffset, 3u);
    return transform == 0u
      ? 3u + bpdi.pixelsPerBlock + tag.z * bpdi.localIndexBits
      : 3u + tag.z * editBits;
  }
  return tag.z * editBits;
}

uint bpdiFindBlockPayload(BpdiLayout bpdi, uint blockIndex) {
  uint group = blockIndex >> bpdi.checkpointLog2;
  uint firstBlock = group << bpdi.checkpointLog2;
  uint relativeOffset = bpdiReadBits(bpdi.directoryStart + group * 32u, 32u);
  for (int index = 0; index < BPDI_MAX_CHECKPOINT_SCAN; ++index) {
    uint precedingBlock = firstBlock + uint(index);
    if (precedingBlock < blockIndex) {
      uvec3 tag = bpdiReadTag(bpdi, precedingBlock);
      relativeOffset += bpdiBlockPayloadBits(bpdi, tag, relativeOffset);
    }
  }
  return bpdi.payloadStart + relativeOffset;
}

uint bpdiTransformPosition(uint position, uint blockSize, uint transform) {
  uint x = position % blockSize;
  uint y = position / blockSize;
  uint last = blockSize - 1u;
  if (transform == 1u) return (last - x) * blockSize + y;
  if (transform == 2u) return (last - y) * blockSize + last - x;
  if (transform == 3u) return x * blockSize + last - y;
  if (transform == 4u) return y * blockSize + last - x;
  if (transform == 5u) return (last - y) * blockSize + x;
  if (transform == 6u) return x * blockSize + y;
  if (transform == 7u) return (last - x) * blockSize + last - y;
  return position;
}

uint bpdiPopCount(uint value) {
  value -= (value >> 1u) & 0x55555555u;
  value = (value & 0x33333333u) + ((value >> 2u) & 0x33333333u);
  return (((value + (value >> 4u)) & 0x0f0f0f0fu) * 0x01010101u) >> 24u;
}

uint bpdiBitmapRank(uint bitmapStart, uint prefixBits) {
  uint rank = 0u;
  for (int word = 0; word < BPDI_MAX_BITMAP_WORDS; ++word) {
    uint consumed = uint(word) * 32u;
    if (consumed < prefixBits) {
      uint countValue = min(32u, prefixBits - consumed);
      rank += bpdiPopCount(bpdiReadBits(bitmapStart + consumed, countValue));
    }
  }
  return rank;
}

uint bpdiPositionLowerBound(
  uint start,
  uint countValue,
  uint stride,
  uint positionBits,
  uint target
) {
  uint low = 0u;
  uint high = countValue;
  for (int step = 0; step < BPDI_MAX_POSITION_SEARCH_STEPS; ++step) {
    if (low < high) {
      uint middle = (low + high) >> 1u;
      uint position = bpdiReadBits(start + middle * stride, positionBits);
      if (position < target) low = middle + 1u;
      else high = middle;
    }
  }
  return low;
}

uint bpdiPositionUpperBound(
  uint start,
  uint countValue,
  uint stride,
  uint positionBits,
  uint target
) {
  uint low = 0u;
  uint high = countValue;
  for (int step = 0; step < BPDI_MAX_POSITION_SEARCH_STEPS; ++step) {
    if (low < high) {
      uint middle = (low + high) >> 1u;
      uint position = bpdiReadBits(start + middle * stride, positionBits);
      if (position <= target) low = middle + 1u;
      else high = middle;
    }
  }
  return low;
}

uint bpdiGetPixelIndex(BpdiLayout bpdi, uvec2 pixel) {
  uvec2 block = pixel / bpdi.blockSize;
  uint blockIndex = block.y * bpdi.blocksX + block.x;
  uvec2 local = pixel % bpdi.blockSize;
  uint localPosition = local.y * bpdi.blockSize + local.x;
  if (bpdi.directPixelColors != 0u) return localPosition;
  if (bpdi.dictionarySize == 0u) {
    return bpdiReadBits(
      bpdi.payloadStart + (pixel.y * bpdi.width + pixel.x) * bpdi.localIndexBits,
      bpdi.localIndexBits
    );
  }
  uvec3 tag = bpdiReadTag(bpdi, blockIndex);
  uint payload = bpdiFindBlockPayload(bpdi, blockIndex);
  uint editBits = bpdi.positionBits + bpdi.localIndexBits;
  if (tag.x == BPDI_MODE_RAW) {
    return bpdiReadBits(payload + localPosition * bpdi.localIndexBits, bpdi.localIndexBits);
  }
  if (tag.x == BPDI_MODE_RUNS) {
    uint start = payload + bpdi.localIndexBits;
    uint upper = bpdiPositionUpperBound(
      start, tag.z, editBits, bpdi.positionBits, localPosition
    );
    return upper == 0u
      ? bpdiReadBits(payload, bpdi.localIndexBits)
      : bpdiReadBits(
        start + (upper - 1u) * editBits + bpdi.positionBits,
        bpdi.localIndexBits
      );
  }
  bool extended = tag.x == BPDI_MODE_EXTENDED_DICTIONARY;
  uint transform = extended ? bpdiReadBits(payload, 3u) : 0u;
  uint prototypePosition = transform == 0u
    ? localPosition
    : bpdiTransformPosition(localPosition, bpdi.blockSize, transform);
  uint value = bpdiReadBits(
    bpdi.dictionaryStart +
      (tag.y * bpdi.pixelsPerBlock + prototypePosition) * bpdi.localIndexBits,
    bpdi.localIndexBits
  );
  if (extended && transform == 0u) {
    uint bitmapStart = payload + 3u;
    if (bpdiReadBits(bitmapStart + localPosition, 1u) != 0u) {
      uint rank = bpdiBitmapRank(bitmapStart, localPosition);
      value = bpdiReadBits(
        bitmapStart + bpdi.pixelsPerBlock + rank * bpdi.localIndexBits,
        bpdi.localIndexBits
      );
    }
    return value;
  }
  uint editsStart = payload + (extended ? 3u : 0u);
  uint editIndex = bpdiPositionLowerBound(
    editsStart, tag.z, editBits, bpdi.positionBits, localPosition
  );
  if (editIndex < tag.z) {
    uint editOffset = editsStart + editIndex * editBits;
    if (bpdiReadBits(editOffset, bpdi.positionBits) == localPosition) {
      value = bpdiReadBits(editOffset + bpdi.positionBits, bpdi.localIndexBits);
    }
  }
  return value;
}

uvec4 bpdiGetPixel(BpdiLayout bpdi, uvec2 pixel) {
  uint localIndex = bpdiGetPixelIndex(bpdi, pixel);
  uvec2 block = pixel / bpdi.blockSize;
  uint blockIndex = block.y * bpdi.blocksX + block.x;
  uint selector = bpdi.paletteIndexBits == 0u
    ? 0u
    : bpdiReadBits(
      bpdi.selectorStart + blockIndex * bpdi.paletteIndexBits,
      bpdi.paletteIndexBits
    );
  uint globalIndex = bpdiReadBits(
    bpdi.blockPaletteStart +
      (blockIndex * bpdi.localColorCount + localIndex) * bpdi.globalIndexBits,
    bpdi.globalIndexBits
  );
  uint colorIndex = selector * bpdi.globalColorCount + globalIndex;
  uint colorOffset = bpdi.paletteStart + colorIndex * bpdi.paletteColorBits;
  if (bpdi.paletteColorBits == 16u) {
    uint packed = bpdiReadBits(colorOffset, 16u);
    return uvec4(
      (((packed >> 11u) & 31u) * 255u + 15u) / 31u,
      (((packed >> 5u) & 63u) * 255u + 31u) / 63u,
      ((packed & 31u) * 255u + 15u) / 31u,
      255u
    );
  }
  return uvec4(
    bpdiReadBits(colorOffset, 8u),
    bpdiReadBits(colorOffset + 8u, 8u),
    bpdiReadBits(colorOffset + 16u, 8u),
    255u
  );
}
`;

  return {
    GLSL_SOURCE,
    MAX_CHECKPOINT_LOG2,
    MAX_CHECKPOINT_SCAN,
    MAX_POSITION_SEARCH_STEPS,
    MAX_BITMAP_WORDS,
    createShaderData,
    samplePackedPixel,
    samplePackedPixelIndex,
  };
});
