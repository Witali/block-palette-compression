"use strict";

importScripts("../decoders/gpu-jpeg.js", "./dct-format.js?v=dct-page-19");

self.addEventListener("message", ({ data }) => {
  if (!data || data.type !== "encode") {
    return;
  }

  try {
    const pixels = new Uint8ClampedArray(data.pixels);
    const postProgress = (progress) => {
      self.postMessage({ type: "progress", requestId: data.requestId, ...progress });
    };
    const options = {
      preset: data.preset,
      quality: data.quality,
      dctLibrary: Boolean(data.dctLibrary),
      librarySize: data.librarySize,
      libraryComponents: data.libraryComponents,
      libraryReferenceCoding: data.libraryReferenceCoding,
      libraryFrequencySplit: data.libraryFrequencySplit,
      libraryClusterSamples: data.libraryClusterSamples,
      libraryCandidateCount: data.libraryCandidateCount,
      referencePixels: data.jpegImport ? pixels : undefined,
      onProgress: postProgress,
    };
    let encoded;
    let decoded;
    let quality = data.quality;
    let candidateCount = 0;
    let squaredError;

    if (data.jpegImport) {
      if (!data.jpegBytes) {
        throw new Error("JPEG DCT import requires the original JPEG file");
      }
      if (data.autoQuality) {
        throw new Error("Automatic quality search is unavailable during JPEG DCT import");
      }

      const jpeg = self.GpuJpegDecoder.parse(data.jpegBytes);

      if (jpeg.width !== data.width || jpeg.height !== data.height) {
        throw new Error("JPEG dimensions do not match the source preview");
      }

      encoded = self.DctImageFormat.importJpegDctFile(jpeg, options);
      const cached = self.DctImageFormat.getCachedDctEncodingResult(encoded);
      decoded = cached ? cached.decoded : self.DctImageFormat.decodeDctFile(encoded);
      squaredError = cached ? cached.squaredError : undefined;
    } else if (data.autoQuality) {
      const result = self.DctImageFormat.findBestDctQuality(
        pixels,
        data.width,
        data.height,
        {
          preset: data.preset,
          sampleMcuCount: data.sampleMcuCount,
          dctLibrary: Boolean(data.dctLibrary),
          librarySize: data.librarySize,
          libraryComponents: data.libraryComponents,
          libraryReferenceCoding: data.libraryReferenceCoding,
          libraryFrequencySplit: data.libraryFrequencySplit,
          libraryClusterSamples: data.libraryClusterSamples,
          libraryCandidateCount: data.libraryCandidateCount,
          onProgress: postProgress,
        }
      );

      encoded = result.encoded;
      decoded = result.decoded;
      quality = result.quality;
      candidateCount = result.candidateCount;
      squaredError = result.error;
    } else {
      encoded = self.DctImageFormat.encodeDctFile(
        pixels,
        data.width,
        data.height,
        options
      );
      decoded = self.DctImageFormat.decodeDctFile(encoded);
    }

    if (squaredError === undefined) {
      squaredError = self.DctImageFormat.calculateSquaredError(pixels, decoded.pixels);
    }

    self.postMessage({
      type: "result",
      requestId: data.requestId,
      encoded: encoded.buffer,
      decodedPixels: decoded.pixels.buffer,
      quality,
      candidateCount,
      squaredError,
      importMode: data.jpegImport ? "jpeg-dct" : "rgba",
    }, [encoded.buffer, decoded.pixels.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
