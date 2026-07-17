import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import createASTCModule from "../../vendor/astc-encoder-wasm/astcenc.mjs";

const ASSET_ROOT = "./assets/scenes/barcelona/";
const MANIFEST_URL = `${ASSET_ROOT}manifest.json`;
const SCENE_URL = `${ASSET_ROOT}scene.gltf`;
const CODEC_LABELS = Object.freeze({
  original: "Original · BC1 / BC7",
  bpal: "BPAL",
  dct: "DCTBS2",
  astc: "ASTC",
});
const FRAME_EXCLUDED_OBJECTS = new Set(["tree_scatter_plane"]);
const elements = {
  canvas: document.getElementById("scene-canvas"),
  codec: document.getElementById("scene-texture-format"),
  codecName: document.getElementById("scene-codec-name"),
  compressedSize: document.getElementById("scene-compressed-size"),
  decodeTime: document.getElementById("scene-decode-time"),
  error: document.getElementById("scene-error"),
  loading: document.getElementById("scene-loading"),
  loadingLabel: document.getElementById("scene-loading-label"),
  progress: document.getElementById("scene-progress-value"),
  status: document.getElementById("scene-status"),
  textureCount: document.getElementById("scene-texture-count"),
};

const renderer = new THREE.WebGLRenderer({
  canvas: elements.canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x11191a, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11191a);
scene.fog = new THREE.Fog(0x11191a, 80, 260);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 1000);
const controls = new OrbitControls(camera, elements.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.screenSpacePanning = true;
controls.minDistance = 0.25;
controls.maxDistance = 500;

scene.add(new THREE.HemisphereLight(0xdde8df, 0x425052, 2.15));
const sun = new THREE.DirectionalLight(0xffefcf, 3.1);
sun.position.set(-28, 38, 26);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9ab9d1, 0.85);
fill.position.set(34, 12, -30);
scene.add(fill);

let manifest;
let sceneRoot;
let textureEntries;
let activeResources = new Map();
let astcModulePromise;
let loadGeneration = 0;
let lastStatus = null;

elements.codec.addEventListener("change", () => applyCodec(elements.codec.value));
window.addEventListener("resize", resizeRenderer);
window.addEventListener("languagechange", () => {
  if (lastStatus) setStatus(lastStatus.key, lastStatus.parameters);
});

initialize().catch(showError);
renderer.setAnimationLoop(render);

async function initialize() {
  setLoading("scene.loadingScene", 0.05);
  const [loadedManifest, gltf] = await Promise.all([
    fetchJson(MANIFEST_URL),
    loadGltf(SCENE_URL),
  ]);
  manifest = loadedManifest;
  textureEntries = new Map(manifest.textures.map((entry) => [entry.id, entry]));
  elements.textureCount.textContent = String(manifest.textureCount);

  sceneRoot = gltf.scene;
  scene.add(sceneRoot);
  configureSceneMaterials(sceneRoot);
  frameScene(sceneRoot);
  resizeRenderer();

  await applyCodec(elements.codec.value);
}

