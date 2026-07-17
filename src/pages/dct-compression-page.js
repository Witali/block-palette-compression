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
const layoutComponentControls = document.getElementById("dct-layout-component-controls");
const layoutRecordSummary = document.getElementById("dct-layout-record-summary");
const layoutRecords = document.getElementById("dct-layout-records");
const layoutMatrixSummary = document.getElementById("dct-layout-matrix-summary");
const layoutMatrixPlane = document.getElementById("dct-layout-matrix-plane");
const layoutCoefficients = document.getElementById("dct-layout-coefficients");
const layoutZigzag = document.getElementById("dct-layout-zigzag");
const layoutCoefficientLegend = document.getElementById("dct-layout-coefficient-legend");
const layoutCodingGuide = document.getElementById("dct-layout-coding-guide");

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
  layoutComponent: "y",
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
layoutComponentControls.addEventListener("click", (event) => {
  const button = event.target.closest("[data-dct-layout-component]");
  if (!button || !layoutComponentControls.contains(button)) return;
  state.layoutComponent = button.dataset.dctLayoutComponent;
  renderDctLayoutDiagram();
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
      preset.bpp >= 7.5
        ? `${key} bpp · ${preset.yBytes / 4} B/DCT · ${preset.bytesPerMcu} B/MCU`
        : `${key} bpp · ${preset.bytesPerMcu} B/MCU`,
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
    createDctLayoutBlock("cb", "Cb 8×8"),
    createDctLayoutBlock("cr", "Cr 8×8")
  );
  layoutSpatial.setAttribute(
    "aria-label",
    t(splitLuma ? "dct.layoutSpatialHighAria" : "dct.layoutSpatialLowAria")
  );

  renderDctLayoutComponentControls();
  const recordShape = getDctLayoutRecordShape(selected, state.layoutComponent);
  renderDctLayoutRecords(selectedKey, selected, recordShape);
  renderDctLayoutCoefficientMatrix(selectedKey, recordShape);
  renderDctLayoutCodingGuide(selectedKey);
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

function renderDctLayoutComponentControls() {
  for (const button of layoutComponentControls.querySelectorAll("[data-dct-layout-component]")) {
    const selected = button.dataset.dctLayoutComponent === state.layoutComponent;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function getDctLayoutRecordShape(preset, component) {
  if (component === "y") {
    const split = preset.bpp >= 3;
    return {
      component,
      width: split ? 8 : 16,
      height: split ? 8 : 16,
      bytes: split ? preset.yBytes / 4 : preset.yBytes,
    };
  }
  return { component, width: 8, height: 8, bytes: preset.cbBytes };
}

function getDctLayoutCodingProfile(presetKey) {
  if (presetKey === "0.75") return { groups: 2, grouping: "equal", skip: "single" };
  if (presetKey === "1" || presetKey === "2") {
    return { groups: 2, grouping: "equal", skip: "dual" };
  }
  return {
    groups: 3,
    grouping: "front",
    skip: Number(presetKey) <= 4.5 ? "dual" : null,
  };
}

function renderDctLayoutRecords(presetKey, preset, shape) {
  const variants = getDctLayoutRecordVariants(presetKey, preset, shape);
  const component = dctLayoutComponentName(shape.component);

  layoutRecordSummary.textContent = t("dct.layoutRecordSummary", {
    component,
    width: shape.width,
    height: shape.height,
    bytes: shape.bytes,
  });

  layoutRecords.replaceChildren(...variants.map((variant) => {
    const record = document.createElement("section");
    const heading = document.createElement("div");
    const name = document.createElement("strong");
    const details = document.createElement("span");
    const strip = document.createElement("div");
    const legend = document.createElement("div");
    const note = document.createElement("p");
    const totalBits = shape.bytes * 8;

    record.className = "dct-layout-record";
    heading.className = "dct-layout-record-heading";
    name.textContent = variant.name;
    details.textContent = `${totalBits} bit · ${variant.order}`;
    heading.append(name, details);

    strip.className = "dct-layout-bit-strip";
    strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", t("dct.layoutRecordAria", {
      name: variant.name,
      bits: totalBits,
    }));
    legend.className = "dct-layout-bit-legend";

    for (const field of variant.fields) {
      const segment = document.createElement("span");
      const key = document.createElement("span");
      const swatch = document.createElement("i");
      const range = field.start === field.end
        ? String(field.start) : `${field.start}–${field.end}`;

      segment.className = `dct-layout-bit-field is-${field.type}`;
      segment.style.flexGrow = String(field.bits);
      segment.style.flexBasis = "0";
      segment.textContent = field.bits / totalBits >= 0.05 ? field.short : "";
      segment.title = `${field.label}: ${field.bits} bit [${range}]`;
      segment.setAttribute("aria-hidden", "true");
      strip.append(segment);

      key.className = "dct-layout-bit-key";
      swatch.className = `dct-layout-bit-swatch is-${field.type}`;
      swatch.setAttribute("aria-hidden", "true");
      key.append(swatch, `${field.label} · ${field.bits} b [${range}]`);
      legend.append(key);
    }

    note.className = "dct-layout-record-note";
    note.textContent = variant.note;
    record.append(heading, strip, legend, note);
    return record;
  }));
}

