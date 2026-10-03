// 消除圖工具：框選水印（含智慧偵測文字/Logo）+ 塗抹消除（放開滑鼠自動執行），皆呼叫 ai/migan.js 的 inpaint。
import '../styles/tool-ai.css';
import { inpaint } from '../ai/migan.js';
import { createCanvas, cloneCanvas } from '../core/canvasUtil.js';
import { t } from '../core/i18n.js';

const icon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 20H9l-6-6 10-10 6 6-7 7m-7-1 7 7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ---------- 模組狀態 ----------
let ctx = null;
let w = 0;
let h = 0;
let workingCanvas = null; // 目前這個工具 session 的工作底圖（每次成功消除後更新）
let mode = 'box'; // 'box' | 'brush'

let boxes = []; // { x0,y0,x1,y1 } 影像座標
let drawingBox = null;
let smartDetect = true;
let boxListEl = null;

let brushSize = 36;
let isStroking = false;
let currentStrokeMask = null; // Float32Array(w*h)，0~1
let strokeBBox = null; // { x0,y0,x1,y1 } 累積畫過的範圍（含）
let mouseImagePoint = null;
let lastDocImage = null; // ctx.doc.getImage() 參照，分辨「真的換圖」vs「同一張圖重新 mount（如切換語言／自己剛 commit）」
let lastPanelEl = null; // mount 時的 panelEl，history:navigate 時用來重畫面板
let unsubscribeHistoryNav = null;

function resetState() {
  mode = 'box';
  boxes = [];
  drawingBox = null;
  smartDetect = true;
  brushSize = 36;
  isStroking = false;
  currentStrokeMask = null;
  strokeBBox = null;
  mouseImagePoint = null;
}

function normalizeBox(b) {
  return {
    x0: Math.max(0, Math.min(b.x0, b.x1)),
    y0: Math.max(0, Math.min(b.y0, b.y1)),
    x1: Math.min(w, Math.max(b.x0, b.x1)),
    y1: Math.min(h, Math.max(b.y0, b.y1)),
  };
}

function expandBox(box, pad) {
  return {
    x0: Math.max(0, Math.round(box.x0 - pad)),
    y0: Math.max(0, Math.round(box.y0 - pad)),
    x1: Math.min(w, Math.round(box.x1 + pad)),
    y1: Math.min(h, Math.round(box.y1 + pad)),
  };
}

function buildBoxMask(box) {
  const maskCanvas = createCanvas(w, h);
  const mctx = maskCanvas.getContext('2d');
  mctx.fillStyle = '#fff';
  mctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  return maskCanvas;
}

// 框內邊緣/亮度差異偵測：只遮住與區域平均亮度差異大的像素（文字/Logo 筆畫），膨脹 3~5px。
// 覆蓋率 <3% 或 >85% 時回傳 null，呼叫端應退回整框。
function smartDetectMask(canvas, box) {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  if (bw < 2 || bh < 2) return null;
  const crop = createCanvas(bw, bh);
  crop.getContext('2d').drawImage(canvas, box.x0, box.y0, bw, bh, 0, 0, bw, bh);
  const data = crop.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bw, bh).data;
  const n = bw * bh;
  const gray = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    gray[i] = g;
    sum += g;
  }
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = gray[i] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / n) || 1;

  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(gray[i] - mean) / std > 0.9) {
      mask[i] = 1;
      count++;
    }
  }
  const coverage = count / n;
  if (coverage < 0.03 || coverage > 0.85) return null;

  // 2026-10-03 更正：先前把膨脹半徑從規格建議的 3~5px 大幅加到 18px，理由是「只膨脹 4px
  // 時模型傾向延伸白色筆畫而非背景」——這個診斷是錯的。實測（見 src/ai/migan.js 檔頭註解與
  // _research/migan-debug/experiment.py）確認問題出在 migan.js 送進模型的 mask 語意反了
  // （真正語意是 0=hole/255=keep，之前當成 255=hole/0=keep），導致洞一律被模型當成「已知、
  // 要保留」，不管膨脹多少都補不進去，18px 只是放大了「幾乎沒變化」的範圍，徒增運算量與
  // 誤傷鄰近內容的風險。語意修正後改回規格建議值（4px），ROI 的背景脈絡則交給
  // migan.js 的 computeRoi（每邊至少 48px 或洞短邊 1 倍）處理。
  const dilated = dilateMask(mask, bw, bh, 4);

  const maskCanvas = createCanvas(w, h);
  const mctx = maskCanvas.getContext('2d');
  const full = mctx.createImageData(w, h);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (!dilated[y * bw + x]) continue;
      const gi = ((box.y0 + y) * w + (box.x0 + x)) * 4;
      full.data[gi] = 255;
      full.data[gi + 1] = 255;
      full.data[gi + 2] = 255;
      full.data[gi + 3] = 255;
    }
  }
  mctx.putImageData(full, 0, 0);
  return maskCanvas;
}

