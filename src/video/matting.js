// 影片去背模式：u2net 逐格 alpha 推論（長邊縮到 maxSide 再放大回原尺寸省算力）+ 背景合成
// （透明／綠幕／白／模糊原畫面／自訂色）+ 主體保留曲線。時間平滑另見 flicker.js。
import { predictAlpha } from '../ai/u2net.js';
import { createCanvas, cloneCanvas } from '../core/canvasUtil.js';
import { blurGrayFloat } from '../ai/util.js';

export async function predictFrameAlpha(frameCanvas, { model = 'u2netp', signal, onProgress, maxSide = 1024 } = {}) {
  const w = frameCanvas.width;
  const h = frameCanvas.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  let input = frameCanvas;
  if (scale < 1) {
    input = createCanvas(Math.round(w * scale), Math.round(h * scale));
    input.getContext('2d').drawImage(frameCanvas, 0, 0, input.width, input.height);
  }
  const small = await predictAlpha(input, { model, signal, onProgress });
  if (scale >= 1) return small;

  // 放大回原尺寸（雙線性）
  const smallCanvas = createCanvas(input.width, input.height);
  const sctx = smallCanvas.getContext('2d');
  const id = sctx.createImageData(input.width, input.height);
  for (let i = 0; i < small.length; i++) {
    const v = Math.round(small[i] * 255);
    id.data[i * 4] = v;
    id.data[i * 4 + 1] = v;
    id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  const big = createCanvas(w, h);
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(smallCanvas, 0, 0, w, h);
  const data = bctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4] / 255;
  return out;
}

// 主體保留（門檻＋對比）曲線，與 tools/matting.js 一致的手感
export function applyAlphaCurve(alpha, retain) {
  const t = retain / 50; // -1..1
  const center = 0.5 - t * 0.25;
  const k = 1 + Math.abs(t) * 2.5;
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    let v = (alpha[i] - center) * k + 0.5;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

export function applyFeather(alpha, w, h, px) {
  return blurGrayFloat(alpha, w, h, px);
}

// 依 alpha 把前景從 frameCanvas 切出，合成到指定背景模式
export function composeBackground(frameCanvas, alpha, { bgMode = 'transparent', bgColor = '#00FF00', blurPx = 18 } = {}) {
  const w = frameCanvas.width;
  const h = frameCanvas.height;
  const out = createCanvas(w, h);
  const octx = out.getContext('2d');
  if (bgMode === 'blur') {
    octx.save();
    octx.filter = `blur(${blurPx}px)`;
    octx.drawImage(frameCanvas, -blurPx, -blurPx, w + blurPx * 2, h + blurPx * 2);
    octx.restore();
  } else if (bgMode !== 'transparent') {
    octx.fillStyle = bgColor;
    octx.fillRect(0, 0, w, h);
  }
  const cut = cloneCanvas(frameCanvas);
  const cctx = cut.getContext('2d', { willReadFrequently: true });
  const id = cctx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    id.data[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
  cctx.putImageData(id, 0, 0);
  octx.drawImage(cut, 0, 0);
  return out;
}
