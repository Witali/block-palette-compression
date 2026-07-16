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
  // The browser application keeps the same independent 16x16 YCbCr 4:2:2 MCU
  // model while exposing a small, testable API for bounded pixel access.

  const MAGIC = Object.freeze([0x44, 0x43, 0x54, 0x42, 0x53, 0x32, 0x00, 0x00]);
  const VERSION = 2;
  const HEADER_BYTES = 64;
  const FLAG_AUTO_QUALITY = 1;
  const FLAG_SPLIT_LUMA_8X8 = 2;
  const FLAG_DCT_LIBRARY = 4;
  const COEFFICIENT_CODING_SHIFT = 8;
  const COEFFICIENT_CODING_MASK = 15 << COEFFICIENT_CODING_SHIFT;
  const SUPPORTED_FLAGS = FLAG_AUTO_QUALITY | FLAG_SPLIT_LUMA_8X8 | FLAG_DCT_LIBRARY |
    COEFFICIENT_CODING_MASK;
  const MCU_WIDTH = 16;
  const MCU_HEIGHT = 16;
  const CHROMA_WIDTH = 8;
  const COMPONENT_CACHE_Y_OFFSET = 0;
  const COMPONENT_CACHE_CB_OFFSET = MCU_WIDTH * MCU_HEIGHT;
  const COMPONENT_CACHE_CR_OFFSET = COMPONENT_CACHE_CB_OFFSET + CHROMA_WIDTH * MCU_HEIGHT;
  const COMPONENT_CACHE_BYTES_PER_MCU = COMPONENT_CACHE_CR_OFFSET + CHROMA_WIDTH * MCU_HEIGHT;
  const SCALE_MULTIPLIERS = Object.freeze([1, 2, 4, 8, 16, 32, 64, 128]);
  const PROFILE_NAMES = Object.freeze(["low frequency", "horizontal", "vertical", "diagonal"]);
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
  ]);
  // Higher-rate modes preserve the reference converter's four-luma-to-two-chroma
  // byte ratio while DCTBS2 keeps its independently addressable 4:2:2 MCU layout.
  const PRESETS = Object.freeze({
    "6": freezePreset(6000, 6, 192, 128, 32, 32),
    "4.5": freezePreset(4500, 4.5, 144, 96, 24, 24),
    "3": freezePreset(3000, 3, 96, 64, 16, 16),
    "2": freezePreset(2000, 2, 64, 32, 16, 16),
    "1.5": freezePreset(1500, 1.5, 48, 24, 12, 12),
    "1": freezePreset(1000, 1, 32, 16, 8, 8),
    "0.75": freezePreset(750, 0.75, 24, 12, 6, 6),
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

  function freezePreset(modeCode, bpp, bytesPerMcu, yBytes, cbBytes, crBytes) {
    return Object.freeze({ modeCode, bpp, bytesPerMcu, yBytes, cbBytes, crBytes });
  }

  function freezeCoefficientCoding(key, mantissaBits, groupCount, grouping, skipMode = null) {
    return Object.freeze({ key, mantissaBits, groupCount, grouping, skipMode });
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

  function encodeDctFile(pixels, width, height, options = {}) {
    validatePixels(pixels, width, height);
    const quality = validateQuality(options.quality === undefined ? 72 : options.quality);
    const layout = getDctFileLayout(width, height, options.preset);
    const coefficientCoding = getCoefficientCoding(options.coefficientCoding, layout.key);
    const splitLuma8x8 = shouldSplitLuma(layout, options);

    if (options.dctLibrary) {
      return encodeDctFileWithLibrary(
        pixels,
        width,
        height,
        layout,
        quality,
        splitLuma8x8,
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
      const planes = extractMcuPlanes(pixels, width, height, mcuX, mcuY);
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
        16,
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
        16,
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
    coefficientCoding,
    options
  ) {
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
        16,
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
        16,
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
        16,
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
        16,
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
    const source = prepareJpegDctSource(jpeg);
    const quality = validateQuality(options.quality === undefined ? 72 : options.quality);
    const layout = getDctFileLayout(source.width, source.height, options.preset);
    const coefficientCoding = getCoefficientCoding(options.coefficientCoding, layout.key);
    const splitLuma8x8 = shouldSplitLuma(layout, options);
    const output = createDctOutput(layout, quality, options, splitLuma8x8, coefficientCoding);
    const reportProgress = createDctProgressReporter(options, layout.mcuCount, quality);
    reportProgress(0);

    for (let mcuIndex = 0; mcuIndex < layout.mcuCount; mcuIndex += 1) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const planes = extractJpegMcuPlanes(source, mcuX, mcuY);
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
        16,
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
        16,
        quality,
        true,
        coefficientCoding,
        splitLuma8x8
      );
      reportProgress(mcuIndex + 1);
    }

    return output;
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
        (COEFFICIENT_CODINGS.indexOf(coefficientCoding) << COEFFICIENT_CODING_SHIFT)
    );
    writeUint32(view, 56, layout.payloadBytes);
    writeUint32(view, 60, libraryBytes || options.searchCandidateCount || 0);

    return output;
  }

  function shouldSplitLuma(layout, options) {
    return layout.bpp >= 3 && options.splitLuma8x8 !== false;
  }

  function collectDctLibrarySource(
    pixels,
    width,
    height,
    layout,
    splitLuma8x8,
    onMcu = () => {}
  ) {
    const mcus = [];
    const yVectors = [];
    const cbVectors = [];
    const crVectors = [];

    for (let mcuIndex = 0; mcuIndex < layout.mcuCount; mcuIndex += 1) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const planes = extractMcuPlanes(pixels, width, height, mcuX, mcuY);
      const y = splitLuma8x8
        ? splitLumaSamples(planes.y).map((samples) => forwardDct(samples, 8, 8))
        : [forwardDct(planes.y, 16, 16)];
      const cb = forwardDct(planes.cb, 8, 16);
      const cr = forwardDct(planes.cr, 8, 16);

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
      const cbPlane = inverseDct(components.cb.coefficients, 8, 16);
      const crPlane = inverseDct(components.cr.coefficients, 8, 16);

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

          const chromaIndex = localY * CHROMA_WIDTH + Math.floor(localX / 2);
          const rgba = yCbCrToRgba(
            yPlane[localY * MCU_WIDTH + localX] + 128,
            cbPlane[chromaIndex] + 128,
            crPlane[chromaIndex] + 128
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
    const samples = new Uint8Array(info.mcuCount * COMPONENT_CACHE_BYTES_PER_MCU);

    for (let mcuIndex = 0; mcuIndex < info.mcuCount; mcuIndex += 1) {
      const components = decodeMcuComponents(bytes, info, mcuIndex);
      const recordOffset = mcuIndex * COMPONENT_CACHE_BYTES_PER_MCU;

      writeCenteredComponentSamples(
        samples,
        recordOffset + COMPONENT_CACHE_Y_OFFSET,
        reconstructLumaPlane(components.y)
      );
      writeCenteredComponentSamples(
        samples,
        recordOffset + COMPONENT_CACHE_CB_OFFSET,
        inverseDct(components.cb.coefficients, CHROMA_WIDTH, MCU_HEIGHT)
      );
      writeCenteredComponentSamples(
        samples,
        recordOffset + COMPONENT_CACHE_CR_OFFSET,
        inverseDct(components.cr.coefficients, CHROMA_WIDTH, MCU_HEIGHT)
      );
    }

    return {
      ...info,
      componentCache: Object.freeze({
        bytesPerMcu: COMPONENT_CACHE_BYTES_PER_MCU,
        yOffset: COMPONENT_CACHE_Y_OFFSET,
        cbOffset: COMPONENT_CACHE_CB_OFFSET,
        crOffset: COMPONENT_CACHE_CR_OFFSET,
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
      16,
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
      16,
      info.quality,
      true,
      info.coefficientCoding,
      createDctLibraryContext(bytes, info, "cr", mcuIndex)
    );
    const chromaX = Math.floor(localX / 2);
    const cb = sampleInverseDct(cbComponent.coefficients, 8, 16, chromaX, localY) + 128;
    const cr = sampleInverseDct(crComponent.coefficients, 8, 16, chromaX, localY) + 128;

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

    const layout = getDctFileLayout(width, height, presetKey);
    const quality = readUint32(view, 48);
    const flags = readUint32(view, 52);
    const coefficientCodingIndex = (flags & COEFFICIENT_CODING_MASK) >> COEFFICIENT_CODING_SHIFT;
    const coefficientCoding = COEFFICIENT_CODINGS[coefficientCodingIndex];
    const payloadBytes = readUint32(view, 56);
    const metadata = readUint32(view, 60);
    const libraryEnabled = (flags & FLAG_DCT_LIBRARY) !== 0;
    const libraryBytes = libraryEnabled ? metadata : 0;

    if (
      readUint32(view, 24) !== layout.mcuColumns ||
      readUint32(view, 28) !== layout.mcuRows ||
      readUint32(view, 32) !== layout.bytesPerMcu ||
      readUint32(view, 36) !== layout.yBytes ||
      readUint32(view, 40) !== layout.cbBytes ||
      readUint32(view, 44) !== layout.crBytes ||
      payloadBytes !== layout.payloadBytes ||
      bytes.length !== HEADER_BYTES + payloadBytes + libraryBytes ||
      quality < 1 || quality > 100 ||
      !coefficientCoding ||
      (flags & ~SUPPORTED_FLAGS) !== 0 ||
      ((flags & FLAG_SPLIT_LUMA_8X8) !== 0 && layout.bpp < 3)
    ) {
      throw new RangeError("Invalid DCTBS2 layout");
    }

    const splitLuma8x8 = (flags & FLAG_SPLIT_LUMA_8X8) !== 0;
    const library = libraryEnabled
      ? inspectDctLibrary(bytes, layout, splitLuma8x8, coefficientCoding, libraryBytes)
      : null;

    return {
      version,
      quality,
      autoQuality: (flags & FLAG_AUTO_QUALITY) !== 0,
      splitLuma8x8,
      libraryEnabled,
      libraryBytes,
      library,
      coefficientCoding,
      coefficientCodingKey: coefficientCoding.key,
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
    const coefficientCoding = getCoefficientCoding(options.coefficientCoding, preset.key);
    const layout = getDctFileLayout(width, height, preset.key);
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const coarse = [];

    for (let quality = 20; quality <= 95; quality += 5) {
      coarse.push(quality);
    }

    const sampleIndices = selectSampleMcuIndices(layout.mcuCount, options.sampleMcuCount || 24);
    const sampleResults = [];
    const estimatedTotal = coarse.length + 9 + 3;
    let completed = 0;

    for (const quality of coarse) {
      sampleResults.push({
        quality,
        error: measureSampleError(
          pixels,
          width,
          height,
          layout,
          quality,
          sampleIndices,
          coefficientCoding
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
          error: measureSampleError(
            pixels,
            width,
            height,
            layout,
            quality,
            sampleIndices,
            coefficientCoding
          ),
        });
      }
      completed += 1;
      onProgress({ stage: "refine", completed, total: estimatedTotal, quality });
    }

    sampleResults.sort(compareQualityResults);
    const finalists = sampleResults.slice(0, 3).map((result) => result.quality);
    let best = null;

    for (const quality of finalists) {
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
        coefficientCoding: coefficientCoding.key,
        searchCandidateCount: sampleResults.length + finalists.length,
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

  function getLibraryCoefficientScan(profile, width, height, acCount, frequencySplit) {
    const scan = getScan(profile, width, height);
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

    if (coding.groupCount > 0) {
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
      coding
    );
    return skip && skip.error < baseline.error ? skip : baseline;
  }

  function chooseLegacyComponentEncoding(
    coefficients,
    width,
    height,
    byteCount,
    quality,
    chroma,
    reservedAcCount = 0,
    libraryFrequencySplit = 0
  ) {
    const acCount = Math.max(0, Math.floor((byteCount * 8 - 18) / 6) - reservedAcCount);
    let best = null;

    for (let profile = 0; profile < PROFILE_NAMES.length; profile += 1) {
      const scan = getLibraryCoefficientScan(profile, width, height, acCount, libraryFrequencySplit);

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
    coding
  ) {
    const layout = getSkipTokenLayout(byteCount, width, height, coding.skipMode);
    const baseError = squaredNorm(coefficients);
    let best = null;

    for (let profile = 0; profile < 8; profile += 1) {
      const scan = getSkipScan(profile, width, height);

      for (let scaleIndex = 0; scaleIndex < SCALE_MULTIPLIERS.length; scaleIndex += 1) {
        const dcChoice = quantizeSkipCoefficient(
          coefficients,
          0,
          width,
          height,
          quality,
          chroma,
          scaleIndex,
          10
        );
        const maximumIndex = Math.min(scan.length - 1, 4 * (layout.tokenCount - 1));
        let previous = new Float64Array(maximumIndex + 1);
        previous.fill(Number.NEGATIVE_INFINITY);
        const back = Array.from({ length: layout.tokenCount }, () => {
          const indices = new Int16Array(maximumIndex + 1);
          indices.fill(-1);
          return indices;
        });
        const firstToken = getSkipTokenParameters(layout, 0, scaleIndex);
        previous[0] = skipCoefficientBenefit(
          coefficients,
          scan[0],
          width,
          height,
          quality,
          chroma,
          firstToken.scaleIndex,
          firstToken.bits
        ).benefit;

        for (let tokenIndex = 1; tokenIndex < layout.tokenCount; tokenIndex += 1) {
          const current = new Float64Array(maximumIndex + 1);
          current.fill(Number.NEGATIVE_INFINITY);
          const parameters = getSkipTokenParameters(layout, tokenIndex, scaleIndex);
          const firstIndex = tokenIndex;
          const lastIndex = Math.min(maximumIndex, 4 * tokenIndex);

          for (let index = firstIndex; index <= lastIndex; index += 1) {
            let previousBenefit = Number.NEGATIVE_INFINITY;
            let previousIndex = -1;

            for (let distance = 1; distance <= 4; distance += 1) {
              const candidateIndex = index - distance;
              if (candidateIndex >= 0 && previous[candidateIndex] > previousBenefit) {
                previousBenefit = previous[candidateIndex];
                previousIndex = candidateIndex;
              }
            }

            if (previousIndex < 0) {
              continue;
            }

            const benefit = skipCoefficientBenefit(
              coefficients,
              scan[index],
              width,
              height,
              quality,
              chroma,
              parameters.scaleIndex,
              parameters.bits
            ).benefit;
            current[index] = previousBenefit + benefit;
            back[tokenIndex][index] = previousIndex;
          }
          previous = current;
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

        const path = new Int16Array(layout.tokenCount);
        path[layout.tokenCount - 1] = endIndex;
        for (let tokenIndex = layout.tokenCount - 1; tokenIndex > 0; tokenIndex -= 1) {
          path[tokenIndex - 1] = back[tokenIndex][path[tokenIndex]];
        }

        const tokens = Array.from({ length: layout.tokenCount }, (_, tokenIndex) => {
          const parameters = getSkipTokenParameters(layout, tokenIndex, scaleIndex);
          const position = scan[path[tokenIndex]];
          const stored = skipCoefficientBenefit(
            coefficients,
            position,
            width,
            height,
            quality,
            chroma,
            parameters.scaleIndex,
            parameters.bits
          ).stored;
          const skip = tokenIndex + 1 < layout.tokenCount
            ? path[tokenIndex + 1] - path[tokenIndex] - 1 : 0;
          return { position, stored, skip, bits: parameters.bits };
        });
        const error = baseError + dcChoice.errorDelta - totalBenefit;
        const candidate = {
          profile,
          scaleIndex,
          dc: dcChoice.stored,
          tokens,
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

  function getSkipTokenLayout(byteCount, width, height, skipMode) {
    const payloadBits = byteCount * 8 - 18;
    if (skipMode === "single") {
      const tokenCount = Math.floor(payloadBits / 8);
      return { tokenCount, coarseCount: tokenCount, dualScale: false };
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
    return { tokenCount, coarseCount, dualScale: true };
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

  function skipCoefficientBenefit(
    coefficients,
    position,
    width,
    height,
    quality,
    chroma,
    scaleIndex,
    bitCount
  ) {
    const choice = quantizeSkipCoefficient(
      coefficients,
      position,
      width,
      height,
      quality,
      chroma,
      scaleIndex,
      bitCount
    );
    const benefit = -choice.errorDelta;
    return benefit > 0 ? { stored: choice.stored, benefit } : { stored: 0, benefit: 0 };
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
    const layout = getGroupedAcLayout(byteCount, coding, reservedAcCount);
    let best = null;

    for (let profile = 0; profile < PROFILE_NAMES.length; profile += 1) {
      const scan = getLibraryCoefficientScan(
        profile,
        width,
        height,
        layout.acCount,
        libraryFrequencySplit
      );
      const dcChoice = chooseQuantizedGroup(
        coefficients,
        [0],
        width,
        height,
        quality,
        chroma,
        10
      );
      const ac = [];
      const groupScaleIndices = [];
      let error = squaredNorm(coefficients) + dcChoice.errorDelta;
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
          coding.mantissaBits
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

  function chooseQuantizedGroup(coefficients, positions, width, height, quality, chroma, bitCount) {
    const minimum = -(2 ** (bitCount - 1));
    const maximum = 2 ** (bitCount - 1) - 1;
    let best = null;

    for (let scaleIndex = 0; scaleIndex < SCALE_MULTIPLIERS.length; scaleIndex += 1) {
      const scale = SCALE_MULTIPLIERS[scaleIndex];
      const values = [];
      let errorDelta = 0;

      for (const position of positions) {
        const u = position % width;
        const v = Math.floor(position / width);
        const step = quantizationStep(u, v, width, height, quality, chroma) * scale;
        const stored = clamp(roundSigned(coefficients[position] / step), minimum, maximum);
        const restored = stored * step;

        values.push(stored);
        errorDelta += (coefficients[position] - restored) ** 2 - coefficients[position] ** 2;
      }

      const candidate = { scaleIndex, values, errorDelta };
      if (!best || candidate.errorDelta < best.errorDelta ||
          (candidate.errorDelta === best.errorDelta && candidate.scaleIndex < best.scaleIndex)) {
        best = candidate;
      }
    }

    return best;
  }

  function getGroupedAcLayout(byteCount, coding, reservedAcCount = 0) {
    const acCount = Math.max(
      0,
      Math.floor((byteCount * 8 - 18 - coding.groupCount * 3) / coding.mantissaBits) - reservedAcCount
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

    if (profile >= (skipRecord ? 8 : PROFILE_NAMES.length) ||
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
      const scan = getSkipScan(profile, width, height);
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

      return {
        coefficients,
        profile,
        scaleIndex,
        groupScaleIndices: skipLayout.dualScale
          ? [scaleIndex, getSkipTokenParameters(skipLayout, skipLayout.coarseCount, scaleIndex).scaleIndex]
          : [scaleIndex],
        coefficientCount: skipLayout.tokenCount + 1,
        storedCoefficientCount,
        libraryIndex: 0,
        encodingMode: skipLayout.dualScale ? "dual-scale-skip" : "skip-rle",
      };
    }

    const groupedLayout = coding.groupCount > 0
      ? getGroupedAcLayout(byteCount, coding, reservedAcCount)
      : null;
    const acCount = groupedLayout
      ? groupedLayout.acCount
      : Math.max(0, Math.floor((byteCount * 8 - 18) / 6) - reservedAcCount);
    const frequencySplit = libraryIndex > 0 && libraryContext
      ? libraryContext.library.frequencySplit : 0;
    const scan = getLibraryCoefficientScan(profile, width, height, acCount, frequencySplit);

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
        16,
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
        16,
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
        profileName: component.encodingMode === "skip-rle" || component.encodingMode === "dual-scale-skip"
          ? SKIP_PROFILE_NAMES[component.profile] : PROFILE_NAMES[component.profile],
        scaleIndex: component.scaleIndex,
        scale: SCALE_MULTIPLIERS[component.scaleIndex],
        groupScaleIndices: component.groupScaleIndices,
        groupScales: component.groupScaleIndices.map((scaleIndex) => SCALE_MULTIPLIERS[scaleIndex]),
        coefficientCount: component.coefficientCount,
        storedCoefficientCount: component.storedCoefficientCount,
        libraryIndex: component.libraryIndex,
        encodingMode: component.encodingMode,
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

  function extractMcuPlanes(pixels, width, height, mcuX, mcuY) {
    const yPlane = new Float64Array(16 * 16);
    const cbPlane = new Float64Array(8 * 16);
    const crPlane = new Float64Array(8 * 16);

    for (let localY = 0; localY < 16; localY += 1) {
      const y = Math.min(height - 1, mcuY * 16 + localY);

      for (let chromaX = 0; chromaX < 8; chromaX += 1) {
        let cbSum = 0;
        let crSum = 0;

        for (let pairX = 0; pairX < 2; pairX += 1) {
          const localX = chromaX * 2 + pairX;
          const x = Math.min(width - 1, mcuX * 16 + localX);
          const pixelOffset = (y * width + x) * 4;
          const red = pixels[pixelOffset];
          const green = pixels[pixelOffset + 1];
          const blue = pixels[pixelOffset + 2];
          const converted = rgbToYCbCr(red, green, blue);

          yPlane[localY * 16 + localX] = converted.y - 128;
          cbSum += converted.cb;
          crSum += converted.cr;
        }

        cbPlane[localY * 8 + chromaX] = cbSum / 2 - 128;
        crPlane[localY * 8 + chromaX] = crSum / 2 - 128;
      }
    }

    return { y: yPlane, cb: cbPlane, cr: crPlane };
  }

  function prepareJpegDctSource(jpeg) {
    if (!jpeg || typeof jpeg !== "object") {
      throw new TypeError("JPEG DCT import requires parsed JPEG coefficient data");
    }

    validateDimensions(jpeg.width, jpeg.height);

    if (!Array.isArray(jpeg.components) || (jpeg.components.length !== 1 && jpeg.components.length !== 3)) {
      throw new RangeError("JPEG DCT import supports grayscale and three-component YCbCr images");
    }

    const maxHorizontalSampling = validateJpegSampling(jpeg.maxHorizontalSampling);
    const maxVerticalSampling = validateJpegSampling(jpeg.maxVerticalSampling);
    const components = jpeg.components.map((component) => prepareJpegComponent(
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

  function prepareJpegComponent(component, imageWidth, imageHeight, maxHorizontalSampling, maxVerticalSampling) {
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
      horizontalSampling,
      verticalSampling,
      sampleWidth,
      sampleHeight,
      activeWidth,
      activeHeight,
      samples,
    };
  }

  function extractJpegMcuPlanes(source, mcuX, mcuY) {
    const yPlane = new Float64Array(16 * 16);
    const cbPlane = new Float64Array(8 * 16);
    const crPlane = new Float64Array(8 * 16);

    for (let localY = 0; localY < 16; localY += 1) {
      const y = Math.min(source.height - 1, mcuY * 16 + localY);

      for (let chromaX = 0; chromaX < 8; chromaX += 1) {
        for (let pairX = 0; pairX < 2; pairX += 1) {
          const localX = chromaX * 2 + pairX;
          const x = Math.min(source.width - 1, mcuX * 16 + localX);

          yPlane[localY * 16 + localX] = sampleJpegComponent(source, 0, x, y) - 128;
        }

        if (source.components.length === 3) {
          const firstX = Math.min(source.width - 1, mcuX * 16 + chromaX * 2);
          const secondX = Math.min(source.width - 1, firstX + 1);
          cbPlane[localY * 8 + chromaX] = (
            sampleJpegComponent(source, 1, firstX, y) +
            sampleJpegComponent(source, 1, secondX, y)
          ) / 2 - 128;
          crPlane[localY * 8 + chromaX] = (
            sampleJpegComponent(source, 2, firstX, y) +
            sampleJpegComponent(source, 2, secondX, y)
          ) / 2 - 128;
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

  function measureSampleError(pixels, width, height, layout, quality, mcuIndices, coding) {
    let squaredError = 0;

    for (const mcuIndex of mcuIndices) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const planes = extractMcuPlanes(pixels, width, height, mcuX, mcuY);
      const record = new Uint8Array(layout.bytesPerMcu);

      const splitLuma8x8 = layout.bpp >= 3;
      encodeLuma(record, 0, layout.yBytes, planes.y, quality, splitLuma8x8, coding, true);
      encodeComponent(
        record,
        layout.yBytes,
        layout.cbBytes,
        planes.cb,
        8,
        16,
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
        16,
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
        16,
        quality,
        true,
        coding
      );
      const crComponent = decodeComponent(
        record,
        layout.yBytes + layout.cbBytes,
        layout.crBytes,
        8,
        16,
        quality,
        true,
        coding
      );
      const yPlane = reconstructLumaPlane(yComponent);
      const cbPlane = inverseDct(cbComponent.coefficients, 8, 16);
      const crPlane = inverseDct(crComponent.coefficients, 8, 16);

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
          const chromaIndex = localY * 8 + Math.floor(localX / 2);
          const rgba = yCbCrToRgba(
            yPlane[localY * 16 + localX] + 128,
            cbPlane[chromaIndex] + 128,
            crPlane[chromaIndex] + 128
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
    encodeDctFile,
    importJpegDctFile,
    decodeDctFile,
    decodeDctComponentSamples,
    sampleDctFilePixel,
    inspectDctFile,
    inspectDctMcu,
    findBestDctQuality,
    calculateSquaredError,
  });
});
