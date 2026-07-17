(function (root, factory) {
  "use strict";

  const blockPaletteCodec = typeof module === "object" && module.exports
    ? require("./block-palette-codec.js")
    : root.BlockPaletteCodec;
  const api = factory(blockPaletteCodec);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BlockPaletteOptimizer = api;
})(typeof self !== "undefined" ? self : globalThis, function (blockPaletteCodec) {
  "use strict";

  const BPAL_HEADER_BYTES = 14;
  const DEFAULT_BITS_PER_PIXEL_TARGETS = [1.5, 2, 2.5, 3, 4, 5, 6, 8];
  const DEFAULT_PROFILES = [
    { blockSize: 8, localColorCount: 8, globalColorCount: 256, paletteColorBits: 24 },
    { blockSize: 8, localColorCount: 8, globalColorCount: 256, paletteColorBits: 16 },
    { blockSize: 8, localColorCount: 4, globalColorCount: 256, paletteColorBits: 16 },
    { blockSize: 16, localColorCount: 16, globalColorCount: 256, paletteColorBits: 24 },
    { blockSize: 16, localColorCount: 16, globalColorCount: 256, paletteColorBits: 16 },
    { blockSize: 16, localColorCount: 8, globalColorCount: 128, paletteColorBits: 16 },
    { blockSize: 16, localColorCount: 4, globalColorCount: 128, paletteColorBits: 16 },
    { blockSize: 16, localColorCount: 2, globalColorCount: 64, paletteColorBits: 16 },
    { blockSize: 32, localColorCount: 16, globalColorCount: 128, paletteColorBits: 16 },
    { blockSize: 32, localColorCount: 8, globalColorCount: 64, paletteColorBits: 16 },
    { blockSize: 32, localColorCount: 4, globalColorCount: 64, paletteColorBits: 16 },
    { blockSize: 32, localColorCount: 2, globalColorCount: 32, paletteColorBits: 16 },
    { blockSize: 64, localColorCount: 16, globalColorCount: 64, paletteColorBits: 16 },
    { blockSize: 64, localColorCount: 8, globalColorCount: 32, paletteColorBits: 16 },
    { blockSize: 64, localColorCount: 4, globalColorCount: 16, paletteColorBits: 16 },
    { blockSize: 64, localColorCount: 2, globalColorCount: 8, paletteColorBits: 16 },
  ];

  function findBalancedBlockPaletteSettings(
    sourcePixels,
    width,
    height,
    options,
    onProgress
  ) {
    const searchOptions = options || {};
    const requestedProfiles = searchOptions.profiles || DEFAULT_PROFILES;
    const paletteColorBits = normalizePaletteColorBits(searchOptions.paletteColorBits);
    const profiles = normalizeProfiles(
      searchOptions.baselineProfile
        ? [searchOptions.baselineProfile, ...requestedProfiles]
        : requestedProfiles,
      paletteColorBits
    );
    const commonSettings = {
      colorSpace: searchOptions.colorSpace || "oklab",
      clusteringMethod: searchOptions.clusteringMethod || "k-medoids",
      dithering: searchOptions.dithering || "none",
      diversity: searchOptions.diversity === undefined ? 0 : searchOptions.diversity,
      refinementPasses: searchOptions.refinementPasses === undefined
        ? 4
        : Number(searchOptions.refinementPasses),
      paletteCount: Number(searchOptions.paletteCount || 1),
      paletteMode: "explicit",
    };
    const storageWidth = normalizeStorageDimension(searchOptions.storageWidth, width);
    const storageHeight = normalizeStorageDimension(searchOptions.storageHeight, height);
    const candidates = [];

    for (let index = 0; index < profiles.length; index += 1) {
      const settings = { ...commonSettings, ...profiles[index] };
      const result = blockPaletteCodec.compressImage(
        sourcePixels,
        width,
        height,
        settings
      );
      const storage = calculateStorage(
        profiles[index],
        commonSettings.paletteCount,
        storageWidth,
        storageHeight
      );
      const candidate = {
        settings: profiles[index],
        rmse: Math.sqrt(result.meanSquaredError),
        psnr: calculatePsnr(result.meanSquaredError),
        payloadBytes: storage.totalBytes,
        fileBytes: storage.totalBytes + BPAL_HEADER_BYTES,
        bitsPerPixel: storage.bitsPerPixel,
        compressionRatio: storage.compressionRatio,
      };

      candidates.push(candidate);

      if (typeof onProgress === "function") {
        onProgress({
          completed: index + 1,
          total: profiles.length,
          candidate,
        });
      }
    }

    const frontier = paretoFrontier(candidates);
    const targetBitsPerPixel = normalizeTargetBitsPerPixel(
      searchOptions.targetBitsPerPixel
    );
    const bitsPerPixelRange = targetBitsPerPixel === null
      ? null
      : calculateBitsPerPixelRange(
        targetBitsPerPixel,
        searchOptions.bitsPerPixelTargets || DEFAULT_BITS_PER_PIXEL_TARGETS
      );
    const matchingCandidates = bitsPerPixelRange === null
      ? frontier
      : candidates.filter((candidate) => (
        candidate.bitsPerPixel >= bitsPerPixelRange.minimum &&
        candidate.bitsPerPixel <= bitsPerPixelRange.maximum
      ));
    const selected = bitsPerPixelRange === null
      ? selectBalancedCandidate(frontier)
      : selectHighestQualityCandidate(matchingCandidates, targetBitsPerPixel);

    return {
      settings: selected.settings,
      selected,
      frontier,
      candidates,
      matchingCandidates,
      targetBitsPerPixel,
      bitsPerPixelRange,
    };
  }

  function calculateBitsPerPixelRange(
    targetBitsPerPixel,
    targets = DEFAULT_BITS_PER_PIXEL_TARGETS
  ) {
    const target = normalizeTargetBitsPerPixel(targetBitsPerPixel);

    if (target === null) {
      throw new RangeError("Target bits per pixel must be a positive finite number");
    }

    const normalizedTargets = Array.from(new Set(targets.map(Number)))
      .filter((value) => Number.isFinite(value) && value > 0 && value !== target)
      .sort((left, right) => left - right);
    const previousTarget = normalizedTargets
      .slice()
      .reverse()
      .find((value) => value < target);
    const nextTarget = normalizedTargets.find((value) => value > target);

    if (previousTarget === undefined && nextTarget === undefined) {
      throw new RangeError("At least one adjacent bits-per-pixel target is required");
    }

    const previous = previousTarget === undefined
      ? target - (nextTarget - target)
      : previousTarget;
    const next = nextTarget === undefined
      ? target + (target - previousTarget)
      : nextTarget;

    return {
      minimum: Math.max(0, (previous + target) / 2),
      maximum: (next + target) / 2,
    };
  }

  function selectHighestQualityCandidate(candidates, targetBitsPerPixel) {
    if (candidates.length === 0) {
      throw new RangeError("No block-palette optimization candidates in the target bpp range");
    }

    return candidates.reduce((selected, candidate) => {
      const errorDifference = candidate.rmse - selected.rmse;

      if (errorDifference < 0) {
        return candidate;
      }

      if (errorDifference > 0) {
        return selected;
      }

      const candidateDistance = Math.abs(candidate.bitsPerPixel - targetBitsPerPixel);
      const selectedDistance = Math.abs(selected.bitsPerPixel - targetBitsPerPixel);

      if (candidateDistance !== selectedDistance) {
        return candidateDistance < selectedDistance ? candidate : selected;
      }

      return candidate.fileBytes < selected.fileBytes ? candidate : selected;
    });
  }

  function calculatePsnr(meanSquaredError) {
    return meanSquaredError === 0
      ? Infinity
      : 10 * Math.log10((255 * 255) / meanSquaredError);
  }

  function calculateStorage(profile, paletteCount, width, height) {
    const blocksX = Math.ceil(width / profile.blockSize);
    const blocksY = Math.ceil(height / profile.blockSize);
    const blockCount = blocksX * blocksY;
    const globalPaletteBits = paletteCount * profile.globalColorCount * profile.paletteColorBits;
    const blockPaletteSelectorBits = blockCount * Math.log2(paletteCount);
    const blockPaletteBits = blockCount * profile.localColorCount * Math.log2(profile.globalColorCount);
    const pixelDataBits = profile.localColorCount === profile.blockSize * profile.blockSize
      ? 0
      : width * height * Math.log2(profile.localColorCount);
    const payloadBits = globalPaletteBits + blockPaletteSelectorBits + blockPaletteBits + pixelDataBits;

    return {
      totalBytes: Math.ceil(payloadBits / 8),
      bitsPerPixel: payloadBits / (width * height),
      compressionRatio: width * height * 24 / payloadBits,
    };
  }

  function normalizeStorageDimension(value, fallback) {
    if (value === undefined || value === null) {
      return fallback;
    }

    const normalized = Number(value);

    if (!Number.isInteger(normalized) || normalized <= 0) {
      throw new RangeError("Storage dimensions must be positive integers");
    }

    return normalized;
  }

  function normalizePaletteColorBits(value) {
    if (value === undefined || value === null) {
      return null;
    }

    const normalized = Number(value);

    if (normalized !== 16 && normalized !== 24) {
      throw new RangeError("Palette color format must be RGB565 or RGB888");
    }

    return normalized;
  }

  function normalizeTargetBitsPerPixel(value) {
    if (value === undefined || value === null || value === "") {
      return null;
    }

    const normalized = Number(value);

    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new RangeError("Target bits per pixel must be a positive finite number");
    }

    return normalized;
  }

  function paretoFrontier(candidates) {
    return candidates
      .filter((candidate, candidateIndex) => !candidates.some((other, otherIndex) => (
        candidateIndex !== otherIndex &&
        other.fileBytes <= candidate.fileBytes &&
        other.rmse <= candidate.rmse &&
        (other.fileBytes < candidate.fileBytes || other.rmse < candidate.rmse)
      )))
      .sort((left, right) => left.fileBytes - right.fileBytes || left.rmse - right.rmse);
  }

  function selectBalancedCandidate(frontier) {
    if (frontier.length === 0) {
      throw new RangeError("No block-palette optimization candidates");
    }

    const minimumRmse = Math.min(...frontier.map((candidate) => candidate.rmse));
    const maximumRmse = Math.max(...frontier.map((candidate) => candidate.rmse));
    const minimumLogSize = Math.min(...frontier.map((candidate) => Math.log(candidate.fileBytes)));
    const maximumLogSize = Math.max(...frontier.map((candidate) => Math.log(candidate.fileBytes)));
    const rmseRange = maximumRmse - minimumRmse;
    const sizeRange = maximumLogSize - minimumLogSize;
    let selected = frontier[0];
    let bestScore = Infinity;

    for (const candidate of frontier) {
      const normalizedError = rmseRange === 0
        ? 0
        : (candidate.rmse - minimumRmse) / rmseRange;
      const normalizedSize = sizeRange === 0
        ? 0
        : (Math.log(candidate.fileBytes) - minimumLogSize) / sizeRange;
      const score = normalizedError * normalizedError * 1.5 + normalizedSize * normalizedSize;

      if (
        score < bestScore ||
        (score === bestScore && candidate.fileBytes < selected.fileBytes)
      ) {
        selected = candidate;
        bestScore = score;
      }
    }

    return { ...selected, score: bestScore };
  }

  function normalizeProfiles(profiles, paletteColorBits) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
      throw new RangeError("Optimization profiles must be a non-empty array");
    }

    const unique = new Map();

    for (const profile of profiles) {
      const normalized = {
        blockSize: Number(profile.blockSize),
        localColorCount: Number(profile.localColorCount),
        globalColorCount: Number(profile.globalColorCount),
        paletteColorBits: paletteColorBits === null
          ? Number(profile.paletteColorBits)
          : paletteColorBits,
      };
      const key = [
        normalized.blockSize,
        normalized.localColorCount,
        normalized.globalColorCount,
        normalized.paletteColorBits,
      ].join(":");

      unique.set(key, normalized);
    }

    return Array.from(unique.values());
  }

  return {
    DEFAULT_BITS_PER_PIXEL_TARGETS,
    DEFAULT_PROFILES,
    calculateBitsPerPixelRange,
    findBalancedBlockPaletteSettings,
    paretoFrontier,
    selectBalancedCandidate,
    selectHighestQualityCandidate,
  };
});
