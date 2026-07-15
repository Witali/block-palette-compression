"use strict";

const t = (key, parameters) => window.I18n.t(key, parameters);
const codec = window.DctImageFormat;
const controls = document.getElementById("controls");
const imageSelect = document.getElementById("image-url");
const presetSelect = document.getElementById("preset");
const qualityInput = document.getElementById("quality");
const qualityValue = document.getElementById("quality-value");
const autoQualityInput = document.getElementById("auto-quality");
const jpegImportInput = document.getElementById("jpeg-dct-import");
const prototypeLibrarySelect = document.getElementById("dct-prototype-library");
const uploadButton = document.getElementById("upload-button");
const fileInput = document.getElementById("image-file");
const processButton = document.getElementById("process-button");
const downloadDctButton = document.getElementById("download-dct");
const downloadPngButton = document.getElementById("download-png");
const statusElement = document.getElementById("status");
const sourceViewport = document.getElementById("source-viewport");
const resultViewport = document.getElementById("result-viewport");
const sourceStage = document.getElementById("source-stage");
const resultStage = document.getElementById("result-stage");
const sourceCanvas = document.getElementById("source-canvas");
const resultCanvas = document.getElementById("result-canvas");
const zoomOutButton = document.getElementById("zoom-out");
const zoomInButton = document.getElementById("zoom-in");
const zoomLevel = document.getElementById("zoom-level");
const actualSizeButton = document.getElementById("actual-size");
const fitImageButton = document.getElementById("fit-image");
const metricSize = document.getElementById("metric-size");
const metricMcus = document.getElementById("metric-mcus");
const metricRecord = document.getElementById("metric-record");
const metricBpp = document.getElementById("metric-bpp");
const metricRatio = document.getElementById("metric-ratio");
const metricRmse = document.getElementById("metric-rmse");
const metricPsnr = document.getElementById("metric-psnr");
const pixelForm = document.getElementById("pixel-form");
const pixelXInput = document.getElementById("pixel-x");
const pixelYInput = document.getElementById("pixel-y");
const pixelReadButton = pixelForm.querySelector("button");
const pixelValue = document.getElementById("pixel-value");
const pixelSwatch = document.getElementById("pixel-swatch");
const pixelMcu = document.getElementById("pixel-mcu");
const progressDialog = document.getElementById("progress-dialog");
const progressBar = document.getElementById("progress-bar");
const progressPercent = document.getElementById("progress-percent");
const progressStage = document.getElementById("progress-stage");
const progressDetail = document.getElementById("progress-detail");
const progressCancelButton = document.getElementById("progress-cancel");
const layoutSummary = document.getElementById("dct-layout-summary");
const layoutRateChart = document.getElementById("dct-layout-rate-chart");
const layoutMcuBar = document.getElementById("dct-layout-mcu-bar");
const layoutSpatial = document.getElementById("dct-layout-spatial");

const state = {
  sourceImageData: null,
  sourceJpegBytes: null,
  sourceName: "image",
  uploadedUrl: null,
  encoded: null,
  decodedImageData: null,
  worker: null,
  requestId: 0,
  startedAt: 0,
  elapsedSeconds: "0.00",
  importMode: "rgba",
  zoom: 1,
  viewMode: "fit",
  synchronizingScroll: false,
  drag: null,
};

const ZOOM_FACTOR = 1.25;
const MIN_ZOOM = 0.03;
const MAX_ZOOM = 32;
const VIEWPORT_PADDING = 28;

populatePresetOptions();
renderDctLayoutDiagram();

controls.addEventListener("submit", (event) => {
  event.preventDefault();
  processImage();
});

imageSelect.addEventListener("change", () => {
  releaseUploadedImage();
  loadImage(imageSelect.value, optionLabel(imageSelect.selectedOptions[0])).catch(showError);
});