function getDctLayoutRecordVariants(presetKey, preset, shape) {
  const profile = getDctLayoutCodingProfile(presetKey);
  const grouped = createDctLayoutGroupedVariant(shape, profile);

  if (Number(presetKey) <= 4.5) {
    const allowSkip = shape.component === "y" || preset.bpp >= 3;
    return allowSkip
      ? [grouped, createDctLayoutSkipVariant(shape, profile.skip)]
      : [grouped];
  }

  if (shape.component !== "y") return [grouped];
  const variants = [grouped, createDctLayoutMaskedVariant(shape)];
  if (presetKey === "9") variants.push(createDctLayoutImplicit2Variant());
  return variants;
}

function createDctLayoutGroupedVariant(shape, profile) {
  const totalBits = shape.bytes * 8;
  const maximumAc = shape.width * shape.height - 1;
  const acCount = Math.min(
    maximumAc,
    Math.max(0, Math.floor((totalBits - 18 - profile.groups * 3) / 5))
  );
  const usedBits = 18 + profile.groups * 3 + acCount * 5;
  return {
    name: t("dct.layoutGroupedVariant", { groups: profile.groups }),
    order: t("dct.layoutMsbFirst"),
    note: t("dct.layoutGroupedNote", { count: acCount }),
    fields: addDctLayoutBitRanges([
      dctLayoutBitField("P", t("dct.layoutFieldProfile"), 4, "profile"),
      dctLayoutBitField("0", t("dct.layoutFieldSkipZero"), 1, "flag"),
      dctLayoutBitField("Sdc", t("dct.layoutFieldDcScale"), 3, "scale"),
      dctLayoutBitField("DC", t("dct.layoutFieldSignedDc", { bits: 10 }), 10, "dc"),
      dctLayoutBitField("Sg", t("dct.layoutFieldGroupScales", { count: profile.groups }), profile.groups * 3, "group"),
      dctLayoutBitField(`AC×${acCount}`, t("dct.layoutFieldSignedAc", { count: acCount, bits: 5 }), acCount * 5, "ac"),
      dctLayoutBitField("∅", t("dct.layoutFieldPadding"), totalBits - usedBits, "pad"),
    ]),
  };
}

function createDctLayoutSkipVariant(shape, skipMode) {
  const totalBits = shape.bytes * 8;
  const tokenLayout = getDctLayoutSkipTokenLayout(shape, skipMode);
  const fields = [
    dctLayoutBitField("P", t("dct.layoutFieldSkipProfile"), 4, "profile"),
    dctLayoutBitField("1", t("dct.layoutFieldSkipOne"), 1, "flag"),
    dctLayoutBitField("S", t("dct.layoutFieldMainScale"), 3, "scale"),
    dctLayoutBitField("DC", t("dct.layoutFieldSignedDc", { bits: 10 }), 10, "dc"),
  ];

  if (skipMode === "single") {
    fields.push(dctLayoutBitField(
      `T6×${tokenLayout.tokenCount}`,
      t("dct.layoutFieldSkipTokens", { count: tokenLayout.tokenCount }),
      tokenLayout.tokenCount * 8,
      "group"
    ));
  } else {
    fields.push(
      dctLayoutBitField(
        `C×${tokenLayout.coarseCount}`,
        t("dct.layoutFieldCoarseTokens", { count: tokenLayout.coarseCount }),
        tokenLayout.coarseCount * 8,
        "group"
      ),
      dctLayoutBitField(
        `F×${tokenLayout.fineCount}`,
        t("dct.layoutFieldFineTokens", { count: tokenLayout.fineCount }),
        tokenLayout.fineCount * 6,
        "ac"
      )
    );
  }
  fields.push(dctLayoutBitField("∅", t("dct.layoutFieldPadding"), totalBits - tokenLayout.usedBits, "pad"));

  return {
    name: t(skipMode === "single" ? "dct.layoutSkipRleVariant" : "dct.layoutDualScaleVariant"),
    order: t("dct.layoutMsbFirst"),
    note: skipMode === "single"
      ? t("dct.layoutSkipRleNote", { count: tokenLayout.tokenCount })
      : t("dct.layoutDualScaleNote", {
        coarse: tokenLayout.coarseCount,
        fine: tokenLayout.fineCount,
      }),
    fields: addDctLayoutBitRanges(fields),
  };
}

