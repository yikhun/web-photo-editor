// Real-ESRGAN / Upscayl 超解析推論：upscale(canvas, {model, scale, maxSide, signal, onProgress}) -> Promise<HTMLCanvasElement>
// 三個模型皆為官方 4x checkpoint 的「固定輸入尺寸」ONNX（查證依據 _research/models/models.md §3、§4）：
//   realesrgan-fast      384×384 → 1536×1536（Saimon8420 轉出，實測可上 WebGPU）
//   upscayl-standard     128×128 → 512×512（對應官方 Real-ESRGAN x4plus 權重）
//   upscayl-digital-art  128×128 → 512×512（對應官方 Real-ESRGAN x4plus anime 6B 權重）
// 三者前處理一致：RGB，數值 /255 到 [0,1]，不做 mean/std 正規化，NCHW；輸入/輸出張量名稱一律用
// session.inputNames[0] / outputNames[0] 動態取得，不寫死字串。
//
// 分塊（tile）：固定輸入尺寸 T，重疊 overlap = max(8, T/8)；圖片任一邊小於 T 時用邊緣延伸補滿到 T。
// 拼接時用「加權累加 + 最後除以權重總和」的做法（而非直接覆寫），每個 tile 在重疊帶兩側做線性羽化權重，
// 這樣不要求 tile 之間的權重精準互補也能避免接縫（常見的 tiled 推論拼接手法）。
// alpha 通道不進模型，另外用 canvas 高品質縮放處理後合併回去。
//
// 效能調查備註（2026-10-03 實測，詳見 _research/upscale-perf.md）：影片逐格放大每格的主要耗時
// 幾乎全部落在 session.run() 本身（本機 Intel Arc iGPU、webgpu backend，384→1536 單一 tile
// 穩定態約 2~4.5 秒／格），用完全獨立於 mediabunny/canvas 流程之外的隔離測試（同一個已快取
// session、合成輸入、不經過影片解碼與畫布繪製）重現了同樣量級的耗時，證實瓶頸在 session.run()
// 內部，不在本檔或呼叫端的前後處理（getImageData/前處理/blend/mergeAlpha 皆 <150ms）。因此
// session 重建、wasm 退回、tile 數過多（確認每格僅 1 個 384 tile）、canvas 前後處理過重
// 這幾個嫌疑皆已排除。曾嘗試用 tile 暫存畫布／colorAcc·weightAcc 累加陣列跨格重複利用來
// 省掉每格的記憶體配置，但這類模組層級共享可變狀態在「同時存在兩個影片工作區實例」
// （#/video 分頁與左側「影片摳圖」工具各自呼叫 upscale()）同時輸出時會有資料互相覆寫的風險，
// 相對於 session.run() 本身 2~4.5 秒的量級，省下的配置時間（數十毫秒）不值得冒這個險，
// 因此未採用，本檔維持原邏輯。
import { getSession, getOrt, getBackend } from './ort.js';
import { createCanvas } from '../core/canvasUtil.js';
import { checkAborted, resizeCanvas } from './util.js';

const TILE_SIZE = {
  'realesrgan-fast': 384,
  'upscayl-standard': 128,
  'upscayl-digital-art': 128,
};

const NATIVE_SCALE = 4; // 三個模型內部都是固定 4x，scale=2 時另外用 canvas 縮小一半
export const MAX_OUTPUT_PIXELS = 80_000_000; // 約 8000 萬像素（例如 4x 後 > 9000×9000）

export { getBackend };

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// 計算 1 維方向上，覆蓋長度 L、tile 尺寸 T、重疊 overlap 的 tile 起點清單（最後一塊貼齊邊界）
function tileStarts(L, T, overlap) {
  if (L <= T) return [0];
  const stride = Math.max(1, T - overlap);
  const starts = [];
  let x = 0;
  while (x + T < L) {
    starts.push(x);
    x += stride;
  }
  const last = Math.max(0, L - T);
  if (starts.length === 0 || starts[starts.length - 1] !== last) starts.push(last);
  return starts;
}

// 依 maxSide / 大圖保護，計算這次放大實際要跑的尺寸規劃（引擎與面板共用，確保顯示與實際行為一致）
// plan.workW/workH：實際餵進模型的輸入尺寸（maxSide 需要時會先縮小）
// plan.outW4x/outH4x：模型固定 4x 推論後的中間尺寸（大圖保護門檻用這個，因為這是實際記憶體峰值）
// plan.finalW/finalH：scale 套用後的最終輸出尺寸（面板顯示用）
export function planUpscale(srcW, srcH, scale, maxSide) {
  const requestedScale = scale === 2 ? 2 : 4;
  let workW = srcW;
  let workH = srcH;
  if (maxSide) {
    const projectedLong = Math.max(srcW, srcH) * requestedScale;
    if (projectedLong > maxSide) {
      const shrink = maxSide / projectedLong;
      workW = Math.max(1, Math.round(srcW * shrink));
      workH = Math.max(1, Math.round(srcH * shrink));
    }
  }
  const outW4x = workW * NATIVE_SCALE;
  const outH4x = workH * NATIVE_SCALE;
  const finalW = Math.round(workW * requestedScale);
  const finalH = Math.round(workH * requestedScale);
  return {
    workW,
    workH,
    outW4x,
    outH4x,
    finalW,
    finalH,
    requestedScale,
    tooLarge: outW4x * outH4x > MAX_OUTPUT_PIXELS,
  };
}

