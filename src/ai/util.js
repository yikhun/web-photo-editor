// AI 共用小工具：取消例外、canvas 縮放/裁切、灰階 Float32Array <-> canvas 轉換、高斯模糊近似。
import { createCanvas } from '../core/canvasUtil.js';

export function makeAbortError() {
  return new DOMException('使用者已取消', 'AbortError');
}

export function checkAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError();
}

// 將來源畫布縮放繪製到指定尺寸的新畫布（高品質雙線性）
export function resizeCanvas(src, w, h) {
  const out = createCanvas(w, h);
  const c = out.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, w, h);
  return out;
}

// 裁切來源畫布的一塊區域成新畫布（超出邊界的部分留空/透明）
export function cropCanvas(src, x, y, w, h) {
  const out = createCanvas(w, h);
  const c = out.getContext('2d', { willReadFrequently: true });
  c.drawImage(src, x, y, w, h, 0, 0, w, h);
  return out;
}

export function getImageData(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

// 灰階 Float32Array（0~1，長度 w*h）轉成一張灰階 canvas
export function grayFloatToCanvas(arr, w, h) {
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d');
  const id = c.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(arr[i] * 255)));
    id.data[i * 4] = v;
    id.data[i * 4 + 1] = v;
    id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  c.putImageData(id, 0, 0);
  return canvas;
}

// 灰階 canvas（讀紅色通道）轉回 Float32Array（0~1）
export function canvasToGrayFloat(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const data = getImageData(canvas).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4] / 255;
  return out;
}

// 用 canvas 2D filter 的 blur 對灰階 Float32Array 做模糊（羽化用，px<=0 時原樣回傳）
export function blurGrayFloat(arr, w, h, px) {
  if (!px || px <= 0) return arr;
  const src = grayFloatToCanvas(arr, w, h);
  const out = createCanvas(w, h);
  const oc = out.getContext('2d', { willReadFrequently: true });
  oc.filter = `blur(${px}px)`;
  oc.drawImage(src, 0, 0);
  oc.filter = 'none';
  return canvasToGrayFloat(out);
}

// 等比例 cover 方式把 img 畫滿 w×h（用於背景圖）
export function drawImageCover(ctx2d, img, w, h) {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const imgRatio = srcW / srcH;
  const targetRatio = w / h;
  let sw;
  let sh;
  let sx;
  let sy;
  if (imgRatio > targetRatio) {
    sh = srcH;
    sw = sh * targetRatio;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    sw = srcW;
    sh = sw / targetRatio;
    sx = 0;
    sy = (srcH - sh) / 2;
  }
  ctx2d.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

export function stripExt(name) {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

export function downloadCanvasAsPng(canvas, fileName) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
}
