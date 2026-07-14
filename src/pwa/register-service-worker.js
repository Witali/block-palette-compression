(function registerBpalServiceWorker() {
  "use strict";

  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js", {
      updateViaCache: "none",
    }).catch((error) => {
      console.warn("BPAL service worker registration failed.", error);
    });
  });
})();