async function applyCodec(codec) {
  if (!manifest || !sceneRoot || !CODEC_LABELS[codec]) return;
  const generation = ++loadGeneration;
  const startedAt = performance.now();
  elements.codec.disabled = true;
  elements.error.hidden = true;
  elements.loading.hidden = false;
  elements.codecName.textContent = CODEC_LABELS[codec];
  setLoading("scene.loadingTextures", 0.08, { codec: CODEC_LABELS[codec] });

  try {
    const identifiers = usedTextureIdentifiers(manifest.materials);
    const jobs = createDecodeJobs(codec, identifiers);
    const encoded = await Promise.all(jobs.map(async (job) => ({
      ...job,
      bytes: await fetchBytes(`${ASSET_ROOT}${job.path}`),
    })));
    const resources = new Map();

    for (let index = 0; index < encoded.length; index += 1) {
      if (generation !== loadGeneration) return;
      const job = encoded[index];
      setLoading("scene.decodingTexture", 0.12 + 0.8 * (index / encoded.length), {
        current: index + 1,
        total: encoded.length,
        codec: CODEC_LABELS[codec],
      });
      const decoded = await decode(job.codec, job.bytes);
      const texture = createThreeTexture(decoded, job.role === "color");
      const resource = resources.get(job.identifier) || {};
      resource[job.role] = texture;
      resources.set(job.identifier, resource);
      await nextFrame();
    }

    if (generation !== loadGeneration) {
      disposeResources(resources);
      return;
    }

    assignTextures(sceneRoot, manifest.materials, resources, codec);
    disposeResources(activeResources);
    activeResources = resources;
    const duration = performance.now() - startedAt;
    elements.compressedSize.textContent = formatBytes(manifest.codecTotals[codec]);
    elements.decodeTime.textContent = formatMilliseconds(duration);
    elements.codecName.textContent = CODEC_LABELS[codec];
    elements.loading.hidden = true;
    elements.codec.disabled = false;
    setStatus("scene.ready", {
      codec: CODEC_LABELS[codec],
      used: identifiers.size,
      total: manifest.textureCount,
    });
  } catch (error) {
    elements.codec.disabled = false;
    throw error;
  }
}

function createDecodeJobs(codec, identifiers) {
  const jobs = [];
  for (const identifier of identifiers) {
    const entry = textureEntries.get(identifier);
    if (!entry) throw new Error(`Texture is missing from the manifest: ${identifier}`);
    const variant = entry.variants[codec];
    if (!variant) throw new Error(`${entry.source} has no ${codec} variant`);
    jobs.push({ codec, identifier, role: "color", path: variant.color });
    if (variant.alpha) {
      jobs.push({ codec, identifier, role: "alpha", path: variant.alpha });
    }
  }
  return jobs;
}

async function decode(codec, bytes) {
  if (codec === "original") {
    return inspectDds(bytes);
  }
  if (codec === "bpal") {
    return window.BpalTextureDecoder.decode(bytes);
  }
  if (codec === "dct") {
    return window.DctImageFormat.decodeDctFile(bytes);
  }
  if (codec === "astc") {
    return decodeAstc(bytes);
  }
  throw new RangeError(`Unsupported scene texture codec: ${codec}`);
}

function inspectDds(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 128 || readAscii(bytes, 0, 4) !== "DDS ") {
    throw new RangeError("Invalid DDS texture header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const fourCc = readAscii(bytes, 84, 4);
  let format;
  let headerBytes;
  let blockBytes;
  if (fourCc === "DXT1") {
    format = "bc1";
    headerBytes = 128;
    blockBytes = 8;
    if (!renderer.extensions.has("WEBGL_compressed_texture_s3tc")) {
      throw new Error("BC1/DXT1 textures require WEBGL_compressed_texture_s3tc");
    }
  } else if (fourCc === "DX10" && bytes.length >= 148 && view.getUint32(128, true) === 98) {
    format = "bc7";
    headerBytes = 148;
    blockBytes = 16;
    if (!renderer.extensions.has("EXT_texture_compression_bptc")) {
      throw new Error("BC7 textures require EXT_texture_compression_bptc");
    }
  } else {
    throw new RangeError(`Unsupported original DDS format: ${fourCc}`);
  }
  const expectedBytes = Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes;
  if (!width || !height || bytes.length !== headerBytes + expectedBytes) {
    throw new RangeError("Invalid DDS texture dimensions or payload length");
  }
  return {
    compressed: true,
    format,
    width,
    height,
    pixels: bytes.subarray(headerBytes),
  };
}

function readAscii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

async function decodeAstc(bytes) {
  const info = inspectAstc(bytes);
  astcModulePromise ||= createASTCModule({
    locateFile(fileName) {
      return new URL(`../../vendor/astc-encoder-wasm/${fileName}`, import.meta.url).href;
    },
  });
  const module = await astcModulePromise;
  const restored = module.decompressImage(
    bytes.subarray(16),
    info.width,
    info.height,
    `${info.blockWidth}x${info.blockHeight}`,
  );
  if (!restored.success) throw new Error(restored.error || "ASTC decompression failed");
  return {
    width: info.width,
    height: info.height,
    pixels: new Uint8ClampedArray(restored.data),
  };
}

function inspectAstc(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 ||
      bytes[0] !== 0x13 || bytes[1] !== 0xAB || bytes[2] !== 0xA1 || bytes[3] !== 0x5C) {
    throw new RangeError("Invalid ASTC texture header");
  }
  return {
    blockWidth: bytes[4],
    blockHeight: bytes[5],
    width: readUint24(bytes, 7),
    height: readUint24(bytes, 10),
  };
}

