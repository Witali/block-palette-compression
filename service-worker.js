"use strict";

const CACHE_VERSION = "v2";
const SHELL_CACHE = `bpal-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `bpal-runtime-${CACHE_VERSION}`;
const CURRENT_CACHES = new Set([SHELL_CACHE, RUNTIME_CACHE]);

// Keep the install small and deterministic. Large images and BPAL/BPLM samples
// are cached by the fetch handler only after the user requests them.
const APP_SHELL = [
  "./",
  "./index.html",
  "./block-palette.html",
  "./bpal-viewer.html",
  "./cube.html",
  "./cube-bpal-sampler.html",
  "./app.webmanifest",
  "./home.css",
  "./block-palette.css",
  "./bpal-viewer.css",
  "./style.css",
  "./bpal-sampler.css",
  "./i18n.css",
  "./assets/icons/app-icon.svg",
  "./assets/icons/app-icon-192.png",
  "./assets/icons/app-icon-512.png",
  "./assets/icons/app-icon-maskable-512.png",
  "./src/core/textured-cube.js",
  "./src/core/textured-cube-webgl2.js",
  "./src/decoders/bpal-texture.js",
  "./src/decoders/gpu-jpeg.js",
  "./src/i18n/en.js",
  "./src/i18n/i18n.js",
  "./src/i18n/ru.js",
  "./src/pages/block-palette-page.js",
  "./src/pages/bpal-example-catalog.js",
  "./src/pages/bpal-viewer-page.js",
  "./src/pages/cube-bpal-sampler-page.js",
  "./src/pages/cube-grid-layout.js",
  "./src/pages/cube-page.js",
  "./src/pages/cube-wheel-zoom.js",
  "./src/palette/block-palette-codec.js",
  "./src/palette/block-palette-format.js",
  "./src/palette/block-palette-optimizer.js",
  "./src/palette/block-palette-optimizer-worker.js",
  "./src/palette/block-palette-webgl-codec.js",
  "./src/palette/block-palette-webgl-worker.js",
  "./src/palette/block-palette-worker.js",
  "./src/palette/bplm-format.js",
  "./src/palette/palette-quantizer.js",
  "./src/pwa/register-service-worker.js",
  "./src/shaders/cube-bpal-sampler.frag.glsl",
  "./src/shaders/cube-webgl2.frag.glsl",
  "./src/shaders/cube-webgl2.vert.glsl",
  "./src/shaders/cube.frag.glsl",
  "./src/shaders/cube.vert.glsl",
  "./src/shaders/jpeg-idct.frag.glsl",
  "./src/shaders/jpeg-idct.vert.glsl"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith("bpal-") && !CURRENT_CACHES.has(cacheName))
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  const updatePromise = fetchAndCache(request);

  event.waitUntil(updatePromise.then(() => undefined));
  event.respondWith(cacheWhileRevalidate(request, updatePromise));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);

    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);

      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    return (await matchCachedRequest(request)) || caches.match("./index.html");
  }
}

async function cacheWhileRevalidate(request, updatePromise) {
  const exactCachedResponse = await caches.match(request);

  if (exactCachedResponse) {
    return exactCachedResponse;
  }

  const networkResponse = await updatePromise;

  if (networkResponse) {
    return networkResponse;
  }

  return (await matchCachedRequest(request)) || Response.error();
}

async function fetchAndCache(request) {
  try {
    const response = await fetch(request);

    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);

      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    return null;
  }
}

async function matchCachedRequest(request) {
  const exactMatch = await caches.match(request);

  if (exactMatch) {
    return exactMatch;
  }

  const url = new URL(request.url);

  if (!url.search) {
    return null;
  }

  url.search = "";
  return caches.match(url.href);
}
