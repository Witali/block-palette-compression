"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GpuJpegDecoder } = require("../src/decoders/gpu-jpeg.js");
const {
  encodeDctFile,
  importJpegDctFile,
  decodeJpegDctPixels,
  decodeDctFile,
  inspectDctFile,
} = require("../src/dct/dct-format.js");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "tools", "dctbs2-cli.js");

test("uses the canonical JS codec for byte-identical command-line encoding", () => {
  withTempDirectory((directory) => {
    const width = 19;
    const height = 17;
    const pixels = makePixels(width, height);
    const input = path.join(directory, "source.ppm");
    const output = path.join(directory, "output.dctbs2");
    writePpm(input, width, height, pixels);

    runCli([
      "encode", input, output,
      "--preset", "3",
      "--quality", "79",
      "--component-budget", "expanded",
      "--coefficient-coding", "dual-scale-skip-front",
      "--zigzag-order", "true",
      "--chroma-subsampling", "4:2:0",
      "--json",
    ]);

    const expected = encodeDctFile(pixels, width, height, {
      preset: "3",
      quality: 79,
      componentBudget: "expanded",
      coefficientCoding: "dual-scale-skip-front",
      zigzagOrder: true,
      chromaSubsampling: "4:2:0",
    });
    assert.deepEqual(fs.readFileSync(output), Buffer.from(expected));

    const info = JSON.parse(runCli(["info", output, "--json"]));
    assert.equal(info.componentAllocationAdaptive, true);
    const pixel = JSON.parse(runCli(["pixel", output, "4", "5", "--json"]));
    const decoded = decodeDctFile(expected);
    const pixelOffset = (5 * width + 4) * 4;
    assert.deepEqual(
      [pixel.r, pixel.g, pixel.b, pixel.a],
      Array.from(decoded.pixels.slice(pixelOffset, pixelOffset + 4))
    );
    const preview = path.join(directory, "preview.ppm");
    runCli(["decode", output, preview]);
    assert.match(fs.readFileSync(preview).subarray(0, 32).toString("ascii"), /^P6\n19 17\n255\n/);
  });
});

test("exposes quality search and every prototype-library control from the shared codec", () => {
  withTempDirectory((directory) => {
    const width = 16;
    const height = 16;
    const pixels = makePixels(width, height);
    const input = path.join(directory, "source.rgba");
    const searched = path.join(directory, "searched.dctbs2");
    const library = path.join(directory, "library.dctbs2");
    fs.writeFileSync(input, Buffer.from(pixels));

    runCli([
      "encode", input, searched,
      "--width", String(width), "--height", String(height),
      "--preset", "2", "--auto-quality",
      "--component-budget", "fast",
    ]);
    assert.equal(inspectDctFile(fs.readFileSync(searched)).autoQuality, true);

    runCli([
      "encode", input, library,
      "--width", String(width), "--height", String(height),
      "--preset", "3", "--quality", "80", "--dct-library",
      "--library-size", "3", "--library-components", "y",
      "--library-reference-coding", "sidecar",
      "--library-frequency-split", "0.25",
      "--library-cluster-samples", "64",
      "--library-candidate-count", "2",
    ]);
    const info = inspectDctFile(fs.readFileSync(library));
    assert.equal(info.libraryEnabled, true);
    assert.equal(info.library.referenceCoding, "sidecar");
    assert.equal(info.library.frequencySplit, 0.25);
  });
});

test("uses the shared direct JPEG DCT import and CPU reconstruction", () => {
  withTempDirectory((directory) => {
    const input = path.join(root, "assets", "stone-texture-small.jpg");
    const output = path.join(directory, "jpeg.dctbs2");
    const jpegBytes = fs.readFileSync(input);
    const jpeg = GpuJpegDecoder.parse(jpegBytes);
    const reference = decodeJpegDctPixels(jpeg);
    const expected = importJpegDctFile(jpeg, {
      preset: "3",
      quality: 72,
      componentBudget: "fast",
      referencePixels: reference.pixels,
      directJpegCoefficients: true,
    });

    const result = JSON.parse(runCli([
      "encode", input, output,
      "--preset", "3", "--quality", "72",
      "--component-budget", "fast", "--json",
    ]));
    assert.equal(result.importMode, "jpeg-dct");
    assert.deepEqual(fs.readFileSync(output), Buffer.from(expected));
    assert.equal(reference.pixels.length, jpeg.width * jpeg.height * 4);
  });
});

test("documents all full-parity command-line algorithm switches", () => {
  const help = runCli(["--help"]);
  assert.match(runCli(["--json", "presets"]), /^\[/);
  for (const option of [
    "--auto-quality",
    "--component-budget",
    "--component-allocation",
    "--coefficient-coding",
    "--zigzag-order",
    "--chroma-subsampling",
    "--dct-library",
    "--library-components",
    "--library-reference-coding",
    "--library-frequency-split",
    "--library-cluster-samples",
    "--library-candidate-count",
    "--jpeg-dct-import",
    "--direct-jpeg-coefficients",
  ]) {
    assert.match(help, new RegExp(option));
  }
  assert.match(fs.readFileSync(cli, "utf8"), /require\("\.\.\/src\/dct\/dct-format\.js"\)/);
});

function runCli(arguments_) {
  const result = childProcess.spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function withTempDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dctbs2-js-cli-"));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writePpm(filename, width, height, pixels) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 3) {
    rgb[target] = pixels[source];
    rgb[target + 1] = pixels[source + 1];
    rgb[target + 2] = pixels[source + 2];
  }
  fs.writeFileSync(filename, Buffer.concat([
    Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii"),
    rgb,
  ]));
}

function makePixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = (x * 19 + y * 7) & 255;
      pixels[offset + 1] = (x * 3 + y * 23) & 255;
      pixels[offset + 2] = (x * 13 + y * 11) & 255;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