function readUint24(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}

function createThreeTexture(decoded, colorTexture) {
  if (decoded.compressed) {
    const format = decoded.format === "bc7"
      ? THREE.RGBA_BPTC_Format
      : THREE.RGB_S3TC_DXT1_Format;
    const texture = new THREE.CompressedTexture(
      [{ data: decoded.pixels, width: decoded.width, height: decoded.height }],
      decoded.width,
      decoded.height,
      format,
      THREE.UnsignedByteType,
    );
    configureThreeTexture(texture, colorTexture, false);
    return texture;
  }
  const pixels = decoded.pixels instanceof Uint8Array
    ? decoded.pixels
    : new Uint8ClampedArray(decoded.pixels);
  const texture = new THREE.DataTexture(
    pixels,
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  configureThreeTexture(texture, colorTexture, true);
  return texture;
}

function configureThreeTexture(texture, colorTexture, generateMipmaps) {
  texture.flipY = false;
  texture.colorSpace = colorTexture ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.generateMipmaps = generateMipmaps;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
}

function assignTextures(root, assignments, resources, codec) {
  const materials = collectMaterials(root);
  for (const material of materials) {
    material.map = null;
    material.alphaMap = null;
    material.bumpMap = null;
    material.emissiveMap = null;
    const assignment = assignments[material.name];
    if (assignment?.baseColor) {
      const base = resources.get(assignment.baseColor);
      material.map = base?.color || null;
      material.alphaMap = base?.alpha || null;
      const entry = textureEntries.get(assignment.baseColor);
      if (entry?.hasAlpha) {
        material.transparent = true;
        material.alphaTest = material.name === "candle_flame" ? 0.08 : 0.32;
        material.depthWrite = material.name !== "candle_flame";
      }
      if (material.name === "candle_flame") {
        material.emissiveMap = base?.color || null;
      }
    }
    if (assignment?.bump) {
      material.bumpMap = resources.get(assignment.bump)?.color || null;
      if (material.bumpMap) material.bumpMap.colorSpace = THREE.NoColorSpace;
      material.bumpScale = material.name === "water" ? 0.09 : 0.055;
    }
    if ((codec === "astc" || codec === "original") &&
        material.map && textureEntries.get(assignment?.baseColor)?.hasAlpha) {
      material.alphaMap = null;
    }
    material.needsUpdate = true;
  }
}

function configureSceneMaterials(root) {
  for (const material of collectMaterials(root)) {
    const name = material.name.toLowerCase();
    // Blender marks many image-backed architectural materials as BLEND even
    // though their decoded pixels are fully opaque. Keep walls, paving, wood,
    // grass, and stone in the opaque render queue; only the explicit material
    // overrides below and real alpha masks may opt back into transparency.
    material.transparent = false;
    material.opacity = 1;
    material.alphaTest = 0;
    material.depthWrite = true;
    material.side = name === "leafs" || name.includes("lotus") || name === "candle_flame"
      ? THREE.DoubleSide
      : THREE.FrontSide;
    if (name.includes("metal")) {
      material.metalness = 0.86;
      material.roughness = 0.22;
    } else if (name.includes("glossy")) {
      material.roughness = 0.16;
    }
    if (name.includes("glass")) {
      material.color.setRGB(0.58, 0.74, 0.76);
      material.transparent = true;
      material.opacity = 0.34;
      material.roughness = 0.08;
      material.metalness = 0.05;
      material.depthWrite = false;
    } else if (name === "water") {
      material.color.setRGB(0.2, 0.45, 0.48);
      material.transparent = true;
      material.opacity = 0.74;
      material.roughness = 0.18;
      material.depthWrite = false;
    } else if (name === "candle_flame") {
      material.color.setRGB(1, 0.72, 0.34);
      material.emissive.setRGB(1, 0.34, 0.05);
      material.emissiveIntensity = 2.4;
    }
  }
}

function collectMaterials(root) {
  const materials = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material) materials.add(material);
    }
  });
  return materials;
}