// 面板用：預估這次放大會切成幾個 tile（純粗估耗時用，不影響實際推論）
export function estimateTileCount(srcW, srcH, model, scale, maxSide) {
  const T = TILE_SIZE[model];
  if (!T) return 0;
  const plan = planUpscale(srcW, srcH, scale, maxSide);
  const overlap = Math.max(8, Math.floor(T / 8));
  const xs = tileStarts(plan.workW, T, overlap);
  const ys = tileStarts(plan.workH, T, overlap);
  return xs.length * ys.length;
}

// 把來源畫布裁出一塊 T×T 的 tile；超出畫布邊界的部分用邊緣延伸（重複最後一列/行像素）補滿
function extractTilePadded(src, x0, y0, T) {
  const w = src.width;
  const h = src.height;
  const tile = createCanvas(T, T);
  const tctx = tile.getContext('2d', { willReadFrequently: true });
  const availW = Math.min(T, w - x0);
  const availH = Math.min(T, h - y0);
  tctx.drawImage(src, x0, y0, availW, availH, 0, 0, availW, availH);
  if (availW < T) {
    // 右側：把最後一欄像素橫向拉伸補滿
    tctx.drawImage(tile, availW - 1, 0, 1, availH, availW, 0, T - availW, availH);
  }
  if (availH < T) {
    // 下側：把（含右側已補好的）最後一列像素縱向拉伸補滿
    tctx.drawImage(tile, 0, availH - 1, T, 1, 0, availH, T, T - availH);
  }
  return { tile, availW, availH };
}

async function inferTile(session, ort, tileCanvas, T) {
  const tctx = tileCanvas.getContext('2d', { willReadFrequently: true });
  const { data } = tctx.getImageData(0, 0, T, T);
  const n = T * T;
  const chw = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    chw[i] = data[i * 4] / 255;
    chw[n + i] = data[i * 4 + 1] / 255;
    chw[2 * n + i] = data[i * 4 + 2] / 255;
  }
  const inputName = session.inputNames[0];
  const inputTensor = new ort.Tensor('float32', chw, [1, 3, T, T]);
  const outputs = await session.run({ [inputName]: inputTensor });
  const outName = session.outputNames[0];
  return outputs[outName]; // ort.Tensor，CHW，長度預期 3*(T*NATIVE_SCALE)^2，數值約在 [0,1]（未必嚴格 clamp）
}

// 建立 1 維羽化權重：在「前方還有鄰近 tile」/「後方還有鄰近 tile」的那一側，於 rampLen 範圍內線性斜坡，
// 其餘區域權重為 1。最終像素值用「所有覆蓋到的 tile 的加權和 / 權重和」合成，不要求斜坡精準互補。
function build1DWeight(length, hasBefore, hasAfter, rampLen) {
  const w = new Float32Array(length);
  const r = Math.max(0, Math.min(rampLen, Math.floor(length / 2)));
  for (let i = 0; i < length; i++) {
    let v = 1;
    if (hasBefore && r > 0 && i < r) v = Math.min(v, (i + 1) / (r + 1));
    if (hasAfter && r > 0 && i >= length - r) v = Math.min(v, (length - i) / (r + 1));
    w[i] = Math.max(v, 0.001);
  }
  return w;
}

function blendTileInto(colorAcc, weightAcc, outW, outH, tensor, OT, x0, y0, availW, availH, scale, overlap, srcW, srcH) {
  const data = tensor.data;
  const validOutW = Math.round(availW * scale);
  const validOutH = Math.round(availH * scale);
  const rampLen = overlap * scale;
  const wx = build1DWeight(validOutW, x0 > 0, x0 + availW < srcW, rampLen);
  const wy = build1DWeight(validOutH, y0 > 0, y0 + availH < srcH, rampLen);
  const baseX = Math.round(x0 * scale);
  const baseY = Math.round(y0 * scale);
  const n = OT * OT;
  for (let yy = 0; yy < validOutH; yy++) {
    const rowOff = yy * OT;
    const wyv = wy[yy];
    const gy = baseY + yy;
    for (let xx = 0; xx < validOutW; xx++) {
      const srcIdx = rowOff + xx;
      const weight = wx[xx] * wyv;
      const gx = baseX + xx;
      const gIdx = gy * outW + gx;
      colorAcc[gIdx * 3] += data[srcIdx] * weight;
      colorAcc[gIdx * 3 + 1] += data[n + srcIdx] * weight;
      colorAcc[gIdx * 3 + 2] += data[2 * n + srcIdx] * weight;
      weightAcc[gIdx] += weight;
    }
  }
}

