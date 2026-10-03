// 調色工具：預設縮圖、滑桿、獨立濾鏡、一鍵換色。
// 即時預覽走 WebGL2（src/tools/color/renderer.js），不支援時退回 CPU（src/tools/color/cpu.js）。
// 預覽用縮小版材質渲染，再拉伸畫回與目前影像同尺寸的 2D canvas，以符合 viewport 的縮放座標系。
import '../styles/tool-color.css';
import { createCanvas, cloneCanvas } from '../core/canvasUtil.js';
import { createGlRenderer, applyFull } from './color/renderer.js';
import { applyCpu } from './color/cpu.js';
import { PRESETS, findPreset } from './color/presets.js';
import { FILTERS, findFilter } from './color/filters.js';
import { hexToRgb01, rgb01ToHex, rgbToHsl, sampleAverageColor } from './color/colorUtil.js';
import { t } from '../core/i18n.js';

const icon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H16a4 4 0 0 0 4-4c0-4.4-3.6-7.5-8-7.5z" stroke-width="2"/>
  <circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>
  <circle cx="16" cy="10.5" r="1.2" fill="currentColor" stroke="none"/>
</svg>`;

const SLIDER_DEFS = [
  { key: 'exposure', label: '曝光', min: -100, max: 100, default: 0 },
  { key: 'brightness', label: '亮度', min: -100, max: 100, default: 0 },
  { key: 'contrast', label: '對比', min: -100, max: 100, default: 0 },
  { key: 'saturation', label: '飽和度', min: -100, max: 100, default: 0 },
  { key: 'vibrance', label: '自然飽和度', min: -100, max: 100, default: 0 },
  { key: 'temperature', label: '色溫', min: -100, max: 100, default: 0 },
  { key: 'tint', label: '色調（綠-洋紅）', min: -100, max: 100, default: 0 },
  { key: 'highlights', label: '高光', min: -100, max: 100, default: 0 },
  { key: 'shadows', label: '陰影', min: -100, max: 100, default: 0 },
  { key: 'whites', label: '白色', min: -100, max: 100, default: 0 },
  { key: 'blacks', label: '黑色', min: -100, max: 100, default: 0 },
  { key: 'clarity', label: '清晰度（局部對比）', min: -100, max: 100, default: 0 },
  { key: 'sharpen', label: '銳化', min: 0, max: 100, default: 0 },
  { key: 'vignette', label: '暈影', min: 0, max: 100, default: 0 },
  { key: 'grain', label: '顆粒', min: 0, max: 100, default: 0 },
  { key: 'fade', label: '褪色', min: 0, max: 100, default: 0 },
];

const TARGET_SWATCHES = [
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be',
  '#30b0c7', '#007aff', '#5856d6', '#af52de', '#ff2d55',
];

const PREVIEW_MAX_SIDE = 2048;
const THUMB_MAX_SIDE = 150;

function createDefaultState() {
  const s = { intensity: 100, splitShadowColor: null, splitHighlightColor: null, splitStrength: 0, activePreset: 'original' };
  for (const def of SLIDER_DEFS) s[def.key] = def.default;
  s.filter = {
    id: 'none',
    mode: 0,
    intensity: 100,
    duotoneColor1: [0.06, 0.06, 0.2],
    duotoneColor2: [1, 0.82, 0.5],
    pixelBlock: 14,
  };
  s.colorReplace = {
    enabled: false,
    sourceRgb: null,
    sourceHue: 0,
    sourceSat: 0,
    targetHex: '#ff3b30',
    targetHue: 6,
    targetSat: 0.85,
    targetLight: 0.55,
    tolerance: 30,
    preserveLightness: true,
  };
  return s;
}

function buildPresetParams(preset) {
  const p = createDefaultState();
  Object.assign(p, preset.values);
  p.intensity = 100;
  return p;
}

function downscale(canvas, maxSide) {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= maxSide) return cloneCanvas(canvas);
  const scale = maxSide / longest;
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const out = createCanvas(w, h);
  out.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return out;
}

// ---------- 模組狀態（單例工具，activate/deactivate 期間持續存在）----------
let glRenderer = null;
let glInitTried = false;
let glTextureSource = null;
let cpuFallbackWarned = false;

let workingSourceCanvas = null; // 目前委入影像的 clone（全尺寸）
let previewSourceCanvas = null; // 長邊 <=2048 的縮小版，供即時預覽
let thumbSourceCanvas = null; // 長邊 <=150 的縮小版，供預設縮圖
let state = createDefaultState();
let lastDocImage = null; // ctx.doc.getImage() 的參照，用來分辨「真的換圖」vs「同一張圖重新 mount（如切換語言)」

let dirty = false;
let rafId = null;
let unsubscribeDocChange = null;
let unsubscribeHistoryNav = null;
let picking = false;

// UI refs（mount 時重建）
let refs = null;

function ensureGlRenderer() {
  if (!glInitTried) {
    glInitTried = true;
    try {
      glRenderer = createGlRenderer();
    } catch (err) {
      console.error('[color] 建立 WebGL2 渲染器失敗', err);
      glRenderer = null;
    }
  }
  return glRenderer;
}

function renderWithEngine(sourceCanvas, params, toastCtx) {
  const renderer = ensureGlRenderer();
  if (renderer) {
    if (glTextureSource !== sourceCanvas) {
      renderer.uploadSource(sourceCanvas);
      glTextureSource = sourceCanvas;
    }
    const result = renderer.renderToCanvas(params);
    if (result) return result;
  }
  if (toastCtx && !cpuFallbackWarned) {
    cpuFallbackWarned = true;
    toastCtx.toast(t('此瀏覽器不支援 WebGL2，調色改用較慢的 CPU 運算'), 'info');
  }
  return applyCpu(sourceCanvas, params);
}

function schedulePreviewRender() {
  dirty = true;
}

function renderPreview(ctx) {
  if (!previewSourceCanvas || !workingSourceCanvas) return;
  const small = renderWithEngine(previewSourceCanvas, state, ctx);
  if (!small) return;
  const full = createCanvas(workingSourceCanvas.width, workingSourceCanvas.height);
  full.getContext('2d').drawImage(small, 0, 0, full.width, full.height);
  ctx.preview(full);
}

function rebuildThumbnails(ctx) {
  if (!thumbSourceCanvas || !refs) return;
  for (const preset of PRESETS) {
    const entry = refs.presetCards[preset.id];
    if (!entry) continue;
    const params = buildPresetParams(preset);
    const result = renderWithEngine(thumbSourceCanvas, params, null);
    if (!result) continue;
    entry.canvasEl.width = result.width;
    entry.canvasEl.height = result.height;
    entry.canvasEl.getContext('2d').drawImage(result, 0, 0);
  }
  // 縮圖批次會覆寫材質，下一次預覽渲染前強制重新上傳
  glTextureSource = null;
}

function updatePresetSelection() {
  if (!refs) return;
  for (const id of Object.keys(refs.presetCards)) {
    refs.presetCards[id].card.classList.toggle('selected', id === state.activePreset);
  }
}

function refreshControlsFromState() {
  if (!refs) return;
  for (const def of SLIDER_DEFS) {
    refs.sliderRows[def.key].setValue(state[def.key]);
  }
  refs.intensityRow.setValue(state.intensity);
  refs.filterSelect.value = state.filter.id;
  refs.filterIntensityRow.setValue(state.filter.intensity);
  buildFilterExtra();
  updatePresetSelection();
  updateSourceSwatch();
  refs.targetColorInput.value = state.colorReplace.targetHex;
  refs.commonSwatches.setSelected(state.colorReplace.targetHex);
  refs.toleranceRow.setValue(state.colorReplace.tolerance);
  refs.preserveToggle.setChecked(state.colorReplace.preserveLightness);
  refs.pickBtn.textContent = t('點選畫面取色');
  refs.pickBtn.classList.remove('active');
}

function updateSourceSwatch() {
  if (!refs) return;
  const rgb = state.colorReplace.sourceRgb;
  if (rgb) {
    refs.sourceSwatch.style.background = `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
    refs.sourceSwatch.classList.remove('empty');
  } else {
    refs.sourceSwatch.style.background = '';
    refs.sourceSwatch.classList.add('empty');
  }
}

