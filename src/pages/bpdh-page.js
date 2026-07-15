(function (root) {
  "use strict";

  const format = root.BpdhFormat;
  const i18n = root.I18n;
  const elements = collectElements();
  const state = {
    sourceImageData: null,
    sourceName: "image",
    uploadedUrl: null,
    worker: null,
    encoded: null,
    decoded: null,
    metrics: null,
    selectedX: 0,
    selectedY: 0,
  };

  elements.controls.addEventListener("submit", (event) => {
    event.preventDefault();
    processImage();
  });
  elements.imageUrl.addEventListener("change", () => loadImage(elements.imageUrl.value));
  elements.uploadButton.addEventListener("click", () => elements.imageFile.click());
  elements.imageFile.addEventListener("change", handleUpload);
  elements.downloadFileButton.addEventListener("click", downloadBpdh);
  elements.downloadPngButton.addEventListener("click", downloadPng);
  elements.showModes.addEventListener("change", drawModeOverlay);
  elements.resultCanvas.addEventListener("click", selectPixelFromPointer);
  root.addEventListener("languagechange", renderDynamicContent);
  root.addEventListener("beforeunload", dispose);

  loadImage(elements.imageUrl.value);

  function collectElements() {
    const byId = (id) => document.getElementById(id);

    return {
      controls: byId("controls"),
      imageUrl: byId("image-url"),
      imageFile: byId("image-file"),
      uploadButton: byId("upload-button"),
      processButton: byId("process-button"),
      downloadFileButton: byId("download-file-button"),
      downloadPngButton: byId("download-png-button"),
      targetBpp: byId("target-bpp"),
      codecMode: byId("codec-mode"),
      dctSearch: byId("dct-search"),
      localColorCount: byId("local-color-count"),
      globalColorCount: byId("global-color-count"),
      paletteCount: byId("palette-count"),
      paletteColorBits: byId("palette-color-bits"),
      colorSpace: byId("color-space"),
      clusteringMethod: byId("clustering-method"),
      refinementPasses: byId("refinement-passes"),
      status: byId("status"),
      progressBar: byId("progress-bar"),
      progressLabel: byId("progress-label"),
      sourceCanvas: byId("source-canvas"),
      resultCanvas: byId("result-canvas"),
      modeCanvas: byId("mode-canvas"),
      sourceStage: byId("source-stage"),
      resultStage: byId("result-stage"),
      showModes: byId("show-modes"),
      dimensions: byId("metric-dimensions"),
      fileSize: byId("metric-file-size"),
      bitsPerPixel: byId("metric-bpp"),
      psnr: byId("metric-psnr"),
      rmse: byId("metric-rmse"),
      modes: byId("metric-modes"),
      duration: byId("metric-time"),
      targetResult: byId("target-result"),
      storageHeader: byId("storage-header"),
      storagePalettes: byId("storage-palettes"),
      storagePalettesNote: byId("storage-palettes-note"),
      storageTables: byId("storage-tables"),
      storageMap: byId("storage-map"),
      storageMapNote: byId("storage-map-note"),
      storageBpal: byId("storage-bpal"),
      storageBpalNote: byId("storage-bpal-note"),
      storageDct: byId("storage-dct"),
      storageDctNote: byId("storage-dct-note"),
      storageTotal: byId("storage-total"),
      storageTotalNote: byId("storage-total-note"),
      legendBpalCount: byId("legend-bpal-count"),
      legendDctCount: byId("legend-dct-count"),
      selectedUnit: byId("selected-unit"),
      pixelCoordinate: byId("pixel-coordinate"),
      pixelMode: byId("pixel-mode"),
      pixelFullColor: byId("pixel-full-color"),
      pixelSampledColor: byId("pixel-sampled-color"),
      pixelMatch: byId("pixel-match"),
      pixelMatchCard: byId("pixel-match").parentElement,
      pixelSwatch: byId("pixel-swatch"),
    };
  }

  async function loadImage(url) {
    setBusy(true, t("hybrid.loading"));

    try {
      const image = await loadHtmlImage(url);
      const context = resizeCanvas(elements.sourceCanvas, image.naturalWidth, image.naturalHeight);

      context.drawImage(image, 0, 0);
      state.sourceImageData = context.getImageData(0, 0, image.naturalWidth, image.naturalHeight);
      state.sourceName = fileStem(url);
      setStageSize(elements.sourceStage, image.naturalWidth, image.naturalHeight);
      await processImage();
    } catch (error) {
      showError(error);
    }
  }

  function loadHtmlImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(t("hybrid.imageError")));
      image.src = url;
    });
  }

  function handleUpload() {
    const file = elements.imageFile.files && elements.imageFile.files[0];

    if (!file) {
      return;
    }

    if (state.uploadedUrl) {
      URL.revokeObjectURL(state.uploadedUrl);
    }

    state.uploadedUrl = URL.createObjectURL(file);
    state.sourceName = fileStem(file.name);
    elements.imageUrl.value = "";
    loadImage(state.uploadedUrl).then(() => {
      state.sourceName = fileStem(file.name);
    });
  }

  async function processImage() {
    if (!state.sourceImageData) {
      return;
    }

    terminateWorker();
    state.encoded = null;
    state.decoded = null;
    state.metrics = null;
    elements.downloadFileButton.disabled = true;
    elements.downloadPngButton.disabled = true;
    updateProgress({ stage: "preparing", progress: 0 });
    setBusy(true, t("hybrid.compressing"));

    const width = state.sourceImageData.width;
    const height = state.sourceImageData.height;
    const pixels = new Uint8ClampedArray(state.sourceImageData.data);
    const worker = new Worker("./src/hybrid/bpdh-worker.js?v=hybrid-1");

    state.worker = worker;
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", (event) => showError(new Error(event.message || t("hybrid.workerError"))));
    worker.postMessage({
      width,
      height,
      pixels: pixels.buffer,
      settings: readSettings(width, height),
    }, [pixels.buffer]);
  }

  function readSettings(width, height) {
    const requestedPaletteCount = Number(elements.paletteCount.value);
    const blockCount = Math.ceil(width / format.CODING_UNIT_SIZE) *
      Math.ceil(height / format.CODING_UNIT_SIZE);

    return {
      targetBitsPerPixel: Number(elements.targetBpp.value),
      mode: elements.codecMode.value,
      dctQualities: dctQualities(elements.dctSearch.value),
      bpal: {
        blockSize: format.CODING_UNIT_SIZE,
        localColorCount: Number(elements.localColorCount.value),
        globalColorCount: Number(elements.globalColorCount.value),
        paletteCount: largestPowerOfTwo(Math.min(requestedPaletteCount, blockCount)),
        paletteColorBits: Number(elements.paletteColorBits.value),
        colorSpace: elements.colorSpace.value,
        clusteringMethod: elements.clusteringMethod.value,
        dithering: "none",
        diversity: 0,
        refinementPasses: Number(elements.refinementPasses.value),
      },
    };
  }

  function dctQualities(value) {
    if (value === "balanced") {
      return [25, 35, 45, 55, 65, 75, 85, 92];
    }

    if (value === "fast") {
      return [35, 55, 75, 90];
    }

    return [Number(value)];
  }

  function handleWorkerMessage(event) {
    const message = event.data || {};

    if (message.type === "progress") {
      updateProgress(message.progress || {});
      return;
    }

    if (message.type === "error") {
      showError(new Error(message.error || t("hybrid.workerError")));
      return;
    }

    if (message.type !== "complete") {
      return;
    }

    try {
      state.encoded = new Uint8Array(message.file);
      state.decoded = format.decodeBpdhFile(state.encoded);
      state.metrics = message.metrics || {};
      state.selectedX = Math.min(state.selectedX, state.decoded.width - 1);
      state.selectedY = Math.min(state.selectedY, state.decoded.height - 1);
      renderResult();
      updateProgress({ stage: "complete", progress: 1 });
      setBusy(false, t("hybrid.done", {
        bpal: state.decoded.bpalBlockCount,
        dct: state.decoded.dctBlockCount,
        bpp: formatNumber(state.decoded.storage.bitsPerPixel, 3),
      }));
      elements.downloadFileButton.disabled = false;
      elements.downloadPngButton.disabled = false;
      root.__bpdhResult = {
        width: state.decoded.width,
        height: state.decoded.height,
        bytes: state.encoded.byteLength,
        bpalBlocks: state.decoded.bpalBlockCount,
        dctBlocks: state.decoded.dctBlockCount,
        coordinateSampleMatches: verifyCoordinateSample(state.selectedX, state.selectedY),
      };
    } catch (error) {
      showError(error);
    } finally {
      terminateWorker();
    }
  }

  function renderResult() {
    const decoded = state.decoded;
    const context = resizeCanvas(elements.resultCanvas, decoded.width, decoded.height);

    context.putImageData(new ImageData(decoded.pixels, decoded.width, decoded.height), 0, 0);
    resizeCanvas(elements.modeCanvas, decoded.width, decoded.height);
    setStageSize(elements.resultStage, decoded.width, decoded.height);
    renderMetrics();
    drawModeOverlay();
    renderInspector();
  }

  function renderMetrics() {
    if (!state.decoded || !state.metrics) {
      return;
    }

    const decoded = state.decoded;
    const storage = decoded.storage;
    const metrics = state.metrics;
    const rmse = Math.sqrt(metrics.meanSquaredError || 0);

    elements.dimensions.textContent = `${decoded.width} × ${decoded.height}`;
    elements.fileSize.textContent = formatBytes(storage.totalBytes);
    elements.bitsPerPixel.textContent = `${formatNumber(storage.bitsPerPixel, 3)} bpp`;
    elements.psnr.textContent = Number.isFinite(metrics.psnr)
      ? `${formatNumber(metrics.psnr, 2)} dB`
      : "∞ dB";
    elements.rmse.textContent = formatNumber(rmse, 3);
    elements.modes.textContent = `${decoded.bpalBlockCount} / ${decoded.dctBlockCount}`;
    elements.duration.textContent = `${formatNumber(metrics.durationMs, 1)} ms`;
    elements.targetResult.textContent = t(
      metrics.withinTarget ? "hybrid.targetMet" : "hybrid.targetMissed",
      { target: formatNumber(metrics.targetBitsPerPixel, 2) }
    );
    elements.targetResult.classList.toggle("is-missed", !metrics.withinTarget);

    elements.storageHeader.textContent = formatBytes(format.HEADER_BYTES);
    elements.storagePalettes.textContent = formatBytes(storage.paletteBytes);
    elements.storagePalettesNote.textContent = t("hybrid.paletteInfo", {
      count: decoded.bpalBlockCount ? decoded.paletteCount : 0,
      colors: decoded.bpalBlockCount ? decoded.globalColorCount : 0,
    });
    elements.storageTables.textContent = formatBytes(storage.quantizationTableBytes);
    elements.storageMap.textContent = formatBytes(storage.modeMapBytes);
    elements.storageMapNote.textContent = t("hybrid.mapBits", { blocks: decoded.blockCount });
    elements.storageBpal.textContent = formatBytes(storage.bpalBytes);
    elements.storageBpalNote.textContent = t("hybrid.blockBytes", { blocks: decoded.bpalBlockCount });
    elements.storageDct.textContent = formatBytes(storage.dctBytes);
    elements.storageDctNote.textContent = t("hybrid.dctInfo", {
      blocks: decoded.dctBlockCount,
      quality: metrics.dctQuality === null ? "—" : metrics.dctQuality,
    });
    elements.storageTotal.textContent = formatBytes(storage.totalBytes);
    elements.storageTotalNote.textContent = t("hybrid.fileInfo", {
      bpp: formatNumber(storage.fileBitsPerPixel, 3),
    });
    elements.legendBpalCount.textContent = String(decoded.bpalBlockCount);
    elements.legendDctCount.textContent = String(decoded.dctBlockCount);
  }

  function drawModeOverlay() {
    const decoded = state.decoded;
    const context = elements.modeCanvas.getContext("2d");

    context.clearRect(0, 0, elements.modeCanvas.width, elements.modeCanvas.height);

    if (!decoded || !elements.showModes.checked) {
      return;
    }

    for (let blockIndex = 0; blockIndex < decoded.blockCount; blockIndex += 1) {
      const blockX = blockIndex % decoded.blocksX;
      const blockY = Math.floor(blockIndex / decoded.blocksX);
      const x = blockX * decoded.codingUnitSize;
      const y = blockY * decoded.codingUnitSize;
      const width = Math.min(decoded.codingUnitSize, decoded.width - x);
      const height = Math.min(decoded.codingUnitSize, decoded.height - y);
      const isDct = decoded.modes[blockIndex] === format.MODE_DCT;

      context.fillStyle = isDct ? "rgba(255, 155, 66, 0.24)" : "rgba(47, 140, 255, 0.24)";
      context.fillRect(x, y, width, height);
      context.strokeStyle = isDct ? "rgba(255, 180, 105, 0.8)" : "rgba(106, 174, 255, 0.8)";
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
    }

    const selectedBlockX = Math.floor(state.selectedX / decoded.codingUnitSize);
    const selectedBlockY = Math.floor(state.selectedY / decoded.codingUnitSize);
    context.strokeStyle = "#fff06a";
    context.lineWidth = 2;
    context.strokeRect(
      selectedBlockX * decoded.codingUnitSize + 1,
      selectedBlockY * decoded.codingUnitSize + 1,
      Math.min(decoded.codingUnitSize, decoded.width - selectedBlockX * decoded.codingUnitSize) - 2,
      Math.min(decoded.codingUnitSize, decoded.height - selectedBlockY * decoded.codingUnitSize) - 2
    );
  }

  function selectPixelFromPointer(event) {
    if (!state.decoded) {
      return;
    }

    const rect = elements.resultCanvas.getBoundingClientRect();
    state.selectedX = clamp(Math.floor((event.clientX - rect.left) * state.decoded.width / rect.width), 0, state.decoded.width - 1);
    state.selectedY = clamp(Math.floor((event.clientY - rect.top) * state.decoded.height / rect.height), 0, state.decoded.height - 1);
    renderInspector();
    drawModeOverlay();
  }

  function renderInspector() {
    if (!state.decoded) {
      return;
    }

    const decoded = state.decoded;
    const x = state.selectedX;
    const y = state.selectedY;
    const blockX = Math.floor(x / decoded.codingUnitSize);
    const blockY = Math.floor(y / decoded.codingUnitSize);
    const blockIndex = blockY * decoded.blocksX + blockX;
    const isDct = decoded.modes[blockIndex] === format.MODE_DCT;
    const sampled = format.sampleBpdhPixel(decoded, x, y);
    const offset = (y * decoded.width + x) * 4;
    const full = {
      r: decoded.pixels[offset],
      g: decoded.pixels[offset + 1],
      b: decoded.pixels[offset + 2],
      a: decoded.pixels[offset + 3],
    };
    const matches = colorsEqual(sampled, full);
    const modeName = t(isDct ? "hybrid.modeLabelDct" : "hybrid.modeLabelBpal");

    elements.selectedUnit.textContent = t("hybrid.unitLabel", {
      index: blockIndex,
      x: blockX,
      y: blockY,
    });
    elements.pixelCoordinate.textContent = `${x}, ${y}`;
    elements.pixelMode.textContent = modeName;
    elements.pixelFullColor.textContent = colorText(full);
    elements.pixelSampledColor.textContent = colorText(sampled);
    elements.pixelMatch.textContent = t(matches ? "hybrid.match" : "hybrid.mismatch");
    elements.pixelMatchCard.classList.toggle("is-match", matches);
    elements.pixelMatchCard.classList.toggle("is-mismatch", !matches);
    elements.pixelSwatch.style.backgroundColor = `rgb(${sampled.r}, ${sampled.g}, ${sampled.b})`;
  }

  function verifyCoordinateSample(x, y) {
    const sampled = format.sampleBpdhPixel(state.decoded, x, y);
    const offset = (y * state.decoded.width + x) * 4;

    return sampled.r === state.decoded.pixels[offset] &&
      sampled.g === state.decoded.pixels[offset + 1] &&
      sampled.b === state.decoded.pixels[offset + 2] &&
      sampled.a === state.decoded.pixels[offset + 3];
  }

  function renderDynamicContent() {
    if (state.decoded) {
      renderMetrics();
      renderInspector();
      setBusy(false, t("hybrid.done", {
        bpal: state.decoded.bpalBlockCount,
        dct: state.decoded.dctBlockCount,
        bpp: formatNumber(state.decoded.storage.bitsPerPixel, 3),
      }));
    }
  }

  function updateProgress(progress) {
    const value = clamp(Math.round(Number(progress.progress || 0) * 100), 0, 100);
    elements.progressBar.value = value;
    elements.progressBar.textContent = `${value}%`;
    elements.progressLabel.value = `${value}%`;
  }

  function setBusy(isBusy, message) {
    elements.status.classList.toggle("is-busy", isBusy);
    elements.status.classList.remove("is-error");
    elements.status.textContent = message;
    elements.processButton.disabled = isBusy;
  }

  function showError(error) {
    terminateWorker();
    elements.status.classList.remove("is-busy");
    elements.status.classList.add("is-error");
    elements.status.textContent = error && error.message ? error.message : String(error);
    elements.processButton.disabled = false;
  }

  function downloadBpdh() {
    if (state.encoded) {
      downloadBlob(new Blob([state.encoded], { type: "application/octet-stream" }), `${state.sourceName}.bpdh`);
    }
  }

  function downloadPng() {
    elements.resultCanvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, `${state.sourceName}-bpdh.png`);
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

  function resizeCanvas(canvas, width, height) {
    canvas.width = width;
    canvas.height = height;
    return canvas.getContext("2d");
  }

  function setStageSize(stage, width, height) {
    const scale = Math.max(1, Math.min(4, Math.floor(384 / Math.max(width, height))));

    stage.style.width = `${width * scale}px`;
    stage.style.height = `${height * scale}px`;
  }

  function terminateWorker() {
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }

    elements.processButton.disabled = false;
  }

  function dispose() {
    terminateWorker();

    if (state.uploadedUrl) {
      URL.revokeObjectURL(state.uploadedUrl);
    }
  }

  function largestPowerOfTwo(value) {
    let result = 1;

    while (result * 2 <= value) {
      result *= 2;
    }

    return result;
  }

  function colorsEqual(left, right) {
    return left.r === right.r && left.g === right.g && left.b === right.b && left.a === right.a;
  }

  function colorText(color) {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${formatNumber(bytes / 1024, 2)} KiB`;
    }

    return `${formatNumber(bytes / (1024 * 1024), 2)} MiB`;
  }

  function formatNumber(value, maximumFractionDigits) {
    return i18n.formatNumber(value, { maximumFractionDigits });
  }

  function fileStem(value) {
    const clean = String(value).split(/[\\/]/).pop().split(/[?#]/)[0];
    return clean.replace(/\.[^.]+$/, "") || "image";
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function t(key, parameters) {
    return i18n.t(key, parameters);
  }
})(typeof self !== "undefined" ? self : globalThis);
