// 影片放大模式：呼叫 ai/esrgan.js 逐格放大；輸出長邊上限 4K（3840），尺寸強制偶數（編碼器需要）。
// esrgan.js 由另一個 agent 並行撰寫，可能尚未就緒，因此用動態 import 延後載入並給出可讀錯誤。
export const MAX_SIDE = 3840;

let esrganModulePromise = null;
export async function loadEsrgan() {
  if (!esrganModulePromise) {
    esrganModulePromise = import('../ai/esrgan.js').catch((err) => {
      esrganModulePromise = null;
      console.error('[video/upscale] 載入 esrgan.js 失敗', err);
      throw new Error('放大模型模組（src/ai/esrgan.js）尚未就緒，暫時無法使用放大功能');
    });
  }
  return esrganModulePromise;
}

export async function isEsrganReady() {
  try {
    await loadEsrgan();
    return true;
  } catch {
    return false;
  }
}

// 計算放大後尺寸：scale 倍 → 若超過 MAX_SIDE 等比縮回 → 偶數化
export function computeUpscaledSize(width, height, scale) {
  let w = width * scale;
  let h = height * scale;
  const longest = Math.max(w, h);
  if (longest > MAX_SIDE) {
    const ratio = MAX_SIDE / longest;
    w *= ratio;
    h *= ratio;
  }
  w = Math.max(2, Math.round(w / 2) * 2);
  h = Math.max(2, Math.round(h / 2) * 2);
  return { width: w, height: h };
}

export async function upscaleFrame(frameCanvas, { model, scale, signal, onProgress } = {}) {
  const mod = await loadEsrgan();
  const result = await mod.upscale(frameCanvas, { model, scale, maxSide: MAX_SIDE, signal, onProgress });
  if (result.width % 2 === 0 && result.height % 2 === 0) return result;
  // 防呆：編碼器通常要求偶數尺寸，若 esrgan 輸出剛好是奇數則裁 1px
  const w = result.width - (result.width % 2);
  const h = result.height - (result.height % 2);
  const fixed = document.createElement('canvas');
  fixed.width = w;
  fixed.height = h;
  fixed.getContext('2d').drawImage(result, 0, 0, w, h, 0, 0, w, h);
  return fixed;
}

export function estimateRemainingMs(firstFrameMs, totalFrames, doneFrames) {
  const remain = Math.max(0, totalFrames - doneFrames);
  return remain * firstFrameMs;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '估算中…';
  const s = Math.round(ms / 1000);
  if (s < 60) return `約 ${s} 秒`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  return `約 ${m} 分 ${rs} 秒`;
}
