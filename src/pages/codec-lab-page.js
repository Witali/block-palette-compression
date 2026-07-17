(function (root) {
  "use strict";

  const i18n = root.I18n;
  const t = (key, parameters) => i18n.t(key, parameters);
  const byId = (id) => document.getElementById(id);
  const elements = collectElements();
  const state = {
    format: "bpal",
    sourceImageData: null,
    sourceBytes: null,
    sourceMime: "",
    sourceName: "image",
    result: null,
    worker: null,
    workerReject: null,
    requestId: 0,
    sourceKey: null,
    pendingFile: null,
    busy: false,
    guideComponent: "y",
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
  const QUALITY_PRESET_BITS_PER_PIXEL = Object.freeze(Object.keys(QUALITY_PRESETS).map(Number));
  const BPAL_PROGRESS_STAGES = Object.freeze([
    "preparing", "analyzing-blocks", "clustering-blocks", "building-palettes",
    "assigning-pixels", "building-block-palettes", "encoding-pixels", "refining", "finalizing",
  ]);
  const BPAL_PROGRESS_STAGE_KEYS = Object.freeze({
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
  });

  const formatAdapters = {
    bpal: createBpalAdapter(),
    dct: createDctAdapter(),
    bpdh: createBpdhAdapter(),
    astc: createStandardTextureAdapter("astc"),
    bc1: createStandardTextureAdapter("bc1"),
    bc7: createStandardTextureAdapter("bc7"),
  };

  const comparison = new root.CodecComparisonView({
    sourceViewport: elements.sourceViewport,
    resultViewport: elements.resultViewport,
    sourceStage: elements.sourceStage,
    resultStage: elements.resultStage,
    sourceCanvas: elements.sourceCanvas,
    resultCanvas: elements.resultCanvas,
    differenceCanvas: elements.differenceCanvas,
    overlayCanvas: elements.overlayCanvas,
    zoomOut: elements.zoomOut,
    zoomIn: elements.zoomIn,
    zoomLevel: elements.zoomLevel,
    actualSize: elements.actualSize,
    fitImage: elements.fitImage,
    smoothScaling: elements.smoothScaling,
    differenceToggle: elements.showDifference,
  }, {
    onSelect: (x, y) => renderInspector(x, y),
  });

  bindEvents();
  selectInitialFormat();
  updateRangeLabels();
  updateFormatUi();
  setStatus(t("lab.readyToEncode"));

  function collectElements() {
    return {
      controls: byId("lab-controls"),
      codecFormat: byId("codec-format"),
      formatDescription: byId("format-description"),
      imageUrl: byId("image-url"),
      imageFile: byId("image-file"),
      uploadButton: byId("upload-button"),
      processButton: byId("process-button"),
      optimizeBpal: byId("optimize-bpal"),
      downloadFile: byId("download-file"),
      downloadPng: byId("download-png"),
      status: byId("status"),
      metricDimensions: byId("metric-dimensions"),
      metricSize: byId("metric-size"),
      metricBpp: byId("metric-bpp"),
      metricRatio: byId("metric-ratio"),
      metricRmse: byId("metric-rmse"),
      metricPsnr: byId("metric-psnr"),
      metricTime: byId("metric-time"),
      metricModeSplit: byId("metric-mode-split"),
      metricModeSplitValue: byId("metric-mode-split-value"),
      sourceViewport: byId("source-viewport"),
      resultViewport: byId("result-viewport"),
      sourceStage: byId("source-stage"),
      resultStage: byId("result-stage"),
      sourceCanvas: byId("source-canvas"),
      resultCanvas: byId("result-canvas"),
      differenceCanvas: byId("difference-canvas"),
      overlayCanvas: byId("overlay-canvas"),
      zoomOut: byId("zoom-out"),
      zoomIn: byId("zoom-in"),
      zoomLevel: byId("zoom-level"),
      actualSize: byId("actual-size"),
      fitImage: byId("fit-image"),
      smoothScaling: byId("smooth-scaling"),
      showDifference: byId("show-difference"),
      showOverlay: byId("show-overlay"),
      bpdhModeLegend: byId("bpdh-mode-legend"),
      bpdhBpalCount: byId("bpdh-bpal-count"),
      bpdhDctCount: byId("bpdh-dct-count"),
      resultCaption: byId("result-caption"),
      formatGuideSummary: byId("format-guide-summary"),
      formatGuideBody: byId("format-guide-body"),
      structureTitle: byId("structure-title"),
      structureDescription: byId("structure-description"),
      structureSummary: byId("structure-summary"),
      structureFlow: byId("structure-flow"),
      bpalPaletteSections: byId("bpal-palette-sections"),
      bpalBlockLabel: byId("lab-bpal-block-label"),
      bpalBlockPalette: byId("lab-bpal-block-palette"),
      bpalPaletteSummary: byId("lab-bpal-palette-summary"),
      bpalGlobalPalette: byId("lab-bpal-global-palette"),
      selectedUnit: byId("selected-unit"),
      pixelCoordinate: byId("pixel-coordinate"),
      pixelSourceColor: byId("pixel-source-color"),
      pixelFullColor: byId("pixel-full-color"),
      pixelSampledColor: byId("pixel-sampled-color"),
      pixelMatch: byId("pixel-match"),
      pixelMatchCard: byId("pixel-match").parentElement,
      pixelSwatch: byId("pixel-swatch"),
      blockDetailsBody: byId("block-details-body"),
      coordinateForm: byId("coordinate-form"),
      coordinateX: byId("coordinate-x"),
      coordinateY: byId("coordinate-y"),
      progressDialog: byId("progress-dialog"),
      progressEyebrow: byId("progress-eyebrow"),
      progressBar: byId("progress-bar"),
      progressPercent: byId("progress-percent"),
      progressStage: byId("progress-stage"),
      progressDetail: byId("progress-detail"),
      progressStageCount: byId("progress-stage-count"),
      progressPrimaryLabel: byId("progress-primary-label"),
      progressPrimaryValue: byId("progress-primary-value"),
      progressSecondaryLabel: byId("progress-secondary-label"),
      progressSecondaryValue: byId("progress-secondary-value"),
      progressCancel: byId("progress-cancel"),
      bpalQualityPreset: byId("bpal-quality-preset"),
      bpalBlockSize: byId("bpal-block-size"),
      bpalLocalColors: byId("bpal-local-colors"),
      bpalGlobalColors: byId("bpal-global-colors"),
      bpalPaletteCount: byId("bpal-palette-count"),
      bpalPaletteBits: byId("bpal-palette-bits"),
      bpalColorSpace: byId("bpal-color-space"),
      bpalClustering: byId("bpal-clustering"),
      bpalAlgorithm: byId("bpal-algorithm"),
      bpalDiversity: byId("bpal-diversity"),
      bpalDiversityValue: byId("bpal-diversity-value"),
      bpalDithering: byId("bpal-dithering"),
      bpalRefinement: byId("bpal-refinement"),
      dctPreset: byId("dct-preset"),
      dctComponentBudget: byId("dct-component-budget"),
      dctQuality: byId("dct-quality"),
      dctQualityValue: byId("dct-quality-value"),
      dctAutoQuality: byId("dct-auto-quality"),
      dctJpegImport: byId("dct-jpeg-import"),
      dctLibrary: byId("dct-library"),
      bpdhTargetBpp: byId("bpdh-target-bpp"),
      bpdhMode: byId("bpdh-mode"),
      bpdhDctSearch: byId("bpdh-dct-search"),
      bpdhLocalColors: byId("bpdh-local-colors"),
      bpdhGlobalColors: byId("bpdh-global-colors"),
      bpdhPaletteCount: byId("bpdh-palette-count"),
      bpdhPaletteBits: byId("bpdh-palette-bits"),
      bpdhColorSpace: byId("bpdh-color-space"),
      bpdhClustering: byId("bpdh-clustering"),
      bpdhRefinement: byId("bpdh-refinement"),
      astcProfile: byId("astc-profile"),
      astcQuality: byId("astc-quality"),
      bc1Quality: byId("bc1-quality"),
      bc7Quality: byId("bc7-quality"),
    };
  }

  function bindEvents() {
    elements.controls.addEventListener("submit", (event) => {
      event.preventDefault();
      processSelection().catch(showError);
    });
    elements.codecFormat.addEventListener("change", () => {
      state.format = elements.codecFormat.value;
      updateFormatUi();
      markSettingsChanged();
    });
    elements.imageUrl.addEventListener("change", () => {
      clearPendingFile();
      previewSelectedSource(t("lab.sourceChanged")).catch(showError);
    });
    elements.uploadButton.addEventListener("click", () => elements.imageFile.click());
    elements.optimizeBpal.addEventListener("click", () => optimizeBpalSettings().catch(showError));
    elements.imageFile.addEventListener("change", () => handleUpload().catch(showError));
    elements.downloadFile.addEventListener("click", downloadEncoded);
    elements.downloadPng.addEventListener("click", downloadPng);
    elements.progressCancel.addEventListener("click", cancelProcessing);
    elements.progressDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelProcessing();
    });
    elements.showOverlay.addEventListener("change", () => comparison.drawOverlay());
    elements.coordinateForm.addEventListener("submit", (event) => {
      event.preventDefault();
      renderInspector(Number(elements.coordinateX.value), Number(elements.coordinateY.value));
    });
    elements.formatGuideBody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-guide-component]");
      if (!button || !elements.formatGuideBody.contains(button)) return;
      state.guideComponent = button.dataset.guideComponent;
      renderFormatGuide();
    });
    elements.bpalQualityPreset.addEventListener("change", applyBpalPreset);
    elements.bpalBlockSize.addEventListener("change", () => {
      updateBpalLocalColorOptions();
      syncBpalPresetFromSettings();
    });
    for (const control of [elements.bpalLocalColors, elements.bpalGlobalColors, elements.bpalPaletteCount]) {
      control.addEventListener("change", syncBpalPresetFromSettings);
    }
    elements.bpalDiversity.addEventListener("input", updateRangeLabels);
    elements.dctQuality.addEventListener("input", updateRangeLabels);
    elements.dctPreset.addEventListener("change", syncDctControls);
    elements.dctJpegImport.addEventListener("change", syncDctControls);
    elements.dctLibrary.addEventListener("change", () => {
      if (elements.dctLibrary.value !== "none") elements.dctJpegImport.checked = false;
      syncDctControls();
    });
    elements.dctAutoQuality.addEventListener("change", () => {
      if (elements.dctAutoQuality.checked) elements.dctJpegImport.checked = false;
      syncDctControls();
    });

    for (const control of elements.controls.querySelectorAll("select, input")) {
      if ([elements.imageUrl, elements.imageFile, elements.codecFormat].includes(control)) continue;
      control.addEventListener("change", markSettingsChanged);
    }

    root.addEventListener("languagechange", renderDynamicContent);
    root.addEventListener("beforeunload", dispose);
  }

  function selectInitialFormat() {
    const requested = new URL(root.location.href).searchParams.get("format");
    state.format = formatAdapters[requested] ? requested : "bpal";
    elements.codecFormat.value = state.format;
  }

  function updateFormatUi() {
    cancelWorker();
    state.result = null;
    elements.downloadFile.disabled = true;
    elements.downloadPng.disabled = true;
    comparison.clearResult();
    resetMetrics(false);
    comparison.setOverlayRenderer((context, view) => currentAdapter().drawOverlay(context, view));

    for (const panel of document.querySelectorAll("[data-format-panel]")) {
      panel.hidden = panel.dataset.formatPanel !== state.format;
    }
    for (const action of document.querySelectorAll("[data-format-action]")) {
      action.hidden = action.dataset.formatAction !== state.format;
    }
    elements.bpalPaletteSections.hidden = state.format !== "bpal";
    elements.metricModeSplit.hidden = state.format !== "bpdh";
    elements.bpdhModeLegend.hidden = true;

    const adapter = currentAdapter();
    elements.formatDescription.textContent = t(adapter.descriptionKey);
    elements.resultCaption.textContent = t(adapter.resultLabelKey);
    elements.structureTitle.textContent = t(adapter.structureTitleKey);
    elements.structureDescription.textContent = t(adapter.structureDescriptionKey);
    elements.progressEyebrow.textContent = adapter.label;
    renderFormatGuide();
    elements.structureSummary.textContent = "—";
    elements.structureFlow.replaceChildren(emptyState(t("lab.encodeToInspect")));
    clearBpalPalettes();
    clearInspector();
    syncDctControls();

    const url = new URL(root.location.href);
    url.searchParams.set("format", state.format);
    root.history.replaceState(null, "", url);

  }

  function currentAdapter() {
    return formatAdapters[state.format];
  }

  async function processSelection() {
    if (state.busy) return;

    const source = selectedSource();
    if (!state.sourceImageData || state.sourceKey !== source.key) {
      await loadSelectedSource(source);
    }

    await processCurrentFormat();
  }

  async function optimizeBpalSettings() {
    if (state.busy || state.format !== "bpal") return;

    const source = selectedSource();
    if (!state.sourceImageData || state.sourceKey !== source.key) {
      await loadSelectedSource(source);
    }

    const requestId = ++state.requestId;
    const targetBitsPerPixel = getBpalOptimizationTarget();
    const preview = createOptimizationPreview();
    const worker = new Worker("./src/palette/block-palette-optimizer-worker.js?v=palette-256-1");
    state.worker = worker;
    showProgress("BPAL SEARCH");
    setBusy(true, t("block.optimizePreparing", { target: targetBitsPerPixel.toFixed(2) }));

    try {
      const result = await new Promise((resolve, reject) => {
        state.workerReject = reject;
        worker.addEventListener("message", (event) => {
          if (worker !== state.worker) return;
          const message = event.data || {};
          if (message.type === "progress") {
            const completed = Number(message.completed || 0);
            const total = Number(message.total || 1);
            renderProgress({
              stage: "searching-settings",
              progress: completed / Math.max(1, total),
              completed,
              total,
              targetBitsPerPixel,
              search: message.candidate,
            }, "bpal-search");
            setBusy(true, t("block.optimizeSearching", {
              completed,
              total,
              target: targetBitsPerPixel.toFixed(2),
              size: formatBytes(message.candidate.fileBytes),
              bpp: message.candidate.bitsPerPixel.toFixed(2),
              rmse: message.candidate.rmse.toFixed(2),
            }));
            return;
          }
          if (message.type === "error") reject(new Error(message.error || t("block.optimizeError")));
          if (message.type === "result") resolve(message.result);
        });
        worker.addEventListener("error", (event) => reject(event.error || new Error(event.message || t("block.optimizeError"))));
        worker.postMessage({
          pixels: preview.data.buffer,
          width: preview.width,
          height: preview.height,
          options: {
            colorSpace: elements.bpalColorSpace.value,
            clusteringMethod: elements.bpalClustering.value,
            dithering: elements.bpalDithering.value,
            diversity: Number(elements.bpalDiversity.value),
            refinementPasses: Number(elements.bpalRefinement.value),
            paletteCount: Number(elements.bpalPaletteCount.value),
            paletteColorBits: Number(elements.bpalPaletteBits.value),
            paletteMode: "explicit",
            targetBitsPerPixel,
            bitsPerPixelTargets: QUALITY_PRESET_BITS_PER_PIXEL,
            storageWidth: state.sourceImageData.width,
            storageHeight: state.sourceImageData.height,
            baselineProfile: {
              blockSize: Number(elements.bpalBlockSize.value),
              localColorCount: Number(elements.bpalLocalColors.value),
              globalColorCount: Number(elements.bpalGlobalColors.value),
              paletteColorBits: Number(elements.bpalPaletteBits.value),
            },
          },
        }, [preview.data.buffer]);
      });

      if (requestId !== state.requestId) return;
      finishWorker();
      closeProgress();
      elements.bpalBlockSize.value = String(result.settings.blockSize);
      updateBpalLocalColorOptions();
      elements.bpalLocalColors.value = String(result.settings.localColorCount);
      elements.bpalGlobalColors.value = String(result.settings.globalColorCount);
      elements.bpalPaletteBits.value = String(result.settings.paletteColorBits);
      elements.bpalQualityPreset.value = "";
      setBusy(false, t("block.optimizeFound", {
        count: formatInteger(result.matchingCandidates.length),
        target: targetBitsPerPixel.toFixed(2),
        minimum: result.bitsPerPixelRange.minimum.toFixed(2),
        maximum: result.bitsPerPixelRange.maximum.toFixed(2),
        bpp: result.selected.bitsPerPixel.toFixed(2),
        size: formatBytes(result.selected.fileBytes),
        rmse: result.selected.rmse.toFixed(2),
        psnr: result.selected.psnr === Infinity ? "∞" : result.selected.psnr.toFixed(2),
      }));
      renderFormatGuide();
      await processCurrentFormat();
    } catch (error) {
      if (!isCancelled(error) && requestId === state.requestId) showError(error);
    } finally {
      if (requestId === state.requestId && state.worker === worker) finishWorker();
      if (requestId === state.requestId) closeProgress();
    }
  }

  function getBpalOptimizationTarget() {
    const preset = Number(elements.bpalQualityPreset.value);
    if (Number.isFinite(preset) && preset > 0) return preset;
    if (state.result && state.format === "bpal") {
      return state.result.encoded.byteLength * 8 / (state.result.imageData.width * state.result.imageData.height);
    }

    const width = state.sourceImageData.width;
    const height = state.sourceImageData.height;
    const blockSize = Number(elements.bpalBlockSize.value);
    const localColors = Number(elements.bpalLocalColors.value);
    const globalColors = Number(elements.bpalGlobalColors.value);
    const paletteCount = Number(elements.bpalPaletteCount.value);
    const blocks = Math.ceil(width / blockSize) * Math.ceil(height / blockSize);
    const payloadBits = paletteCount * globalColors * Number(elements.bpalPaletteBits.value) +
      blocks * Math.log2(paletteCount) + blocks * localColors * Math.log2(globalColors) +
      (localColors === blockSize * blockSize ? 0 : width * height * Math.log2(localColors));
    return payloadBits / (width * height);
  }

  function createOptimizationPreview() {
    const source = state.sourceImageData;
    const scale = Math.min(1, 96 / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    if (width === source.width && height === source.height) {
      return new ImageData(new Uint8ClampedArray(source.data), width, height);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(elements.sourceCanvas, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  async function previewSelectedSource(message) {
    markSourceChanged(message);
    await loadSelectedSource(selectedSource());
  }

  async function loadSelectedSource(source) {
    setBusy(true, t("dynamic.loadingImage"));
    if (source.file) {
      await loadBlob(source.file, source.name, source.key);
    } else {
      await loadUrl(source.url, source.name, source.key);
    }
  }

  function selectedSource() {
    if (state.pendingFile) {
      const file = state.pendingFile;
      return {
        key: `file:${file.name}:${file.size}:${file.lastModified}`,
        file,
        name: file.name,
      };
    }

    return {
      key: `url:${elements.imageUrl.value}`,
      url: elements.imageUrl.value,
      name: optionText(elements.imageUrl),
    };
  }

  async function loadUrl(url, name, sourceKey) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    await loadBlob(await response.blob(), name || fileStem(url), sourceKey);
  }

  async function loadBlob(blob, name, sourceKey) {
    cancelWorker();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();

    state.sourceImageData = imageData;
    state.sourceBytes = bytes;
    state.sourceMime = blob.type || "";
    state.sourceName = fileStem(name);
    state.sourceKey = sourceKey;
    state.result = null;
    comparison.setSource(imageData);
    elements.coordinateX.max = String(Math.max(0, imageData.width - 1));
    elements.coordinateY.max = String(Math.max(0, imageData.height - 1));
    elements.metricDimensions.textContent = `${formatInteger(imageData.width)} × ${formatInteger(imageData.height)}`;
    resetMetrics(false);
    syncDctControls();
    setBusy(false, t("common.ready"));
  }

  async function handleUpload() {
    const file = elements.imageFile.files && elements.imageFile.files[0];
    if (!file) return;

    state.pendingFile = file;
    elements.imageUrl.querySelector("[data-pending-file]")?.remove();
    const localOption = new Option(file.name, "");
    localOption.dataset.pendingFile = "true";
    elements.imageUrl.append(localOption);
    elements.imageUrl.value = "";
    await previewSelectedSource(t("lab.fileSelected", { name: file.name }));
  }

  async function processCurrentFormat() {
    if (!state.sourceImageData || state.busy) return;

    const requestId = ++state.requestId;
    const adapter = currentAdapter();
    state.result = null;
    comparison.clearResult();
    elements.downloadFile.disabled = true;
    elements.downloadPng.disabled = true;
    resetMetrics(true);
    clearBpalPalettes();
    clearInspector();
    renderFormatGuide();
    showProgress(adapter.label);
    setBusy(true, t("lab.encodingFormat", { format: adapter.label }));

    try {
      const result = await adapter.encode();
      if (requestId !== state.requestId) return;

      state.result = result;
      comparison.setResult(result.imageData);
      renderMetrics(result);
      renderStructure(result);
      comparison.setSelectedPixel(0, 0);
      renderInspector(0, 0);
      elements.downloadFile.disabled = false;
      elements.downloadPng.disabled = false;
      setBusy(false, t("lab.ready", { format: adapter.label, size: formatBytes(result.encoded.byteLength) }));
    } catch (error) {
      if (!isCancelled(error) && requestId === state.requestId) showError(error);
    } finally {
      if (requestId === state.requestId) {
        closeProgress();
        finishWorker();
      }
    }
  }

  function createBpalAdapter() {
    return {
      label: "BPAL",
      descriptionKey: "lab.bpalDescription",
      resultLabelKey: "lab.bpalResult",
      structureTitleKey: "block.storageTitle",
      structureDescriptionKey: "block.storageDescription",
      formatGuide: createBpalFormatGuide,
      extension: "bpal",
      mime: "application/vnd.block-palette",
      encode() {
        const source = state.sourceImageData;
        const settings = readBpalSettings();
        const pixels = new Uint8ClampedArray(source.data);
        return runWorker("bpal", {
          pixels: pixels.buffer,
          width: source.width,
          height: source.height,
          settings,
        }, [pixels.buffer], (message) => {
          if (message.error) throw new Error(message.error);
          if (message.type === "progress") {
            renderProgress(message.progress || {}, "bpal");
            return null;
          }

          const encoded = root.BlockPaletteFormat.encodeBlockPaletteFile(message);
          const imageData = new ImageData(message.pixels, message.width, message.height);
          const layout = root.BlockPaletteFormat.getBlockPaletteFileLayout(message);
          return done({
            encoded,
            imageData,
            mse: message.meanSquaredError,
            durationMs: message.durationMs,
            raw: message,
            layout,
          });
        });
      },
      sample(result, x, y) {
        return root.BlockPaletteFormat.sampleBlockPaletteFilePixel(result.encoded, x, y);
      },
      drawOverlay(context, view) {
        if (!state.result) return;
        drawBlockOverlay(context, view, state.result.raw.blockSize, null);
      },
      renderStructure(result) {
        const raw = result.raw;
        const layout = result.layout;
        return [
          structureCard("BPAL header", formatBytes(layout.headerBytes), `${root.BlockPaletteFormat.MAGIC} v${root.BlockPaletteFormat.VERSION}`),
          structureCard("Shared palettes", formatBits(layout.globalPaletteBits), `${raw.paletteCount} × ${raw.globalColorCount} colors`),
          structureCard("Block palettes", formatBits(layout.blockPaletteSelectorBits + layout.blockPaletteBits), `${raw.blockCount} blocks × ${raw.localColorCount} entries`),
          structureCard("Pixel indices", formatBits(layout.pixelDataBits), layout.directPixelColors ? "Direct block colors" : `${raw.localIndexBits} bits/pixel`),
          structureCard("BPAL file", formatBytes(layout.totalBytes), `${layout.paddingBits} padding bits`),
        ];
      },
      inspect(result, x, y) {
        const raw = result.raw;
        const blockX = Math.floor(x / raw.blockSize);
        const blockY = Math.floor(y / raw.blockSize);
        const blockIndex = blockY * raw.blocksX + blockX;
        return {
          label: `BPAL block #${blockIndex} · (${blockX}, ${blockY})`,
          summary: `${raw.blockSize}×${raw.blockSize} · palette #${raw.blockPaletteSelectors[blockIndex]}`,
          body: renderBpalBlock(raw, blockIndex, x, y),
        };
      },
    };
  }

  function createDctAdapter() {
    return {
      label: "DCTBS2",
      descriptionKey: "lab.dctDescription",
      resultLabelKey: "dct.restoredPreview",
      structureTitleKey: "dct.formatTitle",
      structureDescriptionKey: "dct.formatDescription",
      formatGuide: createDctFormatGuide,
      extension: "dctbs2",
      mime: "application/octet-stream",
      encode() {
        const source = state.sourceImageData;
        const pixels = source.data.slice();
        const jpegImport = elements.dctJpegImport.checked && !elements.dctJpegImport.disabled;
        const jpegBytes = jpegImport ? state.sourceBytes.slice() : null;
        const library = jpegImport ? null : dctLibraryOptions();
        const requestId = state.requestId;
        const startedAt = performance.now();
        const message = {
          type: "encode",
          requestId,
          pixels: pixels.buffer,
          width: source.width,
          height: source.height,
          preset: elements.dctPreset.value,
          componentBudget: elements.dctComponentBudget.value,
          quality: Number(elements.dctQuality.value),
          autoQuality: !jpegImport && elements.dctAutoQuality.checked,
          jpegImport,
          dctLibrary: library !== null,
          librarySize: library?.librarySize,
          libraryComponents: library ? ["y"] : undefined,
          libraryReferenceCoding: library?.libraryReferenceCoding,
          libraryFrequencySplit: library?.libraryFrequencySplit,
          libraryClusterSamples: library?.libraryClusterSamples,
          libraryCandidateCount: library?.libraryCandidateCount,
          jpegBytes: jpegBytes ? jpegBytes.buffer : null,
          sampleMcuCount: 32,
        };
        const transfers = jpegBytes ? [pixels.buffer, jpegBytes.buffer] : [pixels.buffer];

        return runWorker("dct", message, transfers, (data) => {
          if (!data || data.requestId !== requestId) return null;
          if (data.type === "progress") {
            renderProgress(data, "dct");
            return null;
          }
          if (data.type === "error") throw new Error(data.message);
          if (data.type !== "result") return null;

          elements.dctQuality.value = String(data.quality);
          updateRangeLabels();
          const encoded = new Uint8Array(data.encoded);
          const imageData = new ImageData(new Uint8ClampedArray(data.decodedPixels), source.width, source.height);
          return done({
            encoded,
            imageData,
            mse: data.squaredError / (source.width * source.height * 3),
            durationMs: performance.now() - startedAt,
            info: root.DctImageFormat.inspectDctFile(encoded),
            importMode: data.importMode,
          });
        });
      },
      sample(result, x, y) {
        return root.DctImageFormat.sampleDctFilePixel(result.encoded, x, y);
      },
      drawOverlay(context, view) {
        if (!state.result) return;
        drawBlockOverlay(context, view, 16, null);
      },
      renderStructure(result) {
        const info = result.info;
        return [
          structureCard("DCTBS2 header", formatBytes(info.headerBytes), `v${info.version} · quality ${info.quality}`),
          structureCard("MCU records", formatBytes(info.payloadBytes), `${info.mcuCount} × ${info.bytesPerMcu} B`),
          structureCard("Luma", `${info.yBytes} B/MCU`, info.splitLuma8x8 ? "4 × Y 8×8" : "Y 16×16"),
          structureCard("Chroma", `${info.cbBytes + info.crBytes} B/MCU`, `Cb + Cr · ${info.chromaSubsampling}`),
          structureCard("Prototype library", formatBytes(info.libraryBytes), info.libraryEnabled ? info.library.referenceCoding : "Disabled"),
          structureCard("DCTBS2 file", formatBytes(result.encoded.byteLength), `${info.totalBpp.toFixed(3)} bpp`),
        ];
      },
      inspect(result, x, y) {
        const info = result.info;
        const mcuIndex = Math.floor(y / 16) * info.mcuColumns + Math.floor(x / 16);
        const mcu = root.DctImageFormat.inspectDctMcu(result.encoded, mcuIndex);
        return {
          label: `DCT MCU #${mcuIndex} · (${mcu.x}, ${mcu.y})`,
          summary: `${mcu.bytes} B · offset ${mcu.byteOffset}`,
          body: renderDctMcu(mcu, info),
        };
      },
    };
  }

  function createBpdhAdapter() {
    return {
      label: "BPDH",
      descriptionKey: "hybrid.description",
      resultLabelKey: "hybrid.restoredPreview",
      structureTitleKey: "hybrid.storageTitle",
      structureDescriptionKey: "hybrid.storageDescription",
      formatGuide: createBpdhFormatGuide,
      extension: "bpdh",
      mime: "application/octet-stream",
      encode() {
        const source = state.sourceImageData;
        const pixels = new Uint8ClampedArray(source.data);
        const startedAt = performance.now();
        return runWorker("bpdh", {
          width: source.width,
          height: source.height,
          pixels: pixels.buffer,
          settings: readBpdhSettings(source.width, source.height),
        }, [pixels.buffer], (message) => {
          if (message.type === "progress") {
            renderProgress(message.progress || {}, "bpdh");
            return null;
          }
          if (message.type === "error") throw new Error(message.error);
          if (message.type !== "complete") return null;

          const encoded = new Uint8Array(message.file);
          const decoded = root.BpdhFormat.decodeBpdhFile(encoded);
          return done({
            encoded,
            imageData: new ImageData(decoded.pixels, decoded.width, decoded.height),
            mse: message.metrics.meanSquaredError,
            durationMs: message.metrics.durationMs || performance.now() - startedAt,
            decoded,
            metrics: message.metrics,
          });
        });
      },
      sample(result, x, y) {
        return root.BpdhFormat.sampleBpdhPixel(result.decoded, x, y);
      },
      drawOverlay(context, view) {
        if (!state.result) return;
        const decoded = state.result.decoded;
        const modeColor = elements.showOverlay.checked
          ? (blockIndex) => decoded.modes[blockIndex] === root.BpdhFormat.MODE_DCT
            ? "rgba(255, 155, 66, 0.20)" : "rgba(47, 140, 255, 0.20)"
          : null;
        drawBlockOverlay(context, view, decoded.codingUnitSize, modeColor);
      },
      renderStructure(result) {
        const decoded = result.decoded;
        const storage = decoded.storage;
        return [
          structureCard("BPDH header", formatBytes(storage.headerBytes), `v${decoded.version}`),
          structureCard("BPAL palettes", formatBytes(storage.paletteBytes), `${decoded.paletteCount} × ${decoded.globalColorCount} colors`),
          structureCard("DCT tables", formatBytes(storage.quantizationTableBytes), decoded.dctBlockCount ? "Y + C" : "Omitted"),
          structureCard("Mode map", formatBytes(storage.modeMapBytes), `${decoded.bpalBlockCount} BPAL / ${decoded.dctBlockCount} DCT`),
          structureCard("BPAL payload", formatBytes(storage.bpalBytes), `${storage.bpalBits} meaningful bits`),
          structureCard("DCT payload", formatBytes(storage.dctBytes), `${storage.dctBits} meaningful bits`),
          structureCard("BPDH file", formatBytes(storage.totalBytes), `${storage.fileBitsPerPixel.toFixed(3)} bpp`),
        ];
      },
      inspect(result, x, y) {
        const decoded = result.decoded;
        const blockX = Math.floor(x / decoded.codingUnitSize);
        const blockY = Math.floor(y / decoded.codingUnitSize);
        const blockIndex = blockY * decoded.blocksX + blockX;
        const isDct = decoded.modes[blockIndex] === root.BpdhFormat.MODE_DCT;
        return {
          label: `BPDH unit #${blockIndex} · (${blockX}, ${blockY})`,
          summary: isDct ? "DCT 4:2:0" : `BPAL · palette #${decoded.blockPaletteSelectors[blockIndex]}`,
          body: isDct
            ? renderBpdhDctBlock(decoded, blockIndex)
            : renderBpalBlock(decoded, blockIndex, x, y),
        };
      },
    };
  }

  function createStandardTextureAdapter(format) {
    const upper = format.toUpperCase();
    const astc = format === "astc";
    return {
      label: upper,
      descriptionKey: `lab.${format}Description`,
      resultLabelKey: `lab.${format}Result`,
      structureTitleKey: "lab.textureStorageTitle",
      structureDescriptionKey: "lab.textureStorageDescription",
      formatGuide: (result) => createStandardTextureFormatGuide(result, format),
      extension: astc ? "astc" : "dds",
      mime: "application/octet-stream",
      encode() {
        const source = state.sourceImageData;
        const pixels = new Uint8ClampedArray(source.data);
        const requestId = state.requestId;
        const options = astc
          ? { profile: elements.astcProfile.value, quality: elements.astcQuality.value }
          : { quality: elements[`${format}Quality`].value };
        return runWorker(format, {
          requestId,
          format,
          pixels: pixels.buffer,
          width: source.width,
          height: source.height,
          options,
        }, [pixels.buffer], (message) => {
          if (!message || message.requestId !== requestId) return null;
          if (message.type === "progress") {
            renderProgress(message, "texture");
            return null;
          }
          if (message.type === "error") throw new Error(message.error);
          if (message.type !== "complete") return null;
          return done({
            encoded: new Uint8Array(message.encoded),
            imageData: new ImageData(new Uint8ClampedArray(message.decoded), source.width, source.height),
            mse: message.squaredError / (source.width * source.height * 3),
            durationMs: message.durationMs,
            info: message.info,
          });
        });
      },
      sample(result, x, y) {
        return rgbaAt(result.imageData.data, result.imageData.width, x, y);
      },
      drawOverlay(context, view) {
        if (!state.result) return;
        drawRectangularBlockOverlay(
          context,
          view,
          state.result.info.blockWidth,
          state.result.info.blockHeight
        );
      },
      renderStructure(result) {
        const info = result.info;
        const blockCount = info.blocksX * info.blocksY;
        return [
          structureCard(`${upper} container`, formatBytes(info.headerBytes), astc ? ".astc" : ".dds"),
          structureCard("Block grid", `${info.blocksX} × ${info.blocksY}`, `${info.blockWidth}×${info.blockHeight} texels/block`),
          structureCard("Block records", formatBytes(info.payloadBytes), `${blockCount} × ${info.blockBytes} B`),
          structureCard("Profile", astc ? info.profile : `${upper} ${info.mode ? `mode ${info.mode}` : "RGB"}`, astc ? info.quality : `${info.quality} encoder`),
          structureCard(`${upper} file`, formatBytes(result.encoded.byteLength), `${(result.encoded.byteLength * 8 / (info.width * info.height)).toFixed(3)} bpp`),
        ];
      },
      inspect(result, x, y) {
        const info = result.info;
        const blockX = Math.floor(x / info.blockWidth);
        const blockY = Math.floor(y / info.blockHeight);
        const blockIndex = blockY * info.blocksX + blockX;
        const bytes = root.StandardTextureCodecs.extractBlock(
          result.encoded,
          info.headerBytes,
          info.blockBytes,
          blockIndex
        );
        const description = format === "bc1"
          ? root.StandardTextureCodecs.inspectBc1Block(bytes)
          : format === "bc7"
            ? root.StandardTextureCodecs.inspectBc7Mode6Block(bytes)
            : null;
        return {
          label: `${upper} block #${blockIndex} · (${blockX}, ${blockY})`,
          summary: `${info.blockWidth}×${info.blockHeight} px · ${info.blockBytes} B`,
          body: renderStandardTextureBlock(info, blockIndex, blockX, blockY, bytes, description),
        };
      },
    };
  }

  function readBpalSettings() {
    return {
      blockSize: Number(elements.bpalBlockSize.value),
      localColorCount: Number(elements.bpalLocalColors.value),
      globalColorCount: Number(elements.bpalGlobalColors.value),
      paletteCount: Number(elements.bpalPaletteCount.value),
      paletteColorBits: Number(elements.bpalPaletteBits.value),
      paletteMode: "explicit",
      colorSpace: elements.bpalColorSpace.value,
      clusteringMethod: elements.bpalClustering.value,
      algorithm: elements.bpalAlgorithm.value,
      dithering: elements.bpalDithering.value,
      diversity: Number(elements.bpalDiversity.value),
      refinementPasses: Number(elements.bpalRefinement.value),
    };
  }

  function readBpdhSettings(width, height) {
    const blockCount = Math.ceil(width / root.BpdhFormat.CODING_UNIT_SIZE) *
      Math.ceil(height / root.BpdhFormat.CODING_UNIT_SIZE);
    return {
      targetBitsPerPixel: Number(elements.bpdhTargetBpp.value),
      mode: elements.bpdhMode.value,
      dctQualities: dctQualities(elements.bpdhDctSearch.value),
      bpal: {
        blockSize: root.BpdhFormat.CODING_UNIT_SIZE,
        localColorCount: Number(elements.bpdhLocalColors.value),
        globalColorCount: Number(elements.bpdhGlobalColors.value),
        paletteCount: largestPowerOfTwo(Math.min(Number(elements.bpdhPaletteCount.value), blockCount)),
        paletteColorBits: Number(elements.bpdhPaletteBits.value),
        colorSpace: elements.bpdhColorSpace.value,
        clusteringMethod: elements.bpdhClustering.value,
        dithering: "none",
        diversity: 0,
        refinementPasses: Number(elements.bpdhRefinement.value),
      },
    };
  }

  function dctQualities(value) {
    if (value === "balanced") return [25, 35, 45, 55, 65, 75, 85, 92];
    if (value === "fast") return [35, 55, 75, 90];
    return [Number(value)];
  }

  function dctLibraryOptions() {
    const mode = elements.dctLibrary.value;
    if (mode === "none") return null;
    if (mode === "header3") return { librarySize: 3 };
    const selected = {
      sidecar16: { librarySize: 16 },
      sidecar32: { librarySize: 32 },
      "sidecar32-spectral": { librarySize: 32, libraryFrequencySplit: 0.25 },
    }[mode];
    if (!selected) throw new RangeError(`Unsupported DCT library: ${mode}`);
    return {
      ...selected,
      libraryReferenceCoding: "sidecar",
      libraryClusterSamples: 4096,
      libraryCandidateCount: 4,
    };
  }

  function applyBpalPreset() {
    const preset = QUALITY_PRESETS[elements.bpalQualityPreset.value];
    if (!preset) return;
    elements.bpalBlockSize.value = String(preset.blockSize);
    elements.bpalLocalColors.value = String(preset.localColorCount);
    elements.bpalGlobalColors.value = String(preset.globalColorCount);
    elements.bpalPaletteCount.value = String(preset.paletteCount);
    updateBpalLocalColorOptions();
    markSettingsChanged();
  }

  function syncBpalPresetFromSettings() {
    const blockSize = Number(elements.bpalBlockSize.value);
    const localColorCount = Number(elements.bpalLocalColors.value);
    const globalColorCount = Number(elements.bpalGlobalColors.value);
    const paletteCount = Number(elements.bpalPaletteCount.value);
    const match = Object.entries(QUALITY_PRESETS).find(([, preset]) =>
      preset.blockSize === blockSize &&
      preset.localColorCount === localColorCount &&
      preset.globalColorCount === globalColorCount &&
      preset.paletteCount === paletteCount
    );

    elements.bpalQualityPreset.value = match ? match[0] : "";
  }

  function updateBpalLocalColorOptions() {
    const maximum = Number(elements.bpalBlockSize.value) ** 2;
    let fallback = null;
    for (const option of elements.bpalLocalColors.options) {
      option.disabled = Number(option.value) > maximum;
      if (!option.disabled) fallback = option;
    }
    if (elements.bpalLocalColors.selectedOptions[0]?.disabled && fallback) {
      elements.bpalLocalColors.value = fallback.value;
    }
  }

  function syncDctControls() {
    const jpeg = /image\/(jpeg|jpg)/i.test(state.sourceMime) || /\.jpe?g$/i.test(state.sourceName);
    elements.dctJpegImport.disabled = !jpeg;
    const importing = jpeg && elements.dctJpegImport.checked;
    elements.dctAutoQuality.disabled = importing;
    elements.dctLibrary.disabled = importing;
    elements.dctComponentBudget.disabled = Number(elements.dctPreset.value) > 3 ||
      elements.dctLibrary.value !== "none";
    if (importing) elements.dctAutoQuality.checked = false;
  }

  function updateRangeLabels() {
    elements.bpalDiversityValue.value = Number(elements.bpalDiversity.value).toFixed(1);
    elements.dctQualityValue.value = elements.dctQuality.value;
  }

  function markSettingsChanged() {
    updateRangeLabels();
    renderFormatGuide();
    if (!state.busy) setStatus(t("lab.settingsChanged"));
  }

  function markSourceChanged(message) {
    state.result = null;
    elements.downloadFile.disabled = true;
    elements.downloadPng.disabled = true;
    comparison.clearResult();
    elements.metricDimensions.textContent = "—";
    resetMetrics(true);
    clearBpalPalettes();
    clearInspector();
    renderFormatGuide();
    elements.structureSummary.textContent = "—";
    elements.structureFlow.replaceChildren(emptyState(t("lab.encodeToInspect")));
    if (!state.busy) setStatus(message);
  }

  function runWorker(format, message, transfers, onMessage) {
    cancelWorker();
    const worker = root.CodecEncoderRuntime.createWorker(format);
    state.worker = worker;

    return new Promise((resolve, reject) => {
      state.workerReject = reject;
      worker.addEventListener("message", (event) => {
        if (worker !== state.worker) return;
        try {
          const outcome = onMessage(event.data || {});
          if (outcome && outcome.done) resolve(outcome.value);
        } catch (error) {
          reject(error);
        }
      });
      worker.addEventListener("error", (event) => {
        if (worker === state.worker) reject(event.error || new Error(event.message || t("dynamic.workerError")));
      });
      worker.postMessage(message, transfers);
    });
  }

  function done(value) {
    return { done: true, value };
  }

  function cancelWorker() {
    if (state.worker) state.worker.terminate();
    state.worker = null;
    const reject = state.workerReject;
    state.workerReject = null;
    if (reject) reject(cancelledError());
  }

  function finishWorker() {
    if (state.worker) state.worker.terminate();
    state.worker = null;
    state.workerReject = null;
  }

  function cancelProcessing() {
    if (!state.busy) {
      closeProgress();
      return;
    }
    ++state.requestId;
    cancelWorker();
    closeProgress();
    setBusy(false, t("lab.cancelled"));
  }

  function renderProgress(progress, format) {
    const rawValue = format === "dct"
      ? Number(progress.completed || 0) / Math.max(1, Number(progress.total || 1))
      : Number(progress.progress || 0);
    const percent = clamp(Math.round(rawValue * 100), 0, 100);
    elements.progressBar.value = percent;
    elements.progressBar.textContent = `${percent}%`;
    elements.progressPercent.value = `${percent}%`;
    const stage = progressStagePresentation(progress.stage, format);
    elements.progressStage.textContent = stage.label;
    elements.progressStageCount.textContent = stage.count;
    const completed = progress.phaseCompleted ?? progress.completed;
    const total = progress.phaseTotal ?? progress.total;
    elements.progressDetail.textContent = Number.isFinite(completed) && Number.isFinite(total)
      ? `${formatInteger(completed)} / ${formatInteger(total)}`
      : Number.isFinite(progress.quality) ? `Quality ${progress.quality}` : t("block.progressWaiting");

    if (format === "bpal") {
      elements.progressPrimaryLabel.textContent = t("block.progressClusters");
      elements.progressPrimaryValue.textContent = formatProgressCount(progress.clusters, progress.targetClusters);
      elements.progressSecondaryLabel.textContent = t("block.progressPalette");
      elements.progressSecondaryValue.textContent = formatProgressCount(progress.palette, progress.paletteTotal);
    } else if (format === "bpal-search") {
      elements.progressPrimaryLabel.textContent = t("hybrid.progressItemsLabel");
      elements.progressPrimaryValue.textContent = formatProgressCount(progress.completed, progress.total);
      elements.progressSecondaryLabel.textContent = "BPP / RMSE";
      elements.progressSecondaryValue.textContent = progress.search
        ? `${formatNumber(progress.search.bitsPerPixel, 2)} / ${formatNumber(progress.search.rmse, 2)}` : "—";
    } else {
      elements.progressPrimaryLabel.textContent = t("hybrid.progressItemsLabel");
      elements.progressPrimaryValue.textContent = formatProgressCount(completed, total);
      elements.progressSecondaryLabel.textContent = t("hybrid.progressQualityLabel");
      elements.progressSecondaryValue.textContent = Number.isFinite(progress.quality) ? formatInteger(progress.quality) : "—";
    }
  }

  function progressStagePresentation(stage, format) {
    if (format === "bpal-search") return { label: t("block.progressStageSearching"), count: "1 / 1" };
    if (format === "bpal") {
      const normalized = stage === "complete" ? "complete" : String(stage || "preparing");
      const index = normalized === "complete"
        ? BPAL_PROGRESS_STAGES.length : Math.max(1, BPAL_PROGRESS_STAGES.indexOf(normalized) + 1);
      return {
        label: t(BPAL_PROGRESS_STAGE_KEYS[normalized] || "block.progressStagePreparing"),
        count: `${index} / ${BPAL_PROGRESS_STAGES.length}`,
      };
    }
    if (format === "bpdh") {
      const normalized = String(stage || "");
      const key = normalized.startsWith("bpal-")
        ? (BPAL_PROGRESS_STAGE_KEYS[normalized.slice(5)] || "hybrid.progressStageBpal")
        : normalized === "transforming-dct" ? "hybrid.progressStageDctTransform"
          : normalized === "evaluating-dct" ? "hybrid.progressStageDctEvaluate"
            : normalized === "complete" ? "block.progressStageComplete" : "block.progressStagePreparing";
      const index = normalized.startsWith("bpal-") ? 2
        : normalized === "transforming-dct" ? 3 : normalized === "evaluating-dct" ? 4
          : normalized === "complete" ? 5 : 1;
      return { label: t(key), count: `${index} / 5` };
    }
    return { label: String(stage || t("block.progressStagePreparing")), count: "—" };
  }

  function formatProgressCount(value, total) {
    if (!Number.isFinite(value)) return "—";
    return Number.isFinite(total) ? `${formatInteger(value)} / ${formatInteger(total)}` : formatInteger(value);
  }

  function showProgress(label) {
    elements.progressEyebrow.textContent = label;
    elements.progressBar.value = 0;
    elements.progressPercent.value = "0%";
    elements.progressStage.textContent = t("block.progressStagePreparing");
    elements.progressDetail.textContent = t("block.progressWaiting");
    elements.progressStageCount.textContent = "—";
    elements.progressPrimaryValue.textContent = "—";
    elements.progressSecondaryValue.textContent = "—";
    if (!elements.progressDialog.open) {
      if (typeof elements.progressDialog.showModal === "function") elements.progressDialog.showModal();
      else elements.progressDialog.setAttribute("open", "");
    }
  }

  function closeProgress() {
    if (!elements.progressDialog.open) return;
    if (typeof elements.progressDialog.close === "function") elements.progressDialog.close();
    else elements.progressDialog.removeAttribute("open");
  }

  function renderMetrics(result) {
    const pixelCount = result.imageData.width * result.imageData.height;
    const bpp = result.encoded.byteLength * 8 / pixelCount;
    const ratio = result.encoded.byteLength / (pixelCount * 3) * 100;
    const rmse = Math.sqrt(result.mse || 0);
    const psnr = result.mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / result.mse);
    elements.metricDimensions.textContent = `${formatInteger(result.imageData.width)} × ${formatInteger(result.imageData.height)}`;
    elements.metricSize.textContent = formatBytes(result.encoded.byteLength);
    elements.metricBpp.textContent = `${formatNumber(bpp, 3)} bpp`;
    elements.metricRatio.textContent = `${formatNumber(ratio, 1)}%`;
    elements.metricRmse.textContent = formatNumber(rmse, 3);
    elements.metricPsnr.textContent = Number.isFinite(psnr) ? `${formatNumber(psnr, 2)} dB` : "∞ dB";
    elements.metricTime.textContent = `${formatNumber(result.durationMs || 0, 1)} ms`;
    if (state.format === "bpdh") {
      const bpalCount = result.decoded.bpalBlockCount;
      const dctCount = result.decoded.dctBlockCount;
      elements.metricModeSplitValue.textContent = `${formatInteger(bpalCount)} / ${formatInteger(dctCount)}`;
      elements.bpdhBpalCount.textContent = formatInteger(bpalCount);
      elements.bpdhDctCount.textContent = formatInteger(dctCount);
      elements.bpdhModeLegend.hidden = false;
    }
  }

  function resetMetrics(preserveDimensions) {
    if (!preserveDimensions && state.sourceImageData) {
      elements.metricDimensions.textContent = `${state.sourceImageData.width} × ${state.sourceImageData.height}`;
    }
    for (const element of [elements.metricSize, elements.metricBpp, elements.metricRatio, elements.metricRmse, elements.metricPsnr, elements.metricTime]) {
      element.textContent = "—";
    }
    elements.metricModeSplitValue.textContent = "—";
    elements.bpdhModeLegend.hidden = true;
  }

  function renderFormatGuide() {
    const guide = currentAdapter().formatGuide(state.result);
    const intro = document.createElement("p");
    intro.className = "lab-format-guide-intro";
    intro.textContent = guide.intro;
    elements.formatGuideSummary.textContent = guide.summary;
    elements.formatGuideBody.replaceChildren(
      intro,
      formatGuideSection(t("lab.formatGuideMap"), renderFileMap(guide.sections)),
      formatGuideSection(t("lab.formatGuideBlockLayout"), renderCodecBlockDiagram(guide.diagram)),
      formatGuideSection(t("lab.formatGuideHeader"), renderHeaderTable(guide.header)),
      formatGuideSection(t("lab.formatGuidePacking"), renderPackingList(guide.packing))
    );
  }

  function createStandardTextureFormatGuide(result, format) {
    const astc = format === "astc";
    const bc1 = format === "bc1";
    const upper = format.toUpperCase();
    const profile = astc ? (result?.info.profile || elements.astcProfile.value) : "4x4";
    const [blockWidth, blockHeight] = profile.split("x").map(Number);
    const headerBytes = astc ? 16 : bc1 ? 128 : 148;
    const blockBytes = bc1 ? 8 : 16;
    const blocksX = result?.info.blocksX ?? (state.sourceImageData ? Math.ceil(state.sourceImageData.width / blockWidth) : null);
    const blocksY = result?.info.blocksY ?? (state.sourceImageData ? Math.ceil(state.sourceImageData.height / blockHeight) : null);
    const blockCount = Number.isFinite(blocksX) && Number.isFinite(blocksY) ? blocksX * blocksY : null;
    const payloadBytes = result?.info.payloadBytes ?? (blockCount === null ? null : blockCount * blockBytes);
    const blockFields = astc
      ? [
        guideBit("block mode", 11, "flag"),
        guideBit("partitions", 2, "map"),
        guideBit("partition / CEM", null, "map", "variable"),
        guideBit("color endpoints", null, "palette", "variable"),
        guideBit("weights", null, "index", "variable"),
      ]
      : bc1
        ? [
          guideBit("RGB565 endpoint 0", 16, "palette"),
          guideBit("RGB565 endpoint 1", 16, "palette"),
          guideBit("16 × color index", 32, "index"),
        ]
        : [
          guideBit("mode 6 prefix", 7, "flag"),
          guideBit("RGBA endpoints", 56, "palette"),
          guideBit("endpoint P-bits", 2, "flag"),
          guideBit("anchor index", 3, "index"),
          guideBit("15 × index", 60, "index"),
        ];
    return {
      summary: astc
        ? `ASTC · ${profile} · 16 B/block`
        : `${upper} · DDS · ${blockBytes} B/block`,
      intro: t(`lab.${format}GuideIntro`),
      diagram: {
        kind: "texture",
        format,
        blockWidth,
        blockHeight,
        blockBytes,
        blockFields,
        profile,
      },
      sections: [
        guideMapEntry(t("lab.guideHeader"), `${headerBytes} B`, astc ? t("lab.astcHeaderDetail") : t("lab.ddsHeaderDetail"), headerBytes * 8, "header"),
        guideMapEntry(t("lab.textureBlockPayload"), payloadBytes === null ? `N × ${blockBytes} B` : formatBytes(payloadBytes), `${blocksX ?? "W"} × ${blocksY ?? "H"} blocks`, payloadBytes === null ? null : payloadBytes * 8, astc ? "dct" : "index"),
      ],
      header: astc
        ? [
          guideHeaderField("0–3 B", 32, "magic", "0x5CA1AB13"),
          guideHeaderField("4 B", 8, "blockDimX", String(blockWidth)),
          guideHeaderField("5 B", 8, "blockDimY", String(blockHeight)),
          guideHeaderField("6 B", 8, "blockDimZ", "1"),
          guideHeaderField("7–9 B", 24, "xSize", "image width · little-endian"),
          guideHeaderField("10–12 B", 24, "ySize", "image height · little-endian"),
          guideHeaderField("13–15 B", 24, "zSize", "1 · little-endian"),
        ]
        : [
          guideHeaderField("0–3 B", 32, "magic", 'ASCII "DDS "'),
          guideHeaderField("4–7 B", 32, "dwSize", "124"),
          guideHeaderField("8–11 B", 32, "dwFlags", "CAPS | HEIGHT | WIDTH | PIXELFORMAT | LINEARSIZE"),
          guideHeaderField("12–15 B", 32, "dwHeight", "image height"),
          guideHeaderField("16–19 B", 32, "dwWidth", "image width"),
          guideHeaderField("20–23 B", 32, "dwPitchOrLinearSize", "compressed payload bytes"),
          guideHeaderField("76–107 B", 256, "DDS_PIXELFORMAT", bc1 ? 'FOURCC "DXT1"' : 'FOURCC "DX10"'),
          guideHeaderField("108–127 B", 160, "caps", "DDSCAPS_TEXTURE; remaining fields zero"),
          ...(bc1 ? [] : [
            guideHeaderField("128–131 B", 32, "dxgiFormat", "98 · DXGI_FORMAT_BC7_UNORM"),
            guideHeaderField("132–135 B", 32, "resourceDimension", "3 · TEXTURE2D"),
            guideHeaderField("136–147 B", 96, "array / flags", "arraySize = 1; flags = 0"),
          ]),
        ],
      packing: [
        guidePacking(t("lab.textureContainerTitle"), astc ? t("lab.astcContainerNote") : t("lab.ddsContainerNote"), [
          guideBit(astc ? "ASTC header" : "DDS header", headerBytes * 8, "header"),
          guideBit(`${blockCount ?? "N"} × ${blockBytes} B`, payloadBytes === null ? null : payloadBytes * 8, astc ? "dct" : "index", payloadBytes === null ? "variable" : undefined),
        ]),
        guidePacking(t("lab.textureBlockTitle"), t(`lab.${format}BlockNote`), blockFields),
      ],
    };
  }

  function createBpalFormatGuide(result) {
    const raw = result?.raw;
    const layout = result?.layout;
    const localBits = raw?.localIndexBits ?? Math.log2(Number(elements.bpalLocalColors.value));
    const globalBits = raw?.globalIndexBits ?? Math.log2(Number(elements.bpalGlobalColors.value));
    const paletteBits = raw?.paletteIndexBits ?? Math.log2(Number(elements.bpalPaletteCount.value));
    const variable = t("lab.formatGuideVariable");
    return {
      summary: "BPAL · v5 · 14 B",
      intro: t("lab.bpalGuideIntro"),
      diagram: {
        kind: "bpal",
        blockSize: raw?.blockSize ?? Number(elements.bpalBlockSize.value),
        localColorCount: raw?.localColorCount ?? Number(elements.bpalLocalColors.value),
        globalColorCount: raw?.globalColorCount ?? Number(elements.bpalGlobalColors.value),
        paletteCount: raw?.paletteCount ?? Number(elements.bpalPaletteCount.value),
      },
      sections: [
        guideMapEntry(t("lab.guideHeader"), "14 B", t("lab.bpalGuideHeaderDetail"), 112, "header"),
        guideMapEntry(t("lab.guideSharedPalettes"), guideSize(layout?.globalPaletteBits, variable), t("lab.bpalGuidePaletteDetail"), layout?.globalPaletteBits, "palette"),
        guideMapEntry(t("lab.guidePaletteSelectors"), guideSize(layout?.blockPaletteSelectorBits, `N × ${paletteBits} ${guideBitUnit()}`), t("lab.bpalGuideSelectorDetail"), layout?.blockPaletteSelectorBits, "map"),
        guideMapEntry(t("lab.guideLocalMappings"), guideSize(layout?.blockPaletteBits, `N × L × ${globalBits} ${guideBitUnit()}`), t("lab.bpalGuideMappingDetail"), layout?.blockPaletteBits, "index"),
        guideMapEntry(t("lab.guidePixelIndices"), guideSize(layout?.pixelDataBits, `W × H × ${localBits} ${guideBitUnit()}`), t("lab.bpalGuidePixelsDetail"), layout?.pixelDataBits, "index"),
      ],
      header: [
        guideHeaderField("0–3 B", 32, "magic", 'ASCII "BPAL"'),
        guideHeaderField("bits 32–35", 4, "version", "5"),
        guideHeaderField("bits 36–59", 24, "width − 1", "width = value + 1"),
        guideHeaderField("bits 60–83", 24, "height − 1", "height = value + 1"),
        guideHeaderField("bits 84–86", 3, "blockSizeExp − 1", "blockSize = 2^(value + 1)"),
        guideHeaderField("bits 87–88", 2, "localIndexBits − 1", "localColorCount = 2^(value + 1)"),
        guideHeaderField("bits 89–92", 4, "globalIndexBits − 1", "globalColorCount = 2^(value + 1)"),
        guideHeaderField("bit 93", 1, "paletteColorBits", "0 = RGB565; 1 = RGB888"),
        guideHeaderField("bit 94", 1, "paletteMode", "0 = explicit; 1 = vector"),
        guideHeaderField("bits 95–103", 9, "vectorCount − 1", "paletteMode = vector"),
        guideHeaderField("bit 104", 1, "vectorColorSpace", "0 = RGB; 1 = OKLab"),
        guideHeaderField("bits 105–107", 3, "paletteIndexBits", "paletteCount = 2^value"),
        guideHeaderField("bits 108–109", 2, "channelMode", "0 = RGB; 1 = scalar"),
        guideHeaderField("bits 110–111", 2, "flags", "b0 = packedPalettes; b1 = 0"),
      ],
      packing: [
        guidePacking(t("lab.bpalHeaderBitsTitle"), t("lab.bpalHeaderPackingNote"), [
          guideBit("version", 4), guideBit("width−1", 24), guideBit("height−1", 24),
          guideBit("block exp", 3), guideBit("local bits", 2, "index"), guideBit("global bits", 4, "index"),
          guideBit("RGB888", 1, "flag"), guideBit("vector", 1, "flag"), guideBit("vectors", 9, "palette"),
          guideBit("space", 1, "flag"), guideBit("palette bits", 3, "map"), guideBit("channels", 2, "flag"), guideBit("flags", 2, "flag"),
        ]),
        guidePacking(t("lab.bpalBodyStreamsTitle"), t("lab.bpalBodyPackingNote"), [
          guideBit(t("lab.guideSharedPalettes"), null, "palette", variable),
          guideBit("palette selector", null, "map", `N × ${paletteBits}`),
          guideBit("local → global", null, "index", `N × L × ${globalBits}`),
          guideBit("pixel index", null, "index", `W × H × ${localBits}`),
        ]),
        guidePacking(t("lab.bpalPackedPaletteTitle"), t("lab.bpalPackedPaletteNote"), [
          guideBit("sectionBytes", 32), guideBit("offset[P]", 32, "map", "32 × P"),
          guideBit("mode", 8, "flag"), guideBit("RGB widths", 8, "palette"),
          guideBit("RGB minima", 24, "palette"), guideBit("residuals", null, "palette", variable),
        ]),
      ],
    };
  }

  function createDctFormatGuide(result) {
    const info = result?.info;
    const presetKey = elements.dctPreset.value;
    const selectedPreset = root.DctImageFormat.getDctPreset(presetKey);
    const preset = info || selectedPreset;
    const presetBpp = Number(presetKey);
    const splitLuma = info ? info.splitLuma8x8 : preset.bpp >= 3;
    const requestedLibrary = elements.dctLibrary.value;
    const libraryReferenceCoding = info?.library?.referenceCoding ||
      (requestedLibrary === "header3" ? "header" :
        requestedLibrary === "none" ? null : "sidecar");
    const requestedSidecarBits = requestedLibrary === "sidecar16" ? 5 :
      requestedLibrary.startsWith("sidecar32") ? 6 : 0;
    const variable = t("lab.formatGuideVariable");
    return {
      summary: `DCTBS2 · v2 · 64 B · ${preset.bytesPerMcu} B/MCU`,
      intro: t("lab.dctGuideIntro"),
      diagram: {
        kind: "dct",
        presetKey,
        bpp: presetBpp,
        bytesPerMcu: preset.bytesPerMcu,
        yBytes: preset.yBytes,
        cbBytes: preset.cbBytes,
        crBytes: preset.crBytes,
        splitLuma,
        coefficientCodingKey: info?.coefficientCodingKey || defaultDctGuideCoding(presetKey),
        zigzagOrder: info?.zigzagOrder ?? true,
        libraryReferenceCoding,
        libraryReferenceBits: {
          y: info?.library?.y?.reference?.bits ?? requestedSidecarBits,
          cb: info?.library?.cb?.reference?.bits ?? 0,
          cr: info?.library?.cr?.reference?.bits ?? 0,
        },
      },
      sections: [
        guideMapEntry(t("lab.guideHeader"), "64 B", t("lab.dctGuideHeaderDetail"), 512, "header"),
        guideMapEntry(t("lab.guideMcuRecords"), info ? formatBytes(info.payloadBytes) : `N × ${preset.bytesPerMcu} B`, t("lab.dctGuideMcuDetail"), info?.payloadBytes * 8, "dct"),
        guideMapEntry(t("lab.guidePrototypeLibrary"), info ? formatBytes(info.libraryBytes) : t("lab.formatGuideOptional"), t("lab.dctGuideLibraryDetail"), info?.libraryBytes * 8, "index"),
      ],
      header: [
        guideHeaderField("0–7 B", 64, "magic", 'ASCII "DCTBS2\\0\\0"'),
        guideHeaderField("8–11 B", 32, "version", "uint32 LE · 2"),
        guideHeaderField("12–15 B", 32, "modeCode", "target bpp × 1000"),
        guideHeaderField("16–19 B", 32, "width", "uint32 LE"),
        guideHeaderField("20–23 B", 32, "height", "uint32 LE"),
        guideHeaderField("24–27 B", 32, "mcuColumns", "ceil(width / 16)"),
        guideHeaderField("28–31 B", 32, "mcuRows", "ceil(height / 16)"),
        guideHeaderField("32–35 B", 32, "bytesPerMcu", "byteOffset(i) = 64 + i × bytesPerMcu"),
        guideHeaderField("36–39 B", 32, "yBytes", "Y segment / MCU"),
        guideHeaderField("40–43 B", 32, "cbBytes", "Cb segment / MCU"),
        guideHeaderField("44–47 B", 32, "crBytes", "Cr segment / MCU"),
        guideHeaderField("48–51 B", 32, "quality", "1…100"),
        guideHeaderField("52–55 B", 32, "flags", "b0 autoQ; b1 4×Y8×8; b2 library; b3 4:2:0; b4 zigzag; b8–11 coding ID"),
        guideHeaderField("56–59 B", 32, "payloadBytes", "mcuCount × bytesPerMcu"),
        guideHeaderField("60–63 B", 32, "metadata", "libraryBytes | searchCandidateCount"),
      ],
      packing: [
        guidePacking(t("lab.dctFlagsTitle"), t("lab.dctFlagsNote"), [
          guideBit("autoQ", 1, "flag"), guideBit("4×Y", 1, "flag"), guideBit("library", 1, "flag"),
          guideBit("4:2:0", 1, "flag"), guideBit("zigzag", 1, "flag"), guideBit("reserved", 3, "reserved"),
          guideBit("coding ID", 4, "dct"), guideBit("reserved", 20, "reserved"),
        ]),
        guidePacking(t("lab.dctMcuTitle"), t("lab.dctMcuNote"), [
          guideBit(splitLuma ? "Y0 · Y1 · Y2 · Y3" : "Y 16×16", preset.yBytes * 8, "dct", `${preset.yBytes} B`),
          guideBit("Cb 8×8", preset.cbBytes * 8, "palette", `${preset.cbBytes} B`),
          guideBit("Cr 8×8", preset.crBytes * 8, "dct", `${preset.crBytes} B`),
        ]),
        guidePacking(t("lab.dctMaskedTitle"), t("lab.dctMaskedNote"), [
          guideBit("mask AC1…AC32", 32, "map"), guideBit("mask AC33…AC62", 30, "map"),
          guideBit("scale", 2, "flag"), guideBit("DC", null, "dct", `8/10 ${guideBitUnit()}`),
          guideBit("explicit AC", null, "dct", variable), guideBit("implicit tail", null, "palette", variable),
        ]),
      ],
    };
  }

  function createBpdhFormatGuide(result) {
    const decoded = result?.decoded;
    const storage = decoded?.storage;
    const localBits = decoded?.localIndexBits ?? Math.log2(Number(elements.bpdhLocalColors.value));
    const globalBits = decoded?.globalIndexBits ?? Math.log2(Number(elements.bpdhGlobalColors.value));
    const paletteBits = decoded?.paletteIndexBits ?? Math.log2(Number(elements.bpdhPaletteCount.value));
    const variable = t("lab.formatGuideVariable");
    const requestedMode = elements.bpdhMode.value;
    const actualMode = decoded
      ? decoded.bpalBlockCount > 0 && decoded.dctBlockCount > 0
        ? "auto"
        : decoded.dctBlockCount > 0 ? "dct" : "bpal"
      : requestedMode;
    return {
      summary: "BPDH · v1 · 48 B · MCU 16×16",
      intro: t("lab.bpdhGuideIntro"),
      diagram: {
        kind: "bpdh",
        mode: actualMode,
        bpalBlockCount: decoded?.bpalBlockCount,
        dctBlockCount: decoded?.dctBlockCount,
        dctQuality: decoded?.dctQuality,
        localColorCount: decoded?.localColorCount ?? Number(elements.bpdhLocalColors.value),
        globalColorCount: decoded?.globalColorCount ?? Number(elements.bpdhGlobalColors.value),
        coefficientCodingKey: "exp-golomb-rle",
        zigzagOrder: true,
      },
      sections: [
        guideMapEntry(t("lab.guideHeader"), "48 B", t("lab.bpdhGuideHeaderDetail"), 384, "header"),
        guideMapEntry(t("lab.guideSharedPalettes"), storage ? formatBytes(storage.paletteBytes) : variable, t("lab.bpdhGuidePaletteDetail"), storage?.paletteBytes * 8, "palette"),
        guideMapEntry(t("lab.guideQuantTables"), storage ? formatBytes(storage.quantizationTableBytes) : "0 / 128 B", t("lab.bpdhGuideQuantDetail"), storage?.quantizationTableBytes * 8, "dct"),
        guideMapEntry(t("lab.guideModeMap"), storage ? formatBytes(storage.modeMapBytes) : "ceil(N / 8) B", t("lab.bpdhGuideModeDetail"), storage?.modeMapBytes * 8, "map"),
        guideMapEntry(t("lab.guideBpalPayload"), storage ? formatBits(storage.bpalBits) : variable, t("lab.bpdhGuideBpalDetail"), storage?.bpalBits, "index"),
        guideMapEntry(t("lab.guideDctPayload"), storage ? formatBits(storage.dctBits) : variable, t("lab.bpdhGuideDctDetail"), storage?.dctBits, "dct"),
      ],
      header: [
        guideHeaderField("0–3 B", 32, "magic", 'ASCII "BPDH"'),
        guideHeaderField("4 B", 8, "version", "1"),
        guideHeaderField("5 B", 8, "flags", "b0 = BPAL; b1 = DCT; b2–7 = 0"),
        guideHeaderField("6 B", 8, "codingUnitExp", "4 → 16×16 px"),
        guideHeaderField("7 B", 8, "reserved", "0"),
        guideHeaderField("8–11 B", 32, "width", "uint32 LE"),
        guideHeaderField("12–15 B", 32, "height", "uint32 LE"),
        guideHeaderField("16 B", 8, "localIndexBits", "localColorCount = 2^value"),
        guideHeaderField("17 B", 8, "globalIndexBits", "globalColorCount = 2^value"),
        guideHeaderField("18 B", 8, "paletteIndexBits", "paletteCount = 2^value"),
        guideHeaderField("19 B", 8, "paletteColorBits", "16 = RGB565; 24 = RGB888"),
        guideHeaderField("20–23 B", 32, "paletteBytes", "uint32 LE"),
        guideHeaderField("24–27 B", 32, "modeMapBytes", "uint32 LE"),
        guideHeaderField("28–31 B", 32, "bpalBytes", "ceil(bpalBits / 8)"),
        guideHeaderField("32–35 B", 32, "bpalBits", "bpalBits ≤ bpalBytes × 8"),
        guideHeaderField("36–39 B", 32, "quantTableBytes", "0 or 128"),
        guideHeaderField("40–43 B", 32, "dctBytes", "ceil(dctBits / 8)"),
        guideHeaderField("44–47 B", 32, "dctBits", "dctBits ≤ dctBytes × 8"),
      ],
      packing: [
        guidePacking(t("lab.bpdhFlagsTitle"), t("lab.bpdhFlagsNote"), [
          guideBit("BPAL", 1, "index"), guideBit("DCT", 1, "dct"), guideBit("reserved", 6, "reserved"),
        ]),
        guidePacking(t("lab.bpdhModeMapTitle"), t("lab.bpdhModeMapNote"), [
          guideBit("unit 0", 1, "map", "0 / 1"), guideBit("unit 1", 1, "map", "0 / 1"),
          guideBit("…", 1, "reserved"), guideBit("unit 7", 1, "map", "0 / 1"),
        ]),
        guidePacking(t("lab.bpdhBpalRecordTitle"), t("lab.bpdhBpalRecordNote"), [
          guideBit("palette selector", null, "map", `${paletteBits} ${guideBitUnit()}`),
          guideBit("local → global", null, "index", `2^${localBits} × ${globalBits}`),
          guideBit("pixel indices", null, "index", `valid px × ${localBits}`),
        ]),
        guidePacking(t("lab.bpdhDctRecordTitle"), t("lab.bpdhDctRecordNote"), [
          guideBit("DC", null, "dct", "SE(v)"), guideBit("non-zero", 1, "flag", "0"),
          guideBit("zero run", null, "map", "UE(run)"), guideBit("AC", null, "dct", "SE(v)"),
          guideBit("EOB", 1, "flag", "1"),
        ]),
      ],
    };
  }

  function renderFileMap(entries) {
    const map = document.createElement("div");
    map.className = "lab-file-map";
    for (const entry of entries) {
      const segment = document.createElement("div");
      segment.className = `lab-file-segment is-${entry.tone}`;
      segment.classList.toggle("is-empty", entry.bits === 0);
      const weight = Number.isFinite(entry.bits)
        ? clamp(Math.log2(entry.bits + 1) / 3, 1, 5)
        : 1.6;
      segment.style.setProperty("--segment-weight", String(weight));
      const label = document.createElement("strong");
      const size = document.createElement("span");
      const detail = document.createElement("small");
      label.textContent = entry.label;
      size.textContent = entry.size;
      detail.textContent = entry.detail;
      segment.append(label, size, detail);
      map.append(segment);
    }
    return map;
  }

  function renderHeaderTable(fields) {
    const wrapper = document.createElement("div");
    wrapper.className = "lab-format-table-wrap";
    const table = document.createElement("table");
    table.className = "lab-format-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const title of [
      t("lab.formatGuideOffset"),
      t("lab.formatGuideBits"),
      t("lab.formatGuideField"),
      t("lab.formatGuideMeaning"),
    ]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = title;
      headRow.append(cell);
    }
    head.append(headRow);
    const body = document.createElement("tbody");
    for (const field of fields) {
      const row = document.createElement("tr");
      for (const value of [field.offset, `${field.bits} ${guideBitUnit()}`, field.name, field.meaning]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    wrapper.append(table);
    return wrapper;
  }

  function renderPackingList(records) {
    const list = document.createElement("div");
    list.className = "lab-packing-list";
    for (const record of records) {
      const card = document.createElement("figure");
      card.className = "lab-packing-card";
      const caption = document.createElement("figcaption");
      caption.textContent = record.title;
      const strip = document.createElement("div");
      strip.className = "lab-bit-strip";
      for (const field of record.fields) {
        const cell = document.createElement("span");
        cell.className = `lab-bit-field is-${field.tone}`;
        const weight = Number.isFinite(field.bits)
          ? clamp(Math.sqrt(field.bits), 1, 6)
          : 2;
        cell.style.setProperty("--field-weight", String(weight));
        const label = document.createElement("strong");
        const bits = document.createElement("small");
        label.textContent = field.label;
        bits.textContent = field.bitsLabel || `${field.bits} ${guideBitUnit()}`;
        cell.append(label, bits);
        strip.append(cell);
      }
      const note = document.createElement("p");
      note.textContent = record.note;
      card.append(caption, strip, note);
      list.append(card);
    }
    return list;
  }

  function renderCodecBlockDiagram(diagram) {
    const layout = document.createElement("div");
    layout.className = "lab-codec-layout-diagrams";

    if (diagram.kind === "texture") {
      layout.append(
        renderTextureFootprintDiagram(diagram),
        renderTextureBitDiagram(diagram)
      );
      if (diagram.format === "astc") layout.append(renderAstcProfileOverview(diagram));
      return layout;
    }

    if (diagram.kind === "bpal") {
      layout.append(renderBpalBlockDiagram(diagram), renderNoDctDiagram());
      return layout;
    }

    if (diagram.kind === "bpdh") {
      layout.append(renderBpdhMcuDiagram(diagram));
      layout.append(diagram.mode === "bpal"
        ? renderNoDctDiagram()
        : renderDctBlockDiagram(diagram));
      if (diagram.mode !== "bpal") layout.append(renderDctRecordBitMap(diagram));
      return layout;
    }

    layout.append(
      renderDctMcuDiagram(diagram),
      renderDctBlockDiagram(diagram),
      renderDctRecordBitMap(diagram),
      renderDctProfileOverview()
    );
    return layout;
  }

  function renderTextureFootprintDiagram(diagram) {
    const figure = createCodecDiagramPanel(
      t("lab.textureFootprintTitle"),
      `${diagram.blockWidth}×${diagram.blockHeight} texels · ${diagram.blockBytes} B`
    );
    const grid = document.createElement("div");
    grid.className = "lab-texture-footprint-grid";
    grid.style.gridTemplateColumns = `repeat(${diagram.blockWidth}, minmax(0, 1fr))`;
    for (let y = 0; y < diagram.blockHeight; y += 1) {
      for (let x = 0; x < diagram.blockWidth; x += 1) {
        const texel = document.createElement("span");
        texel.textContent = `${x},${y}`;
        texel.classList.toggle("is-origin", x === 0 && y === 0);
        grid.append(texel);
      }
    }
    const note = document.createElement("p");
    note.className = "lab-codec-diagram-note";
    note.textContent = t("lab.textureFootprintNote", {
      width: diagram.blockWidth,
      height: diagram.blockHeight,
      bits: diagram.blockBytes * 8,
    });
    figure.append(grid, note);
    return figure;
  }

  function renderTextureBitDiagram(diagram) {
    const figure = createCodecDiagramPanel(
      t("lab.textureBlockTitle"),
      `${diagram.format.toUpperCase()} · ${diagram.blockBytes * 8} bit`
    );
    const strip = document.createElement("div");
    strip.className = "lab-texture-bit-strip";
    for (const field of diagram.blockFields) {
      const segment = document.createElement("span");
      const label = document.createElement("strong");
      const bits = document.createElement("small");
      segment.className = `is-${field.tone}`;
      segment.style.flexGrow = String(Number.isFinite(field.bits) ? field.bits : 24);
      label.textContent = field.label;
      bits.textContent = field.bitsLabel || `${field.bits} bit`;
      segment.append(label, bits);
      strip.append(segment);
    }
    const note = document.createElement("p");
    note.className = "lab-codec-diagram-note";
    note.textContent = t(`lab.${diagram.format}BlockNote`);
    figure.append(strip, note);
    return figure;
  }

  function renderAstcProfileOverview(diagram) {
    const section = document.createElement("section");
    const title = document.createElement("h4");
    const rows = document.createElement("div");
    section.className = "lab-astc-profile-overview";
    title.textContent = t("lab.astcProfilesTitle");
    rows.className = "lab-astc-profile-grid";
    for (const profile of root.StandardTextureCodecs.ASTC_PROFILES) {
      const [width, height] = profile.split("x").map(Number);
      const item = document.createElement("span");
      const label = document.createElement("strong");
      const rate = document.createElement("small");
      item.classList.toggle("is-selected", profile === diagram.profile);
      label.textContent = profile.replace("x", " × ");
      rate.textContent = `${(128 / (width * height)).toFixed(2)} bpp`;
      item.append(label, rate);
      rows.append(item);
    }
    section.append(title, rows);
    return section;
  }

  function renderDctProfileOverview() {
    const section = document.createElement("section");
    section.className = "lab-dct-profile-overview";
    const title = document.createElement("h4");
    const description = document.createElement("p");
    const rows = document.createElement("div");
    title.textContent = t("lab.dctProfileOverview");
    description.textContent = t("lab.dctProfileOverviewDescription");
    rows.className = "lab-dct-profile-rows";

    for (const [key, preset] of Object.entries(root.DctImageFormat.PRESETS)) {
      const row = document.createElement("div");
      const label = document.createElement("strong");
      const bar = document.createElement("div");
      const total = preset.bytesPerMcu;
      const size = document.createElement("output");
      row.className = `lab-dct-profile-row${key === elements.dctPreset.value ? " is-selected" : ""}`;
      label.textContent = `${key} bpp`;
      bar.className = "lab-dct-profile-bar";
      bar.append(
        dctProfileSegment("y", preset.yBytes, total, `Y ${preset.yBytes} B`),
        dctProfileSegment("cb", preset.cbBytes, total, `Cb ${preset.cbBytes} B`),
        dctProfileSegment("cr", preset.crBytes, total, `Cr ${preset.crBytes} B`)
      );
      size.textContent = `${total} B/MCU`;
      row.append(label, bar, size);
      rows.append(row);
    }
    section.append(title, description, rows);
    return section;
  }

  function dctProfileSegment(kind, bytes, total, label) {
    const segment = document.createElement("span");
    segment.className = `is-${kind}`;
    segment.style.flex = `${bytes / total} 1 0`;
    segment.textContent = label;
    return segment;
  }

  function renderBpalBlockDiagram(diagram) {
    const figure = createCodecDiagramPanel(
      t("lab.diagramBpalBlockTitle"),
      `${diagram.blockSize}×${diagram.blockSize} px · L ${diagram.localColorCount} · G ${diagram.globalColorCount}`
    );
    const flow = document.createElement("div");
    flow.className = "lab-bpal-block-flow";
    flow.append(
      codecDiagramStep(t("lab.diagramSelector"), `${diagram.paletteCount}`),
      codecDiagramArrow(),
      codecDiagramStep(t("lab.diagramLocalMap"), `${diagram.localColorCount} × ${Math.log2(diagram.globalColorCount)} bit`),
      codecDiagramArrow(),
      codecDiagramStep(t("lab.diagramPixelIndices"), `${diagram.blockSize ** 2} × ${Math.log2(diagram.localColorCount)} bit`)
    );
    const note = document.createElement("p");
    note.className = "lab-codec-diagram-note";
    note.textContent = t("lab.diagramBpalNote");
    figure.append(flow, note);
    return figure;
  }

  function renderNoDctDiagram() {
    const figure = createCodecDiagramPanel(t("lab.diagramDctBlockTitle"), t("lab.diagramNotUsed"));
    const empty = document.createElement("div");
    empty.className = "lab-no-dct-diagram";
    const mark = document.createElement("strong");
    const note = document.createElement("p");
    mark.textContent = "DCT ×";
    note.textContent = t("lab.diagramBpalNoDctNote");
    empty.append(mark, note);
    figure.append(empty);
    return figure;
  }

  function renderDctMcuDiagram(diagram) {
    const figure = createCodecDiagramPanel(
      t("lab.diagramMcuTitle"),
      `${diagram.bytesPerMcu} B/MCU · 4:2:0 · ${diagram.bpp} bpp`
    );
    const spatial = document.createElement("div");
    const luma = document.createElement("div");
    const chroma = document.createElement("div");
    spatial.className = "lab-mcu-spatial";
    luma.className = `lab-mcu-luma${diagram.splitLuma ? " is-split" : ""}`;
    chroma.className = "lab-mcu-chroma";

    if (diagram.splitLuma) {
      for (let block = 0; block < 4; block += 1) {
        luma.append(codecLayoutTile("y", `Y${block}\n8×8`));
      }
    } else {
      luma.append(codecLayoutTile("y", "Y\n16×16"));
    }
    chroma.append(codecLayoutTile("cb", "Cb\n8×8"), codecLayoutTile("cr", "Cr\n8×8"));
    spatial.append(luma, chroma);

    const bytes = document.createElement("div");
    bytes.className = "lab-mcu-byte-bar";
    bytes.append(
      codecByteSegment("y", diagram.yBytes, `Y · ${diagram.yBytes} B`),
      codecByteSegment("cb", diagram.cbBytes, `Cb · ${diagram.cbBytes} B`),
      codecByteSegment("cr", diagram.crBytes, `Cr · ${diagram.crBytes} B`)
    );
    const note = document.createElement("p");
    note.className = "lab-codec-diagram-note";
    note.textContent = t(diagram.splitLuma ? "lab.diagramDctMcuSplitNote" : "lab.diagramDctMcuSingleNote");
    figure.append(spatial, bytes, note);
    return figure;
  }

  function renderBpdhMcuDiagram(diagram) {
    const counts = Number.isInteger(diagram.bpalBlockCount) && Number.isInteger(diagram.dctBlockCount)
      ? `BPAL ${diagram.bpalBlockCount} · DCT ${diagram.dctBlockCount}`
      : t(`lab.diagramBpdhMode${diagram.mode === "auto" ? "Auto" : diagram.mode === "dct" ? "Dct" : "Bpal"}`);
    const figure = createCodecDiagramPanel(t("lab.diagramCodingUnitTitle"), `16×16 px · ${counts}`);
    const mode = document.createElement("div");
    const branches = document.createElement("div");
    mode.className = "lab-bpdh-mode-bit";
    const modeLabel = document.createElement("strong");
    const bpalBit = document.createElement("span");
    const dctBit = document.createElement("span");
    modeLabel.textContent = t("lab.diagramModeBit");
    bpalBit.textContent = "0 = BPAL";
    dctBit.textContent = "1 = DCT";
    mode.append(modeLabel, bpalBit, dctBit);
    branches.className = "lab-bpdh-branches";
    branches.append(
      codecHybridBranch("bpal", diagram.mode !== "dct", t("lab.diagramBpalBranch"), [
        `L ${diagram.localColorCount}`, `G ${diagram.globalColorCount}`, `16×16 · ${t("lab.diagramPixelIndices")}`,
      ]),
      codecHybridBranch("dct", diagram.mode !== "bpal", t("lab.diagramDctBranch"), [
        "Y0 · Y1 · Y2 · Y3", "Cb · Cr", `Q ${diagram.dctQuality ?? t("lab.diagramSearch")}`,
      ])
    );
    const note = document.createElement("p");
    note.className = "lab-codec-diagram-note";
    note.textContent = t(`lab.diagramBpdh${diagram.mode === "auto" ? "Auto" : diagram.mode === "dct" ? "Dct" : "Bpal"}Note`);
    figure.append(mode, branches, note);
    return figure;
  }

  function renderDctBlockDiagram(diagram) {
    const component = ["y", "cb", "cr"].includes(state.guideComponent)
      ? state.guideComponent : "y";
    const shape = getGuideDctShape(diagram, component);
    const coding = diagram.coefficientCodingKey || "DCT";
    const summary = shape.bytes === null
      ? `${component.toUpperCase()} · ${shape.width}×${shape.height} · ${t("lab.formatGuideVariable")} · ${coding}`
      : `${component.toUpperCase()} · ${shape.width}×${shape.height} · ${shape.bytes} B · ${coding}`;
    const figure = createCodecDiagramPanel(t("lab.diagramDctBlockTitle"), summary);
    const controls = document.createElement("div");
    controls.className = "lab-dct-component-controls";
    for (const name of ["y", "cb", "cr"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.guideComponent = name;
      button.classList.toggle("is-selected", name === component);
      button.setAttribute("aria-pressed", String(name === component));
      button.textContent = t(`lab.diagramComponent${name === "y" ? "Y" : name === "cb" ? "Cb" : "Cr"}`);
      controls.append(button);
    }
    const matrix = renderDctFrequencyMatrix(diagram, shape);
    const legend = renderDctDiagramLegend(diagram);
    const note = document.createElement("p");
    note.className = "lab-codec-diagram-note";
    note.textContent = dctDiagramNote(diagram);
    figure.append(controls, matrix, legend, note);
    return figure;
  }

  function getGuideDctShape(diagram, component) {
    if (diagram.kind === "bpdh") {
      return { component, width: 8, height: 8, bytes: null };
    }
    if (component === "y") {
      return {
        component,
        width: diagram.splitLuma ? 8 : 16,
        height: diagram.splitLuma ? 8 : 16,
        bytes: diagram.splitLuma ? diagram.yBytes / 4 : diagram.yBytes,
      };
    }
    return {
      component,
      width: 8,
      height: 8,
      bytes: component === "cb" ? diagram.cbBytes : diagram.crBytes,
    };
  }

  function renderDctFrequencyMatrix(diagram, shape) {
    const frame = document.createElement("div");
    const grid = document.createElement("div");
    const positions = diagram.zigzagOrder === false
      ? getGuideRowMajorPositions(shape.width, shape.height)
      : getGuideZigzagPositions(shape.width, shape.height);
    const ranks = new Map(positions.map((position, rank) => [`${position.u},${position.v}`, rank]));
    frame.className = `lab-dct-frequency-frame${shape.width > 8 ? " is-wide" : ""}`;
    grid.className = "lab-dct-frequency-grid";
    grid.style.gridTemplateColumns = `repeat(${shape.width}, minmax(0, 1fr))`;
    grid.setAttribute("role", "img");
    grid.setAttribute("aria-label", `${shape.component.toUpperCase()} ${shape.width}×${shape.height} · ${t(diagram.zigzagOrder === false
      ? "lab.diagramRowMajor" : "lab.diagramZigzag")}`);

    for (let v = 0; v < shape.height; v += 1) {
      for (let u = 0; u < shape.width; u += 1) {
        const rank = ranks.get(`${u},${v}`);
        const cell = document.createElement("span");
        const label = document.createElement("strong");
        const kind = guideCoefficientKind(diagram, rank, u, v);
        cell.className = `is-${kind}${rank < 16 || (rank < 100 && rank % 32 === 0) ? " is-major" : ""}`;
        label.textContent = String(rank);
        cell.append(label);
        cell.setAttribute("aria-label", `${rank === 0 ? "DC" : `AC${rank}`} · u ${u}, v ${v}`);
        grid.append(cell);
      }
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    svg.classList.add("lab-dct-zigzag");
    svg.setAttribute("viewBox", `0 0 ${shape.width} ${shape.height}`);
    svg.setAttribute("aria-hidden", "true");
    line.setAttribute("points", positions.map(({ u, v }) => `${u + 0.5},${v + 0.5}`).join(" "));
    svg.append(line);
    frame.append(grid, svg);
    return frame;
  }

  function getGuideZigzagPositions(width, height) {
    const positions = [];
    for (let diagonal = 0; diagonal <= width + height - 2; diagonal += 1) {
      const minimumU = Math.max(0, diagonal - (height - 1));
      const maximumU = Math.min(width - 1, diagonal);
      if (diagonal % 2 === 1) {
        for (let u = maximumU; u >= minimumU; u -= 1) positions.push({ u, v: diagonal - u });
      } else {
        for (let u = minimumU; u <= maximumU; u += 1) positions.push({ u, v: diagonal - u });
      }
    }
    return positions;
  }

  function getGuideRowMajorPositions(width, height) {
    return Array.from({ length: width * height }, (_, rank) => ({
      u: rank % width,
      v: Math.floor(rank / width),
    }));
  }

  function guideCoefficientKind(diagram, rank, u, v) {
    if (rank === 0) return "dc";
    const coding = diagram.coefficientCodingKey || "";
    if (!coding.startsWith("masked-tail")) return "ac";
    if (coding.includes("implicit2") && ((u === 1 && v === 0) || (u === 0 && v === 1))) return "implicit";
    if (rank <= 62) return "mask-tail";
    return "tail";
  }

  function renderDctDiagramLegend(diagram) {
    const legend = document.createElement("div");
    legend.className = "lab-dct-diagram-legend";
    legend.append(codecDiagramLegend("dc", t("lab.diagramDc")));
    const coding = diagram.coefficientCodingKey || "";
    if (!coding.startsWith("masked-tail")) {
      legend.append(codecDiagramLegend("ac", t("lab.diagramAc")));
    } else {
      if (coding.includes("implicit2")) legend.append(codecDiagramLegend("implicit", t("lab.diagramImplicit")));
      legend.append(
        codecDiagramLegend("mask-tail", t("lab.diagramMaskTail")),
        codecDiagramLegend("tail", t("lab.diagramTail"))
      );
    }
    legend.append(codecDiagramLegend("zigzag", t(diagram.zigzagOrder === false
      ? "lab.diagramRowMajor" : "lab.diagramZigzag")));
    return legend;
  }

  function dctDiagramNote(diagram) {
    if (diagram.kind === "bpdh") return t("lab.diagramBpdhDctPackingNote");
    const coding = diagram.coefficientCodingKey || "";
    if (coding.includes("implicit2")) return t("lab.diagramDctImplicit2Note");
    return t(coding.startsWith("masked-tail") ? "lab.diagramDctMaskedNote" : "lab.diagramDctGroupedNote");
  }

  function renderDctRecordBitMap(diagram) {
    const component = ["y", "cb", "cr"].includes(state.guideComponent)
      ? state.guideComponent : "y";
    const shape = getGuideDctShape(diagram, component);
    const componentName = t(`lab.diagramComponent${component === "y" ? "Y" : component === "cb" ? "Cb" : "Cr"}`);
    const figure = createCodecDiagramPanel(
      t("lab.dctBitMapTitle"),
      diagram.kind === "bpdh"
        ? `${componentName} · 8×8 · ${t("lab.formatGuideVariable")}`
        : `${componentName} · ${shape.width}×${shape.height} · ${shape.bytes} B`
    );
    figure.classList.add("lab-dct-record-map");

    if (diagram.kind === "bpdh") {
      figure.append(renderBpdhDctRecordMap(componentName));
      return figure;
    }

    const description = root.DctImageFormat.describeDctComponentRecord({
      byteCount: shape.bytes,
      width: shape.width,
      height: shape.height,
      presetKey: diagram.presetKey,
      coefficientCodingKey: diagram.coefficientCodingKey,
      zigzagOrder: diagram.zigzagOrder,
      allowSkip: !diagram.libraryReferenceCoding &&
        (component === "y" || diagram.splitLuma),
      libraryReferenceCoding: diagram.libraryReferenceCoding,
      libraryReferenceBits: diagram.libraryReferenceBits?.[component] || 0,
    });
    const intro = document.createElement("p");
    intro.className = "lab-codec-diagram-note";
    intro.textContent = t("lab.dctBitMapIntro", {
      component: componentName,
      bytes: description.byteCount,
      bits: description.totalBits,
    });
    const variants = document.createElement("div");
    variants.className = "lab-dct-record-variants";
    for (const variant of description.variants) {
      variants.append(renderDctRecordVariant(description, variant));
    }
    figure.append(intro, variants);

    if (description.prototypeReference?.location === "sidecar") {
      const sidecar = document.createElement("p");
      sidecar.className = "lab-dct-sidecar-note";
      sidecar.textContent = description.prototypeReference.bits > 0
        ? t("lab.dctSidecarReference", { bits: description.prototypeReference.bits })
        : t("lab.dctSidecarUnused");
      figure.append(sidecar);
    }
    return figure;
  }

  function renderDctRecordVariant(description, variant) {
    const section = document.createElement("section");
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    const order = document.createElement("span");
    const stats = document.createElement("div");
    const strip = document.createElement("div");
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    const note = document.createElement("p");
    section.className = "lab-dct-record-variant";
    heading.className = "lab-dct-record-heading";
    title.textContent = dctRecordVariantName(variant);
    order.textContent = t(variant.bitOrder === "lsb-first"
      ? "dct.layoutLsbFirst" : "dct.layoutMsbFirst");
    heading.append(title, order);

    stats.className = "lab-dct-record-stats";
    stats.append(
      dctRecordStat("DC", `1 × ${variant.dcBits} bit`),
      dctRecordStat("AC", variant.acBitDepths
        .map((entry) => `${entry.count} × ${entry.bits} bit`).join(" + ")),
      dctRecordStat(t("lab.dctStoredCoefficients"),
        `${variant.acCount + 1} / ${description.coefficientCount}`),
      dctRecordStat(t("lab.dctRecordSize"),
        `${description.byteCount} B · ${description.totalBits} bit`)
    );

    strip.className = "lab-dct-record-strip";
    strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", `${title.textContent} · ${description.totalBits} bit`);
    for (const field of variant.fields) {
      const segment = document.createElement("span");
      const label = document.createElement("strong");
      const bits = document.createElement("small");
      segment.className = `is-${dctRecordTone(field)}`;
      segment.style.flexGrow = String(Math.max(1, Math.sqrt(field.bits)));
      label.textContent = dctRecordFieldShort(field);
      bits.textContent = `${field.bits} b`;
      segment.append(label, bits);
      appendDctByteBoundaries(segment, field, description.totalBits);
      strip.append(segment);
    }

    const headerRow = document.createElement("tr");
    for (const label of [
      t("lab.formatGuideOffset"),
      t("lab.formatGuideBits"),
      t("lab.formatGuideField"),
      t("lab.formatGuideMeaning"),
    ]) {
      const cell = document.createElement("th");
      cell.textContent = label;
      headerRow.append(cell);
    }
    head.append(headerRow);
    for (const field of variant.fields) {
      const row = document.createElement("tr");
      const values = [
        dctRecordBitRange(field, variant.bitOrder),
        String(field.bits),
        dctRecordFieldLabel(field),
        dctRecordFieldMeaning(field),
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    table.className = "lab-format-table lab-dct-record-table";
    table.append(head, body);
    note.className = "lab-codec-diagram-note";
    note.textContent = dctRecordVariantNote(variant);
    section.append(heading, stats, strip, table, note);
    return section;
  }

  function appendDctByteBoundaries(segment, field, totalBits) {
    const fieldEnd = field.startBit + field.bits;
    const firstBoundary = Math.max(8, Math.ceil(field.startBit / 8) * 8);

    for (let boundary = firstBoundary;
      boundary < fieldEnd && boundary < totalBits;
      boundary += 8) {
      const marker = document.createElement("i");
      marker.className = "lab-dct-byte-boundary";
      marker.style.left = `${(boundary - field.startBit) / field.bits * 100}%`;
      marker.setAttribute("aria-hidden", "true");
      segment.append(marker);
    }
  }

  function renderBpdhDctRecordMap(componentName) {
    const section = document.createElement("section");
    const stats = document.createElement("div");
    const strip = document.createElement("div");
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    const note = document.createElement("p");
    section.className = "lab-dct-record-variant";
    stats.className = "lab-dct-record-stats";
    stats.append(
      dctRecordStat("DC", t("lab.dctVariableExpGolomb")),
      dctRecordStat("AC", t("lab.dctBpdhAcCapacity")),
      dctRecordStat(t("lab.dctRecordSize"), t("lab.formatGuideVariable")),
      dctRecordStat(t("lab.dctBitOrder"), t("dct.layoutMsbFirst"))
    );
    strip.className = "lab-dct-record-strip";
    for (const [short, bits, tone] of [
      ["DC se(v)", "var", "dct"],
      ["0", "1 b", "flag"],
      ["run ue(v)", "var", "map"],
      ["AC se(v)", "var", "dct"],
      ["…", "×0…63", "reserved"],
      ["EOB=1", "1 b", "flag"],
    ]) {
      const segment = document.createElement("span");
      const label = document.createElement("strong");
      const detail = document.createElement("small");
      segment.className = `is-${tone}`;
      label.textContent = short;
      detail.textContent = bits;
      segment.append(label, detail);
      strip.append(segment);
    }
    const headerRow = document.createElement("tr");
    for (const label of [t("lab.formatGuideOffset"), t("lab.formatGuideField"), t("lab.formatGuideMeaning")]) {
      const cell = document.createElement("th");
      cell.textContent = label;
      headerRow.append(cell);
    }
    head.append(headerRow);
    for (const values of [
      ["cursor", "DC · se(v)", t("lab.dctBpdhDcMeaning")],
      ["next 1 bit", "AC marker = 0", t("lab.dctBpdhMarkerMeaning")],
      ["cursor", "zero run · ue(v)", t("lab.dctBpdhRunMeaning")],
      ["cursor", "AC · se(v)", t("lab.dctBpdhAcMeaning")],
      ["next 1 bit", "EOB = 1", t("lab.dctBpdhEobMeaning")],
    ]) {
      const row = document.createElement("tr");
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    table.className = "lab-format-table lab-dct-record-table is-variable";
    table.append(head, body);
    note.className = "lab-codec-diagram-note";
    note.textContent = t("lab.dctBpdhRecordNote", { component: componentName });
    section.append(stats, strip, table, note);
    return section;
  }

  function dctRecordStat(label, value) {
    const stat = document.createElement("span");
    const name = document.createElement("small");
    const detail = document.createElement("strong");
    name.textContent = label;
    detail.textContent = value;
    stat.append(name, detail);
    return stat;
  }

  function dctRecordVariantName(variant) {
    if (variant.mode === "legacy") return t("lab.dctVariantLegacy");
    if (variant.mode === "grouped") {
      const groups = variant.fields.filter((field) => field.key === "ac-group-scale").length;
      return t("dct.layoutGroupedVariant", { groups });
    }
    if (variant.mode === "skip-rle") return t("dct.layoutSkipRleVariant");
    if (variant.mode === "dual-scale-skip") return t("dct.layoutDualScaleVariant");
    if (variant.mode === "masked-tail-implicit2") return t("dct.layoutImplicit2Variant");
    return t("dct.layoutMaskedVariant");
  }

  function dctRecordVariantNote(variant) {
    if (variant.mode === "legacy" || variant.mode === "grouped") {
      const bits = variant.acBitDepths[0]?.bits || 0;
      return t("lab.dctGroupedRecordNote", { count: variant.acCount, bits });
    }
    if (variant.mode === "skip-rle") {
      return t("dct.layoutSkipRleNote", { count: variant.acCount });
    }
    if (variant.mode === "dual-scale-skip") {
      return t("lab.dctDualScaleRecordNote", {
        coarse: variant.coarseAcCount,
        fine: variant.fineAcCount,
        tail: variant.tailAcCount,
      });
    }
    if (variant.mode === "masked-tail-implicit2") return t("dct.layoutImplicit2Note");
    return t("dct.layoutMaskedNote", { count: variant.acCount });
  }

  function dctRecordFieldShort(field) {
    const names = {
      "library-index": "LIB",
      profile: "P",
      "record-mode": field.value ? "1" : "0",
      "dc-scale": "Sdc",
      "shared-scale": "S",
      "main-scale": "S",
      dc: "DC",
      "ac-group-scale": `S${field.group}`,
      "ac-group-values": `G${field.group}×${field.count}`,
      "ac-values": `AC×${field.count}`,
      "coarse-skip-tokens": `C×${field.count}`,
      "fine-skip-tokens": `F×${field.count}`,
      "fine-tail-tokens": `FT×${field.count}`,
      "ac-mask-low": "M1–32",
      "ac-mask-high": "M33–62",
      "ac-selection-mask": "M60",
      "implicit-ac-values": `I×${field.count}`,
      "selected-tail-ac-values": `AC×${field.count}`,
      padding: "∅",
    };
    return names[field.key] || field.key;
  }

  function dctRecordFieldLabel(field) {
    if (field.key === "library-index") return t("lab.dctFieldLibraryIndex");
    if (field.key === "profile") return t("dct.layoutFieldProfile");
    if (field.key === "record-mode") return t(field.value
      ? "dct.layoutFieldSkipOne" : "dct.layoutFieldSkipZero");
    if (field.key === "dc-scale") return t("dct.layoutFieldDcScale");
    if (field.key === "shared-scale") return t("dct.layoutFieldSharedScale");
    if (field.key === "main-scale") return t("dct.layoutFieldMainScale");
    if (field.key === "dc") return t("dct.layoutFieldSignedDc", { bits: field.valueBits });
    if (field.key === "ac-group-scale") return t("lab.dctFieldGroupScale", { group: field.group });
    if (["ac-group-values", "ac-values", "selected-tail-ac-values"].includes(field.key)) {
      return t("dct.layoutFieldSignedAc", { count: field.count, bits: field.valueBits });
    }
    if (field.key === "coarse-skip-tokens") return t("dct.layoutFieldCoarseTokens", { count: field.count });
    if (field.key === "fine-skip-tokens") return t("dct.layoutFieldFineTokens", { count: field.count });
    if (field.key === "fine-tail-tokens") return t("lab.dctFieldTailTokens", { count: field.count });
    if (field.key === "ac-mask-low" || field.key === "ac-mask-high") {
      return t("lab.dctFieldMaskRange", { first: field.firstRank, last: field.lastRank });
    }
    if (field.key === "ac-selection-mask") return t("dct.layoutFieldMask60");
    if (field.key === "implicit-ac-values") return t("lab.dctFieldImplicitValues", {
      count: field.count,
      bits: field.valueBits,
    });
    if (field.key === "padding") return t("dct.layoutFieldPadding");
    return field.key;
  }

  function dctRecordFieldMeaning(field) {
    if (field.key === "profile") return t("lab.dctProfileMeaning");
    if (field.key === "library-index") return t("lab.dctLibraryIndexMeaning");
    if (field.key === "record-mode") return t("lab.dctRecordModeMeaning", { value: field.value });
    if (["dc-scale", "shared-scale", "main-scale", "ac-group-scale"].includes(field.key)) {
      return t("lab.dctScaleMeaning");
    }
    if (field.key === "dc") return t("lab.dctDcMeaning", { bits: field.valueBits });
    if (["coarse-skip-tokens", "fine-skip-tokens"].includes(field.key)) {
      return t("lab.dctSkipTokenMeaning", {
        count: field.count,
        bits: field.valueBits,
        skip: field.skipBits,
      });
    }
    if (field.key === "fine-tail-tokens") {
      return t("lab.dctTailTokenMeaning", { count: field.count, bits: field.valueBits });
    }
    if (["ac-mask-low", "ac-mask-high", "ac-selection-mask"].includes(field.key)) {
      return t("lab.dctMaskMeaning");
    }
    if (field.key === "implicit-ac-values") return t("lab.dctImplicitMeaning");
    if (["ac-group-values", "ac-values", "selected-tail-ac-values"].includes(field.key)) {
      return t("lab.dctAcValuesMeaning", { count: field.count, bits: field.valueBits });
    }
    if (field.key === "padding") return t("lab.dctPaddingMeaning");
    return "";
  }

  function dctRecordBitRange(field, bitOrder) {
    const endBit = field.startBit + field.bits - 1;
    const position = (bit) => {
      const byte = Math.floor(bit / 8);
      const within = bit % 8;
      const byteBit = bitOrder === "lsb-first" ? within : 7 - within;
      return `B${byte}:b${byteBit}`;
    };
    const stream = field.startBit === endBit
      ? String(field.startBit) : `${field.startBit}–${endBit}`;
    const bytes = field.bits === 1
      ? position(field.startBit) : `${position(field.startBit)} → ${position(endBit)}`;
    return `${stream} · ${bytes}`;
  }

  function dctRecordTone(field) {
    if (field.tone === "map") return "map";
    if (field.tone === "flag") return "flag";
    if (field.tone === "index") return "index";
    if (field.tone === "reserved") return "reserved";
    if (field.key === "dc") return "dc";
    return field.tone === "dct" ? "dct" : "header";
  }

  function defaultDctGuideCoding(presetKey) {
    if (presetKey === "0.75") return "skip-rle-equal-2";
    if (presetKey === "1" || presetKey === "2") return "dual-scale-skip-equal-2";
    if (presetKey === "1.5" || presetKey === "3" || presetKey === "4.5") return "dual-scale-skip-front";
    return "grouped-5-front";
  }

  function createCodecDiagramPanel(title, summary) {
    const figure = document.createElement("figure");
    const caption = document.createElement("figcaption");
    const heading = document.createElement("strong");
    const detail = document.createElement("span");
    figure.className = "lab-codec-diagram";
    heading.textContent = title;
    detail.textContent = summary;
    caption.append(heading, detail);
    figure.append(caption);
    return figure;
  }

  function codecDiagramStep(label, detail) {
    const step = document.createElement("span");
    const strong = document.createElement("strong");
    const small = document.createElement("small");
    strong.textContent = label;
    small.textContent = detail;
    step.append(strong, small);
    return step;
  }

  function codecDiagramArrow() {
    const arrow = document.createElement("b");
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    return arrow;
  }

  function codecLayoutTile(component, label) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.dataset.guideComponent = component;
    tile.className = `is-${component}${state.guideComponent === component ? " is-selected" : ""}`;
    tile.setAttribute("aria-pressed", String(state.guideComponent === component));
    tile.textContent = label;
    return tile;
  }

  function codecByteSegment(component, bytes, label) {
    const segment = document.createElement("button");
    segment.type = "button";
    segment.dataset.guideComponent = component;
    segment.className = `is-${component}${state.guideComponent === component ? " is-selected" : ""}`;
    segment.setAttribute("aria-pressed", String(state.guideComponent === component));
    segment.style.flexGrow = String(bytes);
    segment.textContent = label;
    return segment;
  }

  function codecHybridBranch(kind, active, title, details) {
    const branch = document.createElement("section");
    const heading = document.createElement("strong");
    const list = document.createElement("div");
    branch.className = `is-${kind}${active ? " is-active" : ""}`;
    heading.textContent = title;
    for (const detail of details) {
      const item = document.createElement("span");
      item.textContent = detail;
      list.append(item);
    }
    branch.append(heading, list);
    return branch;
  }

  function codecDiagramLegend(kind, label) {
    const entry = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.className = `is-${kind}`;
    swatch.setAttribute("aria-hidden", "true");
    entry.append(swatch, label);
    return entry;
  }

  function formatGuideSection(title, content) {
    const section = document.createElement("section");
    section.className = "lab-format-guide-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading, content);
    return section;
  }

  function guideMapEntry(label, size, detail, bits, tone) {
    return { label, size, detail, bits, tone };
  }

  function guideHeaderField(offset, bits, name, meaning) {
    return { offset, bits, name, meaning };
  }

  function guidePacking(title, note, fields) {
    return { title, note, fields };
  }

  function guideBit(label, bits, tone = "header", bitsLabel = "") {
    return { label, bits, tone, bitsLabel };
  }

  function guideSize(bits, fallback) {
    return Number.isFinite(bits) ? formatBits(bits) : fallback;
  }

  function guideBitUnit() {
    return t("lab.formatGuideBitUnit");
  }

  function renderStructure(result) {
    const adapter = currentAdapter();
    elements.structureSummary.textContent = `${adapter.label} · ${formatBytes(result.encoded.byteLength)}`;
    elements.structureFlow.replaceChildren(...adapter.renderStructure(result));
    renderFormatGuide();
  }

  function renderInspector(x, y) {
    if (!state.result || !state.sourceImageData) return;

    const result = state.result;
    const adapter = currentAdapter();
    const px = clamp(Math.trunc(x), 0, result.imageData.width - 1);
    const py = clamp(Math.trunc(y), 0, result.imageData.height - 1);
    comparison.setSelectedPixel(px, py);
    elements.coordinateX.value = String(px);
    elements.coordinateY.value = String(py);
    const sampled = normalizeColor(adapter.sample(result, px, py));
    const full = rgbaAt(result.imageData.data, result.imageData.width, px, py);
    const source = rgbaAt(state.sourceImageData.data, state.sourceImageData.width, px, py);
    const match = colorsEqual(sampled, full);
    const detail = adapter.inspect(result, px, py);

    elements.selectedUnit.textContent = detail.label;
    elements.pixelCoordinate.textContent = `${px}, ${py}`;
    elements.pixelSourceColor.textContent = colorText(source);
    elements.pixelFullColor.textContent = colorText(full);
    elements.pixelSampledColor.textContent = colorText(sampled);
    elements.pixelMatch.textContent = t(match ? "hybrid.match" : "hybrid.mismatch");
    elements.pixelMatchCard.classList.toggle("is-match", match);
    elements.pixelMatchCard.classList.toggle("is-mismatch", !match);
    elements.pixelSwatch.style.backgroundColor = `rgb(${sampled.r}, ${sampled.g}, ${sampled.b})`;
    elements.blockDetailsBody.replaceChildren(detail.body);
    if (state.format === "bpal") renderBpalPalettes(result.raw, px, py);
    comparison.drawOverlay();
  }

  function clearInspector() {
    elements.selectedUnit.textContent = "—";
    elements.pixelCoordinate.textContent = "—";
    elements.pixelSourceColor.textContent = "—";
    elements.pixelFullColor.textContent = "—";
    elements.pixelSampledColor.textContent = "—";
    elements.pixelMatch.textContent = "—";
    elements.pixelMatchCard.classList.remove("is-match", "is-mismatch");
    elements.pixelSwatch.style.backgroundColor = "#111820";
    elements.coordinateX.value = "0";
    elements.coordinateY.value = "0";
    elements.blockDetailsBody.replaceChildren(emptyState(t("lab.selectPixel")));
  }

  function clearBpalPalettes() {
    elements.bpalBlockLabel.textContent = "—";
    elements.bpalPaletteSummary.textContent = "—";
    elements.bpalBlockPalette.replaceChildren();
    elements.bpalGlobalPalette.replaceChildren();
  }

  function renderBpalPalettes(image, selectedX, selectedY) {
    const blockSize = image.blockSize || image.codingUnitSize;
    const blockX = Math.floor(selectedX / blockSize);
    const blockY = Math.floor(selectedY / blockSize);
    const blockIndex = blockY * image.blocksX + blockX;
    const paletteIndex = image.blockPaletteSelectors[blockIndex];
    const paletteBase = paletteIndex * image.globalColorCount;
    const paletteOffset = blockIndex * image.localColorCount;
    const entries = [];

    for (let localIndex = 0; localIndex < image.localColorCount; localIndex += 1) {
      const globalIndex = image.blockPaletteIndices[paletteOffset + localIndex];
      const color = image.palette[paletteBase + globalIndex];
      const item = document.createElement("div");
      const sample = document.createElement("span");
      const data = document.createElement("span");
      const hex = document.createElement("strong");
      const mapping = document.createElement("span");

      item.className = "block-swatch";
      sample.className = "swatch-color";
      sample.style.backgroundColor = colorCss(color);
      sample.textContent = String(localIndex);
      data.className = "swatch-data";
      hex.textContent = color.hex || colorHex(color);
      mapping.textContent = t("block.mapping", {
        local: localIndex,
        palette: paletteIndex + 1,
        global: globalIndex,
      });
      data.append(hex, mapping);
      item.append(sample, data);
      entries.push(item);
    }

    elements.bpalBlockLabel.textContent = t("block.blockLabel", {
      x: blockX,
      y: blockY,
      x1: blockX * blockSize,
      x2: Math.min(image.width, (blockX + 1) * blockSize) - 1,
      y1: blockY * blockSize,
      y2: Math.min(image.height, (blockY + 1) * blockSize) - 1,
      palette: paletteIndex + 1,
    });
    elements.bpalBlockPalette.replaceChildren(...entries);
    elements.bpalPaletteSummary.textContent = t("block.paletteSummary", {
      palettes: image.paletteCount,
      active: formatInteger(image.activeGlobalColorCount),
      used: formatInteger(image.resultColorCount),
      format: Number(image.paletteColorBits) === 16 ? "RGB565" : "RGB888",
    });
    if (elements.bpalGlobalPalette.childElementCount === 0) {
      renderBpalGlobalPalettes(image);
    }
  }

  function renderBpalGlobalPalettes(image) {
    const groups = [];

    for (let paletteIndex = 0; paletteIndex < image.paletteCount; paletteIndex += 1) {
      const group = document.createElement("section");
      const title = document.createElement("h3");
      const colors = document.createElement("div");
      const paletteBase = paletteIndex * image.globalColorCount;

      group.className = "shared-palette-group";
      title.textContent = t("block.paletteLabel", { palette: paletteIndex + 1 });
      colors.className = "global-palette-colors";
      colors.replaceChildren(...image.palette
        .slice(paletteBase, paletteBase + image.globalColorCount)
        .map((color, paletteColorIndex) => createBpalGlobalSwatch(
          color,
          paletteIndex,
          paletteColorIndex,
          image.globalIndexBits
        )));
      group.append(title, colors);
      groups.push(group);
    }

    elements.bpalGlobalPalette.replaceChildren(...groups);
  }

  function createBpalGlobalSwatch(color, paletteIndex, paletteColorIndex, indexBits) {
    const item = document.createElement("div");
    const sample = document.createElement("span");
    const label = document.createElement("small");
    const hex = color.hex || colorHex(color);
    const pixelCount = Number(color.count) || 0;

    item.className = `global-swatch${pixelCount === 0 ? " is-unused" : ""}`;
    item.title = t("block.indexTitle", {
      palette: paletteIndex + 1,
      index: paletteColorIndex,
      hex,
      pixels: t("units.pixels", { value: formatInteger(pixelCount) }),
    });
    sample.className = "swatch-color";
    sample.style.backgroundColor = colorCss(color);
    sample.textContent = formatPaletteIndex(paletteColorIndex, indexBits);
    label.textContent = hex;
    item.append(sample, label);
    return item;
  }

  function renderBpalBlock(image, blockIndex, selectedX, selectedY) {
    const fragment = document.createElement("div");
    fragment.className = "lab-detail-section";
    const blockSize = image.blockSize || image.codingUnitSize;
    const blockX = blockIndex % image.blocksX;
    const blockY = Math.floor(blockIndex / image.blocksX);
    const startX = blockX * blockSize;
    const startY = blockY * blockSize;
    const width = Math.min(blockSize, image.width - startX);
    const height = Math.min(blockSize, image.height - startY);
    const paletteSelector = image.blockPaletteSelectors[blockIndex];
    const paletteBase = paletteSelector * image.globalColorCount;
    const offset = blockIndex * image.localColorCount;

    fragment.append(metadataGrid([
      ["Block", `#${blockIndex} · (${blockX}, ${blockY})`],
      ["Extent", `${width} × ${height} px · x ${startX}–${startX + width - 1}, y ${startY}–${startY + height - 1}`],
      ["Shared palette", `#${paletteSelector}`],
      ["Indices", `${image.localIndexBits} local bits · ${image.globalIndexBits} global bits`],
    ]));

    const colorsSection = detailSection("Local → global palette entries");
    const colorList = document.createElement("div");
    colorList.className = "lab-color-list";
    for (let localIndex = 0; localIndex < image.localColorCount; localIndex += 1) {
      const globalIndex = image.blockPaletteIndices[offset + localIndex];
      const color = image.palette[paletteBase + globalIndex];
      colorList.append(colorEntry(localIndex, globalIndex, color));
    }
    colorsSection.append(colorList);
    fragment.append(colorsSection);

    const indexSection = detailSection("Stored pixel-local indices");
    const grid = document.createElement("div");
    grid.className = "lab-index-grid";
    grid.style.setProperty("--columns", String(width));
    for (let y = startY; y < startY + height; y += 1) {
      for (let x = startX; x < startX + width; x += 1) {
        const localIndex = image.pixelIndices[y * image.width + x];
        const globalIndex = image.blockPaletteIndices[offset + localIndex];
        const color = image.palette[paletteBase + globalIndex];
        const cell = document.createElement("span");
        cell.textContent = String(localIndex);
        cell.title = `${x}, ${y} · L${localIndex} → G${globalIndex}`;
        cell.style.backgroundColor = colorCss(color);
        cell.style.color = contrastingTextColor(color);
        cell.classList.toggle("is-selected", x === selectedX && y === selectedY);
        grid.append(cell);
      }
    }
    indexSection.append(grid);
    fragment.append(indexSection);
    return fragment;
  }

  function renderDctMcu(mcu, info) {
    const fragment = document.createElement("div");
    fragment.className = "lab-detail-section";
    fragment.append(metadataGrid([
      ["MCU", `#${mcu.index} · (${mcu.x}, ${mcu.y})`],
      ["Byte range", `${mcu.byteOffset}…${mcu.byteOffset + mcu.bytes - 1}`],
      ["Record size", `${mcu.bytes} B`],
      ["Sampling", info.chromaSubsampling],
      ["Coefficient coding", info.coefficientCodingKey],
      ["Quality", String(info.quality)],
    ]));

    const matrices = [];
    appendDctComponentMatrices(matrices, "Y", mcu.components.y, info.splitLuma8x8 ? 8 : 16);
    appendDctComponentMatrices(matrices, "Cb", mcu.components.cb, 8);
    appendDctComponentMatrices(matrices, "Cr", mcu.components.cr, 8);
    fragment.append(matrixSection(matrices));
    return fragment;
  }

  function appendDctComponentMatrices(target, name, component, width) {
    if (component.blocks) {
      component.blocks.forEach((block, index) => target.push({ name: `${name}${index}`, coefficients: block.coefficients, width: 8 }));
    } else {
      target.push({ name, coefficients: component.coefficients, width });
    }
  }

  function renderBpdhDctBlock(decoded, blockIndex) {
    const fragment = document.createElement("div");
    fragment.className = "lab-detail-section";
    const bits = root.BpdhFormat.getDctMacroblockBitLength(decoded.dctBlocks[blockIndex]);
    fragment.append(metadataGrid([
      ["Coding unit", `#${blockIndex}`],
      ["Mode", "DCT 4:2:0"],
      ["Stored payload", `${bits} bits`],
      ["Components", "Y0–Y3 + Cb + Cr"],
    ]));
    const names = ["Y0", "Y1", "Y2", "Y3", "Cb", "Cr"];
    fragment.append(matrixSection(decoded.dctBlocks[blockIndex].map((coefficients, index) => ({
      name: names[index], coefficients, width: 8,
    }))));
    return fragment;
  }

  function renderStandardTextureBlock(info, blockIndex, blockX, blockY, bytes, description) {
    const fragment = document.createElement("div");
    fragment.className = "lab-detail-section lab-texture-block-details";
    const byteOffset = info.headerBytes + blockIndex * info.blockBytes;
    fragment.append(metadataGrid([
      ["Block", `#${blockIndex} · (${blockX}, ${blockY})`],
      ["Extent", `${info.blockWidth} × ${info.blockHeight} texels`],
      ["Byte range", `${byteOffset}…${byteOffset + info.blockBytes - 1}`],
      ["Record size", `${info.blockBytes} B · ${info.blockBytes * 8} bit`],
      ["Encoding", description ? `${description.format} ${description.mode === 6 ? "mode 6" : description.mode}` : `${info.profile} · ${info.quality}`],
    ]));

    const byteSection = detailSection(t("lab.storedBlockBytes"));
    const byteGrid = document.createElement("div");
    byteGrid.className = "lab-texture-byte-grid";
    bytes.forEach((value, index) => {
      const cell = document.createElement("span");
      const offset = document.createElement("small");
      const hex = document.createElement("strong");
      const bits = document.createElement("code");
      offset.textContent = `B${index}`;
      hex.textContent = value.toString(16).padStart(2, "0").toUpperCase();
      bits.textContent = value.toString(2).padStart(8, "0");
      cell.append(offset, hex, bits);
      byteGrid.append(cell);
    });
    byteSection.append(byteGrid);
    fragment.append(byteSection);

    if (!description) return fragment;

    const endpoints = detailSection(t("lab.textureEndpoints"));
    const palette = document.createElement("div");
    palette.className = "lab-texture-palette";
    description.palette?.forEach((color, index) => palette.append(textureColorCard(`P${index}`, color)));
    if (!description.palette) {
      description.endpoints.forEach((color, index) => palette.append(textureColorCard(`E${index}`, color)));
    } else {
      const endpointRow = document.createElement("div");
      endpointRow.className = "lab-texture-endpoints";
      description.endpoints.forEach((color, index) => endpointRow.append(textureColorCard(`E${index}`, color)));
      endpoints.append(endpointRow);
    }
    endpoints.append(palette);

    const selectorSection = detailSection(t("lab.textureSelectors"));
    const selectorGrid = document.createElement("div");
    selectorGrid.className = "lab-texture-selector-grid";
    description.selectors.forEach((selector, index) => {
      const cell = document.createElement("span");
      cell.textContent = String(selector);
      cell.title = `x=${index % 4}, y=${Math.floor(index / 4)}`;
      selectorGrid.append(cell);
    });
    selectorSection.append(selectorGrid);
    fragment.append(endpoints, selectorSection);
    return fragment;
  }

  function textureColorCard(label, color) {
    const card = document.createElement("span");
    const swatch = document.createElement("i");
    const name = document.createElement("strong");
    const value = document.createElement("code");
    card.className = "lab-texture-color";
    swatch.style.backgroundColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${(color.a ?? 255) / 255})`;
    name.textContent = label;
    value.textContent = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a ?? 255})`;
    card.append(swatch, name, value);
    return card;
  }

  function matrixSection(matrices) {
    const section = detailSection("Quantized DCT coefficients");
    const list = document.createElement("div");
    list.className = "lab-matrix-list";
    for (const matrix of matrices) {
      const figure = document.createElement("figure");
      figure.className = "lab-coefficient-matrix";
      figure.classList.toggle("is-wide", matrix.width > 8);
      const caption = document.createElement("figcaption");
      caption.textContent = matrix.name;
      const grid = document.createElement("div");
      grid.className = "lab-coefficient-grid";
      grid.style.setProperty("--columns", String(matrix.width));
      for (let index = 0; index < (matrix.coefficients || []).length; index += 1) {
        const value = matrix.coefficients[index];
        const cell = document.createElement("span");
        cell.textContent = formatCoefficient(value);
        cell.title = `u=${index % matrix.width}, v=${Math.floor(index / matrix.width)} · ${value}`;
        cell.classList.toggle("is-zero", value === 0);
        cell.classList.toggle("is-dc", index === 0);
        grid.append(cell);
      }
      figure.append(caption, grid);
      list.append(figure);
    }
    section.append(list);
    return section;
  }

  function drawBlockOverlay(context, view, blockSize, modeColor) {
    drawRectangularBlockOverlay(context, view, blockSize, blockSize, modeColor);
  }

  function drawRectangularBlockOverlay(context, view, blockWidth, blockHeight, modeColor = null) {
    const blocksX = Math.ceil(view.width / blockWidth);
    const blocksY = Math.ceil(view.height / blockHeight);
    const lineWidth = Math.max(0.4, Math.min(view.width, view.height) / 720);

    if (elements.showOverlay.checked) {
      for (let blockY = 0; blockY < blocksY; blockY += 1) {
        for (let blockX = 0; blockX < blocksX; blockX += 1) {
          const blockIndex = blockY * blocksX + blockX;
          const x = blockX * blockWidth;
          const y = blockY * blockHeight;
          const width = Math.min(blockWidth, view.width - x);
          const height = Math.min(blockHeight, view.height - y);
          if (modeColor) {
            context.fillStyle = modeColor(blockIndex);
            context.fillRect(x, y, width, height);
          }
          context.strokeStyle = "rgba(221, 233, 244, 0.34)";
          context.lineWidth = lineWidth;
          context.strokeRect(x + lineWidth / 2, y + lineWidth / 2, Math.max(0, width - lineWidth), Math.max(0, height - lineWidth));
        }
      }
    }

    const selectedBlockX = Math.floor(view.selectedX / blockWidth);
    const selectedBlockY = Math.floor(view.selectedY / blockHeight);
    const x = selectedBlockX * blockWidth;
    const y = selectedBlockY * blockHeight;
    const width = Math.min(blockWidth, view.width - x);
    const height = Math.min(blockHeight, view.height - y);
    context.fillStyle = "rgba(255, 240, 106, 0.12)";
    context.fillRect(x, y, width, height);
    context.strokeStyle = "#fff06a";
    const selectedLineWidth = Math.max(0.75, lineWidth * 1.5);
    context.lineWidth = selectedLineWidth;
    context.strokeRect(x + selectedLineWidth / 2, y + selectedLineWidth / 2, Math.max(0, width - selectedLineWidth), Math.max(0, height - selectedLineWidth));
  }

  function structureCard(label, value, detail) {
    const card = document.createElement("div");
    card.className = "lab-structure-card";
    const caption = document.createElement("span");
    const strong = document.createElement("strong");
    const small = document.createElement("small");
    caption.textContent = label;
    strong.textContent = value;
    small.textContent = detail;
    card.append(caption, strong, small);
    return card;
  }

  function metadataGrid(entries) {
    const grid = document.createElement("div");
    grid.className = "lab-detail-metadata";
    for (const [label, value] of entries) {
      const item = document.createElement("div");
      const caption = document.createElement("span");
      const strong = document.createElement("strong");
      caption.textContent = label;
      strong.textContent = value;
      item.append(caption, strong);
      grid.append(item);
    }
    return grid;
  }

  function detailSection(title) {
    const section = document.createElement("section");
    section.className = "lab-detail-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading);
    return section;
  }

  function colorEntry(localIndex, globalIndex, color) {
    const entry = document.createElement("div");
    entry.className = "lab-color-entry";
    const swatch = document.createElement("i");
    const mapping = document.createElement("code");
    const value = document.createElement("strong");
    swatch.style.backgroundColor = colorCss(color);
    mapping.textContent = `L${localIndex} → G${globalIndex}`;
    value.textContent = colorHex(color);
    entry.append(swatch, mapping, value);
    return entry;
  }

  function emptyState(message) {
    const element = document.createElement("p");
    element.className = "lab-empty";
    element.textContent = message;
    return element;
  }

  function renderDynamicContent() {
    const adapter = currentAdapter();
    elements.formatDescription.textContent = t(adapter.descriptionKey);
    elements.resultCaption.textContent = t(adapter.resultLabelKey);
    elements.structureTitle.textContent = t(adapter.structureTitleKey);
    elements.structureDescription.textContent = t(adapter.structureDescriptionKey);
    renderFormatGuide();
    if (state.result) {
      renderMetrics(state.result);
      renderStructure(state.result);
      if (state.format === "bpal") renderBpalGlobalPalettes(state.result.raw);
      renderInspector(comparison.selectedX, comparison.selectedY);
    }
  }

  function setBusy(busy, message) {
    state.busy = busy;
    elements.processButton.disabled = busy;
    elements.optimizeBpal.disabled = busy;
    elements.codecFormat.disabled = busy;
    elements.imageUrl.disabled = busy;
    elements.uploadButton.disabled = busy;
    elements.status.classList.toggle("is-busy", busy);
    elements.status.classList.remove("is-error");
    if (message) elements.status.textContent = message;
  }

  function setStatus(message) {
    elements.status.classList.remove("is-busy", "is-error");
    elements.status.textContent = message;
  }

  function showError(error) {
    ++state.requestId;
    finishWorker();
    closeProgress();
    state.busy = false;
    elements.processButton.disabled = false;
    elements.optimizeBpal.disabled = false;
    elements.codecFormat.disabled = false;
    elements.imageUrl.disabled = false;
    elements.uploadButton.disabled = false;
    elements.status.classList.remove("is-busy");
    elements.status.classList.add("is-error");
    elements.status.textContent = error && error.message ? error.message : String(error);
  }

  function downloadEncoded() {
    if (!state.result) return;
    const adapter = currentAdapter();
    downloadBlob(new Blob([state.result.encoded], { type: adapter.mime }), `${state.sourceName}.${adapter.extension}`);
  }

  function downloadPng() {
    if (!state.result) return;
    elements.resultCanvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `${state.sourceName}-${state.format}.png`);
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

  function clearPendingFile() {
    state.pendingFile = null;
    elements.imageFile.value = "";
    elements.imageUrl.querySelector("[data-pending-file]")?.remove();
  }

  function dispose() {
    cancelWorker();
    comparison.destroy();
  }

  function cancelledError() {
    const error = new Error("Codec operation cancelled");
    error.name = "AbortError";
    return error;
  }

  function isCancelled(error) {
    return error && error.name === "AbortError";
  }

  function rgbaAt(pixels, width, x, y) {
    const offset = (y * width + x) * 4;
    return { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2], a: pixels[offset + 3] };
  }

  function normalizeColor(color) {
    return { r: color.r, g: color.g, b: color.b, a: color.a ?? 255 };
  }

  function colorsEqual(left, right) {
    return left.r === right.r && left.g === right.g && left.b === right.b && left.a === right.a;
  }

  function colorText(color) {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
  }

  function colorHex(color) {
    return `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  }

  function colorCss(color) {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  function contrastingTextColor(color) {
    return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 >= 145 ? "#101318" : "#f7fbff";
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${formatInteger(bytes)} B`;
    if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, 2)} KiB`;
    return `${formatNumber(bytes / (1024 * 1024), 2)} MiB`;
  }

  function formatBits(bits) {
    return bits < 8
      ? `${bits} ${guideBitUnit()}`
      : `${formatBytes(Math.ceil(bits / 8))} · ${formatInteger(bits)} ${guideBitUnit()}`;
  }

  function formatNumber(value, digits) {
    return i18n.formatNumber(value, { maximumFractionDigits: digits });
  }

  function formatInteger(value) {
    return formatNumber(value, 0);
  }

  function formatCoefficient(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value);
    if (numeric === 0) return "0";
    return Number(numeric.toPrecision(4)).toString();
  }

  function formatPaletteIndex(index, bits) {
    return bits >= 8
      ? index.toString(16).padStart(Math.ceil(bits / 4), "0").toUpperCase()
      : String(index);
  }

  function optionText(select) {
    return select.selectedOptions[0]?.textContent || "image";
  }

  function fileStem(value) {
    const clean = String(value || "image").split(/[\\/]/).pop().split(/[?#]/)[0];
    return clean.replace(/\.[^.]+$/, "") || "image";
  }

  function largestPowerOfTwo(value) {
    let result = 1;
    while (result * 2 <= value) result *= 2;
    return result;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }
})(typeof self !== "undefined" ? self : globalThis);
