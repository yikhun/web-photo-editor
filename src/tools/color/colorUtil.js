// 色彩工具函式：hex↔rgb(0..1)、RGB↔HSL、像素取樣平均。供 color.js／cpu.js 共用（JS 端）。

export function hexToRgb01(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

export function rgb01ToHex([r, g, b]) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// r,g,b: 0..1 -> {h:0..360, s:0..1, l:0..1}
export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 1e-6) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [r1 + m, g1 + m, b1 + m];
}

// 在 srcCanvas（2D canvas）取 (x,y) 附近 size×size 的平均色，座標為影像像素座標
export function sampleAverageColor(srcCanvas, x, y, size = 5) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const half = Math.floor(size / 2);
  const cx = Math.round(x);
  const cy = Math.round(y);
  const x0 = Math.max(0, cx - half);
  const y0 = Math.max(0, cy - half);
  const x1 = Math.min(w - 1, cx + half);
  const y1 = Math.min(h - 1, cy + half);
  const sw = Math.max(1, x1 - x0 + 1);
  const sh = Math.max(1, y1 - y0 + 1);
  const g = srcCanvas.getContext('2d');
  const data = g.getImageData(x0, y0, sw, sh).data;
  let r = 0;
  let gg = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    gg += data[i + 1];
    b += data[i + 2];
    a += data[i + 3];
    n += 1;
  }
  if (n === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: r / n / 255, g: gg / n / 255, b: b / n / 255, a: a / n / 255 };
}
