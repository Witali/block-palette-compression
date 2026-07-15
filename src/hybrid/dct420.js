(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.Dct420 = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const BLOCK_SIZE = 8;
  const MACROBLOCK_SIZE = 16;
  const BLOCKS_PER_MACROBLOCK = 6;
  const FIXED_POINT_SCALE = 16384;
  const COLOR_SCALE = 65536;
  // round(C(u) * cos((2*x+1)*u*pi/16) * 2^14), fixed by the BPDH v1 decoder.
  const DCT_BASIS = [
    [11585, 16069, 15137, 13623, 11585, 9102, 6270, 3196],
    [11585, 13623, 6270, -3196, -11585, -16069, -15137, -9102],
    [11585, 9102, -6270, -16069, -11585, 3196, 15137, 13623],
    [11585, 3196, -15137, -9102, 11585, 13623, -6270, -16069],
    [11585, -3196, -15137, 9102, 11585, -13623, -6270, 16069],
    [11585, -9102, -6270, 16069, -11585, -3196, 15137, -13623],
    [11585, -13623, 6270, 3196, -11585, 16069, -15137, 9102],
    [11585, -16069, 15137, -13623, 11585, -9102, 6270, -3196],
  ];
  const LUMA_QUANTIZATION_BASE = new Uint8Array([
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
  ]);
  const CHROMA_QUANTIZATION_BASE = new Uint8Array([
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
  ]);

  function createQuantizationTables(quality) {
    const normalizedQuality = Math.round(Number(quality));

    if (!Number.isInteger(normalizedQuality) || normalizedQuality < 1 || normalizedQuality > 100) {
      throw new RangeError("DCT quality must be an integer from 1 to 100");
    }

    return {
      quality: normalizedQuality,
      luma: scaleQuantizationTable(LUMA_QUANTIZATION_BASE, normalizedQuality),
      chroma: scaleQuantizationTable(CHROMA_QUANTIZATION_BASE, normalizedQuality),
    };
  }

  function transformMacroblock(sourcePixels, width, height, blockX, blockY) {
    validateSource(sourcePixels, width, height);

    const startX = blockX * MACROBLOCK_SIZE;
    const startY = blockY * MACROBLOCK_SIZE;
    const luma = new Float64Array(MACROBLOCK_SIZE * MACROBLOCK_SIZE);
    const chromaBlue = new Float64Array(BLOCK_SIZE * BLOCK_SIZE);
    const chromaRed = new Float64Array(BLOCK_SIZE * BLOCK_SIZE);

    for (let localY = 0; localY < MACROBLOCK_SIZE; localY += 1) {
      const sourceY = Math.min(startY + localY, height - 1);

      for (let localX = 0; localX < MACROBLOCK_SIZE; localX += 1) {
        const sourceX = Math.min(startX + localX, width - 1);
        const sourceOffset = (sourceY * width + sourceX) * 4;
        const red = sourcePixels[sourceOffset];
        const green = sourcePixels[sourceOffset + 1];
        const blue = sourcePixels[sourceOffset + 2];
        const lumaValue = clampByte(roundDivide(
          19595 * red + 38470 * green + 7471 * blue,
          COLOR_SCALE
        ));
        const chromaBlueValue = clampByte(128 + roundDivide(
          -11059 * red - 21709 * green + 32768 * blue,
          COLOR_SCALE
        ));
        const chromaRedValue = clampByte(128 + roundDivide(
          32768 * red - 27439 * green - 5329 * blue,
          COLOR_SCALE
        ));
        const chromaIndex = Math.floor(localY / 2) * BLOCK_SIZE + Math.floor(localX / 2);

        luma[localY * MACROBLOCK_SIZE + localX] = lumaValue;
        chromaBlue[chromaIndex] += chromaBlueValue;
        chromaRed[chromaIndex] += chromaRedValue;
      }
    }

    for (let index = 0; index < chromaBlue.length; index += 1) {
      chromaBlue[index] = roundDivide(chromaBlue[index], 4);
      chromaRed[index] = roundDivide(chromaRed[index], 4);
    }

    return [
      forwardDct(extractLumaBlock(luma, 0, 0)),
      forwardDct(extractLumaBlock(luma, 1, 0)),
      forwardDct(extractLumaBlock(luma, 0, 1)),
      forwardDct(extractLumaBlock(luma, 1, 1)),
      forwardDct(chromaBlue),
      forwardDct(chromaRed),
    ];
  }

  function quantizeMacroblock(transformedBlocks, quantizationTables) {
    validateTransformedBlocks(transformedBlocks);
    validateQuantizationTables(quantizationTables);

    return transformedBlocks.map((coefficients, blockIndex) => {
      const table = blockIndex < 4 ? quantizationTables.luma : quantizationTables.chroma;
      const quantized = new Int16Array(64);

      for (let index = 0; index < 64; index += 1) {
        quantized[index] = clampInt16(roundDivide(coefficients[index], table[index]));
      }

      return quantized;
    });
  }

  function decodeMacroblock(quantizedBlocks, quantizationTables) {
    validateQuantizedBlocks(quantizedBlocks);
    validateQuantizationTables(quantizationTables);

    const decoded = quantizedBlocks.map((coefficients, blockIndex) => {
      const table = blockIndex < 4 ? quantizationTables.luma : quantizationTables.chroma;
      const dequantized = new Float64Array(64);

      for (let index = 0; index < 64; index += 1) {
        dequantized[index] = coefficients[index] * table[index];
      }

      const samples = inverseDct(dequantized);

      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = clampByte(Math.round(samples[index]));
      }

      return samples;
    });
    const output = new Uint8ClampedArray(MACROBLOCK_SIZE * MACROBLOCK_SIZE * 4);

    for (let localY = 0; localY < MACROBLOCK_SIZE; localY += 1) {
      for (let localX = 0; localX < MACROBLOCK_SIZE; localX += 1) {
        const lumaBlockX = Math.floor(localX / BLOCK_SIZE);
        const lumaBlockY = Math.floor(localY / BLOCK_SIZE);
        const lumaBlockIndex = lumaBlockY * 2 + lumaBlockX;
        const lumaIndex = (localY % BLOCK_SIZE) * BLOCK_SIZE + localX % BLOCK_SIZE;
        const luma = decoded[lumaBlockIndex][lumaIndex];
        const chromaBlue = sampleChroma(decoded[4], localX, localY) - 128;
        const chromaRed = sampleChroma(decoded[5], localX, localY) - 128;
        const outputOffset = (localY * MACROBLOCK_SIZE + localX) * 4;

        output[outputOffset] = clampByte(luma + roundDivide(91881 * chromaRed, COLOR_SCALE));
        output[outputOffset + 1] = clampByte(luma + roundDivide(
          -22554 * chromaBlue - 46802 * chromaRed,
          COLOR_SCALE
        ));
        output[outputOffset + 2] = clampByte(luma + roundDivide(116130 * chromaBlue, COLOR_SCALE));
        output[outputOffset + 3] = 255;
      }
    }

    return output;
  }

  function calculateMacroblockSquaredError(
    sourcePixels,
    width,
    height,
    blockX,
    blockY,
    reconstructedPixels
  ) {
    validateSource(sourcePixels, width, height);

    if (!isByteArray(reconstructedPixels) || reconstructedPixels.length !== 16 * 16 * 4) {
      throw new TypeError("DCT reconstructed macroblock must contain 16x16 RGBA pixels");
    }

    const startX = blockX * MACROBLOCK_SIZE;
    const startY = blockY * MACROBLOCK_SIZE;
    const endX = Math.min(startX + MACROBLOCK_SIZE, width);
    const endY = Math.min(startY + MACROBLOCK_SIZE, height);
    let squaredError = 0;

    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const sourceOffset = (y * width + x) * 4;
        const localOffset = ((y - startY) * MACROBLOCK_SIZE + x - startX) * 4;

        for (let channel = 0; channel < 3; channel += 1) {
          const difference = sourcePixels[sourceOffset + channel] - reconstructedPixels[localOffset + channel];

          squaredError += difference * difference;
        }
      }
    }

    return squaredError;
  }

  function forwardDct(samples) {
    const horizontal = new Float64Array(64);
    const coefficients = new Float64Array(64);

    for (let y = 0; y < BLOCK_SIZE; y += 1) {
      for (let u = 0; u < BLOCK_SIZE; u += 1) {
        let sum = 0;

        for (let x = 0; x < BLOCK_SIZE; x += 1) {
          sum += (samples[y * BLOCK_SIZE + x] - 128) * DCT_BASIS[x][u];
        }

        horizontal[y * BLOCK_SIZE + u] = roundDivide(sum, FIXED_POINT_SCALE);
      }
    }

    for (let v = 0; v < BLOCK_SIZE; v += 1) {
      for (let u = 0; u < BLOCK_SIZE; u += 1) {
        let sum = 0;

        for (let y = 0; y < BLOCK_SIZE; y += 1) {
          sum += horizontal[y * BLOCK_SIZE + u] * DCT_BASIS[y][v];
        }

        coefficients[v * BLOCK_SIZE + u] = roundDivide(sum, 4 * FIXED_POINT_SCALE);
      }
    }

    return coefficients;
  }

  function inverseDct(coefficients) {
    const horizontal = new Float64Array(64);
    const samples = new Float64Array(64);

    for (let v = 0; v < BLOCK_SIZE; v += 1) {
      for (let x = 0; x < BLOCK_SIZE; x += 1) {
        let sum = 0;

        for (let u = 0; u < BLOCK_SIZE; u += 1) {
          sum += coefficients[v * BLOCK_SIZE + u] * DCT_BASIS[x][u];
        }

        horizontal[v * BLOCK_SIZE + x] = roundDivide(sum, FIXED_POINT_SCALE);
      }
    }

    for (let y = 0; y < BLOCK_SIZE; y += 1) {
      for (let x = 0; x < BLOCK_SIZE; x += 1) {
        let sum = 0;

        for (let v = 0; v < BLOCK_SIZE; v += 1) {
          sum += horizontal[v * BLOCK_SIZE + x] * DCT_BASIS[y][v];
        }

        samples[y * BLOCK_SIZE + x] = roundDivide(sum, 4 * FIXED_POINT_SCALE) + 128;
      }
    }

    return samples;
  }

  function extractLumaBlock(luma, blockX, blockY) {
    const block = new Float64Array(64);
    const startX = blockX * BLOCK_SIZE;
    const startY = blockY * BLOCK_SIZE;

    for (let y = 0; y < BLOCK_SIZE; y += 1) {
      for (let x = 0; x < BLOCK_SIZE; x += 1) {
        block[y * BLOCK_SIZE + x] = luma[(startY + y) * MACROBLOCK_SIZE + startX + x];
      }
    }

    return block;
  }

  function sampleChroma(samples, localX, localY) {
    const floorX = localX % 2 === 0 ? Math.floor(localX / 2) - 1 : Math.floor(localX / 2);
    const floorY = localY % 2 === 0 ? Math.floor(localY / 2) - 1 : Math.floor(localY / 2);
    const x0 = clamp(floorX, 0, BLOCK_SIZE - 1);
    const y0 = clamp(floorY, 0, BLOCK_SIZE - 1);
    const x1 = clamp(floorX + 1, 0, BLOCK_SIZE - 1);
    const y1 = clamp(floorY + 1, 0, BLOCK_SIZE - 1);
    const fractionX = localX % 2 === 0 ? 3 : 1;
    const fractionY = localY % 2 === 0 ? 3 : 1;
    const top = (4 - fractionX) * samples[y0 * BLOCK_SIZE + x0] +
      fractionX * samples[y0 * BLOCK_SIZE + x1];
    const bottom = (4 - fractionX) * samples[y1 * BLOCK_SIZE + x0] +
      fractionX * samples[y1 * BLOCK_SIZE + x1];

    return roundDivide((4 - fractionY) * top + fractionY * bottom, 16);
  }

  function scaleQuantizationTable(base, quality) {
    const table = new Uint8Array(64);

    for (let index = 0; index < 64; index += 1) {
      const value = quality < 50
        ? Math.floor((base[index] * 5000 + 50 * quality) / (100 * quality))
        : Math.floor((base[index] * (200 - quality * 2) + 50) / 100);

      table[index] = clamp(value, 1, 255);
    }

    return table;
  }

  function validateSource(sourcePixels, width, height) {
    if (!isByteArray(sourcePixels) || sourcePixels.length < width * height * 4) {
      throw new TypeError("DCT source must contain width*height RGBA pixels");
    }

    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError("DCT dimensions must be positive integers");
    }
  }

  function validateTransformedBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length !== BLOCKS_PER_MACROBLOCK) {
      throw new TypeError("A DCT macroblock must contain six transformed blocks");
    }

    for (const block of blocks) {
      if (!(block instanceof Float64Array) || block.length !== 64) {
        throw new TypeError("Each transformed DCT block must contain 64 coefficients");
      }
    }
  }

  function validateQuantizedBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length !== BLOCKS_PER_MACROBLOCK) {
      throw new TypeError("A DCT macroblock must contain six quantized blocks");
    }

    for (const block of blocks) {
      if (!(block instanceof Int16Array) || block.length !== 64) {
        throw new TypeError("Each quantized DCT block must contain 64 coefficients");
      }
    }
  }

  function validateQuantizationTables(tables) {
    if (
      !tables ||
      !(tables.luma instanceof Uint8Array) ||
      tables.luma.length !== 64 ||
      !(tables.chroma instanceof Uint8Array) ||
      tables.chroma.length !== 64
    ) {
      throw new TypeError("DCT quantization tables must contain 64 luma and 64 chroma values");
    }

    for (const table of [tables.luma, tables.chroma]) {
      for (const value of table) {
        if (value < 1) {
          throw new RangeError("DCT quantization values must be positive");
        }
      }
    }
  }

  function clampInt16(value) {
    return clamp(value, -32768, 32767);
  }

  function clampByte(value) {
    return clamp(value, 0, 255);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function roundDivide(value, divisor) {
    if (value >= 0) {
      return Math.floor((value + divisor / 2) / divisor);
    }

    return -Math.floor((-value + divisor / 2) / divisor);
  }

  function isByteArray(value) {
    return value instanceof Uint8Array || value instanceof Uint8ClampedArray;
  }

  return {
    BLOCK_SIZE,
    MACROBLOCK_SIZE,
    BLOCKS_PER_MACROBLOCK,
    createQuantizationTables,
    transformMacroblock,
    quantizeMacroblock,
    decodeMacroblock,
    calculateMacroblockSquaredError,
  };
});
