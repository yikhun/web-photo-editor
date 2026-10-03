// 摳圖工具：AI 一鍵去背（U²-Net）+ 主體保留/羽化曲線 + 筆刷修補 alpha + 換背景 + 套用/下載透明 PNG。
import '../styles/tool-ai.css';
import { predictAlpha } from '../ai/u2net.js';
import { createCanvas, cloneCanvas, loadImageFromFile } from '../core/canvasUtil.js';
import { blurGrayFloat, drawImageCover, stripExt, downloadCanvasAsPng } from '../ai/util.js';

const icon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="7" cy="7" r="3" stroke-width="2"/>
  <circle cx="7" cy="17" r="3" stroke-width="2"/>
  <path d="M9.5 8.5 19 19M19 5 9.5 15.5" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const GRADIENTS = [
  { stops: ['#4f8cff', '#8a5cf5'] },
  { stops: ['#f55c9c', '#ffd166'] },
  { stops: ['#06d6a0', '#1b9aaa'] },
  { stops: ['#232526', '#414345'] },
];

const COLOR_SWATCHES = ['#ffffff', '#000000', '#ff5a5a', '#4f8cff', '#4caf7d', '#e0a13b'];

// ---------- 模組狀態（每次 mount 重置）----------
let ctx = null;
let sourceCanvas = null;
let w = 0;
let h = 0;
let rawAlpha = null; // 模型原始輸出
let curvedAlpha = null; // 套用主體保留＋羽化後
let finalAlpha = null; // 再疊上筆刷修補
let manualCoverage = null;
let manualTarget = null;

let modelKey = 'u2netp';
let retain = 0;
let feather = 0;
let bgMode = 'transparent';
let bgColor = '#ffffff';
let bgGradientIndex = 0;
let bgImageCanvas = null;

let brushMode = 'keep';
let brushSize = 40;
let brushHardness = 0.7;
let mouseImagePoint = null;
let lastPaintPoint = null;
let curveRaf = null;

function resetState() {
  rawAlpha = null;
  curvedAlpha = null;
  finalAlpha = null;
  manualCoverage = null;
  manualTarget = null;
  retain = 0;
  feather = 0;
  bgMode = 'transparent';
  bgColor = '#ffffff';
  bgGradientIndex = 0;
  bgImageCanvas = null;
  brushMode = 'keep';
  brushSize = 40;
  brushHardness = 0.7;
  mouseImagePoint = null;
  lastPaintPoint = null;
}

// ---------- 曲線（門檻＋對比）----------
function applyCurveAndFeather() {
  if (!rawAlpha) return;
  const n = w * h;
  const t = retain / 50; // -1..1
  const center = 0.5 - t * 0.25;
  const k = 1 + Math.abs(t) * 2.5;
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = (rawAlpha[i] - center) * k + 0.5;
    if (v < 0) v = 0;
    else if (v > 1) v = 1;
    arr[i] = v;
  }
  curvedAlpha = feather > 0 ? blurGrayFloat(arr, w, h, feather) : arr;
  recomputeFinal();
  renderPreview();
}

function scheduleCurve() {
  if (curveRaf) return;
  curveRaf = requestAnimationFrame(() => {
    curveRaf = null;
    applyCurveAndFeather();
  });
}

function recomputeFinal() {
  if (!curvedAlpha) return;
  const n = w * h;
  if (!finalAlpha) finalAlpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = manualCoverage ? manualCoverage[i] : 0;
    finalAlpha[i] = cov > 0 ? curvedAlpha[i] * (1 - cov) + manualTarget[i] * cov : curvedAlpha[i];
  }
}

// ---------- 筆刷修補 ----------
function stampBrush(px, py) {
  const r = brushSize / 2;
  if (r <= 0) return;
  const hard = Math.max(0.01, Math.min(1, brushHardness));
  const target = brushMode === 'keep' ? 1 : 0;
  const x0 = Math.max(0, Math.floor(px - r));
  const x1 = Math.min(w - 1, Math.ceil(px + r));
  const y0 = Math.max(0, Math.floor(py - r));
  const y1 = Math.min(h - 1, Math.ceil(py + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - px;
      const dy = y - py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) continue;
      const tt = dist / r;
      let strength = tt <= hard ? 1 : 1 - (tt - hard) / (1 - hard + 1e-6);
      if (strength < 0) strength = 0;
      if (strength > 1) strength = 1;
      const idx = y * w + x;
      if (strength >= manualCoverage[idx]) {
        manualCoverage[idx] = strength;
        manualTarget[idx] = target;
      }
    }
  }
}

function stampLine(p0, p1) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = Math.max(1, brushSize / 4);
  const steps = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= steps; i++) {
    const x = p0.x + (dx * i) / steps;
    const y = p0.y + (dy * i) / steps;
    stampBrush(x, y);
  }
}

