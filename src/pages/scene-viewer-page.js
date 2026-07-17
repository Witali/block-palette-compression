import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const ASSET_ROOT = "./assets/scenes/barcelona/";
const MANIFEST_URL = `${ASSET_ROOT}manifest.json`;
const SCENE_URL = `${ASSET_ROOT}scene.gltf`;
const PACKED_SHADER_URL = `${ASSET_ROOT}scene-texture-samplers.glsl`;
const CODEC_LABELS = Object.freeze({
  original: "Original · BC1 / BC7",
  bpal: "BPAL",
  dct: "DCTBS2",
  astc: "ASTC",
});
const PACKED_CODEC_IDS = Object.freeze({ bpal: 1, dct: 2, astc: 3 });
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
let packedSamplerSource = "";
let emptyPackedResource;
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
  const [loadedManifest, gltf, loadedPackedSamplerSource] = await Promise.all([
    fetchJson(MANIFEST_URL),
    loadGltf(SCENE_URL),
    fetchText(PACKED_SHADER_URL),
  ]);
  manifest = loadedManifest;
  packedSamplerSource = loadedPackedSamplerSource;
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
    const jobs = createTextureJobs(codec, identifiers);
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
      const texture = createTextureResource(job.codec, job.bytes, job.role === "color");
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
    if (typeof renderer.compileAsync === "function") {
      await renderer.compileAsync(scene, camera);
    } else {
      renderer.compile(scene, camera);
    }
    if (generation !== loadGeneration) {
      disposeResources(resources);
      return;
    }
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

function createTextureJobs(codec, identifiers) {
  const jobs = [];
  for (const identifier of identifiers) {
    const entry = textureEntries.get(identifier);
    if (!entry) throw new Error(`Texture is missing from the manifest: ${identifier}`);
    const variant = entry.variants[codec];
    if (!variant) throw new Error(`${entry.source} has no ${codec} variant`);
    const colorPath = codec === "original"
      ? variant.color
      : `streams/${codec}/${identifier}.dxtx`;
    jobs.push({ codec, identifier, role: "color", path: colorPath });
    if (variant.alpha) {
      jobs.push({
        codec,
        identifier,
        role: "alpha",
        path: `streams/${codec}/${identifier}-alpha.dxtx`,
      });
    }
  }
  return jobs;
}

function createTextureResource(codec, bytes, colorTexture) {
  if (codec === "original") {
    return createOriginalTexture(inspectDds(bytes), colorTexture);
  }
  return createPackedTexture(inspectPackedTextureStream(bytes, codec));
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

function inspectPackedTextureStream(bytes, codec) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 80 || readAscii(bytes, 0, 4) !== "DXTX") {
    throw new RangeError("Invalid packed GPU texture stream header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const codecId = view.getUint32(8, true);
  const width = view.getUint32(12, true);
  const height = view.getUint32(16, true);
  const dataBytes = view.getUint32(20, true);
  if (version !== 1 || codecId !== PACKED_CODEC_IDS[codec]) {
    throw new RangeError(`Packed GPU stream does not contain ${codec}`);
  }
  if (!width || !height || !dataBytes || dataBytes % 4 !== 0 || bytes.length !== 80 + dataBytes) {
    throw new RangeError("Packed GPU stream dimensions or payload length are invalid");
  }
  const info = new Uint32Array(20);
  info[0] = codecId;
  info[1] = width;
  info[2] = height;
  info[3] = dataBytes;
  for (let index = 0; index < 14; index += 1) {
    info[4 + index] = view.getUint32(24 + index * 4, true);
  }
  return { codec, width, height, dataBytes, info, payload: bytes.subarray(80) };
}

function createPackedTexture(stream) {
  const texelCount = stream.payload.byteLength / 4;
  const maximumSize = renderer.capabilities.maxTextureSize;
  const width = Math.min(maximumSize, texelCount);
  const height = Math.ceil(texelCount / width);
  if (height > maximumSize) {
    throw new RangeError(`${stream.codec} GPU stream exceeds the WebGL2 texture-size limit`);
  }
  const data = new Uint8Array(width * height * 4);
  data.set(stream.payload);
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAIntegerFormat,
    THREE.UnsignedByteType,
  );
  texture.internalFormat = "RGBA8UI";
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, info: stream.info, codec: stream.codec, dataBytes: stream.dataBytes };
}

function createOriginalTexture(decoded, colorTexture) {
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
    const base = assignment?.baseColor ? resources.get(assignment.baseColor) : null;
    const bump = assignment?.bump ? resources.get(assignment.bump)?.color : null;
    const baseEntry = textureEntries.get(assignment?.baseColor);

    if (baseEntry?.hasAlpha) {
      material.transparent = true;
      material.alphaTest = material.name === "candle_flame" ? 0.08 : 0.32;
      material.depthWrite = material.name !== "candle_flame";
    }
    material.bumpScale = material.name === "water" ? 0.09 : 0.055;

    if (codec === "original") {
      clearPackedMaterial(material);
      material.map = base?.color || null;
      material.bumpMap = bump || null;
      if (material.bumpMap) material.bumpMap.colorSpace = THREE.NoColorSpace;
      if (material.name === "candle_flame") material.emissiveMap = base?.color || null;
    } else {
      configurePackedMaterial(material, codec, {
        base: base?.color || null,
        alpha: base?.alpha || null,
        bump,
        emissive: material.name === "candle_flame",
      });
    }
    material.needsUpdate = true;
  }
}

