"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assetDirectory = path.join(root, "assets", "scenes", "barcelona");
const manifestPath = path.join(assetDirectory, "manifest.json");

test("provides a Blender scene viewer with the requested codec switch", () => {
  const html = read("scene-viewer.html");
  const source = read("src/pages/scene-viewer-page.js");

  assert.match(html, /<option value="bpal">BPAL/);
  assert.match(html, /<option value="dct">DCTBS2/);
  assert.match(html, /<option value="astc">ASTC/);
  assert.match(html, /src="\.\/src\/decoders\/bpal-texture\.js"/);
  assert.match(html, /src="\.\/src\/dct\/dct-format\.js"/);
  assert.match(source, /createASTCModule/);
  assert.match(source, /elements\.codec\.addEventListener\("change"/);
  assert.match(source, /assignTextures\(sceneRoot, manifest\.materials, resources, codec\)/);
});

test("ships all source textures in BPAL, DCTBS2, and ASTC", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.textureCount, 17);
  assert.equal(manifest.textures.length, 17);
  assert.deepEqual(Object.keys(manifest.codecTotals).sort(), ["astc", "bpal", "dct"]);

  for (const texture of manifest.textures) {
    for (const codec of ["bpal", "dct", "astc"]) {
      const variant = texture.variants[codec];
      const bytes = fs.readFileSync(path.join(assetDirectory, variant.color));

      assert.equal(variant.bytes, bytes.length + alphaBytes(assetDirectory, variant));
      if (codec === "bpal") assert.equal(bytes.subarray(0, 4).toString("ascii"), "BPAL");
      if (codec === "dct") assert.equal(bytes.subarray(0, 6).toString("ascii"), "DCTBS2");
      if (codec === "astc") assert.deepEqual([...bytes.subarray(0, 4)], [0x13, 0xAB, 0xA1, 0x5C]);
    }
  }
});

test("keeps transparent texture masks in palette and DCT variants", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const transparent = manifest.textures.filter((texture) => texture.hasAlpha);

  assert.deepEqual(transparent.map((texture) => texture.source).sort(), [
    "candle flame 2.png",
    "tree_leafs.png",
  ]);
  assert.ok(transparent.every((texture) => texture.variants.bpal.alpha));
  assert.ok(transparent.every((texture) => texture.variants.dct.alpha));
});

test("exports texture-free glTF geometry and valid material assignments", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const gltf = JSON.parse(fs.readFileSync(path.join(assetDirectory, "scene.gltf"), "utf8"));
  const identifiers = new Set(manifest.textures.map((texture) => texture.id));

  assert.ok(gltf.meshes.length > 0);
  assert.ok(gltf.nodes.length > 0);
  assert.equal(gltf.images, undefined);
  assert.equal(gltf.textures, undefined);
  assert.equal(gltf.samplers, undefined);
  assert.ok(gltf.meshes.some((mesh) => mesh.primitives.some((primitive) => (
    primitive.attributes.TEXCOORD_0 !== undefined
  ))));
  for (const roles of Object.values(manifest.materials)) {
    for (const identifier of Object.values(roles)) assert.ok(identifiers.has(identifier));
  }
});

function alphaBytes(directory, variant) {
  return variant.alpha ? fs.statSync(path.join(directory, variant.alpha)).size : 0;
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