// ---------- 合成預覽 ----------
function buildCutout() {
  const out = cloneCanvas(sourceCanvas);
  const octx = out.getContext('2d');
  const id = octx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    id.data[i * 4 + 3] = Math.round((finalAlpha ? finalAlpha[i] : 1) * 255);
  }
  octx.putImageData(id, 0, 0);
  return out;
}

function composeWithBackground(cutout) {
  if (bgMode === 'transparent') return cutout;
  const out = createCanvas(w, h);
  const octx = out.getContext('2d');
  if (bgMode === 'color') {
    octx.fillStyle = bgColor;
    octx.fillRect(0, 0, w, h);
  } else if (bgMode === 'gradient') {
    const g = GRADIENTS[bgGradientIndex] || GRADIENTS[0];
    const grad = octx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, g.stops[0]);
    grad.addColorStop(1, g.stops[1]);
    octx.fillStyle = grad;
    octx.fillRect(0, 0, w, h);
  } else if (bgMode === 'image' && bgImageCanvas) {
    drawImageCover(octx, bgImageCanvas, w, h);
  } else if (bgMode === 'blur') {
    octx.save();
    octx.filter = 'blur(18px)';
    octx.drawImage(sourceCanvas, -16, -16, w + 32, h + 32);
    octx.restore();
  }
  octx.drawImage(cutout, 0, 0);
  return out;
}

function renderPreview() {
  if (!ctx) return;
  if (!finalAlpha) {
    ctx.preview(null);
    return;
  }
  const cutout = buildCutout();
  const composed = composeWithBackground(cutout);
  ctx.preview(composed);
  ctx.viewport.requestRender();
}

// ---------- AI 推論 ----------
async function runMatting() {
  if (!ctx.doc.hasImage()) return;
  const result = await ctx.runTask({
    title: 'AI 摳圖中',
    async run({ signal, progress }) {
      return predictAlpha(sourceCanvas, { model: modelKey, signal, onProgress: progress });
    },
  });
  if (!result) return; // 取消或失敗：畫面不變
  rawAlpha = result;
  manualCoverage = new Float32Array(w * h);
  manualTarget = new Float32Array(w * h);
  applyCurveAndFeather();
  ctx.toast('摳圖完成', 'success');
}

function applyResult() {
  if (!finalAlpha) {
    ctx.toast('請先執行 AI 摳圖', 'error');
    return;
  }
  const cutout = buildCutout();
  if (bgMode === 'transparent') {
    ctx.commit(cutout, '摳圖');
  } else {
    ctx.commit(composeWithBackground(cutout), '摳圖換背景');
  }
  ctx.toast('已套用摳圖結果', 'success');
}

function downloadTransparent() {
  if (!finalAlpha) {
    ctx.toast('請先執行 AI 摳圖', 'error');
    return;
  }
  const cutout = buildCutout();
  const base = stripExt((ctx.doc.getName && ctx.doc.getName()) || '圖片');
  downloadCanvasAsPng(cutout, `${base}-去背.png`);
  ctx.toast('已下載透明 PNG', 'success');
}

// ---------- viewport 互動（筆刷）----------
function brushOverlay(ctx2d, view) {
  if (!mouseImagePoint) return;
  const center = view.imageToScreen(mouseImagePoint.x, mouseImagePoint.y);
  const r = (brushSize / 2) * view.scale;
  ctx2d.save();
  ctx2d.strokeStyle = brushMode === 'keep' ? '#4caf7d' : '#ef5a5a';
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  ctx2d.arc(center.x, center.y, r, 0, Math.PI * 2);
  ctx2d.stroke();
  ctx2d.restore();
}

const brushInteraction = {
  cursor: 'none',
  onPointerDown(e, p) {
    mouseImagePoint = p;
    if (!finalAlpha) return;
    lastPaintPoint = p;
    stampLine(p, p);
    recomputeFinal();
    renderPreview();
  },
  onPointerMove(e, p) {
    mouseImagePoint = p;
    if (!finalAlpha) {
      ctx.viewport.requestRender();
      return;
    }
    if (e.buttons === 1) {
      stampLine(lastPaintPoint || p, p);
      lastPaintPoint = p;
      recomputeFinal();
      renderPreview();
    } else {
      lastPaintPoint = null;
      ctx.viewport.requestRender();
    }
  },
  onPointerUp() {
    lastPaintPoint = null;
  },
};

