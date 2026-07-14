"use strict";

const t = (key, parameters) => window.I18n.t(key, parameters);

const controls = document.getElementById("controls");
const imageSelect = document.getElementById("image-url");
const qualityPresetSelect = document.getElementById("quality-preset");
const blockSizeSelect = document.getElementById("block-size");
const localColorCountSelect = document.getElementById("local-color-count");
const globalColorCountSelect = document.getElementById("global-color-count");
const paletteCountSelect = document.getElementById("palette-count");
const paletteColorBitsSelect = document.getElementById("palette-color-bits");
const colorSpaceSelect = document.getElementById("color-space");
const clusteringMethodSelect = document.getElementById("clustering-method");
const algorithmSelect = document.getElementById("algorithm");
const diversityInput = document.getElementById("diversity");
const diversityValue = document.getElementById("diversity-value");
const ditheringSelect = document.getElementById("dithering");
const refinementPassesSelect = document.getElementById("refinement-passes");
const uploadButton = document.getElementById("upload-button");
const fileInput = document.getElementById("image-file");
const processButton = document.getElementById("process-button");
const optimizeButton = document.getElementById("optimize-button");
const downloadFileButton = document.getElementById("download-file-button");
const downloadBplmButton = document.getElementById("download-bplm-button");
const downloadButton = document.getElementById("download-button");
const showGridInput = document.getElementById("show-grid");
const statusElement = document.getElementById("status");
const progressDialog = document.getElementById("progress-dialog");
const progressBar = document.getElementById("progress-bar");
const progressPercent = document.getElementById("progress-percent");
const progressStage = document.getElementById("progress-stage");
const progressDetail = document.getElementById("progress-detail");
const progressStageCount = document.getElementById("progress-stage-count");
const progressClusterCount = document.getElementById("progress-cluster-count");
const progressPaletteCount = document.getElementById("progress-palette-count");
const progressCancelButton = document.getElementById("progress-cancel");
const sourceViewport = document.getElementById("source-viewport");
const resultViewport = document.getElementById("result-viewport");
const sourceStage = document.getElementById("source-stage");
const resultStage = document.getElementById("result-stage");
const sourceCanvas = document.getElementById("source-canvas");
const resultCanvas = document.getElementById("result-canvas");
const gridCanvas = document.getElementById("grid-canvas");
const zoomLevel = document.getElementById("zoom-level");
const globalPaletteElement = document.getElementById("global-palette");
const blockPaletteElement = document.getElementById("block-palette");
const blockLabel = document.getElementById("block-label");
const paletteSummary = document.getElementById("palette-summary");
const processingTime = document.getElementById("processing-time");
const metricSize = document.getElementById("metric-size");
const metricBlocks = document.getElementById("metric-blocks");
const metricPayload = document.getElementById("metric-payload");
const metricBpp = document.getElementById("metric-bpp");
const metricRatio = document.getElementById("metric-ratio");
const metricError = document.getElementById("metric-error");
const metricPsnr = document.getElementById("metric-psnr");
const storageHeader = document.getElementById("storage-header");
const storageHeaderFormula = document.getElementById("storage-header-formula");
const storageGlobal = document.getElementById("storage-global");
const storageGlobalFormula = document.getElementById("storage-global-formula");
const storageBlocks = document.getElementById("storage-blocks");
const storageBlocksFormula = document.getElementById("storage-blocks-formula");
const storagePixels = document.getElementById("storage-pixels");
const storagePixelsFormula = document.getElementById("storage-pixels-formula");
const storageTotal = document.getElementById("storage-total");
const storageTotalFormula = document.getElementById("storage-total-formula");
const state = {
  sourceImageData: null,
  sourceName: "image",
  uploadedUrl: null,
  worker: null,
  optimizerWorker: null,
  processingId: 0,
  debounceTimer: 0,
  result: null,
  selectedBlock: 0,
  imageWidth: 0,
  imageHeight: 0,
  displayBaseScale: 1,
  zoom: 1,
  synchronizingScroll: false,
  viewportDrag: null,
  optimizationApplied: false,
  progress: null,
};

const MIN_ZOOM = 0.125;
const MAX_ZOOM = 16;
const DRAG_THRESHOLD = 5;
const DRAG_DELAY_MS = 140;
const PROGRESS_STAGES = [
  "preparing",
  "analyzing-blocks",
  "clustering-blocks",
  "building-palettes",
  "assigning-pixels",
  "building-block-palettes",
  "encoding-pixels",
  "refining",
  "finalizing",
];
const PROGRESS_STAGE_KEYS = {
  "preparing": "block.progressStagePreparing",
  "analyzing-blocks": "block.progressStageAnalyzing",
  "clustering-blocks": "block.progressStageBlockClustering",
  "building-palettes": "block.progressStagePalettes",
  "assigning-pixels": "block.progressStageAssignments",
  "building-block-palettes": "block.progressStageBlockPalettes",
  "encoding-pixels": "block.progressStageEncoding",
  "refining": "block.progressStageRefining",
  "finalizing": "block.progressStageFinalizing",
  "complete": "block.progressStageComplete",
  "searching-settings": "block.progressStageSearching",
};
const QUALITY_PRESETS = Object.freeze({
  "1.5": { blockSize: 4, localColorCount: 2, globalColorCount: 8, paletteCount: 2 },
  "2": { blockSize: 4, localColorCount: 2, globalColorCount: 128, paletteCount: 2 },
  "2.5": { blockSize: 8, localColorCount: 4, globalColorCount: 64, paletteCount: 32 },
  "3": { blockSize: 8, localColorCount: 4, globalColorCount: 256, paletteCount: 64 },
  "4": { blockSize: 8, localColorCount: 8, globalColorCount: 128, paletteCount: 16 },
  "5": { blockSize: 16, localColorCount: 16, globalColorCount: 256, paletteCount: 64 },
  "6": { blockSize: 8, localColorCount: 16, globalColorCount: 128, paletteCount: 32 },
  "8": { blockSize: 4, localColorCount: 8, globalColorCount: 256, paletteCount: 64 },
});

