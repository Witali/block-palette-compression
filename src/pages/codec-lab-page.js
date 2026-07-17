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
    uploadedUrl: null,
    busy: false,
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

  const formatAdapters = {
    bpal: createBpalAdapter(),
    dct: createDctAdapter(),
    bpdh: createBpdhAdapter(),
  };

  const comparison = new root.CodecComparisonView({
    sourceViewport: elements.sourceViewport,
    resultViewport: elements.resultViewport,
    sourceStage: elements.sourceStage,
    resultStage: elements.resultStage,
    sourceCanvas: elements.sourceCanvas,
    resultCanvas: elements.resultCanvas,
    overlayCanvas: elements.overlayCanvas,
    zoomOut: elements.zoomOut,
    zoomIn: elements.zoomIn,
    zoomLevel: elements.zoomLevel,
    actualSize: elements.actualSize,
    fitImage: elements.fitImage,
    smoothScaling: elements.smoothScaling,
  }, {
    onSelect: (x, y) => renderInspector(x, y),
  });

  bindEvents();
  selectInitialFormat();
  updateRangeLabels();
  updateFormatUi(false);
  loadUrl(elements.imageUrl.value, optionText(elements.imageUrl)).catch(showError);

  function collectElements() {
    return {
      controls: byId("lab-controls"),
      codecFormat: byId("codec-format"),
      formatDescription: byId("format-description"),
      imageUrl: byId("image-url"),
      imageFile: byId("image-file"),
      uploadButton: byId("upload-button"),
      processButton: byId("process-button"),
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
      sourceViewport: byId("source-viewport"),
      resultViewport: byId("result-viewport"),
      sourceStage: byId("source-stage"),
      resultStage: byId("result-stage"),
      sourceCanvas: byId("source-canvas"),
      resultCanvas: byId("result-canvas"),
      overlayCanvas: byId("overlay-canvas"),
      zoomOut: byId("zoom-out"),
      zoomIn: byId("zoom-in"),
      zoomLevel: byId("zoom-level"),
      actualSize: byId("actual-size"),
      fitImage: byId("fit-image"),
      smoothScaling: byId("smooth-scaling"),
      showOverlay: byId("show-overlay"),
      resultCaption: byId("result-caption"),
      structureTitle: byId("structure-title"),
      structureDescription: byId("structure-description"),
      structureSummary: byId("structure-summary"),
      structureFlow: byId("structure-flow"),
      selectedUnit: byId("selected-unit"),
      pixelCoordinate: byId("pixel-coordinate"),
      pixelSourceColor: byId("pixel-source-color"),
      pixelFullColor: byId("pixel-full-color"),
      pixelSampledColor: byId("pixel-sampled-color"),
      pixelMatch: byId("pixel-match"),
      pixelMatchCard: byId("pixel-match").parentElement,
      pixelSwatch: byId("pixel-swatch"),
      blockDetails: byId("block-details"),
      blockDetailsSummary: byId("block-details-summary"),
      blockDetailsBody: byId("block-details-body"),
      progressDialog: byId("progress-dialog"),
      progressEyebrow: byId("progress-eyebrow"),
      progressBar: byId("progress-bar"),
      progressPercent: byId("progress-percent"),
      progressStage: byId("progress-stage"),
      progressDetail: byId("progress-detail"),
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
    };
  }

  function bindEvents() {
    elements.controls.addEventListener("submit", (event) => {
      event.preventDefault();
      processCurrentFormat();
    });
    elements.codecFormat.addEventListener("change", () => {
      state.format = elements.codecFormat.value;
      updateFormatUi(true);
    });
    elements.imageUrl.addEventListener("change", () => {
      releaseUpload();
      loadUrl(elements.imageUrl.value, optionText(elements.imageUrl)).catch(showError);
    });
    elements.uploadButton.addEventListener("click", () => elements.imageFile.click());
    elements.imageFile.addEventListener("change", handleUpload);
    elements.downloadFile.addEventListener("click", downloadEncoded);
    elements.downloadPng.addEventListener("click", downloadPng);
    elements.progressCancel.addEventListener("click", cancelProcessing);
    elements.progressDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelProcessing();
    });
    elements.showOverlay.addEventListener("change", () => comparison.drawOverlay());
    elements.bpalQualityPreset.addEventListener("change", applyBpalPreset);
    elements.bpalBlockSize.addEventListener("change", updateBpalLocalColorOptions);
    elements.bpalDiversity.addEventListener("input", updateRangeLabels);
    elements.dctQuality.addEventListener("input", updateRangeLabels);
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

  function updateFormatUi(process) {
    cancelWorker();
    state.result = null;
    elements.downloadFile.disabled = true;
    elements.downloadPng.disabled = true;
    comparison.clearResult();
    comparison.setOverlayRenderer((context, view) => currentAdapter().drawOverlay(context, view));

    for (const panel of document.querySelectorAll("[data-format-panel]")) {
      panel.hidden = panel.dataset.formatPanel !== state.format;
    }

    const adapter = currentAdapter();
    elements.formatDescription.textContent = t(adapter.descriptionKey);
    elements.resultCaption.textContent = t(adapter.resultLabelKey);
    elements.structureTitle.textContent = t(adapter.structureTitleKey);
    elements.structureDescription.textContent = t(adapter.structureDescriptionKey);
    elements.progressEyebrow.textContent = adapter.label;
    elements.structureSummary.textContent = "—";
    elements.structureFlow.replaceChildren(emptyState(t("lab.encodeToInspect")));
    clearInspector();
    syncDctControls();

    const url = new URL(root.location.href);
    url.searchParams.set("format", state.format);
    root.history.replaceState(null, "", url);

    if (process && state.sourceImageData) processCurrentFormat();
  }

  function currentAdapter() {
    return formatAdapters[state.format];
  }

  async function loadUrl(url, name) {
    setBusy(true, t("dynamic.loadingImage"));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    await loadBlob(await response.blob(), name || fileStem(url));
  }

  async function loadBlob(blob, name) {
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
    state.result = null;
    comparison.setSource(imageData);
    elements.metricDimensions.textContent = `${formatInteger(imageData.width)} × ${formatInteger(imageData.height)}`;
    resetMetrics(false);
    syncDctControls();
    setBusy(false, t("common.ready"));
    await processCurrentFormat();
  }

  async function handleUpload() {
    const file = elements.imageFile.files && elements.imageFile.files[0];
    if (!file) return;

    releaseUpload();
    state.uploadedUrl = URL.createObjectURL(file);
    try {
      await loadBlob(file, file.name);
    } catch (error) {
      showError(error);
    }
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
    clearInspector();
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
      extension: "bpal",
      mime: "application/vnd.block-palette",
      encode() {
        const source = state.sourceImageData;
        const settings = readBpalSettings();
        const pixels = new Uint8ClampedArray(source.data);
        const workerUrl = settings.algorithm === "webgl"
          ? "./src/palette/block-palette-webgl-worker.js?v=direct-block-colors-1"
          : "./src/palette/block-palette-worker.js?v=direct-block-colors-1";

        return runWorker(workerUrl, {
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

        return runWorker("./src/dct/dct-worker.js?v=dct-page-19", message, transfers, (data) => {
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
      extension: "bpdh",
      mime: "application/octet-stream",
      encode() {
        const source = state.sourceImageData;
        const pixels = new Uint8ClampedArray(source.data);
        const startedAt = performance.now();
        return runWorker("./src/hybrid/bpdh-worker.js?v=hybrid-2", {
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
    if (importing) elements.dctAutoQuality.checked = false;
  }

  function updateRangeLabels() {
    elements.bpalDiversityValue.value = Number(elements.bpalDiversity.value).toFixed(1);
    elements.dctQualityValue.value = elements.dctQuality.value;
  }

  function markSettingsChanged() {
    updateRangeLabels();
    if (state.result && !state.busy) setStatus(t("lab.settingsChanged"));
  }

  function runWorker(url, message, transfers, onMessage) {
    cancelWorker();
    const worker = new Worker(url);
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
    elements.progressStage.textContent = String(progress.stage || t("block.progressStagePreparing"));
    const completed = progress.phaseCompleted ?? progress.completed;
    const total = progress.phaseTotal ?? progress.total;
    elements.progressDetail.textContent = Number.isFinite(completed) && Number.isFinite(total)
      ? `${formatInteger(completed)} / ${formatInteger(total)}`
      : Number.isFinite(progress.quality) ? `Quality ${progress.quality}` : t("block.progressWaiting");
  }

  function showProgress(label) {
    elements.progressEyebrow.textContent = label;
    elements.progressBar.value = 0;
    elements.progressPercent.value = "0%";
    elements.progressStage.textContent = t("block.progressStagePreparing");
    elements.progressDetail.textContent = t("block.progressWaiting");
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
  }

  function resetMetrics(preserveDimensions) {
    if (!preserveDimensions && state.sourceImageData) {
      elements.metricDimensions.textContent = `${state.sourceImageData.width} × ${state.sourceImageData.height}`;
    }
    for (const element of [elements.metricSize, elements.metricBpp, elements.metricRatio, elements.metricRmse, elements.metricPsnr, elements.metricTime]) {
      element.textContent = "—";
    }
  }

  function renderStructure(result) {
    const adapter = currentAdapter();
    elements.structureSummary.textContent = `${adapter.label} · ${formatBytes(result.encoded.byteLength)}`;
    elements.structureFlow.replaceChildren(...adapter.renderStructure(result));
  }

  function renderInspector(x, y) {
    if (!state.result || !state.sourceImageData) return;

    const result = state.result;
    const adapter = currentAdapter();
    const px = clamp(Math.trunc(x), 0, result.imageData.width - 1);
    const py = clamp(Math.trunc(y), 0, result.imageData.height - 1);
    comparison.setSelectedPixel(px, py);
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
    elements.blockDetailsSummary.textContent = detail.summary;
    elements.blockDetailsBody.replaceChildren(detail.body);
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
    elements.blockDetailsSummary.textContent = "—";
    elements.blockDetailsBody.replaceChildren(emptyState(t("lab.selectPixel")));
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

  function matrixSection(matrices) {
    const section = detailSection("Quantized DCT coefficients");
    const list = document.createElement("div");
    list.className = "lab-matrix-list";
    for (const matrix of matrices) {
      const figure = document.createElement("figure");
      figure.className = "lab-coefficient-matrix";
      const caption = document.createElement("figcaption");
      caption.textContent = matrix.name;
      const grid = document.createElement("div");
      grid.className = "lab-coefficient-grid";
      grid.style.setProperty("--columns", String(matrix.width));
      for (let index = 0; index < (matrix.coefficients || []).length; index += 1) {
        const value = matrix.coefficients[index];
        const cell = document.createElement("span");
        cell.textContent = String(value);
        cell.title = `u=${index % matrix.width}, v=${Math.floor(index / matrix.width)}`;
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
    const blocksX = Math.ceil(view.width / blockSize);
    const blocksY = Math.ceil(view.height / blockSize);
    const lineWidth = Math.max(1, Math.min(view.width, view.height) / 420);

    if (elements.showOverlay.checked) {
      for (let blockY = 0; blockY < blocksY; blockY += 1) {
        for (let blockX = 0; blockX < blocksX; blockX += 1) {
          const blockIndex = blockY * blocksX + blockX;
          const x = blockX * blockSize;
          const y = blockY * blockSize;
          const width = Math.min(blockSize, view.width - x);
          const height = Math.min(blockSize, view.height - y);
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

    const selectedBlockX = Math.floor(view.selectedX / blockSize);
    const selectedBlockY = Math.floor(view.selectedY / blockSize);
    const x = selectedBlockX * blockSize;
    const y = selectedBlockY * blockSize;
    const width = Math.min(blockSize, view.width - x);
    const height = Math.min(blockSize, view.height - y);
    context.fillStyle = "rgba(255, 240, 106, 0.12)";
    context.fillRect(x, y, width, height);
    context.strokeStyle = "#fff06a";
    context.lineWidth = lineWidth * 2.5;
    context.strokeRect(x + context.lineWidth / 2, y + context.lineWidth / 2, Math.max(0, width - context.lineWidth), Math.max(0, height - context.lineWidth));
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
    if (state.result) {
      renderMetrics(state.result);
      renderStructure(state.result);
      renderInspector(comparison.selectedX, comparison.selectedY);
    }
  }

  function setBusy(busy, message) {
    state.busy = busy;
    elements.processButton.disabled = busy;
    elements.codecFormat.disabled = busy;
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
    elements.codecFormat.disabled = false;
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

  function releaseUpload() {
    if (state.uploadedUrl) URL.revokeObjectURL(state.uploadedUrl);
    state.uploadedUrl = null;
  }

  function dispose() {
    cancelWorker();
    releaseUpload();
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
    return bits < 8 ? `${bits} bit` : `${formatBytes(Math.ceil(bits / 8))} · ${formatInteger(bits)} bit`;
  }

  function formatNumber(value, digits) {
    return i18n.formatNumber(value, { maximumFractionDigits: digits });
  }

  function formatInteger(value) {
    return formatNumber(value, 0);
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
