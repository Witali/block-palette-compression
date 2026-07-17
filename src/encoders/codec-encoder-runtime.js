(function (root, factory) {
  "use strict";

  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CodecEncoderRuntime = api;
})(typeof self !== "undefined" ? self : globalThis, function (root) {
  "use strict";

  const WORKER_URLS = Object.freeze({
    bpal: "./src/palette/block-palette-worker.js?v=shared-encoder-runtime-1",
    dct: "./src/dct/dct-worker.js?v=dct-page-19",
    bpdh: "./src/hybrid/bpdh-worker.js?v=hybrid-2",
  });

  function getWorkerUrl(format) {
    const url = WORKER_URLS[format];

    if (!url) {
      throw new RangeError(`Unsupported JS codec encoder: ${format}`);
    }

    return url;
  }

  function createWorker(format) {
    if (typeof root.Worker !== "function") {
      throw new Error("Web Workers are unavailable in this JavaScript runtime");
    }

    return new root.Worker(getWorkerUrl(format));
  }

  return Object.freeze({
    formats: Object.freeze(Object.keys(WORKER_URLS)),
    getWorkerUrl,
    createWorker,
  });
});