// 可分離的方形膨脹（先橫向、再縱向各做一次 max-filter），O(w*h*r) 而非 O(w*h*r^2)，
// r=18 這種量級若用原本的圓形暴力雙層迴圈會明顯變慢。形狀變成方形而非正圓，
// 對「遮住文字周圍」這個用途沒有差別。
function dilateMask(mask, mw, mh, r) {
  const temp = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    for (let x = 0; x < mw; x++) {
      let hit = 0;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(mw - 1, x + r);
      for (let xx = x0; xx <= x1; xx++) {
        if (mask[row + xx]) {
          hit = 1;
          break;
        }
      }
      temp[row + x] = hit;
    }
  }
  const out = new Uint8Array(mw * mh);
  for (let x = 0; x < mw; x++) {
    for (let y = 0; y < mh; y++) {
      let hit = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(mh - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) {
        if (temp[yy * mw + x]) {
          hit = 1;
          break;
        }
      }
      out[y * mw + x] = hit;
    }
  }
  return out;
}

function floatMaskToCanvas(maskFloat) {
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d');
  const id = c.createImageData(w, h);
  for (let i = 0; i < maskFloat.length; i++) {
    const a = Math.round(maskFloat[i] * 255);
    id.data[i * 4] = 255;
    id.data[i * 4 + 1] = 255;
    id.data[i * 4 + 2] = 255;
    id.data[i * 4 + 3] = a;
  }
  c.putImageData(id, 0, 0);
  return canvas;
}

// ---------- 框選模式 ----------
function refreshBoxList() {
  if (!boxListEl) return;
  boxListEl.innerHTML = '';
  boxes.forEach((b, i) => {
    const row = ctx.ui.el('div', 'ai-box-list-item');
    row.appendChild(
      ctx.ui.el('span', null, t('框 {n}（{w}×{h}px）', { n: i + 1, w: Math.round(b.x1 - b.x0), h: Math.round(b.y1 - b.y0) })),
    );
    const delBtn = ctx.ui.button(t('刪除'), () => {
      boxes.splice(i, 1);
      refreshBoxList();
      ctx.viewport.requestRender();
    });
    row.appendChild(delBtn);
    boxListEl.appendChild(row);
  });
  if (boxes.length === 0) {
    boxListEl.appendChild(ctx.ui.el('div', 'ai-hint', t('尚未框選任何區域，在畫布上拖曳畫框')));
  }
}

async function removeWatermark() {
  if (boxes.length === 0) return;
  const beforeSnapshot = cloneCanvas(workingCanvas);
  const todoBoxes = boxes.slice();
  const result = await ctx.runTask({
    title: t('移除水印中'),
    async run({ signal, progress }) {
      let current = cloneCanvas(workingCanvas);
      for (let i = 0; i < todoBoxes.length; i++) {
        if (signal.aborted) throw new DOMException(t('使用者已取消'), 'AbortError');
        const expanded = expandBox(todoBoxes[i], 4);
        let maskCanvas = null;
        if (smartDetect) maskCanvas = smartDetectMask(current, expanded);
        if (!maskCanvas) maskCanvas = buildBoxMask(expanded);
        current = await inpaint(current, maskCanvas, {
          signal,
          onProgress: (p, text) =>
            progress((i + p) / todoBoxes.length, text || t('處理第 {i}/{n} 個框', { i: i + 1, n: todoBoxes.length })),
        });
      }
      return current;
    },
  });
  if (!result) return;
  workingCanvas = result;
  ctx.commit(result, t('消除水印'));
  lastDocImage = result; // 自己 commit 的結果：記住參照，之後重新 mount 才不會被誤判成外部換圖而整個重置
  ctx.showCompare(beforeSnapshot, result);
  boxes = [];
  refreshBoxList();
  ctx.toast(t('已移除水印'), 'success');
}

