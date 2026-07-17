(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.DctImageFormat = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // Adapted from the self-contained converter preserved at
  // docs/reference/dct-chat/dctbs_converter_with_edge_dictionary.html.
  // New files use independent 16x16 YCbCr 4:2:0 MCUs. A header flag
  // distinguishes them from the still-readable earlier 4:2:2 layout.

  const MAGIC = Object.freeze([0x44, 0x43, 0x54, 0x42, 0x53, 0x32, 0x00, 0x00]);
  const VERSION = 2;
  const HEADER_BYTES = 64;
  const FLAG_AUTO_QUALITY = 1;
  const FLAG_SPLIT_LUMA_8X8 = 2;
  const FLAG_DCT_LIBRARY = 4;
  const FLAG_CHROMA_420 = 8;
  const FLAG_ZIGZAG_ORDER = 16;
  const COEFFICIENT_CODING_SHIFT = 8;
  const COEFFICIENT_CODING_MASK = 15 << COEFFICIENT_CODING_SHIFT;
  const SUPPORTED_FLAGS = FLAG_AUTO_QUALITY | FLAG_SPLIT_LUMA_8X8 | FLAG_DCT_LIBRARY |
    FLAG_CHROMA_420 | FLAG_ZIGZAG_ORDER | COEFFICIENT_CODING_MASK;
  const MCU_WIDTH = 16;
  const MCU_HEIGHT = 16;
  const CHROMA_WIDTH = 8;
  const CHROMA_HEIGHT_420 = 8;
  const CHROMA_HEIGHT_422 = 16;
  const SCALE_MULTIPLIERS = Object.freeze([1, 2, 4, 8, 16, 32, 64, 128]);
  const PROFILE_NAMES = Object.freeze(["low frequency", "horizontal", "vertical", "diagonal"]);
  const ZIGZAG_PROFILE_NAME = "zigzag";
  const SKIP_PROFILE_NAMES = Object.freeze([
    "low frequency",
    "horizontal",
    "vertical",
    "cross",
    "diagonal",
    "off diagonal",
    "middle frequency",
    "edge frequency",
  ]);
  const LIBRARY_MAGIC = Object.freeze([0x44, 0x43, 0x54, 0x4c, 0x49, 0x42, 0x31, 0x00]);
  const LIBRARY_VERSION_TAIL_REFERENCE = 1;
  const LIBRARY_VERSION_HEADER_REFERENCE = 2;
  const LIBRARY_VERSION_SPECTRAL_QUARTER = 3;
  const LIBRARY_VERSION_SPECTRAL_HALF = 4;
  const LIBRARY_VERSION_SPECTRAL_FULL = 5;
  const LIBRARY_VERSION_SIDECAR_REFERENCE = 6;
  const LIBRARY_VERSION_SIDECAR_SPECTRAL_QUARTER = 7;
  const LIBRARY_VERSION_SIDECAR_SPECTRAL_HALF = 8;
  const LIBRARY_VERSION_SIDECAR_SPECTRAL_FULL = 9;
  const LIBRARY_HEADER_BYTES = 32;
  const DEFAULT_LIBRARY_SIZE = 8;
  const LIBRARY_CLUSTER_ITERATIONS = 6;
  const LIBRARY_CLUSTER_FEATURES = 32;
  const COEFFICIENT_CODINGS = Object.freeze([
    freezeCoefficientCoding("legacy", 6, 0, "shared"),
    freezeCoefficientCoding("grouped-5-equal-2", 5, 2, "equal"),
    freezeCoefficientCoding("grouped-5-front", 5, 3, "front"),
    freezeCoefficientCoding("skip-rle-equal-2", 5, 2, "equal", "single"),
    freezeCoefficientCoding("dual-scale-skip-equal-2", 5, 2, "equal", "dual"),
    freezeCoefficientCoding("dual-scale-skip-front", 5, 3, "front", "dual"),
    freezeCoefficientCoding("masked-tail-8x8", 5, 3, "front", null, true),
    freezeCoefficientCoding(
      "masked-tail-implicit2-48",
      5,
      3,
      "front",
      null,
      true,
      "implicit2-48"
    ),
  ]);
  const MASKED_TAIL_CONFIGS = Object.freeze({
    16: Object.freeze({ dcBits: 10, acBits: 6, maxAc: 9 }),
    24: Object.freeze({ dcBits: 9, acBits: 7, maxAc: 17 }),
    32: Object.freeze({ dcBits: 8, acBits: 8, maxAc: 23 }),
    40: Object.freeze({ dcBits: 8, acBits: 8, maxAc: 31 }),
    48: Object.freeze({ dcBits: 10, acBits: 8, maxAc: 38 }),
  });
  const MASKED_TAIL_IMPLICIT2_CONFIGS = Object.freeze({
    48: Object.freeze({
      dcBits: 10,
      acBits: 8,
      maxAc: 39,
      implicitPositions: Object.freeze([1, 8]),
    }),
  });
  // Higher-rate modes preserve the reference converter's four-luma-to-two-chroma
  // byte ratio. Chroma sampling is selected independently by the header flag.
  const PRESETS = Object.freeze({
    "9": freezePreset(9000, 9, 288, 192, 48, 48),
    "7.5": freezePreset(7500, 7.5, 240, 160, 40, 40),
    "6": freezePreset(6000, 6, 192, 128, 32, 32),
    "4.5": freezePreset(4500, 4.5, 144, 96, 24, 24),
    "3": freezePreset(3000, 3, 96, 64, 16, 16),
    "2": freezePreset(2000, 2, 64, 32, 16, 16),
    "1.5": freezePreset(1500, 1.5, 48, 24, 12, 12),
    "1": freezePreset(1000, 1, 32, 16, 8, 8),
    "0.75": freezePreset(750, 0.75, 24, 12, 6, 6),
  });
  const FAST_COMPONENT_BUDGETS = Object.freeze({
    "3": Object.freeze([6, 12, 20]),
    "2": Object.freeze([6, 5]),
    "1.5": Object.freeze([5, 4]),
    "1": Object.freeze([5, 4]),
    "0.75": Object.freeze([4, 3]),
  });
  const EXPANDED_COMPONENT_BUDGETS = Object.freeze({
    "3": Object.freeze([4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]),
    "2": Object.freeze([3, 4, 5, 6, 7, 8, 9, 10]),
    "1.5": Object.freeze([4, 5, 6, 7, 8, 9]),
    "1": Object.freeze([3, 4, 5, 6, 7, 8]),
    "0.75": Object.freeze([3, 4, 5, 6]),
  });
  const MODE_TO_PRESET = new Map(
    Object.entries(PRESETS).map(([key, preset]) => [preset.modeCode, key])
  );
  const LUMA_QUANTIZATION = Object.freeze([
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
  ]);
  const CHROMA_QUANTIZATION = Object.freeze([
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
  ]);
  const basisCache = new Map();
  const scanCache = new Map();
  const skipScanCache = new Map();
  const zigzagScanCache = new Map();
  const quantizationStepCache = new Map();
  const jpegDctMetadataCache = new WeakMap();
  const jpegDctSourceCache = new WeakMap();
  const jpegDctRecordCache = new WeakMap();
  const dctEncodingResultCache = new WeakMap();
  const ZERO_DCT_BLOCK = new Float64Array(64);

  function freezePreset(modeCode, bpp, bytesPerMcu, yBytes, cbBytes, crBytes) {
    return Object.freeze({ modeCode, bpp, bytesPerMcu, yBytes, cbBytes, crBytes });
  }

  function freezeCoefficientCoding(
    key,
    mantissaBits,
    groupCount,
    grouping,
    skipMode = null,
    maskedTail = false,
    maskedTailVariant = null
  ) {
    return Object.freeze({
      key,
      mantissaBits,
      groupCount,
      grouping,
      skipMode,
      maskedTail,
      maskedTailVariant,
    });
  }

  function getCoefficientCoding(key, presetKey) {
    const defaultKey = presetKey === "0.75"
      ? "skip-rle-equal-2"
      : presetKey === "1" || presetKey === "2"
        ? "dual-scale-skip-equal-2"
        : presetKey === "1.5" || presetKey === "3" || presetKey === "4.5"
          ? "dual-scale-skip-front"
          : "grouped-5-front";
    const normalized = String(key === undefined ? defaultKey : key);
    const coding = COEFFICIENT_CODINGS.find((candidate) => candidate.key === normalized);

    if (!coding) {
      throw new RangeError(`Unsupported DCT coefficient coding: ${key}`);
    }

    return coding;
  }

  function resolveCoefficientCoding(key, presetKey, options = {}) {
    const requested = getCoefficientCoding(key, presetKey);
    const coding = options.dctLibrary && requested.maskedTail
      ? getCoefficientCoding("grouped-5-front", presetKey)
      : requested;
    return withCoefficientOrder(coding, options.zigzagOrder !== false);
  }

  function withCoefficientOrder(coding, zigzagOrder) {
    return zigzagOrder ? Object.freeze({ ...coding, zigzagOrder: true }) : coding;
  }

  function getDctPreset(key) {
    const normalized = String(key === undefined ? "1.5" : key);
    const preset = PRESETS[normalized];

    if (!preset) {
      throw new RangeError(`Unsupported DCT preset: ${key}`);
    }

    return { key: normalized, ...preset };
  }

  function getDctFileLayout(width, height, presetKey) {
    validateDimensions(width, height);
    const preset = getDctPreset(presetKey);
    const mcuColumns = Math.ceil(width / MCU_WIDTH);
    const mcuRows = Math.ceil(height / MCU_HEIGHT);
    const mcuCount = mcuColumns * mcuRows;
    const payloadBytes = mcuCount * preset.bytesPerMcu;

    return {
      width,
      height,
      headerBytes: HEADER_BYTES,
      mcuWidth: MCU_WIDTH,
      mcuHeight: MCU_HEIGHT,
      mcuColumns,
      mcuRows,
      mcuCount,
      payloadBytes,
      totalBytes: HEADER_BYTES + payloadBytes,
      ...preset,
    };
  }

  function withComponentAllocation(layout, allocation, splitLuma8x8) {
    const yBytes = Number(allocation.yBytes);
    const cbBytes = Number(allocation.cbBytes);
    const crBytes = Number(allocation.crBytes);
    const yRecordBytes = splitLuma8x8 ? yBytes / 4 : yBytes;

    if (!Number.isInteger(yBytes) || !Number.isInteger(cbBytes) ||
        !Number.isInteger(crBytes) || yBytes + cbBytes + crBytes !== layout.bytesPerMcu ||
        yRecordBytes < 3 || !Number.isInteger(yRecordBytes) || cbBytes < 3 || crBytes < 3) {
      throw new RangeError("Invalid DCTBS2 component allocation");
    }

    return { ...layout, yBytes, cbBytes, crBytes };
  }

  function normalizeComponentBudget(value, presetKey) {
    const defaultMode = FAST_COMPONENT_BUDGETS[presetKey] ? "fast" : "fixed";
    const normalized = String(value === undefined ? defaultMode : value);
    if (!["fixed", "fast", "expanded"].includes(normalized)) {
      throw new RangeError(`Unsupported DCT component budget mode: ${value}`);
    }
    return FAST_COMPONENT_BUDGETS[presetKey] ? normalized : "fixed";
  }

  function componentAllocationLayouts(layout, mode, splitLuma8x8) {
    if (mode === "fixed") return [layout];
    const chromaBudgets = mode === "expanded"
      ? EXPANDED_COMPONENT_BUDGETS[layout.key]
      : FAST_COMPONENT_BUDGETS[layout.key];
    const allocations = [{
      yBytes: layout.yBytes,
      cbBytes: layout.cbBytes,
      crBytes: layout.crBytes,
    }];
    for (const chromaBytes of chromaBudgets || []) {
      allocations.push({
        yBytes: layout.bytesPerMcu - chromaBytes * 2,
        cbBytes: chromaBytes,
        crBytes: chromaBytes,
      });
    }
    const seen = new Set();
    return allocations.flatMap((allocation) => {
      const key = `${allocation.yBytes}:${allocation.cbBytes}:${allocation.crBytes}`;
      if (seen.has(key)) return [];
      seen.add(key);
      try {
        return [withComponentAllocation(layout, allocation, splitLuma8x8)];
      } catch (error) {
        if (error instanceof RangeError) return [];
        throw error;
      }
    });
  }

  function encodeDctFile(pixels, width, height, options = {}) {
    validatePixels(pixels, width, height);
    const quality = validateQuality(options.quality === undefined ? 72 : options.quality);
    const baseLayout = getDctFileLayout(width, height, options.preset);
    const chroma420 = resolveChroma420(options);
    const chromaHeight = chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422;
    const splitLuma8x8 = shouldSplitLuma(baseLayout, options);
    const layout = options.componentAllocation
      ? withComponentAllocation(baseLayout, options.componentAllocation, splitLuma8x8)
      : baseLayout;
    const componentBudget = normalizeComponentBudget(options.componentBudget, layout.key);

    if (!options.componentAllocation && !options.dctLibrary && componentBudget !== "fixed") {
      return selectBetterComponentAllocationEncoding(
        pixels,
        width,
        height,
        layout,
        splitLuma8x8,
        componentBudget,
        options,
        (candidateOptions) => encodeDctFile(pixels, width, height, candidateOptions)
      );
    }

    if (shouldAutoSelectMaskedTail(layout.key, options)) {
      return selectBetterHighRateEncoding(
        pixels,
        width,
        height,
        options,
        (candidateOptions) => encodeDctFile(pixels, width, height, candidateOptions)
      );
    }

    const coefficientCoding = resolveCoefficientCoding(options.coefficientCoding, layout.key, options);

    if (options.dctLibrary) {
      return encodeDctFileWithLibrary(
        pixels,
        width,
        height,
        layout,
        quality,
        splitLuma8x8,
        chroma420,
        coefficientCoding,
        options
      );
    }

    const output = createDctOutput(layout, quality, options, splitLuma8x8, coefficientCoding);
    const reportProgress = createDctProgressReporter(options, layout.mcuCount, quality);
    reportProgress(0);

    for (let mcuIndex = 0; mcuIndex < layout.mcuCount; mcuIndex += 1) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const planes = extractMcuPlanes(pixels, width, height, mcuX, mcuY, chroma420);
      const byteOffset = HEADER_BYTES + mcuIndex * layout.bytesPerMcu;

      encodeLuma(
        output,
        byteOffset,
        layout.yBytes,
        planes.y,
        quality,
        splitLuma8x8,
        coefficientCoding,
        true
      );
      encodeComponent(
        output,
        byteOffset + layout.yBytes,
        layout.cbBytes,
        planes.cb,
        8,
        chromaHeight,
        quality,
        true,
        coefficientCoding,
        splitLuma8x8
      );
      encodeComponent(
        output,
        byteOffset + layout.yBytes + layout.cbBytes,
        layout.crBytes,
        planes.cr,
        8,
        chromaHeight,
        quality,
        true,
        coefficientCoding,
        splitLuma8x8
      );
      reportProgress(mcuIndex + 1);
    }

    return output;
  }

  function encodeDctFileWithLibrary(
    pixels,
    width,
    height,
    layout,
    quality,
    splitLuma8x8,
    chroma420,
    coefficientCoding,
    options
  ) {
    const chromaHeight = chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422;
    const requestedLibrarySize = validateLibrarySize(
      options.librarySize === undefined ? DEFAULT_LIBRARY_SIZE : options.librarySize,
      coefficientCoding
    );
    const libraryFrequencySplit = normalizeLibraryFrequencySplit(options.libraryFrequencySplit);
    const requestedReferenceCoding = normalizeLibraryReferenceCoding(options.libraryReferenceCoding);
    const libraryClusterSamples = requestedReferenceCoding === "sidecar"
      ? normalizeLibraryClusterSamples(options.libraryClusterSamples) : 0;
    const libraryCandidateCount = requestedReferenceCoding === "sidecar"
      ? normalizeLibraryCandidateCount(options.libraryCandidateCount) : 0;
    const libraryComponents = normalizeLibraryComponents(options.libraryComponents);
    const progressTotal = layout.mcuCount * 2 + 3;
    const reportProgress = createDctProgressReporter(options, progressTotal, quality);
    reportProgress(0);
    const source = collectDctLibrarySource(
      pixels,
      width,
      height,
      layout,
      splitLuma8x8,
      chroma420,
      reportProgress
    );
    const yRecordBytes = splitLuma8x8 ? layout.yBytes / 4 : layout.yBytes;
    const yLibrary = buildDctPrototypeLibrary(
        source.yVectors,
        libraryComponents.has("y") ? requestedLibrarySize : 0,
        splitLuma8x8 ? 8 : 16,
        splitLuma8x8 ? 8 : 16,
        yRecordBytes,
        quality,
        false,
        coefficientCoding,
        libraryClusterSamples
      );
    reportProgress(layout.mcuCount + 1);
    const cbLibrary = buildDctPrototypeLibrary(
        source.cbVectors,
        libraryComponents.has("cb") ? requestedLibrarySize : 0,
        8,
        chromaHeight,
        layout.cbBytes,
        quality,
        true,
        coefficientCoding,
        libraryClusterSamples
      );
    reportProgress(layout.mcuCount + 2);
    const crLibrary = buildDctPrototypeLibrary(
        source.crVectors,
        libraryComponents.has("cr") ? requestedLibrarySize : 0,
        8,
        chromaHeight,
        layout.crBytes,
        quality,
        true,
        coefficientCoding,
        libraryClusterSamples
      );
    reportProgress(layout.mcuCount + 3);
    const library = {
      referenceCoding: requestedReferenceCoding === "sidecar" ? "sidecar" :
        Math.max(yLibrary.count, cbLibrary.count, crLibrary.count) <= 3 ? "header" : "tail",
      frequencySplit: libraryFrequencySplit,
      y: yLibrary,
      cb: cbLibrary,
      cr: crLibrary,
    };
    library.y.candidateCount = libraryCandidateCount;
    library.cb.candidateCount = libraryCandidateCount;
    library.cr.candidateCount = libraryCandidateCount;
    if (library.frequencySplit > 0 && library.referenceCoding === "tail") {
      throw new RangeError("Spectral-split DCT libraries require header or sidecar references");
    }
    if (library.referenceCoding === "tail" && requestedLibrarySize > 2 ** coefficientCoding.mantissaBits - 1) {
      throw new RangeError("Tail-reference DCT library is too large for the coefficient coding");
    }
    const trailer = serializeDctLibrary(layout, splitLuma8x8, library);
    const output = createDctOutput(
      layout,
      quality,
      options,
      splitLuma8x8,
      coefficientCoding,
      trailer.length
    );

    for (let mcuIndex = 0; mcuIndex < layout.mcuCount; mcuIndex += 1) {
      const record = source.mcus[mcuIndex];
      const byteOffset = HEADER_BYTES + mcuIndex * layout.bytesPerMcu;

      if (splitLuma8x8) {
        for (let blockIndex = 0; blockIndex < 4; blockIndex += 1) {
          const libraryIndex = encodeLibraryComponentCoefficients(
            output,
            byteOffset + blockIndex * yRecordBytes,
            yRecordBytes,
            record.y[blockIndex],
            8,
            8,
            quality,
            false,
            coefficientCoding,
            library.y,
            library.referenceCoding,
            library.frequencySplit
          );
          writeDctLibraryReference(
            trailer,
            library.y,
            mcuIndex * 4 + blockIndex,
            libraryIndex
          );
        }
      } else {
        const libraryIndex = encodeLibraryComponentCoefficients(
          output,
          byteOffset,
          layout.yBytes,
          record.y[0],
          16,
          16,
          quality,
          false,
          coefficientCoding,
          library.y,
          library.referenceCoding,
          library.frequencySplit
        );
        writeDctLibraryReference(trailer, library.y, mcuIndex, libraryIndex);
      }

      const cbLibraryIndex = encodeLibraryComponentCoefficients(
        output,
        byteOffset + layout.yBytes,
        layout.cbBytes,
        record.cb,
        8,
        chromaHeight,
        quality,
        true,
        coefficientCoding,
        library.cb,
        library.referenceCoding,
        library.frequencySplit
      );
      writeDctLibraryReference(trailer, library.cb, mcuIndex, cbLibraryIndex);
      const crLibraryIndex = encodeLibraryComponentCoefficients(
        output,
        byteOffset + layout.yBytes + layout.cbBytes,
        layout.crBytes,
        record.cr,
        8,
        chromaHeight,
        quality,
        true,
        coefficientCoding,
        library.cr,
        library.referenceCoding,
        library.frequencySplit
      );
      writeDctLibraryReference(trailer, library.cr, mcuIndex, crLibraryIndex);
      reportProgress(layout.mcuCount + 4 + mcuIndex);
    }

    output.set(trailer, HEADER_BYTES + layout.payloadBytes);
    return output;
  }

  function importJpegDctFile(jpeg, options = {}) {
    const metadata = getJpegDctMetadata(jpeg);
    const quality = validateQuality(options.quality === undefined ? 72 : options.quality);
    const baseLayout = getDctFileLayout(metadata.width, metadata.height, options.preset);
    const chroma420 = resolveChroma420(options);
    const chromaHeight = chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422;
    const splitLuma8x8 = shouldSplitLuma(baseLayout, options);
    const layout = options.componentAllocation
      ? withComponentAllocation(baseLayout, options.componentAllocation, splitLuma8x8)
      : baseLayout;
    const componentBudget = normalizeComponentBudget(options.componentBudget, layout.key);

    if (!options.componentAllocation && componentBudget !== "fixed" && options.referencePixels) {
      validatePixels(options.referencePixels, metadata.width, metadata.height);
      return selectBetterComponentAllocationEncoding(
        options.referencePixels,
        metadata.width,
        metadata.height,
        layout,
        splitLuma8x8,
        componentBudget,
        options,
        (candidateOptions) => importJpegDctFile(jpeg, candidateOptions)
      );
    }

    if (shouldAutoSelectMaskedTail(layout.key, options) && options.referencePixels) {
      validatePixels(options.referencePixels, metadata.width, metadata.height);
      return selectBetterHighRateEncoding(
        options.referencePixels,
        metadata.width,
        metadata.height,
        options,
        (candidateOptions) => importJpegDctFile(jpeg, candidateOptions)
      );
    }

    const coefficientCoding = resolveCoefficientCoding(options.coefficientCoding, layout.key, options);
    const directCoefficients = canUseDirectJpegDctCoefficients(
      metadata,
      layout,
      chroma420,
      splitLuma8x8,
      options
    );
    const source = directCoefficients ? metadata : getPreparedJpegDctSource(jpeg);
    const output = createDctOutput(layout, quality, options, splitLuma8x8, coefficientCoding);
    const reportProgress = createDctProgressReporter(options, layout.mcuCount, quality);
    const cacheKey = `${directCoefficients ? "direct" : "samples"}:` +
      `${chroma420 ? "420" : "422"}:${splitLuma8x8 ? "split" : "merged"}`;
    let records = getJpegDctRecordMap(jpeg).get(cacheKey);
    const cacheRecords = !records;
    if (!records) records = new Array(layout.mcuCount);
    reportProgress(0);

    for (let mcuIndex = 0; mcuIndex < layout.mcuCount; mcuIndex += 1) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const record = records[mcuIndex] || (directCoefficients
        ? mapDirectJpegMcuCoefficients(source, mcuX, mcuY)
        : transformJpegMcuCoefficients(source, mcuX, mcuY, chroma420, splitLuma8x8));
      records[mcuIndex] = record;
      const byteOffset = HEADER_BYTES + mcuIndex * layout.bytesPerMcu;

      encodeLumaCoefficientBlocks(
        output,
        byteOffset,
        layout.yBytes,
        record.y,
        quality,
        splitLuma8x8,
        coefficientCoding,
        true
      );
      encodeComponentCoefficients(
        output,
        byteOffset + layout.yBytes,
        layout.cbBytes,
        record.cb,
        8,
        chromaHeight,
        quality,
        true,
        coefficientCoding,
        splitLuma8x8
      );
      encodeComponentCoefficients(
        output,
        byteOffset + layout.yBytes + layout.cbBytes,
        layout.crBytes,
        record.cr,
        8,
        chromaHeight,
        quality,
        true,
        coefficientCoding,
        splitLuma8x8
      );
      reportProgress(mcuIndex + 1);
    }

    if (cacheRecords) getJpegDctRecordMap(jpeg).set(cacheKey, records);
    return output;
  }

  function getJpegDctMetadata(jpeg) {
    let metadata = jpegDctMetadataCache.get(jpeg);
    if (!metadata) {
      metadata = prepareJpegDctMetadata(jpeg);
      jpegDctMetadataCache.set(jpeg, metadata);
    }
    return metadata;
  }

  function getPreparedJpegDctSource(jpeg) {
    let source = jpegDctSourceCache.get(jpeg);
    if (!source) {
      source = reconstructJpegDctSource(getJpegDctMetadata(jpeg));
      jpegDctSourceCache.set(jpeg, source);
    }
    return source;
  }

  function decodeJpegDctPixels(jpeg) {
    const source = getPreparedJpegDctSource(jpeg);
    const pixels = new Uint8ClampedArray(source.width * source.height * 4);

    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const luma = sampleJpegComponent(source, 0, x, y);
        const cb = source.components.length === 3
          ? sampleJpegComponent(source, 1, x, y) : 128;
        const cr = source.components.length === 3
          ? sampleJpegComponent(source, 2, x, y) : 128;
        writeRgba(pixels, (y * source.width + x) * 4, yCbCrToRgba(luma, cb, cr));
      }
    }

    return { width: source.width, height: source.height, pixels };
  }

  function getJpegDctRecordMap(jpeg) {
    let records = jpegDctRecordCache.get(jpeg);
    if (!records) {
      records = new Map();
      jpegDctRecordCache.set(jpeg, records);
    }
    return records;
  }

  function canUseDirectJpegDctCoefficients(
    source,
    layout,
    chroma420,
    splitLuma8x8,
    options
  ) {
    if (options.directJpegCoefficients === false || !chroma420 || !splitLuma8x8) {
      return false;
    }
    if (source.components.length === 1) {
      const y = source.components[0];
      return source.maxHorizontalSampling === 1 && source.maxVerticalSampling === 1 &&
        y.horizontalSampling === 1 && y.verticalSampling === 1 &&
        y.blockCountX >= Math.ceil(layout.width / 8) &&
        y.blockCountY >= Math.ceil(layout.height / 8);
    }
    if (source.components.length !== 3 ||
        source.maxHorizontalSampling !== 2 || source.maxVerticalSampling !== 2) {
      return false;
    }

    const [y, cb, cr] = source.components;
    return y.horizontalSampling === 2 && y.verticalSampling === 2 &&
      cb.horizontalSampling === 1 && cb.verticalSampling === 1 &&
      cr.horizontalSampling === 1 && cr.verticalSampling === 1 &&
      y.blockCountX >= layout.mcuColumns * 2 && y.blockCountY >= layout.mcuRows * 2 &&
      cb.blockCountX >= layout.mcuColumns && cb.blockCountY >= layout.mcuRows &&
      cr.blockCountX >= layout.mcuColumns && cr.blockCountY >= layout.mcuRows;
  }

  function mapDirectJpegMcuCoefficients(source, mcuX, mcuY) {
    const y = source.components[0];
    return {
      y: [
        getJpegDctBlock(y, mcuX * 2, mcuY * 2),
        getJpegDctBlock(y, mcuX * 2 + 1, mcuY * 2),
        getJpegDctBlock(y, mcuX * 2, mcuY * 2 + 1),
        getJpegDctBlock(y, mcuX * 2 + 1, mcuY * 2 + 1),
      ],
      cb: source.components.length === 3
        ? getJpegDctBlock(source.components[1], mcuX, mcuY) : ZERO_DCT_BLOCK,
      cr: source.components.length === 3
        ? getJpegDctBlock(source.components[2], mcuX, mcuY) : ZERO_DCT_BLOCK,
    };
  }

  function getJpegDctBlock(component, blockX, blockY) {
    if (blockX < 0 || blockY < 0 ||
        blockX >= component.blockCountX || blockY >= component.blockCountY) {
      return ZERO_DCT_BLOCK;
    }
    const offset = (blockY * component.blockCountX + blockX) * 64;
    return component.blocks.subarray(offset, offset + 64);
  }

  function transformJpegMcuCoefficients(source, mcuX, mcuY, chroma420, splitLuma8x8) {
    const chromaHeight = chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422;
    const planes = extractJpegMcuPlanes(source, mcuX, mcuY, chroma420);
    return {
      y: splitLuma8x8
        ? splitLumaSamples(planes.y).map((samples) => forwardDct(samples, 8, 8))
        : [forwardDct(planes.y, 16, 16)],
      cb: forwardDct(planes.cb, 8, chromaHeight),
      cr: forwardDct(planes.cr, 8, chromaHeight),
    };
  }

  function encodeLumaCoefficientBlocks(
    output,
    offset,
    byteCount,
    coefficientBlocks,
    quality,
    split,
    coding,
    allowSkip = false
  ) {
    if (!split) {
      encodeComponentCoefficients(
        output,
        offset,
        byteCount,
        coefficientBlocks[0],
        16,
        16,
        quality,
        false,
        coding,
        allowSkip
      );
      return;
    }

    const blockBytes = byteCount / 4;
    for (let blockIndex = 0; blockIndex < 4; blockIndex += 1) {
      encodeComponentCoefficients(
        output,
        offset + blockIndex * blockBytes,
        blockBytes,
        coefficientBlocks[blockIndex],
        8,
        8,
        quality,
        false,
        coding,
        allowSkip
      );
    }
  }

  function shouldAutoSelectMaskedTail(presetKey, options) {
    return options.coefficientCoding === undefined && !options.dctLibrary && Number(presetKey) >= 6;
  }

  function selectBetterComponentAllocationEncoding(
    pixels,
    width,
    height,
    layout,
    splitLuma8x8,
    componentBudget,
    options,
    encodeCandidate
  ) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const candidates = componentAllocationLayouts(layout, componentBudget, splitLuma8x8);
    let best = null;

    for (let phase = 0; phase < candidates.length; phase += 1) {
      const candidateLayout = candidates[phase];
      const encoded = encodeCandidate({
        ...options,
        componentBudget: "fixed",
        componentAllocation: candidateLayout,
        onProgress: onProgress ? (progress) => {
          onProgress({
            ...progress,
            stage: "allocation",
            allocationIndex: phase + 1,
            allocationCount: candidates.length,
            yBytes: candidateLayout.yBytes,
            cbBytes: candidateLayout.cbBytes,
            crBytes: candidateLayout.crBytes,
            completed: phase * progress.total + progress.completed,
            total: progress.total * candidates.length,
          });
        } : undefined,
      });
      const cached = getCachedDctEncodingResult(encoded);
      const decoded = cached ? cached.decoded : decodeDctFile(encoded);
      const error = cached ? cached.squaredError : calculateSquaredError(pixels, decoded.pixels);
      if (!best || error < best.error) {
        best = { encoded, decoded, error };
      }
    }

    dctEncodingResultCache.set(best.encoded, {
      decoded: best.decoded,
      squaredError: best.error,
    });
    return best.encoded;
  }

  function selectBetterHighRateEncoding(pixels, width, height, options, encodeCandidate) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const candidates = highRateCandidateConfigurations(options.preset);
    const encodePhase = (candidate, phase) => encodeCandidate({
      ...options,
      ...candidate,
      onProgress: onProgress ? (progress) => {
        onProgress({
          ...progress,
          completed: phase * progress.total + progress.completed,
          total: progress.total * candidates.length,
        });
      } : undefined,
    });
    let best = null;

    for (let phase = 0; phase < candidates.length; phase += 1) {
      const encoded = encodePhase(candidates[phase], phase);
      const decoded = decodeDctFile(encoded);
      const error = calculateSquaredError(pixels, decoded.pixels);
      if (!best || error < best.error) {
        best = { encoded, decoded, error };
      }
    }

    dctEncodingResultCache.set(best.encoded, {
      decoded: best.decoded,
      squaredError: best.error,
    });
    return best.encoded;
  }

  function getCachedDctEncodingResult(encoded) {
    return dctEncodingResultCache.get(encoded) || null;
  }

  function highRateCandidateConfigurations(presetKey) {
    // Keep every automatically produced high-rate file in frequency order.
    // Row-major records remain readable and may still be requested explicitly.
    const candidates = [
      { coefficientCoding: "grouped-5-front", zigzagOrder: true },
      { coefficientCoding: "masked-tail-8x8", zigzagOrder: true },
    ];
    if (String(presetKey) === "9") {
      candidates.push({ coefficientCoding: "masked-tail-implicit2-48", zigzagOrder: true });
    }
    return candidates;
  }

  function createDctOutput(
    layout,
    quality,
    options,
    splitLuma8x8,
    coefficientCoding,
    libraryBytes = 0
  ) {
    const output = new Uint8Array(layout.totalBytes + libraryBytes);
    const view = new DataView(output.buffer);

    output.set(MAGIC, 0);
    writeUint32(view, 8, VERSION);
    writeUint32(view, 12, layout.modeCode);
    writeUint32(view, 16, layout.width);
    writeUint32(view, 20, layout.height);
    writeUint32(view, 24, layout.mcuColumns);
    writeUint32(view, 28, layout.mcuRows);
    writeUint32(view, 32, layout.bytesPerMcu);
    writeUint32(view, 36, layout.yBytes);
    writeUint32(view, 40, layout.cbBytes);
    writeUint32(view, 44, layout.crBytes);
    writeUint32(view, 48, quality);
    writeUint32(
      view,
      52,
      (options.autoQuality ? FLAG_AUTO_QUALITY : 0) |
        (splitLuma8x8 ? FLAG_SPLIT_LUMA_8X8 : 0) |
        (libraryBytes > 0 ? FLAG_DCT_LIBRARY : 0) |
        (resolveChroma420(options) ? FLAG_CHROMA_420 : 0) |
        (coefficientCoding.zigzagOrder ? FLAG_ZIGZAG_ORDER : 0) |
        (COEFFICIENT_CODINGS.findIndex(
          (candidate) => candidate.key === coefficientCoding.key
        ) << COEFFICIENT_CODING_SHIFT)
    );
    writeUint32(view, 56, layout.payloadBytes);
    writeUint32(view, 60, libraryBytes || options.searchCandidateCount || 0);

    return output;
  }

  function shouldSplitLuma(layout, options) {
    return layout.bpp >= 3 && options.splitLuma8x8 !== false;
  }

  function resolveChroma420(options = {}) {
    const value = options.chromaSubsampling;
    if (value === undefined) {
      return options.chroma420 !== false;
    }
    const normalized = String(value).replaceAll(":", "");
    if (normalized === "420") return true;
    if (normalized === "422") return false;
    throw new RangeError(`Unsupported DCT chroma subsampling: ${value}`);
  }

  function collectDctLibrarySource(
    pixels,
    width,
    height,
    layout,
    splitLuma8x8,
    chroma420,
    onMcu = () => {}
  ) {
    const chromaHeight = chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422;
    const mcus = [];
    const yVectors = [];
    const cbVectors = [];
    const crVectors = [];

    for (let mcuIndex = 0; mcuIndex < layout.mcuCount; mcuIndex += 1) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const planes = extractMcuPlanes(pixels, width, height, mcuX, mcuY, chroma420);
      const y = splitLuma8x8
        ? splitLumaSamples(planes.y).map((samples) => forwardDct(samples, 8, 8))
        : [forwardDct(planes.y, 16, 16)];
      const cb = forwardDct(planes.cb, 8, chromaHeight);
      const cr = forwardDct(planes.cr, 8, chromaHeight);

      yVectors.push(...y);
      cbVectors.push(cb);
      crVectors.push(cr);
      mcus.push({ y, cb, cr });
      onMcu(mcuIndex + 1);
    }

    return { mcus, yVectors, cbVectors, crVectors };
  }

  function createDctProgressReporter(options, total, quality) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const interval = Math.max(1, Math.ceil(total / 100));
    let lastCompleted = -interval;

    return (completed) => {
      if (!onProgress || completed !== 0 && completed !== total && completed - lastCompleted < interval) {
        return;
      }

      lastCompleted = completed;
      onProgress({ stage: "encode", completed, total, quality });
    };
  }

  function splitLumaSamples(samples) {
    const blocks = [];

    for (let blockY = 0; blockY < 2; blockY += 1) {
      for (let blockX = 0; blockX < 2; blockX += 1) {
        const block = new Float64Array(64);

        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            block[y * 8 + x] = samples[(blockY * 8 + y) * 16 + blockX * 8 + x];
          }
        }
        blocks.push(block);
      }
    }

    return blocks;
  }

  function buildDctPrototypeLibrary(
    vectors,
    maximumEntries,
    width,
    height,
    recordBytes,
    quality,
    chroma,
    coding,
    clusterSamples = 0
  ) {
    const clusterVectors = selectDctLibraryClusterVectors(vectors, clusterSamples);
    const centroids = clusterDctVectors(
      clusterVectors,
      Math.min(maximumEntries, clusterVectors.length),
      width,
      height,
      quality,
      chroma
    );
    const records = new Uint8Array(centroids.length * recordBytes);
    const coefficients = [];

    centroids.forEach((centroid, index) => {
      const offset = index * recordBytes;
      encodeComponentCoefficients(
        records,
        offset,
        recordBytes,
        centroid,
        width,
        height,
        quality,
        chroma,
        coding
      );
      coefficients.push(
        decodeComponent(records, offset, recordBytes, width, height, quality, chroma, coding).coefficients
      );
    });

    return { records, coefficients, recordBytes, count: centroids.length };
  }

  function selectDctLibraryClusterVectors(vectors, maximumSamples) {
    if (!maximumSamples || vectors.length <= maximumSamples) {
      return vectors;
    }
    return Array.from(
      { length: maximumSamples },
      (_, index) => vectors[Math.floor(index * vectors.length / maximumSamples)]
    );
  }

  function clusterDctVectors(vectors, clusterCount, width, height, quality, chroma) {
    if (clusterCount < 1 || vectors.length < 1) {
      return [];
    }

    const dimensions = width * height;
    const featurePositions = [
      0,
      ...getScan(0, width, height).slice(0, Math.min(LIBRARY_CLUSTER_FEATURES - 1, dimensions - 1)),
    ];
    const featureWeights = featurePositions.map((position) => {
      const u = position % width;
      const v = Math.floor(position / width);
      const step = quantizationStep(u, v, width, height, quality, chroma);
      return 1 / (step * step);
    });
    const centroids = [meanDctVector(vectors, dimensions)];

    while (centroids.length < clusterCount) {
      let bestVector = vectors[0];
      let bestDistance = -1;

      for (const vector of vectors) {
        let nearest = Infinity;
        for (const centroid of centroids) {
          nearest = Math.min(
            nearest,
            weightedDctDistance(vector, centroid, featurePositions, featureWeights)
          );
        }
        if (nearest > bestDistance) {
          bestDistance = nearest;
          bestVector = vector;
        }
      }
      centroids.push(new Float64Array(bestVector));
    }

    for (let iteration = 0; iteration < LIBRARY_CLUSTER_ITERATIONS; iteration += 1) {
      const sums = Array.from({ length: clusterCount }, () => new Float64Array(dimensions));
      const counts = new Uint32Array(clusterCount);

      for (const vector of vectors) {
        let bestIndex = 0;
        let bestDistance = Infinity;

        for (let index = 0; index < centroids.length; index += 1) {
          const distance = weightedDctDistance(
            vector,
            centroids[index],
            featurePositions,
            featureWeights
          );
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }

        counts[bestIndex] += 1;
        for (let position = 0; position < dimensions; position += 1) {
          sums[bestIndex][position] += vector[position];
        }
      }

      for (let index = 0; index < clusterCount; index += 1) {
        if (counts[index] === 0) {
          continue;
        }
        const inverseCount = 1 / counts[index];
        for (let position = 0; position < dimensions; position += 1) {
          centroids[index][position] = sums[index][position] * inverseCount;
        }
      }
    }

    return centroids;
  }

  function meanDctVector(vectors, dimensions) {
    const mean = new Float64Array(dimensions);
    for (const vector of vectors) {
      for (let position = 0; position < dimensions; position += 1) {
        mean[position] += vector[position];
      }
    }
    const inverseCount = 1 / vectors.length;
    for (let position = 0; position < dimensions; position += 1) {
      mean[position] *= inverseCount;
    }
    return mean;
  }

  function weightedDctDistance(left, right, positions, weights) {
    let distance = 0;
    for (let index = 0; index < positions.length; index += 1) {
      const difference = left[positions[index]] - right[positions[index]];
      distance += difference * difference * weights[index];
    }
    return distance;
  }

  function serializeDctLibrary(layout, splitLuma8x8, library) {
    const yRecordBytes = splitLuma8x8 ? layout.yBytes / 4 : layout.yBytes;
    const referenceLayout = getDctLibraryReferenceLayout(layout, splitLuma8x8, library);
    const totalBytes = LIBRARY_HEADER_BYTES + referenceLayout.totalBytes + library.y.records.length +
      library.cb.records.length + library.cr.records.length;
    const output = new Uint8Array(totalBytes);
    const view = new DataView(output.buffer);

    output.set(LIBRARY_MAGIC, 0);
    writeUint32(view, 8, getDctLibraryVersion(library));
    writeUint32(view, 12, library.y.count);
    writeUint32(view, 16, library.cb.count);
    writeUint32(view, 20, library.cr.count);
    writeUint32(view, 24, yRecordBytes);
    writeUint32(view, 28, totalBytes);

    let offset = LIBRARY_HEADER_BYTES + referenceLayout.totalBytes;
    library.y.reference = referenceLayout.y;
    library.cb.reference = referenceLayout.cb;
    library.cr.reference = referenceLayout.cr;
    output.set(library.y.records, offset);
    offset += library.y.records.length;
    output.set(library.cb.records, offset);
    offset += library.cb.records.length;
    output.set(library.cr.records, offset);
    return output;
  }

  function getDctLibraryReferenceLayout(layout, splitLuma8x8, library) {
    let byteOffset = 0;
    const createComponent = (entryCount, referenceCount) => {
      const bits = library.referenceCoding === "sidecar" && entryCount > 0
        ? Math.ceil(Math.log2(entryCount + 1)) : 0;
      const bytes = Math.ceil(referenceCount * bits / 8);
      const result = { bits, bytes, count: referenceCount, offset: byteOffset };
      byteOffset += bytes;
      return result;
    };
    const yBlocksPerMcu = splitLuma8x8 ? 4 : 1;
    const y = createComponent(library.y.count, layout.mcuCount * yBlocksPerMcu);
    const cb = createComponent(library.cb.count, layout.mcuCount);
    const cr = createComponent(library.cr.count, layout.mcuCount);
    return { y, cb, cr, totalBytes: byteOffset };
  }

  function writeDctLibraryReference(bytes, component, referenceIndex, libraryIndex) {
    if (!component.reference || component.reference.bits === 0) {
      return;
    }
    if (libraryIndex < 0 || libraryIndex > component.count ||
        referenceIndex < 0 || referenceIndex >= component.reference.count) {
      throw new RangeError("DCT library sidecar reference is out of range");
    }
    const bitOffset = (LIBRARY_HEADER_BYTES + component.reference.offset) * 8 +
      referenceIndex * component.reference.bits;
    for (let bit = 0; bit < component.reference.bits; bit += 1) {
      if ((libraryIndex & (1 << bit)) !== 0) {
        const position = bitOffset + bit;
        bytes[position >> 3] |= 1 << (position & 7);
      }
    }
  }

  function validateLibrarySize(value, coding) {
    const size = Math.round(Number(value));
    const maximum = 63;

    if (!Number.isFinite(size) || size < 1 || size > maximum) {
      throw new RangeError(`DCT library size must be from 1 through ${maximum}`);
    }

    return size;
  }

  function normalizeLibraryReferenceCoding(value) {
    const coding = String(value || "auto").toLowerCase();
    if (!["auto", "sidecar"].includes(coding)) {
      throw new RangeError("DCT library reference coding must be auto or sidecar");
    }
    return coding;
  }

  function normalizeLibraryClusterSamples(value) {
    const samples = value === undefined ? 2048 : Math.round(Number(value));
    if (!Number.isFinite(samples) || samples < 64 || samples > 65536) {
      throw new RangeError("DCT library cluster sample count must be from 64 through 65536");
    }
    return samples;
  }

  function normalizeLibraryCandidateCount(value) {
    const count = value === undefined ? 2 : Math.round(Number(value));
    if (!Number.isFinite(count) || count < 1 || count > 16) {
      throw new RangeError("DCT library candidate count must be from 1 through 16");
    }
    return count;
  }

  function normalizeLibraryFrequencySplit(value) {
    const ratio = Number(value || 0);
    if (![0, 0.25, 0.5, 1].includes(ratio)) {
      throw new RangeError("DCT library frequency split must be 0, 0.25, 0.5, or 1");
    }
    return ratio;
  }

  function getDctLibraryVersion(library) {
    if (library.referenceCoding === "sidecar") {
      if (library.frequencySplit === 0.25) {
        return LIBRARY_VERSION_SIDECAR_SPECTRAL_QUARTER;
      }
      if (library.frequencySplit === 0.5) {
        return LIBRARY_VERSION_SIDECAR_SPECTRAL_HALF;
      }
      if (library.frequencySplit === 1) {
        return LIBRARY_VERSION_SIDECAR_SPECTRAL_FULL;
      }
      return LIBRARY_VERSION_SIDECAR_REFERENCE;
    }
    if (library.frequencySplit === 0.25) {
      return LIBRARY_VERSION_SPECTRAL_QUARTER;
    }
    if (library.frequencySplit === 0.5) {
      return LIBRARY_VERSION_SPECTRAL_HALF;
    }
    if (library.frequencySplit === 1) {
      return LIBRARY_VERSION_SPECTRAL_FULL;
    }
    return library.referenceCoding === "header"
      ? LIBRARY_VERSION_HEADER_REFERENCE
      : LIBRARY_VERSION_TAIL_REFERENCE;
  }

  function normalizeLibraryComponents(value) {
    const components = value === undefined
      ? ["y", "cb", "cr"]
      : Array.isArray(value) ? value : String(value).split(",");
    const selected = new Set(components.map((component) => String(component).trim().toLowerCase()));

    if (selected.size < 1 || [...selected].some((component) => !["y", "cb", "cr"].includes(component))) {
      throw new RangeError("DCT library components must contain Y, Cb, or Cr");
    }

    return selected;
  }

  function decodeDctFile(input) {
    const bytes = asUint8Array(input);
    const info = inspectDctFile(bytes);
    const pixels = new Uint8ClampedArray(info.width * info.height * 4);

    for (let mcuIndex = 0; mcuIndex < info.mcuCount; mcuIndex += 1) {
      const mcuX = mcuIndex % info.mcuColumns;
      const mcuY = Math.floor(mcuIndex / info.mcuColumns);
      const components = decodeMcuComponents(bytes, info, mcuIndex);
      const yPlane = reconstructLumaPlane(components.y);
      const cbPlane = inverseDct(components.cb.coefficients, CHROMA_WIDTH, info.chromaHeight);
      const crPlane = inverseDct(components.cr.coefficients, CHROMA_WIDTH, info.chromaHeight);

      for (let localY = 0; localY < MCU_HEIGHT; localY += 1) {
        const y = mcuY * MCU_HEIGHT + localY;

        if (y >= info.height) {
          break;
        }

        for (let localX = 0; localX < MCU_WIDTH; localX += 1) {
          const x = mcuX * MCU_WIDTH + localX;

          if (x >= info.width) {
            break;
          }

          const rgba = yCbCrToRgba(
            yPlane[localY * MCU_WIDTH + localX] + 128,
            sampleChromaPlane(cbPlane, localX, localY, info.chroma420) + 128,
            sampleChromaPlane(crPlane, localX, localY, info.chroma420) + 128
          );
          writeRgba(pixels, (y * info.width + x) * 4, rgba);
        }
      }
    }

    return { ...info, pixels };
  }

  function decodeDctComponentSamples(input) {
    const bytes = asUint8Array(input);
    const info = inspectDctFile(bytes);
    const yOffset = 0;
    const cbOffset = MCU_WIDTH * MCU_HEIGHT;
    const crOffset = cbOffset + CHROMA_WIDTH * info.chromaHeight;
    const bytesPerMcu = crOffset + CHROMA_WIDTH * info.chromaHeight;
    const samples = new Uint8Array(info.mcuCount * bytesPerMcu);

    for (let mcuIndex = 0; mcuIndex < info.mcuCount; mcuIndex += 1) {
      const components = decodeMcuComponents(bytes, info, mcuIndex);
      const recordOffset = mcuIndex * bytesPerMcu;

      writeCenteredComponentSamples(
        samples,
        recordOffset + yOffset,
        reconstructLumaPlane(components.y)
      );
      writeCenteredComponentSamples(
        samples,
        recordOffset + cbOffset,
        inverseDct(components.cb.coefficients, CHROMA_WIDTH, info.chromaHeight)
      );
      writeCenteredComponentSamples(
        samples,
        recordOffset + crOffset,
        inverseDct(components.cr.coefficients, CHROMA_WIDTH, info.chromaHeight)
      );
    }

    return {
      ...info,
      componentCache: Object.freeze({
        bytesPerMcu,
        yOffset,
        cbOffset,
        crOffset,
        chromaHeight: info.chromaHeight,
        chroma420: info.chroma420,
        samples,
      }),
    };
  }

  function writeCenteredComponentSamples(target, offset, samples) {
    for (let index = 0; index < samples.length; index += 1) {
      target[offset + index] = clampByte(samples[index] + 128);
    }
  }

  function sampleDctFilePixel(input, x, y) {
    const bytes = asUint8Array(input);
    const info = inspectDctFile(bytes);

    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= info.width || y >= info.height) {
      throw new RangeError("DCT pixel coordinate is out of range");
    }

    const mcuX = Math.floor(x / MCU_WIDTH);
    const mcuY = Math.floor(y / MCU_HEIGHT);
    const mcuIndex = mcuY * info.mcuColumns + mcuX;
    const localX = x % MCU_WIDTH;
    const localY = y % MCU_HEIGHT;
    const recordOffset = HEADER_BYTES + mcuIndex * info.bytesPerMcu;
    const luma = sampleLumaRecord(
      bytes,
      recordOffset,
      info.yBytes,
      info.quality,
      info.splitLuma8x8,
      info.coefficientCoding,
      info.splitLuma8x8
        ? (blockIndex) => createDctLibraryContext(bytes, info, "y", mcuIndex * 4 + blockIndex)
        : createDctLibraryContext(bytes, info, "y", mcuIndex),
      localX,
      localY
    ) + 128;
    const cbComponent = decodeComponent(
      bytes,
      recordOffset + info.yBytes,
      info.cbBytes,
      8,
      info.chromaHeight,
      info.quality,
      true,
      info.coefficientCoding,
      createDctLibraryContext(bytes, info, "cb", mcuIndex)
    );
    const crComponent = decodeComponent(
      bytes,
      recordOffset + info.yBytes + info.cbBytes,
      info.crBytes,
      8,
      info.chromaHeight,
      info.quality,
      true,
      info.coefficientCoding,
      createDctLibraryContext(bytes, info, "cr", mcuIndex)
    );
    const cb = sampleChromaCoefficients(
      cbComponent.coefficients, localX, localY, info.chroma420
    ) + 128;
    const cr = sampleChromaCoefficients(
      crComponent.coefficients, localX, localY, info.chroma420
    ) + 128;

    return yCbCrToRgba(luma, cb, cr);
  }

  function inspectDctFile(input) {
    const bytes = asUint8Array(input);

    if (bytes.length < HEADER_BYTES || MAGIC.some((value, index) => bytes[index] !== value)) {
      throw new RangeError("Invalid or truncated DCTBS2 file");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = readUint32(view, 8);
    const modeCode = readUint32(view, 12);
    const presetKey = MODE_TO_PRESET.get(modeCode);
    const width = readUint32(view, 16);
    const height = readUint32(view, 20);

    if (version !== VERSION || presetKey === undefined) {
      throw new RangeError("Unsupported DCTBS2 version or mode");
    }

    const baseLayout = getDctFileLayout(width, height, presetKey);
    const quality = readUint32(view, 48);
    const flags = readUint32(view, 52);
    const splitLuma8x8 = (flags & FLAG_SPLIT_LUMA_8X8) !== 0;
    let layout;
    try {
      layout = withComponentAllocation(baseLayout, {
        yBytes: readUint32(view, 36),
        cbBytes: readUint32(view, 40),
        crBytes: readUint32(view, 44),
      }, splitLuma8x8);
    } catch (error) {
      throw new RangeError("Invalid DCTBS2 layout");
    }
    const coefficientCodingIndex = (flags & COEFFICIENT_CODING_MASK) >> COEFFICIENT_CODING_SHIFT;
    const baseCoefficientCoding = COEFFICIENT_CODINGS[coefficientCodingIndex];
    const zigzagOrder = (flags & FLAG_ZIGZAG_ORDER) !== 0;
    const coefficientCoding = baseCoefficientCoding
      ? withCoefficientOrder(baseCoefficientCoding, zigzagOrder) : null;
    const payloadBytes = readUint32(view, 56);
    const metadata = readUint32(view, 60);
    const libraryEnabled = (flags & FLAG_DCT_LIBRARY) !== 0;
    const chroma420 = (flags & FLAG_CHROMA_420) !== 0;
    const libraryBytes = libraryEnabled ? metadata : 0;

    if (
      readUint32(view, 24) !== layout.mcuColumns ||
      readUint32(view, 28) !== layout.mcuRows ||
      readUint32(view, 32) !== layout.bytesPerMcu ||
      payloadBytes !== layout.payloadBytes ||
      bytes.length !== HEADER_BYTES + payloadBytes + libraryBytes ||
      quality < 1 || quality > 100 ||
      !coefficientCoding ||
      (flags & ~SUPPORTED_FLAGS) !== 0 ||
      (libraryEnabled && coefficientCoding.maskedTail) ||
      ((flags & FLAG_SPLIT_LUMA_8X8) !== 0 && layout.bpp < 3)
    ) {
      throw new RangeError("Invalid DCTBS2 layout");
    }

    const library = libraryEnabled
      ? inspectDctLibrary(bytes, layout, splitLuma8x8, coefficientCoding, libraryBytes)
      : null;

    return {
      version,
      quality,
      autoQuality: (flags & FLAG_AUTO_QUALITY) !== 0,
      splitLuma8x8,
      chroma420,
      zigzagOrder,
      chromaSubsampling: chroma420 ? "4:2:0" : "4:2:2",
      chromaWidth: CHROMA_WIDTH,
      chromaHeight: chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422,
      libraryEnabled,
      libraryBytes,
      library,
      coefficientCoding,
      coefficientCodingKey: coefficientCoding.key,
      componentAllocationAdaptive: layout.yBytes !== baseLayout.yBytes ||
        layout.cbBytes !== baseLayout.cbBytes || layout.crBytes !== baseLayout.crBytes,
      searchCandidateCount: libraryEnabled ? 0 : metadata,
      totalBpp: bytes.length * 8 / (width * height),
      ...layout,
    };
  }

  function inspectDctLibrary(bytes, layout, splitLuma8x8, coding, libraryBytes) {
    const offset = HEADER_BYTES + layout.payloadBytes;
    const yRecordBytes = splitLuma8x8 ? layout.yBytes / 4 : layout.yBytes;

    if (libraryBytes < LIBRARY_HEADER_BYTES ||
        LIBRARY_MAGIC.some((value, index) => bytes[offset + index] !== value)) {
      throw new RangeError("Invalid DCT prototype library");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, libraryBytes);
    const yCount = readUint32(view, 12);
    const cbCount = readUint32(view, 16);
    const crCount = readUint32(view, 20);
    const libraryVersion = readUint32(view, 8);
    const frequencySplit = [LIBRARY_VERSION_SPECTRAL_QUARTER,
      LIBRARY_VERSION_SIDECAR_SPECTRAL_QUARTER].includes(libraryVersion) ? 0.25 :
      [LIBRARY_VERSION_SPECTRAL_HALF,
        LIBRARY_VERSION_SIDECAR_SPECTRAL_HALF].includes(libraryVersion) ? 0.5 :
      [LIBRARY_VERSION_SPECTRAL_FULL,
        LIBRARY_VERSION_SIDECAR_SPECTRAL_FULL].includes(libraryVersion) ? 1 : 0;
    const referenceCoding = libraryVersion === LIBRARY_VERSION_TAIL_REFERENCE ? "tail" :
      libraryVersion >= LIBRARY_VERSION_HEADER_REFERENCE &&
      libraryVersion <= LIBRARY_VERSION_SPECTRAL_FULL ? "header" :
      libraryVersion >= LIBRARY_VERSION_SIDECAR_REFERENCE &&
      libraryVersion <= LIBRARY_VERSION_SIDECAR_SPECTRAL_FULL ? "sidecar" : null;
    const maximumEntries = referenceCoding === "header" ? 3 :
      referenceCoding === "sidecar" ? 63 : 2 ** coding.mantissaBits - 1;
    const referenceLayout = getDctLibraryReferenceLayout(layout, splitLuma8x8, {
      referenceCoding,
      y: { count: yCount },
      cb: { count: cbCount },
      cr: { count: crCount },
    });
    const expectedBytes = LIBRARY_HEADER_BYTES + referenceLayout.totalBytes + yCount * yRecordBytes +
      cbCount * layout.cbBytes + crCount * layout.crBytes;

    if (
      !referenceCoding ||
      yCount > maximumEntries ||
      cbCount > maximumEntries ||
      crCount > maximumEntries ||
      yCount + cbCount + crCount < 1 ||
      readUint32(view, 24) !== yRecordBytes ||
      readUint32(view, 28) !== libraryBytes ||
      expectedBytes !== libraryBytes
    ) {
      throw new RangeError("Invalid DCT prototype library layout");
    }

    const yReferenceOffset = offset + LIBRARY_HEADER_BYTES;
    const yOffset = yReferenceOffset + referenceLayout.totalBytes;
    const cbOffset = yOffset + yCount * yRecordBytes;
    const crOffset = cbOffset + cbCount * layout.cbBytes;

    return {
      offset,
      bytes: libraryBytes,
      y: {
        count: yCount,
        offset: yOffset,
        recordBytes: yRecordBytes,
        reference: { ...referenceLayout.y, offset: yReferenceOffset + referenceLayout.y.offset },
      },
      cb: {
        count: cbCount,
        offset: cbOffset,
        recordBytes: layout.cbBytes,
        reference: { ...referenceLayout.cb, offset: yReferenceOffset + referenceLayout.cb.offset },
      },
      cr: {
        count: crCount,
        offset: crOffset,
        recordBytes: layout.crBytes,
        reference: { ...referenceLayout.cr, offset: yReferenceOffset + referenceLayout.cr.offset },
      },
      referenceCoding,
      frequencySplit,
      cache: new Map(),
    };
  }

  function inspectDctMcu(input, mcuIndex) {
    const bytes = asUint8Array(input);
    const info = inspectDctFile(bytes);

    if (!Number.isInteger(mcuIndex) || mcuIndex < 0 || mcuIndex >= info.mcuCount) {
      throw new RangeError("DCT MCU index is out of range");
    }

    const components = decodeMcuComponents(bytes, info, mcuIndex);

    return {
      index: mcuIndex,
      x: mcuIndex % info.mcuColumns,
      y: Math.floor(mcuIndex / info.mcuColumns),
      byteOffset: HEADER_BYTES + mcuIndex * info.bytesPerMcu,
      bytes: info.bytesPerMcu,
      components: Object.fromEntries(Object.entries(components).map(([name, component]) => [
        name,
        summarizeComponent(component),
      ])),
    };
  }

  function findBestDctQuality(pixels, width, height, options = {}) {
    validatePixels(pixels, width, height);
    const preset = getDctPreset(options.preset);
    const chroma420 = resolveChroma420(options);
    const coefficientCoding = resolveCoefficientCoding(options.coefficientCoding, preset.key, options);
    const autoSelectMaskedTail = shouldAutoSelectMaskedTail(preset.key, options);
    const sampleCodings = autoSelectMaskedTail
      ? highRateCandidateConfigurations(preset.key).map((candidate) =>
        resolveCoefficientCoding(candidate.coefficientCoding, preset.key, candidate))
      : [coefficientCoding];
    const layout = getDctFileLayout(width, height, preset.key);
    const splitLuma8x8 = shouldSplitLuma(layout, options);
    const componentBudget = options.dctLibrary
      ? "fixed" : normalizeComponentBudget(options.componentBudget, preset.key);
    const sampleLayouts = componentAllocationLayouts(layout, componentBudget, splitLuma8x8);
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const finalistCount = normalizeFinalistCount(options.finalistCount);
    const coarse = [];

    for (let quality = 20; quality <= 95; quality += 5) {
      coarse.push(quality);
    }

    const sampleIndices = selectSampleMcuIndices(layout.mcuCount, options.sampleMcuCount || 24);
    const sampleResults = [];
    const estimatedTotal = coarse.length + 9 + finalistCount;
    let completed = 0;

    for (const quality of coarse) {
      sampleResults.push({
        quality,
        error: measureBestSampleError(
          pixels, width, height, sampleLayouts, quality, sampleIndices, sampleCodings, chroma420
        ),
      });
      completed += 1;
      onProgress({ stage: "sample", completed, total: estimatedTotal, quality });
    }

    sampleResults.sort(compareQualityResults);
    const coarseBest = sampleResults[0].quality;
    const refine = [];

    for (let quality = Math.max(1, coarseBest - 4); quality <= Math.min(100, coarseBest + 4); quality += 1) {
      refine.push(quality);
    }

    for (const quality of refine) {
      if (!sampleResults.some((result) => result.quality === quality)) {
        sampleResults.push({
          quality,
          error: measureBestSampleError(
            pixels, width, height, sampleLayouts, quality, sampleIndices, sampleCodings, chroma420
          ),
        });
      }
      completed += 1;
      onProgress({ stage: "refine", completed, total: estimatedTotal, quality });
    }

    sampleResults.sort(compareQualityResults);
    const finalists = sampleResults.slice(0, finalistCount).map((result) => result.quality);
    let best = null;

    for (const quality of finalists) {
      const finalistStart = completed;
      const encoded = encodeDctFile(pixels, width, height, {
        preset: preset.key,
        quality,
        autoQuality: true,
        dctLibrary: Boolean(options.dctLibrary),
        librarySize: options.librarySize,
        libraryComponents: options.libraryComponents,
        libraryReferenceCoding: options.libraryReferenceCoding,
        libraryFrequencySplit: options.libraryFrequencySplit,
        libraryClusterSamples: options.libraryClusterSamples,
        libraryCandidateCount: options.libraryCandidateCount,
        componentBudget,
        chromaSubsampling: chroma420 ? "4:2:0" : "4:2:2",
        ...(autoSelectMaskedTail ? {} : {
          coefficientCoding: coefficientCoding.key,
          zigzagOrder: Boolean(coefficientCoding.zigzagOrder),
        }),
        searchCandidateCount: sampleResults.length + finalists.length,
        onProgress(progress) {
          const fraction = progress.total > 0 ? progress.completed / progress.total : 0;
          onProgress({
            stage: "full",
            completed: finalistStart + fraction * 0.9,
            total: estimatedTotal,
            quality,
            phaseCompleted: progress.completed,
            phaseTotal: progress.total,
          });
        },
      });
      const decoded = decodeDctFile(encoded);
      const error = calculateSquaredError(pixels, decoded.pixels);
      const candidate = { quality, error, encoded, decoded };

      if (!best || compareQualityResults(candidate, best) < 0) {
        best = candidate;
      }
      completed += 1;
      onProgress({ stage: "full", completed, total: estimatedTotal, quality });
    }

    return {
      ...best,
      candidateCount: sampleResults.length + finalists.length,
      sampleMcuCount: sampleIndices.length,
    };
  }

  function normalizeFinalistCount(value) {
    const count = value === undefined ? 1 : Number(value);

    if (!Number.isInteger(count) || count < 1 || count > 3) {
      throw new RangeError("DCT quality finalist count must be an integer from 1 to 3");
    }

    return count;
  }

  function encodeComponent(
    output,
    offset,
    byteCount,
    samples,
    width,
    height,
    quality,
    chroma,
    coding,
    allowSkip = false
  ) {
    encodeComponentCoefficients(
      output,
      offset,
      byteCount,
      forwardDct(samples, width, height),
      width,
      height,
      quality,
      chroma,
      coding,
      allowSkip
    );
  }

  function encodeComponentCoefficients(
    output,
    offset,
    byteCount,
    coefficients,
    width,
    height,
    quality,
    chroma,
    coding,
    allowSkip = false
  ) {
    const candidate = chooseComponentEncoding(
      coefficients,
      width,
      height,
      byteCount,
      quality,
      chroma,
      coding,
      0,
      0,
      allowSkip
    );
    writeComponentCandidate(output, offset, byteCount, candidate, coding, null);
  }

  function encodeLibraryComponentCoefficients(
    output,
    offset,
    byteCount,
    coefficients,
    width,
    height,
    quality,
    chroma,
    coding,
    libraryComponent,
    referenceCoding,
    frequencySplit = 0
  ) {
    let best = null;
    const reservedAcCount = referenceCoding === "tail" ? 1 : 0;
    const prototypes = libraryComponent.coefficients;
    const libraryIndices = selectDctLibraryCandidateIndices(
      coefficients,
      prototypes,
      width,
      height,
      quality,
      chroma,
      libraryComponent.candidateCount
    );

    for (const libraryIndex of libraryIndices) {
      const residual = libraryIndex === 0
        ? coefficients
        : subtractDctVectors(coefficients, prototypes[libraryIndex - 1]);
      const candidate = chooseComponentEncoding(
        residual,
        width,
        height,
        byteCount,
        quality,
        chroma,
        coding,
        reservedAcCount,
        libraryIndex === 0 ? 0 : frequencySplit
      );
      candidate.libraryIndex = libraryIndex;

      const comparison = best ? compareComponentCandidates(candidate, best) : -1;
      if (!best || comparison < 0 || (comparison === 0 && libraryIndex < best.libraryIndex)) {
        best = candidate;
      }
    }

    writeComponentCandidate(
      output,
      offset,
      byteCount,
      best,
      coding,
      best.libraryIndex,
      referenceCoding
    );
    return best.libraryIndex;
  }

  function selectDctLibraryCandidateIndices(
    coefficients,
    prototypes,
    width,
    height,
    quality,
    chroma,
    maximumCandidates
  ) {
    if (!maximumCandidates || maximumCandidates >= prototypes.length) {
      return Array.from({ length: prototypes.length + 1 }, (_, index) => index);
    }
    const positions = [
      0,
      ...getScan(0, width, height).slice(0, Math.min(LIBRARY_CLUSTER_FEATURES - 1, width * height - 1)),
    ];
    const weights = positions.map((position) => {
      const u = position % width;
      const v = Math.floor(position / width);
      const step = quantizationStep(u, v, width, height, quality, chroma);
      return 1 / (step * step);
    });
    const ranked = prototypes.map((prototype, index) => ({
      index: index + 1,
      distance: weightedDctDistance(coefficients, prototype, positions, weights),
    }));
    ranked.sort((left, right) => left.distance - right.distance || left.index - right.index);
    return [0, ...ranked.slice(0, maximumCandidates).map((item) => item.index)];
  }

  function subtractDctVectors(left, right) {
    const output = new Float64Array(left.length);
    for (let position = 0; position < left.length; position += 1) {
      output[position] = left[position] - right[position];
    }
    return output;
  }

  function getLibraryCoefficientScan(coding, profile, width, height, acCount, frequencySplit) {
    const scan = getProfileScan(coding, profile, width, height);
    if (frequencySplit <= 0) {
      return scan.slice(0, acCount);
    }
    const maximumHighCount = Math.max(0, scan.length - acCount);
    const highCount = Math.min(maximumHighCount, Math.round(acCount * frequencySplit));
    const lowCount = acCount - highCount;
    return [
      ...scan.slice(0, lowCount),
      ...scan.slice(acCount, acCount + highCount),
    ];
  }

  function writeComponentCandidate(
    output,
    offset,
    byteCount,
    candidate,
    coding,
    libraryIndex,
    referenceCoding = null
  ) {
    if (candidate.encodingMode === "masked-tail" || candidate.encodingMode === "masked-tail-implicit2") {
      writeMaskedTailComponentCandidate(output, offset, byteCount, candidate, coding);
      return;
    }

    const writer = new BitWriter(output, offset, byteCount);
    const headerProfile = referenceCoding === "header"
      ? candidate.profile | libraryIndex << 2
      : candidate.profile;
    const skipRecord = Boolean(candidate.skipMode);

    writer.write((headerProfile << 4) | candidate.scaleIndex | (skipRecord ? 8 : 0), 8);
    writer.writeSigned(candidate.dc, 10);

    if (skipRecord) {
      for (const token of candidate.tokens) {
        writer.writeSigned(token.stored, token.bits);
        writer.write(token.skip, 2);
      }
      for (let tokenIndex = 0; tokenIndex < candidate.tailTokens.length; tokenIndex += 1) {
        const token = candidate.tailTokens[tokenIndex];
        writer.writeSigned(token.stored, 4);
        if (tokenIndex + 1 < candidate.tailTokens.length) {
          writer.write(token.skip, 2);
        }
      }
    } else if (coding.groupCount > 0) {
      for (const scaleIndex of candidate.groupScaleIndices) {
        writer.write(scaleIndex, 3);
      }
      for (const value of candidate.ac) {
        writer.writeSigned(value, coding.mantissaBits);
      }
    } else {
      for (const value of candidate.ac) {
        writer.writeSigned(value, coding.mantissaBits);
      }
    }

    if (referenceCoding === "tail") {
      writer.write(libraryIndex, coding.mantissaBits);
    }
  }

  function encodeLuma(output, offset, byteCount, samples, quality, split, coding, allowSkip = false) {
    if (!split) {
      encodeComponent(output, offset, byteCount, samples, 16, 16, quality, false, coding, allowSkip);
      return;
    }

    const blockBytes = byteCount / 4;
    for (let blockY = 0; blockY < 2; blockY += 1) {
      for (let blockX = 0; blockX < 2; blockX += 1) {
        const blockIndex = blockY * 2 + blockX;
        const block = new Float64Array(64);

        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            block[y * 8 + x] = samples[(blockY * 8 + y) * 16 + blockX * 8 + x];
          }
        }

        encodeComponent(
          output,
          offset + blockIndex * blockBytes,
          blockBytes,
          block,
          8,
          8,
          quality,
          false,
          coding,
          allowSkip
        );
      }
    }
  }

  function chooseComponentEncoding(
    coefficients,
    width,
    height,
    byteCount,
    quality,
    chroma,
    coding,
    reservedAcCount = 0,
    libraryFrequencySplit = 0,
    allowSkip = false
  ) {
    let baseline;

    const maskedTailConfig = getMaskedTailConfig(coding, width, height, byteCount);
    if (maskedTailConfig) {
      baseline = chooseMaskedTailComponentEncoding(
        coefficients,
        width,
        height,
        quality,
        chroma,
        maskedTailConfig,
        coding
      );
    } else if (coding.groupCount > 0) {
      baseline = chooseGroupedComponentEncoding(
        coefficients,
        width,
        height,
        byteCount,
        quality,
        chroma,
        coding,
        reservedAcCount,
        libraryFrequencySplit
      );
    } else {
      baseline = chooseLegacyComponentEncoding(
        coefficients,
        width,
        height,
        byteCount,
        quality,
        chroma,
        coding,
        reservedAcCount,
        libraryFrequencySplit
      );
    }

    if (!allowSkip || !coding.skipMode || reservedAcCount > 0 || libraryFrequencySplit > 0) {
      return baseline;
    }

    const skip = chooseSkipComponentEncoding(
      coefficients,
      width,
      height,
      byteCount,
      quality,
      chroma,
      coding,
      baseline.error
    );
    return skip && skip.error < baseline.error ? skip : baseline;
  }

  function isMaskedTailRecord(coding, width, height, byteCount) {
    return Boolean(getMaskedTailConfig(coding, width, height, byteCount));
  }

  function getMaskedTailConfig(coding, width, height, byteCount) {
    if (!coding.maskedTail || width !== 8 || height !== 8) return null;
    return coding.maskedTailVariant === "implicit2-48"
      ? MASKED_TAIL_IMPLICIT2_CONFIGS[byteCount] || null
      : MASKED_TAIL_CONFIGS[byteCount] || null;
  }

  function chooseMaskedTailComponentEncoding(
    coefficients,
    width,
    height,
    quality,
    chroma,
    config,
    coefficientCoding
  ) {
    const implicitPositions = config.implicitPositions || [];
    const implicit = new Uint8Array(64);
    for (const position of implicitPositions) implicit[position] = 1;
    const coefficientOrder = getCoefficientOrder(coefficientCoding, width, height);
    const flexibleAcCount = config.maxAc - implicitPositions.length;
    const dcMinimum = -(2 ** (config.dcBits - 1));
    const dcMaximum = 2 ** (config.dcBits - 1) - 1;
    const acMinimum = -(2 ** (config.acBits - 1));
    const acMaximum = 2 ** (config.acBits - 1) - 1;
    const baseError = squaredNorm(coefficients);
    const quantizationSteps = getScaledQuantizationSteps(width, height, quality, chroma);
    let best = null;

    for (let scaleIndex = 0; scaleIndex < 4; scaleIndex += 1) {
      const dcStep = quantizationSteps[scaleIndex * width * height];
      const dc = clamp(roundSigned(coefficients[0] / dcStep), dcMinimum, dcMaximum);
      const restoredDc = dc * dcStep;
      const errorAfterDc = baseError +
        (coefficients[0] - restoredDc) ** 2 - coefficients[0] ** 2;
      const coding = coefficientOrder.slice(1).map((position, index) => {
        const step = quantizationSteps[scaleIndex * width * height + position];
        let stored = clamp(roundSigned(coefficients[position] / step), acMinimum, acMaximum);
        const restored = stored * step;
        const dropError = coefficients[position] ** 2;
        const keepError = (coefficients[position] - restored) ** 2;

        if (keepError >= dropError) {
          stored = 0;
        }
        return {
          position,
          rank: index + 1,
          stored,
          benefit: stored === 0 ? 0 : dropError - keepError,
        };
      });
      const codingByPosition = new Array(64);
      for (const entry of coding) codingByPosition[entry.position] = entry;

      const selected = new Uint8Array(64);
      const implicitBenefit = implicitPositions.reduce(
        (total, position) => total + codingByPosition[position].benefit,
        0
      );
      const implicitEntries = implicitPositions.map((position) => codingByPosition[position]);
      let explicitBenefit = 0;
      let tailBenefit = coding.slice(63 - flexibleAcCount).reduce(
        (total, entry) => total + entry.benefit,
        0
      );
      const eligible = [];
      let nextEligibleRank = 1;

      for (let explicitCount = 0; explicitCount <= flexibleAcCount; explicitCount += 1) {
        const tailStart = 64 - flexibleAcCount + explicitCount;
        const error = errorAfterDc - implicitBenefit - explicitBenefit - tailBenefit;

        if (!best || error < best.error) {
          best = {
            profile: null,
            scaleIndex,
            dc,
            groupScaleIndices: [scaleIndex],
            implicitEntries,
            explicitEntries: coding.slice(0, tailStart - 1)
              .filter((entry) => selected[entry.position] !== 0),
            tailEntries: coding.slice(tailStart - 1),
            tailStart,
            maxAc: config.maxAc,
            error,
            encodingMode: implicitPositions.length > 0
              ? "masked-tail-implicit2" : "masked-tail",
          };
        }

        if (explicitCount === flexibleAcCount) break;
        tailBenefit -= coding[tailStart - 1].benefit;
        const maximumEligibleRank = Math.min(62, tailStart);
        while (nextEligibleRank <= maximumEligibleRank) {
          const entry = coding[nextEligibleRank - 1];
          if (implicit[entry.position] === 0) pushBenefitEntry(eligible, entry);
          nextEligibleRank += 1;
        }
        const bestEntry = popBenefitEntry(eligible);
        selected[bestEntry.position] = 1;
        explicitBenefit += bestEntry.benefit;
      }
    }

    return best;
  }

  function pushBenefitEntry(heap, entry) {
    let index = heap.length;
    heap.push(entry);

    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (!isBetterBenefitEntry(entry, heap[parentIndex])) break;
      heap[index] = heap[parentIndex];
      index = parentIndex;
    }
    heap[index] = entry;
  }

  function popBenefitEntry(heap) {
    const best = heap[0];
    const last = heap.pop();
    if (heap.length === 0) return best;

    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= heap.length) break;
      const rightIndex = leftIndex + 1;
      const childIndex = rightIndex < heap.length &&
        isBetterBenefitEntry(heap[rightIndex], heap[leftIndex])
        ? rightIndex : leftIndex;
      if (!isBetterBenefitEntry(heap[childIndex], last)) break;
      heap[index] = heap[childIndex];
      index = childIndex;
    }
    heap[index] = last;
    return best;
  }

  function isBetterBenefitEntry(left, right) {
    return left.benefit > right.benefit ||
      left.benefit === right.benefit && left.rank < right.rank;
  }

  function writeMaskedTailComponentCandidate(output, offset, byteCount, candidate, coding) {
    const config = getMaskedTailConfig(coding, 8, 8, byteCount);
    const implicitPositions = config.implicitPositions || [];
    const coefficientOrder = getCoefficientOrder(coding, 8, 8);

    if (implicitPositions.length > 0) {
      output.fill(0, offset, offset + byteCount);
      const selected = new Uint8Array(64);
      for (const entry of candidate.explicitEntries) selected[entry.rank] = 1;
      let bitOffset = 0;
      for (let rank = 1; rank <= 62; rank += 1) {
        const position = coefficientOrder[rank];
        if (implicitPositions.includes(position)) continue;
        writeLittleEndianBits(output, offset, bitOffset, selected[rank], 1);
        bitOffset += 1;
      }
      writeLittleEndianBits(output, offset, bitOffset, candidate.scaleIndex, 2);
      bitOffset += 2;
      writeLittleEndianSignedBits(output, offset, bitOffset, candidate.dc, config.dcBits);
      bitOffset += config.dcBits;
      for (const entry of [
        ...candidate.implicitEntries,
        ...candidate.explicitEntries,
        ...candidate.tailEntries,
      ]) {
        writeLittleEndianSignedBits(output, offset, bitOffset, entry.stored, config.acBits);
        bitOffset += config.acBits;
      }
      return;
    }

    let maskLow = 0;
    let maskHigh = 0;

    output.fill(0, offset, offset + byteCount);
    for (const entry of candidate.explicitEntries) {
      const maskBit = entry.rank - 1;
      if (maskBit < 32) {
        maskLow = (maskLow | (1 << maskBit)) >>> 0;
      } else {
        maskHigh = (maskHigh | (1 << (maskBit - 32))) >>> 0;
      }
    }
    maskHigh = ((maskHigh & 0x3fffffff) | (candidate.scaleIndex << 30)) >>> 0;

    const view = new DataView(output.buffer, output.byteOffset + offset, byteCount);
    view.setUint32(0, maskLow, true);
    view.setUint32(4, maskHigh, true);

    let bitOffset = 0;
    writeLittleEndianSignedBits(output, offset + 8, bitOffset, candidate.dc, config.dcBits);
    bitOffset += config.dcBits;
    for (const entry of [...candidate.explicitEntries, ...candidate.tailEntries]) {
      writeLittleEndianSignedBits(output, offset + 8, bitOffset, entry.stored, config.acBits);
      bitOffset += config.acBits;
    }
  }

  function chooseLegacyComponentEncoding(
    coefficients,
    width,
    height,
    byteCount,
    quality,
    chroma,
    coding,
    reservedAcCount = 0,
    libraryFrequencySplit = 0
  ) {
    const acCount = Math.max(0, Math.floor((byteCount * 8 - 18) / 6) - reservedAcCount);
    let best = null;

    for (let profile = 0; profile < getProfileCount(coding); profile += 1) {
      const scan = getLibraryCoefficientScan(
        coding,
        profile,
        width,
        height,
        acCount,
        libraryFrequencySplit
      );

      for (let scaleIndex = 0; scaleIndex < SCALE_MULTIPLIERS.length; scaleIndex += 1) {
        const scale = SCALE_MULTIPLIERS[scaleIndex];
        const dcStep = quantizationStep(0, 0, width, height, quality, chroma) * scale;
        const dc = clamp(roundSigned(coefficients[0] / dcStep), -512, 511);
        let error = squaredNorm(coefficients);
        const restoredDc = dc * dcStep;
        const ac = [];

        error += (coefficients[0] - restoredDc) ** 2 - coefficients[0] ** 2;

        for (const position of scan) {
          const u = position % width;
          const v = Math.floor(position / width);
          const step = quantizationStep(u, v, width, height, quality, chroma) * scale;
          const stored = clamp(roundSigned(coefficients[position] / step), -32, 31);
          const restored = stored * step;

          ac.push(stored);
          error += (coefficients[position] - restored) ** 2 - coefficients[position] ** 2;
        }

        const candidate = { profile, scaleIndex, dc, ac, error };

        if (!best || compareComponentCandidates(candidate, best) < 0) {
          best = candidate;
        }
      }
    }

    return best;
  }

  function chooseSkipComponentEncoding(
    coefficients,
    width,
    height,
    byteCount,
    quality,
    chroma,
    coding,
    maximumError = Infinity
  ) {
    const layout = getSkipTokenLayout(byteCount, width, height, coding.skipMode);
    const coefficientCount = width * height;
    const baseError = squaredNorm(coefficients);
    const quantizationSteps = getScaledQuantizationSteps(width, height, quality, chroma);
    const coarseChoices = SCALE_MULTIPLIERS.map((_, scaleIndex) =>
      createSkipCoefficientChoices(
        coefficients,
        quantizationSteps,
        coefficientCount,
        scaleIndex,
        6
      )
    );
    const fineChoices = [0, 1].map((scaleIndex) => createSkipCoefficientChoices(
      coefficients,
      quantizationSteps,
      coefficientCount,
      scaleIndex,
      4
    ));
    const dcChoices = SCALE_MULTIPLIERS.map((_, scaleIndex) => quantizeSkipCoefficient(
      coefficients,
      0,
      width,
      height,
      quality,
      chroma,
      scaleIndex,
      10
    ));
    const maximumBenefits = coarseChoices.map((mainChoices, scaleIndex) => {
      const reducedChoices = fineChoices[scaleIndex >= 3 ? 1 : 0];
      return sumLargestBenefits(mainChoices.benefits, layout.coarseCount) +
        sumLargestBenefits(
          reducedChoices.benefits,
          layout.tokenCount - layout.coarseCount + layout.tailTokenCount
        );
    });
    let best = null;

    for (let profile = 0; profile < getProfileCount(coding, true); profile += 1) {
      const scan = getProfileScan(coding, profile, width, height, true);
      const maximumIndex = Math.min(scan.length - 1, 4 * (layout.tokenCount - 1));
      const rowSize = maximumIndex + 1;
      let previous = new Float64Array(rowSize);
      let current = new Float64Array(rowSize);
      const back = new Int16Array(layout.tokenCount * rowSize);
      const path = new Int16Array(layout.tokenCount);
      const maximumWindow = new Int16Array(4);

      for (let scaleIndex = 0; scaleIndex < SCALE_MULTIPLIERS.length; scaleIndex += 1) {
        const dcChoice = dcChoices[scaleIndex];
        const mainChoices = coarseChoices[scaleIndex];
        const reducedChoices = fineChoices[scaleIndex >= 3 ? 1 : 0];
        const errorLimit = best ? Math.min(maximumError, best.error) : maximumError;
        if (baseError + dcChoice.errorDelta - maximumBenefits[scaleIndex] > errorLimit) {
          continue;
        }
        previous.fill(Number.NEGATIVE_INFINITY);
        current.fill(Number.NEGATIVE_INFINITY);
        previous[0] = mainChoices.benefits[scan[0]];

        for (let tokenIndex = 1; tokenIndex < layout.tokenCount; tokenIndex += 1) {
          current.fill(Number.NEGATIVE_INFINITY);
          const choices = layout.dualScale && tokenIndex >= layout.coarseCount
            ? reducedChoices : mainChoices;
          const firstIndex = tokenIndex;
          const lastIndex = Math.min(maximumIndex, 4 * tokenIndex);
          const backOffset = tokenIndex * rowSize;
          fillSkipDpRow(
            previous,
            current,
            choices.benefits,
            scan,
            firstIndex,
            lastIndex,
            back,
            backOffset,
            maximumWindow
          );
          [previous, current] = [current, previous];
        }

        let endIndex = 0;
        let totalBenefit = Number.NEGATIVE_INFINITY;
        for (let index = 0; index <= maximumIndex; index += 1) {
          if (previous[index] > totalBenefit) {
            totalBenefit = previous[index];
            endIndex = index;
          }
        }
        if (!Number.isFinite(totalBenefit)) {
          continue;
        }

        path[layout.tokenCount - 1] = endIndex;
        for (let tokenIndex = layout.tokenCount - 1; tokenIndex > 0; tokenIndex -= 1) {
          path[tokenIndex - 1] = back[tokenIndex * rowSize + path[tokenIndex]];
        }

        const tokens = Array.from({ length: layout.tokenCount }, (_, tokenIndex) => {
          const fine = layout.dualScale && tokenIndex >= layout.coarseCount;
          const choices = fine ? reducedChoices : mainChoices;
          const position = scan[path[tokenIndex]];
          const stored = choices.stored[position];
          const skip = tokenIndex + 1 < layout.tokenCount
            ? path[tokenIndex + 1] - path[tokenIndex] - 1 : 0;
          return { position, stored, skip, bits: fine ? 4 : 6 };
        });
        const tail = selectSkipTailTokens(
          scan,
          path[layout.tokenCount - 1],
          layout.tailTokenCount,
          reducedChoices
        );
        if (tail.tokens.length > 0) {
          tokens[tokens.length - 1].skip = tail.firstSkip;
        }
        const error = baseError + dcChoice.errorDelta - totalBenefit - tail.benefit;
        const candidate = {
          profile,
          scaleIndex,
          dc: dcChoice.stored,
          tokens,
          tailTokens: tail.tokens,
          error,
          skipMode: coding.skipMode,
        };

        if (!best || compareComponentCandidates(candidate, best) < 0) {
          best = candidate;
        }
      }
    }

    return best;
  }

  function sumLargestBenefits(benefits, count) {
    if (count < 1) return 0;
    const largest = new Float64Array(count);
    let used = 0;

    for (const benefit of benefits) {
      if (benefit <= 0 || used === count && benefit <= largest[used - 1]) continue;
      let index = Math.min(used, count - 1);
      while (index > 0 && benefit > largest[index - 1]) {
        if (index < count) largest[index] = largest[index - 1];
        index -= 1;
      }
      largest[index] = benefit;
      if (used < count) used += 1;
    }

    let total = 0;
    for (let index = 0; index < used; index += 1) total += largest[index];
    return total;
  }

  function fillSkipDpRow(
    previous,
    current,
    coefficientBenefits,
    scan,
    firstIndex,
    lastIndex,
    back,
    backOffset,
    maximumWindow
  ) {
    let windowStart = 0;
    let windowLength = 0;

    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const minimumPreviousIndex = index - 4;
      while (windowLength > 0 && maximumWindow[windowStart] < minimumPreviousIndex) {
        windowStart = (windowStart + 1) & 3;
        windowLength -= 1;
      }

      const enteringIndex = index - 1;
      const enteringBenefit = previous[enteringIndex];
      if (Number.isFinite(enteringBenefit)) {
        while (windowLength > 0) {
          const lastWindowSlot = (windowStart + windowLength - 1) & 3;
          if (previous[maximumWindow[lastWindowSlot]] > enteringBenefit) break;
          windowLength -= 1;
        }
        maximumWindow[(windowStart + windowLength) & 3] = enteringIndex;
        windowLength += 1;
      }

      if (windowLength === 0) continue;
      const previousIndex = maximumWindow[windowStart];
      current[index] = previous[previousIndex] + coefficientBenefits[scan[index]];
      back[backOffset + index] = previousIndex;
    }
  }

  function getSkipTokenLayout(byteCount, width, height, skipMode) {
    const payloadBits = byteCount * 8 - 18;
    if (skipMode === "single") {
      const tokenCount = Math.floor(payloadBits / 8);
      return finishSkipTokenLayout(payloadBits, tokenCount, tokenCount, false);
    }

    let tokenCount;
    let coarseCount;
    if (byteCount === 32) {
      tokenCount = 32;
      coarseCount = 16;
    } else if (byteCount === 24) {
      tokenCount = 24;
      coarseCount = width === 16 && height === 16 ? 12 : 11;
    } else if (byteCount === 16) {
      tokenCount = width === 16 && height === 16 ? 15 : 14;
      coarseCount = width === 16 && height === 16 ? 7 : 8;
    } else {
      tokenCount = Math.floor(payloadBits / 7);
      coarseCount = Math.ceil(tokenCount / 2);
      while (coarseCount * 8 + (tokenCount - coarseCount) * 6 > payloadBits) {
        tokenCount -= 1;
        coarseCount = Math.ceil(tokenCount / 2);
      }
    }

    if (tokenCount < 1 || coarseCount * 8 + (tokenCount - coarseCount) * 6 > payloadBits) {
      throw new RangeError("DCT component record is too small for skip coding");
    }
    return finishSkipTokenLayout(payloadBits, tokenCount, coarseCount, true);
  }

  function finishSkipTokenLayout(payloadBits, tokenCount, coarseCount, dualScale) {
    const baseBits = coarseCount * 8 + (tokenCount - coarseCount) * 6;
    const spareBits = payloadBits - baseBits;
    let tailTokenCount = 0;
    let tailBits = 0;

    while (tailBits + 4 + (tailTokenCount > 0 ? 2 : 0) <= spareBits) {
      tailBits += 4 + (tailTokenCount > 0 ? 2 : 0);
      tailTokenCount += 1;
    }

    return { tokenCount, coarseCount, dualScale, spareBits, tailBits, tailTokenCount };
  }

  function selectSkipTailTokens(
    scan,
    lastScanIndex,
    tokenCount,
    choices
  ) {
    if (tokenCount < 1) {
      return { tokens: [], benefit: 0, firstSkip: 0 };
    }

    const indices = new Int16Array(tokenCount);
    const storedValues = new Int16Array(tokenCount);
    let bestBenefit = Number.NEGATIVE_INFINITY;
    let bestIndices = null;
    let bestStoredValues = null;

    const visit = (level, previousIndex, benefit) => {
      if (level === tokenCount) {
        if (benefit > bestBenefit) {
          bestBenefit = benefit;
          bestIndices = Int16Array.from(indices);
          bestStoredValues = Int16Array.from(storedValues);
        }
        return;
      }

      let hadCandidate = false;
      for (let distance = 1; distance <= 4; distance += 1) {
        const scanIndex = previousIndex + distance;
        if (scanIndex >= scan.length) break;
        hadCandidate = true;
        const position = scan[scanIndex];
        indices[level] = scanIndex;
        storedValues[level] = choices.stored[position];
        visit(level + 1, scanIndex, benefit + choices.benefits[position]);
      }

      if (!hadCandidate) {
        for (let index = level; index < tokenCount; index += 1) {
          indices[index] = -1;
          storedValues[index] = 0;
        }
        visit(tokenCount, previousIndex, benefit);
      }
    };

    visit(0, lastScanIndex, 0);
    if (!bestIndices) {
      return { tokens: [], benefit: 0, firstSkip: 0 };
    }

    const tokens = Array.from({ length: tokenCount }, (_, tokenIndex) => {
      const scanIndex = bestIndices[tokenIndex];
      const nextScanIndex = tokenIndex + 1 < tokenCount ? bestIndices[tokenIndex + 1] : -1;
      return {
        position: scanIndex >= 0 ? scan[scanIndex] : -1,
        stored: bestStoredValues[tokenIndex],
        skip: scanIndex >= 0 && nextScanIndex >= 0 ? nextScanIndex - scanIndex - 1 : 0,
      };
    });

    return {
      tokens,
      benefit: Math.max(0, bestBenefit),
      firstSkip: bestIndices[0] >= 0 ? bestIndices[0] - lastScanIndex - 1 : 0,
    };
  }

  function getSkipTokenParameters(layout, tokenIndex, mainScaleIndex) {
    const fine = layout.dualScale && tokenIndex >= layout.coarseCount;
    return {
      bits: fine ? 4 : 6,
      scaleIndex: fine ? (mainScaleIndex >= 3 ? 1 : 0) : mainScaleIndex,
    };
  }

  function quantizeSkipCoefficient(
    coefficients,
    position,
    width,
    height,
    quality,
    chroma,
    scaleIndex,
    bitCount
  ) {
    const u = position % width;
    const v = Math.floor(position / width);
    const step = quantizationStep(u, v, width, height, quality, chroma) *
      SCALE_MULTIPLIERS[scaleIndex];
    const minimum = -(2 ** (bitCount - 1));
    const maximum = 2 ** (bitCount - 1) - 1;
    const stored = clamp(roundSigned(coefficients[position] / step), minimum, maximum);
    const restored = stored * step;
    return {
      stored,
      errorDelta: (coefficients[position] - restored) ** 2 - coefficients[position] ** 2,
    };
  }

  function createSkipCoefficientChoices(
    coefficients,
    quantizationSteps,
    coefficientCount,
    scaleIndex,
    bitCount
  ) {
    const minimum = -(2 ** (bitCount - 1));
    const maximum = 2 ** (bitCount - 1) - 1;
    const stepOffset = scaleIndex * coefficientCount;
    const stored = new Int16Array(coefficientCount);
    const benefits = new Float64Array(coefficientCount);

    for (let position = 0; position < coefficientCount; position += 1) {
      const coefficient = coefficients[position];
      const step = quantizationSteps[stepOffset + position];
      const value = clamp(roundSigned(coefficient / step), minimum, maximum);
      const restored = value * step;
      const benefit = coefficient ** 2 - (coefficient - restored) ** 2;

      if (benefit > 0) {
        stored[position] = value;
        benefits[position] = benefit;
      }
    }

    return { stored, benefits };
  }

  function chooseGroupedComponentEncoding(
    coefficients,
    width,
    height,
    byteCount,
    quality,
    chroma,
    coding,
    reservedAcCount = 0,
    libraryFrequencySplit = 0
  ) {
    const layout = getGroupedAcLayout(
      byteCount,
      coding,
      reservedAcCount,
      width * height - 1
    );
    const quantizationSteps = getScaledQuantizationSteps(width, height, quality, chroma);
    const dcChoice = chooseQuantizedGroup(
      coefficients,
      [0],
      width,
      height,
      quality,
      chroma,
      10,
      quantizationSteps
    );
    const baseError = squaredNorm(coefficients) + dcChoice.errorDelta;
    let best = null;

    for (let profile = 0; profile < getProfileCount(coding); profile += 1) {
      const scan = getLibraryCoefficientScan(
        coding,
        profile,
        width,
        height,
        layout.acCount,
        libraryFrequencySplit
      );
      const ac = [];
      const groupScaleIndices = [];
      let error = baseError;
      let groupStart = 0;

      for (const groupEnd of layout.groupEnds) {
        const positions = scan.slice(groupStart, groupEnd);
        const group = chooseQuantizedGroup(
          coefficients,
          positions,
          width,
          height,
          quality,
          chroma,
          coding.mantissaBits,
          quantizationSteps
        );

        groupScaleIndices.push(group.scaleIndex);
        ac.push(...group.values);
        error += group.errorDelta;
        groupStart = groupEnd;
      }

      const candidate = {
        profile,
        scaleIndex: dcChoice.scaleIndex,
        dc: dcChoice.values[0],
        ac,
        groupScaleIndices,
        error,
      };

      if (!best || compareComponentCandidates(candidate, best) < 0) {
        best = candidate;
      }
    }

    return best;
  }

  function chooseQuantizedGroup(
    coefficients,
    positions,
    width,
    height,
    quality,
    chroma,
    bitCount,
    quantizationSteps = getScaledQuantizationSteps(width, height, quality, chroma)
  ) {
    const minimum = -(2 ** (bitCount - 1));
    const maximum = 2 ** (bitCount - 1) - 1;
    const coefficientCount = width * height;
    let bestScaleIndex = -1;
    let bestErrorDelta = Infinity;

    for (let scaleIndex = 0; scaleIndex < SCALE_MULTIPLIERS.length; scaleIndex += 1) {
      let errorDelta = 0;

      for (const position of positions) {
        const step = quantizationSteps[scaleIndex * coefficientCount + position];
        const stored = clamp(roundSigned(coefficients[position] / step), minimum, maximum);
        const restored = stored * step;

        errorDelta += (coefficients[position] - restored) ** 2 - coefficients[position] ** 2;
      }

      if (errorDelta < bestErrorDelta ||
          (errorDelta === bestErrorDelta && scaleIndex < bestScaleIndex)) {
        bestScaleIndex = scaleIndex;
        bestErrorDelta = errorDelta;
      }
    }

    const values = positions.map((position) => {
      const step = quantizationSteps[bestScaleIndex * coefficientCount + position];
      return clamp(roundSigned(coefficients[position] / step), minimum, maximum);
    });
    return { scaleIndex: bestScaleIndex, values, errorDelta: bestErrorDelta };
  }

  function getGroupedAcLayout(byteCount, coding, reservedAcCount = 0, maximumAcCount = Infinity) {
    const acCount = Math.min(
      maximumAcCount,
      Math.max(
        0,
        Math.floor((byteCount * 8 - 18 - coding.groupCount * 3) / coding.mantissaBits) -
          reservedAcCount
      )
    );
    let groupEnds;

    if (coding.grouping === "front") {
      groupEnds = [Math.ceil(acCount / 6), Math.ceil(acCount / 2), acCount];
    } else {
      groupEnds = Array.from(
        { length: coding.groupCount },
        (_, groupIndex) => Math.floor((groupIndex + 1) * acCount / coding.groupCount)
      );
    }

    return { acCount, groupEnds };
  }

  function describeDctComponentRecord(options = {}) {
    const byteCount = Math.round(Number(options.byteCount));
    const width = Math.round(Number(options.width));
    const height = Math.round(Number(options.height));

    if (!Number.isInteger(byteCount) || byteCount < 1 ||
        !Number.isInteger(width) || width < 1 ||
        !Number.isInteger(height) || height < 1) {
      throw new RangeError("DCT component record description requires positive dimensions and bytes");
    }

    const baseCoding = getCoefficientCoding(options.coefficientCodingKey, options.presetKey);
    const coding = withCoefficientOrder(baseCoding, options.zigzagOrder !== false);
    const referenceCoding = options.libraryReferenceCoding === undefined ||
      options.libraryReferenceCoding === null
      ? null : String(options.libraryReferenceCoding);
    if (referenceCoding !== null && !["header", "tail", "sidecar"].includes(referenceCoding)) {
      throw new RangeError("Unsupported DCT prototype reference coding");
    }

    const maskedConfig = getMaskedTailConfig(coding, width, height, byteCount);
    const variants = maskedConfig
      ? [describeMaskedTailRecord(byteCount, coding, maskedConfig)]
      : [describeSequentialRecord(byteCount, width, height, coding, referenceCoding)];
    if (!maskedConfig && options.allowSkip && !referenceCoding && coding.skipMode) {
      variants.push(describeSkipRecord(byteCount, width, height, coding));
    }

    const sidecarBits = referenceCoding === "sidecar"
      ? Math.max(0, Math.round(Number(options.libraryReferenceBits) || 0)) : 0;
    return {
      byteCount,
      totalBits: byteCount * 8,
      width,
      height,
      coefficientCount: width * height,
      coefficientCodingKey: coding.key,
      zigzagOrder: Boolean(coding.zigzagOrder),
      bitOrder: maskedConfig ? "lsb-first" : "msb-first",
      prototypeReference: referenceCoding ? {
        coding: referenceCoding,
        bits: referenceCoding === "header" ? 2 :
          referenceCoding === "tail" ? coding.mantissaBits : sidecarBits,
        location: referenceCoding === "sidecar" ? "sidecar" : "record",
      } : null,
      variants,
    };
  }

  function describeSequentialRecord(byteCount, width, height, coding, referenceCoding) {
    const fields = [];
    const add = createDctRecordFieldAdder(fields);
    if (referenceCoding === "header") {
      add("library-index", 2, "index", { valueBits: 2, maximum: 3 });
      add("profile", 2, "header", { valueBits: 2 });
    } else {
      add("profile", 4, "header", { valueBits: 4 });
    }
    add("record-mode", 1, "flag", { value: 0 });
    add(coding.groupCount > 0 ? "dc-scale" : "shared-scale", 3, "flag", {
      valueBits: 3,
    });
    add("dc", 10, "dct", { count: 1, valueBits: 10, signed: true });

    const reservedAcCount = referenceCoding === "tail" ? 1 : 0;
    let acCount;
    let mode;
    let acBitDepths;
    if (coding.groupCount > 0) {
      mode = "grouped";
      const layout = getGroupedAcLayout(
        byteCount,
        coding,
        reservedAcCount,
        width * height - 1
      );
      acCount = layout.acCount;
      let groupStart = 0;
      for (let groupIndex = 0; groupIndex < layout.groupEnds.length; groupIndex += 1) {
        add("ac-group-scale", 3, "flag", { group: groupIndex + 1, valueBits: 3 });
      }
      for (let groupIndex = 0; groupIndex < layout.groupEnds.length; groupIndex += 1) {
        const count = layout.groupEnds[groupIndex] - groupStart;
        if (count > 0) {
          add("ac-group-values", count * coding.mantissaBits, "dct", {
            group: groupIndex + 1,
            count,
            valueBits: coding.mantissaBits,
            signed: true,
          });
        }
        groupStart = layout.groupEnds[groupIndex];
      }
      acBitDepths = [{ count: acCount, bits: coding.mantissaBits }];
    } else {
      mode = "legacy";
      acCount = Math.min(
        width * height - 1,
        Math.max(0, Math.floor((byteCount * 8 - 18) / coding.mantissaBits) - reservedAcCount)
      );
      if (acCount > 0) {
        add("ac-values", acCount * coding.mantissaBits, "dct", {
          count: acCount,
          valueBits: coding.mantissaBits,
          signed: true,
        });
      }
      acBitDepths = [{ count: acCount, bits: coding.mantissaBits }];
    }

    if (referenceCoding === "tail") {
      add("library-index", coding.mantissaBits, "index", {
        valueBits: coding.mantissaBits,
        maximum: 2 ** coding.mantissaBits - 1,
      });
    }
    finishDctRecordFields(fields, byteCount * 8, add);
    return {
      key: mode,
      mode,
      bitOrder: "msb-first",
      dcBits: 10,
      acCount,
      acBitDepths,
      fields,
    };
  }

  function describeSkipRecord(byteCount, width, height, coding) {
    const fields = [];
    const add = createDctRecordFieldAdder(fields);
    const layout = getSkipTokenLayout(byteCount, width, height, coding.skipMode);
    const fineCount = layout.tokenCount - layout.coarseCount;
    add("profile", 4, "header", { valueBits: 4 });
    add("record-mode", 1, "flag", { value: 1 });
    add("main-scale", 3, "flag", { valueBits: 3 });
    add("dc", 10, "dct", { count: 1, valueBits: 10, signed: true });
    if (layout.coarseCount > 0) {
      add("coarse-skip-tokens", layout.coarseCount * 8, "dct", {
        count: layout.coarseCount,
        valueBits: 6,
        skipBits: 2,
        unitBits: 8,
        signed: true,
      });
    }
    if (fineCount > 0) {
      add("fine-skip-tokens", fineCount * 6, "dct", {
        count: fineCount,
        valueBits: 4,
        skipBits: 2,
        unitBits: 6,
        signed: true,
      });
    }
    if (layout.tailTokenCount > 0) {
      add("fine-tail-tokens", layout.tailBits, "dct", {
        count: layout.tailTokenCount,
        valueBits: 4,
        skipBits: 2,
        unitBits: null,
        signed: true,
      });
    }
    finishDctRecordFields(fields, byteCount * 8, add);
    return {
      key: layout.dualScale ? "dual-scale-skip" : "skip-rle",
      mode: layout.dualScale ? "dual-scale-skip" : "skip-rle",
      bitOrder: "msb-first",
      dcBits: 10,
      acCount: layout.tokenCount + layout.tailTokenCount,
      acBitDepths: [
        ...(layout.coarseCount > 0 ? [{ count: layout.coarseCount, bits: 6 }] : []),
        ...(fineCount + layout.tailTokenCount > 0
          ? [{ count: fineCount + layout.tailTokenCount, bits: 4 }] : []),
      ],
      coarseAcCount: layout.coarseCount,
      fineAcCount: fineCount,
      tailAcCount: layout.tailTokenCount,
      fields,
    };
  }

  function describeMaskedTailRecord(byteCount, coding, config) {
    const fields = [];
    const add = createDctRecordFieldAdder(fields);
    const implicitCount = (config.implicitPositions || []).length;
    if (implicitCount > 0) {
      add("ac-selection-mask", 62 - implicitCount, "map", {
        count: 62 - implicitCount,
        firstRank: 1,
        lastRank: 62,
        excludedImplicitCount: implicitCount,
      });
      add("shared-scale", 2, "flag", { valueBits: 2 });
      add("dc", config.dcBits, "dct", {
        count: 1,
        valueBits: config.dcBits,
        signed: true,
      });
      add("implicit-ac-values", implicitCount * config.acBits, "dct", {
        count: implicitCount,
        valueBits: config.acBits,
        signed: true,
      });
      add("selected-tail-ac-values", (config.maxAc - implicitCount) * config.acBits, "dct", {
        count: config.maxAc - implicitCount,
        valueBits: config.acBits,
        signed: true,
      });
    } else {
      add("ac-mask-low", 32, "map", { count: 32, firstRank: 1, lastRank: 32 });
      add("ac-mask-high", 30, "map", { count: 30, firstRank: 33, lastRank: 62 });
      add("shared-scale", 2, "flag", { valueBits: 2 });
      add("dc", config.dcBits, "dct", {
        count: 1,
        valueBits: config.dcBits,
        signed: true,
      });
      add("selected-tail-ac-values", config.maxAc * config.acBits, "dct", {
        count: config.maxAc,
        valueBits: config.acBits,
        signed: true,
      });
    }
    finishDctRecordFields(fields, byteCount * 8, add);
    return {
      key: implicitCount > 0 ? "masked-tail-implicit2" : "masked-tail",
      mode: implicitCount > 0 ? "masked-tail-implicit2" : "masked-tail",
      bitOrder: "lsb-first",
      dcBits: config.dcBits,
      acCount: config.maxAc,
      acBitDepths: [{ count: config.maxAc, bits: config.acBits }],
      implicitAcCount: implicitCount,
      selectableAcCount: 62 - implicitCount,
      fields,
    };
  }

  function createDctRecordFieldAdder(fields) {
    let bitOffset = 0;
    const add = (key, bits, tone, metadata = {}) => {
      if (bits <= 0) return;
      fields.push({ key, startBit: bitOffset, bits, tone, ...metadata });
      bitOffset += bits;
    };
    add.offset = () => bitOffset;
    return add;
  }

  function finishDctRecordFields(fields, totalBits, add) {
    const remaining = totalBits - add.offset();
    if (remaining < 0) {
      throw new RangeError("DCT component record description exceeds its byte budget");
    }
    if (remaining > 0) add("padding", remaining, "reserved", { value: 0 });
    return fields;
  }

  function writeLittleEndianBits(bytes, byteOffset, bitOffset, value, bitCount) {
    for (let bit = 0; bit < bitCount; bit += 1) {
      if ((value >> bit & 1) !== 0) {
        const absoluteBit = bitOffset + bit;
        bytes[byteOffset + (absoluteBit >> 3)] |= 1 << (absoluteBit & 7);
      }
    }
  }

  function writeLittleEndianSignedBits(bytes, byteOffset, bitOffset, value, bitCount) {
    writeLittleEndianBits(
      bytes,
      byteOffset,
      bitOffset,
      value < 0 ? value + 2 ** bitCount : value,
      bitCount
    );
  }

  function readLittleEndianBits(bytes, byteOffset, bitOffset, bitCount) {
    let value = 0;
    for (let bit = 0; bit < bitCount; bit += 1) {
      const absoluteBit = bitOffset + bit;
      value |= (bytes[byteOffset + (absoluteBit >> 3)] >> (absoluteBit & 7) & 1) << bit;
    }
    return value;
  }

  function readLittleEndianSignedBits(bytes, byteOffset, bitOffset, bitCount) {
    const value = readLittleEndianBits(bytes, byteOffset, bitOffset, bitCount);
    const signBit = 2 ** (bitCount - 1);
    return value >= signBit ? value - 2 ** bitCount : value;
  }

  function maskedTailHasRank(maskLow, maskHigh, rank) {
    const maskBit = rank - 1;
    return maskBit < 32
      ? (maskLow >>> maskBit & 1) !== 0
      : (maskHigh >>> (maskBit - 32) & 1) !== 0;
  }

  function decodeMaskedTailComponent(bytes, offset, byteCount, quality, chroma, coding) {
    const config = getMaskedTailConfig(coding, 8, 8, byteCount);
    const implicitPositions = config.implicitPositions || [];
    const coefficientOrder = getCoefficientOrder(coding, 8, 8);
    const implicit = new Uint8Array(64);
    const selected = new Uint8Array(64);
    for (const position of implicitPositions) implicit[coefficientOrder.indexOf(position)] = 1;
    let scaleIndex;
    let bitOffset;

    if (implicitPositions.length > 0) {
      bitOffset = 0;
      for (let rank = 1; rank <= 62; rank += 1) {
        if (implicit[rank]) continue;
        selected[rank] = readLittleEndianBits(bytes, offset, bitOffset, 1);
        bitOffset += 1;
      }
      scaleIndex = readLittleEndianBits(bytes, offset, bitOffset, 2);
      bitOffset += 2;
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, byteCount);
      const maskLow = view.getUint32(0, true);
      const rawMaskHigh = view.getUint32(4, true);
      const maskHigh = rawMaskHigh & 0x3fffffff;
      scaleIndex = rawMaskHigh >>> 30;
      bitOffset = 64;
      for (let rank = 1; rank <= 62; rank += 1) {
        selected[rank] = maskedTailHasRank(maskLow, maskHigh, rank) ? 1 : 0;
      }
    }

    const explicitAcCount = selected.reduce((total, value) => total + value, 0);
    const flexibleAcCount = config.maxAc - implicitPositions.length;
    if (explicitAcCount > flexibleAcCount) {
      throw new RangeError("Invalid DCT masked-tail AC count");
    }

    const tailAcCount = flexibleAcCount - explicitAcCount;
    const tailStart = 64 - tailAcCount;
    for (let rank = Math.max(1, tailStart); rank <= 62; rank += 1) {
      if (selected[rank]) {
        throw new RangeError("DCT masked AC overlaps the implicit tail");
      }
    }

    const scale = SCALE_MULTIPLIERS[scaleIndex];
    const coefficients = new Float64Array(64);
    const dc = readLittleEndianSignedBits(bytes, offset, bitOffset, config.dcBits);
    bitOffset += config.dcBits;
    coefficients[0] = dc * quantizationStep(0, 0, 8, 8, quality, chroma) * scale;
    let storedCoefficientCount = dc === 0 ? 0 : 1;

    for (const position of implicitPositions) {
      const stored = readLittleEndianSignedBits(bytes, offset, bitOffset, config.acBits);
      bitOffset += config.acBits;
      coefficients[position] = stored *
        quantizationStep(position % 8, Math.floor(position / 8), 8, 8, quality, chroma) * scale;
      storedCoefficientCount += stored === 0 ? 0 : 1;
    }
    for (let rank = 1; rank < tailStart && rank <= 62; rank += 1) {
      if (!selected[rank]) continue;
      const position = coefficientOrder[rank];
      const stored = readLittleEndianSignedBits(bytes, offset, bitOffset, config.acBits);
      bitOffset += config.acBits;
      coefficients[position] = stored *
        quantizationStep(position % 8, Math.floor(position / 8), 8, 8, quality, chroma) * scale;
      storedCoefficientCount += stored === 0 ? 0 : 1;
    }
    for (let rank = tailStart; rank <= 63; rank += 1) {
      const position = coefficientOrder[rank];
      const stored = readLittleEndianSignedBits(bytes, offset, bitOffset, config.acBits);
      bitOffset += config.acBits;
      coefficients[position] = stored *
        quantizationStep(position % 8, Math.floor(position / 8), 8, 8, quality, chroma) * scale;
      storedCoefficientCount += stored === 0 ? 0 : 1;
    }

    return {
      coefficients,
      profile: null,
      scaleIndex,
      groupScaleIndices: [scaleIndex],
      coefficientCount: config.maxAc + 1,
      storedCoefficientCount,
      implicitAcCount: implicitPositions.length,
      explicitAcCount,
      tailAcCount,
      tailStart,
      libraryIndex: 0,
      encodingMode: implicitPositions.length > 0
        ? "masked-tail-implicit2" : "masked-tail",
    };
  }

  function decodeComponent(
    bytes,
    offset,
    byteCount,
    width,
    height,
    quality,
    chroma,
    coding,
    libraryContext = null
  ) {
    if (isMaskedTailRecord(coding, width, height, byteCount)) {
      if (libraryContext) {
        throw new RangeError("DCT masked-tail records do not support prototype libraries");
      }
      return decodeMaskedTailComponent(bytes, offset, byteCount, quality, chroma, coding);
    }

    const reader = new BitReader(bytes, offset, byteCount);
    const header = reader.read(8);
    const packedProfile = header >> 4;
    const headerReference = libraryContext && libraryContext.library.referenceCoding === "header";
    const tailReference = libraryContext && libraryContext.library.referenceCoding === "tail";
    const packedScale = header & 15;
    const skipRecord = Boolean(coding.skipMode && (packedScale & 8));
    const profile = skipRecord ? packedProfile : headerReference ? packedProfile & 3 : packedProfile;
    let libraryIndex = headerReference ? packedProfile >> 2 :
      libraryContext && libraryContext.library.referenceCoding === "sidecar"
        ? libraryContext.libraryIndex : 0;
    const scaleIndex = packedScale & 7;

    if (profile >= getProfileCount(coding, skipRecord) ||
        !skipRecord && packedScale >= SCALE_MULTIPLIERS.length || skipRecord && libraryContext) {
      throw new RangeError("Invalid DCT component profile");
    }

    const coefficients = new Float64Array(width * height);
    const dc = reader.readSigned(10);
    const reservedAcCount = tailReference ? 1 : 0;
    coefficients[0] = dc * quantizationStep(0, 0, width, height, quality, chroma) *
      SCALE_MULTIPLIERS[scaleIndex];

    if (skipRecord) {
      const skipLayout = getSkipTokenLayout(byteCount, width, height, coding.skipMode);
      const scan = getProfileScan(coding, profile, width, height, true);
      let scanIndex = 0;
      let storedCoefficientCount = dc === 0 ? 0 : 1;

      for (let tokenIndex = 0; tokenIndex < skipLayout.tokenCount; tokenIndex += 1) {
        if (scanIndex >= scan.length) {
          throw new RangeError("Invalid DCT skip-RLE profile traversal");
        }
        const parameters = getSkipTokenParameters(skipLayout, tokenIndex, scaleIndex);
        const stored = reader.readSigned(parameters.bits);
        const skip = reader.read(2);
        const position = scan[scanIndex];
        const u = position % width;
        const v = Math.floor(position / width);
        coefficients[position] = stored * quantizationStep(u, v, width, height, quality, chroma) *
          SCALE_MULTIPLIERS[parameters.scaleIndex];
        storedCoefficientCount += stored === 0 ? 0 : 1;
        scanIndex += skip + 1;
      }

      const tailScaleIndex = scaleIndex >= 3 ? 1 : 0;
      let tailStoredCoefficientCount = 0;
      for (let tokenIndex = 0; tokenIndex < skipLayout.tailTokenCount; tokenIndex += 1) {
        const stored = reader.readSigned(4);
        if (scanIndex < scan.length) {
          const position = scan[scanIndex];
          const u = position % width;
          const v = Math.floor(position / width);
          coefficients[position] = stored * quantizationStep(u, v, width, height, quality, chroma) *
            SCALE_MULTIPLIERS[tailScaleIndex];
        } else if (stored !== 0) {
          throw new RangeError("Invalid DCT skip tail traversal");
        }
        tailStoredCoefficientCount += stored === 0 ? 0 : 1;
        if (tokenIndex + 1 < skipLayout.tailTokenCount) {
          scanIndex += reader.read(2) + 1;
        }
      }
      storedCoefficientCount += tailStoredCoefficientCount;

      return {
        coefficients,
        profile,
        profileName: getProfileName(coding, profile, true),
        scaleIndex,
        groupScaleIndices: skipLayout.dualScale
          ? [scaleIndex, getSkipTokenParameters(skipLayout, skipLayout.coarseCount, scaleIndex).scaleIndex]
          : [scaleIndex],
        coefficientCount: skipLayout.tokenCount + skipLayout.tailTokenCount + 1,
        storedCoefficientCount,
        tailAcCount: skipLayout.tailTokenCount,
        tailStoredCoefficientCount,
        libraryIndex: 0,
        encodingMode: skipLayout.dualScale ? "dual-scale-skip" : "skip-rle",
      };
    }

    const groupedLayout = coding.groupCount > 0
      ? getGroupedAcLayout(byteCount, coding, reservedAcCount, width * height - 1)
      : null;
    const acCount = groupedLayout
      ? groupedLayout.acCount
      : Math.max(0, Math.floor((byteCount * 8 - 18) / 6) - reservedAcCount);
    const frequencySplit = libraryIndex > 0 && libraryContext
      ? libraryContext.library.frequencySplit : 0;
    const scan = getLibraryCoefficientScan(
      coding,
      profile,
      width,
      height,
      acCount,
      frequencySplit
    );

    const groupScaleIndices = groupedLayout ? groupedLayout.groupEnds.map(() => reader.read(3)) : [scaleIndex];
    const groupEnds = groupedLayout ? groupedLayout.groupEnds : [acCount];
    let groupStart = 0;

    for (let groupIndex = 0; groupIndex < groupEnds.length; groupIndex += 1) {
      const scale = SCALE_MULTIPLIERS[groupScaleIndices[groupIndex]];

      for (let index = groupStart; index < groupEnds[groupIndex]; index += 1) {
        const position = scan[index];
        const u = position % width;
        const v = Math.floor(position / width);
        coefficients[position] = reader.readSigned(coding.mantissaBits) *
          quantizationStep(u, v, width, height, quality, chroma) * scale;
      }
      groupStart = groupEnds[groupIndex];
    }

    if (tailReference) {
      libraryIndex = reader.read(coding.mantissaBits);
    }

    if (libraryIndex > 0) {
      const prototype = decodeDctLibraryPrototype(
        libraryContext,
        libraryIndex,
        width,
        height,
        quality,
        chroma,
        coding
      );
      for (let position = 0; position < coefficients.length; position += 1) {
        coefficients[position] += prototype[position];
      }
    }

    return {
      coefficients,
      profile,
      profileName: getProfileName(coding, profile),
      scaleIndex,
      groupScaleIndices,
      coefficientCount: acCount + 1,
      storedCoefficientCount: acCount + (dc === 0 ? 0 : 1),
      libraryIndex,
      encodingMode: groupedLayout ? "grouped" : "legacy",
    };
  }

  function decodeDctLibraryPrototype(
    context,
    libraryIndex,
    width,
    height,
    quality,
    chroma,
    coding
  ) {
    const component = context.library[context.kind];

    if (!component || libraryIndex < 1 || libraryIndex > component.count) {
      throw new RangeError("Invalid DCT prototype library index");
    }

    const cacheKey = `${context.kind}:${libraryIndex}`;
    if (!context.library.cache.has(cacheKey)) {
      const offset = component.offset + (libraryIndex - 1) * component.recordBytes;
      const decoded = decodeComponent(
        context.bytes,
        offset,
        component.recordBytes,
        width,
        height,
        quality,
        chroma,
        coding
      );
      context.library.cache.set(cacheKey, decoded.coefficients);
    }

    return context.library.cache.get(cacheKey);
  }

  function readDctLibraryReference(bytes, component, referenceIndex) {
    if (!component.reference || component.reference.bits === 0) {
      return 0;
    }
    if (referenceIndex < 0 || referenceIndex >= component.reference.count) {
      throw new RangeError("DCT library sidecar reference is out of range");
    }
    const bitOffset = component.reference.offset * 8 + referenceIndex * component.reference.bits;
    let libraryIndex = 0;
    for (let bit = 0; bit < component.reference.bits; bit += 1) {
      const position = bitOffset + bit;
      libraryIndex |= ((bytes[position >> 3] >> (position & 7)) & 1) << bit;
    }
    if (libraryIndex > component.count) {
      throw new RangeError("Invalid DCT library sidecar reference");
    }
    return libraryIndex;
  }

  function createDctLibraryContext(bytes, info, kind, referenceIndex = 0) {
    if (!info.libraryEnabled) {
      return null;
    }
    const component = info.library[kind];
    const libraryIndex = info.library.referenceCoding === "sidecar"
      ? readDctLibraryReference(bytes, component, referenceIndex) : 0;
    return { bytes, library: info.library, kind, libraryIndex };
  }

  function decodeMcuComponents(bytes, info, mcuIndex) {
    const offset = HEADER_BYTES + mcuIndex * info.bytesPerMcu;

    return {
      y: decodeLuma(
        bytes,
        offset,
        info.yBytes,
        info.quality,
        info.splitLuma8x8,
        info.coefficientCoding,
        info.splitLuma8x8
          ? (blockIndex) => createDctLibraryContext(bytes, info, "y", mcuIndex * 4 + blockIndex)
          : createDctLibraryContext(bytes, info, "y", mcuIndex)
      ),
      cb: decodeComponent(
        bytes,
        offset + info.yBytes,
        info.cbBytes,
        8,
        info.chromaHeight,
        info.quality,
        true,
        info.coefficientCoding,
        createDctLibraryContext(bytes, info, "cb", mcuIndex)
      ),
      cr: decodeComponent(
        bytes,
        offset + info.yBytes + info.cbBytes,
        info.crBytes,
        8,
        info.chromaHeight,
        info.quality,
        true,
        info.coefficientCoding,
        createDctLibraryContext(bytes, info, "cr", mcuIndex)
      ),
    };
  }

  function decodeLuma(bytes, offset, byteCount, quality, split, coding, libraryContext = null) {
    if (!split) {
      return decodeComponent(
        bytes,
        offset,
        byteCount,
        16,
        16,
        quality,
        false,
        coding,
        resolveDctLibraryContext(libraryContext, 0)
      );
    }

    const blockBytes = byteCount / 4;
    return {
      blocks: Array.from({ length: 4 }, (_, blockIndex) => decodeComponent(
        bytes,
        offset + blockIndex * blockBytes,
        blockBytes,
        8,
        8,
        quality,
        false,
        coding,
        resolveDctLibraryContext(libraryContext, blockIndex)
      )),
    };
  }

  function resolveDctLibraryContext(libraryContext, blockIndex) {
    return typeof libraryContext === "function" ? libraryContext(blockIndex) : libraryContext;
  }

  function reconstructLumaPlane(component) {
    if (!component.blocks) {
      return inverseDct(component.coefficients, 16, 16);
    }

    const plane = new Float64Array(256);
    component.blocks.forEach((block, blockIndex) => {
      const samples = inverseDct(block.coefficients, 8, 8);
      const blockX = blockIndex % 2;
      const blockY = Math.floor(blockIndex / 2);

      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          plane[(blockY * 8 + y) * 16 + blockX * 8 + x] = samples[y * 8 + x];
        }
      }
    });
    return plane;
  }

  function sampleLumaRecord(
    bytes,
    offset,
    byteCount,
    quality,
    split,
    coding,
    libraryContext,
    x,
    y
  ) {
    if (!split) {
      const component = decodeComponent(
        bytes,
        offset,
        byteCount,
        16,
        16,
        quality,
        false,
        coding,
        resolveDctLibraryContext(libraryContext, 0)
      );
      return sampleInverseDct(component.coefficients, 16, 16, x, y);
    }

    const blockBytes = byteCount / 4;
    const blockIndex = Math.floor(y / 8) * 2 + Math.floor(x / 8);
    const component = decodeComponent(
      bytes,
      offset + blockIndex * blockBytes,
      blockBytes,
      8,
      8,
      quality,
      false,
      coding,
      resolveDctLibraryContext(libraryContext, blockIndex)
    );
    return sampleInverseDct(component.coefficients, 8, 8, x % 8, y % 8);
  }

  function summarizeComponent(component) {
    if (!component.blocks) {
      return {
        profile: component.profile,
        profileName: component.encodingMode === "masked-tail-implicit2"
          ? "implicit AC1/AC2 + masked AC + implicit high-frequency tail"
          : component.encodingMode === "masked-tail"
            ? "masked AC + implicit high-frequency tail"
          : component.profileName,
        scaleIndex: component.scaleIndex,
        scale: SCALE_MULTIPLIERS[component.scaleIndex],
        groupScaleIndices: component.groupScaleIndices,
        groupScales: component.groupScaleIndices.map((scaleIndex) => SCALE_MULTIPLIERS[scaleIndex]),
        coefficientCount: component.coefficientCount,
        storedCoefficientCount: component.storedCoefficientCount,
        libraryIndex: component.libraryIndex,
        encodingMode: component.encodingMode,
        implicitAcCount: component.implicitAcCount || 0,
        explicitAcCount: component.explicitAcCount,
        tailAcCount: component.tailAcCount,
        tailStoredCoefficientCount: component.tailStoredCoefficientCount,
        tailStart: component.tailStart,
        coefficients: Array.from(component.coefficients),
      };
    }

    return {
      profile: null,
      profileName: "four 8x8 luma blocks",
      scaleIndex: null,
      scale: null,
      coefficientCount: component.blocks.reduce((total, block) => total + block.coefficientCount, 0),
      storedCoefficientCount: component.blocks.reduce(
        (total, block) => total + block.storedCoefficientCount,
        0
      ),
      blocks: component.blocks.map((block) => summarizeComponent(block)),
    };
  }

  function extractMcuPlanes(pixels, width, height, mcuX, mcuY, chroma420 = true) {
    const chromaHeight = chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422;
    const yPlane = new Float64Array(16 * 16);
    const cbPlane = new Float64Array(CHROMA_WIDTH * chromaHeight);
    const crPlane = new Float64Array(CHROMA_WIDTH * chromaHeight);

    for (let localY = 0; localY < 16; localY += 1) {
      const y = Math.min(height - 1, mcuY * 16 + localY);

      for (let localX = 0; localX < 16; localX += 1) {
        const x = Math.min(width - 1, mcuX * 16 + localX);
        const pixelOffset = (y * width + x) * 4;
        const converted = rgbToYCbCr(
          pixels[pixelOffset], pixels[pixelOffset + 1], pixels[pixelOffset + 2]
        );
        yPlane[localY * 16 + localX] = converted.y - 128;
      }
    }

    const verticalSamples = chroma420 ? 2 : 1;
    for (let chromaY = 0; chromaY < chromaHeight; chromaY += 1) {
      for (let chromaX = 0; chromaX < CHROMA_WIDTH; chromaX += 1) {
        let cbSum = 0;
        let crSum = 0;
        for (let sampleY = 0; sampleY < verticalSamples; sampleY += 1) {
          const localY = chromaY * verticalSamples + sampleY;
          const y = Math.min(height - 1, mcuY * 16 + localY);
          for (let sampleX = 0; sampleX < 2; sampleX += 1) {
            const localX = chromaX * 2 + sampleX;
            const x = Math.min(width - 1, mcuX * 16 + localX);
            const pixelOffset = (y * width + x) * 4;
            const converted = rgbToYCbCr(
              pixels[pixelOffset], pixels[pixelOffset + 1], pixels[pixelOffset + 2]
            );
            cbSum += converted.cb;
            crSum += converted.cr;
          }
        }
        const divisor = verticalSamples * 2;
        cbPlane[chromaY * CHROMA_WIDTH + chromaX] = cbSum / divisor - 128;
        crPlane[chromaY * CHROMA_WIDTH + chromaX] = crSum / divisor - 128;
      }
    }

    return { y: yPlane, cb: cbPlane, cr: crPlane };
  }

  function prepareJpegDctMetadata(jpeg) {
    if (!jpeg || typeof jpeg !== "object") {
      throw new TypeError("JPEG DCT import requires parsed JPEG coefficient data");
    }

    validateDimensions(jpeg.width, jpeg.height);

    if (!Array.isArray(jpeg.components) || (jpeg.components.length !== 1 && jpeg.components.length !== 3)) {
      throw new RangeError("JPEG DCT import supports grayscale and three-component YCbCr images");
    }

    const maxHorizontalSampling = validateJpegSampling(jpeg.maxHorizontalSampling);
    const maxVerticalSampling = validateJpegSampling(jpeg.maxVerticalSampling);
    const components = jpeg.components.map((component) => prepareJpegComponentMetadata(
      component,
      jpeg.width,
      jpeg.height,
      maxHorizontalSampling,
      maxVerticalSampling
    ));

    for (const component of components) {
      if (component.horizontalSampling > maxHorizontalSampling ||
          component.verticalSampling > maxVerticalSampling) {
        throw new RangeError("Invalid JPEG component sampling factors");
      }
    }

    return {
      width: jpeg.width,
      height: jpeg.height,
      maxHorizontalSampling,
      maxVerticalSampling,
      components,
    };
  }

  function prepareJpegComponentMetadata(
    component,
    imageWidth,
    imageHeight,
    maxHorizontalSampling,
    maxVerticalSampling
  ) {
    if (!component || typeof component !== "object") {
      throw new RangeError("Invalid JPEG component data");
    }

    const horizontalSampling = validateJpegSampling(component.horizontalSampling);
    const verticalSampling = validateJpegSampling(component.verticalSampling);
    const blockCountX = component.blockCountX;
    const blockCountY = component.blockCountY;
    const blocks = component.blocks;

    if (!Number.isInteger(blockCountX) || !Number.isInteger(blockCountY) ||
        blockCountX < 1 || blockCountY < 1 || !ArrayBuffer.isView(blocks) ||
        blocks.length !== blockCountX * blockCountY * 64) {
      throw new RangeError("Invalid JPEG DCT block layout");
    }

    const sampleWidth = blockCountX * 8;
    const sampleHeight = blockCountY * 8;
    const activeWidth = Math.ceil(imageWidth * horizontalSampling / maxHorizontalSampling);
    const activeHeight = Math.ceil(imageHeight * verticalSampling / maxVerticalSampling);

    if (activeWidth > sampleWidth || activeHeight > sampleHeight) {
      throw new RangeError("JPEG DCT blocks do not cover the image dimensions");
    }

    return {
      horizontalSampling,
      verticalSampling,
      blockCountX,
      blockCountY,
      blocks,
      sampleWidth,
      sampleHeight,
      activeWidth,
      activeHeight,
    };
  }

  function reconstructJpegDctSource(metadata) {
    return {
      ...metadata,
      components: metadata.components.map(reconstructJpegComponent),
    };
  }

  function reconstructJpegComponent(component) {
    const {
      blockCountX,
      blockCountY,
      blocks,
      sampleWidth,
      sampleHeight,
    } = component;
    const samples = new Uint8Array(sampleWidth * sampleHeight);
    const basis = getBasis(8);
    const vertical = new Float64Array(64);

    for (let blockY = 0; blockY < blockCountY; blockY += 1) {
      for (let blockX = 0; blockX < blockCountX; blockX += 1) {
        const blockOffset = (blockY * blockCountX + blockX) * 64;

        for (let y = 0; y < 8; y += 1) {
          for (let u = 0; u < 8; u += 1) {
            let sum = 0;

            for (let v = 0; v < 8; v += 1) {
              sum += basis[v * 8 + y] * blocks[blockOffset + v * 8 + u];
            }

            vertical[y * 8 + u] = sum;
          }
        }

        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            let sum = 0;

            for (let u = 0; u < 8; u += 1) {
              sum += vertical[y * 8 + u] * basis[u * 8 + x];
            }

            samples[(blockY * 8 + y) * sampleWidth + blockX * 8 + x] = clampByte(sum + 128);
          }
        }
      }
    }

    return {
      ...component,
      samples,
    };
  }

  function extractJpegMcuPlanes(source, mcuX, mcuY, chroma420 = true) {
    const chromaHeight = chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422;
    const yPlane = new Float64Array(16 * 16);
    const cbPlane = new Float64Array(CHROMA_WIDTH * chromaHeight);
    const crPlane = new Float64Array(CHROMA_WIDTH * chromaHeight);

    for (let localY = 0; localY < 16; localY += 1) {
      const y = Math.min(source.height - 1, mcuY * 16 + localY);

      for (let localX = 0; localX < 16; localX += 1) {
        const x = Math.min(source.width - 1, mcuX * 16 + localX);
        yPlane[localY * 16 + localX] = sampleJpegComponent(source, 0, x, y) - 128;
      }
    }

    if (source.components.length === 3) {
      const verticalSamples = chroma420 ? 2 : 1;
      for (let chromaY = 0; chromaY < chromaHeight; chromaY += 1) {
        for (let chromaX = 0; chromaX < CHROMA_WIDTH; chromaX += 1) {
          let cbSum = 0;
          let crSum = 0;
          for (let sampleY = 0; sampleY < verticalSamples; sampleY += 1) {
            const y = Math.min(source.height - 1, mcuY * 16 + chromaY * verticalSamples + sampleY);
            for (let sampleX = 0; sampleX < 2; sampleX += 1) {
              const x = Math.min(source.width - 1, mcuX * 16 + chromaX * 2 + sampleX);
              cbSum += sampleJpegComponent(source, 1, x, y);
              crSum += sampleJpegComponent(source, 2, x, y);
            }
          }
          const divisor = verticalSamples * 2;
          cbPlane[chromaY * CHROMA_WIDTH + chromaX] = cbSum / divisor - 128;
          crPlane[chromaY * CHROMA_WIDTH + chromaX] = crSum / divisor - 128;
        }
      }
    }

    return { y: yPlane, cb: cbPlane, cr: crPlane };
  }

  function sampleJpegComponent(source, componentIndex, imageX, imageY) {
    const component = source.components[componentIndex];
    const scaleX = component.horizontalSampling / source.maxHorizontalSampling;
    const scaleY = component.verticalSampling / source.maxVerticalSampling;
    const componentX = (imageX + 0.5) * scaleX - 0.5;
    const componentY = (imageY + 0.5) * scaleY - 0.5;
    const floorX = Math.floor(componentX);
    const floorY = Math.floor(componentY);
    const x0 = clamp(floorX, 0, component.activeWidth - 1);
    const x1 = clamp(floorX + 1, 0, component.activeWidth - 1);
    const y0 = clamp(floorY, 0, component.activeHeight - 1);
    const y1 = clamp(floorY + 1, 0, component.activeHeight - 1);
    const mixX = x0 === x1 ? 0 : componentX - floorX;
    const mixY = y0 === y1 ? 0 : componentY - floorY;
    const top = mix(
      component.samples[y0 * component.sampleWidth + x0],
      component.samples[y0 * component.sampleWidth + x1],
      mixX
    );
    const bottom = mix(
      component.samples[y1 * component.sampleWidth + x0],
      component.samples[y1 * component.sampleWidth + x1],
      mixX
    );

    return mix(top, bottom, mixY);
  }

  function validateJpegSampling(value) {
    if (!Number.isInteger(value) || value < 1 || value > 4) {
      throw new RangeError("Invalid JPEG sampling factor");
    }

    return value;
  }

  function mix(left, right, amount) {
    return left + (right - left) * amount;
  }

  function forwardDct(samples, width, height) {
    const basisWidth = getBasis(width);
    const basisHeight = getBasis(height);
    const horizontal = new Float64Array(width * height);
    const output = new Float64Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let u = 0; u < width; u += 1) {
        let sum = 0;

        for (let x = 0; x < width; x += 1) {
          sum += samples[y * width + x] * basisWidth[u * width + x];
        }

        horizontal[y * width + u] = sum;
      }
    }

    for (let v = 0; v < height; v += 1) {
      for (let u = 0; u < width; u += 1) {
        let sum = 0;

        for (let y = 0; y < height; y += 1) {
          sum += basisHeight[v * height + y] * horizontal[y * width + u];
        }

        output[v * width + u] = sum;
      }
    }

    return output;
  }

  function inverseDct(coefficients, width, height) {
    const basisWidth = getBasis(width);
    const basisHeight = getBasis(height);
    const vertical = new Float64Array(width * height);
    const output = new Float64Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let u = 0; u < width; u += 1) {
        let sum = 0;

        for (let v = 0; v < height; v += 1) {
          sum += basisHeight[v * height + y] * coefficients[v * width + u];
        }

        vertical[y * width + u] = sum;
      }
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;

        for (let u = 0; u < width; u += 1) {
          sum += vertical[y * width + u] * basisWidth[u * width + x];
        }

        output[y * width + x] = sum;
      }
    }

    return output;
  }

  function sampleInverseDct(coefficients, width, height, x, y) {
    const basisWidth = getBasis(width);
    const basisHeight = getBasis(height);
    let output = 0;

    for (let u = 0; u < width; u += 1) {
      let vertical = 0;

      for (let v = 0; v < height; v += 1) {
        vertical += basisHeight[v * height + y] * coefficients[v * width + u];
      }

      output += vertical * basisWidth[u * width + x];
    }

    return output;
  }

  function sampleChromaPlane(samples, localX, localY, chroma420) {
    if (!chroma420) {
      return samples[localY * CHROMA_WIDTH + Math.floor(localX / 2)];
    }
    return sampleChroma420(
      (x, y) => samples[y * CHROMA_WIDTH + x],
      localX,
      localY
    );
  }

  function sampleChromaCoefficients(coefficients, localX, localY, chroma420) {
    if (!chroma420) {
      return sampleInverseDct(
        coefficients,
        CHROMA_WIDTH,
        CHROMA_HEIGHT_422,
        Math.floor(localX / 2),
        localY
      );
    }
    return sampleChroma420(
      (x, y) => sampleInverseDct(coefficients, CHROMA_WIDTH, CHROMA_HEIGHT_420, x, y),
      localX,
      localY
    );
  }

  function sampleChroma420(sample, localX, localY) {
    const floorX = localX % 2 === 0 ? Math.floor(localX / 2) - 1 : Math.floor(localX / 2);
    const floorY = localY % 2 === 0 ? Math.floor(localY / 2) - 1 : Math.floor(localY / 2);
    const x0 = clamp(floorX, 0, CHROMA_WIDTH - 1);
    const y0 = clamp(floorY, 0, CHROMA_HEIGHT_420 - 1);
    const x1 = clamp(floorX + 1, 0, CHROMA_WIDTH - 1);
    const y1 = clamp(floorY + 1, 0, CHROMA_HEIGHT_420 - 1);
    const fractionX = localX % 2 === 0 ? 3 : 1;
    const fractionY = localY % 2 === 0 ? 3 : 1;
    const top = (4 - fractionX) * sample(x0, y0) + fractionX * sample(x1, y0);
    const bottom = (4 - fractionX) * sample(x0, y1) + fractionX * sample(x1, y1);
    return ((4 - fractionY) * top + fractionY * bottom) / 16;
  }

  function getBasis(size) {
    if (!basisCache.has(size)) {
      const basis = new Float64Array(size * size);

      for (let frequency = 0; frequency < size; frequency += 1) {
        const normalization = frequency === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);

        for (let position = 0; position < size; position += 1) {
          basis[frequency * size + position] = normalization *
            Math.cos(Math.PI * (2 * position + 1) * frequency / (2 * size));
        }
      }

      basisCache.set(size, basis);
    }

    return basisCache.get(size);
  }

  function getScan(profile, width, height) {
    const key = `${profile}:${width}:${height}`;

    if (!scanCache.has(key)) {
      const positions = [];

      for (let v = 0; v < height; v += 1) {
        for (let u = 0; u < width; u += 1) {
          if (u !== 0 || v !== 0) {
            positions.push({ position: v * width + u, u, v });
          }
        }
      }

      positions.sort((left, right) => {
        const scoreDifference = scanScore(profile, left.u, left.v) - scanScore(profile, right.u, right.v);

        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        const diagonal = left.u + left.v - right.u - right.v;

        if (diagonal !== 0) {
          return diagonal;
        }

        return left.v - right.v || left.u - right.u;
      });
      scanCache.set(key, positions.map((item) => item.position));
    }

    return scanCache.get(key);
  }

  function getZigzagScan(width, height) {
    const key = `${width}:${height}`;

    if (!zigzagScanCache.has(key)) {
      const positions = [];
      for (let diagonal = 0; diagonal <= width + height - 2; diagonal += 1) {
        const minimumU = Math.max(0, diagonal - height + 1);
        const maximumU = Math.min(width - 1, diagonal);
        if ((diagonal & 1) === 0) {
          for (let u = minimumU; u <= maximumU; u += 1) {
            const v = diagonal - u;
            if (u !== 0 || v !== 0) positions.push(v * width + u);
          }
        } else {
          for (let u = maximumU; u >= minimumU; u -= 1) {
            const v = diagonal - u;
            if (u !== 0 || v !== 0) positions.push(v * width + u);
          }
        }
      }
      zigzagScanCache.set(key, positions);
    }

    return zigzagScanCache.get(key);
  }

  function getCoefficientOrder(coding, width, height) {
    return coding.zigzagOrder
      ? [0, ...getZigzagScan(width, height)]
      : Array.from({ length: width * height }, (_, position) => position);
  }

  function getProfileCount(coding, skip = false) {
    return (skip ? SKIP_PROFILE_NAMES.length : PROFILE_NAMES.length) +
      (coding.zigzagOrder ? 1 : 0);
  }

  function getProfileScan(coding, profile, width, height, skip = false) {
    if (coding.zigzagOrder) {
      if (profile === 0) return getZigzagScan(width, height);
      profile -= 1;
    }
    return skip ? getSkipScan(profile, width, height) : getScan(profile, width, height);
  }

  function getProfileName(coding, profile, skip = false) {
    if (coding.zigzagOrder) {
      if (profile === 0) return ZIGZAG_PROFILE_NAME;
      profile -= 1;
    }
    return (skip ? SKIP_PROFILE_NAMES : PROFILE_NAMES)[profile];
  }

  function getSkipScan(profile, width, height) {
    const key = `${profile}:${width}:${height}`;

    if (!skipScanCache.has(key)) {
      const positions = [];

      for (let v = 0; v < height; v += 1) {
        for (let u = 0; u < width; u += 1) {
          if (u === 0 && v === 0) {
            continue;
          }
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
      skipScanCache.set(key, positions.map((item) => item.position));
    }

    return skipScanCache.get(key);
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

  function scanScore(profile, u, v) {
    if (profile === 1) {
      return u + v * 2.4;
    }
    if (profile === 2) {
      return u * 2.4 + v;
    }
    if (profile === 3) {
      return Math.max(u, v) * 1.45 + Math.abs(u - v) * 0.1;
    }
    return u + v + ((u + v) % 2 === 0 ? v : u) * 0.001;
  }

  function quantizationStep(u, v, width, height, quality, chroma) {
    const table = chroma ? CHROMA_QUANTIZATION : LUMA_QUANTIZATION;
    const tableX = Math.min(7, Math.round(u * 7 / Math.max(1, width - 1)));
    const tableY = Math.min(7, Math.round(v * 7 / Math.max(1, height - 1)));
    const qualityScale = quality < 50 ? 50 / quality : 2 - quality * 0.02;
    const dimensionScale = Math.sqrt(width * height / 64);

    return Math.max(1, table[tableY * 8 + tableX] * qualityScale * dimensionScale);
  }

  function getScaledQuantizationSteps(width, height, quality, chroma) {
    const key = `${width}:${height}:${quality}:${chroma ? 1 : 0}`;

    if (!quantizationStepCache.has(key)) {
      const coefficientCount = width * height;
      const steps = new Float64Array(coefficientCount * SCALE_MULTIPLIERS.length);

      for (let position = 0; position < coefficientCount; position += 1) {
        const baseStep = quantizationStep(
          position % width,
          Math.floor(position / width),
          width,
          height,
          quality,
          chroma
        );

        for (let scaleIndex = 0; scaleIndex < SCALE_MULTIPLIERS.length; scaleIndex += 1) {
          steps[scaleIndex * coefficientCount + position] =
            baseStep * SCALE_MULTIPLIERS[scaleIndex];
        }
      }
      quantizationStepCache.set(key, steps);
    }

    return quantizationStepCache.get(key);
  }

  function measureBestSampleError(
    pixels,
    width,
    height,
    layouts,
    quality,
    mcuIndices,
    codings,
    chroma420
  ) {
    return Math.min(...layouts.flatMap((layout) => codings.map((coding) => measureSampleError(
      pixels,
      width,
      height,
      layout,
      quality,
      mcuIndices,
      coding,
      chroma420
    ))));
  }

  function measureSampleError(
    pixels,
    width,
    height,
    layout,
    quality,
    mcuIndices,
    coding,
    chroma420 = true
  ) {
    const chromaHeight = chroma420 ? CHROMA_HEIGHT_420 : CHROMA_HEIGHT_422;
    let squaredError = 0;

    for (const mcuIndex of mcuIndices) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const planes = extractMcuPlanes(pixels, width, height, mcuX, mcuY, chroma420);
      const record = new Uint8Array(layout.bytesPerMcu);

      const splitLuma8x8 = layout.bpp >= 3;
      encodeLuma(record, 0, layout.yBytes, planes.y, quality, splitLuma8x8, coding, true);
      encodeComponent(
        record,
        layout.yBytes,
        layout.cbBytes,
        planes.cb,
        8,
        chromaHeight,
        quality,
        true,
        coding,
        splitLuma8x8
      );
      encodeComponent(
        record,
        layout.yBytes + layout.cbBytes,
        layout.crBytes,
        planes.cr,
        8,
        chromaHeight,
        quality,
        true,
        coding,
        splitLuma8x8
      );

      const yComponent = decodeLuma(record, 0, layout.yBytes, quality, splitLuma8x8, coding);
      const cbComponent = decodeComponent(
        record,
        layout.yBytes,
        layout.cbBytes,
        8,
        chromaHeight,
        quality,
        true,
        coding
      );
      const crComponent = decodeComponent(
        record,
        layout.yBytes + layout.cbBytes,
        layout.crBytes,
        8,
        chromaHeight,
        quality,
        true,
        coding
      );
      const yPlane = reconstructLumaPlane(yComponent);
      const cbPlane = inverseDct(cbComponent.coefficients, 8, chromaHeight);
      const crPlane = inverseDct(crComponent.coefficients, 8, chromaHeight);

      for (let localY = 0; localY < 16; localY += 1) {
        const y = mcuY * 16 + localY;

        if (y >= height) {
          break;
        }

        for (let localX = 0; localX < 16; localX += 1) {
          const x = mcuX * 16 + localX;

          if (x >= width) {
            break;
          }

          const sourceOffset = (y * width + x) * 4;
          const rgba = yCbCrToRgba(
            yPlane[localY * 16 + localX] + 128,
            sampleChromaPlane(cbPlane, localX, localY, chroma420) + 128,
            sampleChromaPlane(crPlane, localX, localY, chroma420) + 128
          );

          squaredError += (pixels[sourceOffset] - rgba.r) ** 2 +
            (pixels[sourceOffset + 1] - rgba.g) ** 2 +
            (pixels[sourceOffset + 2] - rgba.b) ** 2;
        }
      }
    }

    return squaredError;
  }

  function selectSampleMcuIndices(mcuCount, maximum) {
    const count = Math.min(mcuCount, maximum);
    const indices = [];

    for (let index = 0; index < count; index += 1) {
      indices.push(Math.min(mcuCount - 1, Math.floor((index + 0.5) * mcuCount / count)));
    }

    return [...new Set(indices)];
  }

  function calculateSquaredError(left, right) {
    if (left.length !== right.length) {
      throw new RangeError("Pixel buffers have different lengths");
    }

    let error = 0;

    for (let index = 0; index < left.length; index += 4) {
      error += (left[index] - right[index]) ** 2 +
        (left[index + 1] - right[index + 1]) ** 2 +
        (left[index + 2] - right[index + 2]) ** 2;
    }

    return error;
  }

  function rgbToYCbCr(red, green, blue) {
    return {
      y: 0.299 * red + 0.587 * green + 0.114 * blue,
      cb: 128 - 0.168736 * red - 0.331264 * green + 0.5 * blue,
      cr: 128 + 0.5 * red - 0.418688 * green - 0.081312 * blue,
    };
  }

  function yCbCrToRgba(y, cb, cr) {
    const centeredCb = cb - 128;
    const centeredCr = cr - 128;

    return {
      r: clampByte(y + 1.402 * centeredCr),
      g: clampByte(y - 0.344136 * centeredCb - 0.714136 * centeredCr),
      b: clampByte(y + 1.772 * centeredCb),
      a: 255,
    };
  }

  function writeRgba(pixels, offset, rgba) {
    pixels[offset] = rgba.r;
    pixels[offset + 1] = rgba.g;
    pixels[offset + 2] = rgba.b;
    pixels[offset + 3] = 255;
  }

  function clampByte(value) {
    return clamp(roundSigned(value), 0, 255);
  }

  function validatePixels(pixels, width, height) {
    validateDimensions(width, height);

    if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * 4) {
      throw new RangeError("DCT encoder requires a complete RGBA pixel buffer");
    }
  }

  function validateDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 0xffffffff || height > 0xffffffff) {
      throw new RangeError("DCT image dimensions are out of range");
    }
  }

  function validateQuality(quality) {
    const rounded = Math.round(Number(quality));

    if (!Number.isFinite(rounded) || rounded < 1 || rounded > 100) {
      throw new RangeError("DCT quality must be from 1 through 100");
    }

    return rounded;
  }

  function asUint8Array(input) {
    if (input instanceof Uint8Array) {
      return input;
    }
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    throw new TypeError("DCT input must be a Uint8Array or ArrayBuffer");
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function readUint32(view, offset) {
    return view.getUint32(offset, true);
  }

  function roundSigned(value) {
    return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function squaredNorm(values) {
    let total = 0;

    for (const value of values) {
      total += value * value;
    }

    return total;
  }

  function compareComponentCandidates(left, right) {
    return left.error - right.error || left.scaleIndex - right.scaleIndex || left.profile - right.profile;
  }

  function compareQualityResults(left, right) {
    return left.error - right.error || right.quality - left.quality;
  }

  class BitWriter {
    constructor(bytes, byteOffset, byteCount) {
      this.bytes = bytes;
      this.bitOffset = byteOffset * 8;
      this.endBit = (byteOffset + byteCount) * 8;
    }

    write(value, bitCount) {
      if (this.bitOffset + bitCount > this.endBit) {
        throw new RangeError("DCT component bitstream overflow");
      }

      for (let bit = bitCount - 1; bit >= 0; bit -= 1) {
        const byteIndex = this.bitOffset >> 3;
        const bitIndex = 7 - (this.bitOffset & 7);
        this.bytes[byteIndex] |= (value >> bit & 1) << bitIndex;
        this.bitOffset += 1;
      }
    }

    writeSigned(value, bitCount) {
      const encoded = value < 0 ? value + 2 ** bitCount : value;
      this.write(encoded, bitCount);
    }
  }

  class BitReader {
    constructor(bytes, byteOffset, byteCount) {
      this.bytes = bytes;
      this.bitOffset = byteOffset * 8;
      this.endBit = (byteOffset + byteCount) * 8;
    }

    read(bitCount) {
      if (this.bitOffset + bitCount > this.endBit) {
        throw new RangeError("Truncated DCT component bitstream");
      }

      let value = 0;

      for (let bit = 0; bit < bitCount; bit += 1) {
        const byteIndex = this.bitOffset >> 3;
        const bitIndex = 7 - (this.bitOffset & 7);
        value = value * 2 + (this.bytes[byteIndex] >> bitIndex & 1);
        this.bitOffset += 1;
      }

      return value;
    }

    readSigned(bitCount) {
      const value = this.read(bitCount);
      const signBit = 2 ** (bitCount - 1);
      return value >= signBit ? value - 2 ** bitCount : value;
    }
  }

  return Object.freeze({
    MAGIC: "DCTBS2",
    VERSION,
    HEADER_BYTES,
    MCU_WIDTH,
    MCU_HEIGHT,
    PRESETS,
    PROFILE_NAMES,
    COEFFICIENT_CODINGS,
    getDctPreset,
    getDctFileLayout,
    describeDctComponentRecord,
    encodeDctFile,
    importJpegDctFile,
    decodeJpegDctPixels,
    decodeDctFile,
    decodeDctComponentSamples,
    sampleDctFilePixel,
    inspectDctFile,
    inspectDctMcu,
    findBestDctQuality,
    calculateSquaredError,
    getCachedDctEncodingResult,
  });
});
