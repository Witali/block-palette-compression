/*
 * Purpose: Demo page for mipmapped BPAL sampling in a WebGL fragment shader.
 * Processing blocks:
 * - Load a BPAL file and build independently indexed mip levels.
 * - Upload compact index/palette atlases to the shared cube renderer.
 * - Switch custom nearest, bilinear, trilinear, and anisotropic filters live.
 */
"use strict";

const t = (key, parameters) => window.I18n.t(key, parameters);
const localized = (english, russian) => window.I18n.getLanguage() === "ru" ? russian : english;

const canvas = document.getElementById("gl-canvas");
const fpsCounter = document.getElementById("fps-counter");
const controls = document.getElementById("sampler-controls");
const bpalFileInput = document.getElementById("bpal-file");
const bpalStatus = document.getElementById("bpal-status");
const samplerStats = document.getElementById("sampler-stats");
const filterModeInput = document.getElementById("filter-mode");
const anisotropyInput = document.getElementById("anisotropy");
const lodBiasInput = document.getElementById("lod-bias");
const lodBiasValue = document.getElementById("lod-bias-value");
const gl = canvas.getContext("webgl", { antialias: true });
const motion = {
  running: true,
  angleX: 0,
  angleY: 0,
  lastFrameTime: 0,
  drag: null,
  suppressNextClick: false,
  zoom: CubeWheelZoom.DEFAULT_SCALE,
};
const cubeInstances = [{ translation: [0, 0, 0], scale: motion.zoom }];
const fps = {
  frames: 0,
  lastUpdate: 0,
};
const AUTO_ROTATE_X_SPEED = 0.0007;
const AUTO_ROTATE_Y_SPEED = 0.001;
const POINTER_ROTATE_SPEED = 0.01;
const CLICK_DRAG_THRESHOLD = 4;
const DEFAULT_BPAL_TEXTURE_URL = "assets/bpal/stone-texture-wic.bplm";
const DEFAULT_BPAL_TEXTURE_NAME = "stone-texture-wic.bplm";
let renderer = null;
let loadId = 0;
let loadedTexture = null;

window.addEventListener("languagechange", () => {
  if (loadedTexture) {
    updateTextureDetails();
  }
});

if (!gl) {
  document.body.textContent = localized(
    "WebGL is not supported in this browser.",
    "WebGL не поддерживается этим браузером."
  );
  throw new Error("WebGL is not supported");
}

if (!gl.getExtension("OES_standard_derivatives")) {
  document.body.textContent = localized(
    "BPAL mipmapping requires OES_standard_derivatives.",
    "Для BPAL mipmapping требуется OES_standard_derivatives."
  );
  throw new Error("OES_standard_derivatives is unavailable");
}

start().catch((error) => {
  console.error("BPAL sampler startup failed.", error);
  document.body.textContent = `BPAL sampler startup failed: ${error.message}`;
});

async function start() {
  renderer = await TexturedCubeRenderer.create(gl, {
    shaderUrls: {
      vertex: "src/shaders/cube.vert.glsl?v=bplm-1",
      fragment: "src/shaders/cube-bpal-sampler.frag.glsl?v=bplm-1",
    },
  });
  window.__bpalSamplerRenderer = renderer;
  window.__bpalSamplerState = { motion, loadedTexture: null };

  initializeControls();
  initializePointerControls();
  applySamplerOptions();
  applyMaterial();

  try {
    await loadDefaultBpalTexture();
  } catch (error) {
    console.warn("Default BPAL sampler texture could not be loaded.", error);
    await renderer.loadTexture("assets/stone-texture-wic.jpg", { materialMaps: false });
    setStatus(t("sampler.defaultStatus"), false);
    samplerStats.textContent = t("sampler.initialStats");
  }

  requestAnimationFrame(render);
}

function render(time) {
  updateMotion(time);
  updateFps(time);
  renderer.draw({
    angleX: motion.angleX,
    angleY: motion.angleY,
    instances: cubeInstances,
    resizeToDisplaySize: true,
  });
  requestAnimationFrame(render);
}

