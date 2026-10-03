// U²-Net 去背推論：predictAlpha(srcCanvas, {model, signal, onProgress}) -> Float32Array(w*h) 0~1
// 前後處理依 _research/models/models.md §1.2（實讀 rembg 原始碼確認）：
// 輸入固定 320×320 RGB，正規化＝先除以整張圖像的最大像素值，再套 ImageNet mean/std；
// 輸出取第 0 個 head，per-image min-max 正規化回 [0,1]，再縮放回原圖尺寸。
import { getSession, getOrt } from './ort.js';
import { createCanvas } from '../core/canvasUtil.js';
import { checkAborted, makeAbortError } from './util.js';
import { t } from '../core/i18n.js';

const INPUT_SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export async function predictAlpha(srcCanvas, { model = 'u2netp', signal, onProgress } = {}) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;

  onProgress && onProgress(0, t('準備模型'));
  const session = await getSession(model, {
    signal,
    onProgress: (p, text) => onProgress && onProgress(p * 0.55, text),
  });
  checkAborted(signal);
  const ort = await getOrt();

  // ---------- 前處理 ----------
  const small = createCanvas(INPUT_SIZE, INPUT_SIZE);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCanvas, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = sctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  const n = INPUT_SIZE * INPUT_SIZE;
  let maxVal = 1e-6;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    if (r > maxVal) maxVal = r;
    if (g > maxVal) maxVal = g;
    if (b > maxVal) maxVal = b;
  }

  const chw = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / maxVal;
    const g = data[i * 4 + 1] / maxVal;
    const b = data[i * 4 + 2] / maxVal;
    chw[i] = (r - MEAN[0]) / STD[0];
    chw[n + i] = (g - MEAN[1]) / STD[1];
    chw[2 * n + i] = (b - MEAN[2]) / STD[2];
  }

  checkAborted(signal);
  onProgress && onProgress(0.6, t('推論中'));

  const inputName = session.inputNames[0];
  const inputTensor = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const feeds = { [inputName]: inputTensor };

  let outputs;
  try {
    outputs = await session.run(feeds);
  } catch (err) {
    if (signal && signal.aborted) throw makeAbortError();
    throw err;
  }
  checkAborted(signal);
  onProgress && onProgress(0.85, t('後處理中'));

  const outName = session.outputNames[0];
  const outData = outputs[outName].data; // Float32Array，長度 320*320（單通道）

  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < outData.length; i++) {
    const v = outData[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = Math.max(mx - mn, 1e-6);
  const maskSmall = new Float32Array(outData.length);
  for (let i = 0; i < outData.length; i++) {
    const v = (outData[i] - mn) / range;
    maskSmall[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // ---------- 放大回原尺寸（canvas 雙線性） ----------
  const maskCanvas = createCanvas(INPUT_SIZE, INPUT_SIZE);
  const mctx = maskCanvas.getContext('2d');
  const imgData = mctx.createImageData(INPUT_SIZE, INPUT_SIZE);
  for (let i = 0; i < maskSmall.length; i++) {
    const v = Math.round(maskSmall[i] * 255);
    imgData.data[i * 4] = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  mctx.putImageData(imgData, 0, 0);

  const big = createCanvas(w, h);
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(maskCanvas, 0, 0, w, h);
  const bigData = bctx.getImageData(0, 0, w, h).data;

  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = bigData[i * 4] / 255;

  onProgress && onProgress(1, t('完成'));
  return alpha;
}
