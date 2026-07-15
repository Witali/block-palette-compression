/*
 * Purpose: Prepare BPDH records for coordinate-based fragment-shader sampling.
 * Processing blocks:
 * - Parse-only BPDH input supplies palette indices and quantized DCT blocks without RGBA pixels.
 * - DCT blocks are cached as block-local Y/Cb/Cr samples, keeping adjacent shader reads contiguous.
 * - The fragment shader performs palette lookup or YCbCr conversion for the requested coordinate.
 */
(function (root, factory) {
  "use strict";

  const dct420 = typeof module === "object" && module.exports
    ? require("../hybrid/dct420.js")
    : root.Dct420;
  const api = factory(dct420);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BpdhTextureDecoder = api;
})(typeof self !== "undefined" ? self : globalThis, function (dct420) {
  "use strict";

  const CODING_UNIT_SIZE = 16;
  const DCT_SAMPLE_COUNT = 6 * 64;
  const BLOCK_MAP_BYTES = 4;
  const MODE_BPAL = 0;
  const MODE_DCT = 1;

  function createShaderTextureData(image, maxTextureSize) {
    validateImage(image);

    const textureLimit = Math.floor(Number(maxTextureSize));

    if (!Number.isInteger(textureLimit) || textureLimit < 1) {
      throw new RangeError("BPDH shader atlas requires a positive texture-size limit");
    }

    const bpalRecordStride = 1 + image.localColorCount * 2 +
      CODING_UNIT_SIZE * CODING_UNIT_SIZE;
    const paletteBytes = image.palette.length * 3;
    const blockMapOffset = paletteBytes;
    const blockMapBytes = image.blockCount * BLOCK_MAP_BYTES;
    const bpalRecordsOffset = blockMapOffset + blockMapBytes;
    const bpalRecordsBytes = image.bpalBlockCount * bpalRecordStride;
    const dctRecordsOffset = bpalRecordsOffset + bpalRecordsBytes;
    const totalBytes = dctRecordsOffset + image.dctBlockCount * DCT_SAMPLE_COUNT;
    const bytes = new Uint8Array(totalBytes);

    writePalette(bytes, image.palette);

    let bpalRecordIndex = 0;
    let dctRecordIndex = 0;

    for (let blockIndex = 0; blockIndex < image.blockCount; blockIndex += 1) {
      const mapOffset = blockMapOffset + blockIndex * BLOCK_MAP_BYTES;

      if (image.modes[blockIndex] === MODE_DCT) {
        writeBlockMap(bytes, mapOffset, MODE_DCT, dctRecordIndex);
        writeDctRecord(
          bytes,
          dctRecordsOffset + dctRecordIndex * DCT_SAMPLE_COUNT,
          image.dctBlocks[blockIndex],
          image.quantizationTables,
        );
        dctRecordIndex += 1;
      } else {
        writeBlockMap(bytes, mapOffset, MODE_BPAL, bpalRecordIndex);
        writeBpalRecord(
          bytes,
          bpalRecordsOffset + bpalRecordIndex * bpalRecordStride,
          image,
          blockIndex,
        );
        bpalRecordIndex += 1;
      }
    }

    const dataAtlas = createByteAtlas(bytes, textureLimit);

    return {
      width: image.width,
      height: image.height,
      codingUnitSize: CODING_UNIT_SIZE,
      blocksX: image.blocksX,
      localColorCount: image.localColorCount,
      globalColorCount: image.globalColorCount,
      blockMapOffset,
      bpalRecordsOffset,
      bpalRecordStride,
      dctRecordsOffset,
      dctRecordStride: DCT_SAMPLE_COUNT,
      dataAtlas,
      gpuBytes: dataAtlas.data.byteLength,
    };
  }

  function sampleShaderTexturePixel(texture, x, y) {
    if (!texture || !Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || y < 0 || x >= texture.width || y >= texture.height) {
      throw new RangeError("BPDH shader sample coordinates are outside the image");
    }

    const localX = x % CODING_UNIT_SIZE;
    const localY = y % CODING_UNIT_SIZE;
    const blockIndex = Math.floor(y / CODING_UNIT_SIZE) * texture.blocksX +
      Math.floor(x / CODING_UNIT_SIZE);
    const mapOffset = texture.blockMapOffset + blockIndex * BLOCK_MAP_BYTES;
    const mode = readByte(texture, mapOffset);
    const recordIndex = readUint24(texture, mapOffset + 1);

    if (mode === MODE_BPAL) {
      const recordBase = texture.bpalRecordsOffset + recordIndex * texture.bpalRecordStride;
      const paletteSelector = readByte(texture, recordBase);
      const pixelOffset = recordBase + 1 + texture.localColorCount * 2;
      const localIndex = readByte(texture, pixelOffset + localY * CODING_UNIT_SIZE + localX);
      const globalIndex = readUint16(texture, recordBase + 1 + localIndex * 2);
      const colorOffset = (paletteSelector * texture.globalColorCount + globalIndex) * 3;

      return {
        r: readByte(texture, colorOffset),
        g: readByte(texture, colorOffset + 1),
        b: readByte(texture, colorOffset + 2),
        a: 255,
      };
    }

    const recordBase = texture.dctRecordsOffset + recordIndex * texture.dctRecordStride;
    const lumaComponent = Math.floor(localY / 8) * 2 + Math.floor(localX / 8);
    const luma = readDctSample(texture, recordBase, lumaComponent, localX % 8, localY % 8);
    const chromaBlue = sampleChroma(texture, recordBase, 4, localX, localY) - 128;
    const chromaRed = sampleChroma(texture, recordBase, 5, localX, localY) - 128;

    return {
      r: clampByte(luma + roundDivide(91881 * chromaRed, 65536)),
      g: clampByte(luma + roundDivide(-22554 * chromaBlue - 46802 * chromaRed, 65536)),
      b: clampByte(luma + roundDivide(116130 * chromaBlue, 65536)),
      a: 255,
    };
  }

  function writePalette(target, palette) {
    palette.forEach((color, index) => {
      const offset = index * 3;

      target[offset] = color.r;
      target[offset + 1] = color.g;
      target[offset + 2] = color.b;
    });
  }

  function writeBlockMap(target, offset, mode, recordIndex) {
    if (!Number.isInteger(recordIndex) || recordIndex < 0 || recordIndex > 0xffffff) {
      throw new RangeError("BPDH shader record index exceeds 24 bits");
    }

    target[offset] = mode;
    target[offset + 1] = recordIndex & 0xff;
    target[offset + 2] = recordIndex >>> 8 & 0xff;
    target[offset + 3] = recordIndex >>> 16 & 0xff;
  }

  function writeBpalRecord(target, offset, image, blockIndex) {
    target[offset] = image.blockPaletteSelectors[blockIndex];

    const paletteOffset = blockIndex * image.localColorCount;

    for (let index = 0; index < image.localColorCount; index += 1) {
      writeUint16(target, offset + 1 + index * 2, image.blockPaletteIndices[paletteOffset + index]);
    }

    const pixelOffset = offset + 1 + image.localColorCount * 2;
    const blockX = blockIndex % image.blocksX;
    const blockY = Math.floor(blockIndex / image.blocksX);

    for (let localY = 0; localY < CODING_UNIT_SIZE; localY += 1) {
      const y = blockY * CODING_UNIT_SIZE + localY;

      if (y >= image.height) {
        break;
      }

      for (let localX = 0; localX < CODING_UNIT_SIZE; localX += 1) {
        const x = blockX * CODING_UNIT_SIZE + localX;

        if (x < image.width) {
          target[pixelOffset + localY * CODING_UNIT_SIZE + localX] =
            image.pixelIndices[y * image.width + x];
        }
      }
    }
  }

  function writeDctRecord(target, offset, quantizedBlocks, quantizationTables) {
    const components = dct420.decodeMacroblockComponents(quantizedBlocks, quantizationTables);

    components.forEach((component, blockIndex) => {
      const componentOffset = offset + blockIndex * 64;

      for (let index = 0; index < 64; index += 1) {
        target[componentOffset + index] = component[index];
      }
    });
  }

  function writeUint16(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = value >>> 8 & 0xff;
  }

  function readByte(texture, offset) {
    return texture.dataAtlas.data[offset];
  }

  function readUint16(texture, offset) {
    return readByte(texture, offset) + readByte(texture, offset + 1) * 256;
  }

  function readUint24(texture, offset) {
    return readUint16(texture, offset) + readByte(texture, offset + 2) * 65536;
  }

  function readDctSample(texture, recordBase, component, x, y) {
    return readByte(texture, recordBase + component * 64 + y * 8 + x);
  }

  function sampleChroma(texture, recordBase, component, localX, localY) {
    const floorX = localX % 2 === 0 ? Math.floor(localX / 2) - 1 : Math.floor(localX / 2);
    const floorY = localY % 2 === 0 ? Math.floor(localY / 2) - 1 : Math.floor(localY / 2);
    const x0 = clamp(floorX, 0, 7);
    const y0 = clamp(floorY, 0, 7);
    const x1 = clamp(floorX + 1, 0, 7);
    const y1 = clamp(floorY + 1, 0, 7);
    const fractionX = localX % 2 === 0 ? 3 : 1;
    const fractionY = localY % 2 === 0 ? 3 : 1;
    const top = (4 - fractionX) * readDctSample(texture, recordBase, component, x0, y0) +
      fractionX * readDctSample(texture, recordBase, component, x1, y0);
    const bottom = (4 - fractionX) * readDctSample(texture, recordBase, component, x0, y1) +
      fractionX * readDctSample(texture, recordBase, component, x1, y1);

    return roundDivide((4 - fractionY) * top + fractionY * bottom, 16);
  }

  function roundDivide(value, divisor) {
    return value >= 0
      ? Math.floor((value + divisor / 2) / divisor)
      : -Math.floor((-value + divisor / 2) / divisor);
  }

  function clampByte(value) {
    return clamp(value, 0, 255);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function createByteAtlas(bytes, maxTextureSize) {
    const texelCount = Math.ceil(bytes.length / 4);
    const width = Math.min(maxTextureSize, texelCount);
    const height = Math.ceil(texelCount / width);

    if (height > maxTextureSize) {
      throw new RangeError("BPDH shader data exceeds the WebGL texture size limit");
    }

    const data = new Uint8Array(width * height * 4);

    data.set(bytes);
    return { width, height, channels: 4, data };
  }

  function validateImage(image) {
    if (
      !image ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      !(image.modes instanceof Uint8Array) ||
      !Array.isArray(image.palette) ||
      !Array.isArray(image.dctBlocks) ||
      image.pixels !== null
    ) {
      throw new TypeError("Parsed BPDH image is invalid for shader upload");
    }
  }

  return {
    createShaderTextureData,
    sampleShaderTexturePixel,
  };
});