function buildFilterExtra() {
  if (!refs) return;
  const el = refs.filterExtra;
  el.innerHTML = '';
  const f = state.filter;
  if (f.id === 'duotone') {
    const row = document.createElement('div');
    row.className = 'color-duotone-row';
    const c1 = document.createElement('input');
    c1.type = 'color';
    c1.value = rgb01ToHex(f.duotoneColor1);
    const c2 = document.createElement('input');
    c2.type = 'color';
    c2.value = rgb01ToHex(f.duotoneColor2);
    c1.addEventListener('input', () => {
      f.duotoneColor1 = hexToRgb01(c1.value);
      schedulePreviewRender();
    });
    c2.addEventListener('input', () => {
      f.duotoneColor2 = hexToRgb01(c2.value);
      schedulePreviewRender();
    });
    const wrap1 = document.createElement('label');
    wrap1.className = 'color-duotone-item';
    wrap1.appendChild(document.createTextNode(t('陰影色') + ' '));
    wrap1.appendChild(c1);
    const wrap2 = document.createElement('label');
    wrap2.className = 'color-duotone-item';
    wrap2.appendChild(document.createTextNode(t('亮部色') + ' '));
    wrap2.appendChild(c2);
    row.appendChild(wrap1);
    row.appendChild(wrap2);
    el.appendChild(row);
  } else if (f.id === 'pixelate') {
    const row = toolCtx.ui.slider(t('像素區塊大小'), 4, 60, 1, f.pixelBlock, (v) => {
      f.pixelBlock = v;
      schedulePreviewRender();
    });
    el.appendChild(row);
  }
}

