// 影片讀取／單格預覽／逐格處理輸出共用管線（mediabunny）。
// 全程瀏覽器端處理，不上傳；保留音軌；進度與取消；透明輸出用 WebM + alpha:'keep'。
// API 依 _research/video.md（實讀 mediabunny 1.61.0 原始碼查證）：
//   Conversion.init({ input, output, video: { process } }) 逐格呼叫 process(sample)；
//   CanvasSink.getCanvas(t) 取單格預覽；getFirstEncodableVideoCodec/AudioCodec 檢查瀏覽器可編碼的格式。
import {
  Input,
  Output,
  Conversion,
  ConversionCanceledError,
  ALL_FORMATS,
  BlobSource,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  CanvasSink,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  QUALITY_HIGH,
} from 'mediabunny';
import { makeAbortError, checkAborted } from '../ai/util.js';
import { t } from '../core/i18n.js';

const MP4_VIDEO_CANDIDATES = ['avc', 'hevc'];
const WEBM_VIDEO_CANDIDATES = ['vp9', 'vp8'];
const MP4_AUDIO_CANDIDATES = ['aac', 'opus'];
const WEBM_AUDIO_CANDIDATES = ['opus', 'vorbis'];

// ---------- 讀檔與中繼資料 ----------
export async function readVideoInfo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    throw new Error(t('找不到視訊軌，請確認檔案是有效的 MP4 或 WebM 影片'));
  }
  const audioTrack = await input.getPrimaryAudioTrack();
  const [duration, width, height, metrics, canBeTransparent] = await Promise.all([
    input.computeDuration(),
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    videoTrack.computeFrameRateMetrics(),
    videoTrack.canBeTransparent(),
  ]);
  const fps = metrics.bestGuessFrameRate || metrics.averageFrameRate || metrics.medianFrameRate || 30;
  return {
    file,
    name: file.name || '影片',
    input,
    videoTrack,
    audioTrack,
    hasAudio: !!audioTrack,
    duration,
    width,
    height,
    fps,
    canBeTransparent,
  };
}

// ---------- 單格預覽（時間軸拖動用）----------
// 回傳 { getFrame(time) -> Promise<canvas|null> }，同一支影片的多次預覽共用同一個 sink。
export function createPreviewSink(videoTrack, { alpha = false } = {}) {
  const sink = new CanvasSink(videoTrack, { alpha, poolSize: 3 });
  let closed = false;
  return {
    async getFrame(time) {
      if (closed) return null;
      const t = Math.max(0, Number.isFinite(time) ? time : 0);
      const wrapped = await sink.getCanvas(t);
      return wrapped ? wrapped.canvas : null;
    },
    dispose() {
      closed = true;
    },
  };
}

// ---------- 輸出格式可行性檢查 ----------
// container: 'mp4' | 'webm'；回傳 { ok, videoCodec, audioCodec, reason }
export async function pickOutputCodecs({ container, hasAudio, width, height, fps }) {
  const videoCandidates = container === 'webm' ? WEBM_VIDEO_CANDIDATES : MP4_VIDEO_CANDIDATES;
  const audioCandidates = container === 'webm' ? WEBM_AUDIO_CANDIDATES : MP4_AUDIO_CANDIDATES;
  const videoCodec = await getFirstEncodableVideoCodec(videoCandidates, {
    width,
    height,
    frameRate: fps,
    quality: QUALITY_HIGH,
  });
  if (!videoCodec) {
    return {
      ok: false,
      reason: t('此瀏覽器缺少 WebCodecs 或不支援輸出 {container} 所需的視訊編碼（{codecs}）', {
        container: container.toUpperCase(),
        codecs: videoCandidates.join('/'),
      }),
    };
  }
  let audioCodec = null;
  if (hasAudio) {
    audioCodec = await getFirstEncodableAudioCodec(audioCandidates);
    if (!audioCodec) {
      return {
        ok: false,
        reason: t('此瀏覽器不支援輸出 {container} 所需的音訊編碼（{codecs}）', {
          container: container.toUpperCase(),
          codecs: audioCandidates.join('/'),
        }),
      };
    }
  }
  return { ok: true, videoCodec, audioCodec };
}

// ---------- 逐格處理並輸出 ----------
// processFrame(canvas, index, time) -> async Promise<canvas>：就地修改或回傳同尺寸 canvas；
// 若會改變尺寸（放大模式），canvas 直接回傳不同尺寸即可，另外用 outputSize 提示編碼器預先設定好目標尺寸。
export async function runPipeline({
  file,
  container = 'mp4',
  alpha = false,
  videoCodec,
  audioCodec,
  outputSize, // {width, height} 可選
  processFrame,
  onProgress,
  onFrame, // (index, time) 每格處理前呼叫，供 UI 顯示「第 n/N 格」
  signal,
}) {
  checkAborted(signal);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const OutputFormatCtor = container === 'webm' ? WebMOutputFormat : Mp4OutputFormat;
  const output = new Output({ format: new OutputFormatCtor(), target: new BufferTarget() });

  let frameIndex = 0;
  let workCanvas = null;

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec: videoCodec,
      alpha: alpha ? 'keep' : 'discard',
      quality: QUALITY_HIGH,
      processedWidth: outputSize ? outputSize.width : undefined,
      processedHeight: outputSize ? outputSize.height : undefined,
      process: async (sample) => {
        checkAborted(signal);
        const w = sample.displayWidth;
        const h = sample.displayHeight;
        if (!workCanvas || workCanvas.width !== w || workCanvas.height !== h) {
          workCanvas = document.createElement('canvas');
          workCanvas.width = w;
          workCanvas.height = h;
        }
        const wctx = workCanvas.getContext('2d', { willReadFrequently: true });
        wctx.clearRect(0, 0, w, h);
        sample.draw(wctx, 0, 0, w, h);
        onFrame && onFrame(frameIndex, sample.timestamp);
        const result = await processFrame(workCanvas, frameIndex, sample.timestamp);
        frameIndex += 1;
        checkAborted(signal);
        return result || workCanvas;
      },
    },
    audio: audioCodec ? { codec: audioCodec } : undefined,
  });

  if (!conversion.isValid) {
    const reasons = (conversion.discardedTracks || []).map((tr) => tr.reason || '').filter(Boolean).join('; ');
    throw new Error(reasons ? t('轉檔設定不相容：{reasons}', { reasons }) : t('轉檔設定不相容'));
  }

  conversion.onProgress = (p) => {
    onProgress && onProgress(Math.min(0.99, p));
  };

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    conversion.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      await conversion.cancel();
      throw makeAbortError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await conversion.execute();
  } catch (err) {
    if (aborted || (signal && signal.aborted) || err instanceof ConversionCanceledError) {
      throw makeAbortError();
    }
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  onProgress && onProgress(1);
  return output.target.buffer;
}

// ---------- 下載輔助 ----------
export function downloadArrayBuffer(buffer, fileName, mime) {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function stripExt(name) {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

export function containerMime(container) {
  return container === 'webm' ? 'video/webm' : 'video/mp4';
}

export function formatTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
