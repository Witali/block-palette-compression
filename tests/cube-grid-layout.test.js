"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CubeGridLayout = require("../src/pages/cube-grid-layout.js");

const root = path.resolve(__dirname, "..");

test("offers the requested cube counts", () => {
  const html = fs.readFileSync(path.join(root, "cube.html"), "utf8");
  const values = Array.from(
    html.matchAll(/<option value="(1|3|10|30|100)"(?: selected)?>(?:1|3|10|30|100)<\/option>/g),
    (match) => Number(match[1]),
  );

  assert.deepEqual(values, [1, 3, 10, 30, 100]);
  assert.deepEqual(CubeGridLayout.COUNTS, values);
});

test("lays cubes out in complete rectangular rows", () => {
  assert.deepEqual(CubeGridLayout.getDimensions(1), { columns: 1, rows: 1 });
  assert.deepEqual(CubeGridLayout.getDimensions(3), { columns: 3, rows: 1 });
  assert.deepEqual(CubeGridLayout.getDimensions(10), { columns: 5, rows: 2 });
  assert.deepEqual(CubeGridLayout.getDimensions(30), { columns: 6, rows: 5 });
  assert.deepEqual(CubeGridLayout.getDimensions(100), { columns: 10, rows: 10 });
});

test("centers cube instances in one three-dimensional scene", () => {
  const instances = CubeGridLayout.createInstances(30, 1.5);
  const xs = instances.map((instance) => instance.translation[0]);
  const ys = instances.map((instance) => instance.translation[1]);

  assert.equal(instances.length, 30);
  assert.ok(instances.every((instance) => instance.translation[2] === 0));
  assert.ok(Math.abs(Math.min(...xs) + Math.max(...xs)) < 1e-12);
  assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - 0.25) < 1e-12);
  assert.ok(instances.every((instance) => instance.scale === instances[0].scale));
});

test("reduces cube scale as the grid grows", () => {
  const one = CubeGridLayout.createInstances(1, 16 / 9);
  const hundred = CubeGridLayout.createInstances(100, 16 / 9);

  assert.equal(one[0].scale, 1);
  assert.ok(hundred[0].scale < one[0].scale);
});

test("rejects cube counts outside the selector", () => {
  assert.throws(() => CubeGridLayout.getDimensions(2), /Unsupported cube count/);
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