function initializeControls() {
  bpalFileInput.addEventListener("change", () => {
    const file = bpalFileInput.files && bpalFileInput.files[0];

    if (file) {
      loadBpal(file).catch((error) => {
        console.error("BPAL mip texture load failed.", error);
        setStatus(error && error.message ? error.message : String(error), true);
      });
    }
  });
  filterModeInput.addEventListener("change", applySamplerOptions);
  anisotropyInput.addEventListener("change", applySamplerOptions);
  lodBiasInput.addEventListener("input", applySamplerOptions);
  controls.addEventListener("change", (event) => {
    if (event.target && event.target.name === "material") {
      applyMaterial();
    }
  });
}

async function loadBpal(file) {
  if (!window.BpalTextureDecoder) {
    throw new Error("BPAL decoder is unavailable");
  }

  const currentLoadId = ++loadId;

  bpalFileInput.disabled = true;
  setStatus(localized(`Reading ${file.name}…`, `Чтение ${file.name}…`), false);

  try {
    const bytes = await file.arrayBuffer();

    if (currentLoadId !== loadId) {
      return;
    }

    setStatus(localized(
      "Decoding BPAL and building mip levels…",
      "Декодирование BPAL и построение mip-уровней…"
    ), false);
    await nextFrame();

    const decoded = decodeBlockPaletteTexture(bytes);

    if (currentLoadId !== loadId) {
      return;
    }

    activateBpalTexture(decoded, {
      name: file.name,
      fileBytes: bytes.byteLength,
    });
  } finally {
    if (currentLoadId === loadId) {
      bpalFileInput.disabled = false;
      bpalFileInput.value = "";
    }
  }
}

async function loadDefaultBpalTexture() {
  if (!window.BpalTextureDecoder) {
    throw new Error("BPAL decoder is unavailable");
  }

  setStatus(localized(
    "Loading the built-in BPAL texture…",
    "Загрузка встроенной BPAL-текстуры…"
  ), false);

  const response = await fetch(DEFAULT_BPAL_TEXTURE_URL);

  if (!response.ok) {
    throw new Error(`Could not load ${DEFAULT_BPAL_TEXTURE_NAME}: ${response.status} ${response.statusText}`);
  }

  const bytes = await response.arrayBuffer();
  const decoded = decodeBlockPaletteTexture(bytes);

  activateBpalTexture(decoded, {
    name: DEFAULT_BPAL_TEXTURE_NAME,
    fileBytes: bytes.byteLength,
  });
}

function activateBpalTexture(decoded, metadata) {
  const startedAt = performance.now();
  const shaderTexture = window.BpalTextureDecoder.createMipmappedShaderTextureData(
    decoded,
    gl.getParameter(gl.MAX_TEXTURE_SIZE),
      { maxMipLevels: 16 }
  );
  const buildMilliseconds = performance.now() - startedAt;

  renderer.loadTexturePixels(decoded.pixels, decoded.width, decoded.height, {
    flipY: true,
    resetMaterialMaps: true,
  });
  renderer.loadBpalShaderTexture(shaderTexture);
  renderer.setBpalShaderTextureEnabled(true);
  applySamplerOptions();

  loadedTexture = {
    name: metadata.name,
    width: decoded.width,
    height: decoded.height,
    format: decoded.containerMagic || "BPAL",
    version: decoded.containerVersion || decoded.version,
    blockSize: decoded.blockSize,
    localColorCount: decoded.localColorCount,
    globalColorCount: decoded.globalColorCount,
    mipCount: shaderTexture.mipCount,
    gpuBytes: shaderTexture.gpuBytes,
    fileBytes: metadata.fileBytes,
    buildMilliseconds,
  };
  window.__bpalSamplerState.loadedTexture = loadedTexture;
  updateTextureDetails();
}

function applySamplerOptions() {
  const filterMode = filterModeInput.value;
  const maxAnisotropy = Number(anisotropyInput.value);
  const lodBias = Number(lodBiasInput.value);

  anisotropyInput.disabled = filterMode !== "anisotropic";
  lodBiasValue.textContent = lodBias.toFixed(2);

  if (renderer) {
    renderer.setBpalSamplerOptions({ filterMode, maxAnisotropy, lodBias });
  }

  if (loadedTexture) {
    updateTextureDetails();
  }
}

function applyMaterial() {
  if (!renderer) {
    return;
  }

  const material = new FormData(controls).get("material") || "matte";

  renderer.setMaterial(String(material));
}