controls.addEventListener("submit", (event) => {
  event.preventDefault();
  state.optimizationApplied = false;
  processImage();
});

imageSelect.addEventListener("change", () => {
  state.optimizationApplied = false;
  releaseUploadedImage();
  loadImage(imageSelect.value, optionLabel(imageSelect.selectedOptions[0])).catch(showError);
});

qualityPresetSelect.addEventListener("change", applyQualityPreset);

for (const select of [
  blockSizeSelect,
  localColorCountSelect,
  globalColorCountSelect,
  paletteCountSelect,
  paletteColorBitsSelect,
  colorSpaceSelect,
  clusteringMethodSelect,
  algorithmSelect,
  ditheringSelect,
  refinementPassesSelect,
]) {
  select.addEventListener("change", () => {
    qualityPresetSelect.value = "";
    state.optimizationApplied = false;
    processImage();
  });
}

diversityInput.addEventListener("input", () => {
  qualityPresetSelect.value = "";
  state.optimizationApplied = false;
  updateDiversityLabel();
  window.clearTimeout(state.debounceTimer);
  state.debounceTimer = window.setTimeout(processImage, 180);
});

uploadButton.addEventListener("click", () => fileInput.click());
optimizeButton.addEventListener("click", optimizeSettings);
progressCancelButton.addEventListener("click", cancelProcessing);
progressDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelProcessing();
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];

  if (!file) {
    return;
  }

  releaseUploadedImage();
  state.optimizationApplied = false;
  state.uploadedUrl = URL.createObjectURL(file);
  const option = new Option(t("dynamic.uploaded", { name: file.name }), state.uploadedUrl, true, true);

  option.dataset.uploaded = "true";
  imageSelect.append(option);
  loadImage(state.uploadedUrl, file.name).catch(showError);
});

downloadFileButton.addEventListener("click", downloadBlockPaletteFile);
downloadBplmButton.addEventListener("click", downloadBlockPaletteMipmapFile);
downloadButton.addEventListener("click", downloadResult);
showGridInput.addEventListener("change", drawGrid);
sourceViewport.addEventListener("scroll", () => synchronizeScroll(sourceViewport, resultViewport), { passive: true });
resultViewport.addEventListener("scroll", () => synchronizeScroll(resultViewport, sourceViewport), { passive: true });
sourceViewport.addEventListener("wheel", zoomFromWheel, { passive: false });
resultViewport.addEventListener("wheel", zoomFromWheel, { passive: false });
for (const viewport of [sourceViewport, resultViewport]) {
  viewport.addEventListener("pointerdown", startViewportDrag);
  viewport.addEventListener("pointermove", moveViewportDrag);
  viewport.addEventListener("pointerup", finishViewportDrag);
  viewport.addEventListener("pointercancel", finishViewportDrag);
  viewport.addEventListener("lostpointercapture", finishViewportDrag);
}
window.addEventListener("beforeunload", () => {
  stopWorker();
  stopOptimizer();
  releaseUploadedImage();
});
window.addEventListener("languagechange", () => {
  updateDiversityLabel();

  if (state.progress) {
    renderProgress(state.progress);
  }

  if (state.result) {
    const fileLayout = renderResult(state.result);

    renderDoneStatus(state.result, fileLayout);
  }
});

function applyQualityPreset() {
  const preset = QUALITY_PRESETS[qualityPresetSelect.value];

  if (!preset) {
    return;
  }

  blockSizeSelect.value = String(preset.blockSize);
  localColorCountSelect.value = String(preset.localColorCount);
  globalColorCountSelect.value = String(preset.globalColorCount);
  paletteCountSelect.value = String(preset.paletteCount);
  paletteColorBitsSelect.value = "24";
  colorSpaceSelect.value = "rgb";
  clusteringMethodSelect.value = "k-means";
  algorithmSelect.value = "cpu";
  diversityInput.value = "0";
  ditheringSelect.value = "none";
  refinementPassesSelect.value = "4";
  state.optimizationApplied = false;
  updateDiversityLabel();
  processImage();
}

updateDiversityLabel();
loadImage(imageSelect.value, optionLabel(imageSelect.selectedOptions[0])).catch(showError);

async function loadImage(url, name) {
  stopWorker();
  stopOptimizer();
  resetResult();
  setBusy(true);
  setStatus(t("dynamic.loadingImage"), "busy");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(t("dynamic.imageLoadFailed", {
      status: response.status,
      statusText: response.statusText,
    }));
  }

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  try {
    sourceCanvas.width = bitmap.width;
    sourceCanvas.height = bitmap.height;

    const context = sourceCanvas.getContext("2d", { willReadFrequently: true });

    context.clearRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    state.sourceImageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    state.sourceName = stripExtension(name || "image");
    metricSize.textContent = `${formatInteger(bitmap.width)} × ${formatInteger(bitmap.height)}`;
    updateCanvasDisplaySize(bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }

  processImage();
}