function usedTextureIdentifiers(assignments) {
  const identifiers = new Set();
  for (const roles of Object.values(assignments)) {
    for (const identifier of Object.values(roles)) identifiers.add(identifier);
  }
  return identifiers;
}

function frameScene(root) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  root.traverse((object) => {
    if (object.isMesh && !FRAME_EXCLUDED_OBJECTS.has(object.name)) {
      bounds.expandByObject(object);
    }
  });
  if (bounds.isEmpty()) bounds.setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 1);
  const direction = new THREE.Vector3(1.05, 0.56, 1).normalize();
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 0.68;
  camera.near = Math.max(radius / 800, 0.02);
  camera.far = radius * 35;
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = radius * 0.08;
  controls.maxDistance = radius * 8;
  controls.update();
  scene.fog.near = radius * 2.5;
  scene.fog.far = radius * 7;
}

function resizeRenderer() {
  const width = Math.max(1, elements.canvas.clientWidth);
  const height = Math.max(1, elements.canvas.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function render() {
  controls.update();
  renderer.render(scene, camera);
}

function setLoading(key, fraction, parameters) {
  elements.loadingLabel.textContent = translate(key, parameters);
  elements.progress.style.width = `${Math.max(4, Math.min(100, fraction * 100))}%`;
  setStatus(key, parameters);
}

function setStatus(key, parameters) {
  lastStatus = { key, parameters };
  elements.status.textContent = translate(key, parameters);
}

function showError(error) {
  console.error(error);
  elements.loading.hidden = true;
  elements.error.hidden = false;
  elements.error.textContent = translate("scene.error", {
    message: error?.message || String(error),
  });
  setStatus("scene.errorShort");
}

function translate(key, parameters) {
  return window.I18n ? window.I18n.t(key, parameters) : key;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (bytes >= 1024 * 1024) return `${formatNumber(bytes / (1024 * 1024), 1)} MiB`;
  if (bytes >= 1024) return `${formatNumber(bytes / 1024, 1)} KiB`;
  return `${formatNumber(bytes, 0)} B`;
}

function formatMilliseconds(value) {
  return `${formatNumber(value, value >= 100 ? 0 : 1)} ms`;
}

function formatNumber(value, maximumFractionDigits) {
  if (window.I18n) return window.I18n.formatNumber(value, { maximumFractionDigits });
  return Number(value).toFixed(maximumFractionDigits);
}

function disposeResources(resources) {
  for (const resource of resources.values()) {
    resource.color?.dispose();
    resource.alpha?.dispose();
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function loadGltf(url) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url, resolve, (event) => {
      if (event.total > 0) {
        setLoading("scene.loadingScene", Math.min(0.35, event.loaded / event.total * 0.35));
      }
    }, reject);
  });
}

function nextFrame() {
  return new Promise((resolve) => {
    if (document.hidden) {
      setTimeout(resolve, 0);
    } else {
      requestAnimationFrame(resolve);
    }
  });
}
