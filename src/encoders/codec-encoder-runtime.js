(function (root, factory) {
  "use strict";

  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CodecEncoderRuntime = api;
})(typeof self !== "undefined" ? self : globalThis, function (root) {
  "use strict";

  const WORKERS = Object.freeze({
    bpal: Object.freeze({ url: "./src/palette/block-palette-worker.js?v=palette-256-1", type: "classic" }),
    dct: Object.freeze({ url: "./src/dct/dct-worker.js?v=dct-page-20", type: "classic" }),
    bpdh: Object.freeze({ url: "./src/hybrid/bpdh-worker.js?v=hybrid-2", type: "classic" }),
    astc: Object.freeze({ url: "./src/texture/astc-texture-codec-worker.mjs?v=1", type: "module" }),
    bc1: Object.freeze({ url: "./src/texture/standard-texture-codec-worker.js?v=1", type: "classic" }),
    bc7: Object.freeze({ url: "./src/texture/standard-texture-codec-worker.js?v=1", type: "classic" }),
  });

  function getWorkerUrl(format) {
    const definition = WORKERS[format];

    if (!definition) {
      throw new RangeError(`Unsupported JS codec encoder: ${format}`);
    }

    return definition.url;
  }

  function getWorkerType(format) {
    const definition = WORKERS[format];
    if (!definition) throw new RangeError(`Unsupported JS codec encoder: ${format}`);
    return definition.type;
  }

  function createWorker(format) {
    if (typeof root.Worker !== "function") {
      throw new Error("Web Workers are unavailable in this JavaScript runtime");
    }

    const definition = WORKERS[format];
    if (!definition) throw new RangeError(`Unsupported JS codec encoder: ${format}`);
    return definition.type === "module"
      ? new root.Worker(definition.url, { type: "module" })
      : new root.Worker(definition.url);
  }

  return Object.freeze({
    formats: Object.freeze(Object.keys(WORKERS)),
    getWorkerUrl,
    getWorkerType,
    createWorker,
  });
});