presetSelect.addEventListener("change", () => {
  renderDctLayoutDiagram();
  setBusy(false);
  processImage();
});
qualityInput.addEventListener("input", updateQualityLabel);
qualityInput.addEventListener("change", () => {
  if (!autoQualityInput.checked) {
    processImage();
  }
});
autoQualityInput.addEventListener("change", () => {
  updateQualityLabel();
  processImage();
});
jpegImportInput.addEventListener("change", () => {
  if (jpegImportInput.checked) {
    autoQualityInput.checked = false;
    prototypeLibrarySelect.value = "none";
  }
  updateQualityLabel();
  processImage();
});
prototypeLibrarySelect.addEventListener("change", () => {
  if (prototypeLibrarySelect.value !== "none") {
    jpegImportInput.checked = false;
  }
  setBusy(false);
  processImage();
});
uploadButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => handleUpload().catch(showError));
downloadDctButton.addEventListener("click", downloadDctFile);
downloadPngButton.addEventListener("click", downloadPng);
pixelForm.addEventListener("submit", readPixel);
zoomOutButton.addEventListener("click", () => setZoom(state.zoom / ZOOM_FACTOR));
zoomInButton.addEventListener("click", () => setZoom(state.zoom * ZOOM_FACTOR));
actualSizeButton.addEventListener("click", showActualSize);
fitImageButton.addEventListener("click", fitImage);
progressCancelButton.addEventListener("click", cancelProcessing);
progressDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelProcessing();
});
sourceViewport.addEventListener("scroll", () => synchronizeScroll(sourceViewport, resultViewport), { passive: true });
resultViewport.addEventListener("scroll", () => synchronizeScroll(resultViewport, sourceViewport), { passive: true });

for (const viewport of [sourceViewport, resultViewport]) {
  viewport.addEventListener("wheel", zoomFromWheel, { passive: false });
  viewport.addEventListener("pointerdown", startDrag);
  viewport.addEventListener("pointermove", moveDrag);
  viewport.addEventListener("pointerup", finishDrag);
  viewport.addEventListener("pointercancel", finishDrag);
  viewport.addEventListener("lostpointercapture", finishDrag);
}

window.addEventListener("resize", () => {
  if (state.viewMode === "fit") {
    fitImage();
  }
});
window.addEventListener("languagechange", () => {
  updateQualityLabel();
  renderDctLayoutDiagram();
  if (state.encoded) {
    renderReadyStatus();
  }
});
window.addEventListener("beforeunload", () => {
  stopWorker();
  releaseUploadedImage();
});

updateQualityLabel();
loadImage(imageSelect.value, optionLabel(imageSelect.selectedOptions[0])).catch(showError);

function populatePresetOptions() {
  const selected = presetSelect.value || "1.5";
  const options = Object.entries(codec.PRESETS)
    .sort((left, right) => right[1].bpp - left[1].bpp)
    .map(([key, preset]) => new Option(
      `${key} bpp · ${preset.bytesPerMcu} B/MCU`,
      key,
      false,
      key === selected
    ));

  presetSelect.replaceChildren(...options);
  if (!codec.PRESETS[selected]) {
    presetSelect.value = "1.5";
  }
}

