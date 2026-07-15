(function (root, factory) {
  "use strict";

  const blockPaletteCodec = typeof module === "object" && module.exports
    ? require("../palette/block-palette-codec.js")
    : root.BlockPaletteCodec;
  const dct420 = typeof module === "object" && module.exports
    ? require("./dct420.js")
    : root.Dct420;
  const bpdhFormat = typeof module === "object" && module.exports
    ? require("./bpdh-format.js")
    : root.BpdhFormat;
  const api = factory(blockPaletteCodec, dct420, bpdhFormat);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BpdhCodec = api;
})(typeof self !== "undefined" ? self : globalThis, function (
  blockPaletteCodec,
  dct420,
  bpdhFormat
) {
  "use strict";

  const DEFAULT_TARGET_BITS_PER_PIXEL = 4;
  const DEFAULT_DCT_QUALITIES = [25, 35, 45, 55, 65, 75, 85, 92];
  const VALID_MODES = new Set(["auto", "bpal", "dct"]);

  function compressHybridImage(sourcePixels, width, height, settings) {
    const options = settings || {};

    validateSource(sourcePixels, width, height);

    const requestedMode = options.mode || "auto";

    if (!VALID_MODES.has(requestedMode)) {
      throw new RangeError("BPDH mode must be auto, bpal, or dct");
    }

    const targetBitsPerPixel = options.targetBitsPerPixel === undefined
      ? DEFAULT_TARGET_BITS_PER_PIXEL
      : Number(options.targetBitsPerPixel);

    if (!Number.isFinite(targetBitsPerPixel) || targetBitsPerPixel <= 0) {
      throw new RangeError("BPDH targetBitsPerPixel must be positive");
    }

    const blocksX = Math.ceil(width / bpdhFormat.CODING_UNIT_SIZE);
    const blocksY = Math.ceil(height / bpdhFormat.CODING_UNIT_SIZE);
    const blockCount = blocksX * blocksY;
    const bpalSettings = normalizeBpalSettings(options.bpal, blockCount);
    const dctQualities = normalizeDctQualities(options);
    const targetPayloadBytes = Math.floor(targetBitsPerPixel * width * height / 8);
    const selection = createSelectionTracker(targetPayloadBytes);
    let bpalResult = null;
    let bpalCandidates = null;
    let transformedMacroblocks = null;

    reportProgress(options.onProgress, "preparing", 0, {
      blockCount,
      targetPayloadBytes,
    });

    if (requestedMode !== "dct") {
      bpalResult = blockPaletteCodec.compressImage(sourcePixels, width, height, {
        ...bpalSettings,
        onProgress: options.onBpalProgress || null,
      });
      bpalCandidates = createBpalCandidates(
        sourcePixels,
        width,
        height,
        blocksX,
        blockCount,
        bpalResult
      );

      selection.consider(createPureBpalDescriptor(bpalCandidates, bpalResult, blockCount));
    }

    if (requestedMode !== "bpal") {
      transformedMacroblocks = transformAllMacroblocks(
        sourcePixels,
        width,
        height,
        blocksX,
        blocksY,
        options.onProgress
      );

      for (let qualityIndex = 0; qualityIndex < dctQualities.length; qualityIndex += 1) {
        const quality = dctQualities[qualityIndex];
        const quantizationTables = dct420.createQuantizationTables(quality);
        const dctCandidates = createDctCandidates(
          sourcePixels,
          width,
          height,
          blocksX,
          transformedMacroblocks,
          quantizationTables
        );

        selection.consider(createPureDctDescriptor(
          dctCandidates,
          quantizationTables,
          quality,
          blockCount
        ));

        if (requestedMode === "auto") {
          considerHybridSweep(
            selection,
            bpalCandidates,
            bpalResult,
            dctCandidates,
            quantizationTables,
            quality
          );
        }

        reportProgress(options.onProgress, "evaluating-dct", 0.55 + 0.4 * (
          (qualityIndex + 1) / dctQualities.length
        ), {
          quality,
          completed: qualityIndex + 1,
          total: dctQualities.length,
        });
      }
    }

    const selected = selection.finish();
    const image = buildHybridImage({
      sourcePixels,
      width,
      height,
      blocksX,
      blocksY,
      blockCount,
      bpalSettings,
      bpalResult,
      selected,
      targetBitsPerPixel,
      targetPayloadBytes,
    });

    reportProgress(options.onProgress, "complete", 1, {
      bpalBlocks: image.bpalBlockCount,
      dctBlocks: image.dctBlockCount,
      bitsPerPixel: image.storage.bitsPerPixel,
      withinTarget: image.storage.withinTarget,
    });

    return image;
  }

  function createBpalCandidates(
    sourcePixels,
    width,
    height,
    blocksX,
    blockCount,
    bpalResult
  ) {
    const candidates = [];
    const fixedRecordBits = bpalResult.paletteIndexBits +
      bpalResult.localColorCount * bpalResult.globalIndexBits;

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const blockX = blockIndex % blocksX;
      const blockY = Math.floor(blockIndex / blocksX);
      const pixelCount = blockPixelCount(width, height, blockX, blockY);

      candidates.push({
        squaredError: calculateBlockSquaredError(
          sourcePixels,
          bpalResult.pixels,
          width,
          height,
          blockX,
          blockY
        ),
        bits: fixedRecordBits + pixelCount * bpalResult.localIndexBits,
      });
    }

    return candidates;
  }

  function transformAllMacroblocks(
    sourcePixels,
    width,
    height,
    blocksX,
    blocksY,
    onProgress
  ) {
    const transformed = [];
    const blockCount = blocksX * blocksY;

    for (let blockY = 0; blockY < blocksY; blockY += 1) {
      for (let blockX = 0; blockX < blocksX; blockX += 1) {
        transformed.push(dct420.transformMacroblock(
          sourcePixels,
          width,
          height,
          blockX,
          blockY
        ));
      }

      reportProgress(onProgress, "transforming-dct", 0.15 + 0.4 * (
        (blockY + 1) / blocksY
      ), {
        completed: Math.min((blockY + 1) * blocksX, blockCount),
        total: blockCount,
      });
    }

    return transformed;
  }

  function createDctCandidates(
    sourcePixels,
    width,
    height,
    blocksX,
    transformedMacroblocks,
    quantizationTables
  ) {
    return transformedMacroblocks.map((transformed, blockIndex) => {
      const blockX = blockIndex % blocksX;
      const blockY = Math.floor(blockIndex / blocksX);
      const blocks = dct420.quantizeMacroblock(transformed, quantizationTables);
      const pixels = dct420.decodeMacroblock(blocks, quantizationTables);

      return {
        blocks,
        pixels,
        bits: bpdhFormat.getDctMacroblockBitLength(blocks),
        squaredError: dct420.calculateMacroblockSquaredError(
          sourcePixels,
          width,
          height,
          blockX,
          blockY,
          pixels
        ),
      };
    });
  }

  function createPureBpalDescriptor(bpalCandidates, bpalResult, blockCount) {
    const totals = sumCandidates(bpalCandidates);

    return createDescriptor({
      modes: new Uint8Array(blockCount),
      bpalBits: totals.bits,
      dctBits: 0,
      squaredError: totals.squaredError,
      bpalCount: blockCount,
      dctCount: 0,
      paletteBytes: paletteByteLength(bpalResult),
      quality: null,
      quantizationTables: null,
      dctCandidates: null,
    });
  }

  function createPureDctDescriptor(dctCandidates, quantizationTables, quality, blockCount) {
    const totals = sumCandidates(dctCandidates);
    const modes = new Uint8Array(blockCount);

    modes.fill(bpdhFormat.MODE_DCT);

    return createDescriptor({
      modes,
      bpalBits: 0,
      dctBits: totals.bits,
      squaredError: totals.squaredError,
      bpalCount: 0,
      dctCount: blockCount,
      paletteBytes: 0,
      quality,
      quantizationTables,
      dctCandidates,
    });
  }

  function considerHybridSweep(
    selection,
    bpalCandidates,
    bpalResult,
    dctCandidates,
    quantizationTables,
    quality
  ) {
    const blockCount = bpalCandidates.length;
    const modes = new Uint8Array(blockCount);
    const events = [];
    let bpalBits = 0;
    let dctBits = 0;
    let squaredError = 0;
    let bpalCount = 0;
    let dctCount = 0;

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const bpal = bpalCandidates[blockIndex];
      const dct = dctCandidates[blockIndex];
      const initialMode = chooseLowestDistortionMode(bpal, dct);

      modes[blockIndex] = initialMode;

      if (initialMode === bpdhFormat.MODE_BPAL) {
        bpalBits += bpal.bits;
        squaredError += bpal.squaredError;
        bpalCount += 1;
      } else {
        dctBits += dct.bits;
        squaredError += dct.squaredError;
        dctCount += 1;
      }

      const selected = initialMode === bpdhFormat.MODE_BPAL ? bpal : dct;
      const alternative = initialMode === bpdhFormat.MODE_BPAL ? dct : bpal;

      if (
        selected.bits > alternative.bits &&
        selected.squaredError < alternative.squaredError
      ) {
        events.push({
          blockIndex,
          threshold: (alternative.squaredError - selected.squaredError) /
            (selected.bits - alternative.bits),
          nextMode: initialMode === bpdhFormat.MODE_BPAL
            ? bpdhFormat.MODE_DCT
            : bpdhFormat.MODE_BPAL,
        });
      }
    }

    events.sort((left, right) => (
      left.threshold - right.threshold || left.blockIndex - right.blockIndex
    ));

    const paletteBytes = paletteByteLength(bpalResult);
    const considerCurrentState = () => {
      selection.consider(createDescriptor({
        modes,
        bpalBits,
        dctBits,
        squaredError,
        bpalCount,
        dctCount,
        paletteBytes,
        quality,
        quantizationTables,
        dctCandidates,
      }));
    };

    considerCurrentState();

    for (const event of events) {
      const blockIndex = event.blockIndex;
      const previousMode = modes[blockIndex];
      const bpal = bpalCandidates[blockIndex];
      const dct = dctCandidates[blockIndex];

      if (previousMode === bpdhFormat.MODE_BPAL) {
        bpalBits -= bpal.bits;
        dctBits += dct.bits;
        squaredError += dct.squaredError - bpal.squaredError;
        bpalCount -= 1;
        dctCount += 1;
      } else {
        dctBits -= dct.bits;
        bpalBits += bpal.bits;
        squaredError += bpal.squaredError - dct.squaredError;
        dctCount -= 1;
        bpalCount += 1;
      }

      modes[blockIndex] = event.nextMode;
      considerCurrentState();
    }
  }

  function createDescriptor(options) {
    const bothModes = options.bpalCount > 0 && options.dctCount > 0;
    const payloadBytes = (options.bpalCount > 0 ? options.paletteBytes : 0) +
      (options.dctCount > 0 ? 128 : 0) +
      (bothModes ? Math.ceil(options.modes.length / 8) : 0) +
      Math.ceil(options.bpalBits / 8) +
      Math.ceil(options.dctBits / 8);

    return {
      modes: options.modes,
      bpalBits: options.bpalBits,
      dctBits: options.dctBits,
      squaredError: options.squaredError,
      bpalCount: options.bpalCount,
      dctCount: options.dctCount,
      payloadBytes,
      quality: options.quality,
      quantizationTables: options.quantizationTables,
      dctCandidates: options.dctCandidates,
    };
  }

  function createSelectionTracker(targetPayloadBytes) {
    let bestWithinTarget = null;
    let smallestFallback = null;

    function consider(candidate) {
      if (candidate.payloadBytes <= targetPayloadBytes) {
        if (
          !bestWithinTarget ||
          candidate.squaredError < bestWithinTarget.squaredError ||
          (
            candidate.squaredError === bestWithinTarget.squaredError &&
            candidate.payloadBytes < bestWithinTarget.payloadBytes
          )
        ) {
          bestWithinTarget = snapshotDescriptor(candidate);
        }
      }

      if (!bestWithinTarget && (
        !smallestFallback ||
        candidate.payloadBytes < smallestFallback.payloadBytes ||
        (
          candidate.payloadBytes === smallestFallback.payloadBytes &&
          candidate.squaredError < smallestFallback.squaredError
        )
      )) {
        smallestFallback = snapshotDescriptor(candidate);
      }
    }

    function finish() {
      const result = bestWithinTarget || smallestFallback;

      if (!result) {
        throw new Error("BPDH encoder did not generate any candidates");
      }

      return {
        ...result,
        withinTarget: Boolean(bestWithinTarget),
      };
    }

    return { consider, finish };
  }

  function snapshotDescriptor(candidate) {
    return {
      ...candidate,
      modes: candidate.modes.slice(),
    };
  }

  function buildHybridImage(options) {
    const {
      sourcePixels,
      width,
      height,
      blocksX,
      blocksY,
      blockCount,
      bpalSettings,
      bpalResult,
      selected,
      targetBitsPerPixel,
      targetPayloadBytes,
    } = options;
    const dctBlocks = Array(blockCount).fill(null);
    const pixels = new Uint8ClampedArray(width * height * 4);

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const blockX = blockIndex % blocksX;
      const blockY = Math.floor(blockIndex / blocksX);
      const startX = blockX * bpdhFormat.CODING_UNIT_SIZE;
      const startY = blockY * bpdhFormat.CODING_UNIT_SIZE;
      const endX = Math.min(startX + bpdhFormat.CODING_UNIT_SIZE, width);
      const endY = Math.min(startY + bpdhFormat.CODING_UNIT_SIZE, height);

      if (selected.modes[blockIndex] === bpdhFormat.MODE_DCT) {
        const candidate = selected.dctCandidates[blockIndex];

        dctBlocks[blockIndex] = candidate.blocks;
        copyMacroblockPixels(candidate.pixels, pixels, width, startX, startY, endX, endY);
      } else {
        if (!bpalResult) {
          throw new Error("BPDH selected BPAL without a BPAL candidate");
        }

        for (let y = startY; y < endY; y += 1) {
          for (let x = startX; x < endX; x += 1) {
            const offset = (y * width + x) * 4;

            pixels[offset] = bpalResult.pixels[offset];
            pixels[offset + 1] = bpalResult.pixels[offset + 1];
            pixels[offset + 2] = bpalResult.pixels[offset + 2];
            pixels[offset + 3] = 255;
          }
        }
      }
    }

    const localColorCount = bpalResult
      ? bpalResult.localColorCount
      : bpalSettings.localColorCount;
    const globalColorCount = bpalResult
      ? bpalResult.globalColorCount
      : bpalSettings.globalColorCount;
    const paletteCount = bpalResult
      ? bpalResult.paletteCount
      : bpalSettings.paletteCount;
    const paletteColorBits = bpalResult
      ? bpalResult.paletteColorBits
      : bpalSettings.paletteColorBits;
    const image = {
      width,
      height,
      codingUnitSize: bpdhFormat.CODING_UNIT_SIZE,
      blocksX,
      blocksY,
      blockCount,
      modes: selected.modes,
      bpalBlockCount: selected.bpalCount,
      dctBlockCount: selected.dctCount,
      localColorCount,
      globalColorCount,
      paletteCount,
      paletteColorBits,
      palette: bpalResult ? bpalResult.palette.map(copyColor) : [],
      blockPaletteSelectors: bpalResult
        ? bpalResult.blockPaletteSelectors
        : new Uint8Array(blockCount),
      blockPaletteIndices: bpalResult
        ? bpalResult.blockPaletteIndices
        : new Uint16Array(blockCount * localColorCount),
      pixelIndices: bpalResult
        ? bpalResult.pixelIndices
        : new Uint8Array(width * height),
      quantizationTables: selected.dctCount > 0 ? selected.quantizationTables : null,
      dctQuality: selected.dctCount > 0 ? selected.quality : null,
      dctBlocks,
      pixels,
      targetBitsPerPixel,
    };
    const layout = bpdhFormat.getBpdhFileLayout(image);
    const squaredError = calculateImageSquaredError(sourcePixels, pixels);
    const meanSquaredError = squaredError / (width * height * 3);

    if (layout.payloadBytes !== selected.payloadBytes) {
      throw new Error("BPDH RDO size estimate differs from the serialized layout");
    }

    return {
      ...image,
      squaredError,
      meanSquaredError,
      psnr: meanSquaredError === 0
        ? Infinity
        : 10 * Math.log10(255 * 255 / meanSquaredError),
      storage: {
        ...layout,
        targetBitsPerPixel,
        targetPayloadBytes,
        withinTarget: selected.withinTarget,
      },
    };
  }

  function normalizeBpalSettings(settings, blockCount) {
    const supplied = settings || {};

    if (
      supplied.blockSize !== undefined &&
      Number(supplied.blockSize) !== bpdhFormat.CODING_UNIT_SIZE
    ) {
      throw new RangeError("BPDH BPAL blocks must be 16x16");
    }

    return {
      blockSize: bpdhFormat.CODING_UNIT_SIZE,
      localColorCount: supplied.localColorCount === undefined
        ? 8
        : Number(supplied.localColorCount),
      globalColorCount: supplied.globalColorCount === undefined
        ? 32
        : Number(supplied.globalColorCount),
      paletteCount: supplied.paletteCount === undefined
        ? largestPowerOfTwo(Math.min(64, blockCount))
        : Number(supplied.paletteCount),
      paletteColorBits: supplied.paletteColorBits === undefined
        ? 24
        : Number(supplied.paletteColorBits),
      paletteMode: "explicit",
      colorSpace: supplied.colorSpace || "rgb",
      clusteringMethod: supplied.clusteringMethod || "k-means",
      dithering: supplied.dithering || "none",
      diversity: supplied.diversity === undefined ? 0 : Number(supplied.diversity),
      refinementPasses: supplied.refinementPasses === undefined
        ? 4
        : Number(supplied.refinementPasses),
    };
  }

  function normalizeDctQualities(options) {
    let values;

    if (options.dctQualities !== undefined) {
      if (!Array.isArray(options.dctQualities) || options.dctQualities.length === 0) {
        throw new TypeError("BPDH dctQualities must be a nonempty array");
      }

      values = options.dctQualities;
    } else if (options.dctQuality !== undefined) {
      values = [options.dctQuality];
    } else {
      values = DEFAULT_DCT_QUALITIES;
    }

    const normalized = Array.from(new Set(values.map((value) => Math.round(Number(value)))));

    for (const quality of normalized) {
      if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
        throw new RangeError("BPDH DCT qualities must be integers from 1 to 100");
      }
    }

    normalized.sort((left, right) => left - right);
    return normalized;
  }

  function chooseLowestDistortionMode(bpal, dct) {
    if (dct.squaredError < bpal.squaredError) {
      return bpdhFormat.MODE_DCT;
    }

    if (dct.squaredError > bpal.squaredError) {
      return bpdhFormat.MODE_BPAL;
    }

    return dct.bits < bpal.bits ? bpdhFormat.MODE_DCT : bpdhFormat.MODE_BPAL;
  }

  function sumCandidates(candidates) {
    let bits = 0;
    let squaredError = 0;

    for (const candidate of candidates) {
      bits += candidate.bits;
      squaredError += candidate.squaredError;
    }

    return { bits, squaredError };
  }

  function paletteByteLength(bpalResult) {
    return bpalResult.paletteCount * bpalResult.globalColorCount *
      bpalResult.paletteColorBits / 8;
  }

  function calculateBlockSquaredError(
    sourcePixels,
    reconstructedPixels,
    width,
    height,
    blockX,
    blockY
  ) {
    const startX = blockX * bpdhFormat.CODING_UNIT_SIZE;
    const startY = blockY * bpdhFormat.CODING_UNIT_SIZE;
    const endX = Math.min(startX + bpdhFormat.CODING_UNIT_SIZE, width);
    const endY = Math.min(startY + bpdhFormat.CODING_UNIT_SIZE, height);
    let squaredError = 0;

    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * width + x) * 4;

        for (let channel = 0; channel < 3; channel += 1) {
          const difference = sourcePixels[offset + channel] - reconstructedPixels[offset + channel];

          squaredError += difference * difference;
        }
      }
    }

    return squaredError;
  }

  function calculateImageSquaredError(sourcePixels, reconstructedPixels) {
    let squaredError = 0;

    for (let offset = 0; offset < reconstructedPixels.length; offset += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = sourcePixels[offset + channel] - reconstructedPixels[offset + channel];

        squaredError += difference * difference;
      }
    }

    return squaredError;
  }

  function copyMacroblockPixels(source, target, width, startX, startY, endX, endY) {
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const sourceOffset = ((y - startY) * bpdhFormat.CODING_UNIT_SIZE + x - startX) * 4;
        const targetOffset = (y * width + x) * 4;

        target.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
  }

  function blockPixelCount(width, height, blockX, blockY) {
    return Math.max(0, Math.min(bpdhFormat.CODING_UNIT_SIZE, width - blockX * 16)) *
      Math.max(0, Math.min(bpdhFormat.CODING_UNIT_SIZE, height - blockY * 16));
  }

  function largestPowerOfTwo(value) {
    let result = 1;

    while (result * 2 <= value) {
      result *= 2;
    }

    return result;
  }

  function copyColor(color) {
    return { r: color.r, g: color.g, b: color.b };
  }

  function validateSource(sourcePixels, width, height) {
    if (!isByteArray(sourcePixels) || sourcePixels.length !== width * height * 4) {
      throw new TypeError("BPDH source must contain exactly width*height RGBA pixels");
    }

    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError("BPDH dimensions must be positive integers");
    }
  }

  function reportProgress(callback, stage, progress, details) {
    if (typeof callback === "function") {
      callback({ stage, progress, ...(details || {}) });
    }
  }

  function isByteArray(value) {
    return value instanceof Uint8Array || value instanceof Uint8ClampedArray;
  }

  return {
    DEFAULT_TARGET_BITS_PER_PIXEL,
    DEFAULT_DCT_QUALITIES: DEFAULT_DCT_QUALITIES.slice(),
    compressHybridImage,
  };
});
