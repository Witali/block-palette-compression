"use strict";

const t = (key, parameters) => window.I18n.t(key, parameters);

const exampleSelect = document.querySelector("#example-image");
const uploadButton = document.querySelector("#upload-button");
const fileInput = document.querySelector("#file-input");
const viewport = document.querySelector("#image-viewport");
const stage = document.querySelector("#image-stage");
const canvas = document.querySelector("#image-canvas");
const emptyState = document.querySelector("#empty-state");
const statusElement = document.querySelector("#status");
const mipPreviousButton = document.querySelector("#mip-previous");
const mipNextButton = document.querySelector("#mip-next");
const mipLevel = document.querySelector("#mip-level");
const zoomLevel = document.querySelector("#zoom-level");
const zoomOutButton = document.querySelector("#zoom-out");
const zoomInButton = document.querySelector("#zoom-in");
const actualSizeButton = document.querySelector("#actual-size");
const fitImageButton = document.querySelector("#fit-image");
const panButtons = {
  left: document.querySelector("#pan-left"),
  up: document.querySelector("#pan-up"),
  down: document.querySelector("#pan-down"),
  right: document.querySelector("#pan-right"),
};

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
const ZOOM_FACTOR = 1.25;
const STAGE_MARGIN = 32;
const state = {
  width: 0,
  height: 0,
  zoom: 1,
  loaded: false,
  dragging: false,
  dragPointerId: null,
  dragX: 0,
  dragY: 0,
  dragScrollLeft: 0,
  dragScrollTop: 0,
  touches: new Map(),
  pinching: false,
  pinchStartDistance: 0,
  pinchStartZoom: 1,
  pinchImageX: 0,
  pinchImageY: 0,
  fileDescription: null,
  bplmImage: null,
  bplmName: "",
  mipIndex: 0,
  loading: false,
  viewMode: "fit",
  loadId: 0,
  stageOffsetX: STAGE_MARGIN,
  stageOffsetY: STAGE_MARGIN,
};
let fileLaunchReceived = false;

window.addEventListener("languagechange", () => {
  if (state.fileDescription) {
    renderFileStatus();
  }

  updateMipControls();
});

uploadButton.addEventListener("click", () => fileInput.click());
exampleSelect.addEventListener("change", () => {
  const option = exampleSelect.selectedOptions[0];

  if (option) {
    loadBundledBlockPalette(exampleSelect.value, option.textContent.trim());
  }
});
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;

  if (file) {
    loadFile(file);
  }
});

zoomOutButton.addEventListener("click", () => setZoom(state.zoom / ZOOM_FACTOR));
zoomInButton.addEventListener("click", () => setZoom(state.zoom * ZOOM_FACTOR));
actualSizeButton.addEventListener("click", showActualSize);
fitImageButton.addEventListener("click", fitImage);
mipPreviousButton.addEventListener("click", () => showBplmMip(state.mipIndex - 1));
mipNextButton.addEventListener("click", () => showBplmMip(state.mipIndex + 1));

panButtons.left.addEventListener("click", () => panBy(-getPanStep("x"), 0));
panButtons.right.addEventListener("click", () => panBy(getPanStep("x"), 0));
panButtons.up.addEventListener("click", () => panBy(0, -getPanStep("y")));
panButtons.down.addEventListener("click", () => panBy(0, getPanStep("y")));

viewport.addEventListener("wheel", (event) => {
  if (!state.loaded || (!event.ctrlKey && !event.metaKey)) {
    return;
  }

  event.preventDefault();
  const factor = event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;

  setZoom(state.zoom * factor, event.clientX, event.clientY);
}, { passive: false });