function renderDctLayoutDiagram() {
  const selectedKey = presetSelect.value || "1.5";
  const selected = codec.PRESETS[selectedKey] || codec.PRESETS["1.5"];
  const profiles = Object.entries(codec.PRESETS)
    .sort((left, right) => left[1].bpp - right[1].bpp);
  const maxBytes = Math.max(...profiles.map(([, profile]) => profile.bytesPerMcu));
  const splitLuma = selected.bpp >= 3;

  layoutSummary.textContent = t(
    splitLuma ? "dct.layoutSummaryHigh" : "dct.layoutSummaryLow",
    { rate: selectedKey, bytes: selected.bytesPerMcu }
  );

  const rows = profiles.map(([key, profile]) => {
    const row = document.createElement("div");
    const rate = document.createElement("span");
    const track = document.createElement("span");
    const fill = document.createElement("span");
    const bytes = document.createElement("span");
    const selectedRow = key === selectedKey;

    row.className = `dct-layout-rate-row${selectedRow ? " is-selected" : ""}`;
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-label", t("dct.layoutModeAria", {
      rate: key,
      bytes: profile.bytesPerMcu,
      y: profile.yBytes,
      cb: profile.cbBytes,
      cr: profile.crBytes,
    }));
    if (selectedRow) {
      row.setAttribute("aria-current", "true");
    }

    rate.textContent = t("dct.layoutRateLabel", { rate: key });
    track.className = "dct-layout-rate-track";
    fill.className = "dct-layout-rate-fill";
    fill.style.width = `${profile.bytesPerMcu / maxBytes * 100}%`;
    fill.append(
      createDctLayoutSegment("y", profile.yBytes, `Y ${profile.yBytes}`),
      createDctLayoutSegment("cb", profile.cbBytes, `Cb ${profile.cbBytes}`),
      createDctLayoutSegment("cr", profile.crBytes, `Cr ${profile.crBytes}`)
    );
    track.append(fill);
    bytes.textContent = t("dct.layoutByteLabel", { bytes: profile.bytesPerMcu });
    row.append(rate, track, bytes);
    return row;
  });
  layoutRateChart.replaceChildren(...rows);

  layoutMcuBar.replaceChildren(
    createDctLayoutSegment("y", selected.yBytes, `Y · ${selected.yBytes}`),
    createDctLayoutSegment("cb", selected.cbBytes, `Cb · ${selected.cbBytes}`),
    createDctLayoutSegment("cr", selected.crBytes, `Cr · ${selected.crBytes}`)
  );
  layoutMcuBar.setAttribute("aria-label", t("dct.layoutSelectedMcuAria", {
    rate: selectedKey,
    y: selected.yBytes,
    cb: selected.cbBytes,
    cr: selected.crBytes,
  }));

  const luma = document.createElement("span");
  luma.className = `dct-layout-luma${splitLuma ? " is-split" : ""}`;
  if (splitLuma) {
    for (let block = 1; block <= 4; block += 1) {
      luma.append(createDctLayoutBlock("y", `Y 8×8 · ${block}`));
    }
  } else {
    luma.append(createDctLayoutBlock("y", "Y 16×16"));
  }
  layoutSpatial.replaceChildren(
    luma,
    createDctLayoutBlock("cb", "Cb 8×16"),
    createDctLayoutBlock("cr", "Cr 8×16")
  );
  layoutSpatial.setAttribute(
    "aria-label",
    t(splitLuma ? "dct.layoutSpatialHighAria" : "dct.layoutSpatialLowAria")
  );
}

function createDctLayoutSegment(component, bytes, label) {
  const segment = document.createElement("span");
  segment.className = `dct-layout-segment is-${component}`;
  segment.style.flexGrow = String(bytes);
  segment.style.flexBasis = "0";
  segment.textContent = label;
  segment.setAttribute("aria-hidden", "true");
  return segment;
}

function createDctLayoutBlock(component, label) {
  const block = document.createElement("span");
  block.className = `dct-layout-block is-${component}`;
  block.textContent = label;
  block.setAttribute("aria-hidden", "true");
  return block;
}

async function loadImage(url, name, suppliedBytes = null) {
  stopWorker();
  setBusy(true);
  setStatus(t("dynamic.loadingImage"), "busy");

  const [image, sourceBytes] = await Promise.all([
    loadHtmlImage(url),
    suppliedBytes ? Promise.resolve(asSourceBytes(suppliedBytes)) : loadSourceBytes(url),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);

  state.sourceImageData = context.getImageData(0, 0, canvas.width, canvas.height);
  state.sourceJpegBytes = isJpegBytes(sourceBytes) ? sourceBytes : null;
  state.sourceName = name || "image";
  state.encoded = null;
  state.decodedImageData = null;
  state.importMode = "rgba";
  jpegImportInput.checked = Boolean(state.sourceJpegBytes);
  if (jpegImportInput.checked) {
    autoQualityInput.checked = false;
    prototypeLibrarySelect.value = "none";
  }
  updateQualityLabel();
  drawImageData(sourceCanvas, state.sourceImageData);
  clearCanvas(resultCanvas);
  resetMetrics();
  updatePixelBounds();
  enableViewControls(true);
  fitImage();
  setBusy(false);
  await processImage();
}

async function loadSourceBytes(url) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch (_error) {
    return null;
  }
}

function asSourceBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return null;
}

function isJpegBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function loadHtmlImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t("dct.imageLoadFailed")));
    image.src = url;
  });
}

async function handleUpload() {
  const file = fileInput.files && fileInput.files[0];

  if (!file) {
    return;
  }

  releaseUploadedImage();
  state.uploadedUrl = URL.createObjectURL(file);
  const option = new Option(t("dynamic.uploaded", { name: file.name }), state.uploadedUrl, true, true);
  option.dataset.uploaded = "true";
  imageSelect.append(option);
  await loadImage(state.uploadedUrl, file.name, await file.arrayBuffer());
}

function getPrototypeLibraryOptions() {
  const mode = prototypeLibrarySelect.value;
  if (mode === "none") {
    return null;
  }
  if (mode === "header3") {
    return { librarySize: 3 };
  }
  const sidecarModes = {
    sidecar16: { librarySize: 16 },
    sidecar32: { librarySize: 32 },
    "sidecar32-spectral": { librarySize: 32, libraryFrequencySplit: 0.25 },
  };
  const selected = sidecarModes[mode];
  if (!selected) {
    throw new RangeError(`Unsupported DCT prototype library mode: ${mode}`);
  }
  return {
    ...selected,
    libraryReferenceCoding: "sidecar",
    libraryClusterSamples: 4096,
    libraryCandidateCount: 4,
  };
}

function processImage() {
  if (!state.sourceImageData) {
    return Promise.resolve();
  }

  stopWorker();
  const requestId = ++state.requestId;
  const source = state.sourceImageData;
  const jpegImport = jpegImportInput.checked && Boolean(state.sourceJpegBytes);
  const autoQuality = !jpegImport && autoQualityInput.checked;
  const worker = new Worker("./src/dct/dct-worker.js?v=dct-page-10");
  const pixels = source.data.slice();
  const jpegBytes = jpegImport ? state.sourceJpegBytes.slice() : null;

  state.worker = worker;
  state.startedAt = performance.now();
  state.encoded = null;
  state.decodedImageData = null;
  setBusy(true);
  setStatus(jpegImport
    ? t("dct.statusImportingJpeg")
    : t(autoQuality ? "dct.statusSearching" : "dct.statusEncoding"), "busy");
  showProgress(autoQuality);

  return new Promise((resolve, reject) => {
    worker.addEventListener("message", ({ data }) => {
      if (!data || data.requestId !== requestId) {
        return;
      }

      if (data.type === "progress") {
        renderProgress(data);
        return;
      }

      if (data.type === "error") {
        const error = new Error(data.message);
        stopWorker();
        setBusy(false);
        closeProgress();
        showError(error);
        reject(error);
        return;
      }

      if (data.type !== "result") {
        return;
      }

      state.encoded = new Uint8Array(data.encoded);
      state.importMode = data.importMode || "rgba";
      state.decodedImageData = new ImageData(
        new Uint8ClampedArray(data.decodedPixels),
        source.width,
        source.height
      );
      qualityInput.value = String(data.quality);
      updateQualityLabel();
      drawImageData(resultCanvas, state.decodedImageData);
      renderMetrics(data.squaredError);
      readPixelAt(0, 0);
      setBusy(false);
      closeProgress();
      renderReadyStatus(data.candidateCount);
      stopWorker();
      resolve();
    });

    worker.addEventListener("error", (event) => {
      const error = event.error || new Error(event.message || t("dynamic.workerError"));
      stopWorker();
      setBusy(false);
      closeProgress();
      showError(error);
      reject(error);
    });

    const libraryOptions = getPrototypeLibraryOptions();
    const message = {
      type: "encode",
      requestId,
      pixels: pixels.buffer,
      width: source.width,
      height: source.height,
      preset: presetSelect.value,
      quality: Number(qualityInput.value),
      autoQuality,
      jpegImport,
      dctLibrary: !jpegImport && libraryOptions !== null,
      librarySize: libraryOptions?.librarySize,
      libraryComponents: libraryOptions ? ["y"] : undefined,
      libraryReferenceCoding: libraryOptions?.libraryReferenceCoding,
      libraryFrequencySplit: libraryOptions?.libraryFrequencySplit,
      libraryClusterSamples: libraryOptions?.libraryClusterSamples,
      libraryCandidateCount: libraryOptions?.libraryCandidateCount,
      jpegBytes: jpegBytes ? jpegBytes.buffer : null,
      sampleMcuCount: 24,
    };
    const transfers = jpegBytes ? [pixels.buffer, jpegBytes.buffer] : [pixels.buffer];
    worker.postMessage(message, transfers);
  });
}