function getDctLayoutSkipTokenLayout(shape, skipMode) {
  const payloadBits = shape.bytes * 8 - 18;
  if (skipMode === "single") {
    const tokenCount = Math.floor(payloadBits / 8);
    return { tokenCount, coarseCount: tokenCount, fineCount: 0, usedBits: 18 + tokenCount * 8 };
  }

  let tokenCount;
  let coarseCount;
  if (shape.bytes === 32) {
    tokenCount = 32;
    coarseCount = 16;
  } else if (shape.bytes === 24) {
    tokenCount = 24;
    coarseCount = shape.width === 16 && shape.height === 16 ? 12 : 11;
  } else if (shape.bytes === 16) {
    tokenCount = shape.width === 16 && shape.height === 16 ? 15 : 14;
    coarseCount = shape.width === 16 && shape.height === 16 ? 7 : 8;
  } else {
    tokenCount = Math.floor(payloadBits / 7);
    coarseCount = Math.ceil(tokenCount / 2);
    while (coarseCount * 8 + (tokenCount - coarseCount) * 6 > payloadBits) {
      tokenCount -= 1;
      coarseCount = Math.ceil(tokenCount / 2);
    }
  }
  const fineCount = tokenCount - coarseCount;
  return {
    tokenCount,
    coarseCount,
    fineCount,
    usedBits: 18 + coarseCount * 8 + fineCount * 6,
  };
}

function createDctLayoutMaskedVariant(shape) {
  const configs = {
    16: { dcBits: 10, acBits: 6, acCount: 9 },
    24: { dcBits: 9, acBits: 7, acCount: 17 },
    32: { dcBits: 8, acBits: 8, acCount: 23 },
    40: { dcBits: 8, acBits: 8, acCount: 31 },
    48: { dcBits: 10, acBits: 8, acCount: 38 },
  };
  const config = configs[shape.bytes];
  const totalBits = shape.bytes * 8;
  const usedBits = 64 + config.dcBits + config.acBits * config.acCount;
  return {
    name: t("dct.layoutMaskedVariant"),
    order: t("dct.layoutLsbFirst"),
    note: t("dct.layoutMaskedNote", { count: config.acCount }),
    fields: addDctLayoutBitRanges([
      dctLayoutBitField("M62", t("dct.layoutFieldMask62"), 62, "mask"),
      dctLayoutBitField("S", t("dct.layoutFieldSharedScale"), 2, "scale"),
      dctLayoutBitField("DC", t("dct.layoutFieldSignedDc", { bits: config.dcBits }), config.dcBits, "dc"),
      dctLayoutBitField(`AC×${config.acCount}`, t("dct.layoutFieldSignedAc", {
        count: config.acCount,
        bits: config.acBits,
      }), config.acCount * config.acBits, "ac"),
      dctLayoutBitField("∅", t("dct.layoutFieldPadding"), totalBits - usedBits, "pad"),
    ]),
  };
}

function createDctLayoutImplicit2Variant() {
  return {
    name: t("dct.layoutImplicit2Variant"),
    order: t("dct.layoutLsbFirst"),
    note: t("dct.layoutImplicit2Note"),
    fields: addDctLayoutBitRanges([
      dctLayoutBitField("M60", t("dct.layoutFieldMask60"), 60, "mask"),
      dctLayoutBitField("S", t("dct.layoutFieldSharedScale"), 2, "scale"),
      dctLayoutBitField("DC", t("dct.layoutFieldSignedDc", { bits: 10 }), 10, "dc"),
      dctLayoutBitField("A1", t("dct.layoutFieldImplicitDct1"), 8, "ac"),
      dctLayoutBitField("A8", t("dct.layoutFieldImplicitDct8"), 8, "ac"),
      dctLayoutBitField("AC×37", t("dct.layoutFieldRemainingAc"), 296, "ac"),
    ]),
  };
}

