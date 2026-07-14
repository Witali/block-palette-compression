"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cpuSource = fs.readFileSync(path.join(root, "native", "bpal5_simd", "src", "bpal5enc.c"), "utf8");
const cudaSource = fs.readFileSync(path.join(root, "native", "bpal5_simd", "src", "bpal5cudaenc.cu"), "utf8");
const librarySource = fs.readFileSync(path.join(root, "native", "bpal5_simd", "src", "bpal5.c"), "utf8");
const header = fs.readFileSync(path.join(root, "native", "bpal5_simd", "include", "bpal5.h"), "utf8");
const readme = fs.readFileSync(path.join(root, "native", "bpal5_simd", "README.md"), "utf8");

test("offers target-bpp settings search in both native encoders", () => {
  for (const source of [cpuSource, cudaSource]) {
    assert.match(source, /--find-settings/);
    assert.match(source, /--find-settings requires --preset BPP/);
    assert.match(source, /bpal5_find_settings_candidates\(/);
    assert.match(source, /bpal5_quality_preset_range\(/);
    assert.match(source, /candidate_stats\.final_error < best_error/);
  }

  assert.match(header, /BPAL5_FIND_SETTINGS_MAX_CANDIDATES 19u/);
  assert.match(librarySource, /minimum_bits_per_pixel = \(previous \+ preset->bits_per_pixel\) \/ 2\.0/);
  assert.match(librarySource, /maximum_bits_per_pixel = \(next \+ preset->bits_per_pixel\) \/ 2\.0/);
  assert.doesNotMatch(librarySource, /candidate\.palette_color_bits = profile->palette_color_bits/);
  assert.match(readme, /--preset 3 --find-settings/);
  assert.match(readme, /search never changes the selected RGB565 or RGB888 palette color format/);
});

test("exposes CPU encoder error without a decode pass", () => {
  assert.match(header, /uint64_t initial_error;\s+uint64_t final_error;/);
  assert.match(librarySource, /stats->initial_error = current_error/);
  assert.match(librarySource, /stats->final_error = current_error/);
  assert.doesNotMatch(cpuSource, /bpal5_decode_rgba\(/);
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
