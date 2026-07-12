(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CubeWheelZoom = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MIN_SCALE = 0.35;
  const MAX_SCALE = 3;
  const DEFAULT_SCALE = 1;
  const WHEEL_SENSITIVITY = 0.0015;
  const LINE_HEIGHT = 16;
  const PAGE_HEIGHT = 800;

  function getNextScale(currentScale, deltaY, deltaMode) {
    if (!Number.isFinite(currentScale) || currentScale <= 0) {
      throw new RangeError("Cube scale must be positive");
    }

    if (!Number.isFinite(deltaY)) {
      throw new TypeError("Wheel delta must be finite");
    }

    const pixelDelta = deltaY * getDeltaMultiplier(deltaMode);
    const nextScale = currentScale * Math.exp(-pixelDelta * WHEEL_SENSITIVITY);

    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
  }

  function getDeltaMultiplier(deltaMode) {
    if (deltaMode === 1) {
      return LINE_HEIGHT;
    }

    if (deltaMode === 2) {
      return PAGE_HEIGHT;
    }

    return 1;
  }

  return {
    DEFAULT_SCALE,
    MAX_SCALE,
    MIN_SCALE,
    getNextScale,
  };
});