function dctLayoutBitField(short, label, bits, type) {
  return { short, label, bits, type };
}

function addDctLayoutBitRanges(fields) {
  let cursor = 0;
  return fields.filter((field) => field.bits > 0).map((field) => {
    const ranged = { ...field, start: cursor, end: cursor + field.bits - 1 };
    cursor += field.bits;
    return ranged;
  });
}

function renderDctLayoutCoefficientMatrix(presetKey, shape) {
  const masked = shape.width === 8 && shape.height === 8 && Number(presetKey) >= 6;
  const implicit2 = masked && presetKey === "9";
  const showZigzag = true;
  const capacity = presetKey === "6" ? 23 : presetKey === "7.5" ? 31 : implicit2 ? 37 : 38;
  const tailStart = 64 - capacity;
  const zigzag = getDctLayoutZigzagPositions(shape.width, shape.height);
  const zigzagRank = new Map(
    zigzag.map(({ u, v }, rank) => [v * shape.width + u, rank])
  );
  const component = dctLayoutComponentName(shape.component);
  const packing = t(implicit2
    ? "dct.layoutMatrixImplicit2" : masked
      ? "dct.layoutMatrixMasked" : showZigzag
        ? "dct.layoutMatrixProfiledZigzag" : "dct.layoutMatrixProfiled");
  const cells = [];

  layoutMatrixSummary.textContent = t("dct.layoutMatrixSummary", {
    component,
    width: shape.width,
    height: shape.height,
    packing,
  });
  layoutMatrixPlane.style.aspectRatio = `${shape.width} / ${shape.height}`;
  layoutMatrixPlane.style.width = "min(100%, 340px)";
  layoutCoefficients.style.gridTemplateColumns = `repeat(${shape.width}, minmax(0, 1fr))`;
  const matrixAria = t("dct.layoutMatrixAria", {
    component,
    width: shape.width,
    height: shape.height,
  });
  layoutCoefficients.setAttribute(
    "aria-label",
    showZigzag
      ? `${matrixAria}. ${t("dct.layoutZigzagAria", { end: shape.width * shape.height - 1 })}`
      : matrixAria
  );

  for (let v = 0; v < shape.height; v += 1) {
    for (let u = 0; u < shape.width; u += 1) {
      const position = v * shape.width + u;
      const rank = zigzagRank.get(position);
      const cell = document.createElement("span");
      const normalized = Math.sqrt(
        (u / Math.max(1, shape.width - 1)) ** 2 +
        (v / Math.max(1, shape.height - 1)) ** 2
      ) / Math.sqrt(2);

      cell.className = "dct-layout-coefficient";
      cell.style.setProperty("--dct-frequency-alpha", String(Math.max(0.06, 0.34 * (1 - normalized))));
      cell.setAttribute("aria-hidden", "true");
      cell.title = t("dct.layoutCellAc", { position, rank, u, v });

      if (position === 0) {
        cell.classList.add("is-dc");
        cell.textContent = "DC";
        cell.title = t("dct.layoutCellDc", { position, rank, u, v });
      } else if (implicit2 && (position === 1 || position === 8)) {
        cell.classList.add("is-implicit");
        cell.textContent = "I";
        cell.title = t("dct.layoutCellImplicit", { position, rank, u, v });
      } else if (masked && rank === 63) {
        cell.classList.add("is-tail");
        cell.textContent = "T";
        cell.title = t("dct.layoutCellTail", { position, rank, u, v });
      } else if (masked && rank >= tailStart) {
        cell.classList.add("is-mask-tail");
        cell.textContent = "M/T";
        cell.title = t("dct.layoutCellMaskTail", { position, rank, u, v });
      } else if (masked && position <= 62) {
        cell.classList.add("is-mask");
        cell.textContent = "M";
        cell.title = t("dct.layoutCellMask", { position, rank, u, v });
      }
      cells.push(cell);
    }
  }
  layoutCoefficients.replaceChildren(...cells);
  renderDctLayoutZigzag(shape, showZigzag);

  const legend = [
    ["dc", "dct.layoutLegendDc"],
    ["frequency", "dct.layoutLegendFrequency"],
  ];
  if (implicit2) legend.push(["implicit", "dct.layoutLegendImplicit"]);
  if (masked) {
    legend.push(["mask", "dct.layoutLegendMask"]);
    legend.push(["mask-tail", "dct.layoutLegendMaskTail"]);
    legend.push(["tail", "dct.layoutLegendTail"]);
  }
  if (showZigzag) legend.push(["zigzag", "dct.layoutLegendZigzag"]);
  layoutCoefficientLegend.replaceChildren(...legend.map(([type, key]) => {
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    item.className = "dct-layout-coefficient-key";
    swatch.className = `dct-layout-coefficient-swatch is-${type}`;
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, t(key));
    return item;
  }));
}

