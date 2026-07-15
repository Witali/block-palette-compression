"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "native", "dct_cuda", "dctcuda.cu"), "utf8");
const readme = fs.readFileSync(path.join(root, "native", "dct_cuda", "README.md"), "utf8");
const build = fs.readFileSync(path.join(root, "native", "dct_cuda", "build.ps1"), "utf8");

test("provides CUDA encode, decode, settings search, and pixel commands", () => {
  assert.match(source, /__global__ void encode_component_kernel/);
  assert.match(source, /__global__ void decode_image_kernel/);
  assert.match(source, /__global__ void sample_pixel_kernel/);
  assert.match(source, /--find-settings/);
  assert.match(source, /0\.75, 1, 1\.5, 2, 3, 4\.5, or 6/);
  assert.match(source, /command == "presets"/);
  assert.match(source, /command == "pixel"/);
  assert.match(source, /preset\.bytes_per_mcu/);
});

test("keeps random pixel access bounded to one fixed MCU record", () => {
  assert.match(source, /std::vector<uint8_t> record\(info\.preset\.bytes_per_mcu\)/);
  assert.match(source, /file\.seekg\(static_cast<std::streamoff>\(offset\)/);
  assert.match(source, /cudaMemcpy\([\s\S]*record\.size\(\)[\s\S]*cudaMemcpyHostToDevice/);
  assert.match(readme, /uploads only that record to the GPU/);
  assert.match(readme, /sampleDctFilePixel/);
});

test("uses deterministic split luma blocks for high-rate files", () => {
  assert.match(source, /FLAG_SPLIT_LUMA_8X8/);
  assert.match(source, /encode_component_kernel<8, 8, false>/);
  assert.match(source, /sample_inverse_dct<8, 8>/);
  assert.match(source, /record \+ luma_block \* block_bytes/);
  assert.match(source, /preset\.nominal_bpp >= 3\.0/);
  assert.match(readme, /four independent 8x8 Y transforms/);
});

test("ships reproducible nvcc and CMake build entry points", () => {
  assert.match(build, /Get-Command nvcc\.exe/);
  assert.match(build, /VsDevCmd\.bat/);
  assert.match(build, /-arch=\$Architecture/);
  assert.ok(fs.existsSync(path.join(root, "native", "dct_cuda", "CMakeLists.txt")));
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
