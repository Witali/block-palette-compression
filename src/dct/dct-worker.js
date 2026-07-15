"use strict";

importScripts("./dct-format.js");

self.addEventListener("message", ({ data }) => {
  if (!data || data.type !== "encode") {
    return;
  }

  try {
    const pixels = new Uint8ClampedArray(data.pixels);
    const options = { preset: data.preset, quality: data.quality };
    let encoded;
    let decoded;
    let quality = data.quality;
    let candidateCount = 0;

    if (data.autoQuality) {
      const result = self.DctImageFormat.findBestDctQuality(
        pixels,
        data.width,
        data.height,
        {
          preset: data.preset,
          sampleMcuCount: data.sampleMcuCount,
          onProgress(progress) {
            self.postMessage({ type: "progress", requestId: data.requestId, ...progress });
          },
        }
      );

      encoded = result.encoded;
      decoded = result.decoded;
      quality = result.quality;
      candidateCount = result.candidateCount;
    } else {
      encoded = self.DctImageFormat.encodeDctFile(
        pixels,
        data.width,
        data.height,
        options
      );
      decoded = self.DctImageFormat.decodeDctFile(encoded);
    }

    const squaredError = self.DctImageFormat.calculateSquaredError(pixels, decoded.pixels);

    self.postMessage({
      type: "result",
      requestId: data.requestId,
      encoded: encoded.buffer,
      decodedPixels: decoded.pixels.buffer,
      quality,
      candidateCount,
      squaredError,
    }, [encoded.buffer, decoded.pixels.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