function clearPackedMaterial(material) {
  material.onBeforeCompile = () => {};
  material.customProgramCacheKey = () => "scene-standard-textures-v1";
  delete material.userData.scenePackedTextures;
}

function configurePackedMaterial(material, codec, resources) {
  const fallback = getEmptyPackedResource();
  const state = {
    codec,
    codecId: PACKED_CODEC_IDS[codec],
    base: resources.base || fallback,
    alpha: resources.alpha || fallback,
    bump: resources.bump || fallback,
    hasBase: Boolean(resources.base),
    hasAlpha: Boolean(resources.alpha),
    hasBump: Boolean(resources.bump),
    emissive: Boolean(resources.emissive),
    bumpScale: material.bumpScale,
  };
  material.userData.scenePackedTextures = state;
  material.onBeforeCompile = (shader) => injectPackedTextureShader(shader, state);
  material.customProgramCacheKey = () => `scene-packed-${codec}-v1`;
}

function injectPackedTextureShader(shader, state) {
  bindPackedStreamUniforms(shader, "Base", state.base);
  bindPackedStreamUniforms(shader, "Alpha", state.alpha);
  bindPackedStreamUniforms(shader, "Bump", state.bump);
  shader.uniforms.uSceneHasBase = { value: state.hasBase ? 1 : 0 };
  shader.uniforms.uSceneHasAlpha = { value: state.hasAlpha ? 1 : 0 };
  shader.uniforms.uSceneHasBump = { value: state.hasBump ? 1 : 0 };
  shader.uniforms.uSceneHasEmissive = { value: state.emissive ? 1 : 0 };
  shader.uniforms.uSceneBumpScale = { value: state.bumpScale };

  shader.vertexShader = replaceShaderChunk(
    shader.vertexShader,
    "void main() {",
    "varying vec2 vSceneUv;\nvoid main() {\n  vSceneUv = uv;",
  );
  shader.fragmentShader = replaceShaderChunk(
    shader.fragmentShader,
    "void main() {",
    `#define SCENE_CODEC ${state.codecId}\n${packedSamplerSource}\nvoid main() {`,
  );
  shader.fragmentShader = replaceShaderChunk(
    shader.fragmentShader,
    "#include <map_fragment>",
    `vec4 sceneDiffuseTexel = uSceneHasBase != 0u
      ? sceneSampleBase(vSceneUv, true)
      : vec4(1.0);
    if (uSceneHasAlpha != 0u) sceneDiffuseTexel.a *= sceneSampleAlpha(vSceneUv).r;
    diffuseColor *= sceneDiffuseTexel;`,
  );
  shader.fragmentShader = replaceShaderChunk(
    shader.fragmentShader,
    "#include <alphamap_fragment>",
    "",
  );
  shader.fragmentShader = replaceShaderChunk(
    shader.fragmentShader,
    "#include <emissivemap_fragment>",
    `if (uSceneHasEmissive != 0u && uSceneHasBase != 0u) {
      totalEmissiveRadiance *= sceneSampleBase(vSceneUv, true).rgb;
    }`,
  );
  shader.fragmentShader = replaceShaderChunk(
    shader.fragmentShader,
    "#include <normal_fragment_maps>",
    `#include <normal_fragment_maps>
    if (uSceneHasBump != 0u) {
      float sceneHeight = sceneSampleBump(vSceneUv).r;
      vec2 sceneHeightGradient = vec2(dFdx(sceneHeight), dFdy(sceneHeight)) * uSceneBumpScale;
      normal = scenePerturbNormalArb(
        -vViewPosition,
        normal,
        sceneHeightGradient,
        faceDirection
      );
    }`,
  );
}

function bindPackedStreamUniforms(shader, role, resource) {
  shader.uniforms[`uScene${role}Stream`] = { value: resource.texture };
  shader.uniforms[`uScene${role}Info`] = { value: resource.info };
}

function replaceShaderChunk(source, search, replacement) {
  if (!source.includes(search)) throw new Error(`Three.js shader chunk is missing: ${search}`);
  return source.replace(search, replacement);
}

function getEmptyPackedResource() {
  if (emptyPackedResource) return emptyPackedResource;
  emptyPackedResource = createPackedTexture({
    codec: "fallback",
    payload: new Uint8Array(4),
    info: new Uint32Array(20),
    dataBytes: 4,
  });
  return emptyPackedResource;
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
    disposeTextureResource(resource.color);
    disposeTextureResource(resource.alpha);
  }
}

function disposeTextureResource(resource) {
  if (resource?.isTexture) {
    resource.dispose();
  } else {
    resource?.texture?.dispose();
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

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
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
