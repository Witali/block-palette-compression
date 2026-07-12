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

  async function loadManifest(
    manifestUrl = DEFAULT_MANIFEST_URL,
    fetchImplementation = root.fetch,
  ) {
    if (typeof fetchImplementation !== "function") {
      throw new TypeError("Fetch is unavailable for the BPAL example catalog");
    }

    const response = await fetchImplementation(manifestUrl);

    if (!response.ok) {
      throw new Error(
        `Could not load the BPAL example catalog: ${response.status} ${response.statusText}`,
      );
    }

    return validateManifest(await response.json());
  }

  function validateManifest(manifest) {
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) {
      throw new TypeError("Invalid bundled BPAL manifest");
    }

    const files = manifest.files.filter(isValidFileName);

    if (
      files.length === 0 ||
      files.length !== manifest.files.length ||
      new Set(files).size !== files.length
    ) {
      throw new TypeError("Invalid bundled BPAL manifest entries");
    }

    if (typeof manifest.default !== "string" || !files.includes(manifest.default)) {
      throw new TypeError("Invalid default bundled BPAL image");
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
    const validated = validateManifest(manifest);
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

  function isValidFileName(fileName) {
    return typeof fileName === "string" &&
      !fileName.includes("/") &&
      !fileName.includes("\\") &&
      /\.(?:bpal|bplm)$/i.test(fileName);
  }

  return {
    DEFAULT_MANIFEST_URL,
    loadManifest,
    validateManifest,
    populateSelect,
    getSelectedExample,
  };
});
