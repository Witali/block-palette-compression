"use strict";

const CACHE_VERSION = "v7";
const SHELL_CACHE = `bpal-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `bpal-runtime-${CACHE_VERSION}`;
const SHARED_FILE_CACHE = "bpal-shared-files-v1";
const CURRENT_CACHES = new Set([SHELL_CACHE, RUNTIME_CACHE, SHARED_FILE_CACHE]);
const SHARE_TARGET_URL = new URL("./share-target", self.registration.scope);
const SHARED_FILE_DIRECTORY_URL = new URL("./shared-files/", self.registration.scope);

// Keep the install small and deterministic. Large images and BPAL/BPLM/BPDH samples
// are cached by the fetch handler only after the user requests them.
const APP_SHELL = [
  "./",
  "./index.html",
  "./block-palette.html",
  "./bpdh.html",
  "./bpal-viewer.html",
  "./cube.html",
  "./cube-bpal-sampler.html",
  "./app.webmanifest",
  "./home.css",
  "./block-palette.css",
  "./bpdh.css",
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
  "./src/hybrid/dct420.js",
  "./src/hybrid/bpdh-format.js",
  "./src/hybrid/bpdh-codec.js",
  "./src/hybrid/bpdh-worker.js",
  "./src/pages/block-palette-page.js",
  "./src/pages/bpdh-page.js",
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

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.method === "POST" && url.pathname === SHARE_TARGET_URL.pathname) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  if (request.method !== "GET") {
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

async function handleShareTarget(request) {
  const viewerUrl = new URL("./bpal-viewer.html", self.registration.scope);

  try {
    const formData = await request.formData();
    const sharedFile = formData.getAll("bpal_file").find(
      (value) => value && typeof value.arrayBuffer === "function"
    );

    if (!sharedFile) {
      throw new TypeError("The share request does not contain a file");
    }

    const shareId = self.crypto.randomUUID();
    const sharedFileUrl = new URL(shareId, SHARED_FILE_DIRECTORY_URL);
    const cache = await caches.open(SHARED_FILE_CACHE);

    await cache.put(sharedFileUrl.href, new Response(sharedFile, {
      headers: {
        "Content-Type": sharedFile.type || "application/octet-stream",
        "X-BPAL-File-Name": encodeURIComponent(sharedFile.name || "shared.bpal"),
      },
    }));

    viewerUrl.searchParams.set("shared", shareId);
  } catch (error) {
    console.error("Could not receive a file from the Web Share Target.", error);
    viewerUrl.searchParams.set("share-error", "invalid-file");
  }

  return Response.redirect(viewerUrl.href, 303);
}

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
