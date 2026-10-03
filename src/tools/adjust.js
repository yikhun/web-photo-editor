// 調整工具：裁剪、常用尺寸、形狀蒙版、旋轉翻轉。四個子功能共用同一塊畫布 overlay/interaction，
// 同一時間只有一種「互動模式」生效（裁剪框 / 形狀預覽 / 旋轉預覽），彼此切換時會互相讓位。
import '../styles/tools-adjust-text.css';
import {
  highQualityResize,
  cropCanvas,
  rotateCanvasFull,
  rotateCanvasCropped,
  rotate90,
  flipCanvas,
  ratioValue,
  maxCenteredRect,
} from './adjust/geometry.js';
import { SHAPE_OPTIONS, applyShapeMask } from './adjust/shapes.js';
import { SIZE_PRESETS } from './adjust/presets.js';

const icon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 7h10M4 12h16M4 17h7" stroke-width="2" stroke-linecap="round"/>
  <circle cx="16" cy="7" r="2" stroke-width="2"/>
  <circle cx="8" cy="17" r="2" stroke-width="2"/>
</svg>`;

const RATIO_OPTIONS = [
  { id: 'free', label: '自由' },
  { id: 'original', label: '原始' },
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '3:4', label: '3:4' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
  { id: '3:2', label: '3:2' },
  { id: '2:3', label: '2:3' },
];

// ---------- 模組狀態（切換工具時視情況保留或重置，見 activate） ----------
let cropRect = null; // {x,y,w,h} 影像像素座標
let cropRatioId = 'free';
let activeRatio = null; // 數值比例，null = 自由
let targetSize = null; // {w,h} 來自常用尺寸/自訂
let cropForImgW = null;
let cropForImgH = null;
let cropDragState = null;

let shapeSelected = null;
let shapeRoundness = 0.15; // 0~0.5，僅圓角矩形使用

let rotateAngle = 0; // -45~45，滑桿即時值
let rotateEdgeMode = 'crop'; // 'crop' | 'keep'

let customSize = { w: 1080, h: 1080, lock: true, ratio: 1 };

let mountedPanelEl = null;

function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function resetCropToFull(ctx) {
  const img = ctx.doc.getImage();
  cropRect = { x: 0, y: 0, w: img.width, h: img.height };
  cropRatioId = 'free';
  activeRatio = null;
  targetSize = null;
  cropForImgW = img.width;
  cropForImgH = img.height;
}

function clearShapePreviewIfAny(ctx) {
  if (shapeSelected != null) {
    shapeSelected = null;
    ctx.preview(null);
  }
}

function clearRotatePreviewIfAny(ctx) {
  if (rotateAngle !== 0) {
    rotateAngle = 0;
    ctx.preview(null);
  }
}

function restoreCropOverlay(ctx) {
  ctx.viewport.setOverlay(drawCropOverlay);
  ctx.viewport.setInteraction({
    cursor: 'crosshair',
    onPointerDown: (e, p) => onCropPointerDown(ctx, e, p),
    onPointerMove: (e, p) => onCropPointerMove(ctx, e, p),
    onPointerUp: () => {
      cropDragState = null;
    },
  });
  ctx.viewport.requestRender();
}

// ---------- 裁剪框：overlay 繪製 ----------
function getHandlePositions(rect) {
  const { x, y, w, h } = rect;
  return {
    nw: { x, y },
    n: { x: x + w / 2, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 },
    se: { x: x + w, y: y + h },
    s: { x: x + w / 2, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: y + h / 2 },
  };
}

function drawCropOverlay(g, view) {
  if (!cropRect) return;
  const tl = view.imageToScreen(cropRect.x, cropRect.y);
  const br = view.imageToScreen(cropRect.x + cropRect.w, cropRect.y + cropRect.h);
  const fullTL = view.imageToScreen(0, 0);
  const fullBR = view.imageToScreen(cropForImgW || 0, cropForImgH || 0);

  g.save();
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.rect(fullTL.x, fullTL.y, fullBR.x - fullTL.x, fullBR.y - fullTL.y);
  g.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  g.fill('evenodd');

  g.strokeStyle = '#ffffff';
  g.lineWidth = 1.5;
  g.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.lineWidth = 1;
  const w = br.x - tl.x;
  const h = br.y - tl.y;
  for (let i = 1; i <= 2; i++) {
    const x = tl.x + (w * i) / 3;
    g.beginPath();
    g.moveTo(x, tl.y);
    g.lineTo(x, br.y);
    g.stroke();
    const y = tl.y + (h * i) / 3;
    g.beginPath();
    g.moveTo(tl.x, y);
    g.lineTo(br.x, y);
    g.stroke();
  }

  const handles = getHandlePositions(cropRect);
  g.fillStyle = '#4f8cff';
  for (const key of Object.keys(handles)) {
    const pt = view.imageToScreen(handles[key].x, handles[key].y);
    g.fillRect(pt.x - 5, pt.y - 5, 10, 10);
  }
  g.restore();
}

function pointInRect(p, rect) {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampRect(rect, imgW, imgH) {
  let { x, y, w, h } = rect;
  w = Math.max(10, Math.min(w, imgW));
  h = Math.max(10, Math.min(h, imgH));
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > imgW) x = imgW - w;
  if (y + h > imgH) y = imgH - h;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  return { x, y, w, h };
}

function resizeFree(startRect, key, dx, dy) {
  let { x, y, w, h } = startRect;
  switch (key) {
    case 'e':
      w += dx;
      break;
    case 'w':
      x += dx;
      w -= dx;
      break;
    case 's':
      h += dy;
      break;
    case 'n':
      y += dy;
      h -= dy;
      break;
    case 'se':
      w += dx;
      h += dy;
      break;
    case 'nw':
      x += dx;
      y += dy;
      w -= dx;
      h -= dy;
      break;
    case 'ne':
      y += dy;
      w += dx;
      h -= dy;
      break;
    case 'sw':
      x += dx;
      w -= dx;
      h += dy;
      break;
    default:
      break;
  }
  return { x, y, w, h };
}

function resizeWithRatio(startRect, key, p, ratio) {
  const right = startRect.x + startRect.w;
  const bottom = startRect.y + startRect.h;
  const cx = startRect.x + startRect.w / 2;
  const cy = startRect.y + startRect.h / 2;
  let newW;
  let newH;
  switch (key) {
    case 'se':
      newW = p.x - startRect.x;
      newH = newW / ratio;
      return { x: startRect.x, y: startRect.y, w: newW, h: newH };
    case 'nw':
      newW = right - p.x;
      newH = newW / ratio;
      return { x: right - newW, y: bottom - newH, w: newW, h: newH };
    case 'ne':
      newW = p.x - startRect.x;
      newH = newW / ratio;
      return { x: startRect.x, y: bottom - newH, w: newW, h: newH };
    case 'sw':
      newW = right - p.x;
      newH = newW / ratio;
      return { x: right - newW, y: startRect.y, w: newW, h: newH };
    case 'e':
      newW = p.x - startRect.x;
      newH = newW / ratio;
      return { x: startRect.x, y: cy - newH / 2, w: newW, h: newH };
    case 'w':
      newW = right - p.x;
      newH = newW / ratio;
      return { x: right - newW, y: cy - newH / 2, w: newW, h: newH };
    case 's':
      newH = p.y - startRect.y;
      newW = newH * ratio;
      return { x: cx - newW / 2, y: startRect.y, w: newW, h: newH };
    case 'n':
      newH = bottom - p.y;
      newW = newH * ratio;
      return { x: cx - newW / 2, y: bottom - newH, w: newW, h: newH };
    default:
      return startRect;
  }
}

function onCropPointerDown(ctx, e, p) {
  if (!cropRect) return;
  const scale = ctx.viewport.getScale();
  const tol = 10 / scale;
  const handles = getHandlePositions(cropRect);
  for (const key of Object.keys(handles)) {
    if (dist(p, handles[key]) <= tol) {
      cropDragState = { mode: key, startP: p, startRect: { ...cropRect } };
      return;
    }
  }
  if (pointInRect(p, cropRect)) {
    cropDragState = { mode: 'move', startP: p, startRect: { ...cropRect } };
  } else {
    cropDragState = null;
  }
}

function onCropPointerMove(ctx, e, p) {
  if (!cropDragState) return;
  const img = ctx.doc.getImage();
  const { mode, startRect, startP } = cropDragState;
  let rect;
  if (mode === 'move') {
    const dx = p.x - startP.x;
    const dy = p.y - startP.y;
    rect = {
      x: clampNum(startRect.x + dx, 0, img.width - startRect.w),
      y: clampNum(startRect.y + dy, 0, img.height - startRect.h),
      w: startRect.w,
      h: startRect.h,
    };
  } else if (activeRatio) {
    rect = resizeWithRatio(startRect, mode, p, activeRatio);
    rect = clampRect(rect, img.width, img.height);
  } else {
    const dx = p.x - startP.x;
    const dy = p.y - startP.y;
    rect = resizeFree(startRect, mode, dx, dy);
    rect = clampRect(rect, img.width, img.height);
  }
  cropRect = rect;
  ctx.viewport.requestRender();
}

// ---------- 比例 / 常用尺寸 / 自訂尺寸 ----------
function applyRatioChoice(id, ctx) {
  clearShapePreviewIfAny(ctx);
  clearRotatePreviewIfAny(ctx);
  const img = ctx.doc.getImage();
  cropRatioId = id;
  const ratio = ratioValue(id, img.width, img.height);
  activeRatio = ratio;
  targetSize = null;
  cropRect = maxCenteredRect(ratio, img.width, img.height);
  ctx.viewport.requestRender();
  mountPanel(ctx);
}

function applyPresetChoice(preset, ctx) {
  clearShapePreviewIfAny(ctx);
  clearRotatePreviewIfAny(ctx);
  const img = ctx.doc.getImage();
  cropRatioId = null;
  const ratio = preset.w / preset.h;
  activeRatio = ratio;
  targetSize = { w: preset.w, h: preset.h };
  cropRect = maxCenteredRect(ratio, img.width, img.height);
  ctx.viewport.requestRender();
  mountPanel(ctx);
}

function applyCustomSizeChoice(ctx) {
  clearShapePreviewIfAny(ctx);
  clearRotatePreviewIfAny(ctx);
  const img = ctx.doc.getImage();
  const ratio = customSize.w / customSize.h;
  cropRatioId = null;
  activeRatio = ratio;
  targetSize = { w: customSize.w, h: customSize.h };
  cropRect = maxCenteredRect(ratio, img.width, img.height);
  ctx.viewport.requestRender();
}

function cropApply(ctx) {
  const img = ctx.doc.getImage();
  let out = cropCanvas(img, cropRect);
  if (targetSize) out = highQualityResize(out, targetSize.w, targetSize.h);
  ctx.commit(out, targetSize ? '裁剪並調整尺寸' : '裁剪');
  resetCropToFull(ctx);
  restoreCropOverlay(ctx);
  mountPanel(ctx);
  ctx.toast('已套用裁剪', 'success');
}

function cropCancel(ctx) {
  resetCropToFull(ctx);
  restoreCropOverlay(ctx);
  mountPanel(ctx);
}

// ---------- 形狀蒙版 ----------
function selectShape(id, ctx) {
  clearRotatePreviewIfAny(ctx);
  shapeSelected = id;
  const img = ctx.doc.getImage();
  const masked = applyShapeMask(img, id, { radius: id === 'roundedRect' ? Math.min(img.width, img.height) * shapeRoundness : undefined });
  ctx.preview(masked);
  ctx.viewport.setOverlay(null);
  ctx.viewport.setInteraction(null);
  ctx.viewport.requestRender();
  mountPanel(ctx);
}

function refreshShapePreview(ctx) {
  if (!shapeSelected) return;
  const img = ctx.doc.getImage();
  const masked = applyShapeMask(img, shapeSelected, {
    radius: shapeSelected === 'roundedRect' ? Math.min(img.width, img.height) * shapeRoundness : undefined,
  });
  ctx.preview(masked);
  ctx.viewport.requestRender();
}

function applyShapeChoice(ctx) {
  if (!shapeSelected) return;
  const img = ctx.doc.getImage();
  const masked = applyShapeMask(img, shapeSelected, {
    radius: shapeSelected === 'roundedRect' ? Math.min(img.width, img.height) * shapeRoundness : undefined,
  });
  ctx.commit(masked, '套用形狀');
  shapeSelected = null;
  ctx.preview(null);
  resetCropToFull(ctx);
  restoreCropOverlay(ctx);
  mountPanel(ctx);
  ctx.toast('已套用形狀蒙版', 'success');
}

// ---------- 旋轉翻轉 ----------
function onAngleInput(v, ctx) {
  clearShapePreviewIfAny(ctx);
  rotateAngle = v;
  if (v === 0) {
    ctx.preview(null);
    restoreCropOverlay(ctx);
    return;
  }
  const img = ctx.doc.getImage();
  const preview = rotateEdgeMode === 'crop' ? rotateCanvasCropped(img, v) : rotateCanvasFull(img, v);
  ctx.preview(preview);
  ctx.viewport.setOverlay(null);
  ctx.viewport.setInteraction(null);
  ctx.viewport.requestRender();
}

function applyRotateSlider(ctx) {
  if (rotateAngle === 0) {
    ctx.toast('角度為 0，無需套用', 'info');
    return;
  }
  const img = ctx.doc.getImage();
  const out = rotateEdgeMode === 'crop' ? rotateCanvasCropped(img, rotateAngle) : rotateCanvasFull(img, rotateAngle);
  ctx.commit(out, '旋轉');
  rotateAngle = 0;
  ctx.preview(null);
  resetCropToFull(ctx);
  restoreCropOverlay(ctx);
  mountPanel(ctx);
  ctx.toast('已套用旋轉', 'success');
}

function quickTransform(kind, ctx) {
  clearShapePreviewIfAny(ctx);
  clearRotatePreviewIfAny(ctx);
  const img = ctx.doc.getImage();
  let out;
  let label;
  if (kind === 'left') {
    out = rotate90(img, 'left');
    label = '向左旋轉';
  } else if (kind === 'right') {
    out = rotate90(img, 'right');
    label = '向右旋轉';
  } else if (kind === 'fliph') {
    out = flipCanvas(img, 'h');
    label = '水平翻轉';
  } else {
    out = flipCanvas(img, 'v');
    label = '垂直翻轉';
  }
  ctx.commit(out, label);
  resetCropToFull(ctx);
  restoreCropOverlay(ctx);
  mountPanel(ctx);
}

// ---------- 面板 ----------
function mountPanel(ctx) {
  const panelEl = mountedPanelEl;
  if (!panelEl) return;
  panelEl.innerHTML = '';

  // 1. 裁剪
  const ratioGroup = ctx.ui.buttonGroup(RATIO_OPTIONS, cropRatioId || '', (id) => applyRatioChoice(id, ctx));
  const cropBtnRow = ctx.ui.el('div', 'adj-grid');
  cropBtnRow.appendChild(ctx.ui.button('套用裁剪', () => cropApply(ctx), { primary: true }));
  cropBtnRow.appendChild(ctx.ui.button('取消', () => cropCancel(ctx)));
  panelEl.appendChild(ctx.ui.section('裁剪', [ratioGroup, cropBtnRow]));

  // 2. 常用尺寸
  const presetGrid = ctx.ui.el('div', 'adj-grid');
  for (const preset of SIZE_PRESETS) {
    presetGrid.appendChild(
      ctx.ui.button(`${preset.label}\n${preset.w}×${preset.h}`, () => applyPresetChoice(preset, ctx)),
    );
  }
  const customRow1 = ctx.ui.el('div', 'adj-size-row');
  const wInput = document.createElement('input');
  wInput.type = 'number';
  wInput.min = '1';
  wInput.value = String(customSize.w);
  const hInput = document.createElement('input');
  hInput.type = 'number';
  hInput.min = '1';
  hInput.value = String(customSize.h);
  wInput.addEventListener('input', () => {
    const v = Math.max(1, Math.round(Number(wInput.value) || 1));
    customSize.w = v;
    if (customSize.lock) {
      customSize.h = Math.max(1, Math.round(v / customSize.ratio));
      hInput.value = String(customSize.h);
    }
    applyCustomSizeChoice(ctx);
  });
  hInput.addEventListener('input', () => {
    const v = Math.max(1, Math.round(Number(hInput.value) || 1));
    customSize.h = v;
    if (customSize.lock) {
      customSize.w = Math.max(1, Math.round(v * customSize.ratio));
      wInput.value = String(customSize.w);
    }
    applyCustomSizeChoice(ctx);
  });
  customRow1.appendChild(ctx.ui.el('span', 'ui-label', '寬'));
  customRow1.appendChild(wInput);
  customRow1.appendChild(ctx.ui.el('span', 'ui-label', '高'));
  customRow1.appendChild(hInput);
  const lockToggle = ctx.ui.toggle('鎖定比例', customSize.lock, (checked) => {
    customSize.lock = checked;
    if (checked) customSize.ratio = customSize.w / customSize.h;
  });
  const customApplyBtn = ctx.ui.button('套用尺寸（裁剪＋縮放）', () => cropApply(ctx), { block: true });
  panelEl.appendChild(
    ctx.ui.section('常用尺寸', [presetGrid, customRow1, lockToggle, customApplyBtn]),
  );

  // 3. 形狀蒙版
  const shapeGrid = ctx.ui.el('div', 'adj-grid');
  for (const shape of SHAPE_OPTIONS) {
    const btn = ctx.ui.button(shape.label, () => selectShape(shape.id, ctx));
    if (shapeSelected === shape.id) btn.classList.add('selected');
    shapeGrid.appendChild(btn);
  }
  const shapeChildren = [shapeGrid];
  if (shapeSelected === 'roundedRect') {
    shapeChildren.push(
      ctx.ui.slider('圓角大小', 0, 50, 1, Math.round(shapeRoundness * 100), (v) => {
        shapeRoundness = v / 100;
        refreshShapePreview(ctx);
      }),
    );
  }
  shapeChildren.push(ctx.ui.button('套用形狀', () => applyShapeChoice(ctx), { primary: true, block: true }));
  panelEl.appendChild(ctx.ui.section('形狀蒙版', shapeChildren));

  // 4. 旋轉翻轉
  const quickRow = ctx.ui.el('div', 'adj-grid');
  quickRow.appendChild(ctx.ui.button('向左 90°', () => quickTransform('left', ctx)));
  quickRow.appendChild(ctx.ui.button('向右 90°', () => quickTransform('right', ctx)));
  quickRow.appendChild(ctx.ui.button('水平翻轉', () => quickTransform('fliph', ctx)));
  quickRow.appendChild(ctx.ui.button('垂直翻轉', () => quickTransform('flipv', ctx)));

  const angleSlider = ctx.ui.slider('任意角度', -45, 45, 1, rotateAngle, (v) => onAngleInput(v, ctx));
  const edgeModeGroup = ctx.ui.buttonGroup(
    [
      { id: 'crop', label: '自動裁掉黑邊' },
      { id: 'keep', label: '保留透明' },
    ],
    rotateEdgeMode,
    (id) => {
      rotateEdgeMode = id;
      if (rotateAngle !== 0) onAngleInput(rotateAngle, ctx);
    },
  );
  const rotateApplyBtn = ctx.ui.button('套用旋轉', () => applyRotateSlider(ctx), { primary: true, block: true });

  panelEl.appendChild(
    ctx.ui.section('旋轉翻轉', [
      quickRow,
      angleSlider,
      edgeModeGroup,
      rotateApplyBtn,
      ctx.ui.el('div', 'adj-help-text', '拖曳滑桿可即時預覽旋轉結果，按「套用旋轉」才會真正寫入影像。'),
    ]),
  );
}

export default {
  id: 'adjust',
  name: '調整',
  icon,
  needsImage: true,
  mount(panelEl, ctx) {
    mountedPanelEl = panelEl;
    mountPanel(ctx);
  },
  activate(ctx) {
    const img = ctx.doc.getImage();
    if (!cropRect || cropForImgW !== img.width || cropForImgH !== img.height) {
      resetCropToFull(ctx);
    }
    shapeSelected = null;
    rotateAngle = 0;
    restoreCropOverlay(ctx);
  },
  deactivate(ctx) {
    shapeSelected = null;
    rotateAngle = 0;
    cropDragState = null;
    ctx.preview(null);
    ctx.viewport.setOverlay(null);
    ctx.viewport.setInteraction(null);
    mountedPanelEl = null;
  },
};
