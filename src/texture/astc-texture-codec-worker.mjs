import createASTCModule from "../../vendor/astc-encoder-wasm/astcenc.mjs";
import "./standard-texture-codecs.js";

let modulePromise;

self.addEventListener("message", (event) => {
  encodeAstc(event.data || {}).catch((error) => {
    self.postMessage({
      type: "error",
      requestId: event.data?.requestId,
      error: error && error.message ? error.message : String(error),
    });
  });
});

async function encodeAstc(message) {
  const requestId = message.requestId;
  const source = new Uint8ClampedArray(message.pixels);
  self.postMessage({ type: "progress", requestId, stage: "loading-astc", completed: 0, total: 2 });
  modulePromise ||= createASTCModule();
  const module = await modulePromise;
  self.postMessage({ type: "progress", requestId, stage: "encoding-blocks", completed: 1, total: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const startedAt = performance.now();
  const profile = message.options?.profile || "6x6";
  const quality = message.options?.quality || "medium";
  const compressed = module.compressImage(source, message.width, message.height, profile, quality);
  if (!compressed.success) throw new Error(compressed.error || "ASTC compression failed");
  const restored = module.decompressImage(compressed.data, message.width, message.height, profile);
  if (!restored.success) throw new Error(restored.error || "ASTC decompression failed");

  const payload = new Uint8Array(compressed.data);
  const decoded = new Uint8ClampedArray(restored.data);
  const encoded = self.StandardTextureCodecs.createAstcFile(payload, message.width, message.height, profile);
  const squaredError = self.StandardTextureCodecs.computeRgbSquaredError(source, decoded);
  const [blockWidth, blockHeight] = profile.split("x").map(Number);
  self.postMessage({
    type: "complete",
    requestId,
    encoded: encoded.buffer,
    decoded: decoded.buffer,
    squaredError,
    durationMs: performance.now() - startedAt,
    info: {
      format: "ASTC",
      profile,
      quality,
      width: message.width,
      height: message.height,
      blocksX: Math.ceil(message.width / blockWidth),
      blocksY: Math.ceil(message.height / blockHeight),
      blockWidth,
      blockHeight,
      blockBytes: 16,
      headerBytes: 16,
      payloadBytes: payload.byteLength,
      encoder: module.getVersion(),
    },
  }, [encoded.buffer, decoded.buffer]);
}