function renderDctLayoutZigzag(shape, visible) {
  layoutZigzag.classList.toggle("is-visible", visible);
  layoutZigzag.replaceChildren();
  if (!visible) return;

  const positions = getDctLayoutZigzagPositions(shape.width, shape.height);
  const points = positions.map(({ u, v }) => `${u + 0.5},${v + 0.5}`).join(" ");
  const rankLabels = positions.map(({ u, v }, rank) => (
    `<text class="dct-layout-zigzag-rank" x="${u + 0.07}" y="${v + 0.17}">${rank}</text>`
  )).join("");

  layoutZigzag.setAttribute("viewBox", `0 0 ${shape.width} ${shape.height}`);
  layoutZigzag.setAttribute("preserveAspectRatio", "none");
  layoutZigzag.innerHTML = `
    <polyline class="dct-layout-zigzag-halo" points="${points}"></polyline>
    <polyline class="dct-layout-zigzag-line" points="${points}"></polyline>
    ${rankLabels}`;
}

function getDctLayoutZigzagPositions(width, height) {
  const positions = [];
  for (let diagonal = 0; diagonal <= width + height - 2; diagonal += 1) {
    const minimumU = Math.max(0, diagonal - height + 1);
    const maximumU = Math.min(width - 1, diagonal);
    if ((diagonal & 1) === 0) {
      for (let u = minimumU; u <= maximumU; u += 1) {
        positions.push({ u, v: diagonal - u });
      }
    } else {
      for (let u = maximumU; u >= minimumU; u -= 1) {
        positions.push({ u, v: diagonal - u });
      }
    }
  }
  return positions;
}

function renderDctLayoutCodingGuide(presetKey) {
  const activeIds = presetKey === "0.75" ? [3]
    : presetKey === "1" || presetKey === "2" ? [4]
      : presetKey === "1.5" || presetKey === "3" || presetKey === "4.5" ? [5]
        : presetKey === "9" ? [2, 6, 7] : [2, 6];
  const rows = [];

  for (let id = 0; id <= 7; id += 1) {
    const row = document.createElement("div");
    const code = document.createElement("span");
    const name = document.createElement("strong");
    const description = document.createElement("span");
    const active = activeIds.includes(id);

    row.className = `dct-layout-coding-item${active ? " is-active" : ""}`;
    row.setAttribute("role", "listitem");
    if (active) row.setAttribute("aria-current", "true");
    code.className = "dct-layout-coding-id";
    code.textContent = `ID ${id}`;
    name.textContent = t(`dct.layoutCoding${id}Name`);
    description.textContent = t(`dct.layoutCoding${id}Description`);
    row.append(code, name, description);
    rows.push(row);
  }
  layoutCodingGuide.replaceChildren(...rows);
}

function dctLayoutComponentName(component) {
  return component === "y" ? "Y" : component === "cb" ? "Cb" : "Cr";
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
  const worker = new Worker("./src/dct/dct-worker.js?v=dct-page-19");
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
      sampleMcuCount: 32,
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
  const searching = progress.stage === "sample" || progress.stage === "refine";
  progressBar.value = percent;
  progressPercent.value = `${percent}%`;
  progressStage.textContent = progress.stage === "full"
    ? t("dct.progressFinalists")
    : t(searching ? "dct.progressSearching" : "dct.progressEncoding");
  progressDetail.textContent = t("dct.progressQuality", {
    quality: progress.quality,
    completed: progress.phaseCompleted ?? progress.completed,
    total: progress.phaseTotal ?? total,
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
