(function (root, factory) {
  "use strict";

  const blockPaletteFormat = typeof module === "object" && module.exports
    ? require("./block-palette-format.js")
    : root.BlockPaletteFormat;
  const api = factory(blockPaletteFormat);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BlockPatternDictionary = api;
})(typeof self !== "undefined" ? self : globalThis, function (blockPaletteFormat) {
  "use strict";

  const MAGIC_BYTES = [0x42, 0x50, 0x44, 0x49]; // BPDI
  const MAGIC = "BPDI";
  const VERSION = 2;
  const MODE_DICTIONARY = 0;
  const MODE_RAW = 1;
  const MODE_RUNS = 2;
  const HEADER_BYTES = 28;
  const DEFAULT_MAX_DICTIONARY_SIZE = 64;
  const DEFAULT_SAMPLE_LIMIT = 8192;
  const DEFAULT_CHECKPOINT_LOG2 = 6;

  function encodePatternDictionaryFile(image, options) {
    const settings = options || {};
    const metadata = validateImage(image);
    const checkpointLog2 = normalizeInteger(
      settings.checkpointLog2,
      DEFAULT_CHECKPOINT_LOG2,
      0,
      12,
      "checkpointLog2"
    );
    const checkpointInterval = 2 ** checkpointLog2;
    const normalized = metadata.directPixelColors
      ? {
        blockPaletteIndices: Uint16Array.from(metadata.blockPaletteIndices),
        patterns: null,
      }
      : canonicalizeBlocks(metadata);
    const dictionaryEncoding = metadata.directPixelColors
      ? createDirectEncoding(metadata)
      : chooseDictionaryEncoding(
        normalized.patterns,
        metadata,
        settings,
        checkpointInterval
      );
    const fixedLayout = calculateFixedLayout(metadata, normalized, dictionaryEncoding);
    const groupOffsets = dictionaryEncoding.dictionarySize > 0
      ? calculateGroupOffsets(metadata, dictionaryEncoding, checkpointInterval)
      : new Uint32Array(0);
    const directoryBits = groupOffsets.length * 32;
    const payloadBits = dictionaryEncoding.payloadBits;
    const totalBits = HEADER_BYTES * 8 + fixedLayout.fixedBits + directoryBits + payloadBits;
    const bytes = new Uint8Array(Math.ceil(totalBits / 8));

    writeHeader(bytes, metadata, dictionaryEncoding, checkpointLog2, payloadBits);

    const writer = new BitWriter(bytes, HEADER_BYTES * 8);

    writePalette(writer, metadata.palette, metadata.paletteColorBits);

    for (let block = 0; block < metadata.blockCount; block += 1) {
      writer.write(metadata.blockPaletteSelectors[block], metadata.paletteIndexBits);
    }

    for (const globalIndex of normalized.blockPaletteIndices) {
      writer.write(globalIndex, metadata.globalIndexBits);
    }

    if (dictionaryEncoding.dictionarySize > 0) {
      for (const prototype of dictionaryEncoding.dictionary) {
        for (const localIndex of prototype) {
          writer.write(localIndex, metadata.localIndexBits);
        }
      }

      writeTags(writer, metadata, dictionaryEncoding);

      for (const offset of groupOffsets) {
        writer.write(offset, 32);
      }

      writeDictionaryPayload(writer, normalized.patterns, metadata, dictionaryEncoding);
    } else if (!metadata.directPixelColors) {
      writeLinearPixelIndices(writer, normalized.patterns, metadata);
    }

    if (writer.bitOffset !== totalBits) {
      throw new Error(`Internal BPDI size mismatch: wrote ${writer.bitOffset}, expected ${totalBits}`);
    }

    const stats = createEncodingStats(
      metadata,
      dictionaryEncoding,
      fixedLayout,
      directoryBits,
      bytes.length
    );

    return { bytes, stats };
  }

  function encodeSmallestRandomAccessFile(image, options) {
    if (!blockPaletteFormat || typeof blockPaletteFormat.encodeBlockPaletteFile !== "function") {
      throw new Error("BlockPaletteFormat is required for hybrid BPAL/BPDI encoding");
    }

    const baselineBytes = blockPaletteFormat.encodeBlockPaletteFile(image);
    const candidate = encodePatternDictionaryFile(image, options);
    const useDictionary = candidate.bytes.length < baselineBytes.length;

    return {
      bytes: useDictionary ? candidate.bytes : baselineBytes,
      format: useDictionary ? "bpdi" : "bpal",
      baselineBytes: baselineBytes.length,
      candidateBytes: candidate.bytes.length,
      candidateStats: candidate.stats,
      savedBytes: useDictionary ? baselineBytes.length - candidate.bytes.length : 0,
      stats: useDictionary
        ? {
          ...candidate.stats,
          selected: true,
        }
        : {
          ...candidate.stats,
          dictionarySize: 0,
          encodedPixelBits: candidate.stats.originalPixelBits,
          pixelSavingsRatio: 0,
          payloadBits: candidate.stats.originalPixelBits,
          directoryBits: 0,
          rawBlocks: candidate.stats.blockCount,
          referencedBlocks: 0,
          runLengthBlocks: 0,
          exactBlocks: 0,
          totalEdits: 0,
          selected: false,
          fileBytes: baselineBytes.length,
        },
    };
  }

  function openRandomAccessImageFile(input) {
    const bytes = asUint8Array(input);
    const magic = bytes.length >= 4
      ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
      : "";

    if (magic === MAGIC) {
      return openPatternDictionaryFile(bytes);
    }

    if (magic === "BPAL") {
      return openBlockPaletteFileForRandomAccess(bytes);
    }

    throw new RangeError("Unsupported random-access image magic");
  }

  function openPatternDictionaryFile(input) {
    const bytes = asUint8Array(input);

    if (bytes.length < HEADER_BYTES) {
      throw new RangeError("Truncated BPDI header");
    }

    for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
      if (bytes[index] !== MAGIC_BYTES[index]) {
        throw new RangeError("Invalid BPDI magic");
      }
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(4);

    if (version !== VERSION) {
      throw new RangeError(`Unsupported BPDI version: ${version}`);
    }

    const flags = view.getUint8(5);
    const blockSizeExponent = view.getUint8(6);
    const localIndexBits = view.getUint8(7);
    const globalIndexBits = view.getUint8(8);
    const paletteIndexBits = view.getUint8(9);
    const paletteColorBits = view.getUint8(10);
    const checkpointLog2 = view.getUint8(11);
    const width = view.getUint32(12, true);
    const height = view.getUint32(16, true);
    const dictionarySize = view.getUint16(20, true);
    const reserved = view.getUint16(22, true);
    const payloadBits = view.getUint32(24, true);

    validateHeader({
      flags,
      blockSizeExponent,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      paletteColorBits,
      checkpointLog2,
      width,
      height,
      dictionarySize,
      reserved,
    });

    const blockSize = 2 ** blockSizeExponent;
    const localColorCount = 2 ** localIndexBits;
    const globalColorCount = 2 ** globalIndexBits;
    const paletteCount = 2 ** paletteIndexBits;
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const blockCount = blocksX * blocksY;
    const pixelsPerBlock = blockSize * blockSize;
    const directPixelColors = (flags & 1) !== 0;
    const prototypeIndexBits = dictionarySize > 0 ? Math.log2(dictionarySize) : 0;
    const editCountBits = Math.ceil(Math.log2(pixelsPerBlock + 1));
    const tagBits = dictionarySize > 0
      ? 2 + prototypeIndexBits + editCountBits
      : 0;
    const groupCount = dictionarySize > 0
      ? Math.ceil(blockCount / 2 ** checkpointLog2)
      : 0;
    const paletteStart = HEADER_BYTES * 8;
    const paletteBits = paletteCount * globalColorCount * paletteColorBits;
    const selectorStart = paletteStart + paletteBits;
    const selectorBits = blockCount * paletteIndexBits;
    const blockPaletteStart = selectorStart + selectorBits;
    const blockPaletteBits = blockCount * localColorCount * globalIndexBits;
    const dictionaryStart = blockPaletteStart + blockPaletteBits;
    const dictionaryBits = dictionarySize * pixelsPerBlock * localIndexBits;
    const tagsStart = dictionaryStart + dictionaryBits;
    const tagsBits = blockCount * tagBits;
    const directoryStart = tagsStart + tagsBits;
    const directoryBits = dictionarySize > 0 ? (groupCount + 1) * 32 : 0;
    const payloadStart = directoryStart + directoryBits;
    const expectedBits = payloadStart + payloadBits;

    if (Math.ceil(expectedBits / 8) !== bytes.length) {
      throw new RangeError("BPDI file size does not match its header");
    }

    if (directPixelColors && (dictionarySize !== 0 || payloadBits !== 0)) {
      throw new RangeError("Direct-color BPDI files cannot contain pixel dictionaries");
    }

    if (!directPixelColors && dictionarySize === 0 && payloadBits !== width * height * localIndexBits) {
      throw new RangeError("Raw BPDI pixel payload has an invalid size");
    }

    if (dictionarySize > 0) {
      const firstOffset = readBits(bytes, directoryStart, 32);
      const lastOffset = readBits(bytes, directoryStart + groupCount * 32, 32);

      if (firstOffset !== 0 || lastOffset !== payloadBits) {
        throw new RangeError("Invalid BPDI checkpoint directory");
      }
    }

    const layout = {
      paletteStart,
      selectorStart,
      blockPaletteStart,
      dictionaryStart,
      tagsStart,
      directoryStart,
      payloadStart,
      tagBits,
      prototypeIndexBits,
      editCountBits,
      positionBits: Math.log2(pixelsPerBlock),
      checkpointInterval: 2 ** checkpointLog2,
      groupCount,
    };

    function getPixelIndex(x, y) {
      validateCoordinate(x, width, "x");
      validateCoordinate(y, height, "y");

      const blockX = Math.floor(x / blockSize);
      const blockY = Math.floor(y / blockSize);
      const blockIndex = blockY * blocksX + blockX;
      const localPosition = y % blockSize * blockSize + x % blockSize;

      if (directPixelColors) {
        return localPosition;
      }

      if (dictionarySize === 0) {
        return readBits(
          bytes,
          payloadStart + (y * width + x) * localIndexBits,
          localIndexBits
        );
      }

      const tag = readTag(bytes, layout, blockIndex);
      const blockPayload = findBlockPayload(bytes, layout, blockIndex, pixelsPerBlock, localIndexBits);

      if (tag.mode === MODE_RAW) {
        return readBits(
          bytes,
          blockPayload + localPosition * localIndexBits,
          localIndexBits
        );
      }

      const editBits = layout.positionBits + localIndexBits;

      if (tag.mode === MODE_RUNS) {
        let value = readBits(bytes, blockPayload, localIndexBits);

        for (let change = 0; change < tag.editCount; change += 1) {
          const changeOffset = blockPayload + localIndexBits + change * editBits;
          const position = readBits(bytes, changeOffset, layout.positionBits);

          if (position > localPosition) {
            break;
          }

          value = readBits(bytes, changeOffset + layout.positionBits, localIndexBits);
        }

        return value;
      }

      let value = readBits(
        bytes,
        dictionaryStart +
          (tag.prototypeIndex * pixelsPerBlock + localPosition) * localIndexBits,
        localIndexBits
      );

      for (let edit = 0; edit < tag.editCount; edit += 1) {
        const editOffset = blockPayload + edit * editBits;
        const position = readBits(bytes, editOffset, layout.positionBits);

        if (position === localPosition) {
          value = readBits(bytes, editOffset + layout.positionBits, localIndexBits);
          break;
        }

        if (position > localPosition) {
          break;
        }
      }

      return value;
    }

    function getPixel(x, y) {
      const localIndex = getPixelIndex(x, y);
      const blockX = Math.floor(x / blockSize);
      const blockY = Math.floor(y / blockSize);
      const blockIndex = blockY * blocksX + blockX;
      const selector = paletteIndexBits === 0
        ? 0
        : readBits(bytes, selectorStart + blockIndex * paletteIndexBits, paletteIndexBits);
      const globalIndex = readBits(
        bytes,
        blockPaletteStart +
          (blockIndex * localColorCount + localIndex) * globalIndexBits,
        globalIndexBits
      );
      const colorIndex = selector * globalColorCount + globalIndex;

      return readColorAt(bytes, paletteStart + colorIndex * paletteColorBits, paletteColorBits);
    }

    return {
      format: "bpdi",
      magic: MAGIC,
      version,
      width,
      height,
      blockSize,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
      dictionarySize,
      directPixelColors,
      blocksX,
      blocksY,
      blockCount,
      getPixel,
      getPixelIndex,
    };
  }

  function openBlockPaletteFileForRandomAccess(input) {
    const bytes = asUint8Array(input);

    if (bytes.length < 14) {
      throw new RangeError("Truncated BPAL header");
    }

    let offset = 32;
    const version = readBits(bytes, offset, 4);

    offset += 4;

    if (version !== 5) {
      throw new RangeError(`Unsupported BPAL version: ${version}`);
    }

    const width = readBits(bytes, offset, 24) + 1;

    offset += 24;
    const height = readBits(bytes, offset, 24) + 1;

    offset += 24;
    const blockSize = 2 ** (readBits(bytes, offset, 3) + 1);

    offset += 3;
    const localIndexBits = readBits(bytes, offset, 2) + 1;

    offset += 2;
    const globalIndexBits = readBits(bytes, offset, 4) + 1;

    offset += 4;
    const paletteColorBits = readBits(bytes, offset, 1) === 1 ? 24 : 16;

    offset += 1;
    const paletteMode = readBits(bytes, offset, 1);

    offset += 1;
    offset += 9; // Legacy vector count.
    offset += 1; // Legacy vector color space.
    const paletteIndexBits = readBits(bytes, offset, 3);

    offset += 3;
    const reserved = readBits(bytes, offset, 4);

    if (paletteMode !== 0) {
      throw new RangeError("Random access supports explicit BPAL palettes only");
    }

    if (reserved !== 0) {
      throw new RangeError("Unsupported BPAL flags");
    }

    const localColorCount = 2 ** localIndexBits;
    const globalColorCount = 2 ** globalIndexBits;
    const paletteCount = 2 ** paletteIndexBits;
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const blockCount = blocksX * blocksY;
    const directPixelColors = localColorCount === blockSize * blockSize;
    const paletteStart = 14 * 8;
    const selectorStart = paletteStart + paletteCount * globalColorCount * paletteColorBits;
    const blockPaletteStart = selectorStart + blockCount * paletteIndexBits;
    const pixelStart = blockPaletteStart + blockCount * localColorCount * globalIndexBits;
    const pixelBits = directPixelColors ? 0 : width * height * localIndexBits;
    const expectedBits = pixelStart + pixelBits;

    if (Math.ceil(expectedBits / 8) !== bytes.length) {
      throw new RangeError("BPAL file size does not match its header");
    }

    function getPixelIndex(x, y) {
      validateCoordinate(x, width, "x");
      validateCoordinate(y, height, "y");

      return directPixelColors
        ? y % blockSize * blockSize + x % blockSize
        : readBits(bytes, pixelStart + (y * width + x) * localIndexBits, localIndexBits);
    }

    function getPixel(x, y) {
      const blockIndex = Math.floor(y / blockSize) * blocksX + Math.floor(x / blockSize);
      const localIndex = getPixelIndex(x, y);
      const selector = paletteIndexBits === 0
        ? 0
        : readBits(bytes, selectorStart + blockIndex * paletteIndexBits, paletteIndexBits);
      const globalIndex = readBits(
        bytes,
        blockPaletteStart +
          (blockIndex * localColorCount + localIndex) * globalIndexBits,
        globalIndexBits
      );
      const colorIndex = selector * globalColorCount + globalIndex;

      return readColorAt(bytes, paletteStart + colorIndex * paletteColorBits, paletteColorBits);
    }

    return {
      format: "bpal",
      magic: "BPAL",
      version,
      width,
      height,
      blockSize,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
      dictionarySize: 0,
      directPixelColors,
      blocksX,
      blocksY,
      blockCount,
      getPixel,
      getPixelIndex,
    };
  }

  function chooseDictionaryEncoding(patterns, metadata, settings, checkpointInterval) {
    const maxDictionarySize = normalizePowerOfTwo(
      settings.maxDictionarySize,
      DEFAULT_MAX_DICTIONARY_SIZE,
      "maxDictionarySize"
    );
    const sampleLimit = normalizeInteger(
      settings.sampleLimit,
      DEFAULT_SAMPLE_LIMIT,
      1,
      65536,
      "sampleLimit"
    );
    const requestedDictionarySize = settings.forceDictionarySize === undefined
      ? null
      : normalizePowerOfTwo(settings.forceDictionarySize, null, "forceDictionarySize");
    const targetSize = requestedDictionarySize === null
      ? maxDictionarySize
      : Math.max(maxDictionarySize, requestedDictionarySize);
    const prototypes = buildPrototypeSequence(
      patterns,
      metadata.blockCount,
      metadata.pixelsPerBlock,
      targetSize,
      sampleLimit
    );
    const candidateSizes = [];

    for (let size = 1; size <= prototypes.length && size <= targetSize; size *= 2) {
      candidateSizes.push(size);
    }

    if (requestedDictionarySize !== null && !candidateSizes.includes(requestedDictionarySize)) {
      throw new RangeError("forceDictionarySize exceeds the number of distinct sampled patterns");
    }

    const candidates = evaluateDictionaries(
      patterns,
      prototypes,
      candidateSizes,
      metadata,
      checkpointInterval
    );
    const rawPayloadBits = metadata.width * metadata.height * metadata.localIndexBits;
    let selected = {
      dictionarySize: 0,
      dictionary: [],
      assignments: null,
      modes: null,
      counts: null,
      payloadBits: rawPayloadBits,
      pixelSectionBits: rawPayloadBits,
      rawBlocks: metadata.blockCount,
      referencedBlocks: 0,
      runLengthBlocks: 0,
      exactBlocks: 0,
      totalEdits: 0,
    };

    for (const candidate of candidates) {
      if (
        (requestedDictionarySize === null && candidate.pixelSectionBits < selected.pixelSectionBits) ||
        requestedDictionarySize === candidate.dictionarySize
      ) {
        selected = candidate;
      }
    }

    return selected;
  }

  function buildPrototypeSequence(patterns, blockCount, pixelsPerBlock, maximumSize, sampleLimit) {
    const sampleCount = Math.min(blockCount, sampleLimit);
    const frequencies = new Map();

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const blockIndex = Math.floor(sample * blockCount / sampleCount);
      const offset = blockIndex * pixelsPerBlock;
      const key = patternKey(patterns, offset, pixelsPerBlock);
      const existing = frequencies.get(key);

      if (existing) {
        existing.count += 1;
      } else {
        frequencies.set(key, { blockIndex, count: 1 });
      }
    }

    const entries = Array.from(frequencies.values());

    if (entries.length === 0) {
      return [];
    }

    let first = 0;

    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index].count > entries[first].count) {
        first = index;
      }
    }

    const prototypes = [];
    const nearestDistances = new Uint32Array(entries.length);

    nearestDistances.fill(pixelsPerBlock + 1);

    let selectedEntry = first;

    while (prototypes.length < maximumSize && prototypes.length < entries.length) {
      const prototype = patterns.slice(
        entries[selectedEntry].blockIndex * pixelsPerBlock,
        (entries[selectedEntry].blockIndex + 1) * pixelsPerBlock
      );

      prototypes.push(prototype);

      let nextEntry = -1;
      let bestScore = -1;

      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const entryOffset = entries[entryIndex].blockIndex * pixelsPerBlock;
        const distance = hammingDistance(
          patterns,
          entryOffset,
          prototype,
          nearestDistances[entryIndex]
        );

        if (distance < nearestDistances[entryIndex]) {
          nearestDistances[entryIndex] = distance;
        }

        const score = nearestDistances[entryIndex] *
          (1 + Math.log2(entries[entryIndex].count + 1));

        if (score > bestScore) {
          bestScore = score;
          nextEntry = entryIndex;
        }
      }

      if (nextEntry < 0 || bestScore <= 0) {
        break;
      }

      selectedEntry = nextEntry;
    }

    return prototypes;
  }

  function evaluateDictionaries(
    patterns,
    prototypes,
    candidateSizes,
    metadata,
    checkpointInterval
  ) {
    const states = candidateSizes.map((dictionarySize) => ({
      dictionarySize,
      dictionary: prototypes.slice(0, dictionarySize),
      assignments: new Uint16Array(metadata.blockCount),
      modes: new Uint8Array(metadata.blockCount),
      counts: new Uint16Array(metadata.blockCount),
      payloadBits: 0,
      rawBlocks: 0,
      referencedBlocks: 0,
      runLengthBlocks: 0,
      exactBlocks: 0,
      totalEdits: 0,
    }));
    const rawBlockBits = metadata.pixelsPerBlock * metadata.localIndexBits;
    const editBits = metadata.positionBits + metadata.localIndexBits;
    let stateIndex = 0;

    for (let block = 0; block < metadata.blockCount; block += 1) {
      const patternOffset = block * metadata.pixelsPerBlock;
      let bestDistance = metadata.pixelsPerBlock + 1;
      let bestPrototype = 0;
      let changeCount = 0;

      for (let position = 1; position < metadata.pixelsPerBlock; position += 1) {
        if (patterns[patternOffset + position] !== patterns[patternOffset + position - 1]) {
          changeCount += 1;
        }
      }

      stateIndex = 0;

      for (let prototypeIndex = 0; prototypeIndex < prototypes.length; prototypeIndex += 1) {
        const distance = hammingDistance(
          patterns,
          patternOffset,
          prototypes[prototypeIndex],
          bestDistance
        );

        if (distance < bestDistance) {
          bestDistance = distance;
          bestPrototype = prototypeIndex;
        }

        if (
          stateIndex < states.length &&
          prototypeIndex + 1 === states[stateIndex].dictionarySize
        ) {
          const state = states[stateIndex];
          const deltaBits = bestDistance * editBits;
          const runBits = metadata.localIndexBits + changeCount * editBits;
          let mode = MODE_RAW;
          let blockPayloadBits = rawBlockBits;
          let count = 0;

          if (runBits < blockPayloadBits) {
            mode = MODE_RUNS;
            blockPayloadBits = runBits;
            count = changeCount;
          }

          if (deltaBits < blockPayloadBits) {
            mode = MODE_DICTIONARY;
            blockPayloadBits = deltaBits;
            count = bestDistance;
          }

          state.assignments[block] = bestPrototype;
          state.modes[block] = mode;
          state.counts[block] = count;
          state.payloadBits += blockPayloadBits;
          state.rawBlocks += mode === MODE_RAW ? 1 : 0;
          state.referencedBlocks += mode === MODE_DICTIONARY ? 1 : 0;
          state.runLengthBlocks += mode === MODE_RUNS ? 1 : 0;
          state.exactBlocks += mode === MODE_DICTIONARY && bestDistance === 0 ? 1 : 0;
          state.totalEdits += count;
          stateIndex += 1;
        }
      }
    }

    for (const state of states) {
      const prototypeIndexBits = Math.log2(state.dictionarySize);
      const editCountBits = Math.ceil(Math.log2(metadata.pixelsPerBlock + 1));
      const dictionaryBits = state.dictionarySize *
        metadata.pixelsPerBlock * metadata.localIndexBits;
      const tagsBits = metadata.blockCount *
        (2 + prototypeIndexBits + editCountBits);
      const groupCount = Math.ceil(metadata.blockCount / checkpointInterval);
      const directoryBits = (groupCount + 1) * 32;

      state.pixelSectionBits = dictionaryBits + tagsBits + directoryBits + state.payloadBits;
    }

    return states;
  }

  function canonicalizeBlocks(metadata) {
    const patterns = new Uint8Array(metadata.blockCount * metadata.pixelsPerBlock);
    const blockPaletteIndices = new Uint16Array(metadata.blockCount * metadata.localColorCount);

    for (let blockY = 0; blockY < metadata.blocksY; blockY += 1) {
      for (let blockX = 0; blockX < metadata.blocksX; blockX += 1) {
        const blockIndex = blockY * metadata.blocksX + blockX;
        const blockOffset = blockIndex * metadata.localColorCount;
        const patternOffset = blockIndex * metadata.pixelsPerBlock;
        const usage = new Uint32Array(metadata.localColorCount);

        for (let localY = 0; localY < metadata.blockSize; localY += 1) {
          const y = blockY * metadata.blockSize + localY;

          if (y >= metadata.height) {
            continue;
          }

          for (let localX = 0; localX < metadata.blockSize; localX += 1) {
            const x = blockX * metadata.blockSize + localX;

            if (x < metadata.width) {
              usage[metadata.pixelIndices[y * metadata.width + x]] += 1;
            }
          }
        }

        const selector = metadata.blockPaletteSelectors[blockIndex];
        const entries = Array.from({ length: metadata.localColorCount }, (_, oldIndex) => {
          const globalIndex = metadata.blockPaletteIndices[blockOffset + oldIndex];
          const color = metadata.palette[selector * metadata.globalColorCount + globalIndex];

          return {
            oldIndex,
            globalIndex,
            usage: usage[oldIndex],
            color,
            luma: 2126 * color.r + 7152 * color.g + 722 * color.b,
          };
        });

        entries.sort((left, right) => (
          Number(right.usage > 0) - Number(left.usage > 0) ||
          left.luma - right.luma ||
          left.color.r - right.color.r ||
          left.color.g - right.color.g ||
          left.color.b - right.color.b ||
          left.globalIndex - right.globalIndex ||
          left.oldIndex - right.oldIndex
        ));

        const oldToNew = new Uint8Array(metadata.localColorCount);

        entries.forEach((entry, newIndex) => {
          oldToNew[entry.oldIndex] = newIndex;
          blockPaletteIndices[blockOffset + newIndex] = entry.globalIndex;
        });

        for (let localY = 0; localY < metadata.blockSize; localY += 1) {
          const y = blockY * metadata.blockSize + localY;

          for (let localX = 0; localX < metadata.blockSize; localX += 1) {
            const x = blockX * metadata.blockSize + localX;
            const localPosition = localY * metadata.blockSize + localX;

            patterns[patternOffset + localPosition] = x < metadata.width && y < metadata.height
              ? oldToNew[metadata.pixelIndices[y * metadata.width + x]]
              : 0;
          }
        }
      }
    }

    return { blockPaletteIndices, patterns };
  }

  function calculateFixedLayout(metadata, normalized, dictionaryEncoding) {
    const paletteBits = metadata.palette.length * metadata.paletteColorBits;
    const selectorBits = metadata.blockCount * metadata.paletteIndexBits;
    const blockPaletteBits = normalized.blockPaletteIndices.length * metadata.globalIndexBits;
    const dictionaryBits = dictionaryEncoding.dictionarySize *
      metadata.pixelsPerBlock * metadata.localIndexBits;
    const tagBits = dictionaryEncoding.dictionarySize > 0
      ? metadata.blockCount * (
        2 +
        Math.log2(dictionaryEncoding.dictionarySize) +
        Math.ceil(Math.log2(metadata.pixelsPerBlock + 1))
      )
      : 0;

    return {
      paletteBits,
      selectorBits,
      blockPaletteBits,
      dictionaryBits,
      tagBits,
      fixedBits: paletteBits + selectorBits + blockPaletteBits + dictionaryBits + tagBits,
    };
  }

  function calculateGroupOffsets(metadata, encoding, checkpointInterval) {
    const groupCount = Math.ceil(metadata.blockCount / checkpointInterval);
    const offsets = new Uint32Array(groupCount + 1);
    const rawBlockBits = metadata.pixelsPerBlock * metadata.localIndexBits;
    const editBits = metadata.positionBits + metadata.localIndexBits;
    let payloadBits = 0;

    for (let group = 0; group < groupCount; group += 1) {
      offsets[group] = payloadBits;
      const end = Math.min(metadata.blockCount, (group + 1) * checkpointInterval);

      for (let block = group * checkpointInterval; block < end; block += 1) {
        const mode = encoding.modes[block];

        if (mode === MODE_RAW) {
          payloadBits += rawBlockBits;
        } else if (mode === MODE_RUNS) {
          payloadBits += metadata.localIndexBits + encoding.counts[block] * editBits;
        } else {
          payloadBits += encoding.counts[block] * editBits;
        }
      }
    }

    if (payloadBits >= 2 ** 32) {
      throw new RangeError("BPDI pixel payload exceeds the 32-bit checkpoint range");
    }

    offsets[groupCount] = payloadBits;
    return offsets;
  }

  function writeHeader(bytes, metadata, encoding, checkpointLog2, payloadBits) {
    bytes.set(MAGIC_BYTES, 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    view.setUint8(4, VERSION);
    view.setUint8(5, metadata.directPixelColors ? 1 : 0);
    view.setUint8(6, Math.log2(metadata.blockSize));
    view.setUint8(7, metadata.localIndexBits);
    view.setUint8(8, metadata.globalIndexBits);
    view.setUint8(9, metadata.paletteIndexBits);
    view.setUint8(10, metadata.paletteColorBits);
    view.setUint8(11, checkpointLog2);
    view.setUint32(12, metadata.width, true);
    view.setUint32(16, metadata.height, true);
    view.setUint16(20, encoding.dictionarySize, true);
    view.setUint16(22, 0, true);
    view.setUint32(24, payloadBits, true);
  }

  function writePalette(writer, palette, paletteColorBits) {
    for (const color of palette) {
      if (paletteColorBits === 16) {
        writer.write(packRgb565(color), 16);
      } else {
        writer.write(color.r, 8);
        writer.write(color.g, 8);
        writer.write(color.b, 8);
      }
    }
  }

  function writeTags(writer, metadata, encoding) {
    const prototypeIndexBits = Math.log2(encoding.dictionarySize);
    const editCountBits = Math.ceil(Math.log2(metadata.pixelsPerBlock + 1));
    for (let block = 0; block < metadata.blockCount; block += 1) {
      const mode = encoding.modes[block];

      writer.write(mode, 2);
      writer.write(
        mode === MODE_DICTIONARY ? encoding.assignments[block] : 0,
        prototypeIndexBits
      );
      writer.write(mode === MODE_RAW ? 0 : encoding.counts[block], editCountBits);
    }
  }

  function writeDictionaryPayload(writer, patterns, metadata, encoding) {
    for (let block = 0; block < metadata.blockCount; block += 1) {
      const patternOffset = block * metadata.pixelsPerBlock;
      const mode = encoding.modes[block];

      if (mode === MODE_RAW) {
        for (let position = 0; position < metadata.pixelsPerBlock; position += 1) {
          writer.write(patterns[patternOffset + position], metadata.localIndexBits);
        }
      } else if (mode === MODE_RUNS) {
        let previous = patterns[patternOffset];

        writer.write(previous, metadata.localIndexBits);

        for (let position = 1; position < metadata.pixelsPerBlock; position += 1) {
          const value = patterns[patternOffset + position];

          if (value !== previous) {
            writer.write(position, metadata.positionBits);
            writer.write(value, metadata.localIndexBits);
            previous = value;
          }
        }
      } else {
        const prototype = encoding.dictionary[encoding.assignments[block]];

        for (let position = 0; position < metadata.pixelsPerBlock; position += 1) {
          const value = patterns[patternOffset + position];

          if (value !== prototype[position]) {
            writer.write(position, metadata.positionBits);
            writer.write(value, metadata.localIndexBits);
          }
        }
      }
    }
  }

  function writeLinearPixelIndices(writer, patterns, metadata) {
    for (let y = 0; y < metadata.height; y += 1) {
      const blockY = Math.floor(y / metadata.blockSize);
      const localY = y % metadata.blockSize;

      for (let x = 0; x < metadata.width; x += 1) {
        const blockX = Math.floor(x / metadata.blockSize);
        const localX = x % metadata.blockSize;
        const blockIndex = blockY * metadata.blocksX + blockX;
        const patternOffset = blockIndex * metadata.pixelsPerBlock;

        writer.write(
          patterns[patternOffset + localY * metadata.blockSize + localX],
          metadata.localIndexBits
        );
      }
    }
  }

  function createEncodingStats(metadata, encoding, fixedLayout, directoryBits, fileBytes) {
    const originalPixelBits = metadata.directPixelColors
      ? 0
      : metadata.width * metadata.height * metadata.localIndexBits;
    const encodedPixelBits = metadata.directPixelColors
      ? 0
      : fixedLayout.dictionaryBits + fixedLayout.tagBits + directoryBits + encoding.payloadBits;

    return {
      width: metadata.width,
      height: metadata.height,
      blockCount: metadata.blockCount,
      dictionarySize: encoding.dictionarySize,
      originalPixelBits,
      encodedPixelBits,
      pixelSavingsRatio: originalPixelBits === 0
        ? 0
        : 1 - encodedPixelBits / originalPixelBits,
      payloadBits: encoding.payloadBits,
      directoryBits,
      rawBlocks: encoding.rawBlocks,
      referencedBlocks: encoding.referencedBlocks,
      runLengthBlocks: encoding.runLengthBlocks,
      exactBlocks: encoding.exactBlocks,
      totalEdits: encoding.totalEdits,
      fileBytes,
    };
  }

  function createDirectEncoding() {
    return {
      dictionarySize: 0,
      dictionary: [],
      assignments: null,
      modes: null,
      counts: null,
      payloadBits: 0,
      pixelSectionBits: 0,
      rawBlocks: 0,
      referencedBlocks: 0,
      runLengthBlocks: 0,
      exactBlocks: 0,
      totalEdits: 0,
    };
  }

  function readTag(bytes, layout, blockIndex) {
    let offset = layout.tagsStart + blockIndex * layout.tagBits;
    const mode = readBits(bytes, offset, 2);

    offset += 2;

    if (mode > MODE_RUNS) {
      throw new RangeError("Invalid BPDI block mode");
    }

    const prototypeIndex = readBits(bytes, offset, layout.prototypeIndexBits);

    offset += layout.prototypeIndexBits;

    return {
      mode,
      prototypeIndex,
      editCount: readBits(bytes, offset, layout.editCountBits),
    };
  }

  function findBlockPayload(bytes, layout, blockIndex, pixelsPerBlock, localIndexBits) {
    const group = Math.floor(blockIndex / layout.checkpointInterval);
    const firstBlock = group * layout.checkpointInterval;
    let relativeOffset = readBits(bytes, layout.directoryStart + group * 32, 32);
    const rawBlockBits = pixelsPerBlock * localIndexBits;
    const editBits = layout.positionBits + localIndexBits;

    for (let block = firstBlock; block < blockIndex; block += 1) {
      const tag = readTag(bytes, layout, block);

      if (tag.mode === MODE_RAW) {
        relativeOffset += rawBlockBits;
      } else if (tag.mode === MODE_RUNS) {
        relativeOffset += localIndexBits + tag.editCount * editBits;
      } else {
        relativeOffset += tag.editCount * editBits;
      }
    }

    return layout.payloadStart + relativeOffset;
  }

  function readColorAt(bytes, bitOffset, paletteColorBits) {
    if (paletteColorBits === 16) {
      const value = readBits(bytes, bitOffset, 16);

      return {
        r: Math.round((value >> 11 & 31) * 255 / 31),
        g: Math.round((value >> 5 & 63) * 255 / 63),
        b: Math.round((value & 31) * 255 / 31),
        a: 255,
      };
    }

    return {
      r: readBits(bytes, bitOffset, 8),
      g: readBits(bytes, bitOffset + 8, 8),
      b: readBits(bytes, bitOffset + 16, 8),
      a: 255,
    };
  }

  function validateImage(image) {
    if (!image || typeof image !== "object") {
      throw new TypeError("BPDI image must be an object");
    }

    const width = positiveInteger(image.width, "width");
    const height = positiveInteger(image.height, "height");
    const blockSize = positivePowerOfTwo(image.blockSize, "blockSize");
    const localColorCount = positivePowerOfTwo(image.localColorCount, "localColorCount");
    const globalColorCount = positivePowerOfTwo(image.globalColorCount, "globalColorCount");
    const paletteCount = positivePowerOfTwo(image.paletteCount || 1, "paletteCount");
    const paletteColorBits = Number(image.paletteColorBits);

    if (paletteColorBits !== 16 && paletteColorBits !== 24) {
      throw new RangeError("paletteColorBits must be 16 or 24");
    }

    if (localColorCount > blockSize * blockSize || localColorCount > globalColorCount) {
      throw new RangeError("Invalid BPDI local color count");
    }

    if (
      blockSize > 64 ||
      localColorCount > 16 ||
      globalColorCount > 4096 ||
      paletteCount > 128
    ) {
      throw new RangeError("BPDI settings exceed the supported format limits");
    }

    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const blockCount = blocksX * blocksY;
    const directPixelColors = localColorCount === blockSize * blockSize;
    const palette = image.palette;

    if (!Array.isArray(palette) || palette.length !== paletteCount * globalColorCount) {
      throw new RangeError("BPDI palette has an invalid length");
    }

    const blockPaletteSelectors = image.blockPaletteSelectors || new Uint8Array(blockCount);

    validateArray(blockPaletteSelectors, blockCount, paletteCount, "blockPaletteSelectors");
    validateArray(
      image.blockPaletteIndices,
      blockCount * localColorCount,
      globalColorCount,
      "blockPaletteIndices"
    );
    validateArray(image.pixelIndices, width * height, localColorCount, "pixelIndices");

    return {
      width,
      height,
      blockSize,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
      palette,
      blockPaletteSelectors,
      blockPaletteIndices: image.blockPaletteIndices,
      pixelIndices: image.pixelIndices,
      blocksX,
      blocksY,
      blockCount,
      pixelsPerBlock: blockSize * blockSize,
      localIndexBits: Math.log2(localColorCount),
      globalIndexBits: Math.log2(globalColorCount),
      paletteIndexBits: Math.log2(paletteCount),
      positionBits: Math.log2(blockSize * blockSize),
      directPixelColors,
    };
  }

  function validateHeader(header) {
    if (header.flags & ~1 || header.reserved !== 0) {
      throw new RangeError("Unsupported BPDI flags");
    }

    if (
      header.width <= 0 ||
      header.height <= 0 ||
      header.blockSizeExponent < 1 ||
      header.blockSizeExponent > 6 ||
      header.localIndexBits < 1 ||
      header.localIndexBits > 4 ||
      header.globalIndexBits < header.localIndexBits ||
      header.globalIndexBits > 12 ||
      header.paletteIndexBits > 7 ||
      (header.paletteColorBits !== 16 && header.paletteColorBits !== 24) ||
      header.checkpointLog2 > 12 ||
      (header.dictionarySize !== 0 && !isPowerOfTwo(header.dictionarySize))
    ) {
      throw new RangeError("Invalid BPDI header fields");
    }

    const blockSize = 2 ** header.blockSizeExponent;

    if (2 ** header.localIndexBits > blockSize * blockSize) {
      throw new RangeError("BPDI local palette does not fit in a block");
    }
  }

  function validateArray(array, length, upperBound, name) {
    if (!array || typeof array.length !== "number" || array.length !== length) {
      throw new RangeError(`${name} has an invalid length`);
    }

    for (const value of array) {
      if (!Number.isInteger(value) || value < 0 || value >= upperBound) {
        throw new RangeError(`${name} contains an invalid index`);
      }
    }
  }

  function validateCoordinate(value, limit, name) {
    if (!Number.isInteger(value) || value < 0 || value >= limit) {
      throw new RangeError(`${name} coordinate is outside the image`);
    }
  }

  function packRgb565(color) {
    const red = Math.round(color.r * 31 / 255);
    const green = Math.round(color.g * 63 / 255);
    const blue = Math.round(color.b * 31 / 255);

    return (red << 11) | (green << 5) | blue;
  }

  function patternKey(patterns, offset, length) {
    let key = "";

    for (let index = 0; index < length; index += 1) {
      key += String.fromCharCode(patterns[offset + index]);
    }

    return key;
  }

  function hammingDistance(patterns, offset, prototype, cutoff) {
    let distance = 0;

    for (let index = 0; index < prototype.length; index += 1) {
      distance += patterns[offset + index] !== prototype[index] ? 1 : 0;

      if (distance >= cutoff) {
        return distance;
      }
    }

    return distance;
  }

  function readBits(bytes, bitOffset, bitCount) {
    let value = 0;

    if (bitOffset + bitCount > bytes.length * 8) {
      throw new RangeError("Truncated BPDI bit stream");
    }

    for (let bit = 0; bit < bitCount; bit += 1) {
      const byteIndex = Math.floor(bitOffset / 8);
      const bitInByte = 7 - bitOffset % 8;

      value = value * 2 + (bytes[byteIndex] >> bitInByte & 1);
      bitOffset += 1;
    }

    return value;
  }

  function asUint8Array(input) {
    if (input instanceof Uint8Array) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }

    throw new TypeError("BPDI input must be an ArrayBuffer or Uint8Array");
  }

  function normalizePowerOfTwo(value, fallback, name) {
    const normalized = value === undefined || value === null ? fallback : Number(value);

    if (!isPowerOfTwo(normalized) || normalized > 1024) {
      throw new RangeError(`${name} must be a power of two from 1 to 1024`);
    }

    return normalized;
  }

  function normalizeInteger(value, fallback, minimum, maximum, name) {
    const normalized = value === undefined || value === null ? fallback : Number(value);

    if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
      throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
    }

    return normalized;
  }

  function positiveInteger(value, name) {
    const normalized = Number(value);

    if (!Number.isInteger(normalized) || normalized <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }

    return normalized;
  }

  function positivePowerOfTwo(value, name) {
    const normalized = positiveInteger(value, name);

    if (!isPowerOfTwo(normalized)) {
      throw new RangeError(`${name} must be a power of two`);
    }

    return normalized;
  }

  function isPowerOfTwo(value) {
    return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
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
        throw new RangeError("BPDI output buffer is too small");
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

  return {
    MAGIC,
    VERSION,
    HEADER_BYTES,
    encodePatternDictionaryFile,
    encodeSmallestRandomAccessFile,
    openRandomAccessImageFile,
    openPatternDictionaryFile,
  };
});