function processImage() {
  window.clearTimeout(state.debounceTimer);

  if (!state.sourceImageData) {
    return;
  }

  stopWorker();
  resetResultMetrics();
  setBusy(true);

  const settings = getSettings();
  const sourceCopy = new Uint8ClampedArray(state.sourceImageData.data);
  const processingId = ++state.processingId;
  const workerUrl = settings.algorithm === "webgl"
    ? "./src/palette/block-palette-webgl-worker.js?v=block-distance-cache-1"
    : "./src/palette/block-palette-worker.js?v=block-distance-cache-1";
  const worker = new Worker(workerUrl);

  state.worker = worker;
  startProgress({
    stage: "preparing",
    progress: 0,
    completed: 0,
    total: Math.ceil(state.sourceImageData.width / settings.blockSize) *
      Math.ceil(state.sourceImageData.height / settings.blockSize),
    targetClusters: settings.paletteCount,
  });
  setStatus(
    t("block.processing", {
      algorithm: getAlgorithmLabel(settings.algorithm),
      palettes: settings.paletteCount,
      globalColors: formatInteger(settings.globalColorCount),
      storage: getPaletteStorageLabel(settings),
      format: getPaletteFormatLabel(settings.paletteColorBits),
      clustering: getClusteringMethodLabel(settings.clusteringMethod),
      diversity: getDiversityLabel(),
      blockSize: settings.blockSize,
      localColors: settings.localColorCount,
      dithering: getDitheringLabel(settings.dithering),
    }),
    "busy"
  );

  worker.addEventListener("message", (event) => {
    if (worker !== state.worker || processingId !== state.processingId) {
      return;
    }

    if (event.data.error) {
      showError(new Error(event.data.error));
      stopWorker();
      return;
    }

    if (event.data.type === "progress") {
      updateProgress(event.data.progress);
      return;
    }

    const fileLayout = renderResult(event.data);
    updateProgress({ stage: "complete", progress: 1 });
    stopWorker();
    setBusy(false);
    renderDoneStatus(event.data, fileLayout);
    closeProgress();
  });

  worker.addEventListener("error", (event) => {
    if (worker === state.worker) {
      showError(new Error(event.message || t("dynamic.workerError")));
      stopWorker();
    }
  });

  worker.postMessage({
    pixels: sourceCopy.buffer,
    width: state.sourceImageData.width,
    height: state.sourceImageData.height,
    settings,
  }, [sourceCopy.buffer]);
}

function renderResult(result) {
  state.result = result;
  state.selectedBlock = 0;
  const fileLayout = window.BlockPaletteFormat.getBlockPaletteFileLayout(result);

  resultCanvas.width = result.width;
  resultCanvas.height = result.height;
  resultCanvas.getContext("2d").putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
  gridCanvas.width = result.width;
  gridCanvas.height = result.height;

  metricBlocks.textContent = `${formatInteger(result.blocksX)} × ${formatInteger(result.blocksY)}`;
  metricPayload.textContent = formatBytes(fileLayout.payloadBytes);
  metricBpp.textContent = result.storage.bitsPerPixel.toFixed(2);
  metricRatio.textContent = `${result.storage.compressionRatio.toFixed(2)}×`;
  metricError.textContent = Math.sqrt(result.meanSquaredError).toFixed(2);
  metricPsnr.textContent = formatPsnr(result.meanSquaredError);
  processingTime.textContent = `${t("units.ms", { value: result.durationMs.toFixed(1) })} · ${getColorSpaceLabel(result.colorSpace)} · ${getClusteringMethodLabel(result.clusteringMethod)} · ${getAlgorithmLabel(result.algorithm)}`;

  storageHeader.textContent = formatBytes(fileLayout.headerBytes);
  storageHeaderFormula.textContent = t("block.headerFormula", {
    magic: window.BlockPaletteFormat.MAGIC,
    version: window.BlockPaletteFormat.VERSION,
    bits: fileLayout.bitFieldHeaderBits,
  });
  storageGlobal.textContent = formatBitSize(result.storage.globalPaletteBits);
  storageGlobalFormula.textContent = t("block.paletteFormula", {
    palettes: result.paletteCount,
    colors: formatInteger(result.globalColorCount),
    bytes: result.paletteColorBits / 8,
    format: getPaletteFormatLabel(result.paletteColorBits),
  });
  storageBlocks.textContent = formatBitSize(
    result.storage.blockPaletteSelectorBits + result.storage.blockPaletteBits
  );
  storageBlocksFormula.textContent = t("block.indexFormula", {
    items: formatInteger(result.blockCount),
    paletteBits: result.paletteIndexBits,
    colors: result.localColorCount,
    bits: result.globalIndexBits,
  });
  storagePixels.textContent = formatBitSize(result.storage.pixelDataBits);
  storagePixelsFormula.textContent = t("block.pixelFormula", {
    pixels: formatInteger(result.width * result.height),
    bits: result.localIndexBits,
  });
  storageTotal.textContent = formatBytes(fileLayout.totalBytes);
  storageTotalFormula.textContent = fileLayout.paddingBits === 0
    ? t("block.totalNoPadding", { size: formatBitSize(fileLayout.payloadBits) })
    : t("block.totalPadding", {
      size: formatBitSize(fileLayout.payloadBits),
      bits: formatInteger(fileLayout.paddingBits),
    });
  paletteSummary.textContent = t("block.paletteSummary", {
    palettes: result.paletteCount,
    active: formatInteger(result.activeGlobalColorCount),
    used: formatInteger(result.resultColorCount),
    format: getPaletteFormatLabel(result.paletteColorBits),
  });

  renderGlobalPalettes(result);
  renderSelectedBlock();
  drawGrid();
  downloadFileButton.disabled = false;
  downloadBplmButton.disabled = false;
  downloadButton.disabled = false;

  window.__blockPaletteResult = {
    width: result.width,
    height: result.height,
    blockSize: result.blockSize,
    blocksX: result.blocksX,
    blocksY: result.blocksY,
    blockCount: result.blockCount,
    localColorCount: result.localColorCount,
    globalColorCount: result.globalColorCount,
    paletteCount: result.paletteCount,
    paletteIndexBits: result.paletteIndexBits,
    paletteColorBits: result.paletteColorBits,
    paletteMode: result.paletteMode,
    algorithm: result.algorithm,
    acceleratedStages: result.acceleratedStages,
    fallbackReason: result.fallbackReason || null,
    clusteringMethod: result.clusteringMethod,
    dithering: result.dithering,
    diversity: result.diversity,
    storage: result.storage,
    rmse: Math.sqrt(result.meanSquaredError),
    psnr: calculatePsnr(result.meanSquaredError),
    refinementPasses: result.refinementPasses,
    refinementIterations: result.refinementIterations,
    refinementAcceptedPasses: result.refinementAcceptedPasses,
    durationMs: result.durationMs,
    file: fileLayout,
  };

  return fileLayout;
}