function finalizeCanvas(colorAcc, weightAcc, w, h) {
  const canvas = createCanvas(w, h);
  const cctx = canvas.getContext('2d');
  const id = cctx.createImageData(w, h);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const wgt = weightAcc[i] || 1;
    id.data[i * 4] = clamp255((colorAcc[i * 3] / wgt) * 255);
    id.data[i * 4 + 1] = clamp255((colorAcc[i * 3 + 1] / wgt) * 255);
    id.data[i * 4 + 2] = clamp255((colorAcc[i * 3 + 2] / wgt) * 255);
    id.data[i * 4 + 3] = 255;
  }
  cctx.putImageData(id, 0, 0);
  return canvas;
}

async function runTiledUpscale(session, ort, srcCanvas, T, nativeScale, { signal, onProgress }) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const overlap = Math.max(8, Math.floor(T / 8));
  const xs = tileStarts(w, T, overlap);
  const ys = tileStarts(h, T, overlap);
  const total = xs.length * ys.length;
  const outW = w * nativeScale;
  const outH = h * nativeScale;
  const colorAcc = new Float32Array(outW * outH * 3);
  const weightAcc = new Float32Array(outW * outH);

  let done = 0;
  for (const y0 of ys) {
    for (const x0 of xs) {
      checkAborted(signal);
      const { tile, availW, availH } = extractTilePadded(srcCanvas, x0, y0, T);
      const tensor = await inferTile(session, ort, tile, T);
      checkAborted(signal);
      blendTileInto(colorAcc, weightAcc, outW, outH, tensor, T * nativeScale, x0, y0, availW, availH, nativeScale, overlap, w, h);
      done++;
      onProgress && onProgress(done / total, `處理區塊 ${done}/${total}`);
    }
  }
  return finalizeCanvas(colorAcc, weightAcc, outW, outH);
}

// 把 rgbCanvas 的 alpha 通道換成 alphaSourceCanvas（原圖或縮小後的輸入）高品質縮放後的 alpha；
// 來源若本來就不透明（alpha 全 255），縮放後仍是 255，等同沒動作。
function mergeAlpha(rgbCanvas, alphaSourceCanvas) {
  const w = rgbCanvas.width;
  const h = rgbCanvas.height;
  const rctx = rgbCanvas.getContext('2d', { willReadFrequently: true });
  const rgbData = rctx.getImageData(0, 0, w, h);
  const alphaScaled = resizeCanvas(alphaSourceCanvas, w, h);
  const actx = alphaScaled.getContext('2d', { willReadFrequently: true });
  const aData = actx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < w * h; i++) rgbData.data[i * 4 + 3] = aData[i * 4 + 3];
  rctx.putImageData(rgbData, 0, 0);
  return rgbCanvas;
}

// upscale(canvas, { model, scale, maxSide, signal, onProgress }) -> Promise<HTMLCanvasElement>
export async function upscale(canvas, { model = 'realesrgan-fast', scale = 4, maxSide, signal, onProgress } = {}) {
  const T = TILE_SIZE[model];
  if (!T) throw new Error(`未知的變清晰模型: ${model}`);
  checkAborted(signal);

  const srcW = canvas.width;
  const srcH = canvas.height;
  const plan = planUpscale(srcW, srcH, scale, maxSide);
  if (plan.tooLarge) {
    throw new Error(
      `輸出尺寸過大（${plan.outW4x}×${plan.outH4x}，超過約 8000 萬像素上限），請先縮小圖片或改用較低倍率`,
    );
  }

  onProgress && onProgress(0, '準備模型');
  const session = await getSession(model, {
    signal,
    onProgress: (p, text) => onProgress && onProgress(p * 0.12, text),
  });
  checkAborted(signal);
  const ort = await getOrt();

  const workCanvas = plan.workW === srcW && plan.workH === srcH ? canvas : resizeCanvas(canvas, plan.workW, plan.workH);

  let resultCanvas = await runTiledUpscale(session, ort, workCanvas, T, NATIVE_SCALE, {
    signal,
    onProgress: (p, text) => onProgress && onProgress(0.12 + p * 0.8, text),
  });
  checkAborted(signal);

  resultCanvas = mergeAlpha(resultCanvas, workCanvas);

  let finalCanvas = resultCanvas;
  if (plan.requestedScale === 2) {
    onProgress && onProgress(0.95, '縮小至 2 倍輸出');
    finalCanvas = resizeCanvas(resultCanvas, plan.finalW, plan.finalH);
  }

  checkAborted(signal);
  onProgress && onProgress(1, '完成');
  return finalCanvas;
}
