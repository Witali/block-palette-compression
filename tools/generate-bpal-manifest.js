"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const defaultBpalAssetDirectory = path.join(root, "assets", "bpal");
const defaultBpalOutputPath = path.join(defaultBpalAssetDirectory, "manifest.json");
const defaultBpalExample = "stone-texture-wic.bplm";
const defaultBpdhAssetDirectory = path.join(root, "assets", "bpdh");
const defaultBpdhOutputPath = path.join(defaultBpdhAssetDirectory, "manifest.json");
const defaultBpdhExample = "landscape-alaska.bpdh";

function createAssetManifest(assetDirectory, filePattern, defaultExample, formatLabel) {
  const files = fs.readdirSync(assetDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && filePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`No ${formatLabel} files found in ${assetDirectory}`);
  }

  if (!files.includes(defaultExample)) {
    throw new Error(`Default ${formatLabel} example is missing: ${defaultExample}`);
  }

  return {
    version: 1,
    default: defaultExample,
    files,
  };
}

function createBpalManifest(assetDirectory = defaultBpalAssetDirectory) {
  return createAssetManifest(
    assetDirectory,
    /\.(?:bpal|bplm)$/i,
    defaultBpalExample,
    "BPAL/BPLM"
  );
}

function createBpdhManifest(assetDirectory = defaultBpdhAssetDirectory) {
  return createAssetManifest(
    assetDirectory,
    /\.bpdh$/i,
    defaultBpdhExample,
    "BPDH"
  );
}

function writeBpalManifest(
  assetDirectory = defaultBpalAssetDirectory,
  outputPath = defaultBpalOutputPath,
) {
  const manifest = createBpalManifest(assetDirectory);

  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function writeBpdhManifest(
  assetDirectory = defaultBpdhAssetDirectory,
  outputPath = defaultBpdhOutputPath,
) {
  const manifest = createBpdhManifest(assetDirectory);

  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (require.main === module) {
  if (process.argv[2]) {
    const assetDirectory = path.resolve(process.argv[2]);
    const outputPath = process.argv[3]
      ? path.resolve(process.argv[3])
      : path.join(assetDirectory, "manifest.json");
    const manifest = writeBpalManifest(assetDirectory, outputPath);

    console.log(`Wrote ${manifest.files.length} entries to ${outputPath}`);
  } else {
    const bpalManifest = writeBpalManifest();
    const bpdhManifest = writeBpdhManifest();

    console.log(`Wrote ${bpalManifest.files.length} entries to ${defaultBpalOutputPath}`);
    console.log(`Wrote ${bpdhManifest.files.length} entries to ${defaultBpdhOutputPath}`);
  }
}

module.exports = {
  createBpalManifest,
  createBpdhManifest,
  writeBpalManifest,
  writeBpdhManifest,
};
