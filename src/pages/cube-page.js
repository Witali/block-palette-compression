/*
 * Purpose: WebGL demo entry point that renders the rotating textured cube.
 * Processing blocks:
 * - Create the shared textured cube renderer.
 * - Load BPAL/BPLM textures and optionally create one GPU texture resource per cube.
 * - Run the animation loop, pointer controls, and FPS counter.
 */
"use strict";

const localized = (english, russian) => window.I18n.getLanguage() === "ru" ? russian : english;

const canvas = document.getElementById("gl-canvas");
const fpsCounter = document.getElementById("fps-counter");
const materialControls = document.getElementById("material-controls");
const heightStrengthInput = document.getElementById("height-strength");
const heightStrengthValue = document.getElementById("height-strength-value");
const webgl2CompactInput = document.getElementById("webgl2-compact");
const cubeCountInput = document.getElementById("cube-count");
const textureFormatSelect = document.getElementById("texture-format");
const bpalExampleSelect = document.getElementById("bpal-example");
const bpalFileInput = document.getElementById("bpal-file");
const perCubeTexturesInput = document.getElementById("per-cube-textures");
const bpalStatus = document.getElementById("bpal-status");
const requestedCompactRenderer = new URLSearchParams(window.location.search).get("renderer") !== "webgl1";
const DCT_DEMO_URL = "assets/dct/stone-texture-wic-1.5bpp.dctbs2";
const DCT_DEMO_NAME = "stone-texture-wic-1.5bpp.dctbs2";
let compactRendererEnabled = requestedCompactRenderer;
let gl = canvas.getContext(compactRendererEnabled ? "webgl2" : "webgl", { antialias: true });

if (!gl && compactRendererEnabled) {
  compactRendererEnabled = false;
  gl = canvas.getContext("webgl", { antialias: true });
}
const fpsState = {
  frameCount: 0,
  lastUpdateTime: 0,
};
const cubeMotionState = {
  running: true,
  angleX: 0,
  angleY: 0,
  lastFrameTime: 0,
  drag: null,
  suppressNextClick: false,
  cubeCount: 1,
  perCubeTextures: true,
  zoom: CubeWheelZoom.DEFAULT_SCALE,
};
const cubeGridState = {
  count: 0,
  width: 0,
  height: 0,
  zoom: 0,
  textureRevision: -1,
  textureInstances: [],
  instances: [],
};
const AUTO_ROTATE_X_SPEED = 0.0007;
const AUTO_ROTATE_Y_SPEED = 0.001;
const POINTER_ROTATE_SPEED = 0.01;
const CLICK_DRAG_THRESHOLD = 4;
let cubeRenderer = null;
let bpalLoadId = 0;
let loadedBpalTexture = null;
let loadedTextureKind = "bpal";
let bundledBpalExamples = [];
let primaryTextureResource = null;
let cubeTextureRevision = 0;
let cubeTextureBuildId = 0;
let primaryTextureData = null;
let ownedCubeTextureResources = [];
const cubeTextureDataCache = new Map();
const cubeTextureDataPromises = new Map();

window.addEventListener("languagechange", () => {
  if (loadedBpalTexture) {
    updateLoadedBpalStatus();
  }
});

if (!gl) {
  document.body.textContent = "WebGL is not supported in this browser.";
  throw new Error("WebGL is not supported");
}

start().catch((error) => {
  console.error("WebGL cube startup failed.", error);
  document.body.textContent = `WebGL cube startup failed: ${error.message}`;
});

async function start() {
  initializeRendererModeControl();
  cubeRenderer = compactRendererEnabled
    ? await CompactTexturedCubeRenderer.create(gl)
    : await TexturedCubeRenderer.create(gl);
  window.__texturedCubeRenderer = cubeRenderer;
  window.__cubeRendererMode = compactRendererEnabled ? "webgl2-compact" : "webgl1";
  window.__cubeMotionState = cubeMotionState;
  window.__cubeGridState = cubeGridState;
  window.__cubeTextureInstances = cubeGridState.textureInstances;
  initializeMaterialControls();
  initializeCubePointerControls();
  initializeBpalTextureControls();

  try {
    await initializeBundledBpalTexture();
  } catch (error) {
    console.warn("Bundled BPAL cube texture could not be loaded.", error);
    await cubeRenderer.loadTexture("assets/stone-texture-wic.jpg");
    primaryTextureResource = cubeRenderer.getCurrentBpalTextureResource();
    resetCubeTextureInstances();
    setBpalStatus(localized("Default JPEG fallback", "Резервная JPEG-текстура"), false);
  }

  requestAnimationFrame(render);
}

