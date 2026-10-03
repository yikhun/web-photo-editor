// 變清晰工具：AI 超解析 2x/4x（Real-ESRGAN 快速 / Upscayl 標準 / Upscayl 數位藝術 三選一），呼叫 ai/esrgan.js 的 upscale。
import '../styles/tool-enhance.css';
import { upscale, planUpscale, estimateTileCount } from '../ai/esrgan.js';
import { getBackend } from '../ai/ort.js';
import { cloneCanvas } from '../core/canvasUtil.js';
import { resizeCanvas } from '../ai/util.js';

const icon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4L12 3z" stroke-width="2" stroke-linejoin="round"/>
  <path d="M19 15l.7 1.8L21.5 17l-1.8.7L19 19.5l-.7-1.8-1.8-.7 1.8-.7L19 15z" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

const MODEL_OPTIONS = [
  { id: 'realesrgan-fast', title: 'Real-ESRGAN 快速', desc: '速度最快，一般照片放大堪用', sizeLabel: '約 5MB' },
  { id: 'upscayl-standard', title: 'Upscayl 標準', desc: '同 Real-ESRGAN x4plus，照片寫實', sizeLabel: '約 67MB' },
  { id: 'upscayl-digital-art', title: 'Upscayl 數位藝術', desc: '同 Real-ESRGAN anime 6B，插畫/動漫', sizeLabel: '約 18MB' },
];

// ---------- 模組狀態（每次 mount 重置）----------
let ctx = null;
let modelKey = 'realesrgan-fast';
let scale = 4;
let modelCardEls = [];
let sizeInfoEl = null;
let backendInfoEl = null;
let startBtn = null;

function resetState() {
  modelKey = 'realesrgan-fast';
  scale = 4;
}

function updateModelCardSelection() {
  modelCardEls.forEach((card, i) => card.classList.toggle('selected', MODEL_OPTIONS[i].id === modelKey));
}

function updateSizeInfo() {
  if (!ctx || !sizeInfoEl || !ctx.doc.hasImage()) return;
  const img = ctx.doc.getImage();
  const plan = planUpscale(img.width, img.height, scale);
  const tiles = estimateTileCount(img.width, img.height, modelKey, scale);
  // 粗估：每個區塊以 WebGPU 約 0.3 秒、wasm 約 1.5 秒估（僅供參考，實際視裝置差異很大）
  const backend = getBackend();
  const perTile = backend === 'wasm' ? 1.5 : 0.3;
  const estSeconds = Math.max(1, Math.round(tiles * perTile));
  const estText = estSeconds >= 60 ? `約 ${Math.ceil(estSeconds / 60)} 分鐘` : `約 ${estSeconds} 秒`;

  sizeInfoEl.innerHTML = '';
  sizeInfoEl.appendChild(
    ctx.ui.el('div', null, `目前 ${img.width}×${img.height} → 輸出 ${plan.finalW}×${plan.finalH}`),
  );
  sizeInfoEl.appendChild(ctx.ui.el('div', null, `預估切成 ${tiles} 個區塊，耗時${estText}（粗估，依裝置效能而異）`));
  if (plan.tooLarge) {
    sizeInfoEl.appendChild(
      ctx.ui.el(
        'div',
        'enhance-warning',
        `輸出過大（中間放大尺寸 ${plan.outW4x}×${plan.outH4x}，超過約 8000 萬像素上限），請先縮小圖片或改用較低倍率`,
      ),
    );
  }
  if (startBtn) startBtn.disabled = plan.tooLarge;
}

function updateBackendInfo() {
  if (!backendInfoEl) return;
  const backend = getBackend();
  backendInfoEl.textContent = backend
    ? `目前推論後端：${backend === 'webgpu' ? 'WebGPU' : 'WASM（CPU，較慢）'}`
    : '推論後端：尚未建立（執行時優先嘗試 WebGPU，失敗退回 WASM）';
}

function buildModelCards() {
  const wrap = ctx.ui.el('div', 'enhance-model-cards');
  modelCardEls = MODEL_OPTIONS.map((opt) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'enhance-model-card' + (opt.id === modelKey ? ' selected' : '');
    card.appendChild(ctx.ui.el('div', 'enhance-model-title', opt.title));
    card.appendChild(ctx.ui.el('div', 'enhance-model-desc', opt.desc));
    card.appendChild(ctx.ui.el('div', 'enhance-model-size', opt.sizeLabel));
    card.addEventListener('click', () => {
      modelKey = opt.id;
      updateModelCardSelection();
      updateSizeInfo();
    });
    wrap.appendChild(card);
    return card;
  });
  return wrap;
}

async function runEnhance() {
  if (!ctx.doc.hasImage()) return;
  const before = cloneCanvas(ctx.doc.getImage());
  const beforeForCompare = resizeCanvas(
    before,
    Math.round(before.width * (scale === 2 ? 2 : 4)),
    Math.round(before.height * (scale === 2 ? 2 : 4)),
  );

  const result = await ctx.runTask({
    title: 'AI 變清晰中',
    async run({ signal, progress }) {
      return upscale(before, { model: modelKey, scale, signal, onProgress: progress });
    },
  });
  if (!result) return; // 取消或失敗：畫面不變

  ctx.commit(result, `AI 放大 ${scale}x`);
  ctx.showCompare(beforeForCompare, result);
  ctx.toast('已完成變清晰', 'success');
  updateBackendInfo();
  updateSizeInfo();
}

export default {
  id: 'enhance',
  name: '變清晰',
  icon,
  needsImage: true,
  mount(panelEl, c) {
    ctx = c;
    panelEl.innerHTML = '';
    resetState();

    const modelCards = buildModelCards();

    const scaleGroup = ctx.ui.buttonGroup(
      [
        { id: '2', label: '2 倍' },
        { id: '4', label: '4 倍' },
      ],
      String(scale),
      (id) => {
        scale = Number(id);
        updateSizeInfo();
      },
    );

    sizeInfoEl = ctx.ui.el('div', 'enhance-size-info');
    backendInfoEl = ctx.ui.el('div', 'enhance-backend-info');
    startBtn = ctx.ui.button('開始變清晰', () => runEnhance(), { primary: true, block: true });

    panelEl.appendChild(ctx.ui.section('模型', [modelCards]));
    panelEl.appendChild(ctx.ui.section('倍率', [scaleGroup]));
    panelEl.appendChild(ctx.ui.section('輸出尺寸', [sizeInfoEl]));
    panelEl.appendChild(ctx.ui.section('執行', [startBtn, backendInfoEl]));

    updateSizeInfo();
    updateBackendInfo();
  },
  activate(c) {
    ctx = c;
  },
  deactivate(c) {
    ctx = c;
    ctx.preview(null);
  },
};
