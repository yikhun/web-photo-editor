// 去背邊緣閃爍抑制：依畫面差異自適應的 EMA（公式見 _research/video.md「C. 時間軸平滑」）。
// S_t = alpha_t · A_t + (1-alpha_t) · S_{t-1}；alpha_t 依相鄰格差異 Δt 在 [alphaMin, alphaMax] 間調整，
// 畫面幾乎靜止時信賴歷史平均（壓抖動），畫面劇烈變化/場景切換時直接重置，避免把不同鏡頭的遮罩混在一起。
const SAMPLE_W = 64;
const SAMPLE_H = 36;

function downsampleGray(canvas) {
  const c = document.createElement('canvas');
  c.width = SAMPLE_W;
  c.height = SAMPLE_H;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(canvas, 0, 0, SAMPLE_W, SAMPLE_H);
  const data = cx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  const out = new Float32Array(SAMPLE_W * SAMPLE_H);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) / 255;
  }
  return out;
}

export function createFlickerReducer({ alphaMin = 0.2, alphaMax = 0.95, sceneCutThreshold = 0.35 } = {}) {
  let prevGray = null;
  let prevSmoothed = null;

  function reset() {
    prevGray = null;
    prevSmoothed = null;
  }

  // alphaArray: Float32Array(w*h) 0~1，frameCanvas: 該格原始影像（用來估計畫面差異 Δt）
  function apply(alphaArray, frameCanvas) {
    const gray = downsampleGray(frameCanvas);
    let delta = 0;
    if (prevGray) {
      let sum = 0;
      for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prevGray[i]);
      delta = Math.min(1, Math.sqrt(sum / gray.length));
    }
    prevGray = gray;

    if (!prevSmoothed || delta >= sceneCutThreshold) {
      // 第一格，或偵測到場景切換：直接採用本格原始輸出，重置歷史（避免跨鏡頭混影）
      prevSmoothed = new Float32Array(alphaArray);
      return prevSmoothed;
    }

    const a = alphaMin + (alphaMax - alphaMin) * delta;
    const out = new Float32Array(alphaArray.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = a * alphaArray[i] + (1 - a) * prevSmoothed[i];
    }
    prevSmoothed = out;
    return out;
  }

  return { apply, reset };
}