function renderMetrics(squaredError) {
  const info = codec.inspectDctFile(state.encoded);
  const pixelCount = info.width * info.height;
  const channelCount = pixelCount * 3;
  const mse = squaredError / channelCount;
  const rmse = Math.sqrt(mse);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
  const rgbBytes = pixelCount * 3;

  metricSize.textContent = formatBytes(state.encoded.byteLength);
  metricMcus.textContent = info.mcuCount.toLocaleString();
  metricRecord.textContent = formatBytes(info.bytesPerMcu);
  metricBpp.textContent = (state.encoded.byteLength * 8 / pixelCount).toFixed(3);
  metricRatio.textContent = `${(state.encoded.byteLength / rgbBytes * 100).toFixed(1)}%`;
  metricRmse.textContent = rmse.toFixed(2);
  metricPsnr.textContent = Number.isFinite(psnr) ? `${psnr.toFixed(2)} dB` : "∞";
}

function renderReadyStatus(candidateCount = null) {
  if (!state.encoded) {
    return;
  }

  const info = codec.inspectDctFile(state.encoded);
  if (candidateCount !== null) {
    state.elapsedSeconds = ((performance.now() - state.startedAt) / 1000).toFixed(2);
  }
  const candidates = candidateCount === null ? info.searchCandidateCount : candidateCount;
  const key = state.importMode === "jpeg-dct"
    ? "dct.statusReadyJpeg"
    : candidates > 0 ? "dct.statusReadyAuto" : "dct.statusReady";
  setStatus(t(key, {
    name: state.sourceName,
    quality: info.quality,
    seconds: state.elapsedSeconds,
    candidates,
  }));
}

function showProgress(autoQuality) {
  progressBar.value = 0;
  progressPercent.value = "0%";
  progressStage.textContent = autoQuality ? t("dct.progressSearching") : t("dct.progressEncoding");
  progressDetail.textContent = t("dct.progressWaiting");

  if (!progressDialog.open) {
    progressDialog.showModal();
  }
}

function renderProgress(progress) {
  const total = Math.max(1, progress.total || 1);
  const percent = Math.min(100, Math.round((progress.completed || 0) * 100 / total));
  progressBar.value = percent;
  progressPercent.value = `${percent}%`;
  progressStage.textContent = progress.stage === "full"
    ? t("dct.progressFinalists")
    : t("dct.progressSearching");
  progressDetail.textContent = t("dct.progressQuality", {
    quality: progress.quality,
    completed: progress.completed,
    total,
  });
}

function closeProgress() {
  if (progressDialog.open) {
    progressDialog.close();
  }
}

function cancelProcessing() {
  if (!state.worker) {
    closeProgress();
    return;
  }

  ++state.requestId;
  stopWorker();
  closeProgress();
  setBusy(false);
  setStatus(t("dct.statusCancelled"));
}

function stopWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
}

function readPixel(event) {
  event.preventDefault();
  readPixelAt(Number(pixelXInput.value), Number(pixelYInput.value));
}

