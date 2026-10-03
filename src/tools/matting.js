// 去背工具：AI 一鍵去背（U²-Net）+ 主體保留/羽化曲線 + 筆刷修補 alpha + 換背景 + 套用/下載透明 PNG。
import '../styles/tool-ai.css';
import { predictAlpha } from '../ai/u2net.js';
import { createCanvas, cloneCanvas, loadImageFromFile } from '../core/canvasUtil.js';
import { blurGrayFloat, drawImageCover, stripExt, downloadCanvasAsPng } from '../ai/util.js';
import { t } from '../core/i18n.js';

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
let lastSourceImage = null; // ctx.doc.getImage() 參照，分辨「真的換圖」vs「同一張圖重新 mount（如切換語言／自己剛 commit）」
let lastPanelEl = null; // mount 時的 panelEl，history:navigate 時用來重畫面板
let unsubscribeHistoryNav = null;

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

// ---------- commit 目前結果 ----------
// 把 ctx.doc.commit() 的結果記成 lastSourceImage：下次這個工具重新 mount（切工具再切回來、切換語言）
// 時，sameImage 判斷會認出「這就是我自己剛 commit 的東西」而不是外部換了新圖，不會誤觸 resetState()
// 把 sourceCanvas/alpha/滑桿狀態整個清掉（sourceCanvas 仍是修補前的原圖，commit 只動 ctx.doc 的歷史，
// 不影響我們內部拿來重算 alpha 的基底）。
function commitCurrentResult(label) {
  const cutout = buildCutout();
  const result = bgMode === 'transparent' ? cutout : composeWithBackground(cutout);
  ctx.commit(result, label);
  lastSourceImage = result;
  ctx.preview(null);
  return result;
}

// ---------- AI 推論 ----------
async function runMatting() {
  if (!ctx.doc.hasImage()) return;
  const result = await ctx.runTask({
    title: t('AI 去背中'),
    async run({ signal, progress }) {
      return predictAlpha(sourceCanvas, { model: modelKey, signal, onProgress: progress });
    },
  });
  if (!result) return; // 取消或失敗：畫面不變
  rawAlpha = result;
  manualCoverage = new Float32Array(w * h);
  manualTarget = new Float32Array(w * h);
  applyCurveAndFeather();
  // 推論完成立刻 commit 一筆，讓復原／重做／重置馬上對這次去背生效，不必等使用者按「套用」。
  commitCurrentResult(t('AI 去背'));
  ctx.toast(t('去背完成'), 'success');
}

function applyResult() {
  if (!finalAlpha) {
    ctx.toast(t('請先執行 AI 去背'), 'error');
    return;
  }
  commitCurrentResult(t('調整去背'));
  ctx.toast(t('已套用去背結果'), 'success');
}

