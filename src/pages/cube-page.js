/*
 * Purpose: WebGL demo entry point that renders the rotating textured cube.
 * Processing blocks:
 * - Create the shared textured cube renderer.
 * - Load the default BPLM stone texture through the shared texture path.
 * - Run the animation loop, pointer controls, and FPS counter.
 */
"use strict";

const localized = (english, russian) => window.I18n.getLanguage() === "ru" ? russian : english;

const canvas = document.getElementById("gl-canvas");
const fpsCounter = document.getElementById("fps-counter");
const materialControls = document.getElementById("material-controls");
const heightStrengthInput = document.getElementById("height-strength");
const heightStrengthValue = document.getElementById("height-strength-value");
const cubeCountInput = document.getElementById("cube-count");
const bpalFileInput = document.getElementById("bpal-file");
const bpalShaderTextureInput = document.getElementById("bpal-shader-texture");
const bpalStatus = document.getElementById("bpal-status");
const gl = canvas.getContext("webgl", { antialias: true });
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
  zoom: CubeWheelZoom.DEFAULT_SCALE,
};
const cubeGridState = {
  count: 0,
  width: 0,
  height: 0,
  zoom: 0,
  instances: [],
};
const AUTO_ROTATE_X_SPEED = 0.0007;
const AUTO_ROTATE_Y_SPEED = 0.001;
const POINTER_ROTATE_SPEED = 0.01;
const CLICK_DRAG_THRESHOLD = 4;
const DEFAULT_BPAL_TEXTURE_URL = "assets/bpal/stone-texture-wic.bplm";
const DEFAULT_BPAL_TEXTURE_NAME = "stone-texture-wic.bplm";
let cubeRenderer = null;
let bpalLoadId = 0;
let loadedBpalTexture = null;

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
  cubeRenderer = await TexturedCubeRenderer.create(gl);
  window.__texturedCubeRenderer = cubeRenderer;
  window.__cubeMotionState = cubeMotionState;
  window.__cubeGridState = cubeGridState;
  initializeMaterialControls();
  initializeCubePointerControls();
  initializeBpalTextureControls();

  try {
    await loadDefaultBpalTexture();
  } catch (error) {
    console.warn("Default BPAL cube texture could not be loaded.", error);
    await cubeRenderer.loadTexture("assets/stone-texture-wic.jpg");
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
    cubeGridState.zoom !== cubeMotionState.zoom
  ) {
    cubeGridState.count = cubeMotionState.cubeCount;
    cubeGridState.width = width;
    cubeGridState.height = height;
    cubeGridState.zoom = cubeMotionState.zoom;
    cubeGridState.instances = window.CubeGridLayout.createInstances(
      cubeMotionState.cubeCount,
      width / Math.max(1, height),
      cubeMotionState.zoom
    );
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
  });
  cubeMotionState.cubeCount = Number(cubeCountInput.value);
  applySelectedMaterial();
}

function initializeBpalTextureControls() {
  if (!bpalFileInput || !bpalStatus) {
    return;
  }

  bpalFileInput.addEventListener("change", () => {
    const file = bpalFileInput.files && bpalFileInput.files[0];

    if (file) {
      loadBpalTextureFile(file).catch((error) => {
        console.error("BPAL texture load failed.", error);
        setBpalStatus(error && error.message ? error.message : String(error), true);
      });
    }
  });

  if (bpalShaderTextureInput) {
    bpalShaderTextureInput.addEventListener("change", () => {
      const enabled = bpalShaderTextureInput.checked && Boolean(loadedBpalTexture);

      cubeRenderer.setBpalShaderTextureEnabled(enabled);

      if (loadedBpalTexture) {
        loadedBpalTexture.shaderTextureEnabled = enabled;
        window.__cubeBpalTexture.shaderTextureEnabled = enabled;
        updateLoadedBpalStatus();
      }
    });
  }
}

async function loadBpalTextureFile(file) {
  return loadBpalTextureSource(file, file.name);
}

async function loadDefaultBpalTexture() {
  const response = await fetch(DEFAULT_BPAL_TEXTURE_URL);

  if (!response.ok) {
    throw new Error(`Could not load ${DEFAULT_BPAL_TEXTURE_NAME}: ${response.status} ${response.statusText}`);
  }

  await loadBpalTextureSource(response, DEFAULT_BPAL_TEXTURE_NAME);
}

async function loadBpalTextureSource(source, fileName) {
  if (!window.BpalTextureDecoder) {
    throw new Error("BPAL texture decoder is unavailable");
  }

  const loadId = ++bpalLoadId;

  bpalFileInput.disabled = true;
  setBpalStatus(localized(`Reading ${fileName}…`, `Чтение ${fileName}…`), false);

  try {
    const bytes = await source.arrayBuffer();

    if (loadId !== bpalLoadId) {
      return;
    }

    const decoded = decodeBlockPaletteTexture(bytes);
    const shaderTextureData = window.BpalTextureDecoder.createShaderTextureData(
      decoded,
      gl.getParameter(gl.MAX_TEXTURE_SIZE)
    );

    cubeRenderer.loadTexturePixels(decoded.pixels, decoded.width, decoded.height, {
      flipY: true,
      resetMaterialMaps: true,
    });
    cubeRenderer.loadBpalShaderTexture(shaderTextureData);

    if (bpalShaderTextureInput) {
      bpalShaderTextureInput.disabled = false;
      cubeRenderer.setBpalShaderTextureEnabled(bpalShaderTextureInput.checked);
    }

    loadedBpalTexture = {
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
      shaderTextureEnabled: Boolean(bpalShaderTextureInput && bpalShaderTextureInput.checked),
    };
    window.__cubeBpalTexture = loadedBpalTexture;

    updateLoadedBpalStatus();
  } finally {
    if (loadId === bpalLoadId) {
      bpalFileInput.disabled = false;
      bpalFileInput.value = "";
    }
  }
}

function updateLoadedBpalStatus() {
  if (!loadedBpalTexture) {
    return;
  }

  const renderMode = loadedBpalTexture.shaderTextureEnabled
    ? localized("double indexing in shader", "двойная индексация в шейдере")
    : localized("decoded RGBA texture", "готовая RGBA-текстура");

  setBpalStatus(
    `${loadedBpalTexture.name} · ${loadedBpalTexture.width}×${loadedBpalTexture.height} · ` +
      `${loadedBpalTexture.format} v${loadedBpalTexture.formatVersion} · ${renderMode}`,
    false
  );
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
