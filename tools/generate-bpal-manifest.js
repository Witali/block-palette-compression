"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const defaultAssetDirectory = path.join(root, "assets", "bpal");
const defaultOutputPath = path.join(defaultAssetDirectory, "manifest.json");
const defaultExample = "stone-texture-wic.bplm";

function createBpalManifest(assetDirectory = defaultAssetDirectory) {
  const files = fs.readdirSync(assetDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:bpal|bplm)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`No BPAL or BPLM files found in ${assetDirectory}`);
  }

  if (!files.includes(defaultExample)) {
    throw new Error(`Default BPAL example is missing: ${defaultExample}`);
  }

  return {
    version: 1,
    default: defaultExample,
    files,
  };
}

function writeBpalManifest(
  assetDirectory = defaultAssetDirectory,
  outputPath = defaultOutputPath,
) {
  const manifest = createBpalManifest(assetDirectory);

  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (require.main === module) {
  const assetDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : defaultAssetDirectory;
  const outputPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(assetDirectory, "manifest.json");
  const manifest = writeBpalManifest(assetDirectory, outputPath);

  console.log(`Wrote ${manifest.files.length} entries to ${outputPath}`);
}

module.exports = {
  createBpalManifest,
  writeBpalManifest,
};
