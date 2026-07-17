(function (root) {
  "use strict";

  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 32;
  const ZOOM_FACTOR = 1.25;
  const VIEWPORT_PADDING = 28;
  const DRAG_THRESHOLD = 5;
  const DRAG_DELAY_MS = 140;
  const DIFFERENCE_SCALE = 4;

  class CodecComparisonView {
    constructor(elements, options = {}) {
      this.elements = elements;
      this.onSelect = typeof options.onSelect === "function" ? options.onSelect : () => {};
      this.imageWidth = 0;
      this.imageHeight = 0;
      this.hasResult = false;
      this.zoom = 1;
      this.viewMode = "fit";
      this.synchronizingScroll = false;
      this.viewportDrag = null;
      this.touches = new Map();
      this.pinch = null;
      this.selectedX = 0;
      this.selectedY = 0;
      this.sourceImageData = null;
      this.resultImageData = null;
      this.differenceDirty = false;
      this.overlayRenderer = null;
      this.listeners = [];

      this.bindEvents();
      this.updateImageRendering();
      this.setControlsEnabled(false);
    }

    bindEvents() {
      const { sourceViewport, resultViewport, zoomOut, zoomIn, actualSize, fitImage, smoothScaling, differenceToggle } = this.elements;

      this.listen(zoomOut, "click", () => this.setZoom(this.zoom / ZOOM_FACTOR));
      this.listen(zoomIn, "click", () => this.setZoom(this.zoom * ZOOM_FACTOR));
      this.listen(actualSize, "click", () => this.showActualSize());
      this.listen(fitImage, "click", () => this.fit());
      this.listen(smoothScaling, "change", () => this.updateImageRendering());
      if (differenceToggle) this.listen(differenceToggle, "change", () => this.updateDifferenceVisibility());
      this.listen(sourceViewport, "scroll", () => this.synchronizeScroll(sourceViewport, resultViewport), { passive: true });
      this.listen(resultViewport, "scroll", () => this.synchronizeScroll(resultViewport, sourceViewport), { passive: true });

      for (const viewport of [sourceViewport, resultViewport]) {
        this.listen(viewport, "wheel", (event) => this.zoomFromWheel(event), { passive: false });
        this.listen(viewport, "pointerdown", (event) => this.startPointer(event));
        this.listen(viewport, "pointermove", (event) => this.movePointer(event));
        this.listen(viewport, "pointerup", (event) => this.finishPointer(event));
        this.listen(viewport, "pointercancel", (event) => this.finishPointer(event));
        this.listen(viewport, "lostpointercapture", (event) => this.finishPointer(event));
      }

      this.listen(root, "resize", () => this.handleResize());
    }

    listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      this.listeners.push(() => target.removeEventListener(type, listener, options));
    }

    setSource(imageData) {
      this.sourceImageData = imageData;
      this.imageWidth = imageData.width;
      this.imageHeight = imageData.height;
      this.drawImageData(this.elements.sourceCanvas, imageData);
      this.resizeCanvas(this.elements.resultCanvas, imageData.width, imageData.height);
      if (this.elements.differenceCanvas) this.resizeCanvas(this.elements.differenceCanvas, imageData.width, imageData.height);
      this.resizeCanvas(this.elements.overlayCanvas, imageData.width, imageData.height);
      this.hasResult = false;
      this.selectedX = 0;
      this.selectedY = 0;
      this.setControlsEnabled(true);
      this.clearResult();
      root.requestAnimationFrame(() => this.fit());
    }

    setResult(imageData) {
      if (imageData.width !== this.imageWidth || imageData.height !== this.imageHeight) {
        throw new RangeError("Comparison images must have the same dimensions");
      }

      this.drawImageData(this.elements.resultCanvas, imageData);
      this.resultImageData = imageData;
      this.differenceDirty = true;
      this.hasResult = true;
      if (this.elements.differenceToggle) this.elements.differenceToggle.disabled = false;
      this.updateDifferenceVisibility();
      this.drawOverlay();
    }

    clearResult() {
      const context = this.elements.resultCanvas.getContext("2d");
      context.clearRect(0, 0, this.elements.resultCanvas.width, this.elements.resultCanvas.height);
      if (this.elements.differenceCanvas) {
        const differenceContext = this.elements.differenceCanvas.getContext("2d");
        differenceContext.clearRect(0, 0, this.elements.differenceCanvas.width, this.elements.differenceCanvas.height);
        this.elements.differenceCanvas.hidden = true;
      }
      this.resultImageData = null;
      this.differenceDirty = false;
      this.hasResult = false;
      if (this.elements.differenceToggle) this.elements.differenceToggle.disabled = true;
      this.drawOverlay();
    }

    updateDifferenceVisibility() {
      if (!this.elements.differenceCanvas) return;
      const showDifference = this.hasResult && Boolean(this.elements.differenceToggle?.checked);
      if (showDifference && this.differenceDirty && this.sourceImageData && this.resultImageData) {
        this.drawImageData(
          this.elements.differenceCanvas,
          createDifferenceImageData(this.sourceImageData, this.resultImageData)
        );
        this.differenceDirty = false;
      }
      this.elements.differenceCanvas.hidden = !showDifference;
    }

    setOverlayRenderer(renderer) {
      this.overlayRenderer = typeof renderer === "function" ? renderer : null;
      this.drawOverlay();
    }

    setSelectedPixel(x, y, notify = false) {
      if (!this.imageWidth || !this.imageHeight) return;

      this.selectedX = clamp(Math.trunc(x), 0, this.imageWidth - 1);
      this.selectedY = clamp(Math.trunc(y), 0, this.imageHeight - 1);
      this.drawOverlay();

      if (notify) {
        this.onSelect(this.selectedX, this.selectedY);
      }
    }

    drawOverlay() {
      const canvas = this.elements.overlayCanvas;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);

      if (this.hasResult && this.overlayRenderer) {
        this.overlayRenderer(context, {
          width: this.imageWidth,
          height: this.imageHeight,
          selectedX: this.selectedX,
          selectedY: this.selectedY,
        });
      }
    }

    fit() {
      if (!this.imageWidth || !this.imageHeight) return;

      const { sourceViewport, resultViewport } = this.elements;
      const availableWidth = Math.max(1, Math.min(sourceViewport.clientWidth, resultViewport.clientWidth) - VIEWPORT_PADDING);
      const availableHeight = Math.max(1, Math.min(sourceViewport.clientHeight, resultViewport.clientHeight) - VIEWPORT_PADDING);
      this.setViewMode("fit");
      this.setZoom(Math.min(availableWidth / this.imageWidth, availableHeight / this.imageHeight), resultViewport, undefined, undefined, true);
    }

    showActualSize() {
      if (!this.imageWidth || !this.imageHeight) return;
      this.setViewMode("actual");
      this.setZoom(1, this.elements.resultViewport, undefined, undefined, true);
    }

    setViewMode(mode) {
      this.viewMode = mode;
      this.elements.fitImage.setAttribute("aria-pressed", String(mode === "fit"));
      this.elements.actualSize.setAttribute("aria-pressed", String(mode === "actual"));
    }

    setZoom(value, viewport = this.elements.resultViewport, clientX, clientY, forceCenter = false, fixedImagePoint) {
      if (!this.imageWidth || !this.imageHeight) return;

      const nextZoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
      const stage = this.stageForViewport(viewport);
      let anchorClientX = clientX;
      let anchorClientY = clientY;
      let imagePoint = fixedImagePoint;

      if (!forceCenter) {
        const viewportBounds = viewport.getBoundingClientRect();
        anchorClientX = clientX === undefined ? viewportBounds.left + viewport.clientWidth / 2 : clientX;
        anchorClientY = clientY === undefined ? viewportBounds.top + viewport.clientHeight / 2 : clientY;

        if (!imagePoint) {
          const stageBounds = stage.getBoundingClientRect();
          imagePoint = {
            x: (anchorClientX - stageBounds.left) / this.zoom,
            y: (anchorClientY - stageBounds.top) / this.zoom,
          };
        }
      }

      this.zoom = nextZoom;
      this.applyDisplaySize();

      if (forceCenter) {
        this.centerViewports();
        return;
      }

      this.setViewMode("custom");
      const updatedStageBounds = stage.getBoundingClientRect();
      viewport.scrollLeft += updatedStageBounds.left + imagePoint.x * nextZoom - anchorClientX;
      viewport.scrollTop += updatedStageBounds.top + imagePoint.y * nextZoom - anchorClientY;
      this.synchronizingScroll = false;
      this.synchronizeScroll(viewport, viewport === this.elements.sourceViewport
        ? this.elements.resultViewport : this.elements.sourceViewport);
    }

    applyDisplaySize() {
      const displayWidth = `${this.imageWidth * this.zoom}px`;
      const displayHeight = `${this.imageHeight * this.zoom}px`;

      for (const stage of [this.elements.sourceStage, this.elements.resultStage]) {
        stage.style.width = displayWidth;
        stage.style.height = displayHeight;
      }

      this.elements.zoomLevel.value = `${formatZoom(this.zoom)}%`;
      this.elements.zoomOut.disabled = this.zoom <= MIN_ZOOM;
      this.elements.zoomIn.disabled = this.zoom >= MAX_ZOOM;
    }

    updateImageRendering() {
      const pixelated = !this.elements.smoothScaling.checked;
      this.elements.sourceStage.classList.toggle("is-pixelated", pixelated);
      this.elements.resultStage.classList.toggle("is-pixelated", pixelated);
    }

    setControlsEnabled(enabled) {
      this.elements.actualSize.disabled = !enabled;
      this.elements.fitImage.disabled = !enabled;
      this.elements.zoomOut.disabled = !enabled;
      this.elements.zoomIn.disabled = !enabled;
      if (this.elements.differenceToggle) this.elements.differenceToggle.disabled = !this.hasResult;
    }

    synchronizeScroll(source, target) {
      if (this.synchronizingScroll) return;

      this.synchronizingScroll = true;
      const sourceRangeX = Math.max(0, source.scrollWidth - source.clientWidth);
      const sourceRangeY = Math.max(0, source.scrollHeight - source.clientHeight);
      const targetRangeX = Math.max(0, target.scrollWidth - target.clientWidth);
      const targetRangeY = Math.max(0, target.scrollHeight - target.clientHeight);
      target.scrollLeft = sourceRangeX > 0 ? source.scrollLeft / sourceRangeX * targetRangeX : 0;
      target.scrollTop = sourceRangeY > 0 ? source.scrollTop / sourceRangeY * targetRangeY : 0;
      root.requestAnimationFrame(() => {
        this.synchronizingScroll = false;
      });
    }

    centerViewports() {
      this.synchronizingScroll = true;

      for (const viewport of [this.elements.sourceViewport, this.elements.resultViewport]) {
        viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
        viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
      }

      root.requestAnimationFrame(() => {
        this.synchronizingScroll = false;
      });
    }

    startPointer(event) {
      if (event.pointerType === "touch") {
        this.startTouch(event);
      } else {
        this.startDrag(event);
      }
    }

    movePointer(event) {
      if (this.touches.has(event.pointerId)) {
        this.moveTouch(event);
      } else {
        this.moveDrag(event);
      }
    }

    finishPointer(event) {
      if (this.touches.has(event.pointerId)) {
        this.finishTouch(event);
      } else {
        this.finishDrag(event);
      }
    }

    startTouch(event) {
      if (!this.imageWidth || !this.imageHeight) return;

      const viewport = event.currentTarget;
      const [activeTouch] = this.touches.values();

      if ((activeTouch && activeTouch.viewport !== viewport) || this.touches.size >= 2) {
        event.preventDefault();
        return;
      }

      this.touches.set(event.pointerId, {
        id: event.pointerId,
        viewport,
        x: event.clientX,
        y: event.clientY,
      });

      if (this.touches.size === 1) {
        this.startDrag(event);
      } else {
        capturePointer(viewport, event.pointerId);
        this.startPinch(viewport);
      }

      event.preventDefault();
    }

    moveTouch(event) {
      const touch = this.touches.get(event.pointerId);
      touch.x = event.clientX;
      touch.y = event.clientY;

      if (this.pinch && this.pinch.viewport === event.currentTarget && this.touches.size === 2) {
        const [first, second] = this.touches.values();
        const distance = Math.max(1, touchDistance(first, second));
        const center = touchCenter(first, second);
        this.setZoom(this.pinch.startZoom * distance / this.pinch.startDistance, this.pinch.viewport, center.x, center.y, false, {
          x: this.pinch.imageX,
          y: this.pinch.imageY,
        });
      } else {
        this.moveDrag(event);
      }

      event.preventDefault();
    }

    startPinch(viewport) {
      const [first, second] = this.touches.values();
      const center = touchCenter(first, second);
      const stageBounds = this.stageForViewport(viewport).getBoundingClientRect();

      this.viewportDrag = null;
      this.pinch = {
        viewport,
        startDistance: Math.max(1, touchDistance(first, second)),
        startZoom: this.zoom,
        imageX: (center.x - stageBounds.left) / this.zoom,
        imageY: (center.y - stageBounds.top) / this.zoom,
      };
      viewport.classList.add("is-dragging");
    }

    finishTouch(event) {
      const touch = this.touches.get(event.pointerId);
      if (!touch) return;

      const viewport = touch.viewport;
      this.touches.delete(event.pointerId);

      if (this.pinch && this.pinch.viewport === viewport) {
        this.pinch = null;
        this.viewportDrag = null;
        viewport.classList.remove("is-dragging");

        if (this.touches.size === 1) {
          const [remaining] = this.touches.values();
          this.beginDrag(viewport, remaining.id, remaining.x, remaining.y, event.timeStamp - DRAG_DELAY_MS);
        }
      } else {
        this.finishDrag(event);
      }

      releasePointer(viewport, event);
    }

    startDrag(event) {
      if (event.button !== 0 || !this.imageWidth || !this.imageHeight) return;

      const viewport = event.currentTarget;
      this.beginDrag(viewport, event.pointerId, event.clientX, event.clientY, event.timeStamp);
      capturePointer(viewport, event.pointerId);
    }

    beginDrag(viewport, pointerId, startX, startY, startedAt) {
      this.viewportDrag = {
        viewport,
        pointerId,
        startX,
        startY,
        startedAt,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        active: false,
        moved: false,
        selectOnRelease: viewport === this.elements.resultViewport && this.isInsideResult(startX, startY),
      };
    }

    moveDrag(event) {
      const drag = this.viewportDrag;
      if (!drag || drag.viewport !== event.currentTarget || drag.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      const distance = Math.hypot(deltaX, deltaY);

      if (!drag.active) {
        if (event.timeStamp - drag.startedAt < DRAG_DELAY_MS || distance < DRAG_THRESHOLD) return;
        drag.active = true;
        drag.viewport.classList.add("is-dragging");
      }

      drag.moved = true;
      drag.viewport.scrollLeft = drag.scrollLeft - deltaX;
      drag.viewport.scrollTop = drag.scrollTop - deltaY;
      this.synchronizingScroll = false;
      this.synchronizeScroll(drag.viewport, drag.viewport === this.elements.sourceViewport
        ? this.elements.resultViewport : this.elements.sourceViewport);
      event.preventDefault();
    }

    finishDrag(event) {
      const drag = this.viewportDrag;
      if (!drag || drag.viewport !== event.currentTarget || drag.pointerId !== event.pointerId) return;

      this.viewportDrag = null;
      drag.viewport.classList.remove("is-dragging");

      if (!drag.moved && drag.selectOnRelease && this.hasResult && this.isInsideResult(event.clientX, event.clientY)) {
        const bounds = this.elements.resultCanvas.getBoundingClientRect();
        this.setSelectedPixel(
          (event.clientX - bounds.left) * this.imageWidth / bounds.width,
          (event.clientY - bounds.top) * this.imageHeight / bounds.height,
          true
        );
      }

      releasePointer(drag.viewport, event);
    }

    zoomFromWheel(event) {
      if (!event.ctrlKey || !this.imageWidth || !this.imageHeight) return;

      event.preventDefault();
      const viewport = event.currentTarget;
      const pixelDelta = event.deltaMode === root.WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === root.WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * viewport.clientHeight
          : event.deltaY;
      const nextZoom = clamp(this.zoom * Math.exp(-pixelDelta * 0.002), MIN_ZOOM, MAX_ZOOM);

      if (Math.abs(nextZoom - this.zoom) >= 0.0001) {
        this.setZoom(nextZoom, viewport, event.clientX, event.clientY);
      }
    }

    isInsideResult(clientX, clientY) {
      const bounds = this.elements.resultCanvas.getBoundingClientRect();
      return clientX >= bounds.left && clientX < bounds.right && clientY >= bounds.top && clientY < bounds.bottom;
    }

    stageForViewport(viewport) {
      return viewport === this.elements.sourceViewport ? this.elements.sourceStage : this.elements.resultStage;
    }

    handleResize() {
      if (this.viewMode === "fit") this.fit();
      else if (this.viewMode === "actual") this.showActualSize();
      else this.setZoom(this.zoom);
    }

    resizeCanvas(canvas, width, height) {
      canvas.width = width;
      canvas.height = height;
      return canvas.getContext("2d");
    }

    drawImageData(canvas, imageData) {
      this.resizeCanvas(canvas, imageData.width, imageData.height).putImageData(imageData, 0, 0);
    }

    destroy() {
      for (const remove of this.listeners.splice(0)) remove();
      this.touches.clear();
      this.viewportDrag = null;
      this.pinch = null;
    }
  }

  function capturePointer(viewport, pointerId) {
    try {
      viewport.setPointerCapture(pointerId);
    } catch (_error) {
      // Synthetic events and older browsers may not provide pointer capture.
    }
  }

  function createDifferenceImageData(source, result) {
    const difference = new Uint8ClampedArray(source.data.length);
    for (let offset = 0; offset < difference.length; offset += 4) {
      difference[offset] = Math.min(255, Math.abs(source.data[offset] - result.data[offset]) * DIFFERENCE_SCALE);
      difference[offset + 1] = Math.min(255, Math.abs(source.data[offset + 1] - result.data[offset + 1]) * DIFFERENCE_SCALE);
      difference[offset + 2] = Math.min(255, Math.abs(source.data[offset + 2] - result.data[offset + 2]) * DIFFERENCE_SCALE);
      difference[offset + 3] = 255;
    }
    return new ImageData(difference, source.width, source.height);
  }

  function releasePointer(viewport, event) {
    if (event.type !== "lostpointercapture" && viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  }

  function touchDistance(first, second) {
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function touchCenter(first, second) {
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function formatZoom(value) {
    const percent = value * 100;
    return percent < 10 ? percent.toFixed(1) : String(Math.round(percent));
  }

  root.CodecComparisonView = CodecComparisonView;
})(typeof self !== "undefined" ? self : globalThis);
