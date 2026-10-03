// 右側畫布：繪製、縮放、平移、互動、overlay。
// canvas 填滿 #stage，依 devicePixelRatio 畫清晰；透明區域畫棋盤格；
// 滾輪以游標為中心縮放（0.05x～32x）；空白鍵按住拖曳平移（cursor: grab）；雙擊空白處或 fit() = 適合畫面。
import { drawCheckerboard } from './canvasUtil.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 32;

export function createViewport({ stageWrapEl, canvasEl, doc, bus }) {
  const ctx2d = canvasEl.getContext('2d');

  let scale = 1;
  let offsetX = 0; // 影像左上角在 stage CSS 座標系中的位置
  let offsetY = 0;
  let overlayFn = null;
  let interactionHandler = null;
  let previewCanvas = null; // 非 null 時優先顯示（不入歷史）
  let spaceHeld = false;
  let isPanning = false;
  let panStart = null; // {x, y, offsetX, offsetY}
  let renderQueued = false;
  let cssWidth = 0;
  let cssHeight = 0;

  function currentImage() {
    return previewCanvas || (doc.hasImage() ? doc.getImage() : null);
  }

  function resizeCanvasToStage() {
    const rect = stageWrapEl.getBoundingClientRect();
    cssWidth = rect.width;
    cssHeight = rect.height;
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.max(1, Math.round(cssWidth * dpr));
    const pixelH = Math.max(1, Math.round(cssHeight * dpr));
    if (canvasEl.width !== pixelW || canvasEl.height !== pixelH) {
      canvasEl.width = pixelW;
      canvasEl.height = pixelH;
    }
  }

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    resizeCanvasToStage();
    const dpr = window.devicePixelRatio || 1;
    ctx2d.save();
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, cssWidth, cssHeight);

    const img = currentImage();
    if (img) {
      const w = img.width * scale;
      const h = img.height * scale;
      drawCheckerboard(ctx2d, offsetX, offsetY, w, h, 10);
      ctx2d.imageSmoothingEnabled = scale < 1;
      ctx2d.drawImage(img, offsetX, offsetY, w, h);
    }

    if (overlayFn) {
      const view = { scale, offsetX, offsetY, imageToScreen };
      try {
        overlayFn(ctx2d, view);
      } catch (err) {
        console.error('[viewport] overlay 繪製失敗', err);
      }
    }
    ctx2d.restore();
  }

  function screenToImage(clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    return {
      x: (cssX - offsetX) / scale,
      y: (cssY - offsetY) / scale,
    };
  }

  function imageToScreen(x, y) {
    return {
      x: offsetX + x * scale,
      y: offsetY + y * scale,
    };
  }

  function getScale() {
    return scale;
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  function setScaleAtPoint(newScale, cssX, cssY) {
    const clamped = clampScale(newScale);
    // 保持游標下的影像座標不變
    const imgX = (cssX - offsetX) / scale;
    const imgY = (cssY - offsetY) / scale;
    scale = clamped;
    offsetX = cssX - imgX * scale;
    offsetY = cssY - imgY * scale;
    bus.emit('viewport:zoom', { scale });
    requestRender();
  }

  function fit() {
    const img = currentImage();
    if (!img) return;
    resizeCanvasToStage();
    const pad = 24;
    const availW = Math.max(10, cssWidth - pad * 2);
    const availH = Math.max(10, cssHeight - pad * 2);
    const s = clampScale(Math.min(availW / img.width, availH / img.height));
    scale = s;
    offsetX = (cssWidth - img.width * s) / 2;
    offsetY = (cssHeight - img.height * s) / 2;
    bus.emit('viewport:zoom', { scale });
    requestRender();
  }

  function setOverlay(fn) {
    overlayFn = fn || null;
    requestRender();
  }

  function setInteraction(handler) {
    interactionHandler = handler || null;
    updateCursor();
  }

  function preview(canvasOrNull) {
    previewCanvas = canvasOrNull || null;
    requestRender();
  }

  function getPreview() {
    return previewCanvas;
  }

  function updateCursor() {
    if (spaceHeld || isPanning) {
      canvasEl.style.cursor = isPanning ? 'grabbing' : 'grab';
    } else if (interactionHandler && interactionHandler.cursor) {
      canvasEl.style.cursor = interactionHandler.cursor;
    } else {
      canvasEl.style.cursor = 'default';
    }
  }

  // ---------- 事件綁定 ----------
  function onWheel(e) {
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const factor = Math.pow(1.0015, -e.deltaY);
    setScaleAtPoint(scale * factor, cssX, cssY);
  }

  function onPointerDown(e) {
    canvasEl.setPointerCapture(e.pointerId);
    if (spaceHeld) {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY, offsetX, offsetY };
      updateCursor();
      return;
    }
    if (interactionHandler && interactionHandler.onPointerDown) {
      const p = screenToImage(e.clientX, e.clientY);
      interactionHandler.onPointerDown(e, p);
    }
  }

  function onPointerMove(e) {
    if (isPanning && panStart) {
      offsetX = panStart.offsetX + (e.clientX - panStart.x);
      offsetY = panStart.offsetY + (e.clientY - panStart.y);
      requestRender();
      return;
    }
    if (interactionHandler && interactionHandler.onPointerMove) {
      const p = screenToImage(e.clientX, e.clientY);
      interactionHandler.onPointerMove(e, p);
    }
  }

  function onPointerUp(e) {
    try {
      canvasEl.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (isPanning) {
      isPanning = false;
      panStart = null;
      updateCursor();
      return;
    }
    if (interactionHandler && interactionHandler.onPointerUp) {
      const p = screenToImage(e.clientX, e.clientY);
      interactionHandler.onPointerUp(e, p);
    }
  }

  function onDblClick(e) {
    if (interactionHandler && interactionHandler.onDblClick) {
      const p = screenToImage(e.clientX, e.clientY);
      const handled = interactionHandler.onDblClick(e, p);
      if (handled) return;
    }
    fit();
  }

  function onKeyDown(e) {
    if (e.code !== 'Space') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!spaceHeld) {
      spaceHeld = true;
      updateCursor();
    }
    e.preventDefault();
  }

  function onKeyUp(e) {
    if (e.code !== 'Space') return;
    spaceHeld = false;
    isPanning = false;
    panStart = null;
    updateCursor();
  }

  canvasEl.addEventListener('wheel', onWheel, { passive: false });
  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);
  canvasEl.addEventListener('dblclick', onDblClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', requestRender);

  bus.on('doc:change', requestRender);
  bus.on('doc:load', fit);

  return {
    requestRender,
    screenToImage,
    imageToScreen,
    getScale,
    setOverlay,
    setInteraction,
    preview,
    getPreview,
    fit,
  };
}