function renderDoneStatus(result, fileLayout) {
  setStatus(t("block.done", {
    blocks: formatInteger(result.blockCount),
    palettes: result.paletteCount,
    bits: result.localIndexBits,
    size: formatBytes(fileLayout.totalBytes),
    storage: getPaletteStorageLabel(result),
    clustering: getClusteringMethodLabel(result.clusteringMethod),
    algorithm: getAlgorithmLabel(result.algorithm),
    diversity: getDiversityLabel(),
    dithering: getDitheringLabel(result.dithering),
    optimized: state.optimizationApplied ? t("block.optimizedSuffix") : "",
  }));
}

function renderGlobalPalettes(result) {
  const groups = [];

  for (let paletteIndex = 0; paletteIndex < result.paletteCount; paletteIndex += 1) {
    const group = document.createElement("section");
    const title = document.createElement("h3");
    const colors = document.createElement("div");
    const paletteBase = paletteIndex * result.globalColorCount;

    group.className = "shared-palette-group";
    title.textContent = t("block.paletteLabel", { palette: paletteIndex + 1 });
    colors.className = "global-palette-colors";
    colors.replaceChildren(...result.palette
      .slice(paletteBase, paletteBase + result.globalColorCount)
      .map((color, paletteColorIndex) =>
        createGlobalSwatch(color, paletteIndex, paletteColorIndex)
      ));
    group.append(title, colors);
    groups.push(group);
  }

  globalPaletteElement.replaceChildren(...groups);
}

function createGlobalSwatch(color, paletteIndex, paletteColorIndex) {
  const item = document.createElement("div");
  const sample = document.createElement("span");
  const label = document.createElement("small");

  item.className = `global-swatch${color.count === 0 ? " is-unused" : ""}`;
  item.title = t("block.indexTitle", {
    palette: paletteIndex + 1,
    index: paletteColorIndex,
    hex: color.hex,
    pixels: t("units.pixels", { value: formatInteger(color.count) }),
  });
  sample.className = "swatch-color";
  sample.style.backgroundColor = color.hex;
  sample.textContent = formatPaletteIndex(paletteColorIndex, state.result.globalIndexBits);
  label.textContent = color.hex;
  item.append(sample, label);

  return item;
}

function renderSelectedBlock() {
  const result = state.result;

  if (!result) {
    return;
  }

  const blockX = state.selectedBlock % result.blocksX;
  const blockY = Math.floor(state.selectedBlock / result.blocksX);
  const offset = state.selectedBlock * result.localColorCount;
  const paletteIndex = result.blockPaletteSelectors[state.selectedBlock];
  const paletteBase = paletteIndex * result.globalColorCount;
  const entries = [];

  for (let localIndex = 0; localIndex < result.localColorCount; localIndex += 1) {
    const globalIndex = result.blockPaletteIndices[offset + localIndex];
    const color = result.palette[paletteBase + globalIndex];
    const item = document.createElement("div");
    const sample = document.createElement("span");
    const data = document.createElement("span");
    const hex = document.createElement("strong");
    const mapping = document.createElement("span");

    item.className = "block-swatch";
    sample.className = "swatch-color";
    sample.style.backgroundColor = color.hex;
    sample.textContent = String(localIndex);
    data.className = "swatch-data";
    hex.textContent = color.hex;
    mapping.textContent = t("block.mapping", {
      local: localIndex,
      palette: paletteIndex + 1,
      global: globalIndex,
    });
    data.append(hex, mapping);
    item.append(sample, data);
    entries.push(item);
  }

  blockLabel.textContent = t("block.blockLabel", {
    x: blockX,
    y: blockY,
    x1: blockX * result.blockSize,
    x2: Math.min(result.width, (blockX + 1) * result.blockSize) - 1,
    y1: blockY * result.blockSize,
    y2: Math.min(result.height, (blockY + 1) * result.blockSize) - 1,
    palette: paletteIndex + 1,
  });
  blockPaletteElement.replaceChildren(...entries);
}

function selectBlockFromPointer(event) {
  if (!state.result) {
    return;
  }

  const bounds = resultCanvas.getBoundingClientRect();
  const pixelX = Math.min(state.result.width - 1, Math.max(0, Math.floor((event.clientX - bounds.left) / bounds.width * state.result.width)));
  const pixelY = Math.min(state.result.height - 1, Math.max(0, Math.floor((event.clientY - bounds.top) / bounds.height * state.result.height)));
  const blockX = Math.floor(pixelX / state.result.blockSize);
  const blockY = Math.floor(pixelY / state.result.blockSize);

  state.selectedBlock = blockY * state.result.blocksX + blockX;
  renderSelectedBlock();
  drawGrid();
}

