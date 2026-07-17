"use strict";

importScripts("./standard-texture-codecs.js?v=1");

self.addEventListener("message", (event) => {
  const message = event.data || {};
  const requestId = message.requestId;

  try {
    self.postMessage({ type: "progress", requestId, stage: "encoding-blocks", completed: 0, total: 1 });
    const source = new Uint8ClampedArray(message.pixels);
    const startedAt = performance.now();
    const format = String(message.format || "").toLowerCase();
    const result = format === "bc1"
      ? self.StandardTextureCodecs.encodeBc1Image(source, message.width, message.height, message.options)
      : format === "bc7"
        ? self.StandardTextureCodecs.encodeBc7Image(source, message.width, message.height, message.options)
        : null;
    if (!result) throw new RangeError(`Unsupported standard texture codec: ${format}`);

    const encoded = self.StandardTextureCodecs.createDdsFile(format, result.payload, message.width, message.height);
    const squaredError = self.StandardTextureCodecs.computeRgbSquaredError(source, result.decoded);
    self.postMessage({
      type: "complete",
      requestId,
      encoded: encoded.buffer,
      decoded: result.decoded.buffer,
      squaredError,
      durationMs: performance.now() - startedAt,
      info: {
        format: format.toUpperCase(),
        quality: result.quality,
        width: message.width,
        height: message.height,
        blocksX: result.blocksX,
        blocksY: result.blocksY,
        blockWidth: result.blockWidth,
        blockHeight: result.blockHeight,
        blockBytes: result.blockBytes,
        headerBytes: format === "bc7" ? 148 : 128,
        payloadBytes: result.payload.byteLength,
        mode: result.mode,
      },
    }, [encoded.buffer, result.decoded.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", requestId, error: error && error.message ? error.message : String(error) });
  }
});
