"use strict";

const assert = require("node:assert/strict");
const { createWebGLAccelerator } = require("../src/palette/block-palette-webgl-accelerator.js");

test("keeps WebGL2 as an accelerator rather than a second BPAL encoder", () => {
  assert.equal(typeof createWebGLAccelerator, "function");
  assert.throws(() => createWebGLAccelerator(4, 4), /OffscreenCanvas/);
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