function drawGrid() {
  const result = state.result;
  const context = gridCanvas.getContext("2d");

  context.clearRect(0, 0, gridCanvas.width, gridCanvas.height);

  if (!result) {
    return;
  }

  const lineWidth = Math.max(1, Math.min(result.width, result.height) / 420);

  if (showGridInput.checked) {
    context.beginPath();
    context.strokeStyle = "rgba(230, 241, 255, 0.42)";
    context.lineWidth = lineWidth;

    for (let x = result.blockSize; x < result.width; x += result.blockSize) {
      context.moveTo(x, 0);
      context.lineTo(x, result.height);
    }

    for (let y = result.blockSize; y < result.height; y += result.blockSize) {
      context.moveTo(0, y);
      context.lineTo(result.width, y);
    }

    context.stroke();
  }

  const blockX = state.selectedBlock % result.blocksX;
  const blockY = Math.floor(state.selectedBlock / result.blocksX);
  const x = blockX * result.blockSize;
  const y = blockY * result.blockSize;
  const width = Math.min(result.blockSize, result.width - x);
  const height = Math.min(result.blockSize, result.height - y);
  const outlineWidth = lineWidth * 3;
  const outlineInset = outlineWidth / 2;

  context.fillStyle = "rgba(41, 182, 255, 0.24)";
  context.fillRect(x, y, width, height);
  context.strokeStyle = "rgba(3, 10, 18, 0.92)";
  context.lineWidth = outlineWidth;
  context.strokeRect(
    x + outlineInset,
    y + outlineInset,
    Math.max(0, width - outlineWidth),
    Math.max(0, height - outlineWidth)
  );
  context.strokeStyle = "#7ddcff";
  context.lineWidth = lineWidth * 1.4;
  context.strokeRect(
    x + outlineInset,
    y + outlineInset,
    Math.max(0, width - outlineWidth),
    Math.max(0, height - outlineWidth)
  );
}

function getSettings() {
  return {
    blockSize: Number(blockSizeSelect.value),
    localColorCount: Number(localColorCountSelect.value),
    globalColorCount: Number(globalColorCountSelect.value),
    paletteCount: Number(paletteCountSelect.value),
    paletteColorBits: Number(paletteColorBitsSelect.value),
    paletteMode: "explicit",
    colorSpace: colorSpaceSelect.value,
    clusteringMethod: clusteringMethodSelect.value,
    algorithm: algorithmSelect.value,
    dithering: ditheringSelect.value,
    diversity: getDiversity(),
    refinementPasses: Number(refinementPassesSelect.value),
  };
}

function updateCanvasDisplaySize(width, height) {
  const longestSide = Math.max(width, height);
  const preferredScale = longestSide < 512 ? Math.min(8, Math.floor(512 / longestSide)) : 1;
  const viewportWidth = Math.min(sourceViewport.clientWidth, resultViewport.clientWidth);
  const availableWidth = Math.max(1, viewportWidth - 28);

  state.imageWidth = width;
  state.imageHeight = height;
  state.displayBaseScale = Math.min(preferredScale, availableWidth / width);
  state.zoom = 1;
  applyCanvasDisplaySize();
  sourceViewport.scrollTo(0, 0);
  resultViewport.scrollTo(0, 0);
}

function applyCanvasDisplaySize() {
  const displayScale = state.displayBaseScale * state.zoom;
  const displayWidth = `${state.imageWidth * displayScale}px`;
  const displayHeight = `${state.imageHeight * displayScale}px`;

  for (const stage of [sourceStage, resultStage]) {
    stage.style.width = displayWidth;
    stage.style.height = displayHeight;
  }

  zoomLevel.value = `${Math.round(state.zoom * 100)}%`;
}

function synchronizeScroll(source, target) {
  if (state.synchronizingScroll) {
    return;
  }

  state.synchronizingScroll = true;
  const sourceRangeX = Math.max(0, source.scrollWidth - source.clientWidth);
  const sourceRangeY = Math.max(0, source.scrollHeight - source.clientHeight);
  const targetRangeX = Math.max(0, target.scrollWidth - target.clientWidth);
  const targetRangeY = Math.max(0, target.scrollHeight - target.clientHeight);

  target.scrollLeft = sourceRangeX > 0 ? source.scrollLeft / sourceRangeX * targetRangeX : 0;
  target.scrollTop = sourceRangeY > 0 ? source.scrollTop / sourceRangeY * targetRangeY : 0;
  window.requestAnimationFrame(() => {
    state.synchronizingScroll = false;
  });
}

function startViewportDrag(event) {
  if (event.button !== 0 || !state.imageWidth || !state.imageHeight) {
    return;
  }

  const viewport = event.currentTarget;

  if (viewport === resultViewport && isPointerInsideResultCanvas(event)) {
    selectBlockFromPointer(event);
  }

  state.viewportDrag = {
    viewport,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startedAt: event.timeStamp,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
    active: false,
    moved: false,
  };
  try {
    viewport.setPointerCapture(event.pointerId);
  } catch (_error) {
    // Synthetic pointer events used by tests may not have a capturable pointer.
  }
}

