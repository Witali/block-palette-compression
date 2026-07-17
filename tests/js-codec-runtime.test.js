"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const runtime = require("../src/encoders/codec-encoder-runtime.js");
const runtimeSource = read("src/encoders/codec-encoder-runtime.js");
const bpalWorker = read("src/palette/block-palette-worker.js");

test("defines one canonical JS worker entry point for every encoder", () => {
  assert.deepEqual(runtime.formats, ["bpal", "dct", "bpdh"]);
  assert.match(runtime.getWorkerUrl("bpal"), /src\/palette\/block-palette-worker\.js/);
  assert.match(runtime.getWorkerUrl("dct"), /src\/dct\/dct-worker\.js/);
  assert.match(runtime.getWorkerUrl("bpdh"), /src\/hybrid\/bpdh-worker\.js/);
  assert.throws(() => runtime.getWorkerUrl("unknown"), /Unsupported JS codec encoder/);
  assert.equal((runtimeSource.match(/block-palette-worker\.js/g) || []).length, 1);
  assert.equal((runtimeSource.match(/dct-worker\.js/g) || []).length, 1);
  assert.equal((runtimeSource.match(/bpdh-worker\.js/g) || []).length, 1);
});

test("routes every laboratory encoder through the shared runtime", () => {
  const html = read("codec-lab.html");
  const lab = read("src/pages/codec-lab-page.js");
  const runtimeIndex = html.indexOf("src/encoders/codec-encoder-runtime.js");
  const controllerIndex = html.indexOf("src/pages/codec-lab-page.js");
  assert.ok(runtimeIndex >= 0 && runtimeIndex < controllerIndex);
  assert.doesNotMatch(
    lab,
    /new Worker\("\.\/src\/(?:palette\/(?:block-palette|block-palette-webgl)-worker|dct\/dct-worker|hybrid\/bpdh-worker)/
  );
  for (const format of runtime.formats) {
    assert.match(lab, new RegExp(`runWorker\\("${format}"`));
  }
  assert.match(lab, /root\.CodecEncoderRuntime\.createWorker\(format\)/);
});

test("uses one BPAL worker for both CPU and WebGL backends", () => {
  assert.equal(fs.existsSync(path.join(root, "src/palette/block-palette-webgl-worker.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/palette/block-palette-webgl-codec.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/palette/block-palette-webgl-accelerator.js")), true);
  assert.match(bpalWorker, /settings && settings\.algorithm === "webgl"/);
  assert.match(bpalWorker, /importScripts\("\.\/block-palette-webgl-accelerator\.js/);
  assert.match(bpalWorker, /self\.BlockPaletteWebGLAccelerator\.createWebGLAccelerator/);
  assert.match(bpalWorker, /self\.BlockPaletteCodec\.compressImage/);
  assert.doesNotMatch(read("src/palette/block-palette-webgl-accelerator.js"), /function compressImage/);
});

test("selects CPU and WebGL inside the same BPAL worker", () => {
  const cpu = runBpalWorker("cpu");
  const webgl = runBpalWorker("webgl");

  assert.equal(cpu.result.algorithm, "cpu");
  assert.equal(cpu.acceleratorImports, 0);
  assert.equal(cpu.receivedAccelerator, undefined);
  assert.equal(webgl.result.algorithm, "webgl");
  assert.equal(webgl.acceleratorImports, 1);
  assert.equal(webgl.receivedAccelerator, webgl.accelerator);
  assert.equal(webgl.accelerator.disposed, true);
});

test("keeps each public encoder algorithm in one canonical source file", () => {
  assert.deepEqual(definingFiles("function compressImage("), ["src/palette/block-palette-codec.js"]);
  assert.deepEqual(definingFiles("function encodeDctFile("), ["src/dct/dct-format.js"]);
  assert.deepEqual(definingFiles("function compressHybridImage("), ["src/hybrid/bpdh-codec.js"]);
  assert.match(read("src/hybrid/bpdh-codec.js"), /blockPaletteCodec\.compressImage/);
});

function definingFiles(signature) {
  return sourceFiles(path.join(root, "src"))
    .filter((fileName) => fs.readFileSync(path.join(root, fileName), "utf8").includes(signature))
    .sort();
}

function runBpalWorker(algorithm) {
  let messageListener = null;
  let receivedAccelerator;
  let acceleratorImports = 0;
  const messages = [];
  const accelerator = {
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
  const sandbox = {
    Uint8ClampedArray,
    performance: { now: () => 1 },
    importScripts(...urls) {
      if (urls.some((url) => url.includes("block-palette-webgl-accelerator.js"))) {
        acceleratorImports += 1;
        sandbox.BlockPaletteWebGLAccelerator = {
          createWebGLAccelerator: () => accelerator,
        };
      }
    },
    addEventListener(type, listener) {
      if (type === "message") messageListener = listener;
    },
    postMessage(message) {
      messages.push(message);
    },
    BlockPaletteCodec: {
      compressImage(source, width, height, options) {
        receivedAccelerator = options.accelerator;
        return {
          pixels: new Uint8ClampedArray(width * height * 4),
          blockPaletteSelectors: new Uint8Array(1),
          blockPaletteIndices: new Uint8Array(1),
          pixelIndices: new Uint8Array(width * height),
        };
      },
    },
  };
  sandbox.self = sandbox;
  vm.runInNewContext(bpalWorker, sandbox, { filename: "block-palette-worker.js" });
  messageListener({
    data: {
      pixels: new Uint8ClampedArray(4).buffer,
      width: 1,
      height: 1,
      settings: { algorithm },
    },
  });

  return {
    accelerator,
    acceleratorImports,
    receivedAccelerator,
    result: messages.at(-1),
  };
}

function sourceFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...sourceFiles(absolute));
    } else if (entry.name.endsWith(".js")) {
      result.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return result;
}

function read(fileName) {
  return fs.readFileSync(path.join(root, fileName), "utf8");
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
