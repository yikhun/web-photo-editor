// 調整工具：幾何計算 — 高品質縮放、旋轉後最大內接矩形、裁切工具函式。
import { createCanvas } from '../../core/canvasUtil.js';

// 高品質縮放：多次減半逼近目標尺寸，最後一次用 imageSmoothingQuality='high' 精細縮放。
export function highQualityResize(srcCanvas, targetW, targetH) {
  targetW = Math.max(1, Math.round(targetW));
  targetH = Math.max(1, Math.round(targetH));
  let cur = srcCanvas;
  // 放大：直接一次高品質縮放即可。
  if (targetW >= cur.width && targetH >= cur.height) {
    const out = createCanvas(targetW, targetH);
    const g = out.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, targetW, targetH);
    return out;
  }
  // 縮小：每次最多減半，直到小於兩倍目標尺寸再做最後一次精細縮放。
  while (cur.width > targetW * 2 || cur.height > targetH * 2) {
    const nextW = Math.max(targetW, Math.round(cur.width / 2));
    const nextH = Math.max(targetH, Math.round(cur.height / 2));
    const step = createCanvas(nextW, nextH);
    const g = step.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nextW, nextH);
    cur = step;
  }
  const out = createCanvas(targetW, targetH);
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, targetW, targetH);
  return out;
}

// 裁切出 rect（影像像素座標，整數化）為新 canvas。
export function cropCanvas(srcCanvas, rect) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const out = createCanvas(w, h);
  out.getContext('2d').drawImage(srcCanvas, -x, -y);
  return out;
}

// 以旋轉角度（弧度，絕對值）計算 w×h 矩形旋轉後、同比例最大內接矩形尺寸。
// 參考經典公式（rotated rect with max area, aspect-locked）。
export function rotatedRectMaxArea(w, h, angleRad) {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  const widthIsLonger = w >= h;
  const sideLong = widthIsLonger ? w : h;
  const sideShort = widthIsLonger ? h : w;
  const sinA = Math.abs(Math.sin(angleRad));
  const cosA = Math.abs(Math.cos(angleRad));
  if (sideShort <= 2 * sinA * cosA * sideLong || Math.abs(sinA - cosA) < 1e-10) {
    const x = 0.5 * sideShort;
    const wr = widthIsLonger ? x / sinA : x / cosA;
    const hr = widthIsLonger ? x / cosA : x / sinA;
    return { w: wr, h: hr };
  }
  const cos2a = cosA * cosA - sinA * sinA;
  const wr = (w * cosA - h * sinA) / cos2a;
  const hr = (h * cosA - w * sinA) / cos2a;
  return { w: Math.abs(wr), h: Math.abs(hr) };
}

// 以任意角度（度）旋轉整張影像，輸出放大後可容納整張旋轉結果的 canvas（含透明邊角）。
export function rotateCanvasFull(srcCanvas, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const outW = Math.ceil(w * cos + h * sin);
  const outH = Math.ceil(w * sin + h * cos);
  const out = createCanvas(outW, outH);
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.translate(outW / 2, outH / 2);
  g.rotate(rad);
  g.drawImage(srcCanvas, -w / 2, -h / 2);
  return out;
}

// 任意角度旋轉＋裁掉透明邊角（依比例計算最大內接矩形，置中裁切）。
export function rotateCanvasCropped(srcCanvas, angleDeg) {
  const full = rotateCanvasFull(srcCanvas, angleDeg);
  const rad = (angleDeg * Math.PI) / 180;
  const inner = rotatedRectMaxArea(srcCanvas.width, srcCanvas.height, rad);
  const w = Math.max(1, Math.min(full.width, Math.round(inner.w)));
  const h = Math.max(1, Math.min(full.height, Math.round(inner.h)));
  const x = (full.width - w) / 2;
  const y = (full.height - h) / 2;
  return cropCanvas(full, { x, y, w, h });
}

export function rotate90(srcCanvas, dir) {
  // dir: 'left' | 'right'
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const out = createCanvas(h, w);
  const g = out.getContext('2d');
  g.translate(h / 2, w / 2);
  g.rotate(dir === 'left' ? -Math.PI / 2 : Math.PI / 2);
  g.drawImage(srcCanvas, -w / 2, -h / 2);
  return out;
}

export function flipCanvas(srcCanvas, axis) {
  // axis: 'h' | 'v'
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const out = createCanvas(w, h);
  const g = out.getContext('2d');
  if (axis === 'h') {
    g.translate(w, 0);
    g.scale(-1, 1);
  } else {
    g.translate(0, h);
    g.scale(1, -1);
  }
  g.drawImage(srcCanvas, 0, 0);
  return out;
}

// 依比例字串（如 '4:3'、'free'、'original'）取得數值比例；free/original 回傳 null 表示不限制。
export function ratioValue(id, imgW, imgH) {
  if (id === 'free') return null;
  if (id === 'original') return imgW / imgH;
  const m = /^(\d+):(\d+)$/.exec(id);
  if (!m) return null;
  return Number(m[1]) / Number(m[2]);
}

// 給定比例（w/h，null=自由）與影像尺寸，計算置中最大裁切框。
export function maxCenteredRect(ratio, imgW, imgH) {
  if (!ratio) return { x: 0, y: 0, w: imgW, h: imgH };
  let w = imgW;
  let h = w / ratio;
  if (h > imgH) {
    h = imgH;
    w = h * ratio;
  }
  return { x: (imgW - w) / 2, y: (imgH - h) / 2, w, h };
}
