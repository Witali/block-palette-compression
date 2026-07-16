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
  assert.match(source, /0\.75, 1, 1\.5, 2, 3, 4\.5, 6, 7\.5, or 9/);
  assert.match(source, /command == "presets"/);
  assert.match(source, /command == "pixel"/);
  assert.match(source, /preset\.bytes_per_mcu/);
  assert.match(source, /--coefficient-coding/);
  assert.match(source, /COEFFICIENT_CODING_MASKED_TAIL_8X8 = 6/);
  assert.match(source, /COEFFICIENT_CODING_MASKED_TAIL_IMPLICIT2_48 = 7/);
  assert.match(source, /masked-tail-implicit2-48/);
  assert.match(source, /mask_bit = best_position - 1/);
  assert.match(source, /const int tail_start = 64 - tail_count/);
  assert.match(source, /encode_best_coding/);
  assert.match(source, /if \(error < best\.error\)/);
  assert.match(readme, /bit zero selects AC1 \(DC is separate\)/);
  assert.match(readme, /tie keeps grouped coding/);
});

test("keeps random pixel access bounded to one fixed MCU record and its prototype library", () => {
  assert.match(source, /const std::vector<uint8_t> record\(/);
  assert.match(source, /HEADER_BYTES \+ static_cast<size_t>\(mcu_index\) \* info\.preset\.bytes_per_mcu/);
  assert.match(source, /device_record\.get\(\), record\.data\(\), record\.size\(\), cudaMemcpyHostToDevice/);
  assert.match(source, /info\.library_enabled \? device_library\.get\(\) : nullptr/);
  assert.match(source, /read_sidecar_reference/);
  assert.match(source, /mcu_index \* 4u \+ static_cast<uint32_t>\(luma_block\)/);
  assert.match(readme, /does\s+not upload the other MCU records/);
  assert.match(readme, /16 or 32 prototypes/);
  assert.match(readme, /constant-time random access/);
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

test("writes 4:2:0 chroma and keeps the legacy 4:2:2 decoder path", () => {
  assert.match(source, /FLAG_CHROMA_420 = 8u/);
  assert.match(source, /FLAG_CHROMA_420 \|/);
  assert.match(source, /encode_component_kernel<8, 8, true>/);
  assert.match(source, /sample_chroma_420/);
  assert.match(source, /info\.chroma_420/);
  assert.match(source, /"4:2:2 \(legacy\)"/);
  assert.match(readme, /4:2:0 downsampling/);
  assert.match(readme, /compatibility\s+with earlier 4:2:2 files/);
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