function render(time) {
  updateCubeAngles(time);
  updateFpsCounter(time);
  cubeRenderer.resizeToDisplaySize();
  cubeRenderer.draw({
    angleY: cubeMotionState.angleY,
    angleX: cubeMotionState.angleX,
    instances: getCubeInstances(gl.drawingBufferWidth, gl.drawingBufferHeight),
  });
  requestAnimationFrame(render);
}

function getCubeInstances(width, height) {
  if (
    cubeGridState.count !== cubeMotionState.cubeCount ||
    cubeGridState.width !== width ||
    cubeGridState.height !== height ||
    cubeGridState.zoom !== cubeMotionState.zoom ||
    cubeGridState.textureRevision !== cubeTextureRevision
  ) {
    cubeGridState.count = cubeMotionState.cubeCount;
    cubeGridState.width = width;
    cubeGridState.height = height;
    cubeGridState.zoom = cubeMotionState.zoom;
    cubeGridState.textureRevision = cubeTextureRevision;
    cubeGridState.instances = window.CubeGridLayout.createInstances(
      cubeMotionState.cubeCount,
      width / Math.max(1, height),
      cubeMotionState.zoom
    );
    cubeGridState.instances.forEach((instance, index) => {
      instance.textureResource = cubeGridState.textureInstances[index] || primaryTextureResource;
    });
  }

  return cubeGridState.instances;
}

function updateCubeAngles(time) {
  const elapsed = cubeMotionState.lastFrameTime
    ? Math.min(64, time - cubeMotionState.lastFrameTime)
    : 0;

  cubeMotionState.lastFrameTime = time;

  if (!cubeMotionState.running || cubeMotionState.drag) {
    return;
  }

  cubeMotionState.angleY += elapsed * AUTO_ROTATE_Y_SPEED;
  cubeMotionState.angleX += elapsed * AUTO_ROTATE_X_SPEED;
}

function updateFpsCounter(time) {
  fpsState.frameCount += 1;

  if (fpsState.lastUpdateTime === 0) {
    fpsState.lastUpdateTime = time;
    return;
  }

  const elapsed = time - fpsState.lastUpdateTime;

  if (elapsed >= 500) {
    const fps = Math.round((fpsState.frameCount * 1000) / elapsed);

    fpsCounter.textContent = `${fps} FPS`;
    fpsState.frameCount = 0;
    fpsState.lastUpdateTime = time;
  }
}

function initializeMaterialControls() {
  if (!materialControls || !heightStrengthInput) {
    return;
  }

  materialControls.addEventListener("change", (event) => {
    if (event.target && event.target.name === "material") {
      applySelectedMaterial();
    }
  });
  heightStrengthInput.addEventListener("input", () => {
    cubeRenderer.setHeightStrength(Number(heightStrengthInput.value));
    updateHeightStrengthLabel();
  });
  cubeCountInput.addEventListener("change", () => {
    cubeMotionState.cubeCount = Number(cubeCountInput.value);
    resetCubeTextureInstances();
    requestCubeTextureRebuild();
  });
  cubeMotionState.cubeCount = Number(cubeCountInput.value);
  cubeMotionState.perCubeTextures = Boolean(perCubeTexturesInput && perCubeTexturesInput.checked);
  applySelectedMaterial();
}

function initializeRendererModeControl() {
  if (!webgl2CompactInput) {
    return;
  }

  webgl2CompactInput.checked = compactRendererEnabled;
  webgl2CompactInput.disabled = !compactRendererEnabled &&
    typeof window.WebGL2RenderingContext === "undefined";
  webgl2CompactInput.addEventListener("change", () => {
    const url = new URL(window.location.href);

    if (webgl2CompactInput.checked) {
      url.searchParams.delete("renderer");
    } else {
      url.searchParams.set("renderer", "webgl1");
    }

    window.location.replace(url.href);
  });
}