function readPixelAt(x, y) {
  if (!state.encoded) {
    return;
  }

  const info = codec.inspectDctFile(state.encoded);
  const px = clamp(Math.trunc(x), 0, info.width - 1);
  const py = clamp(Math.trunc(y), 0, info.height - 1);
  const color = codec.sampleDctFilePixel(state.encoded, px, py);
  const mcuIndex = Math.floor(py / 16) * info.mcuColumns + Math.floor(px / 16);
  const mcu = codec.inspectDctMcu(state.encoded, mcuIndex);

  pixelXInput.value = String(px);
  pixelYInput.value = String(py);
  pixelValue.value = `RGBA(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
  pixelSwatch.style.backgroundColor = `rgb(${color.r} ${color.g} ${color.b})`;
  pixelMcu.textContent = t("dct.pixelMcu", {
    index: mcuIndex,
    offset: mcu.byteOffset,
    bytes: mcu.bytes,
  });
}

function updatePixelBounds() {
  const width = state.sourceImageData ? state.sourceImageData.width : 1;
  const height = state.sourceImageData ? state.sourceImageData.height : 1;
  pixelXInput.max = String(width - 1);
  pixelYInput.max = String(height - 1);
  pixelXInput.value = "0";
  pixelYInput.value = "0";
  pixelValue.value = "—";
  pixelMcu.textContent = "—";
  pixelSwatch.style.backgroundColor = "#11161c";
}

function downloadDctFile() {
  if (!state.encoded) {
    return;
  }

  downloadBlob(
    new Blob([state.encoded], { type: "application/octet-stream" }),
    `${baseName(state.sourceName)}-${presetSelect.value}bpp.dctbs2`
  );
}

function downloadPng() {
  if (!state.decodedImageData) {
    return;
  }

  resultCanvas.toBlob((blob) => {
    if (blob) {
      downloadBlob(blob, `${baseName(state.sourceName)}-${presetSelect.value}bpp.png`);
    } else {
      showError(new Error(t("dynamic.browserPngError")));
    }
  }, "image/png");
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function drawImageData(canvas, imageData) {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
}

function clearCanvas(canvas) {
  canvas.width = state.sourceImageData ? state.sourceImageData.width : 1;
  canvas.height = state.sourceImageData ? state.sourceImageData.height : 1;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function resetMetrics() {
  for (const element of [metricSize, metricMcus, metricRecord, metricBpp, metricRatio, metricRmse, metricPsnr]) {
    element.textContent = "—";
  }
}

function setZoom(value, viewport = resultViewport, clientX, clientY) {
  if (!state.sourceImageData) {
    return;
  }

  const nextZoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
  const stage = viewport === sourceViewport ? sourceStage : resultStage;
  const viewportBounds = viewport.getBoundingClientRect();
  const anchorClientX = clientX === undefined
    ? viewportBounds.left + viewport.clientWidth / 2
    : clientX;
  const anchorClientY = clientY === undefined
    ? viewportBounds.top + viewport.clientHeight / 2
    : clientY;
  const stageBounds = stage.getBoundingClientRect();
  const imagePoint = {
    x: (anchorClientX - stageBounds.left) / state.zoom,
    y: (anchorClientY - stageBounds.top) / state.zoom,
  };

  state.zoom = nextZoom;
  state.viewMode = "custom";
  const width = Math.max(1, Math.round(state.sourceImageData.width * state.zoom));
  const height = Math.max(1, Math.round(state.sourceImageData.height * state.zoom));

  for (const stage of [sourceStage, resultStage]) {
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
  }

  zoomLevel.value = `${Math.round(state.zoom * 100)}%`;
  zoomOutButton.disabled = state.zoom <= MIN_ZOOM;
  zoomInButton.disabled = state.zoom >= MAX_ZOOM;
  actualSizeButton.setAttribute("aria-pressed", String(state.viewMode === "actual"));
  fitImageButton.setAttribute("aria-pressed", String(state.viewMode === "fit"));

  const updatedStageBounds = stage.getBoundingClientRect();
  viewport.scrollLeft += updatedStageBounds.left + imagePoint.x * nextZoom - anchorClientX;
  viewport.scrollTop += updatedStageBounds.top + imagePoint.y * nextZoom - anchorClientY;
  state.synchronizingScroll = false;
  synchronizeScroll(
    viewport,
    viewport === sourceViewport ? resultViewport : sourceViewport
  );
}

function fitImage() {
  if (!state.sourceImageData) {
    return;
  }

  const availableWidth = Math.max(1, Math.min(sourceViewport.clientWidth, resultViewport.clientWidth) - VIEWPORT_PADDING);
  const availableHeight = Math.max(1, Math.min(sourceViewport.clientHeight, resultViewport.clientHeight) - VIEWPORT_PADDING);
  const scale = Math.min(
    availableWidth / state.sourceImageData.width,
    availableHeight / state.sourceImageData.height,
    1
  );

  setZoom(scale);
  state.viewMode = "fit";
  actualSizeButton.setAttribute("aria-pressed", "false");
  fitImageButton.setAttribute("aria-pressed", "true");
  sourceViewport.scrollLeft = resultViewport.scrollLeft = 0;
  sourceViewport.scrollTop = resultViewport.scrollTop = 0;
}

function showActualSize() {
  setZoom(1);
  state.viewMode = "actual";
  actualSizeButton.setAttribute("aria-pressed", "true");
  fitImageButton.setAttribute("aria-pressed", "false");
}

function zoomFromWheel(event) {
  if (!event.ctrlKey || !state.sourceImageData) {
    return;
  }

  event.preventDefault();
  const viewport = event.currentTarget;
  const pixelDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? event.deltaY * 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * viewport.clientHeight
      : event.deltaY;
  const nextZoom = clamp(state.zoom * Math.exp(-pixelDelta * 0.002), MIN_ZOOM, MAX_ZOOM);

  if (Math.abs(nextZoom - state.zoom) < 0.0001) {
    return;
  }

  setZoom(nextZoom, viewport, event.clientX, event.clientY);
}

function startDrag(event) {
  if (event.button !== 0) {
    return;
  }

  const viewport = event.currentTarget;
  state.drag = {
    viewport,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
  };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add("is-dragging");
}

function moveDrag(event) {
  const drag = state.drag;

  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  drag.viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.x);
  drag.viewport.scrollTop = drag.scrollTop - (event.clientY - drag.y);
}

function finishDrag(event) {
  const drag = state.drag;

  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  drag.viewport.classList.remove("is-dragging");
  state.drag = null;
}

function synchronizeScroll(source, target) {
  if (state.synchronizingScroll) {
    return;
  }

  state.synchronizingScroll = true;
  target.scrollLeft = source.scrollLeft;
  target.scrollTop = source.scrollTop;
  requestAnimationFrame(() => {
    state.synchronizingScroll = false;
  });
}

function enableViewControls(enabled) {
  for (const button of [zoomOutButton, zoomInButton, actualSizeButton, fitImageButton]) {
    button.disabled = !enabled;
  }
}

function setBusy(busy) {
  processButton.disabled = busy;
  presetSelect.disabled = busy;
  qualityInput.disabled = busy || autoQualityInput.checked;
  autoQualityInput.disabled = busy || jpegImportInput.checked;
  jpegImportInput.disabled = busy || !state.sourceJpegBytes;
  prototypeLibrarySelect.disabled = busy || jpegImportInput.checked;
  uploadButton.disabled = busy;
  imageSelect.disabled = busy;
  downloadDctButton.disabled = busy || !state.encoded;
  downloadPngButton.disabled = busy || !state.decodedImageData;
  pixelReadButton.disabled = busy || !state.encoded;
}

function updateQualityLabel() {
  qualityValue.value = autoQualityInput.checked
    ? t("dct.qualityAuto", { quality: qualityInput.value })
    : qualityInput.value;
  qualityInput.disabled = autoQualityInput.checked || Boolean(state.worker);
}

function setStatus(message, type = "") {
  statusElement.textContent = message;
  statusElement.classList.toggle("is-busy", type === "busy");
  statusElement.classList.toggle("is-error", type === "error");
}

function showError(error) {
  console.error(error);
  setStatus(error instanceof Error ? error.message : String(error), "error");
}

function releaseUploadedImage() {
  if (state.uploadedUrl) {
    URL.revokeObjectURL(state.uploadedUrl);
    state.uploadedUrl = null;
  }

  for (const option of imageSelect.querySelectorAll("option[data-uploaded]")) {
    option.remove();
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes.toLocaleString()} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function optionLabel(option) {
  return option ? option.textContent.trim() : "image";
}

function baseName(name) {
  return String(name || "image").replace(/\.[^.]+$/, "").replace(/[^a-z0-9._-]+/gi, "-") || "image";
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
