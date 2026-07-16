"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { PRESETS } = require(path.join(root, "src", "dct", "dct-format.js"));
const {
  buildScan,
  buildSkipScan,
  cubePresets,
  cubeShaderFile,
  generatedFiles,
  presets,
} = require(path.join(root, "tools", "generate-dctbs2-shaders.js"));

test("ships one current-format WebGL2 DCTBS2 shader for every payload rate", () => {
  assert.deepEqual(
    presets.map((preset) => preset.key),
    Object.keys(PRESETS).sort((left, right) => Number(left) - Number(right))
  );
  assert.equal(generatedFiles().size, 17);

  for (const [file, expected] of generatedFiles()) {
    const actual = fs.readFileSync(path.join(root, "src", "shaders", file), "utf8")
      .replace(/\r\n?/g, "\n");
    assert.equal(actual, expected, `${file} must be regenerated after format changes`);
  }
});

test("matches DCTBS2 v2 MCU layouts instead of the attached legacy dctb layout", () => {
  for (const preset of presets) {
    const source = generatedFiles().get(preset.file);
    const layout = PRESETS[preset.key];
    assert.equal(preset.mode, layout.modeCode);
    assert.deepEqual(
      [preset.mcu, preset.y, preset.cb, preset.cr],
      [layout.bytesPerMcu, layout.yBytes, layout.cbBytes, layout.crBytes]
    );
    assert.match(source, /const int HEADER_SIZE = 64;/);
    assert.match(source, /u32le\(8\) == 2u/);
    assert.match(source, /int mcuOffset = HEADER_SIZE \+ mcuIndex \* int\(EXPECTED_MCU_BYTES\)/);
    assert.doesNotMatch(source, /HEADER_SIZE = 256/);
  }
});

test("keeps shader coefficient scans, grouped exponents, and libraries bounded", () => {
  assert.deepEqual(buildScan(0, 8, 8).slice(0, 8), [8, 1, 2, 9, 16, 24, 17, 10]);
  assert.equal(new Set(buildScan(3, 16, 16)).size, 255);
  assert.equal(new Set(buildSkipScan(7, 16, 16)).size, 255);

  const source = generatedFiles().get("dctbs2-3bpp.frag.glsl");
  assert.match(source, /for \(int index = 0; index < 256; \+\+index\)/);
  assert.match(source, /uint readComponentBits/);
  assert.match(source, /uint componentWordAt/);
  assert.match(source, /componentWordAt\(wordByteOffset\) << wordBit/);
  assert.doesNotMatch(source, /for \(int bit = 0; bit < 16/);
  assert.match(source, /uint readSidecarBits/);
  assert.match(source, /int groupedScaleIndex/);
  assert.match(source, /int skipScanPosition/);
  assert.match(source, /bool skipRecord = coding >= 3 && coding <= 5/);
  assert.match(source, /float sampleMaskedTailRecord/);
  assert.match(source, /float sampleImplicit2MaskedTailRecord/);
  assert.match(source, /if \(coding == 7 && \(kind == 1 \|\| kind == 3\) && recordBytes == 48\)/);
  assert.match(source, /int explicitCount = bitCount\(maskLow\) \+ bitCount\(maskHigh\)/);
  assert.match(source, /position >= tailStart/);
  assert.match(source, /int tokenCount = skipTokenCount/);
  assert.match(source, /bool sidecarReferenceVersion/);
  assert.match(source, /int resolveLibraryIndex/);
  assert.match(source, /int prototypeOffset = prototypeBase \+ \(libraryIndex - 1\) \* recordBytes/);
  assert.match(source, /yReferenceOrdinal = mcuIndex \* 4 \+ block/);
  assert.match(source, /const uint FLAG_CHROMA_420 = 8u/);
  assert.match(source, /float sampleChroma420WithPrototype/);
  assert.match(source, /kind == 1 \|\| kind == 3 \? 8 : 16/);
});

test("generates unrolled baseline Cube shaders for the supported payload profiles", () => {
  for (const preset of cubePresets) {
    const source = generatedFiles().get(cubeShaderFile(preset));
    const decoder = source.match(
      /\/\/ <dctbs2-profile-decoder>([\s\S]*?)\/\/ <\/dctbs2-profile-decoder>/
    );
    const expectedYCount = Math.floor((preset.y * 8 - 27) / 5);
    const expectedChromaCount = Math.floor((preset.cb * 8 - 27) / 5);

    assert.ok(decoder, `${preset.key} bpp Cube shader must contain a generated decoder`);
    assert.match(source, new RegExp(`const int DCT_MCU_BYTES = ${preset.mcu};`));
    assert.match(source, new RegExp(`const int DCT_Y_AC_COUNT = ${expectedYCount};`));
    assert.match(source, new RegExp(`const int DCT_C_AC_COUNT = ${expectedChromaCount};`));
    assert.doesNotMatch(decoder[1], /for \(|libraryVersion|splitLuma|profile < 0/);
    assert.doesNotMatch(source, /uHeightTexture|uHeightStrength|applyHeightNormal|reliefTexCoord/);
    assert.equal(
      (decoder[1].match(/int position = DCT_SCAN_Y/g) || []).length,
      expectedYCount
    );
    assert.equal(
      (decoder[1].match(/int position = DCT_SCAN_C/g) || []).length,
      expectedChromaCount * 2
    );
    assert.match(source, /sampleDctChroma420Record/);
    assert.match(source, /sampleDctChroma422Record/);
  }
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