function initializeBpalTextureControls() {
  if (!textureFormatSelect || !bpalExampleSelect || !bpalFileInput || !bpalStatus) {
    return;
  }

  const dctOption = textureFormatSelect.querySelector('option[value="dct"]');

  if (dctOption) {
    dctOption.disabled = !compactRendererEnabled;
  }

  textureFormatSelect.addEventListener("change", () => {
    const load = textureFormatSelect.value === "dct"
      ? loadBundledDctTexture()
      : loadSelectedBundledBpalTexture();

    load.catch((error) => {
      console.error("Cube texture format switch failed.", error);
      setBpalStatus(error && error.message ? error.message : String(error), true);
    });
  });

  bpalExampleSelect.addEventListener("change", () => {
    const example = window.BpalExampleCatalog.getSelectedExample(bpalExampleSelect);

    if (example) {
      loadBundledBpalTexture(example.url, example.name).catch((error) => {
        console.error("Bundled BPAL texture load failed.", error);
        setBpalStatus(error && error.message ? error.message : String(error), true);
      });
    }
  });

  bpalFileInput.addEventListener("change", () => {
    const file = bpalFileInput.files && bpalFileInput.files[0];

    if (file) {
      loadBpalTextureFile(file).catch((error) => {
        console.error("BPAL texture load failed.", error);
        setBpalStatus(error && error.message ? error.message : String(error), true);
      });
    }
  });

  if (perCubeTexturesInput) {
    perCubeTexturesInput.addEventListener("change", () => {
      cubeMotionState.perCubeTextures = perCubeTexturesInput.checked;
      resetCubeTextureInstances();
      requestCubeTextureRebuild();
      updateLoadedBpalStatus();
    });
  }
}

function loadSelectedBundledBpalTexture() {
  const example = window.BpalExampleCatalog.getSelectedExample(bpalExampleSelect);

  if (!example) {
    throw new Error("No bundled BPAL texture is selected");
  }

  return loadBundledBpalTexture(example.url, example.name);
}

async function loadBpalTextureFile(file) {
  return loadBpalTextureSource(file, file.name);
}

async function initializeBundledBpalTexture() {
  const manifest = await window.BpalExampleCatalog.loadManifest();
  const example = window.BpalExampleCatalog.populateSelect(bpalExampleSelect, manifest);

  bundledBpalExamples = Array.from(bpalExampleSelect.options, (option) => ({
    url: option.value,
    name: option.textContent.trim(),
  }));

  if (perCubeTexturesInput) {
    perCubeTexturesInput.disabled = false;
  }

  return loadBundledBpalTexture(example.url, example.name);
}

