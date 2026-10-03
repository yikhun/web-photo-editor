// 文字工具：新增標題/副標題/正文、花字樣式、拖曳移動/縮放/旋轉，套用到圖片後清空文字層。
// 文字物件存在本模組的陣列（不入歷史），只有「套用到圖片」或切出/匯出前才真正畫進影像。
import '../styles/tools-adjust-text.css';
import { cloneCanvas } from '../core/canvasUtil.js';
import { FONT_OPTIONS, STYLE_OPTIONS, STYLES, renderTextObject, measureTextObject } from './text/styles.js';

const icon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M5 6h14M12 6v12" stroke-width="2" stroke-linecap="round"/>
</svg>`;

// ---------- 模組狀態 ----------
let textObjects = [];
let selectedId = null;
let idCounter = 0;
let dragState = null;
let exportHandlerRegistered = false;
let loadHandlerRegistered = false;
let mountedPanelEl = null;
let mountedCtx = null;
let panelRefs = {};

function selectedObj() {
  return textObjects.find((o) => o.id === selectedId) || null;
}

function createTextObject(kind, ctx) {
  const img = ctx.doc.getImage();
  const presets = {
    title: { ratio: 0.08, weight: 700, text: '標題文字' },
    subtitle: { ratio: 0.05, weight: 600, text: '副標題文字' },
    body: { ratio: 0.03, weight: 400, text: '在此輸入正文內容' },
  };
  const p = presets[kind] || presets.body;
  const fontSize = Math.max(12, Math.round(img.width * p.ratio));
  const obj = {
    id: ++idCounter,
    text: p.text,
    x: img.width / 2,
    y: img.height / 2 + (textObjects.length % 6) * fontSize * 0.6,
    fontSize,
    fontFamily: FONT_OPTIONS[0].family,
    weight: p.weight,
    color: '#ffffff',
    align: 'center',
    style: 'plain',
    rotation: 0,
    lineHeight: 1.2,
    letterSpacing: 0,
    opacity: 1,
  };
  textObjects.push(obj);
  selectedId = obj.id;
  return obj;
}

function applyStyleToSelectedOrNew(styleId, ctx) {
  let obj = selectedObj();
  if (!obj) obj = createTextObject('body', ctx);
  obj.style = styleId;
  selectedId = obj.id;
  mountPanel(ctx);
  ctx.viewport.requestRender();
}

// ---------- 套用到圖片 ----------
function applyAllToImage(ctx) {
  if (!textObjects.length) return;
  if (!ctx.doc.hasImage()) {
    textObjects = [];
    selectedId = null;
    return;
  }
  const out = cloneCanvas(ctx.doc.getImage());
  const g = out.getContext('2d');
  for (const obj of textObjects) {
    renderTextObject(g, obj);
  }
  ctx.commit(out, '加入文字');
  textObjects = [];
  selectedId = null;
  dragState = null;
  if (mountedPanelEl) mountPanel(ctx);
  ctx.viewport.requestRender();
}

// ---------- overlay 繪製 ----------
function drawOverlay(g, view) {
  for (const obj of textObjects) {
    const pos = view.imageToScreen(obj.x, obj.y);
    g.save();
    g.translate(pos.x, pos.y);
    g.scale(view.scale, view.scale);
    renderTextObject(g, { ...obj, x: 0, y: 0 });
    g.restore();
    if (obj.id === selectedId) drawSelectionChrome(g, view, obj);
  }
}

function drawSelectionChrome(g, view, obj) {
  const { width, height } = measureTextObject(obj);
  const pad = obj.fontSize * 0.15;
  const hw = width / 2 + pad;
  const hh = height / 2 + pad;
  const pos = view.imageToScreen(obj.x, obj.y);
  const s = view.scale;
  const gap = 24;
  g.save();
  g.translate(pos.x, pos.y);
  g.rotate(obj.rotation || 0);
  g.strokeStyle = '#4f8cff';
  g.lineWidth = 1.5;
  g.setLineDash([4, 3]);
  g.strokeRect(-hw * s, -hh * s, hw * 2 * s, hh * 2 * s);
  g.setLineDash([]);
  g.fillStyle = '#4f8cff';
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [-hw, hh],
    [hw, hh],
  ];
  for (const [cx, cy] of corners) {
    g.fillRect(cx * s - 4, cy * s - 4, 8, 8);
  }
  g.beginPath();
  g.moveTo(0, -hh * s);
  g.lineTo(0, -hh * s - gap);
  g.strokeStyle = '#4f8cff';
  g.lineWidth = 1.5;
  g.stroke();
  g.beginPath();
  g.arc(0, -hh * s - gap, 6, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  g.strokeStyle = '#4f8cff';
  g.stroke();
  g.restore();
}

// ---------- 命中測試（影像座標系） ----------
function hitTestObject(obj, p, scale) {
  const dx = p.x - obj.x;
  const dy = p.y - obj.y;
  const rot = -(obj.rotation || 0);
  const lx = dx * Math.cos(rot) - dy * Math.sin(rot);
  const ly = dx * Math.sin(rot) + dy * Math.cos(rot);
  const { width, height } = measureTextObject(obj);
  const pad = obj.fontSize * 0.15;
  const hw = width / 2 + pad;
  const hh = height / 2 + pad;
  const handleTol = 10 / scale;
  const gapImg = 24 / scale;

  if (Math.hypot(lx - 0, ly - (-hh - gapImg)) <= handleTol) return { type: 'rotate' };

  const corners = {
    nw: [-hw, -hh],
    ne: [hw, -hh],
    sw: [-hw, hh],
    se: [hw, hh],
  };
  for (const key of Object.keys(corners)) {
    const [cx, cy] = corners[key];
    if (Math.hypot(lx - cx, ly - cy) <= handleTol) return { type: 'scale', corner: key };
  }
  if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return { type: 'move' };
  return null;
}

function findHitAtPoint(p, scale) {
  const sel = selectedObj();
  if (sel) {
    const hit = hitTestObject(sel, p, scale);
    if (hit) return { obj: sel, hit };
  }
  for (let i = textObjects.length - 1; i >= 0; i--) {
    const obj = textObjects[i];
    if (obj === sel) continue;
    const hit = hitTestObject(obj, p, scale);
    if (hit) return { obj, hit: { type: 'move' } };
  }
  return null;
}

// ---------- 互動 ----------
function onPointerDown(ctx, e, p) {
  const scale = ctx.viewport.getScale();
  const found = findHitAtPoint(p, scale);
  if (!found) {
    if (selectedId != null) {
      selectedId = null;
      mountPanel(ctx);
      ctx.viewport.requestRender();
    }
    dragState = null;
    return;
  }
  const { obj, hit } = found;
  const selectionChanged = selectedId !== obj.id;
  selectedId = obj.id;
  dragState = {
    obj,
    type: hit.type,
    corner: hit.corner,
    startP: p,
    startX: obj.x,
    startY: obj.y,
    startFontSize: obj.fontSize,
    startRotation: obj.rotation || 0,
  };
  if (selectionChanged) mountPanel(ctx);
  ctx.viewport.requestRender();
}

function onPointerMove(ctx, e, p) {
  if (!dragState) return;
  const { obj, type } = dragState;
  if (type === 'move') {
    obj.x = dragState.startX + (p.x - dragState.startP.x);
    obj.y = dragState.startY + (p.y - dragState.startP.y);
  } else if (type === 'scale') {
    const d0 = Math.hypot(dragState.startP.x - obj.x, dragState.startP.y - obj.y) || 1;
    const d1 = Math.hypot(p.x - obj.x, p.y - obj.y) || 1;
    const ratio = d1 / d0;
    obj.fontSize = Math.min(2000, Math.max(6, Math.round(dragState.startFontSize * ratio)));
    if (panelRefs.fontSizeRow && selectedId === obj.id) panelRefs.fontSizeRow.setValue(obj.fontSize);
  } else if (type === 'rotate') {
    obj.rotation = Math.atan2(p.y - obj.y, p.x - obj.x) + Math.PI / 2;
  }
  ctx.viewport.requestRender();
}

function onPointerUp() {
  dragState = null;
}

function onDblClick(ctx, e, p) {
  const scale = ctx.viewport.getScale();
  const found = findHitAtPoint(p, scale);
  if (!found) return false;
  const { obj } = found;
  const selectionChanged = selectedId !== obj.id;
  selectedId = obj.id;
  dragState = null;
  if (selectionChanged) mountPanel(ctx);
  ctx.viewport.requestRender();
  if (panelRefs.textarea) {
    panelRefs.textarea.focus();
    panelRefs.textarea.select();
  }
  return true;
}

// ---------- 面板 ----------
function section(ctx, title, children) {
  return ctx.ui.section(title, children);
}

function mountPanel(ctx) {
  const panelEl = mountedPanelEl;
  if (!panelEl) return;
  panelRefs = {};
  panelEl.innerHTML = '';

  const addRow = ctx.ui.el('div', 'adj-grid');
  addRow.appendChild(
    ctx.ui.button('新增標題', () => {
      createTextObject('title', ctx);
      mountPanel(ctx);
      ctx.viewport.requestRender();
    }),
  );
  addRow.appendChild(
    ctx.ui.button('新增副標題', () => {
      createTextObject('subtitle', ctx);
      mountPanel(ctx);
      ctx.viewport.requestRender();
    }),
  );
  addRow.appendChild(
    ctx.ui.button('新增正文', () => {
      createTextObject('body', ctx);
      mountPanel(ctx);
      ctx.viewport.requestRender();
    }),
  );
  panelEl.appendChild(section(ctx, '新增文字', [addRow]));

  const styleGrid = ctx.ui.el('div', 'txt-style-grid');
  for (const opt of STYLE_OPTIONS) {
    const btn = ctx.ui.el('button', `txt-style-btn txt-style-${opt.id}`);
    btn.type = 'button';
    const preview = ctx.ui.el('span', 'txt-style-preview', 'Aa');
    btn.appendChild(preview);
    btn.appendChild(ctx.ui.el('span', null, opt.label));
    const cur = selectedObj();
    if (cur && cur.style === opt.id) btn.classList.add('selected');
    btn.addEventListener('click', () => applyStyleToSelectedOrNew(opt.id, ctx));
    styleGrid.appendChild(btn);
  }
  panelEl.appendChild(section(ctx, '花字樣式', [styleGrid]));

  const obj = selectedObj();
  if (!obj) {
    panelEl.appendChild(
      ctx.ui.el('div', 'txt-object-hint', '尚未選取文字物件：點選畫布上的文字，或先新增一個。'),
    );
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.className = 'txt-content';
  textarea.value = obj.text;
  textarea.addEventListener('input', () => {
    obj.text = textarea.value;
    ctx.viewport.requestRender();
  });
  panelRefs.textarea = textarea;
  panelEl.appendChild(section(ctx, '內容', [textarea]));

  const fontSelect = ctx.ui.select(
    FONT_OPTIONS.map((f) => ({ value: f.id, label: f.label })),
    FONT_OPTIONS.find((f) => f.family === obj.fontFamily)?.id || FONT_OPTIONS[0].id,
    (val) => {
      const f = FONT_OPTIONS.find((x) => x.id === val);
      if (f) obj.fontFamily = f.family;
      ctx.viewport.requestRender();
    },
  );
  const fontSizeRow = ctx.ui.slider('字級', 8, 600, 1, obj.fontSize, (v) => {
    obj.fontSize = v;
    ctx.viewport.requestRender();
  });
  panelRefs.fontSizeRow = fontSizeRow;

  const weightGroup = ctx.ui.buttonGroup(
    [
      { id: '400', label: '一般' },
      { id: '600', label: '中粗' },
      { id: '700', label: '粗體' },
      { id: '900', label: '特粗' },
    ],
    String(obj.weight),
    (val) => {
      obj.weight = Number(val);
      ctx.viewport.requestRender();
    },
  );

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = obj.color;
  colorInput.addEventListener('input', () => {
    obj.color = colorInput.value;
    ctx.viewport.requestRender();
  });
  const swatches = ctx.ui.colorSwatches(
    ['#ffffff', '#000000', '#ff5a8a', '#4ef0ff', '#ffd500', '#4caf7d', '#4f8cff'],
    obj.color,
    (c) => {
      obj.color = c;
      colorInput.value = c;
      ctx.viewport.requestRender();
    },
  );
  const colorRow = ctx.ui.el('div', 'ui-row');
  colorRow.appendChild(swatches);
  colorRow.appendChild(colorInput);

  const alignGroup = ctx.ui.buttonGroup(
    [
      { id: 'left', label: '靠左' },
      { id: 'center', label: '置中' },
      { id: 'right', label: '靠右' },
    ],
    obj.align,
    (val) => {
      obj.align = val;
      ctx.viewport.requestRender();
    },
  );

  const lineHeightRow = ctx.ui.slider('行距', 0.8, 3, 0.1, obj.lineHeight, (v) => {
    obj.lineHeight = v;
    ctx.viewport.requestRender();
  });
  const letterSpacingRow = ctx.ui.slider('字距 (px)', -5, 40, 1, obj.letterSpacing, (v) => {
    obj.letterSpacing = v;
    ctx.viewport.requestRender();
  });
  const opacityRow = ctx.ui.slider('透明度 (%)', 0, 100, 5, Math.round(obj.opacity * 100), (v) => {
    obj.opacity = v / 100;
    ctx.viewport.requestRender();
  });

  const deleteBtn = ctx.ui.button(
    '刪除此文字',
    () => {
      textObjects = textObjects.filter((o) => o.id !== obj.id);
      selectedId = null;
      mountPanel(ctx);
      ctx.viewport.requestRender();
    },
    { block: true },
  );

  panelEl.appendChild(
    section(ctx, '屬性', [
      ctx.ui.el('div', 'ui-row', [ctx.ui.el('span', 'ui-label', '字型'), fontSelect]),
      fontSizeRow,
      ctx.ui.el('div', 'ui-row', [ctx.ui.el('span', 'ui-label', '粗細'), weightGroup]),
      ctx.ui.el('div', 'ui-row', [ctx.ui.el('span', 'ui-label', '顏色'), colorRow]),
      ctx.ui.el('div', 'ui-row', [ctx.ui.el('span', 'ui-label', '對齊'), alignGroup]),
      lineHeightRow,
      letterSpacingRow,
      opacityRow,
      deleteBtn,
    ]),
  );

  panelEl.appendChild(
    section(ctx, '完成', [
      ctx.ui.button(
        '套用到圖片',
        () => {
          applyAllToImage(ctx);
        },
        { primary: true, block: true },
      ),
      ctx.ui.el('div', 'adj-help-text', '切換工具或匯出圖片時，尚未套用的文字也會自動合併進影像。'),
    ]),
  );
}

function ensureGlobalHandlers(ctx) {
  if (!exportHandlerRegistered) {
    exportHandlerRegistered = true;
    ctx.bus.on('export:before', () => {
      if (textObjects.length && mountedCtx) applyAllToImage(mountedCtx);
    });
  }
  if (!loadHandlerRegistered) {
    loadHandlerRegistered = true;
    ctx.bus.on('doc:load', () => {
      textObjects = [];
      selectedId = null;
      dragState = null;
      if (mountedPanelEl) mountPanel(mountedCtx || ctx);
    });
  }
}

export default {
  id: 'text',
  name: '文字',
  icon,
  needsImage: true,
  mount(panelEl, ctx) {
    mountedPanelEl = panelEl;
    mountedCtx = ctx;
    ensureGlobalHandlers(ctx);
    mountPanel(ctx);
  },
  activate(ctx) {
    mountedCtx = ctx;
    ctx.viewport.setOverlay(drawOverlay);
    ctx.viewport.setInteraction({
      cursor: 'default',
      onPointerDown: (e, p) => onPointerDown(ctx, e, p),
      onPointerMove: (e, p) => onPointerMove(ctx, e, p),
      onPointerUp: () => onPointerUp(),
      onDblClick: (e, p) => onDblClick(ctx, e, p),
    });
    ctx.viewport.requestRender();
  },
  deactivate(ctx) {
    applyAllToImage(ctx);
    dragState = null;
    ctx.viewport.setOverlay(null);
    ctx.viewport.setInteraction(null);
    mountedPanelEl = null;
  },
};

// 供 STYLES 外部參考（例如未來其他工具想重用花字清單）。
export { STYLES };