export default {
  id: 'matting',
  name: '摳圖',
  icon,
  needsImage: true,
  mount(panelEl, c) {
    ctx = c;
    panelEl.innerHTML = '';
    sourceCanvas = cloneCanvas(ctx.doc.getImage());
    w = sourceCanvas.width;
    h = sourceCanvas.height;
    resetState();

    const runBtn = ctx.ui.button('AI 一鍵摳圖', () => runMatting(), { primary: true, block: true });
    const modelGroup = ctx.ui.buttonGroup(
      [
        { id: 'u2net', label: '標準 176MB（較準）' },
        { id: 'u2netp', label: '輕量 4.6MB（較快）' },
      ],
      modelKey,
      (id) => {
        modelKey = id;
      },
    );

    const retainSlider = ctx.ui.slider('主體保留', -50, 50, 1, retain, (v) => {
      retain = v;
      scheduleCurve();
    });
    const featherSlider = ctx.ui.slider('邊緣羽化 (px)', 0, 10, 1, feather, (v) => {
      feather = v;
      scheduleCurve();
    });

    const brushModeGroup = ctx.ui.buttonGroup(
      [
        { id: 'keep', label: '保留（加回）' },
        { id: 'erase', label: '擦除' },
      ],
      brushMode,
      (id) => {
        brushMode = id;
      },
    );
    const brushSizeSlider = ctx.ui.slider('筆刷大小', 4, 300, 1, brushSize, (v) => {
      brushSize = v;
    });
    const brushHardnessSlider = ctx.ui.slider('筆刷硬度', 0, 100, 1, Math.round(brushHardness * 100), (v) => {
      brushHardness = v / 100;
    });

    const bgSubPanel = ctx.ui.el('div');
    function refreshBgSubPanel() {
      bgSubPanel.innerHTML = '';
      if (bgMode === 'color') {
        const swatches = ctx.ui.colorSwatches(COLOR_SWATCHES, bgColor, (c2) => {
          bgColor = c2;
          renderPreview();
        });
        const row = ctx.ui.el('div', 'ai-color-row');
        const customInput = document.createElement('input');
        customInput.type = 'color';
        customInput.className = 'ai-color-input';
        customInput.value = bgColor.startsWith('#') ? bgColor : '#ffffff';
        customInput.addEventListener('input', () => {
          bgColor = customInput.value;
          swatches.setSelected(customInput.value);
          renderPreview();
        });
        row.appendChild(customInput);
        bgSubPanel.appendChild(swatches);
        bgSubPanel.appendChild(row);
      } else if (bgMode === 'gradient') {
        const wrap = ctx.ui.el('div', 'ui-swatches');
        GRADIENTS.forEach((g, i) => {
          const sw = document.createElement('button');
          sw.type = 'button';
          sw.className = 'ai-gradient-swatch' + (i === bgGradientIndex ? ' selected' : '');
          sw.style.background = `linear-gradient(135deg, ${g.stops[0]}, ${g.stops[1]})`;
          sw.addEventListener('click', () => {
            bgGradientIndex = i;
            for (const ch of wrap.children) ch.classList.remove('selected');
            sw.classList.add('selected');
            renderPreview();
          });
          wrap.appendChild(sw);
        });
        bgSubPanel.appendChild(wrap);
      } else if (bgMode === 'image') {
        const fb = ctx.ui.fileButton(
          '上傳背景圖',
          (file) => {
            loadImageFromFile(file)
              .then((canvas) => {
                bgImageCanvas = canvas;
                renderPreview();
                ctx.toast('背景圖已套用', 'success');
              })
              .catch(() => ctx.toast('背景圖載入失敗', 'error'));
          },
          { block: true },
        );
        bgSubPanel.appendChild(fb);
        if (!bgImageCanvas) bgSubPanel.appendChild(ctx.ui.el('div', 'ai-hint', '尚未上傳背景圖（以 cover 方式填滿）'));
      }
    }

    const bgModeGroup = ctx.ui.buttonGroup(
      [
        { id: 'transparent', label: '透明' },
        { id: 'color', label: '純色' },
        { id: 'gradient', label: '漸層' },
        { id: 'image', label: '圖片' },
        { id: 'blur', label: '模糊原圖' },
      ],
      bgMode,
      (id) => {
        bgMode = id;
        refreshBgSubPanel();
        renderPreview();
      },
    );
    refreshBgSubPanel();

    const applyBtn = ctx.ui.button('套用', () => applyResult(), { primary: true, block: true });
    const downloadBtn = ctx.ui.button('下載透明 PNG', () => downloadTransparent(), { block: true });

    panelEl.appendChild(ctx.ui.section('AI 摳圖', [runBtn, modelGroup]));
    panelEl.appendChild(ctx.ui.section('調整', [retainSlider, featherSlider]));
    panelEl.appendChild(
      ctx.ui.section('筆刷修補（執行摳圖後，在畫布上塗抹）', [brushModeGroup, brushSizeSlider, brushHardnessSlider]),
    );
    panelEl.appendChild(ctx.ui.section('換背景', [bgModeGroup, bgSubPanel]));
    panelEl.appendChild(ctx.ui.section('輸出', [applyBtn, downloadBtn]));

    renderPreview();
  },
  activate(c) {
    ctx = c;
    ctx.viewport.setOverlay(brushOverlay);
    ctx.viewport.setInteraction(brushInteraction);
  },
  deactivate(c) {
    ctx = c;
    ctx.viewport.setOverlay(null);
    ctx.viewport.setInteraction(null);
    ctx.preview(null);
  },
};