function applyPresetById(id) {
  const preset = findPreset(id) || findPreset('original');
  for (const def of SLIDER_DEFS) state[def.key] = def.default;
  state.splitShadowColor = null;
  state.splitHighlightColor = null;
  state.splitStrength = 0;
  Object.assign(state, preset.values);
  state.intensity = 100;
  state.activePreset = preset.id;
  refreshControlsFromState();
  schedulePreviewRender();
}

function applyTargetColor(hex) {
  const [r, g, b] = hexToRgb01(hex);
  const hsl = rgbToHsl(r, g, b);
  state.colorReplace.targetHex = hex;
  state.colorReplace.targetHue = hsl.h;
  state.colorReplace.targetSat = Math.max(hsl.s, 0.4);
  state.colorReplace.targetLight = hsl.l;
  if (refs) {
    refs.targetColorInput.value = hex;
    refs.commonSwatches.setSelected(hex);
  }
  schedulePreviewRender();
}

function togglePicking(ctx) {
  picking = !picking;
  refs.pickBtn.textContent = picking ? t('請在畫面上點一下…') : t('點選畫面取色');
  refs.pickBtn.classList.toggle('active', picking);
  if (picking) {
    ctx.viewport.setInteraction({
      cursor: 'crosshair',
      onPointerDown(_e, p) {
        pickColorAt(ctx, p);
      },
    });
  } else {
    ctx.viewport.setInteraction(null);
  }
}

function pickColorAt(ctx, p) {
  if (!workingSourceCanvas) return;
  const sample = sampleAverageColor(workingSourceCanvas, p.x, p.y, 5);
  if (sample.a < 0.04) {
    ctx.toast(t('該處幾乎透明，請改選其他位置'), 'error');
    return;
  }
  const hsl = rgbToHsl(sample.r, sample.g, sample.b);
  state.colorReplace.sourceRgb = [sample.r, sample.g, sample.b];
  state.colorReplace.sourceHue = hsl.h;
  state.colorReplace.sourceSat = hsl.s;
  state.colorReplace.enabled = true;
  updateSourceSwatch();
  picking = false;
  refs.pickBtn.textContent = t('點選畫面取色');
  refs.pickBtn.classList.remove('active');
  ctx.viewport.setInteraction(null);
  schedulePreviewRender();
}

function clearPick() {
  state.colorReplace.enabled = false;
  state.colorReplace.sourceRgb = null;
  updateSourceSwatch();
  schedulePreviewRender();
}

function resetSliders(ctx) {
  state = createDefaultState();
  refreshControlsFromState();
  ctx.viewport.setInteraction(null);
  picking = false;
  ctx.preview(null);
}

