// 調整工具：形狀蒙版 — 各形狀 Path2D 產生器與套用（框外變透明）。
import { createCanvas } from '../../core/canvasUtil.js';

export const SHAPE_OPTIONS = [
  { id: 'circle', label: '圓形' },
  { id: 'roundedRect', label: '圓角矩形' },
  { id: 'ellipse', label: '橢圓' },
  { id: 'heart', label: '愛心' },
  { id: 'star', label: '星形' },
  { id: 'hexagon', label: '六角形' },
  { id: 'speech', label: '對話框' },
];

// 回傳 Path2D，座標系以 (0,0)-(w,h) 為邊界，留 margin 比例的安全邊。
export function buildShapePath(shapeId, w, h, opts = {}) {
  const margin = opts.margin ?? 0.02;
  const mx = w * margin;
  const my = h * margin;
  const bx = mx;
  const by = my;
  const bw = w - mx * 2;
  const bh = h - my * 2;
  const cx = w / 2;
  const cy = h / 2;
  const p = new Path2D();

  switch (shapeId) {
    case 'circle': {
      const r = Math.min(bw, bh) / 2;
      p.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    }
    case 'ellipse': {
      p.ellipse(cx, cy, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      break;
    }
    case 'roundedRect': {
      const r = Math.min(opts.radius ?? Math.min(bw, bh) * 0.15, Math.min(bw, bh) / 2);
      roundRectPath(p, bx, by, bw, bh, r);
      break;
    }
    case 'heart': {
      heartPath(p, bx, by, bw, bh);
      break;
    }
    case 'star': {
      starPath(p, cx, cy, Math.min(bw, bh) / 2, Math.min(bw, bh) / 2.6, 5);
      break;
    }
    case 'hexagon': {
      polygonPath(p, cx, cy, Math.min(bw, bh) / 2, 6, -Math.PI / 2);
      break;
    }
    case 'speech': {
      speechBubblePath(p, bx, by, bw, bh);
      break;
    }
    default: {
      p.rect(bx, by, bw, bh);
    }
  }
  return p;
}

function roundRectPath(p, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.arcTo(x + w, y, x + w, y + r, r);
  p.lineTo(x + w, y + h - r);
  p.arcTo(x + w, y + h, x + w - r, y + h, r);
  p.lineTo(x + r, y + h);
  p.arcTo(x, y + h, x, y + h - r, r);
  p.lineTo(x, y + r);
  p.arcTo(x, y, x + r, y, r);
  p.closePath();
}

function heartPath(p, x, y, w, h) {
  // 以歸一化座標 (0~1) 繪製愛心再映射回 bounds。
  const map = (nx, ny) => [x + nx * w, y + ny * h];
  const topDip = 0.3;
  let [sx, sy] = map(0.5, 1);
  p.moveTo(sx, sy);
  let c;
  c = map(0.0, 0.55);
  let c1 = map(0.0, 0.2);
  let c2 = map(0.1, 0.0);
  p.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], ...map(0.5, topDip));
  c1 = map(0.9, 0.0);
  c2 = map(1.0, 0.2);
  p.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], ...map(1.0, 0.55));
  c1 = map(1.0, 0.8);
  c2 = map(0.75, 0.95);
  p.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], ...map(0.5, 1));
  void c;
  p.closePath();
}

function starPath(p, cx, cy, outerR, innerR, spikes) {
  const step = Math.PI / spikes;
  let rot = -Math.PI / 2;
  p.moveTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
  for (let i = 0; i < spikes; i++) {
    rot += step;
    p.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
    rot += step;
    p.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
  }
  p.closePath();
}

function polygonPath(p, cx, cy, r, sides, rotOffset = 0) {
  for (let i = 0; i <= sides; i++) {
    const a = rotOffset + (i * Math.PI * 2) / sides;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
}

function speechBubblePath(p, x, y, w, h) {
  const bubbleH = h * 0.78;
  const r = Math.min(w, bubbleH) * 0.12;
  roundRectPath(p, x, y, w, bubbleH, r);
  // 尾巴（左下角三角形）
  const tailW = w * 0.18;
  const tailH = h * 0.22;
  const tx = x + w * 0.18;
  const ty = y + bubbleH;
  p.moveTo(tx, ty - 2);
  p.lineTo(tx, ty + tailH);
  p.lineTo(tx + tailW, ty - 2);
  p.closePath();
}

// 套用形狀蒙版到來源 canvas，回傳新 canvas（框外 alpha=0）。
export function applyShapeMask(srcCanvas, shapeId, opts = {}) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const out = createCanvas(w, h);
  const g = out.getContext('2d');
  const path = buildShapePath(shapeId, w, h, opts);
  g.save();
  g.clip(path);
  g.drawImage(srcCanvas, 0, 0);
  g.restore();
  return out;
}
