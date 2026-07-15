/*
 * Purpose: Validate a baseline DCTBS2 texture and pack its file bytes into an
 * RGBA8UI atlas for direct random-access sampling in a WebGL2 fragment shader.
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

  function createShaderTextureData(input, maximumTextureSize) {
    if (!DctImageFormat || typeof DctImageFormat.inspectDctFile !== "function") {
      throw new Error("DCTBS2 format decoder is unavailable");
    }

    const bytes = asUint8Array(input);
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

    const texelCount = Math.ceil(bytes.length / 4);
    const atlasWidth = Math.min(maximumSize, Math.ceil(Math.sqrt(texelCount)));
    const atlasHeight = Math.ceil(texelCount / atlasWidth);

    if (atlasHeight > maximumSize) {
      throw new RangeError("DCTBS2 file exceeds the WebGL2 texture size limit");
    }

    const data = new Uint8Array(atlasWidth * atlasHeight * 4);
    data.set(bytes);

    return {
      format: "dctbs2-rgba8ui",
      version: info.version,
      preset: info.key,
      width: info.width,
      height: info.height,
      mcuColumns: info.mcuColumns,
      quality: info.quality,
      bitsPerPixel: info.totalBpp,
      sourceBytes: bytes.length,
      gpuBytes: data.byteLength,
      dataAtlas: {
        width: atlasWidth,
        height: atlasHeight,
        data,
      },
    };
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
    createShaderTextureData,
  });
});