const boxInteraction = {
  cursor: 'crosshair',
  onPointerDown(e, p) {
    drawingBox = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  },
  onPointerMove(e, p) {
    if (drawingBox) {
      drawingBox.x1 = p.x;
      drawingBox.y1 = p.y;
      ctx.viewport.requestRender();
    }
  },
  onPointerUp() {
    if (drawingBox) {
      const b = normalizeBox(drawingBox);
      drawingBox = null;
      if (b.x1 - b.x0 > 3 && b.y1 - b.y0 > 3) {
        boxes.push(b);
        refreshBoxList();
      }
      ctx.viewport.requestRender();
    }
  },
};

function drawBoxRect(ctx2d, view, b, dashed) {
  const topLeft = view.imageToScreen(b.x0, b.y0);
  const bottomRight = view.imageToScreen(b.x1, b.y1);
  ctx2d.save();
  ctx2d.strokeStyle = '#4f8cff';
  ctx2d.lineWidth = 2;
  if (dashed) ctx2d.setLineDash([6, 4]);
  ctx2d.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx2d.restore();
}

// ---------- 塗抹模式 ----------
function stampCircle(maskFloat, px, py, r) {
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
      const strength = 1 - dist / r;
      const idx = y * w + x;
      if (strength > maskFloat[idx]) maskFloat[idx] = strength;
    }
  }
  if (!strokeBBox) {
    strokeBBox = { x0, y0, x1, y1 };
  } else {
    strokeBBox.x0 = Math.min(strokeBBox.x0, x0);
    strokeBBox.y0 = Math.min(strokeBBox.y0, y0);
    strokeBBox.x1 = Math.max(strokeBBox.x1, x1);
    strokeBBox.y1 = Math.max(strokeBBox.y1, y1);
  }
}

async function performBrushErase(maskFloat) {
  const maskCanvas = floatMaskToCanvas(maskFloat);
  const beforeSnapshot = cloneCanvas(workingCanvas);
  const baseCanvas = workingCanvas;
  const result = await ctx.runTask({
    title: t('消除中'),
    async run({ signal, progress }) {
      return inpaint(baseCanvas, maskCanvas, { signal, onProgress: progress });
    },
  });
  if (!result) return;
  workingCanvas = result;
  ctx.commit(result, t('塗抹消除'));
  lastDocImage = result; // 同上：避免自己 commit 的結果被下一次 mount 誤判成外部換圖
  ctx.showCompare(beforeSnapshot, result);
  ctx.toast(t('已消除'), 'success');
}

function drawStrokeOverlay(ctx2d, view) {
  if (!currentStrokeMask || !strokeBBox) return;
  const bw = strokeBBox.x1 - strokeBBox.x0 + 1;
  const bh = strokeBBox.y1 - strokeBBox.y0 + 1;
  if (bw <= 0 || bh <= 0) return;
  const small = createCanvas(bw, bh);
  const sc = small.getContext('2d');
  const id = sc.createImageData(bw, bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const v = currentStrokeMask[(strokeBBox.y0 + y) * w + (strokeBBox.x0 + x)];
      const idx = (y * bw + x) * 4;
      id.data[idx] = 239;
      id.data[idx + 1] = 90;
      id.data[idx + 2] = 90;
      id.data[idx + 3] = Math.round(v * 160);
    }
  }
  sc.putImageData(id, 0, 0);
  const topLeft = view.imageToScreen(strokeBBox.x0, strokeBBox.y0);
  ctx2d.drawImage(small, topLeft.x, topLeft.y, bw * view.scale, bh * view.scale);
}

const brushInteraction = {
  cursor: 'none',
  onPointerDown(e, p) {
    mouseImagePoint = p;
    isStroking = true;
    currentStrokeMask = new Float32Array(w * h);
    strokeBBox = null;
    stampCircle(currentStrokeMask, p.x, p.y, brushSize / 2);
    ctx.viewport.requestRender();
  },
  onPointerMove(e, p) {
    mouseImagePoint = p;
    if (isStroking && currentStrokeMask) {
      stampCircle(currentStrokeMask, p.x, p.y, brushSize / 2);
    }
    ctx.viewport.requestRender();
  },
  onPointerUp() {
    if (isStroking && currentStrokeMask) {
      const maskFloat = currentStrokeMask;
      currentStrokeMask = null;
      strokeBBox = null;
      isStroking = false;
      performBrushErase(maskFloat);
    }
    isStroking = false;
  },
};