viewport.addEventListener("pointerdown", (event) => {
  if (!state.loaded) {
    return;
  }

  if (event.pointerType === "touch") {
    startTouch(event);
    return;
  }

  if (event.button === 0) {
    startDrag(event.pointerId, event.clientX, event.clientY);
    viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
});

viewport.addEventListener("pointermove", (event) => {
  if (state.touches.has(event.pointerId)) {
    moveTouch(event);
    return;
  }

  if (!state.dragging || event.pointerId !== state.dragPointerId) {
    return;
  }

  viewport.scrollLeft = state.dragScrollLeft - (event.clientX - state.dragX);
  viewport.scrollTop = state.dragScrollTop - (event.clientY - state.dragY);
});

viewport.addEventListener("pointerup", finishPointer);
viewport.addEventListener("pointercancel", finishPointer);

viewport.addEventListener("keydown", (event) => {
  if (!state.loaded) {
    return;
  }

  const directions = {
    ArrowLeft: [-getPanStep("x"), 0],
    ArrowRight: [getPanStep("x"), 0],
    ArrowUp: [0, -getPanStep("y")],
    ArrowDown: [0, getPanStep("y")],
  };
  const offset = directions[event.key];

  if (offset) {
    event.preventDefault();
    panBy(offset[0], offset[1]);
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  viewport.addEventListener(eventName, (event) => {
    event.preventDefault();
    viewport.classList.add("is-drag-over");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  viewport.addEventListener(eventName, (event) => {
    event.preventDefault();
    viewport.classList.remove("is-drag-over");
  });
}

viewport.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;

  if (file) {
    loadFile(file);
  }
});

window.addEventListener("resize", () => {
  if (!state.loaded) {
    return;
  }

  if (state.viewMode === "fit") {
    fitImage();
  } else if (state.viewMode === "actual") {
    showActualSize();
  } else {
    setZoom(state.zoom);
  }
});

registerFileLaunchHandler();
initializeBundledExamples();

function registerFileLaunchHandler() {
  if (!("launchQueue" in window)) {
    return;
  }

  window.launchQueue.setConsumer(async (launchParams) => {
    const [fileHandle] = launchParams.files || [];

    if (!fileHandle) {
      return;
    }

    fileLaunchReceived = true;
    const launchId = ++state.loadId;

    setLoading(true);

    try {
      const file = await fileHandle.getFile();

      if (launchId === state.loadId) {
        await loadFile(file);
      }
    } catch (error) {
      if (launchId === state.loadId) {
        console.error("Could not open the file passed by the operating system.", error);
        setStatus(error && error.message ? error.message : String(error), true);
      }
    } finally {
      if (launchId === state.loadId) {
        setLoading(false);
      }
    }
  });
}

async function initializeBundledExamples() {
  if (fileLaunchReceived) {
    return;
  }

  const initializationId = ++state.loadId;

  setLoading(true);

  try {
    const manifest = await window.BpalExampleCatalog.loadManifest();

    if (fileLaunchReceived || initializationId !== state.loadId) {
      return;
    }

    const example = window.BpalExampleCatalog.populateSelect(exampleSelect, manifest);

    await loadBundledBlockPalette(example.url, example.name);
  } catch (error) {
    if (initializationId === state.loadId) {
      console.error("Could not load the bundled BPAL manifest.", error);
      setStatus(error && error.message ? error.message : String(error), true);
    }
  } finally {
    if (initializationId === state.loadId) {
      setLoading(false);
    }
  }
}

async function loadBundledBlockPalette(url, fileName) {
  const loadId = ++state.loadId;

  setStatus(t("viewer.opening", { name: fileName }));
  setLoading(true);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(t("dynamic.imageLoadFailed", {
        status: response.status,
        statusText: response.statusText,
      }));
    }

    const bytes = await response.arrayBuffer();

    if (loadId === state.loadId) {
      loadBlockPalette(bytes, fileName);
    }
  } catch (error) {
    if (loadId === state.loadId) {
      console.error("Could not open the built-in BPAL image.", error);
      setStatus(error && error.message ? error.message : String(error), true);
    }
  } finally {
    if (loadId === state.loadId) {
      setLoading(false);
    }
  }
}

async function loadFile(file) {
  const loadId = ++state.loadId;

  setStatus(t("viewer.opening", { name: file.name }));
  setLoading(true);

  try {
    const bytes = await file.arrayBuffer();
    const lowerName = file.name.toLowerCase();
    const isBlockPalette = hasBpalMagic(bytes) ||
      window.BplmFormat.isBplmFile(bytes) ||
      lowerName.endsWith(".bpal") ||
      lowerName.endsWith(".bplm");

    if (loadId === state.loadId) {
      if (isBlockPalette) {
        loadBlockPalette(bytes, file.name);
      } else {
        await loadRegularImage(file);
      }
    }
  } catch (error) {
    if (loadId === state.loadId) {
      console.error("Could not open the selected image.", error);
      setStatus(error && error.message ? error.message : String(error), true);
    }
  } finally {
    if (loadId === state.loadId) {
      setLoading(false);
      fileInput.value = "";
    }
  }
}

function loadBlockPalette(bytes, fileName) {
  if (window.BplmFormat.isBplmFile(bytes) || fileName.toLowerCase().endsWith(".bplm")) {
    loadBplm(bytes, fileName);
  } else {
    loadBpal(bytes, fileName);
  }
}

function loadBpal(bytes, fileName) {
  const decoded = window.BlockPaletteFormat.decodeBlockPaletteFile(bytes);
  const pixels = new Uint8ClampedArray(decoded.pixels);

  clearMipState();
  drawPixels(pixels, decoded.width, decoded.height);
  state.fileDescription = {
    type: "bpal",
    name: fileName,
    width: decoded.width,
    height: decoded.height,
    version: decoded.version,
    palettes: decoded.paletteCount,
    colors: decoded.globalColorCount,
    localColors: decoded.localColorCount,
    bitsPerPixel: decoded.storage.totalBytes * 8 / (decoded.width * decoded.height),
    blockSize: decoded.blockSize,
  };
  renderFileStatus();
}

function loadBplm(bytes, fileName) {
  state.bplmImage = window.BplmFormat.decodeBplmFile(bytes);
  state.bplmName = fileName;
  state.mipIndex = 0;
  showBplmMip(0);
}

function showBplmMip(mipIndex) {
  const image = state.bplmImage;

  if (!image || mipIndex < 0 || mipIndex >= image.mipLevels.length) {
    return;
  }

  const level = image.mipLevels[mipIndex];
  const pixels = window.BplmFormat.reconstructBplmMipPixels(image, mipIndex);

  state.mipIndex = mipIndex;
  drawPixels(pixels, level.width, level.height);
  state.fileDescription = {
    type: "bplm",
    name: state.bplmName,
    width: level.width,
    height: level.height,
    version: image.containerVersion,
    palettes: image.paletteCount || 1,
    mip: mipIndex,
    maxMip: image.mipLevels.length - 1,
    colors: image.globalColorCount,
    localColors: level.localColorCount,
    bitsPerPixel: image.bplmStorage.totalBytes * 8 / (image.width * image.height),
    blockSize: level.blockSize,
  };
  updateMipControls();
  renderFileStatus();
}

async function loadRegularImage(file) {
  const image = await decodeBrowserImage(file);

  clearMipState();
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d").drawImage(image, 0, 0);

  if (typeof image.close === "function") {
    image.close();
  }

  finishLoading(file.name, canvas.width, canvas.height);
  state.fileDescription = {
    type: "image",
    name: file.name,
    width: canvas.width,
    height: canvas.height,
  };
  renderFileStatus();
}

function renderFileStatus() {
  const description = state.fileDescription;

  if (!description) {
    return;
  }

  const parameters = description.type === "bpal" || description.type === "bplm"
    ? {
        ...description,
        bitsPerPixel: window.I18n.formatNumber(description.bitsPerPixel, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      }
    : description;

  const statusKey = description.type === "bpal"
    ? "viewer.bpalStatus"
    : description.type === "bplm"
      ? "viewer.bplmStatus"
      : "viewer.imageStatus";

  setStatus(t(statusKey, parameters));
}

function clearMipState() {
  state.bplmImage = null;
  state.bplmName = "";
  state.mipIndex = 0;
  updateMipControls();
}

function updateMipControls() {
  const image = state.bplmImage;
  const maxMip = image ? image.mipLevels.length - 1 : 0;

  mipLevel.value = image
    ? t("viewer.mipValue", { level: state.mipIndex, max: maxMip })
    : "Mip —";
  mipPreviousButton.disabled = state.loading || !image || state.mipIndex <= 0;
  mipNextButton.disabled = state.loading || !image || state.mipIndex >= maxMip;
}

async function decodeBrowserImage(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file);
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = new Image();

    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function drawPixels(pixels, width, height) {
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
  finishLoading("BPAL", width, height);
}

function finishLoading(_name, width, height) {
  state.width = width;
  state.height = height;
  state.loaded = true;
  stage.hidden = false;
  emptyState.hidden = true;
  setControlsEnabled(true);

  requestAnimationFrame(() => {
    if (state.viewMode === "fit") {
      fitImage();
    } else if (state.viewMode === "actual") {
      showActualSize();
    } else {
      setZoom(state.zoom, undefined, undefined, true);
    }
  });
}

function fitImage() {
  if (!state.loaded) {
    return;
  }

  const availableWidth = Math.max(1, viewport.clientWidth - STAGE_MARGIN * 2);
  const availableHeight = Math.max(1, viewport.clientHeight - STAGE_MARGIN * 2);
  const fittedZoom = Math.min(availableWidth / state.width, availableHeight / state.height);

  setViewMode("fit");
  setZoom(fittedZoom, undefined, undefined, true);
}

function showActualSize() {
  if (!state.loaded) {
    return;
  }

  setViewMode("actual");
  setZoom(1, undefined, undefined, true);
}

function setViewMode(mode) {
  state.viewMode = mode;
  fitImageButton.setAttribute("aria-pressed", String(mode === "fit"));
  actualSizeButton.setAttribute("aria-pressed", String(mode === "actual"));
}

function setZoom(value, clientX, clientY, forceCenter, fixedImagePoint) {
  if (!state.loaded) {
    return;
  }

  const nextZoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
  const viewportRect = viewport.getBoundingClientRect();
  const anchorOffsetX = clientX === undefined ? viewport.clientWidth / 2 : clientX - viewportRect.left;
  const anchorOffsetY = clientY === undefined ? viewport.clientHeight / 2 : clientY - viewportRect.top;
  const imageX = fixedImagePoint
    ? fixedImagePoint.x
    : (viewport.scrollLeft + anchorOffsetX - state.stageOffsetX) / state.zoom;
  const imageY = fixedImagePoint
    ? fixedImagePoint.y
    : (viewport.scrollTop + anchorOffsetY - state.stageOffsetY) / state.zoom;
  const stageWidth = state.width * nextZoom;
  const stageHeight = state.height * nextZoom;

  state.zoom = nextZoom;
  state.stageOffsetX = Math.max(STAGE_MARGIN, (viewport.clientWidth - stageWidth) / 2);
  state.stageOffsetY = Math.max(STAGE_MARGIN, (viewport.clientHeight - stageHeight) / 2);
  stage.style.width = `${stageWidth}px`;
  stage.style.height = `${stageHeight}px`;
  stage.style.margin = `${state.stageOffsetY}px ${state.stageOffsetX}px`;
  stage.classList.toggle("is-magnified", nextZoom >= 2);
  zoomLevel.value = `${formatZoom(nextZoom)}%`;
  zoomOutButton.disabled = nextZoom <= MIN_ZOOM;
  zoomInButton.disabled = nextZoom >= MAX_ZOOM;

  if (!forceCenter) {
    setViewMode("custom");
  }

  const updateScrollPosition = () => {
    if (forceCenter) {
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
      return;
    }

    viewport.scrollLeft = imageX * nextZoom + state.stageOffsetX - anchorOffsetX;
    viewport.scrollTop = imageY * nextZoom + state.stageOffsetY - anchorOffsetY;
  };

  if (fixedImagePoint) {
    updateScrollPosition();
  } else {
    requestAnimationFrame(updateScrollPosition);
  }
}

function panBy(left, top) {
  viewport.scrollBy({ left, top, behavior: "smooth" });
}

function getPanStep(axis) {
  return (axis === "x" ? viewport.clientWidth : viewport.clientHeight) * 0.35;
}

function startTouch(event) {
  if (state.touches.size >= 2) {
    event.preventDefault();
    return;
  }

  state.touches.set(event.pointerId, {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  });
  viewport.setPointerCapture(event.pointerId);

  if (state.touches.size === 1) {
    startDrag(event.pointerId, event.clientX, event.clientY);
  } else {
    startPinch();
  }

  event.preventDefault();
}

function moveTouch(event) {
  const touch = state.touches.get(event.pointerId);

  touch.x = event.clientX;
  touch.y = event.clientY;

  if (state.pinching && state.touches.size === 2) {
    const [first, second] = state.touches.values();
    const distance = Math.max(1, getDistance(first, second));
    const center = getCenter(first, second);
    const nextZoom = state.pinchStartZoom * distance / state.pinchStartDistance;

    setZoom(nextZoom, center.x, center.y, false, {
      x: state.pinchImageX,
      y: state.pinchImageY,
    });
  } else if (state.dragging && event.pointerId === state.dragPointerId) {
    viewport.scrollLeft = state.dragScrollLeft - (event.clientX - state.dragX);
    viewport.scrollTop = state.dragScrollTop - (event.clientY - state.dragY);
  }

  event.preventDefault();
}

function startPinch() {
  const [first, second] = state.touches.values();
  const center = getCenter(first, second);
  const viewportRect = viewport.getBoundingClientRect();
  const anchorOffsetX = center.x - viewportRect.left;
  const anchorOffsetY = center.y - viewportRect.top;

  state.dragging = false;
  state.dragPointerId = null;
  state.pinching = true;
  state.pinchStartDistance = Math.max(1, getDistance(first, second));
  state.pinchStartZoom = state.zoom;
  state.pinchImageX = (viewport.scrollLeft + anchorOffsetX - STAGE_MARGIN) / state.zoom;
  state.pinchImageY = (viewport.scrollTop + anchorOffsetY - STAGE_MARGIN) / state.zoom;
  viewport.classList.add("is-dragging");
}

function startDrag(pointerId, clientX, clientY) {
  state.dragging = true;
  state.dragPointerId = pointerId;
  state.dragX = clientX;
  state.dragY = clientY;
  state.dragScrollLeft = viewport.scrollLeft;
  state.dragScrollTop = viewport.scrollTop;
  viewport.classList.add("is-dragging");
}

function finishPointer(event) {
  if (state.touches.has(event.pointerId)) {
    state.touches.delete(event.pointerId);

    if (state.pinching) {
      state.pinching = false;

      if (state.touches.size === 1) {
        const [remainingTouch] = state.touches.values();

        startDrag(remainingTouch.id, remainingTouch.x, remainingTouch.y);
      } else {
        stopDrag();
      }
    } else if (state.dragPointerId === event.pointerId) {
      stopDrag();
    }
  } else if (state.dragPointerId === event.pointerId) {
    stopDrag();
  }

  if (viewport.hasPointerCapture(event.pointerId)) {
    viewport.releasePointerCapture(event.pointerId);
  }
}

function stopDrag() {
  state.dragging = false;
  state.dragPointerId = null;
  viewport.classList.remove("is-dragging");
}

function getDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function getCenter(first, second) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function setControlsEnabled(enabled) {
  actualSizeButton.disabled = !enabled;
  fitImageButton.disabled = !enabled;

  for (const button of Object.values(panButtons)) {
    button.disabled = !enabled;
  }
}

function setLoading(loading) {
  state.loading = loading;
  exampleSelect.disabled = loading;
  uploadButton.disabled = loading;
  updateMipControls();
}

function setStatus(message, isError) {
  statusElement.textContent = message;
  statusElement.classList.toggle("is-error", Boolean(isError));
}

function hasBpalMagic(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4));

  return bytes.length === 4
    && bytes[0] === 0x42
    && bytes[1] === 0x50
    && bytes[2] === 0x41
    && bytes[3] === 0x4c;
}

function formatZoom(value) {
  const percent = value * 100;

  return percent < 10 ? percent.toFixed(1) : String(Math.round(percent));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
