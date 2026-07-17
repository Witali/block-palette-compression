"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(read("app.webmanifest"));
const serviceWorker = read("service-worker.js");
const registration = read("src/pwa/register-service-worker.js");
const viewerSource = read("src/pages/bpal-viewer-page.js");
const testCases = [];
const htmlPages = [
  "index.html",
  "block-palette.html",
  "dct-compression.html",
  "bpdh.html",
  "codec-lab.html",
  "bpal-viewer.html",
  "cube.html",
  "cube-bpal-sampler.html",
];

test("defines a subpath-safe installable web app manifest", () => {
  assert.equal(manifest.name, "Block Palette Compression");
  assert.equal(manifest.short_name, "BPAL");
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#101318");
  assert.equal(manifest.background_color, "#101318");

  const iconSizes = new Set(manifest.icons.map((icon) => icon.sizes));

  assert.ok(iconSizes.has("192x192"));
  assert.ok(iconSizes.has("512x512"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
});

test("provides valid PNG application icons", () => {
  assertPngDimensions("assets/icons/app-icon-192.png", 192, 192);
  assertPngDimensions("assets/icons/app-icon-512.png", 512, 512);
  assertPngDimensions("assets/icons/app-icon-maskable-512.png", 512, 512);
});

test("connects every application page to the PWA", () => {
  for (const page of htmlPages) {
    const html = read(page);

    assert.match(html, /<meta name="theme-color" content="#101318">/);
    assert.match(html, /<link rel="manifest" href="\.\/app\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\.\/assets\/icons\/app-icon-192\.png">/);
    assert.match(html, /<script src="\.\/src\/pwa\/register-service-worker\.js\?v=1"><\/script>/);
  }
});

test("registers the root service worker without breaking project-page paths", () => {
  assert.match(registration, /navigator\.serviceWorker\.register\("\.\/service-worker\.js"/);
  assert.match(registration, /updateViaCache: "none"/);
});

test("associates installed desktop PWAs with BPAL, BPLM, and BPDH files", () => {
  assert.deepEqual(manifest.file_handlers, [
    {
      action: "./bpal-viewer.html",
      accept: {
        "application/octet-stream": [".bpal", ".bplm", ".bpdh"],
      },
    },
  ]);
  assert.match(viewerSource, /window\.launchQueue\.setConsumer/);
  assert.match(viewerSource, /const file = await fileHandle\.getFile\(\)/);
  assert.match(viewerSource, /await loadFile\(file\)/);
  assert.match(viewerSource, /catalogLoadId !== state\.loadId/);
});

test("registers an Android Web Share Target for BPAL, BPLM, and BPDH files", () => {
  assert.deepEqual(manifest.share_target, {
    action: "./share-target",
    method: "POST",
    enctype: "multipart/form-data",
    params: {
      files: [
        {
          name: "bpal_file",
          accept: ["application/octet-stream", ".bpal", ".bplm", ".bpdh"],
        },
      ],
    },
  });
  assert.match(serviceWorker, /request\.method === "POST"/);
  assert.match(serviceWorker, /formData\.getAll\("bpal_file"\)/);
  assert.match(serviceWorker, /Response\.redirect\(viewerUrl\.href, 303\)/);
  assert.match(viewerSource, /window\.caches\.open\(SHARED_FILE_CACHE\)/);
  assert.match(viewerSource, /await cache\.delete\(sharedFileUrl\.href\)/);
  assert.match(viewerSource, /await loadFile\(new File\(\[blob\], fileName/);
});

test("stores an Android shared file and redirects it to Image Viewer", async () => {
  const harness = createServiceWorkerHarness();
  const formData = new FormData();
  const sourceBytes = Buffer.from([0x42, 0x50, 0x41, 0x4c, 0x05, 0x00]);

  formData.append("bpal_file", new File([sourceBytes], "phone sample.bpal", {
    type: "application/octet-stream",
  }));

  const response = await dispatchFetch(harness.listeners.fetch, new Request(
    "https://example.test/block-palette-compression/share-target",
    { method: "POST", body: formData }
  ));
  const redirectUrl = new URL(response.headers.get("location"));
  const shareId = redirectUrl.searchParams.get("shared");

  assert.equal(response.status, 303);
  assert.equal(redirectUrl.pathname, "/block-palette-compression/bpal-viewer.html");
  assert.match(shareId, /^[0-9a-f-]{36}$/i);

  const sharedCache = harness.cacheStores.get("bpal-shared-files-v1");
  const storedResponse = sharedCache.get(
    `https://example.test/block-palette-compression/shared-files/${shareId}`
  );

  assert.ok(storedResponse);
  assert.equal(
    decodeURIComponent(storedResponse.headers.get("X-BPAL-File-Name")),
    "phone sample.bpal"
  );
  assert.deepEqual(Buffer.from(await storedResponse.arrayBuffer()), sourceBytes);
});

test("uses network-first navigations and runtime caching for large assets", () => {
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /networkFirst\(request\)/);
  assert.match(serviceWorker, /cacheWhileRevalidate\(request, updatePromise\)/);
  assert.match(serviceWorker, /url\.origin !== self\.location\.origin/);
  assert.doesNotMatch(serviceWorker, /"\.\/assets\/bpal\//);
  assert.doesNotMatch(serviceWorker, /"\.\/assets\/benchmark-jpegs\//);
});

test("honors cache-busting queries before using the offline shell fallback", () => {
  const exactLookup = serviceWorker.indexOf("const exactCachedResponse = await caches.match(request)");
  const networkLookup = serviceWorker.indexOf("const networkResponse = await updatePromise");
  const fallbackLookup = serviceWorker.indexOf("return (await matchCachedRequest(request)) || Response.error()");

  assert.ok(exactLookup >= 0);
  assert.ok(networkLookup > exactLookup);
  assert.ok(fallbackLookup > networkLookup);
});

test("serves web manifests with their registered content type locally", () => {
  assert.match(
    read("tools/serve.js"),
    /\["\.webmanifest", "application\/manifest\+json; charset=utf-8"\]/
  );
});

function assertPngDimensions(fileName, expectedWidth, expectedHeight) {
  const bytes = fs.readFileSync(path.join(root, fileName));

  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.readUInt32BE(16), expectedWidth);
  assert.equal(bytes.readUInt32BE(20), expectedHeight);
}

function read(fileName) {
  return fs.readFileSync(path.join(root, fileName), "utf8");
}

function createServiceWorkerHarness() {
  const listeners = {};
  const cacheStores = new Map();
  const cachesMock = {
    async open(cacheName) {
      if (!cacheStores.has(cacheName)) {
        cacheStores.set(cacheName, new Map());
      }

      const entries = cacheStores.get(cacheName);

      return {
        async addAll() {},
        async put(request, response) {
          entries.set(requestUrl(request), response.clone());
        },
        async match(request) {
          const response = entries.get(requestUrl(request));

          return response && response.clone();
        },
        async delete(request) {
          return entries.delete(requestUrl(request));
        },
      };
    },
    async keys() {
      return [...cacheStores.keys()];
    },
    async delete(cacheName) {
      return cacheStores.delete(cacheName);
    },
    async match(request) {
      for (const entries of cacheStores.values()) {
        const response = entries.get(requestUrl(request));

        if (response) {
          return response.clone();
        }
      }

      return undefined;
    },
  };
  const serviceWorkerGlobal = {
    location: { origin: "https://example.test" },
    registration: { scope: "https://example.test/block-palette-compression/" },
    crypto,
    clients: { claim: async () => undefined },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };

  vm.runInNewContext(serviceWorker, {
    URL,
    Request,
    Response,
    FormData,
    File,
    Headers,
    caches: cachesMock,
    crypto,
    encodeURIComponent,
    fetch: async () => {
      throw new Error("Unexpected network request");
    },
    console,
    self: serviceWorkerGlobal,
  });

  return { listeners, cacheStores };
}

function requestUrl(request) {
  return typeof request === "string" ? request : request.url;
}

function dispatchFetch(listener, request) {
  let responsePromise = null;

  listener({
    request,
    respondWith(response) {
      responsePromise = Promise.resolve(response);
    },
    waitUntil() {},
  });

  assert.ok(responsePromise, "The service worker did not handle the share request");
  return responsePromise;
}

function test(name, callback) {
  testCases.push({ name, callback });
}

async function runTests() {
  for (const { name, callback } of testCases) {
    try {
      await callback();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      throw error;
    }
  }
}

module.exports = runTests();