function moveViewportDrag(event) {
  const drag = state.viewportDrag;

  if (!drag || drag.viewport !== event.currentTarget || drag.pointerId !== event.pointerId) {
    return;
  }

  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;
  const distance = Math.hypot(deltaX, deltaY);

  if (!drag.active) {
    const heldLongEnough = event.timeStamp - drag.startedAt >= DRAG_DELAY_MS;

    if (!heldLongEnough || distance < DRAG_THRESHOLD) {
      return;
    }

    drag.active = true;
    drag.viewport.classList.add("is-dragging");
  }

  drag.moved = true;
  drag.viewport.scrollLeft = drag.scrollLeft - deltaX;
  drag.viewport.scrollTop = drag.scrollTop - deltaY;
  state.synchronizingScroll = false;
  synchronizeScroll(
    drag.viewport,
    drag.viewport === sourceViewport ? resultViewport : sourceViewport
  );
  event.preventDefault();
}

function finishViewportDrag(event) {
  const drag = state.viewportDrag;

  if (!drag || drag.viewport !== event.currentTarget || drag.pointerId !== event.pointerId) {
    return;
  }

  state.viewportDrag = null;
  drag.viewport.classList.remove("is-dragging");

  if (event.type !== "lostpointercapture" && drag.viewport.hasPointerCapture(event.pointerId)) {
    drag.viewport.releasePointerCapture(event.pointerId);
  }
}

function isPointerInsideResultCanvas(event) {
  const bounds = resultCanvas.getBoundingClientRect();

  return event.clientX >= bounds.left && event.clientX < bounds.right &&
    event.clientY >= bounds.top && event.clientY < bounds.bottom;
}

function zoomFromWheel(event) {
  if (!event.ctrlKey || !state.imageWidth || !state.imageHeight) {
    return;
  }

  event.preventDefault();
  const viewport = event.currentTarget;
  const otherViewport = viewport === sourceViewport ? resultViewport : sourceViewport;
  const bounds = viewport.getBoundingClientRect();
  const pointerX = event.clientX - bounds.left;
  const pointerY = event.clientY - bounds.top;
  const anchorX = (viewport.scrollLeft + pointerX) / Math.max(1, viewport.scrollWidth);
  const anchorY = (viewport.scrollTop + pointerY) / Math.max(1, viewport.scrollHeight);
  const pixelDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? event.deltaY * 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * viewport.clientHeight
      : event.deltaY;
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom * Math.exp(-pixelDelta * 0.002)));

  if (Math.abs(nextZoom - state.zoom) < 0.0001) {
    return;
  }

  state.zoom = nextZoom;
  applyCanvasDisplaySize();
  viewport.scrollLeft = anchorX * viewport.scrollWidth - pointerX;
  viewport.scrollTop = anchorY * viewport.scrollHeight - pointerY;
  state.synchronizingScroll = false;
  synchronizeScroll(viewport, otherViewport);
}

function downloadResult() {
  if (!state.result || downloadButton.disabled) {
    return;
  }

  resultCanvas.toBlob((blob) => {
    if (!blob) {
      showError(new Error(t("dynamic.browserPngError")));
      return;
    }

    const settings = getSettings();
    const ditherSuffix = settings.dithering === "none" ? "" : `-${settings.dithering}`;

    downloadBlob(
      blob,
      `${state.sourceName}-blocks-${settings.blockSize}-local-${settings.localColorCount}-global-${settings.globalColorCount}-palettes-${settings.paletteCount}-${settings.paletteColorBits}bit${ditherSuffix}.png`
    );
  }, "image/png");
}

function downloadBlockPaletteFile() {
  if (!state.result || downloadFileButton.disabled) {
    return;
  }

  try {
    const settings = getSettings();
    const bytes = window.BlockPaletteFormat.encodeBlockPaletteFile(state.result);
    const blob = new Blob([bytes], { type: "application/vnd.block-palette" });

    downloadBlob(
      blob,
      `${state.sourceName}-blocks-${settings.blockSize}-local-${settings.localColorCount}-global-${settings.globalColorCount}-palettes-${settings.paletteCount}-${settings.paletteColorBits}bit.bpal`
    );
  } catch (error) {
    showError(error);
  }
}