function applyEdit(ctx) {
  if (!workingSourceCanvas) return;
  const renderer = ensureGlRenderer();
  let result;
  if (renderer) {
    result = applyFull(renderer, workingSourceCanvas, state);
    glTextureSource = null;
  } else {
    result = applyCpu(workingSourceCanvas, state);
  }
  ctx.commit(result, t('調色'));
  ctx.toast(t('已套用調色'), 'success');
}

// 滑桿/濾鏡/換色皆為預設值時，直接讓 viewport 顯示真正的文件影像（不經過縮小再放大的預覽材質），
// 避免大圖在「根本沒調整」時也被重取樣一輪而損失一點銳利度。
function isDefaultState(s) {
  for (const def of SLIDER_DEFS) {
    if (s[def.key] !== def.default) return false;
  }
  if (s.filter.id !== 'none') return false;
  if (s.colorReplace.enabled) return false;
  if (s.splitStrength) return false;
  return true;
}

function refreshBaseFromDoc(ctx) {
  const img = ctx.doc.getImage();
  if (!img) return;
  // 同一張圖（參照相同）代表這次只是重新 mount（例如切換語言面板重畫），不是真的換了底圖，
  // 此時保留使用者已調的滑桿/濾鏡/換色狀態；真的換圖（doc:change 來的新 canvas）才重置。
  const sameImage = img === lastDocImage && workingSourceCanvas != null;
  lastDocImage = img;
  workingSourceCanvas = cloneCanvas(img);
  previewSourceCanvas = downscale(workingSourceCanvas, PREVIEW_MAX_SIDE);
  thumbSourceCanvas = downscale(workingSourceCanvas, THUMB_MAX_SIDE);
  glTextureSource = null;
  if (!sameImage) state = createDefaultState();
  picking = false;
  if (refs) {
    refreshControlsFromState();
    rebuildThumbnails(ctx);
  }
  ctx.viewport.setInteraction(null);
  if (isDefaultState(state)) {
    ctx.preview(null);
  } else {
    // 保留下來的非預設狀態：排進下一個 rAF 重新渲染預覽，讓重新 mount 後畫面立刻反映之前的調整
    schedulePreviewRender();
  }
}

let toolCtx = null;

