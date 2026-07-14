(function (root, factory) {
  "use strict";

  const blockPaletteFormat = typeof module === "object" && module.exports
    ? require("../palette/block-palette-format.js")
    : root.BlockPaletteFormat;
  const api = factory(blockPaletteFormat);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BpalTextureDecoder = api;
})(typeof self !== "undefined" ? self : globalThis, function (blockPaletteFormat) {
  "use strict";

  const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, value) => {
    const normalized = value / 255;

    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  function decode(input) {
    if (!blockPaletteFormat || typeof blockPaletteFormat.decodeBlockPaletteFile !== "function") {
      throw new Error("BPAL format decoder is unavailable");
    }

    const decoded = blockPaletteFormat.decodeBlockPaletteFile(input);
    const expectedLength = decoded.width * decoded.height * 4;

    if (!(decoded.pixels instanceof Uint8ClampedArray) || decoded.pixels.length !== expectedLength) {
      throw new RangeError("Decoded BPAL texture has an invalid RGBA buffer");
    }

    return {
      width: decoded.width,
      height: decoded.height,
      pixels: decoded.pixels,
      version: decoded.version,
      blockSize: decoded.blockSize,
      localColorCount: decoded.localColorCount,
      globalColorCount: decoded.globalColorCount,
      paletteCount: decoded.paletteCount,
      paletteIndexBits: decoded.paletteIndexBits,
      paletteMode: decoded.paletteMode,
      paletteColorBits: decoded.paletteColorBits,
      channelMode: decoded.channelMode,
      blocksX: decoded.blocksX,
      palette: decoded.palette,
      blockPaletteSelectors: decoded.blockPaletteSelectors,
      blockPaletteIndices: decoded.blockPaletteIndices,
      pixelIndices: decoded.pixelIndices,
    };
  }

  function createShaderTextureData(texture, maxTextureSize) {
    if (!texture || !Number.isInteger(texture.width) || !Number.isInteger(texture.height)) {
      throw new TypeError("Decoded BPAL texture metadata is invalid");
    }

    const textureLimit = Number(maxTextureSize);

    if (!Number.isInteger(textureLimit) || textureLimit < 1) {
      throw new RangeError("WebGL maximum texture size must be a positive integer");
    }

    const pixelAtlas = createAtlas(texture.pixelIndices, 1, textureLimit, (target, offset, value) => {
      target[offset] = value;
    });
    const blockPaletteAtlas = createAtlas(
      texture.blockPaletteIndices,
      4,
      textureLimit,
      (target, offset, value) => {
        target[offset] = value & 255;
        target[offset + 1] = value >> 8 & 255;
        target[offset + 3] = 255;
      }
    );
    const paletteSelectorAtlas = createAtlas(
      texture.blockPaletteSelectors || new Uint8Array(
        texture.blocksX * Math.ceil(texture.height / texture.blockSize)
      ),
      1,
      textureLimit,
      (target, offset, value) => {
        target[offset] = value;
      }
    );
    const paletteAtlas = createAtlas(texture.palette, 4, textureLimit, (target, offset, color) => {
      target[offset] = color.r;
      target[offset + 1] = color.g;
      target[offset + 2] = color.b;
      target[offset + 3] = 255;
    });

    return {
      width: texture.width,
      height: texture.height,
      blockSize: texture.blockSize,
      blocksX: texture.blocksX,
      localColorCount: texture.localColorCount,
      globalColorCount: texture.globalColorCount,
      paletteCount: texture.paletteCount || 1,
      pixelAtlas,
      paletteSelectorAtlas,
      blockPaletteAtlas,
      paletteAtlas,
    };
  }

  function createCompactShaderTextureData(texture, maxTextureSize) {
    if (!texture || !Number.isInteger(texture.width) || !Number.isInteger(texture.height)) {
      throw new TypeError("Decoded BPAL texture metadata is invalid");
    }

    const textureLimit = Number(maxTextureSize);

    if (!Number.isInteger(textureLimit) || textureLimit < 1) {
      throw new RangeError("WebGL maximum texture size must be a positive integer");
    }

    const localIndexBits = indexBitCount(texture.localColorCount);
    const globalIndexBits = indexBitCount(texture.globalColorCount);
    const paletteCount = texture.paletteCount || 1;
    const paletteIndexBits = Math.log2(paletteCount);
    const paletteColorBits = texture.paletteColorBits === 16 ? 16 : 24;
    const pixelAtlas = createPackedUintAtlas(
      texture.pixelIndices,
      localIndexBits,
      textureLimit,
      (value) => value
    );
    const blockPaletteAtlas = createPackedUintAtlas(
      texture.blockPaletteIndices,
      globalIndexBits,
      textureLimit,
      (value) => value
    );
    const paletteSelectorAtlas = createPackedUintAtlas(
      texture.blockPaletteSelectors || new Uint8Array(
        texture.blocksX * Math.ceil(texture.height / texture.blockSize)
      ),
      Math.max(1, paletteIndexBits),
      textureLimit,
      (value) => value
    );
    const paletteAtlas = createPackedUintAtlas(
      texture.palette,
      paletteColorBits,
      textureLimit,
      (color) => encodePaletteColor(color, paletteColorBits)
    );

    return {
      compact: true,
      width: texture.width,
      height: texture.height,
      blockSize: texture.blockSize,
      blocksX: texture.blocksX,
      localColorCount: texture.localColorCount,
      globalColorCount: texture.globalColorCount,
      paletteCount,
      localIndexBits,
      globalIndexBits,
      paletteIndexBits,
      paletteColorBits,
      pixelAtlas,
      paletteSelectorAtlas,
      blockPaletteAtlas,
      paletteAtlas,
      gpuBytes: pixelAtlas.data.byteLength +
        paletteSelectorAtlas.data.byteLength +
        blockPaletteAtlas.data.byteLength +
        paletteAtlas.data.byteLength,
    };
  }

  function createMipmappedShaderTextureData(texture, maxTextureSize, options) {
    const settings = options || {};
    const maximumMipLevels = Math.floor(
      Math.max(1, Math.min(16, Number(settings.maxMipLevels) || 16))
    );
    const sourceLevels = Array.isArray(texture && texture.mipLevels)
      ? texture.mipLevels
      : createMipLevels(texture, { maxMipLevels: maximumMipLevels });
    const levels = sourceLevels.slice(0, maximumMipLevels).map((level) => ({ ...level }));

    if (levels.length === 0) {
      throw new RangeError("Decoded BPAL texture has no mip levels");
    }

    let pixelCount = 0;
    let paletteSelectorCount = 0;
    let blockPaletteEntryCount = 0;

    levels.forEach((level) => {
      level.pixelOffset = pixelCount;
      level.paletteSelectorOffset = paletteSelectorCount;
      level.blockPaletteOffset = blockPaletteEntryCount;
      level.direct = Boolean(level.direct || level.directGlobalIndices);
      pixelCount += level.pixelIndices ? level.pixelIndices.length : 0;
      paletteSelectorCount += level.direct ? 0 : level.blockPaletteSelectors.length;
      blockPaletteEntryCount += level.direct
        ? level.directGlobalIndices.length
        : level.blockPaletteIndices.length;
    });

    const pixelIndices = new Uint8Array(pixelCount);
    const blockPaletteSelectors = new Uint8Array(Math.max(1, paletteSelectorCount));
    const blockPaletteIndices = new Uint16Array(blockPaletteEntryCount);

    levels.forEach((level) => {
      if (level.pixelIndices) {
        pixelIndices.set(level.pixelIndices, level.pixelOffset);
      }

      if (!level.direct) {
        blockPaletteSelectors.set(level.blockPaletteSelectors, level.paletteSelectorOffset);
      }

      blockPaletteIndices.set(
        level.direct ? level.directGlobalIndices : level.blockPaletteIndices,
        level.blockPaletteOffset
      );
    });

    const pixelAtlas = createAtlas(pixelIndices, 1, maxTextureSize, (target, offset, value) => {
      target[offset] = value;
    });
    const blockPaletteAtlas = createAtlas(
      blockPaletteIndices,
      4,
      maxTextureSize,
      (target, offset, value) => {
        target[offset] = value & 255;
        target[offset + 1] = value >> 8 & 255;
        target[offset + 3] = 255;
      }
    );
    const paletteSelectorAtlas = createAtlas(
      blockPaletteSelectors,
      1,
      maxTextureSize,
      (target, offset, value) => {
        target[offset] = value;
      }
    );
    const paletteAtlas = createAtlas(texture.palette, 4, maxTextureSize, (target, offset, color) => {
      target[offset] = color.r;
      target[offset + 1] = color.g;
      target[offset + 2] = color.b;
      target[offset + 3] = 255;
    });

    return {
      width: texture.width,
      height: texture.height,
      blockSize: texture.blockSize,
      localColorCount: texture.localColorCount,
      globalColorCount: texture.globalColorCount,
      paletteCount: texture.paletteCount || 1,
      blocksX: texture.blocksX,
      mipCount: levels.length,
      levels,
      pixelAtlas,
      paletteSelectorAtlas,
      blockPaletteAtlas,
      paletteAtlas,
      gpuBytes: pixelAtlas.data.byteLength +
        paletteSelectorAtlas.data.byteLength +
        blockPaletteAtlas.data.byteLength +
        paletteAtlas.data.byteLength,
    };
  }

  function createMipLevels(texture, options) {
    if (
      !texture ||
      !(texture.pixels instanceof Uint8ClampedArray) ||
      !Array.isArray(texture.palette)
    ) {
      throw new TypeError("Decoded BPAL texture cannot be converted into a mip chain");
    }

    const settings = options || {};
    const maximumMipLevels = Math.floor(
      Math.max(1, Math.min(255, Number(settings.maxMipLevels) || 255))
    );
    const paletteCount = texture.paletteCount || 1;
    const globalColorCount = texture.globalColorCount || texture.palette.length;
    const palettePoints = texture.palette.map((color) => [
      srgbByteToLinear(color.r),
      srgbByteToLinear(color.g),
      srgbByteToLinear(color.b),
    ]);
    const paletteSearchTree = buildPaletteSearchTree(
      palettePoints.map((point, index) => ({ point, index })),
      0
    );
    const palettePointsByPalette = Array.from({ length: paletteCount }, (_, paletteIndex) =>
      palettePoints.slice(
        paletteIndex * globalColorCount,
        (paletteIndex + 1) * globalColorCount
      )
    );
    const paletteSearchTrees = palettePointsByPalette.map((points) =>
      buildPaletteSearchTree(
        points.map((point, index) => ({ point, index })),
        0
      )
    );
    const levels = [{
      width: texture.width,
      height: texture.height,
      blockSize: texture.blockSize,
      localColorCount: texture.localColorCount,
      blocksX: texture.blocksX,
      blocksY: Math.ceil(texture.height / texture.blockSize),
      blockPaletteSelectors: texture.blockPaletteSelectors || new Uint8Array(
        texture.blocksX * Math.ceil(texture.height / texture.blockSize)
      ),
      pixelIndices: texture.pixelIndices,
      blockPaletteIndices: texture.blockPaletteIndices,
    }];
    let sourcePixels = texture.pixels;
    let width = texture.width;
    let height = texture.height;
    let blockSize = texture.blockSize;

    while ((width > 1 || height > 1) && levels.length < maximumMipLevels) {
      const downsampled = downsampleRgba(sourcePixels, width, height);
      blockSize = Math.max(1, blockSize / 2);
      const localColorCount = Math.min(texture.localColorCount, blockSize * blockSize);
      const direct = localColorCount === blockSize * blockSize;
      const encoded = direct
        ? encodeDirectMipLevel(
          downsampled.pixels,
          downsampled.width,
          downsampled.height,
          blockSize,
          localColorCount,
          paletteSearchTree
        )
        : encodeMipLevel(
          downsampled.pixels,
          downsampled.width,
          downsampled.height,
          blockSize,
          localColorCount,
          palettePointsByPalette,
          paletteSearchTrees
        );

      levels.push(encoded);
      sourcePixels = downsampled.pixels;
      width = downsampled.width;
      height = downsampled.height;
    }

    return levels;
  }

  function downsampleRgba(source, width, height) {
    const targetWidth = Math.max(1, Math.floor(width / 2));
    const targetHeight = Math.max(1, Math.floor(height / 2));
    const target = new Uint8ClampedArray(targetWidth * targetHeight * 4);

    for (let y = 0; y < targetHeight; y += 1) {
      for (let x = 0; x < targetWidth; x += 1) {
        const x0 = x * 2;
        const y0 = y * 2;
        const x1 = Math.min(width - 1, x0 + 1);
        const y1 = Math.min(height - 1, y0 + 1);
        const topLeft = (y0 * width + x0) * 4;
        const topRight = (y0 * width + x1) * 4;
        const bottomLeft = (y1 * width + x0) * 4;
        const bottomRight = (y1 * width + x1) * 4;
        const targetOffset = (y * targetWidth + x) * 4;

        target[targetOffset] = linearToSrgbByte((
          SRGB_TO_LINEAR[source[topLeft]] +
          SRGB_TO_LINEAR[source[topRight]] +
          SRGB_TO_LINEAR[source[bottomLeft]] +
          SRGB_TO_LINEAR[source[bottomRight]]
        ) * 0.25);
        target[targetOffset + 1] = linearToSrgbByte((
          SRGB_TO_LINEAR[source[topLeft + 1]] +
          SRGB_TO_LINEAR[source[topRight + 1]] +
          SRGB_TO_LINEAR[source[bottomLeft + 1]] +
          SRGB_TO_LINEAR[source[bottomRight + 1]]
        ) * 0.25);
        target[targetOffset + 2] = linearToSrgbByte((
          SRGB_TO_LINEAR[source[topLeft + 2]] +
          SRGB_TO_LINEAR[source[topRight + 2]] +
          SRGB_TO_LINEAR[source[bottomLeft + 2]] +
          SRGB_TO_LINEAR[source[bottomRight + 2]]
        ) * 0.25);
        target[targetOffset + 3] = 255;
      }
    }

    return { width: targetWidth, height: targetHeight, pixels: target };
  }

  function encodeMipLevel(
    pixels,
    width,
    height,
    blockSize,
    localColorCount,
    palettePointsByPalette,
    paletteSearchTrees
  ) {
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const pixelPoints = createPixelPoints(pixels, width, height);
    const assignmentsByPalette = paletteSearchTrees.map((paletteSearchTree) =>
      assignPixelsToPalette(pixels, width, height, paletteSearchTree)
    );
    const blockPaletteSelectors = new Uint8Array(blocksX * blocksY);
    const blockPaletteIndices = new Uint16Array(blocksX * blocksY * localColorCount);
    const pixelIndices = new Uint8Array(width * height);

    for (let blockY = 0; blockY < blocksY; blockY += 1) {
      for (let blockX = 0; blockX < blocksX; blockX += 1) {
        const counts = new Map();
        const endX = Math.min(width, (blockX + 1) * blockSize);
        const endY = Math.min(height, (blockY + 1) * blockSize);
        let paletteIndex = 0;
        let bestPaletteError = Infinity;

        for (let candidate = 0; candidate < palettePointsByPalette.length; candidate += 1) {
          let error = 0;

          for (let y = blockY * blockSize; y < endY; y += 1) {
            for (let x = blockX * blockSize; x < endX; x += 1) {
              const pixel = y * width + x;
              const colorIndex = assignmentsByPalette[candidate][pixel];

              error += squaredDistance(
                pixelPoints[pixel],
                palettePointsByPalette[candidate][colorIndex]
              );
            }
          }

          if (error < bestPaletteError) {
            paletteIndex = candidate;
            bestPaletteError = error;
          }
        }

        const assignments = assignmentsByPalette[paletteIndex];
        const palettePoints = palettePointsByPalette[paletteIndex];

        for (let y = blockY * blockSize; y < endY; y += 1) {
          for (let x = blockX * blockSize; x < endX; x += 1) {
            const globalIndex = assignments[y * width + x];

            counts.set(globalIndex, (counts.get(globalIndex) || 0) + 1);
          }
        }

        const selected = Array.from(counts)
          .sort((left, right) => right[1] - left[1] || left[0] - right[0])
          .slice(0, localColorCount)
          .map(([globalIndex]) => globalIndex);

        if (selected.length === 0) {
          selected.push(0);
        }

        while (selected.length < localColorCount) {
          selected.push(selected[0]);
        }

        const blockIndex = blockY * blocksX + blockX;
        const paletteOffset = blockIndex * localColorCount;

        blockPaletteSelectors[blockIndex] = paletteIndex;

        for (let localIndex = 0; localIndex < localColorCount; localIndex += 1) {
          blockPaletteIndices[paletteOffset + localIndex] = selected[localIndex];
        }

        for (let y = blockY * blockSize; y < endY; y += 1) {
          for (let x = blockX * blockSize; x < endX; x += 1) {
            const pixel = y * width + x;
            const targetPoint = pixelPoints[pixel];
            let bestLocalIndex = 0;
            let bestDistance = squaredDistance(targetPoint, palettePoints[selected[0]]);

            for (let localIndex = 1; localIndex < localColorCount; localIndex += 1) {
              const distance = squaredDistance(targetPoint, palettePoints[selected[localIndex]]);

              if (distance < bestDistance) {
                bestDistance = distance;
                bestLocalIndex = localIndex;
              }
            }

            pixelIndices[pixel] = bestLocalIndex;
          }
        }
      }
    }

    return {
      width,
      height,
      blockSize,
      localColorCount,
      blocksX,
      blocksY,
      blockPaletteSelectors,
      blockPaletteIndices,
      pixelIndices,
    };
  }

  function encodeDirectMipLevel(
    pixels,
    width,
    height,
    blockSize,
    localColorCount,
    paletteSearchTree
  ) {
    return {
      width,
      height,
      blockSize,
      localColorCount,
      blocksX: Math.ceil(width / blockSize),
      blocksY: Math.ceil(height / blockSize),
      direct: true,
      directGlobalIndices: assignPixelsToPalette(pixels, width, height, paletteSearchTree),
    };
  }

  function assignPixelsToPalette(pixels, width, height, paletteSearchTree) {
    const assignments = new Uint16Array(width * height);
    const assignmentCache = new Map();

    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      const key = pixels[offset] << 16 | pixels[offset + 1] << 8 | pixels[offset + 2];
      let globalIndex = assignmentCache.get(key);

      if (globalIndex === undefined) {
        globalIndex = nearestPalettePoint([
          srgbByteToLinear(pixels[offset]),
          srgbByteToLinear(pixels[offset + 1]),
          srgbByteToLinear(pixels[offset + 2]),
        ], paletteSearchTree).index;
        assignmentCache.set(key, globalIndex);
      }

      assignments[pixel] = globalIndex;
    }

    return assignments;
  }

  function createPixelPoints(pixels, width, height) {
    const points = new Array(width * height);

    for (let pixel = 0; pixel < points.length; pixel += 1) {
      const offset = pixel * 4;

      points[pixel] = [
        srgbByteToLinear(pixels[offset]),
        srgbByteToLinear(pixels[offset + 1]),
        srgbByteToLinear(pixels[offset + 2]),
      ];
    }

    return points;
  }

  function buildPaletteSearchTree(entries, depth) {
    if (entries.length === 0) {
      return null;
    }

    const axis = depth % 3;
    const sorted = entries.slice().sort((left, right) => left.point[axis] - right.point[axis]);
    const middle = Math.floor(sorted.length / 2);

    return {
      ...sorted[middle],
      axis,
      left: buildPaletteSearchTree(sorted.slice(0, middle), depth + 1),
      right: buildPaletteSearchTree(sorted.slice(middle + 1), depth + 1),
    };
  }

  function nearestPalettePoint(point, tree, best) {
    if (!tree) {
      return best;
    }

    const distance = squaredDistance(point, tree.point);
    let nearest = !best || distance < best.distance
      ? { index: tree.index, distance }
      : best;
    const difference = point[tree.axis] - tree.point[tree.axis];
    const nearBranch = difference < 0 ? tree.left : tree.right;
    const farBranch = difference < 0 ? tree.right : tree.left;

    nearest = nearestPalettePoint(point, nearBranch, nearest);

    if (difference * difference < nearest.distance) {
      nearest = nearestPalettePoint(point, farBranch, nearest);
    }

    return nearest;
  }

  function squaredDistance(left, right) {
    return (left[0] - right[0]) ** 2 +
      (left[1] - right[1]) ** 2 +
      (left[2] - right[2]) ** 2;
  }

  function srgbByteToLinear(value) {
    return SRGB_TO_LINEAR[value];
  }

  function linearToSrgbByte(value) {
    const clamped = Math.max(0, Math.min(1, value));
    const normalized = clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * clamped ** (1 / 2.4) - 0.055;

    return Math.round(normalized * 255);
  }

  function createAtlas(values, channels, maxTextureSize, writeValue) {
    if (!values || typeof values.length !== "number" || values.length < 1) {
      throw new RangeError("BPAL shader atlas source is empty");
    }

    const width = Math.min(maxTextureSize, values.length);
    const height = Math.ceil(values.length / width);

    if (height > maxTextureSize) {
      throw new RangeError("BPAL data exceeds the WebGL texture size limit");
    }

    const data = new Uint8Array(width * height * channels);

    for (let index = 0; index < values.length; index += 1) {
      writeValue(data, index * channels, values[index]);
    }

    return { width, height, data, channels };
  }

  function createPackedUintAtlas(values, bitsPerValue, maxTextureSize, transformValue) {
    if (!values || typeof values.length !== "number" || values.length < 1) {
      throw new RangeError("BPAL compact atlas source is empty");
    }

    const wordCount = Math.ceil(values.length * bitsPerValue / 32);
    const height = Math.ceil(wordCount / maxTextureSize);
    const width = Math.ceil(wordCount / height);

    if (height > maxTextureSize) {
      throw new RangeError("BPAL compact data exceeds the WebGL texture size limit");
    }

    const data = new Uint32Array(width * height);
    const valueLimit = 2 ** bitsPerValue;

    for (let index = 0; index < values.length; index += 1) {
      const value = Number(transformValue(values[index]));

      if (!Number.isInteger(value) || value < 0 || value >= valueLimit) {
        throw new RangeError("BPAL compact atlas value does not fit its bit width");
      }

      const bitOffset = index * bitsPerValue;
      const wordIndex = Math.floor(bitOffset / 32);
      const wordBit = bitOffset % 32;

      data[wordIndex] = (data[wordIndex] | value << wordBit) >>> 0;

      if (wordBit + bitsPerValue > 32) {
        data[wordIndex + 1] = (data[wordIndex + 1] | value >>> (32 - wordBit)) >>> 0;
      }
    }

    return { width, height, data, bitsPerValue };
  }

  function indexBitCount(valueCount) {
    if (!Number.isInteger(valueCount) || valueCount < 1) {
      throw new RangeError("BPAL index value count must be positive");
    }

    return Math.max(1, Math.ceil(Math.log2(valueCount)));
  }

  function encodePaletteColor(color, paletteColorBits) {
    if (paletteColorBits === 16) {
      const red = Math.round(color.r * 31 / 255);
      const green = Math.round(color.g * 63 / 255);
      const blue = Math.round(color.b * 31 / 255);

      return red << 11 | green << 5 | blue;
    }

    return color.r | color.g << 8 | color.b << 16;
  }

  return {
    decode,
    createShaderTextureData,
    createCompactShaderTextureData,
    createMipLevels,
    createMipmappedShaderTextureData,
  };
});
