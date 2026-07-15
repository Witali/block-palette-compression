(function (root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BpalExampleCatalog = api;
})(typeof self !== "undefined" ? self : globalThis, function (root) {
  "use strict";

  const DEFAULT_MANIFEST_URL = "./assets/bpal/manifest.json";
  const DEFAULT_ASSET_DIRECTORY = "./assets/bpal/";
  const CATALOGS = Object.freeze({
    bpal: Object.freeze({
      manifestUrl: DEFAULT_MANIFEST_URL,
      assetDirectory: DEFAULT_ASSET_DIRECTORY,
      filePattern: /\.(?:bpal|bplm)$/i,
      label: "BPAL",
    }),
    bpdh: Object.freeze({
      manifestUrl: "./assets/bpdh/manifest.json",
      assetDirectory: "./assets/bpdh/",
      filePattern: /\.bpdh$/i,
      label: "BPDH",
    }),
  });

  async function loadManifest(
    manifestUrl = DEFAULT_MANIFEST_URL,
    fetchImplementation = root.fetch,
  ) {
    return loadCatalogManifest(CATALOGS.bpal, manifestUrl, fetchImplementation);
  }

  async function loadManifestForType(
    type,
    fetchImplementation = root.fetch,
  ) {
    const catalog = getCatalog(type);

    return loadCatalogManifest(catalog, catalog.manifestUrl, fetchImplementation);
  }

  async function loadCatalogManifest(catalog, manifestUrl, fetchImplementation) {
    if (typeof fetchImplementation !== "function") {
      throw new TypeError(`Fetch is unavailable for the ${catalog.label} example catalog`);
    }

    const response = await fetchImplementation(manifestUrl);

    if (!response.ok) {
      throw new Error(
        `Could not load the ${catalog.label} example catalog: ${response.status} ${response.statusText}`,
      );
    }

    return validateCatalogManifest(await response.json(), catalog);
  }

  function validateManifest(manifest) {
    return validateCatalogManifest(manifest, CATALOGS.bpal);
  }

  function validateManifestForType(manifest, type) {
    return validateCatalogManifest(manifest, getCatalog(type));
  }

  function validateCatalogManifest(manifest, catalog) {
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) {
      throw new TypeError(`Invalid bundled ${catalog.label} manifest`);
    }

    const files = manifest.files.filter((fileName) => isValidFileName(fileName, catalog));

    if (
      files.length === 0 ||
      files.length !== manifest.files.length ||
      new Set(files).size !== files.length
    ) {
      throw new TypeError(`Invalid bundled ${catalog.label} manifest entries`);
    }

    if (typeof manifest.default !== "string" || !files.includes(manifest.default)) {
      throw new TypeError(`Invalid default bundled ${catalog.label} image`);
    }

    return {
      version: 1,
      default: manifest.default,
      files: [...files],
    };
  }

  function populateSelect(
    select,
    manifest,
    assetDirectory = DEFAULT_ASSET_DIRECTORY,
  ) {
    return populateCatalogSelect(select, manifest, CATALOGS.bpal, assetDirectory);
  }

  function populateSelectForType(select, manifest, type) {
    const catalog = getCatalog(type);

    return populateCatalogSelect(select, manifest, catalog, catalog.assetDirectory);
  }

  function populateCatalogSelect(select, manifest, catalog, assetDirectory) {
    const validated = validateCatalogManifest(manifest, catalog);
    const options = validated.files.map((fileName) => {
      const option = select.ownerDocument.createElement("option");

      option.value = `${assetDirectory}${encodeURIComponent(fileName)}`;
      option.textContent = fileName;
      option.selected = fileName === validated.default;
      return option;
    });

    select.replaceChildren(...options);

    if (select.selectedIndex < 0) {
      select.selectedIndex = 0;
    }

    return getSelectedExample(select);
  }

  function getSelectedExample(select) {
    const option = select && select.selectedOptions && select.selectedOptions[0];

    return option
      ? { url: option.value, name: option.textContent.trim() }
      : null;
  }

  function isValidFileName(fileName, catalog) {
    return typeof fileName === "string" &&
      !fileName.includes("/") &&
      !fileName.includes("\\") &&
      catalog.filePattern.test(fileName);
  }

  function getCatalog(type) {
    const catalog = CATALOGS[type];

    if (!catalog) {
      throw new TypeError(`Unknown image catalog type: ${type}`);
    }

    return catalog;
  }

  return {
    DEFAULT_MANIFEST_URL,
    DEFAULT_ASSET_DIRECTORY,
    CATALOGS,
    loadManifest,
    loadManifestForType,
    validateManifest,
    validateManifestForType,
    populateSelect,
    populateSelectForType,
    getSelectedExample,
  };
});
