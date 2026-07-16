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
    progress: null,
    encoded: null,
    decoded: null,
    metrics: null,
    selectedX: 0,
    selectedY: 0,
    imageWidth: 0,
    imageHeight: 0,
    zoom: 1,
    viewMode: "fit",
    synchronizingScroll: false,
    viewportDrag: null,
    touches: new Map(),
    pinch: null,
  };
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 32;
  const ZOOM_FACTOR = 1.25;
  const VIEWPORT_PADDING = 28;
  const DRAG_THRESHOLD = 5;
  const DRAG_DELAY_MS = 140;
  const PROGRESS_STAGE_COUNT = 5;
  const BPAL_PROGRESS_STAGE_KEYS = {
    "preparing": "block.progressStagePreparing",
    "analyzing-blocks": "block.progressStageAnalyzing",
    "clustering-blocks": "block.progressStageBlockClustering",
    "building-palettes": "block.progressStagePalettes",
    "assigning-pixels": "block.progressStageAssignments",
    "building-block-palettes": "block.progressStageBlockPalettes",
    "encoding-pixels": "block.progressStageEncoding",
    "refining": "block.progressStageRefining",
    "finalizing": "block.progressStageFinalizing",
    "complete": "hybrid.progressStageBpalComplete",
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
  elements.progressCancelButton.addEventListener("click", cancelProcessing);
  elements.progressDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelProcessing();
  });
  elements.showModes.addEventListener("change", drawModeOverlay);
  elements.smoothScaling.addEventListener("change", updateCanvasImageRendering);
  elements.zoomOutButton.addEventListener("click", () => setZoom(state.zoom / ZOOM_FACTOR));
  elements.zoomInButton.addEventListener("click", () => setZoom(state.zoom * ZOOM_FACTOR));
  elements.actualSizeButton.addEventListener("click", showActualSize);
  elements.fitImageButton.addEventListener("click", fitImage);
  elements.sourceViewport.addEventListener("scroll", () => (
    synchronizeScroll(elements.sourceViewport, elements.resultViewport)
  ), { passive: true });
  elements.resultViewport.addEventListener("scroll", () => (
    synchronizeScroll(elements.resultViewport, elements.sourceViewport)
  ), { passive: true });
  elements.sourceViewport.addEventListener("wheel", zoomFromWheel, { passive: false });
  elements.resultViewport.addEventListener("wheel", zoomFromWheel, { passive: false });

  for (const viewport of [elements.sourceViewport, elements.resultViewport]) {
    viewport.addEventListener("pointerdown", startViewportPointer);
    viewport.addEventListener("pointermove", moveViewportPointer);
    viewport.addEventListener("pointerup", finishViewportPointer);
    viewport.addEventListener("pointercancel", finishViewportPointer);
    viewport.addEventListener("lostpointercapture", finishViewportPointer);
  }

  root.addEventListener("languagechange", renderDynamicContent);
  root.addEventListener("beforeunload", dispose);
  root.addEventListener("resize", handleResize);

  updateCanvasImageRendering();
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
      progressDialog: byId("progress-dialog"),
      progressBar: byId("progress-bar"),
      progressPercent: byId("progress-percent"),
      progressStage: byId("progress-stage"),
      progressDetail: byId("progress-detail"),
      progressStageCount: byId("progress-stage-count"),
      progressItemCount: byId("progress-item-count"),
      progressQuality: byId("progress-quality"),
      progressCancelButton: byId("progress-cancel"),
      sourceViewport: byId("source-viewport"),
      resultViewport: byId("result-viewport"),
      sourceCanvas: byId("source-canvas"),
      resultCanvas: byId("result-canvas"),
      modeCanvas: byId("mode-canvas"),
      sourceStage: byId("source-stage"),
      resultStage: byId("result-stage"),
      zoomLevel: byId("zoom-level"),
      zoomOutButton: byId("zoom-out"),
      zoomInButton: byId("zoom-in"),
      actualSizeButton: byId("actual-size"),
      fitImageButton: byId("fit-image"),
      smoothScaling: byId("smooth-scaling"),
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
      updateCanvasDisplaySize(image.naturalWidth, image.naturalHeight);
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
    startProgress({ stage: "preparing", progress: 0 });
    setBusy(true, t("hybrid.compressing"));

    const width = state.sourceImageData.width;
    const height = state.sourceImageData.height;
    const pixels = new Uint8ClampedArray(state.sourceImageData.data);
    const worker = new Worker("./src/hybrid/bpdh-worker.js?v=hybrid-2");

    state.worker = worker;
    worker.addEventListener("message", (event) => handleWorkerMessage(worker, event));
    worker.addEventListener("error", (event) => {
      if (worker === state.worker) {
        showError(new Error(event.message || t("hybrid.workerError")));
      }
    });
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

  function handleWorkerMessage(worker, event) {
    if (worker !== state.worker) {
      return;
    }

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
      closeProgress();
    }
  }

  function renderResult() {
    const decoded = state.decoded;
    const context = resizeCanvas(elements.resultCanvas, decoded.width, decoded.height);

    context.putImageData(new ImageData(decoded.pixels, decoded.width, decoded.height), 0, 0);
    resizeCanvas(elements.modeCanvas, decoded.width, decoded.height);
    applyCanvasDisplaySize();
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
    if (state.progress) {
      renderProgress(state.progress);
    }

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

  function startProgress(progress) {
    updateProgress(progress);

    if (elements.progressDialog.open) {
      return;
    }

    if (typeof elements.progressDialog.showModal === "function") {
      elements.progressDialog.showModal();
    } else {
      elements.progressDialog.setAttribute("open", "");
    }
  }

  function updateProgress(progress) {
    state.progress = { ...progress };
    renderProgress(state.progress);
  }

  function renderProgress(progress) {
    const value = clamp(Math.round(Number(progress.progress || 0) * 100), 0, 100);

    elements.progressBar.value = value;
    elements.progressBar.textContent = `${value}%`;
    elements.progressPercent.value = `${value}%`;
    elements.progressStage.textContent = t(progressStageKey(progress.stage));
    elements.progressStageCount.textContent = `${progressStageIndex(progress.stage)} / ${PROGRESS_STAGE_COUNT}`;
    elements.progressItemCount.textContent = formatProgressCount(progress.completed, progress.total);
    elements.progressQuality.textContent = Number.isFinite(progress.quality)
      ? formatInteger(progress.quality)
      : "—";

    if (Number.isFinite(progress.quality) && Number.isFinite(progress.completed) && Number.isFinite(progress.total)) {
      elements.progressDetail.textContent = t("hybrid.progressDctCandidate", {
        quality: formatInteger(progress.quality),
        completed: formatInteger(progress.completed),
        total: formatInteger(progress.total),
      });
    } else if (Number.isFinite(progress.iteration) && Number.isFinite(progress.totalIterations)) {
      elements.progressDetail.textContent = t("block.progressIteration", {
        current: formatInteger(progress.iteration),
        total: formatInteger(progress.totalIterations),
      });
    } else if (Number.isFinite(progress.completed) && Number.isFinite(progress.total)) {
      elements.progressDetail.textContent = t("block.progressItems", {
        completed: formatInteger(progress.completed),
        total: formatInteger(progress.total),
      });
    } else {
      elements.progressDetail.textContent = t("block.progressWaiting");
    }
  }

  function progressStageKey(stage) {
    if (typeof stage === "string" && stage.startsWith("bpal-")) {
      return BPAL_PROGRESS_STAGE_KEYS[stage.slice(5)] || "hybrid.progressStageBpal";
    }

    if (stage === "transforming-dct") {
      return "hybrid.progressStageDctTransform";
    }

    if (stage === "evaluating-dct") {
      return "hybrid.progressStageDctEvaluate";
    }

    if (stage === "complete") {
      return "block.progressStageComplete";
    }

    return "block.progressStagePreparing";
  }

  function progressStageIndex(stage) {
    if (typeof stage === "string" && stage.startsWith("bpal-")) {
      return 2;
    }

    if (stage === "transforming-dct") {
      return 3;
    }

    if (stage === "evaluating-dct") {
      return 4;
    }

    return stage === "complete" ? 5 : 1;
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
    if (elements.progressDialog.open) {
      if (typeof elements.progressDialog.close === "function") {
        elements.progressDialog.close();
      } else {
        elements.progressDialog.removeAttribute("open");
      }
    }

    state.progress = null;
  }

  function cancelProcessing() {
    if (!state.worker) {
      closeProgress();
      return;
    }

    terminateWorker();
    closeProgress();
    setBusy(false, t("hybrid.progressCancelled"));
  }

  function setBusy(isBusy, message) {
    elements.status.classList.toggle("is-busy", isBusy);
    elements.status.classList.remove("is-error");
    elements.status.textContent = message;
    elements.processButton.disabled = isBusy;
  }

  function showError(error) {
    terminateWorker();
    closeProgress();
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

  function updateCanvasDisplaySize(width, height) {
    state.imageWidth = width;
    state.imageHeight = height;
    setZoomControlsEnabled(true);
    fitImage();
  }

  function applyCanvasDisplaySize() {
    const displayWidth = `${state.imageWidth * state.zoom}px`;
    const displayHeight = `${state.imageHeight * state.zoom}px`;

    for (const stage of [elements.sourceStage, elements.resultStage]) {
      stage.style.width = displayWidth;
      stage.style.height = displayHeight;
    }

    elements.zoomLevel.value = `${formatZoom(state.zoom)}%`;
    elements.zoomOutButton.disabled = state.zoom <= MIN_ZOOM;
    elements.zoomInButton.disabled = state.zoom >= MAX_ZOOM;
  }

  function updateCanvasImageRendering() {
    const pixelated = !elements.smoothScaling.checked;

    for (const stage of [elements.sourceStage, elements.resultStage]) {
      stage.classList.toggle("is-pixelated", pixelated);
    }
  }

  function fitImage() {
    if (!state.imageWidth || !state.imageHeight) {
      return;
    }

    const availableWidth = Math.max(1, Math.min(
      elements.sourceViewport.clientWidth,
      elements.resultViewport.clientWidth
    ) - VIEWPORT_PADDING);
    const availableHeight = Math.max(1, Math.min(
      elements.sourceViewport.clientHeight,
      elements.resultViewport.clientHeight
    ) - VIEWPORT_PADDING);
    const fittedZoom = Math.min(
      availableWidth / state.imageWidth,
      availableHeight / state.imageHeight
    );

    setViewMode("fit");
    setZoom(fittedZoom, elements.resultViewport, undefined, undefined, true);
  }

  function showActualSize() {
    if (!state.imageWidth || !state.imageHeight) {
      return;
    }

    setViewMode("actual");
    setZoom(1, elements.resultViewport, undefined, undefined, true);
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    elements.fitImageButton.setAttribute("aria-pressed", String(mode === "fit"));
    elements.actualSizeButton.setAttribute("aria-pressed", String(mode === "actual"));
  }

  function setZoom(value, viewport = elements.resultViewport, clientX, clientY, forceCenter = false, fixedImagePoint) {
    if (!state.imageWidth || !state.imageHeight) {
      return;
    }

    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    const stage = viewport === elements.sourceViewport ? elements.sourceStage : elements.resultStage;
    let anchorClientX = clientX;
    let anchorClientY = clientY;
    let imagePoint = fixedImagePoint;

    if (!forceCenter) {
      const viewportBounds = viewport.getBoundingClientRect();

      anchorClientX = clientX === undefined
        ? viewportBounds.left + viewport.clientWidth / 2
        : clientX;
      anchorClientY = clientY === undefined
        ? viewportBounds.top + viewport.clientHeight / 2
        : clientY;

      if (!imagePoint) {
        const stageBounds = stage.getBoundingClientRect();

        imagePoint = {
          x: (anchorClientX - stageBounds.left) / state.zoom,
          y: (anchorClientY - stageBounds.top) / state.zoom,
        };
      }
    }

    state.zoom = nextZoom;
    applyCanvasDisplaySize();

    if (forceCenter) {
      centerViewports();
      return;
    }

    setViewMode("custom");
    const updatedStageBounds = stage.getBoundingClientRect();

    viewport.scrollLeft += updatedStageBounds.left + imagePoint.x * nextZoom - anchorClientX;
    viewport.scrollTop += updatedStageBounds.top + imagePoint.y * nextZoom - anchorClientY;
    state.synchronizingScroll = false;
    synchronizeScroll(
      viewport,
      viewport === elements.sourceViewport ? elements.resultViewport : elements.sourceViewport
    );
  }

  function centerViewports() {
    state.synchronizingScroll = true;

    for (const viewport of [elements.sourceViewport, elements.resultViewport]) {
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
    }

    root.requestAnimationFrame(() => {
      state.synchronizingScroll = false;
    });
  }

  function setZoomControlsEnabled(enabled) {
    elements.actualSizeButton.disabled = !enabled;
    elements.fitImageButton.disabled = !enabled;

    if (!enabled) {
      elements.zoomOutButton.disabled = true;
      elements.zoomInButton.disabled = true;
    }
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
    root.requestAnimationFrame(() => {
      state.synchronizingScroll = false;
    });
  }

  function startViewportPointer(event) {
    if (event.pointerType === "touch") {
      startViewportTouch(event);
      return;
    }

    startViewportDrag(event);
  }

  function moveViewportPointer(event) {
    if (state.touches.has(event.pointerId)) {
      moveViewportTouch(event);
      return;
    }

    moveViewportDrag(event);
  }

  function finishViewportPointer(event) {
    if (state.touches.has(event.pointerId)) {
      finishViewportTouch(event);
      return;
    }

    finishViewportDrag(event);
  }

  function startViewportTouch(event) {
    if (!state.imageWidth || !state.imageHeight) {
      return;
    }

    const viewport = event.currentTarget;
    const [activeTouch] = state.touches.values();

    if ((activeTouch && activeTouch.viewport !== viewport) || state.touches.size >= 2) {
      event.preventDefault();
      return;
    }

    state.touches.set(event.pointerId, {
      id: event.pointerId,
      viewport,
      x: event.clientX,
      y: event.clientY,
    });

    if (state.touches.size === 1) {
      startViewportDrag(event);
    } else {
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch (_error) {
        // Synthetic pointer events used by tests may not have a capturable pointer.
      }

      startViewportPinch(viewport);
    }

    event.preventDefault();
  }

  function moveViewportTouch(event) {
    const touch = state.touches.get(event.pointerId);

    touch.x = event.clientX;
    touch.y = event.clientY;

    if (state.pinch && state.pinch.viewport === event.currentTarget && state.touches.size === 2) {
      const [first, second] = state.touches.values();
      const distance = Math.max(1, getTouchDistance(first, second));
      const center = getTouchCenter(first, second);
      const nextZoom = state.pinch.startZoom * distance / state.pinch.startDistance;

      setZoom(nextZoom, state.pinch.viewport, center.x, center.y, false, {
        x: state.pinch.imageX,
        y: state.pinch.imageY,
      });
    } else {
      moveViewportDrag(event);
    }

    event.preventDefault();
  }

  function startViewportPinch(viewport) {
    const [first, second] = state.touches.values();
    const center = getTouchCenter(first, second);
    const stage = viewport === elements.sourceViewport ? elements.sourceStage : elements.resultStage;
    const stageBounds = stage.getBoundingClientRect();

    state.viewportDrag = null;
    state.pinch = {
      viewport,
      startDistance: Math.max(1, getTouchDistance(first, second)),
      startZoom: state.zoom,
      imageX: (center.x - stageBounds.left) / state.zoom,
      imageY: (center.y - stageBounds.top) / state.zoom,
    };
    viewport.classList.add("is-dragging");
  }

  function finishViewportTouch(event) {
    const touch = state.touches.get(event.pointerId);
    const viewport = touch.viewport;

    state.touches.delete(event.pointerId);

    if (state.pinch && state.pinch.viewport === viewport) {
      state.pinch = null;
      state.viewportDrag = null;
      viewport.classList.remove("is-dragging");

      if (state.touches.size === 1) {
        const [remainingTouch] = state.touches.values();

        beginViewportDrag(
          viewport,
          remainingTouch.id,
          remainingTouch.x,
          remainingTouch.y,
          event.timeStamp - DRAG_DELAY_MS
        );
      }
    } else if (state.viewportDrag && state.viewportDrag.pointerId === event.pointerId) {
      state.viewportDrag = null;
      viewport.classList.remove("is-dragging");
    }

    if (event.type !== "lostpointercapture" && viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  }

  function getTouchDistance(first, second) {
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function getTouchCenter(first, second) {
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
  }

  function startViewportDrag(event) {
    if (event.button !== 0 || !state.imageWidth || !state.imageHeight) {
      return;
    }

    const viewport = event.currentTarget;

    if (viewport === elements.resultViewport && isPointerInsideResultCanvas(event)) {
      selectPixelFromPointer(event);
    }

    beginViewportDrag(
      viewport,
      event.pointerId,
      event.clientX,
      event.clientY,
      event.timeStamp
    );

    try {
      viewport.setPointerCapture(event.pointerId);
    } catch (_error) {
      // Synthetic pointer events used by tests may not have a capturable pointer.
    }
  }

  function beginViewportDrag(viewport, pointerId, startX, startY, startedAt) {
    state.viewportDrag = {
      viewport,
      pointerId,
      startX,
      startY,
      startedAt,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      active: false,
      moved: false,
    };
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
      drag.viewport === elements.sourceViewport ? elements.resultViewport : elements.sourceViewport
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
    const bounds = elements.resultCanvas.getBoundingClientRect();

    return event.clientX >= bounds.left && event.clientX < bounds.right &&
      event.clientY >= bounds.top && event.clientY < bounds.bottom;
  }

  function zoomFromWheel(event) {
    if (!event.ctrlKey || !state.imageWidth || !state.imageHeight) {
      return;
    }

    event.preventDefault();
    const viewport = event.currentTarget;
    const pixelDelta = event.deltaMode === root.WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * 16
      : event.deltaMode === root.WheelEvent.DOM_DELTA_PAGE
        ? event.deltaY * viewport.clientHeight
        : event.deltaY;
    const nextZoom = Math.min(MAX_ZOOM, Math.max(
      MIN_ZOOM,
      state.zoom * Math.exp(-pixelDelta * 0.002)
    ));

    if (Math.abs(nextZoom - state.zoom) < 0.0001) {
      return;
    }

    setZoom(nextZoom, viewport, event.clientX, event.clientY);
  }

  function handleResize() {
    if (!state.imageWidth || !state.imageHeight) {
      return;
    }

    if (state.viewMode === "fit") {
      fitImage();
    } else if (state.viewMode === "actual") {
      showActualSize();
    } else {
      setZoom(state.zoom);
    }
  }

  function formatZoom(value) {
    const percent = value * 100;

    return percent < 10 ? percent.toFixed(1) : String(Math.round(percent));
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

  function formatInteger(value) {
    return formatNumber(value, 0);
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
