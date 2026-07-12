"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CubeWheelZoom = require("../src/pages/cube-wheel-zoom.js");

const root = path.resolve(__dirname, "..");

test("zooms cube scenes in and out with the mouse wheel", () => {
  const zoomedIn = CubeWheelZoom.getNextScale(1, -100, 0);
  const zoomedOut = CubeWheelZoom.getNextScale(1, 100, 0);

  assert.ok(zoomedIn > 1);
  assert.ok(zoomedOut < 1);
});

test("limits cube wheel zoom to the supported range", () => {
  assert.equal(CubeWheelZoom.MIN_SCALE, 0.175);
  assert.equal(CubeWheelZoom.getNextScale(1, -100000, 0), CubeWheelZoom.MAX_SCALE);
  assert.equal(CubeWheelZoom.getNextScale(1, 100000, 0), CubeWheelZoom.MIN_SCALE);
});

test("handles wheel deltas expressed as lines and pages", () => {
  assert.equal(
    CubeWheelZoom.getNextScale(1, -1, 1),
    CubeWheelZoom.getNextScale(1, -16, 0)
  );
  assert.equal(
    CubeWheelZoom.getNextScale(1, -1, 2),
    CubeWheelZoom.getNextScale(1, -800, 0)
  );
});

test("loads wheel zoom controls on both cube pages", () => {
  const cubeHtml = fs.readFileSync(path.join(root, "cube.html"), "utf8");
  const samplerHtml = fs.readFileSync(path.join(root, "cube-bpal-sampler.html"), "utf8");
  const cubeSource = fs.readFileSync(path.join(root, "src", "pages", "cube-page.js"), "utf8");
  const samplerSource = fs.readFileSync(
    path.join(root, "src", "pages", "cube-bpal-sampler-page.js"),
    "utf8"
  );

  assert.match(cubeHtml, /src="\.\/src\/pages\/cube-wheel-zoom\.js\?v=2"/);
  assert.match(samplerHtml, /src="\.\/src\/pages\/cube-wheel-zoom\.js\?v=2"/);
  assert.match(cubeSource, /addEventListener\("wheel", zoomCubes, \{ passive: false \}\)/);
  assert.match(samplerSource, /addEventListener\("wheel", zoomCube, \{ passive: false \}\)/);
});

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