function buildPanel(panelEl, ctx) {
  toolCtx = ctx;
  const ui = ctx.ui;
  refs = {
    sliderRows: {},
    presetCards: {},
  };

  // ---- 1. 預設縮圖 ----
  const presetGrid = ui.el('div', 'color-preset-grid');
  for (const preset of PRESETS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'color-preset-card';
    card.dataset.id = preset.id;
    const thumbWrap = ui.el('div', 'color-preset-thumb');
    const canvasEl = document.createElement('canvas');
    thumbWrap.appendChild(canvasEl);
    card.appendChild(thumbWrap);
    card.appendChild(ui.el('div', 'color-preset-label', t(preset.label)));
    card.addEventListener('click', () => applyPresetById(preset.id));
    presetGrid.appendChild(card);
    refs.presetCards[preset.id] = { card, canvasEl };
  }
  refs.intensityRow = ui.slider(t('強度'), 0, 100, 1, state.intensity, (v) => {
    state.intensity = v;
    schedulePreviewRender();
  });

  panelEl.appendChild(ui.section(t('預設'), [presetGrid, refs.intensityRow]));

  // ---- 2. 滑桿 ----
  const sliderNodes = [];
  for (const def of SLIDER_DEFS) {
    const row = ui.slider(t(def.label), def.min, def.max, 1, state[def.key], (v) => {
      state[def.key] = v;
      schedulePreviewRender();
    });
    row.input.addEventListener('dblclick', () => {
      state[def.key] = def.default;
      row.setValue(def.default);
      schedulePreviewRender();
    });
    refs.sliderRows[def.key] = row;
    sliderNodes.push(row);
  }
  panelEl.appendChild(ui.section(t('滑桿（雙擊歸零）'), sliderNodes));

  // ---- 3. 濾鏡 ----
  refs.filterSelect = ui.select(
    FILTERS.map((f) => ({ value: f.id, label: t(f.label) })),
    state.filter.id,
    (val) => {
      const f = findFilter(val);
      state.filter.id = f.id;
      state.filter.mode = f.mode;
      buildFilterExtra();
      schedulePreviewRender();
    },
  );
  refs.filterIntensityRow = ui.slider(t('濾鏡強度'), 0, 100, 1, state.filter.intensity, (v) => {
    state.filter.intensity = v;
    schedulePreviewRender();
  });
  refs.filterExtra = ui.el('div', 'color-filter-extra');
  panelEl.appendChild(ui.section(t('濾鏡'), [refs.filterSelect, refs.filterIntensityRow, refs.filterExtra]));

  // ---- 4. 一鍵換色 ----
  refs.pickBtn = ui.button(t('點選畫面取色'), () => togglePicking(ctx), { block: true });
  const clearBtn = ui.button(t('清除選色'), clearPick);
  refs.sourceSwatch = ui.el('div', 'color-swatch-preview empty');
  const sourceRow = ui.el('div', 'color-source-row', [
    ui.el('span', null, t('來源色：')),
    refs.sourceSwatch,
    clearBtn,
  ]);

  refs.targetColorInput = document.createElement('input');
  refs.targetColorInput.type = 'color';
  refs.targetColorInput.value = state.colorReplace.targetHex;
  refs.targetColorInput.addEventListener('input', () => applyTargetColor(refs.targetColorInput.value));
  refs.commonSwatches = ui.colorSwatches(TARGET_SWATCHES, state.colorReplace.targetHex, (hex) => applyTargetColor(hex));
  const targetRow = ui.el('div', 'color-target-row', [
    ui.el('span', null, t('目標色：')),
    refs.targetColorInput,
  ]);

  refs.toleranceRow = ui.slider(t('容差（色相範圍）'), 0, 180, 1, state.colorReplace.tolerance, (v) => {
    state.colorReplace.tolerance = v;
    schedulePreviewRender();
  });
  refs.preserveToggle = ui.toggle(t('保留明暗（只轉色相＋飽和度）'), state.colorReplace.preserveLightness, (v) => {
    state.colorReplace.preserveLightness = v;
    schedulePreviewRender();
  });

  panelEl.appendChild(
    ui.section(t('一鍵換色'), [
      refs.pickBtn,
      sourceRow,
      targetRow,
      refs.commonSwatches,
      refs.toleranceRow,
      refs.preserveToggle,
    ]),
  );

  // ---- 5. 動作 ----
  const applyBtn = ui.button(t('套用'), () => applyEdit(ctx), { primary: true, block: true });
  const resetBtn = ui.button(t('重設滑桿'), () => resetSliders(ctx), { block: true });
  panelEl.appendChild(ui.section(t('動作'), [applyBtn, resetBtn]));

  buildFilterExtra();
}

export default {
  id: 'color',
  name: '調色',
  icon,
  needsImage: true,
  mount(panelEl, ctx) {
    panelEl.innerHTML = '';
    refs = null;
    refreshBaseFromDoc(ctx);
    buildPanel(panelEl, ctx);
    refreshControlsFromState();
    rebuildThumbnails(ctx);
  },
  activate(ctx) {
    // 不在這裡強制 dirty=false：mount() 若保留了非預設狀態（例如切換語言重新 mount），
    // 會在那裡排好一次 schedulePreviewRender()，activate 要讓它自然跑到，而不是蓋掉。
    function loop() {
      if (dirty) {
        dirty = false;
        renderPreview(ctx);
      }
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    unsubscribeDocChange = ctx.bus.on('doc:change', () => refreshBaseFromDoc(ctx));
    // 復原／重做／重置前：目前調色滑桿都還只是即時預覽、沒寫回 ctx.doc，導覽完後预覽會對不上
    // 新的目前影像，整個丟掉並把滑桿/預設/換色歸零。
    unsubscribeHistoryNav = ctx.bus.on('history:navigate', () => resetSliders(ctx));
  },
  deactivate(ctx) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (unsubscribeDocChange) {
      unsubscribeDocChange();
      unsubscribeDocChange = null;
    }
    if (unsubscribeHistoryNav) {
      unsubscribeHistoryNav();
      unsubscribeHistoryNav = null;
    }
    picking = false;
    ctx.viewport.setInteraction(null);
    ctx.viewport.setOverlay(null);
    ctx.preview(null);
  },
};
