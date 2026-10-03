// 去水印模式：矩形框狀態、智慧偵測（多幀 Otsu 二值化多數決靜態遮罩，參考 WatermarkRemover 流程，
// 見 _research/video.md B2）、逐框呼叫 ai/migan.js 的 inpaint。
import { inpaint } from '../ai/migan.js';
import { createCanvas } from '../core/canvasUtil.js';

// ---------- Otsu 二值化門檻 ----------
function otsuThreshold(grayData) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < grayData.length; i++) hist[grayData[i]] += 1;
  const total = grayData.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

function regionGray(canvas, x, y, w, h) {
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  const data = cx.getImageData(x, y, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    gray[i] = Math.round(data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114);
  }
  return gray;
}

// 形態學膨脹（3x3 視窗 max-pooling），iterations 次
function dilateBinary(mask, w, h, iterations = 2) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            if (cur[ny * w + nx]) {
              v = 1;
              break;
            }
          }
        }
        next[y * w + x] = v;
      }
    }
    cur = next;
  }
  return cur;
}

// 在抽樣的幾格畫面上對 box 區域做 Otsu 二值化多數決（>=minRatio 格命中才算數），
// 回傳 box 尺寸的 Uint8Array（255=水印候選、0=背景），供 boxToMaskCanvas 使用。
export function buildSmartMask(sampleCanvases, box, { minRatio = 0.7 } = {}) {
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const votes = new Int32Array(w * h);
  let used = 0;
  for (const canvas of sampleCanvases) {
    if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height) continue;
    const gray = regionGray(canvas, x, y, w, h);
    const th = otsuThreshold(gray);
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] >= th) votes[i] += 1;
    }
    used += 1;
  }
  if (used === 0) return null;
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = votes[i] / used >= minRatio ? 1 : 0;
  const dilated = dilateBinary(bin, w, h, 2);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = dilated[i] ? 255 : 0;
  return out;
}

// 針對單一框產生整張畫面大小的遮罩 canvas（白=要修補），供 migan.inpaint 使用。
// box.smartMask 存在時只遮住偵測到的形狀，否則整框當 mask。
export function boxToMaskCanvas(box, frameW, frameH) {
  const mask = createCanvas(frameW, frameH);
  const mctx = mask.getContext('2d');
  mctx.clearRect(0, 0, frameW, frameH);
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.max(1, Math.min(Math.round(box.w), frameW - x));
  const h = Math.max(1, Math.min(Math.round(box.h), frameH - y));
  if (box.smartMask && box.smartMask.length === Math.round(box.w) * Math.round(box.h)) {
    const bw = Math.round(box.w);
    const id = mctx.createImageData(w, h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const v = box.smartMask[yy * bw + xx] || 0;
        const o = (yy * w + xx) * 4;
        id.data[o] = 255;
        id.data[o + 1] = 255;
        id.data[o + 2] = 255;
        id.data[o + 3] = v;
      }
    }
    mctx.putImageData(id, x, y);
  } else {
    mctx.fillStyle = '#fff';
    mctx.fillRect(x, y, w, h);
  }
  return mask;
}

// 對一格影像依序套用所有框的修補（每框各自一次 inpaint，鏈式疊加）。
export async function applyWatermarkRemoval(frameCanvas, boxes, { signal, onProgress } = {}) {
  let current = frameCanvas;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const maskCanvas = boxToMaskCanvas(box, frameCanvas.width, frameCanvas.height);
    current = await inpaint(current, maskCanvas, {
      signal,
      onProgress: (p, text) => onProgress && onProgress((i + p) / boxes.length, text),
    });
  }
  return current;
}