async function loadBundledBpalTexture(url, fileName) {
  return loadBpalTextureSource({
    async arrayBuffer() {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Could not load ${fileName}: ${response.status} ${response.statusText}`);
      }

      return response.arrayBuffer();
    },
  }, fileName, url);
}

async function loadBundledDctTexture() {
  if (!compactRendererEnabled || !window.Dctbs2TextureDecoder) {
    throw new Error(localized(
      "DCTBS2 texture sampling requires WebGL2 compact mode",
      "Для DCTBS2-текстуры требуется режим WebGL2 compact"
    ));
  }

  const loadId = ++bpalLoadId;

  setBpalControlsDisabled(true);
  setBpalStatus(localized(
    `Reading ${DCT_DEMO_NAME}…`,
    `Чтение ${DCT_DEMO_NAME}…`
  ), false);

  try {
    const response = await fetch(DCT_DEMO_URL);

    if (!response.ok) {
      throw new Error(
        `Could not load ${DCT_DEMO_NAME}: ${response.status} ${response.statusText}`
      );
    }

    const bytes = await response.arrayBuffer();

    if (loadId !== bpalLoadId) {
      return;
    }

    const shaderTextureData = window.Dctbs2TextureDecoder.createShaderTextureData(
      bytes,
      gl.getParameter(gl.MAX_TEXTURE_SIZE)
    );

    cubeRenderer.resetMaterialMaps();
    cubeRenderer.discardColorTexture();
    cubeRenderer.loadDctShaderTexture(shaderTextureData);
    cubeRenderer.setDctShaderTextureEnabled(true);
    primaryTextureResource = cubeRenderer.getCurrentBpalTextureResource();
    primaryTextureData = null;
    loadedTextureKind = "dct";

    resetCubeTextureInstances();

    loadedBpalTexture = {
      kind: "dct",
      name: DCT_DEMO_NAME,
      width: shaderTextureData.width,
      height: shaderTextureData.height,
      version: shaderTextureData.version,
      format: "DCTBS2",
      formatVersion: shaderTextureData.version,
      bitsPerPixel: shaderTextureData.bitsPerPixel,
      quality: shaderTextureData.quality,
      shaderTextureEnabled: true,
    };
    window.__cubeBpalTexture = null;
    window.__cubeDctTexture = loadedBpalTexture;

    updateLoadedBpalStatus();
  } finally {
    if (loadId === bpalLoadId) {
      setBpalControlsDisabled(false);
    }
  }
}

async function loadBpalTextureSource(source, fileName, sourceUrl) {
  if (!window.BpalTextureDecoder) {
    throw new Error("BPAL texture decoder is unavailable");
  }

  const loadId = ++bpalLoadId;

  setBpalControlsDisabled(true);
  setBpalStatus(localized(`Reading ${fileName}…`, `Чтение ${fileName}…`), false);

  try {
    const bytes = await source.arrayBuffer();

    if (loadId !== bpalLoadId) {
      return;
    }

    const textureData = createBpalTextureData(bytes);
    const { decoded, shaderTextureData } = textureData;

    cubeRenderer.resetMaterialMaps();
    cubeRenderer.discardColorTexture();
    cubeRenderer.loadBpalShaderTexture(shaderTextureData);
    primaryTextureResource = cubeRenderer.getCurrentBpalTextureResource();
    primaryTextureData = textureData;

    cubeRenderer.setBpalShaderTextureEnabled(true);
    loadedTextureKind = "bpal";

    if (sourceUrl) {
      cubeTextureDataCache.set(sourceUrl, textureData);
    }

    resetCubeTextureInstances();
    requestCubeTextureRebuild();

    loadedBpalTexture = {
      kind: "bpal",
      name: fileName,
      width: decoded.width,
      height: decoded.height,
      version: decoded.version,
      format: decoded.containerMagic || "BPAL",
      formatVersion: decoded.containerVersion || decoded.version,
      blockSize: decoded.blockSize,
      localColorCount: decoded.localColorCount,
      globalColorCount: decoded.globalColorCount,
      paletteMode: decoded.paletteMode,
      shaderTextureEnabled: true,
    };
    window.__cubeBpalTexture = loadedBpalTexture;
    window.__cubeDctTexture = null;

    updateLoadedBpalStatus();
  } finally {
    if (loadId === bpalLoadId) {
      setBpalControlsDisabled(false);
      bpalFileInput.value = "";
    }
  }
}

function setBpalControlsDisabled(disabled) {
  const bpalSelected = textureFormatSelect.value === "bpal";

  textureFormatSelect.disabled = disabled;
  bpalFileInput.disabled = disabled || !bpalSelected;
  bpalExampleSelect.disabled = disabled || !bpalSelected || bpalExampleSelect.options.length === 0;
  if (perCubeTexturesInput) {
    perCubeTexturesInput.disabled = disabled || !bpalSelected;
  }
}

function updateLoadedBpalStatus() {
  if (!loadedBpalTexture) {
    return;
  }

  if (loadedTextureKind === "dct") {
    const dctRate = localized(
      `${loadedBpalTexture.bitsPerPixel.toFixed(3)} bpp · quality ${loadedBpalTexture.quality}`,
      `${loadedBpalTexture.bitsPerPixel.toFixed(3)} бит/пиксель · качество ${loadedBpalTexture.quality}`
    );

    setBpalStatus(
      `${loadedBpalTexture.name} · ${loadedBpalTexture.width}×${loadedBpalTexture.height} · ` +
        `DCTBS2 v${loadedBpalTexture.version} · ` +
        `${dctRate} · ` +
        localized(
          "fragment-shader IDCT, RGBA not uploaded",
          "IDCT во fragment shader, RGBA не загружена"
        ) + ` · GPU ${formatBytes(getAssignedGpuBytes())}`,
      false
    );
    return;
  }

  const renderMode = loadedBpalTexture.shaderTextureEnabled
    ? localized(
      "shader-only double indexing, RGBA not uploaded",
      "только двойная индексация в шейдере, RGBA не загружена"
    )
    : localized("decoded RGBA texture", "готовая RGBA-текстура");
  const textureMode = cubeMotionState.perCubeTextures
    ? localized(
      `texture instances: ${cubeGridState.textureInstances.length}`,
      `экземпляров текстур: ${cubeGridState.textureInstances.length}`
    )
    : localized("one shared texture", "одна общая текстура");
  const rendererMode = compactRendererEnabled
    ? localized("WebGL2 compact R32UI", "WebGL2 compact R32UI")
    : localized("WebGL1 compatible", "WebGL1 совместимый");
  const gpuBytes = getAssignedGpuBytes();

  setBpalStatus(
    `${loadedBpalTexture.name} · ${loadedBpalTexture.width}×${loadedBpalTexture.height} · ` +
      `${loadedBpalTexture.format} v${loadedBpalTexture.formatVersion} · ${rendererMode} · ` +
      `${renderMode} · ${textureMode} · GPU ${formatBytes(gpuBytes)}`,
    false
  );
}

function createBpalTextureData(bytes) {
  const decoded = decodeBlockPaletteTexture(bytes);
  const shaderTextureData = compactRendererEnabled
    ? window.BpalTextureDecoder.createCompactShaderTextureData(
      decoded,
      gl.getParameter(gl.MAX_TEXTURE_SIZE)
    )
    : window.BpalTextureDecoder.createShaderTextureData(
      decoded,
      gl.getParameter(gl.MAX_TEXTURE_SIZE)
    );

  if (!Number.isFinite(shaderTextureData.gpuBytes)) {
    shaderTextureData.gpuBytes = shaderTextureData.pixelAtlas.data.byteLength +
      shaderTextureData.blockPaletteAtlas.data.byteLength +
      shaderTextureData.paletteAtlas.data.byteLength;
  }

  return { decoded, shaderTextureData };
}

function getAssignedGpuBytes() {
  const resources = new Set(cubeGridState.textureInstances.filter(Boolean));

  return Array.from(resources).reduce((total, resource) => {
    const textureInfo = loadedTextureKind === "dct"
      ? resource.dctTextureInfo
      : resource.bpalTextureInfo;

    return total + (textureInfo && textureInfo.gpuBytes || 0);
  }, 0);
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function getOrderedBpalExamples() {
  const selected = window.BpalExampleCatalog.getSelectedExample(bpalExampleSelect);

  if (!selected) {
    return bundledBpalExamples;
  }

  return [
    selected,
    ...bundledBpalExamples.filter((example) => example.url !== selected.url),
  ];
}

function resetCubeTextureInstances() {
  cubeTextureBuildId += 1;
  deleteOwnedCubeTextureResources();
  setCubeTextureInstances(Array.from(
    { length: cubeMotionState.cubeCount },
    () => primaryTextureResource
  ));
}

function setCubeTextureInstances(resources) {
  cubeGridState.textureInstances.length = 0;
  cubeGridState.textureInstances.push(...resources);
  cubeTextureRevision += 1;
  window.__cubeTextureInstances = cubeGridState.textureInstances;
}

function deleteOwnedCubeTextureResources() {
  ownedCubeTextureResources.forEach((resource) => {
    cubeRenderer.deleteBpalTextureResource(resource);
  });
  ownedCubeTextureResources = [];
}

function requestCubeTextureRebuild() {
  rebuildCubeTextureInstances().catch((error) => {
    console.error("Per-cube BPAL texture creation failed.", error);
    setBpalStatus(error && error.message ? error.message : String(error), true);
  });
}

async function rebuildCubeTextureInstances() {
  const buildId = ++cubeTextureBuildId;
  const count = cubeMotionState.cubeCount;

  if (!cubeMotionState.perCubeTextures || !primaryTextureData || count < 2) {
    return;
  }

  const examples = getOrderedBpalExamples();
  const textureData = await Promise.all(Array.from({ length: count - 1 }, (_, offset) => {
    const cubeIndex = offset + 1;
    const example = examples.length > 0 ? examples[cubeIndex % examples.length] : null;

    return example ? loadCubeTextureData(example) : primaryTextureData;
  }));

  if (buildId !== cubeTextureBuildId) {
    return;
  }

  const createdResources = [];

  try {
    textureData.forEach((data) => {
      createdResources.push(cubeRenderer.createBpalTextureResource(data.shaderTextureData));
    });
  } catch (error) {
    createdResources.forEach((resource) => cubeRenderer.deleteBpalTextureResource(resource));
    throw error;
  }

  if (buildId !== cubeTextureBuildId) {
    createdResources.forEach((resource) => cubeRenderer.deleteBpalTextureResource(resource));
    return;
  }

  deleteOwnedCubeTextureResources();
  ownedCubeTextureResources = createdResources;
  setCubeTextureInstances([primaryTextureResource, ...createdResources]);
  updateLoadedBpalStatus();
}

async function loadCubeTextureData(example) {
  const selected = window.BpalExampleCatalog.getSelectedExample(bpalExampleSelect);

  if (selected && example.url === selected.url && primaryTextureData) {
    return primaryTextureData;
  }

  if (cubeTextureDataCache.has(example.url)) {
    return cubeTextureDataCache.get(example.url);
  }

  if (cubeTextureDataPromises.has(example.url)) {
    return cubeTextureDataPromises.get(example.url);
  }

  const promise = (async () => {
    const response = await fetch(example.url);

    if (!response.ok) {
      throw new Error(`Could not load ${example.name}: ${response.status} ${response.statusText}`);
    }

    const data = createBpalTextureData(await response.arrayBuffer());

    cubeTextureDataCache.set(example.url, data);
    return data;
  })().finally(() => {
    cubeTextureDataPromises.delete(example.url);
  });

  cubeTextureDataPromises.set(example.url, promise);
  return promise;
}

function decodeBlockPaletteTexture(bytes) {
  return window.BplmFormat && window.BplmFormat.isBplmFile(bytes)
    ? window.BplmFormat.decodeBplmFile(bytes)
    : window.BpalTextureDecoder.decode(bytes);
}

function setBpalStatus(message, isError) {
  bpalStatus.textContent = message;
  bpalStatus.classList.toggle("is-error", Boolean(isError));
}

function initializeCubePointerControls() {
  canvas.addEventListener("click", () => {
    if (cubeMotionState.suppressNextClick) {
      cubeMotionState.suppressNextClick = false;
      return;
    }

    cubeMotionState.running = !cubeMotionState.running;
    cubeMotionState.lastFrameTime = 0;
  });
  canvas.addEventListener("pointerdown", startCubeDrag);
  canvas.addEventListener("pointermove", updateCubeDrag);
  canvas.addEventListener("pointerup", finishCubeDrag);
  canvas.addEventListener("pointercancel", finishCubeDrag);
  canvas.addEventListener("wheel", zoomCubes, { passive: false });
  canvas.addEventListener("lostpointercapture", () => {
    cubeMotionState.drag = null;
    canvas.classList.remove("is-dragging");
  });
}

function zoomCubes(event) {
  event.preventDefault();
  cubeMotionState.zoom = CubeWheelZoom.getNextScale(
    cubeMotionState.zoom,
    event.deltaY,
    event.deltaMode
  );
}

function startCubeDrag(event) {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();

  if (canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      // Synthetic pointer events used by tests may not have a capturable pointer.
    }
  }

  canvas.classList.add("is-dragging");
  cubeMotionState.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    angleX: cubeMotionState.angleX,
    angleY: cubeMotionState.angleY,
    moved: false,
  };
}

function updateCubeDrag(event) {
  const drag = cubeMotionState.drag;

  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();

  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;

  if (Math.hypot(deltaX, deltaY) >= CLICK_DRAG_THRESHOLD) {
    drag.moved = true;
  }

  cubeMotionState.angleY = drag.angleY + deltaX * POINTER_ROTATE_SPEED;
  cubeMotionState.angleX = drag.angleX - deltaY * POINTER_ROTATE_SPEED;
}

function finishCubeDrag(event) {
  const drag = cubeMotionState.drag;

  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  cubeMotionState.drag = null;
  cubeMotionState.suppressNextClick = drag.moved;
  canvas.classList.remove("is-dragging");

  if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

function applySelectedMaterial() {
  const formData = new FormData(materialControls);
  const material = formData.get("material") || "matte";

  cubeRenderer.setMaterial(String(material));
  heightStrengthInput.value = cubeRenderer.material.heightStrength.toFixed(2);
  updateHeightStrengthLabel();
}

function updateHeightStrengthLabel() {
  if (heightStrengthValue) {
    heightStrengthValue.textContent = Number(heightStrengthInput.value).toFixed(2);
  }
}
