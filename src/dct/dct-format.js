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
  const MCU_WIDTH = 16;
  const MCU_HEIGHT = 16;
  const CHROMA_WIDTH = 8;
  const SCALE_MULTIPLIERS = Object.freeze([1, 2, 4, 8]);
  const PROFILE_NAMES = Object.freeze(["low frequency", "horizontal", "vertical", "diagonal"]);
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

  function freezePreset(modeCode, bpp, bytesPerMcu, yBytes, cbBytes, crBytes) {
    return Object.freeze({ modeCode, bpp, bytesPerMcu, yBytes, cbBytes, crBytes });
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
    const output = new Uint8Array(layout.totalBytes);
    const view = new DataView(output.buffer);

    output.set(MAGIC, 0);
    writeUint32(view, 8, VERSION);
    writeUint32(view, 12, layout.modeCode);
    writeUint32(view, 16, width);
    writeUint32(view, 20, height);
    writeUint32(view, 24, layout.mcuColumns);
    writeUint32(view, 28, layout.mcuRows);
    writeUint32(view, 32, layout.bytesPerMcu);
    writeUint32(view, 36, layout.yBytes);
    writeUint32(view, 40, layout.cbBytes);
    writeUint32(view, 44, layout.crBytes);
    writeUint32(view, 48, quality);
    writeUint32(view, 52, options.autoQuality ? 1 : 0);
    writeUint32(view, 56, layout.payloadBytes);
    writeUint32(view, 60, options.searchCandidateCount || 0);

    for (let mcuIndex = 0; mcuIndex < layout.mcuCount; mcuIndex += 1) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const planes = extractMcuPlanes(pixels, width, height, mcuX, mcuY);
      const byteOffset = HEADER_BYTES + mcuIndex * layout.bytesPerMcu;

      encodeComponent(output, byteOffset, layout.yBytes, planes.y, 16, 16, quality, false);
      encodeComponent(
        output,
        byteOffset + layout.yBytes,
        layout.cbBytes,
        planes.cb,
        8,
        16,
        quality,
        true
      );
      encodeComponent(
        output,
        byteOffset + layout.yBytes + layout.cbBytes,
        layout.crBytes,
        planes.cr,
        8,
        16,
        quality,
        true
      );
    }

    return output;
  }

  function decodeDctFile(input) {
    const bytes = asUint8Array(input);
    const info = inspectDctFile(bytes);
    const pixels = new Uint8ClampedArray(info.width * info.height * 4);

    for (let mcuIndex = 0; mcuIndex < info.mcuCount; mcuIndex += 1) {
      const mcuX = mcuIndex % info.mcuColumns;
      const mcuY = Math.floor(mcuIndex / info.mcuColumns);
      const components = decodeMcuComponents(bytes, info, mcuIndex);
      const yPlane = inverseDct(components.y.coefficients, 16, 16);
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
    const components = decodeMcuComponents(bytes, info, mcuIndex);
    const luma = sampleInverseDct(components.y.coefficients, 16, 16, localX, localY) + 128;
    const chromaX = Math.floor(localX / 2);
    const cb = sampleInverseDct(components.cb.coefficients, 8, 16, chromaX, localY) + 128;
    const cr = sampleInverseDct(components.cr.coefficients, 8, 16, chromaX, localY) + 128;

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
    const payloadBytes = readUint32(view, 56);

    if (
      readUint32(view, 24) !== layout.mcuColumns ||
      readUint32(view, 28) !== layout.mcuRows ||
      readUint32(view, 32) !== layout.bytesPerMcu ||
      readUint32(view, 36) !== layout.yBytes ||
      readUint32(view, 40) !== layout.cbBytes ||
      readUint32(view, 44) !== layout.crBytes ||
      payloadBytes !== layout.payloadBytes ||
      bytes.length !== HEADER_BYTES + payloadBytes ||
      quality < 1 || quality > 100 ||
      (flags & ~1) !== 0
    ) {
      throw new RangeError("Invalid DCTBS2 layout");
    }

    return {
      version,
      quality,
      autoQuality: (flags & 1) !== 0,
      searchCandidateCount: readUint32(view, 60),
      ...layout,
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
      components: Object.fromEntries(Object.entries(components).map(([name, component]) => [name, {
        profile: component.profile,
        profileName: PROFILE_NAMES[component.profile],
        scaleIndex: component.scaleIndex,
        scale: SCALE_MULTIPLIERS[component.scaleIndex],
        coefficientCount: component.coefficientCount,
      }])),
    };
  }

  function findBestDctQuality(pixels, width, height, options = {}) {
    validatePixels(pixels, width, height);
    const preset = getDctPreset(options.preset);
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
      sampleResults.push({ quality, error: measureSampleError(pixels, width, height, layout, quality, sampleIndices) });
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
        sampleResults.push({ quality, error: measureSampleError(pixels, width, height, layout, quality, sampleIndices) });
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

  function encodeComponent(output, offset, byteCount, samples, width, height, quality, chroma) {
    const coefficients = forwardDct(samples, width, height);
    const candidate = chooseComponentEncoding(coefficients, width, height, byteCount, quality, chroma);
    const writer = new BitWriter(output, offset, byteCount);

    writer.write((candidate.profile << 4) | candidate.scaleIndex, 8);
    writer.writeSigned(candidate.dc, 10);

    for (const value of candidate.ac) {
      writer.writeSigned(value, 6);
    }
  }

  function chooseComponentEncoding(coefficients, width, height, byteCount, quality, chroma) {
    const acCount = Math.floor((byteCount * 8 - 18) / 6);
    let best = null;

    for (let profile = 0; profile < PROFILE_NAMES.length; profile += 1) {
      const scan = getScan(profile, width, height).slice(0, acCount);

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

  function decodeComponent(bytes, offset, byteCount, width, height, quality, chroma) {
    const reader = new BitReader(bytes, offset, byteCount);
    const header = reader.read(8);
    const profile = header >> 4;
    const scaleIndex = header & 15;

    if (profile >= PROFILE_NAMES.length || scaleIndex >= SCALE_MULTIPLIERS.length) {
      throw new RangeError("Invalid DCT component profile");
    }

    const coefficients = new Float64Array(width * height);
    const scale = SCALE_MULTIPLIERS[scaleIndex];
    const dc = reader.readSigned(10);
    const acCount = Math.floor((byteCount * 8 - 18) / 6);
    const scan = getScan(profile, width, height).slice(0, acCount);

    coefficients[0] = dc * quantizationStep(0, 0, width, height, quality, chroma) * scale;

    for (const position of scan) {
      const u = position % width;
      const v = Math.floor(position / width);
      coefficients[position] = reader.readSigned(6) *
        quantizationStep(u, v, width, height, quality, chroma) * scale;
    }

    return { coefficients, profile, scaleIndex, coefficientCount: acCount + 1 };
  }

  function decodeMcuComponents(bytes, info, mcuIndex) {
    const offset = HEADER_BYTES + mcuIndex * info.bytesPerMcu;

    return {
      y: decodeComponent(bytes, offset, info.yBytes, 16, 16, info.quality, false),
      cb: decodeComponent(bytes, offset + info.yBytes, info.cbBytes, 8, 16, info.quality, true),
      cr: decodeComponent(
        bytes,
        offset + info.yBytes + info.cbBytes,
        info.crBytes,
        8,
        16,
        info.quality,
        true
      ),
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

  function measureSampleError(pixels, width, height, layout, quality, mcuIndices) {
    let squaredError = 0;

    for (const mcuIndex of mcuIndices) {
      const mcuX = mcuIndex % layout.mcuColumns;
      const mcuY = Math.floor(mcuIndex / layout.mcuColumns);
      const planes = extractMcuPlanes(pixels, width, height, mcuX, mcuY);
      const record = new Uint8Array(layout.bytesPerMcu);

      encodeComponent(record, 0, layout.yBytes, planes.y, 16, 16, quality, false);
      encodeComponent(record, layout.yBytes, layout.cbBytes, planes.cb, 8, 16, quality, true);
      encodeComponent(record, layout.yBytes + layout.cbBytes, layout.crBytes, planes.cr, 8, 16, quality, true);

      const yComponent = decodeComponent(record, 0, layout.yBytes, 16, 16, quality, false);
      const cbComponent = decodeComponent(record, layout.yBytes, layout.cbBytes, 8, 16, quality, true);
      const crComponent = decodeComponent(
        record,
        layout.yBytes + layout.cbBytes,
        layout.crBytes,
        8,
        16,
        quality,
        true
      );
      const yPlane = inverseDct(yComponent.coefficients, 16, 16);
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
    getDctPreset,
    getDctFileLayout,
    encodeDctFile,
    decodeDctFile,
    sampleDctFilePixel,
    inspectDctFile,
    inspectDctMcu,
    findBestDctQuality,
    calculateSquaredError,
  });
});
