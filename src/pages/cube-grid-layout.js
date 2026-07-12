(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CubeGridLayout = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const GRID_COLUMNS = new Map([
    [1, 1],
    [3, 3],
    [10, 5],
    [30, 6],
    [100, 10],
  ]);
  const WORLD_HEIGHT = 3.6;
  const WORLD_CENTER_Y = 0.25;
  const CELL_FILL = 0.34;

  function getDimensions(count) {
    const columns = GRID_COLUMNS.get(count);

    if (!columns) {
      throw new RangeError(`Unsupported cube count: ${count}`);
    }

    return { columns, rows: count / columns };
  }

  function createInstances(count, aspectRatio, sceneScale) {
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
      throw new RangeError("Cube grid aspect ratio must be positive");
    }

    const zoom = sceneScale === undefined ? 1 : sceneScale;

    if (!Number.isFinite(zoom) || zoom <= 0) {
      throw new RangeError("Cube grid scale must be positive");
    }

    const { columns, rows } = getDimensions(count);
    const worldWidth = WORLD_HEIGHT * aspectRatio;
    const cellWidth = worldWidth / columns;
    const cellHeight = WORLD_HEIGHT / rows;
    const scale = Math.min(1, Math.min(cellWidth, cellHeight) * CELL_FILL);
    const instances = [];

    for (let index = 0; index < count; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = -worldWidth / 2 + (column + 0.5) * cellWidth;
      const y = WORLD_CENTER_Y + WORLD_HEIGHT / 2 - (row + 0.5) * cellHeight;

      instances.push({
        translation: [x * zoom, WORLD_CENTER_Y + (y - WORLD_CENTER_Y) * zoom, 0],
        scale: scale * zoom,
      });
    }

    return instances;
  }

  return {
    COUNTS: Array.from(GRID_COLUMNS.keys()),
    createInstances,
    getDimensions,
  };
});