function downloadTransparent() {
  if (!finalAlpha) {
    ctx.toast(t('請先執行 AI 去背'), 'error');
    return;
  }
  const cutout = buildCutout();
  const base = stripExt((ctx.doc.getName && ctx.doc.getName()) || t('圖片'));
  downloadCanvasAsPng(cutout, `${base}-${t('去背')}.png`);
  ctx.toast(t('已下載透明 PNG'), 'success');
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

function mountPanel(panelEl, c) {
    ctx = c;
    panelEl.innerHTML = '';
    lastPanelEl = panelEl;
    const img = ctx.doc.getImage();
    // 同一張圖（參照相同）代表只是重新 mount（例如切換語言面板重畫，或剛好是自己 commitCurrentResult()
    // 產生的那張圖——詳見該函式），保留目前的去背結果/滑桿/筆刷修補狀態；真的換了底圖（外部編輯、
    // 開新圖）才整個重置，且只有這時才重新從 ctx.doc 取用底圖（sourceCanvas 必須一路是「去背前」的
    // 原圖，commitCurrentResult() 之後 ctx.doc 的目前影像已經是合成/透明結果，不能拿來覆寫它）。
    const sameImage = img === lastSourceImage && sourceCanvas != null;
    lastSourceImage = img;
    if (!sameImage) {
      sourceCanvas = cloneCanvas(img);
      resetState();
    }
    w = sourceCanvas.width;
    h = sourceCanvas.height;

    const runBtn = ctx.ui.button(t('AI 一鍵去背'), () => runMatting(), { primary: true, block: true });
    const modelGroup = ctx.ui.buttonGroup(
      [
        { id: 'u2net', label: t('標準 176MB（較準）') },
        { id: 'u2netp', label: t('輕量 4.6MB（較快）') },
      ],
      modelKey,
      (id) => {
        modelKey = id;
      },
    );

    const retainSlider = ctx.ui.slider(t('主體保留'), -50, 50, 1, retain, (v) => {
      retain = v;
      scheduleCurve();
    });
    const featherSlider = ctx.ui.slider(t('邊緣羽化 (px)'), 0, 10, 1, feather, (v) => {
      feather = v;
      scheduleCurve();
    });

    const brushModeGroup = ctx.ui.buttonGroup(
      [
        { id: 'keep', label: t('保留（加回）') },
        { id: 'erase', label: t('擦除') },
      ],
      brushMode,
      (id) => {
        brushMode = id;
      },
    );
    const brushSizeSlider = ctx.ui.slider(t('筆刷大小'), 4, 300, 1, brushSize, (v) => {
      brushSize = v;
    });
    const brushHardnessSlider = ctx.ui.slider(t('筆刷硬度'), 0, 100, 1, Math.round(brushHardness * 100), (v) => {
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
          t('上傳背景圖'),
          (file) => {
            loadImageFromFile(file)
              .then((canvas) => {
                bgImageCanvas = canvas;
                renderPreview();
                ctx.toast(t('背景圖已套用'), 'success');
              })
              .catch(() => ctx.toast(t('背景圖載入失敗'), 'error'));
          },
          { block: true },
        );
        bgSubPanel.appendChild(fb);
        if (!bgImageCanvas) bgSubPanel.appendChild(ctx.ui.el('div', 'ai-hint', t('尚未上傳背景圖（以 cover 方式填滿）')));
      }
    }

    const bgModeGroup = ctx.ui.buttonGroup(
      [
        { id: 'transparent', label: t('透明') },
        { id: 'color', label: t('純色') },
        { id: 'gradient', label: t('漸層') },
        { id: 'image', label: t('圖片') },
        { id: 'blur', label: t('模糊原圖') },
      ],
      bgMode,
      (id) => {
        bgMode = id;
        refreshBgSubPanel();
        renderPreview();
      },
    );
    refreshBgSubPanel();

    const applyBtn = ctx.ui.button(t('套用'), () => applyResult(), { primary: true, block: true });
    const downloadBtn = ctx.ui.button(t('下載透明 PNG'), () => downloadTransparent(), { block: true });

    panelEl.appendChild(ctx.ui.section(t('AI 去背'), [runBtn, modelGroup]));
    panelEl.appendChild(ctx.ui.section(t('調整'), [retainSlider, featherSlider]));
    panelEl.appendChild(
      ctx.ui.section(t('筆刷修補（執行去背後，在畫布上塗抹）'), [brushModeGroup, brushSizeSlider, brushHardnessSlider]),
    );
    panelEl.appendChild(ctx.ui.section(t('換背景'), [bgModeGroup, bgSubPanel]));
    panelEl.appendChild(ctx.ui.section(t('輸出'), [applyBtn, downloadBtn]));

    renderPreview();
}

// 復原／重做／重置前（另一個 core 事件 'history:navigate'，在實際導覽與清預覽之前 emit）：
// 去背這個工具正在編輯的暫存結果（alpha、筆刷修補、換背景設定）此刻都還沒寫回 ctx.doc，
// 導覽完成後它們對不上新的目前影像了，整個丟掉並把面板重畫回初始狀態。
function handleHistoryNavigate(c) {
  resetState();
  c.preview(null);
  if (lastPanelEl) mountPanel(lastPanelEl, c);
}

export default {
  id: 'matting',
  name: '去背',
  icon,
  needsImage: true,
  mount: mountPanel,
  activate(c) {
    ctx = c;
    ctx.viewport.setOverlay(brushOverlay);
    ctx.viewport.setInteraction(brushInteraction);
    unsubscribeHistoryNav = ctx.bus.on('history:navigate', () => handleHistoryNavigate(ctx));
  },
  deactivate(c) {
    ctx = c;
    ctx.viewport.setOverlay(null);
    ctx.viewport.setInteraction(null);
    ctx.preview(null);
    if (unsubscribeHistoryNav) {
      unsubscribeHistoryNav();
      unsubscribeHistoryNav = null;
    }
  },
};
