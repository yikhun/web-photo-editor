// CPU 退回管線（WebGL2 不可用時使用）：ImageData 逐像素運算。
// 涵蓋滑桿／分離色調／暈影／顆粒／褪色／一鍵換色／大部分獨立濾鏡；
// 需要鄰域取樣的濾鏡（模糊/浮雕/素描/油畫感）在此簡化為近似效果以維持可用性。
import { createCanvas } from '../../core/canvasUtil.js';
import { rgbToHsl, hslToRgb } from './colorUtil.js';

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function applyCpu(srcCanvas, params) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const srcCtx = srcCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, w, h);
  const out = createCanvas(w, h);
  const outCtx = out.getContext('2d');
  const outData = outCtx.createImageData(w, h);
  const s = srcData.data;
  const d = outData.data;

  const filter = params.filter || { mode: 0, intensity: 100 };
  const cr = params.colorReplace || { enabled: false };
  const aspect = w / h;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = s[i] / 255;
      let g = s[i + 1] / 255;
      let b = s[i + 2] / 255;
      const a = s[i + 3];
      const origR = r;
      const origG = g;
      const origB = b;

      // ---- 獨立濾鏡（簡化版）----
      if (filter.mode && filter.mode !== 0) {
        let fr = r;
        let fg = g;
        let fb = b;
        if (filter.mode === 5) {
          const block = Math.max(2, filter.pixelBlock || 10);
          const bx = Math.floor(x / block) * block + Math.floor(block / 2);
          const by = Math.floor(y / block) * block + Math.floor(block / 2);
          const cx = Math.min(w - 1, bx);
          const cy = Math.min(h - 1, by);
          const j = (cy * w + cx) * 4;
          fr = s[j] / 255;
          fg = s[j + 1] / 255;
          fb = s[j + 2] / 255;
        } else if (filter.mode === 6) {
          fr = 1 - r; fg = 1 - g; fb = 1 - b;
        } else if (filter.mode === 7) {
          const l = luminance(r, g, b);
          fr = l * 1.07 + 0.05; fg = l * 0.84; fb = l * 0.55;
        } else if (filter.mode === 9) {
          const l = luminance(r, g, b);
          const d1 = filter.duotoneColor1 || [0.05, 0.05, 0.2];
          const d2 = filter.duotoneColor2 || [1, 0.8, 0.4];
          fr = d1[0] + (d2[0] - d1[0]) * l;
          fg = d1[1] + (d2[1] - d1[1]) * l;
          fb = d1[2] + (d2[2] - d1[2]) * l;
        } else if (filter.mode === 8) {
          const hsl = rgbToHsl(r, g, b);
          hsl.s = clamp01(hsl.s * 1.35);
          [fr, fg, fb] = hslToRgb(hsl.h, hsl.s, hsl.l);
          fr = (fr - 0.5) * 1.25 + 0.5 + 0.03;
          fg = (fg - 0.5) * 1.25 + 0.5;
          fb = (fb - 0.5) * 1.25 + 0.5 - 0.02;
        } else {
          // 1 模糊 / 2 浮雕 / 3 素描 / 4 油畫感：CPU 簡化為輕微平滑 + 降飽和近似
          const l = luminance(r, g, b);
          fr = r * 0.5 + l * 0.5;
          fg = g * 0.5 + l * 0.5;
          fb = b * 0.5 + l * 0.5;
        }
        const fi = (filter.intensity ?? 100) / 100;
        r = r + (fr - r) * fi;
        g = g + (fg - g) * fi;
        b = b + (fb - b) * fi;
      }

      // ---- 色溫 / 色調 ----
      const t = (params.temperature || 0) / 100;
      r += t * 0.12;
      b -= t * 0.12;
      const ti = (params.tint || 0) / 100;
      g -= ti * 0.10;
      r += ti * 0.05;
      b += ti * 0.05;

      // ---- 曝光 / 亮度 / 對比 ----
      const expFactor = Math.pow(2, ((params.exposure || 0) / 100) * 2);
      r *= expFactor; g *= expFactor; b *= expFactor;
      const brightAdd = ((params.brightness || 0) / 100) * 0.3;
      r += brightAdd; g += brightAdd; b += brightAdd;
      const contrastFactor = 1 + (params.contrast || 0) / 100;
      r = (r - 0.5) * contrastFactor + 0.5;
      g = (g - 0.5) * contrastFactor + 0.5;
      b = (b - 0.5) * contrastFactor + 0.5;

      // ---- 高光 / 陰影 / 白色 / 黑色 ----
      const lum = luminance(r, g, b);
      const hiMask = smoothstep(0.5, 1.0, lum);
      const shMask = smoothstep(0.5, 0.0, lum);
      const hiAdd = ((params.highlights || 0) / 100) * 0.3 * hiMask * (1 - lum);
      const shAdd = ((params.shadows || 0) / 100) * 0.3 * shMask * (lum + 0.15);
      const whAdd = ((params.whites || 0) / 100) * 0.25 * smoothstep(0.75, 1.0, lum);
      const blAdd = ((params.blacks || 0) / 100) * 0.25 * smoothstep(0.25, 0.0, lum);
      r += hiAdd + shAdd + whAdd + blAdd;
      g += hiAdd + shAdd + whAdd + blAdd;
      b += hiAdd + shAdd + whAdd + blAdd;

      // ---- 飽和度 / 自然飽和度 ----
      if (Math.abs(params.saturation || 0) > 0.5 || Math.abs(params.vibrance || 0) > 0.5) {
        const hsl = rgbToHsl(clamp01(r), clamp01(g), clamp01(b));
        hsl.s = clamp01(hsl.s * (1 + (params.saturation || 0) / 100));
        const vib = (params.vibrance || 0) / 100;
        hsl.s = clamp01(hsl.s + vib * (1 - hsl.s) * 0.9);
        [r, g, b] = hslToRgb(hsl.h, hsl.s, hsl.l);
      }

      // ---- 分離色調 ----
      if ((params.splitStrength || 0) > 0.5) {
        const l2 = luminance(clamp01(r), clamp01(g), clamp01(b));
        const shadowAmt = (1 - smoothstep(0.0, 0.6, l2)) * (params.splitStrength / 100);
        const highAmt = smoothstep(0.4, 1.0, l2) * (params.splitStrength / 100);
        const ss = params.splitShadowColor || [0.5, 0.5, 0.5];
        const sh2 = params.splitHighlightColor || [0.5, 0.5, 0.5];
        r += (ss[0] - 0.5) * shadowAmt * 0.7 + (sh2[0] - 0.5) * highAmt * 0.7;
        g += (ss[1] - 0.5) * shadowAmt * 0.7 + (sh2[1] - 0.5) * highAmt * 0.7;
        b += (ss[2] - 0.5) * shadowAmt * 0.7 + (sh2[2] - 0.5) * highAmt * 0.7;
      }

      // ---- 褪色 ----
      if ((params.fade || 0) > 0.5) {
        const f = params.fade / 100;
        r = r + (r * 0.82 + 0.12 - r) * f;
        g = g + (g * 0.82 + 0.12 - g) * f;
        b = b + (b * 0.82 + 0.12 - b) * f;
      }

      // ---- 暈影 ----
      if ((params.vignette || 0) > 0.5) {
        const cx = (x / w - 0.5) * aspect;
        const cy = y / h - 0.5;
        const dist = Math.sqrt(cx * cx + cy * cy);
        const vig = smoothstep(1.0, 0.3, dist);
        const mixv = 1 + (vig - 1) * (params.vignette / 100);
        r *= mixv; g *= mixv; b *= mixv;
      }

      // ---- 顆粒 ----
      if ((params.grain || 0) > 0.5) {
        const n = (hash(x, y) * 2 - 1) * (params.grain / 100) * 0.12;
        r += n; g += n; b += n;
      }

      r = clamp01(r); g = clamp01(g); b = clamp01(b);

      // ---- 一鍵換色 ----
      if (cr.enabled) {
        const hsl = rgbToHsl(r, g, b);
        let diff = Math.abs(((hsl.h - cr.sourceHue + 180) % 360 + 360) % 360 - 180);
        const satMask = smoothstep(0.06, 0.22, hsl.s);
        const hueMask = 1 - smoothstep((cr.tolerance ?? 30) * 0.5, cr.tolerance ?? 30, diff);
        const mask = clamp01(hueMask * satMask);
        let newH = ((cr.targetHue || 0) % 360 + 360) % 360;
        let newS = hsl.s;
        let newL = hsl.l;
        if (cr.preserveLightness === false) {
          newS = cr.targetSat ?? 0.6;
          newL = cr.targetLight ?? 0.5;
        }
        const [rr, rg, rb] = hslToRgb(newH, newS, newL);
        r = r + (rr - r) * mask;
        g = g + (rg - g) * mask;
        b = b + (rb - b) * mask;
      }

      const intensity = (params.intensity ?? 100) / 100;
      r = origR + (r - origR) * intensity;
      g = origG + (g - origG) * intensity;
      b = origB + (b - origB) * intensity;

      d[i] = Math.round(clamp01(r) * 255);
      d[i + 1] = Math.round(clamp01(g) * 255);
      d[i + 2] = Math.round(clamp01(b) * 255);
      d[i + 3] = a;
    }
  }

  outCtx.putImageData(outData, 0, 0);
  return out;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

function hash(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}