function updateTextureDetails() {
  const filterLabel = filterModeInput.options[filterModeInput.selectedIndex].textContent;
  const anisotropy = filterModeInput.value === "anisotropic"
    ? ` · ${anisotropyInput.value}×`
    : "";
  const versionLabel = Number.isInteger(loadedTexture.version)
    ? `${loadedTexture.format} v${loadedTexture.version}`
    : "BPAL demo";

  setStatus(
    `${loadedTexture.name} · ${versionLabel} · ${filterLabel}${anisotropy}`,
    false
  );
  samplerStats.textContent =
    `${loadedTexture.width}×${loadedTexture.height} · ` +
    localized(
      `${loadedTexture.mipCount} mip levels · ${loadedTexture.blockSize}×${loadedTexture.blockSize} blocks · ` +
      `${loadedTexture.localColorCount}/${loadedTexture.globalColorCount} colors · ` +
      `GPU atlases ${formatBytes(loadedTexture.gpuBytes)} · ` +
      `built in ${t("units.ms", { value: loadedTexture.buildMilliseconds.toFixed(1) })}`,
      `${loadedTexture.mipCount} mip-уровней · блок ${loadedTexture.blockSize}×${loadedTexture.blockSize} · ` +
      `${loadedTexture.localColorCount}/${loadedTexture.globalColorCount} цветов · ` +
      `GPU-атласы ${formatBytes(loadedTexture.gpuBytes)} · ` +
      `построение ${t("units.ms", { value: loadedTexture.buildMilliseconds.toFixed(1) })}`
    );
}

function setStatus(message, isError) {
  bpalStatus.textContent = message;
  bpalStatus.title = message;
  bpalStatus.classList.toggle("is-error", Boolean(isError));
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return t("units.bytes", { value: bytes });
  }

  if (bytes < 1024 * 1024) {
    return t("units.kib", { value: (bytes / 1024).toFixed(2) });
  }

  return t("units.mib", { value: (bytes / (1024 * 1024)).toFixed(2) });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function updateMotion(time) {
  const elapsed = motion.lastFrameTime ? Math.min(64, time - motion.lastFrameTime) : 0;

  motion.lastFrameTime = time;

  if (!motion.running || motion.drag) {
    return;
  }

  motion.angleY += elapsed * AUTO_ROTATE_Y_SPEED;
  motion.angleX += elapsed * AUTO_ROTATE_X_SPEED;
}

function updateFps(time) {
  fps.frames += 1;

  if (fps.lastUpdate === 0) {
    fps.lastUpdate = time;
    return;
  }

  const elapsed = time - fps.lastUpdate;

  if (elapsed >= 500) {
    fpsCounter.textContent = `${Math.round(fps.frames * 1000 / elapsed)} FPS`;
    fps.frames = 0;
    fps.lastUpdate = time;
  }
}

function initializePointerControls() {
  canvas.addEventListener("click", () => {
    if (motion.suppressNextClick) {
      motion.suppressNextClick = false;
      return;
    }

    motion.running = !motion.running;
    motion.lastFrameTime = 0;
  });
  canvas.addEventListener("pointerdown", startDrag);
  canvas.addEventListener("pointermove", moveDrag);
  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);
  canvas.addEventListener("wheel", zoomCube, { passive: false });
  canvas.addEventListener("lostpointercapture", () => {
    motion.drag = null;
    canvas.classList.remove("is-dragging");
  });
}

function decodeBlockPaletteTexture(bytes) {
  return window.BplmFormat && window.BplmFormat.isBplmFile(bytes)
    ? window.BplmFormat.decodeBplmFile(bytes)
    : window.BpalTextureDecoder.decode(bytes);
}

function zoomCube(event) {
  event.preventDefault();
  motion.zoom = CubeWheelZoom.getNextScale(motion.zoom, event.deltaY, event.deltaMode);
  cubeInstances[0].scale = motion.zoom;
}

function startDrag(event) {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("is-dragging");
  motion.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    angleX: motion.angleX,
    angleY: motion.angleY,
    moved: false,
  };
}

function moveDrag(event) {
  const drag = motion.drag;

  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();

  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;

  drag.moved = drag.moved || Math.hypot(deltaX, deltaY) >= CLICK_DRAG_THRESHOLD;
  motion.angleY = drag.angleY + deltaX * POINTER_ROTATE_SPEED;
  motion.angleX = drag.angleX - deltaY * POINTER_ROTATE_SPEED;
}

function finishDrag(event) {
  const drag = motion.drag;

  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  motion.drag = null;
  motion.suppressNextClick = drag.moved;
  canvas.classList.remove("is-dragging");

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}