function downloadBlockPaletteMipmapFile() {
  if (!state.result || downloadBplmButton.disabled) {
    return;
  }

  try {
    const settings = getSettings();
    const bytes = window.BplmFormat.encodeBplmFile(state.result);
    const blob = new Blob([bytes], { type: "application/vnd.block-palette-mipmap" });

    downloadBlob(
      blob,
      `${state.sourceName}-blocks-${settings.blockSize}-local-${settings.localColorCount}-global-${settings.globalColorCount}-palettes-${settings.paletteCount}-${settings.paletteColorBits}bit.bplm`
    );
  } catch (error) {
    showError(error);
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function optimizeSettings() {
  if (!state.sourceImageData || state.optimizerWorker) {
    return;
  }

  stopWorker();
  stopOptimizer();
  setBusy(true);
  optimizeButton.textContent = t("block.optimizeInitial");
  setStatus(t("block.optimizePreparing"), "busy");
  startProgress({
    stage: "searching-settings",
    progress: 0,
    completed: 0,
    total: 20,
  });

  const preview = createOptimizationPreview();
  const worker = new Worker("./src/palette/block-palette-optimizer-worker.js?v=block-distance-cache-1");

  state.optimizerWorker = worker;

  worker.addEventListener("message", (event) => {
    if (worker !== state.optimizerWorker) {
      return;
    }

    if (event.data.type === "progress") {
      const { completed, total, candidate } = event.data;

      optimizeButton.textContent = t("block.optimizeProgress", { completed, total });
      updateProgress({
        stage: "searching-settings",
        progress: completed / total,
        completed,
        total,
        search: {
          size: candidate.fileBytes,
          rmse: candidate.rmse,
        },
      });
      setStatus(
        t("block.optimizeSearching", {
          completed,
          total,
          size: formatBytes(candidate.fileBytes),
          rmse: candidate.rmse.toFixed(2),
        }),
        "busy"
      );
      return;
    }

    if (event.data.type === "error") {
      stopOptimizer();
      showError(new Error(event.data.error));
      return;
    }

    if (event.data.type === "result") {
      const { settings, selected, frontier } = event.data.result;

      blockSizeSelect.value = String(settings.blockSize);
      localColorCountSelect.value = String(settings.localColorCount);
      globalColorCountSelect.value = String(settings.globalColorCount);
      paletteColorBitsSelect.value = String(settings.paletteColorBits);
      qualityPresetSelect.value = "";
      state.optimizationApplied = true;
      stopOptimizer();
      setBusy(false);
      setStatus(
        t("block.optimizeFound", {
          count: formatInteger(frontier.length),
          size: formatBytes(selected.fileBytes),
          rmse: selected.rmse.toFixed(2),
        }),
        "busy"
      );
      processImage();
    }
  });

  worker.addEventListener("error", (event) => {
    if (worker === state.optimizerWorker) {
      stopOptimizer();
      showError(new Error(event.message || t("block.optimizeError")));
    }
  });

  worker.postMessage({
    pixels: preview.data.buffer,
    width: preview.width,
    height: preview.height,
    options: {
      colorSpace: colorSpaceSelect.value,
      clusteringMethod: clusteringMethodSelect.value,
      dithering: ditheringSelect.value,
      diversity: getDiversity(),
      refinementPasses: Number(refinementPassesSelect.value),
      paletteCount: Number(paletteCountSelect.value),
      paletteMode: "explicit",
    },
  }, [preview.data.buffer]);
}

function createOptimizationPreview() {
  const maximumSide = 96;
  const sourceWidth = state.sourceImageData.width;
  const sourceHeight = state.sourceImageData.height;
  const scale = Math.min(1, maximumSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  if (width === sourceWidth && height === sourceHeight) {
    return new ImageData(new Uint8ClampedArray(state.sourceImageData.data), width, height);
  }

  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(sourceCanvas, 0, 0, width, height);

  return context.getImageData(0, 0, width, height);
}

function startProgress(progress) {
  updateProgress(progress);

  if (progressDialog.open) {
    return;
  }

  if (typeof progressDialog.showModal === "function") {
    progressDialog.showModal();
  } else {
    progressDialog.setAttribute("open", "");
  }
}

function updateProgress(progress) {
  state.progress = { ...progress };
  renderProgress(state.progress);
}

function renderProgress(progress) {
  const normalized = Math.max(0, Math.min(1, Number(progress.progress) || 0));
  const percent = Math.round(normalized * 100);
  const stageKey = PROGRESS_STAGE_KEYS[progress.stage] || PROGRESS_STAGE_KEYS.preparing;
  const stageIndex = progress.stage === "searching-settings"
    ? 1
    : progress.stage === "complete"
      ? PROGRESS_STAGES.length
      : Math.max(1, PROGRESS_STAGES.indexOf(progress.stage) + 1);
  const stageTotal = progress.stage === "searching-settings" ? 1 : PROGRESS_STAGES.length;

  progressBar.value = percent;
  progressBar.textContent = `${percent}%`;
  progressPercent.value = `${percent}%`;
  progressStage.textContent = t(stageKey);
  progressStageCount.textContent = `${formatInteger(stageIndex)} / ${formatInteger(stageTotal)}`;
  progressClusterCount.textContent = formatProgressCount(
    progress.clusters,
    progress.targetClusters
  );
  progressPaletteCount.textContent = formatProgressCount(
    progress.palette,
    progress.paletteTotal
  );

  if (progress.search) {
    progressDetail.textContent = t("block.progressSearchDetail", {
      completed: formatInteger(progress.completed),
      total: formatInteger(progress.total),
      size: formatBytes(progress.search.size),
      rmse: progress.search.rmse.toFixed(2),
    });
  } else if (Number.isFinite(progress.iteration) && Number.isFinite(progress.totalIterations)) {
    progressDetail.textContent = t("block.progressIteration", {
      current: formatInteger(progress.iteration),
      total: formatInteger(progress.totalIterations),
    });
  } else if (Number.isFinite(progress.completed) && Number.isFinite(progress.total)) {
    progressDetail.textContent = t("block.progressItems", {
      completed: formatInteger(progress.completed),
      total: formatInteger(progress.total),
    });
  } else {
    progressDetail.textContent = t("block.progressWaiting");
  }
}

function formatProgressCount(value, total) {
  if (!Number.isFinite(value)) {
    return "—";
  }

  return Number.isFinite(total)
    ? `${formatInteger(value)} / ${formatInteger(total)}`
    : formatInteger(value);
}

function closeProgress() {
  if (progressDialog.open) {
    if (typeof progressDialog.close === "function") {
      progressDialog.close();
    } else {
      progressDialog.removeAttribute("open");
    }
  }

  state.progress = null;
}

function cancelProcessing() {
  if (!state.worker && !state.optimizerWorker) {
    closeProgress();
    return;
  }

  state.processingId += 1;
  stopWorker();
  stopOptimizer();
  setBusy(false);
  closeProgress();
  setStatus(t("block.progressCancelled"));
}

function stopWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
}

function releaseUploadedImage() {
  const uploadedOption = imageSelect.querySelector("option[data-uploaded='true']");

  if (uploadedOption) {
    uploadedOption.remove();
  }

  if (state.uploadedUrl) {
    URL.revokeObjectURL(state.uploadedUrl);
    state.uploadedUrl = null;
  }

  fileInput.value = "";
}

function resetResult() {
  state.sourceImageData = null;
  metricSize.textContent = "—";
  resetResultMetrics();
}

function resetResultMetrics() {
  state.result = null;
  resultCanvas.width = 0;
  resultCanvas.height = 0;
  gridCanvas.width = 0;
  gridCanvas.height = 0;

  for (const element of [metricBlocks, metricPayload, metricBpp, metricRatio, metricError, metricPsnr, storageHeader, storageGlobal, storageBlocks, storagePixels, storageTotal]) {
    element.textContent = "—";
  }

  storageHeaderFormula.textContent = "—";
  storageGlobalFormula.textContent = "—";
  storageBlocksFormula.textContent = "—";
  storagePixelsFormula.textContent = "—";
  storageTotalFormula.textContent = "—";
  processingTime.textContent = "";
  blockLabel.textContent = "—";
  paletteSummary.textContent = "—";
  blockPaletteElement.replaceChildren();
  globalPaletteElement.replaceChildren();
  downloadFileButton.disabled = true;
  downloadBplmButton.disabled = true;
  downloadButton.disabled = true;
  delete window.__blockPaletteResult;
}

function showError(error) {
  console.error("Block palette conversion failed.", error);
  setBusy(false);
  closeProgress();
  setStatus(error && error.message ? error.message : String(error), "error");
}

function setBusy(busy) {
  processButton.disabled = busy;
  optimizeButton.disabled = busy;
  imageSelect.disabled = busy;
  qualityPresetSelect.disabled = busy;
  uploadButton.disabled = busy;
  blockSizeSelect.disabled = busy;
  localColorCountSelect.disabled = busy;
  globalColorCountSelect.disabled = busy;
  paletteCountSelect.disabled = busy;
  paletteColorBitsSelect.disabled = busy;
  colorSpaceSelect.disabled = busy;
  clusteringMethodSelect.disabled = busy;
  algorithmSelect.disabled = busy;
  diversityInput.disabled = busy;
  ditheringSelect.disabled = busy;
  refinementPassesSelect.disabled = busy;
}

function setStatus(message, kind) {
  statusElement.textContent = message;
  statusElement.classList.toggle("is-busy", kind === "busy");
  statusElement.classList.toggle("is-error", kind === "error");
}

function formatInteger(value) {
  return window.I18n.formatNumber(value);
}

function calculatePsnr(meanSquaredError) {
  const mse = Number(meanSquaredError);

  if (!Number.isFinite(mse) || mse < 0) {
    return NaN;
  }

  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

function formatPsnr(meanSquaredError) {
  const psnr = calculatePsnr(meanSquaredError);

  if (psnr === Infinity) {
    return "∞ dB";
  }

  return Number.isFinite(psnr) ? `${psnr.toFixed(2)} dB` : "—";
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return t("units.bytes", { value: formatInteger(bytes) });
  }

  if (bytes < 1024 * 1024) {
    return t("units.kib", { value: (bytes / 1024).toFixed(2) });
  }

  return t("units.mib", { value: (bytes / (1024 * 1024)).toFixed(2) });
}

function formatBitSize(bits) {
  return bits % 8 === 0
    ? formatBytes(bits / 8)
    : t("units.bits", { value: formatInteger(bits) });
}

function formatPaletteIndex(index, bits) {
  return bits >= 8
    ? index.toString(16).padStart(Math.ceil(bits / 4), "0").toUpperCase()
    : String(index);
}

function getColorSpaceLabel(value) {
  return value === "rgb" ? "RGB" : "OKLab";
}

function getAlgorithmLabel(value) {
  if (value === "webgl") {
    return "WebGL2";
  }

  if (value === "webgl-hybrid") {
    return "WebGL2 + CPU Floyd";
  }

  if (value === "cpu-fallback") {
    return "WebGL2 → CPU";
  }

  return "CPU";
}

function getPaletteFormatLabel(bits) {
  return Number(bits) === 16 ? "RGB565" : "RGB888";
}

function getPaletteStorageLabel() {
  return t("block.explicitPalette");
}

function getClusteringMethodLabel(value) {
  if (value === "k-medians") {
    return "K-medians · L1";
  }

  return value === "k-means-uniform"
    ? t("block.kmeansUniform")
    : "K-means · L2";
}

function getDitheringLabel(mode) {
  switch (mode) {
    case "pattern-2x2":
      return t("common.bayer2");
    case "pattern":
      return t("common.bayer4");
    case "floyd-steinberg":
      return "Floyd–Steinberg";
    default:
      return t("common.noDithering");
  }
}

function stopOptimizer() {
  if (state.optimizerWorker) {
    state.optimizerWorker.terminate();
    state.optimizerWorker = null;
  }

  optimizeButton.textContent = t("block.optimize");
}

function getDiversityLevel() {
  return Math.max(0, Math.min(6, Math.round(Number(diversityInput.value) || 0)));
}

function getDiversity() {
  return getDiversityLevel() / 6;
}

function updateDiversityLabel() {
  diversityValue.textContent = getDiversityLabel();
}

function getDiversityLabel() {
  return t(`common.diversity${getDiversityLevel()}`);
}

function optionLabel(option) {
  return option ? option.textContent.trim() : "image";
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "") || "image";
}