// ---------- overlay / interaction 依模式切換 ----------
function overlay(ctx2d, view) {
  if (mode === 'box') {
    for (const b of boxes) drawBoxRect(ctx2d, view, b, false);
    if (drawingBox) drawBoxRect(ctx2d, view, normalizeBox(drawingBox), true);
  } else {
    drawStrokeOverlay(ctx2d, view);
    if (mouseImagePoint) {
      const c = view.imageToScreen(mouseImagePoint.x, mouseImagePoint.y);
      ctx2d.save();
      ctx2d.strokeStyle = '#ef5a5a';
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.arc(c.x, c.y, (brushSize / 2) * view.scale, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.restore();
    }
  }
}

function currentInteraction() {
  return mode === 'box' ? boxInteraction : brushInteraction;
}

function mountPanel(panelEl, c) {
    ctx = c;
    panelEl.innerHTML = '';
    lastPanelEl = panelEl;
    const img = ctx.doc.getImage();
    // 同一張圖（參照相同）代表只是重新 mount（例如切換語言面板重畫），保留目前框選清單/模式/
    // 筆刷設定；真的換了底圖（doc:change 來的新 canvas）才整個重置。
    const sameImage = img === lastDocImage && workingCanvas != null;
    lastDocImage = img;
    workingCanvas = cloneCanvas(img);
    w = workingCanvas.width;
    h = workingCanvas.height;
    if (!sameImage) resetState();

    const modeGroup = ctx.ui.buttonGroup(
      [
        { id: 'box', label: t('框選水印') },
        { id: 'brush', label: t('塗抹消除') },
      ],
      mode,
      (id) => {
        mode = id;
        drawingBox = null;
        currentStrokeMask = null;
        strokeBBox = null;
        isStroking = false;
        mouseImagePoint = null;
        ctx.viewport.setInteraction(currentInteraction());
        refreshPanel();
        ctx.viewport.requestRender();
      },
    );

    const sectionsHost = ctx.ui.el('div');

    function refreshPanel() {
      sectionsHost.innerHTML = '';
      if (mode === 'box') {
        boxListEl = ctx.ui.el('div', 'ai-box-list');
        refreshBoxList();

        const smartToggle = ctx.ui.toggle(t('智慧偵測文字/Logo（只遮住筆畫，覆蓋率過低/過高自動退回整框）'), smartDetect, (v) => {
          smartDetect = v;
        });

        const clearBtn = ctx.ui.button(t('清除全部框'), () => {
          boxes = [];
          refreshBoxList();
          ctx.viewport.requestRender();
        });
        const removeBtn = ctx.ui.button(t('移除水印'), () => removeWatermark(), { primary: true, block: true });

        sectionsHost.appendChild(
          ctx.ui.section(t('在畫布上拖曳畫出水印框'), [boxListEl, clearBtn]),
        );
        sectionsHost.appendChild(ctx.ui.section(t('選項'), [smartToggle]));
        sectionsHost.appendChild(ctx.ui.section(t('執行'), [removeBtn]));
      } else {
        const brushSizeSlider = ctx.ui.slider(t('筆刷大小'), 6, 200, 1, brushSize, (v) => {
          brushSize = v;
        });
        sectionsHost.appendChild(
          ctx.ui.section(t('在畫布上塗抹要消除的區域'), [
            brushSizeSlider,
            ctx.ui.el('div', 'ai-hint', t('放開滑鼠即自動執行消除，不需另外按按鈕')),
          ]),
        );
      }
    }
    refreshPanel();

    panelEl.appendChild(ctx.ui.section(t('模式'), [modeGroup]));
    panelEl.appendChild(sectionsHost);
}

// 復原／重做／重置前：還沒執行的框選清單／畫到一半的塗抹都對不上新的目前影像了，清掉並重畫面板。
function handleHistoryNavigate(c) {
  boxes = [];
  drawingBox = null;
  currentStrokeMask = null;
  strokeBBox = null;
  isStroking = false;
  mouseImagePoint = null;
  c.viewport.requestRender();
  if (lastPanelEl) mountPanel(lastPanelEl, c);
}

export default {
  id: 'erase',
  name: '消除圖',
  icon,
  needsImage: true,
  mount: mountPanel,
  activate(c) {
    ctx = c;
    ctx.viewport.setOverlay(overlay);
    ctx.viewport.setInteraction(currentInteraction());
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
