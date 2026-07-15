/*
 * Purpose: Prepare a baseline DCTBS2 texture for WebGL2 rendering.
 * Fast mode stores one 512-byte Y/Cb/Cr sample record per MCU; low-memory mode
 * keeps the compressed file bytes for direct fragment-shader IDCT.
 */
(function (root, factory) {
  "use strict";

  const api = factory(
    typeof module === "object" && module.exports
      ? require("../dct/dct-format.js")
      : root.DctImageFormat
  );

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.Dctbs2TextureDecoder = api;
})(typeof self !== "undefined" ? self : globalThis, function (DctImageFormat) {
  "use strict";

  const SUPPORTED_PRESET = "1.5";
  const SUPPORTED_CODING = "grouped-5-front";
  const DECODE_MODE_FAST = "fast";
  const DECODE_MODE_LOW_MEMORY = "low-memory";
  const FORMAT_DIRECT = "dctbs2-rgba8ui";
  const FORMAT_COMPONENT_CACHE = "dctbs2-component-cache-rgba8ui";

  function createShaderTextureData(input, maximumTextureSize, options = {}) {
    if (!DctImageFormat || typeof DctImageFormat.inspectDctFile !== "function") {
      throw new Error("DCTBS2 format decoder is unavailable");
    }

    const bytes = asUint8Array(input);
    const decodeMode = normalizeDecodeMode(options);
    const info = DctImageFormat.inspectDctFile(bytes);
    const maximumSize = Number(maximumTextureSize);

    if (
      info.key !== SUPPORTED_PRESET ||
      info.splitLuma8x8 ||
      info.libraryEnabled ||
      info.coefficientCodingKey !== SUPPORTED_CODING
    ) {
      throw new RangeError(
        "Demo Cube supports baseline DCTBS2 1.5 bpp with grouped-5-front coefficients"
      );
    }

    if (!Number.isInteger(maximumSize) || maximumSize < 1) {
      throw new RangeError("Maximum WebGL texture size must be a positive integer");
    }

    const componentCache = decodeMode === DECODE_MODE_FAST
      ? decodeComponentSamples(bytes).componentCache
      : null;
    const dataAtlas = componentCache
      ? createComponentCacheAtlas(componentCache, info.mcuCount, maximumSize)
      : createByteAtlas(bytes, maximumSize);

    return {
      format: componentCache ? FORMAT_COMPONENT_CACHE : FORMAT_DIRECT,
      decodeMode,
      version: info.version,
      preset: info.key,
      width: info.width,
      height: info.height,
      mcuColumns: info.mcuColumns,
      quality: info.quality,
      bitsPerPixel: info.totalBpp,
      sourceBytes: bytes.length,
      gpuBytes: dataAtlas.data.byteLength,
      componentBytesPerMcu: componentCache ? componentCache.bytesPerMcu : 0,
      componentYOffset: componentCache ? componentCache.yOffset : 0,
      componentCbOffset: componentCache ? componentCache.cbOffset : 0,
      componentCrOffset: componentCache ? componentCache.crOffset : 0,
      dataAtlas,
    };
  }

  function decodeComponentSamples(bytes) {
    if (typeof DctImageFormat.decodeDctComponentSamples !== "function") {
      throw new Error("DCTBS2 component-cache decoder is unavailable");
    }

    return DctImageFormat.decodeDctComponentSamples(bytes);
  }

  function normalizeDecodeMode(options) {
    const value = typeof options === "string"
      ? options
      : options && options.decodeMode;
    const mode = value === undefined ? DECODE_MODE_LOW_MEMORY : String(value);

    if (mode !== DECODE_MODE_FAST && mode !== DECODE_MODE_LOW_MEMORY) {
      throw new RangeError(`Unsupported DCTBS2 shader decode mode: ${value}`);
    }

    return mode;
  }

  function createByteAtlas(bytes, maximumSize) {
    const texelCount = Math.ceil(bytes.length / 4);
    const width = Math.min(maximumSize, Math.ceil(Math.sqrt(texelCount)));
    const height = Math.ceil(texelCount / width);

    if (height > maximumSize) {
      throw new RangeError("DCTBS2 data exceeds the WebGL2 texture size limit");
    }

    const data = new Uint8Array(width * height * 4);
    data.set(bytes);
    return { width, height, channels: 4, data };
  }

  function createComponentCacheAtlas(componentCache, mcuCount, maximumSize) {
    const recordTexels = componentCache.bytesPerMcu / 4;
    const maximumMcusPerRow = Math.floor(maximumSize / recordTexels);

    if (!Number.isInteger(recordTexels) || recordTexels < 1 || maximumMcusPerRow < 1) {
      throw new RangeError("DCTBS2 component records exceed the WebGL2 texture width limit");
    }

    let bestLayout = null;

    for (let mcusPerRow = 1; mcusPerRow <= maximumMcusPerRow; mcusPerRow += 1) {
      const width = mcusPerRow * recordTexels;
      const height = Math.ceil(mcuCount / mcusPerRow);

      if (height > maximumSize) {
        continue;
      }

      const layout = {
        mcusPerRow,
        width,
        height,
        aspectDifference: Math.abs(width - height),
        paddedMcus: mcusPerRow * height - mcuCount,
      };

      if (!bestLayout ||
          layout.aspectDifference < bestLayout.aspectDifference ||
          layout.aspectDifference === bestLayout.aspectDifference &&
            layout.paddedMcus < bestLayout.paddedMcus) {
        bestLayout = layout;
      }
    }

    if (!bestLayout) {
      throw new RangeError("DCTBS2 component cache exceeds the WebGL2 texture size limit");
    }

    const data = new Uint8Array(bestLayout.width * bestLayout.height * 4);
    data.set(componentCache.samples);
    return {
      width: bestLayout.width,
      height: bestLayout.height,
      channels: 4,
      mcusPerRow: bestLayout.mcusPerRow,
      recordTexels,
      data,
    };
  }

  function sampleShaderTexturePixel(texture, x, y) {
    validateSampleCoordinate(texture, x, y);

    if (texture.decodeMode === DECODE_MODE_LOW_MEMORY) {
      return DctImageFormat.sampleDctFilePixel(
        texture.dataAtlas.data.subarray(0, texture.sourceBytes),
        x,
        y
      );
    }

    const localX = x & 15;
    const localY = y & 15;
    const mcuIndex = Math.floor(y / 16) * texture.mcuColumns + Math.floor(x / 16);
    const recordOffset = mcuIndex * texture.componentBytesPerMcu;
    const luma = readAtlasByte(
      texture,
      recordOffset + texture.componentYOffset + localY * 16 + localX
    );
    const chromaIndex = localY * 8 + Math.floor(localX / 2);
    const cb = readAtlasByte(texture, recordOffset + texture.componentCbOffset + chromaIndex);
    const cr = readAtlasByte(texture, recordOffset + texture.componentCrOffset + chromaIndex);

    return yCbCrToRgba(luma, cb, cr);
  }

  function validateSampleCoordinate(texture, x, y) {
    if (!texture || !Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || y < 0 || x >= texture.width || y >= texture.height) {
      throw new RangeError("DCTBS2 shader sample coordinates are outside the image");
    }
  }

  function readAtlasByte(texture, offset) {
    return texture.dataAtlas.data[offset];
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

  function clampByte(value) {
    const rounded = value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
    return Math.max(0, Math.min(255, rounded));
  }

  function asUint8Array(input) {
    if (input instanceof Uint8Array) {
      return input;
    }
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    throw new TypeError("DCTBS2 input must be an ArrayBuffer or typed array");
  }

  return Object.freeze({
    SUPPORTED_PRESET,
    SUPPORTED_CODING,
    DECODE_MODE_FAST,
    DECODE_MODE_LOW_MEMORY,
    FORMAT_DIRECT,
    FORMAT_COMPONENT_CACHE,
    createShaderTextureData,
    sampleShaderTexturePixel,
  });
});
