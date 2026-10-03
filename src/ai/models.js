// 模型註冊表、下載（進度、Cache Storage 'pe-models-v1' 快取、可取消）。
// 查證依據：_research/models/models.md（URL、CORS、大小皆已於 2026-10-03 實測）。
import { makeAbortError } from './util.js';

const CACHE_NAME = 'pe-models-v1';

// 路徑一律用 BASE_URL 組，dev 是 '/'，GitHub Pages build:pages 是 '/web-photo-editor/'
const BASE = import.meta.env.BASE_URL;

// url：本機 public/models/ 路徑優先（npm run fetch-models 下載好的檔案；Pages 上是 build 時切段的檔案）
// fallbackUrl：本機檔案 404 時改走的有 CORS 來源（本機沒放檔案時仍可用）
export const MODELS = {
  u2net: {
    url: `${BASE}models/u2net.onnx`,
    fallbackUrl: null, // GitHub Release 附件無 CORS，瀏覽器無法直接 fetch，必須本機託管
    size: 175997641,
    label: 'U²-Net（標準，較準）',
  },
  u2netp: {
    url: `${BASE}models/u2netp.onnx`,
    fallbackUrl: null,
    size: 4574861,
    label: 'U²-Net（輕量，較快）',
  },
  migan: {
    url: `${BASE}models/migan.onnx`,
    fallbackUrl: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    size: 28079181,
    label: 'MI-GAN 影像修補',
  },
  'realesrgan-fast': {
    url: `${BASE}models/realesr-general-x4v3-static384.onnx`,
    fallbackUrl:
      'https://huggingface.co/Saimon8420/realesr-general-x4v3-web/resolve/main/realesr-general-x4v3-static384.onnx',
    size: 4878946,
    label: 'Real-ESRGAN 快速版（384→1536，可上 WebGPU）',
  },
  // 固定 128×128 輸入版（WebGPU 可上；esrgan.js 的 tile 推論固定吃這個尺寸，wasm 退回時一樣能跑，
  // 只是 tile 仍為 128，犧牲一點效率換取邏輯單純；動態版 upscayl-*-4x.onnx 已下載於 public/models/
  // 但目前未接線，留作未來改善 wasm 效能的備用）。
  'upscayl-standard': {
    url: `${BASE}models/upscayl-standard-4x-128.onnx`,
    fallbackUrl: null,
    size: 66925664,
    label: 'Upscayl 標準（同 Real-ESRGAN x4plus，照片寫實）',
  },
  'upscayl-digital-art': {
    url: `${BASE}models/upscayl-digital-art-4x-128.onnx`,
    fallbackUrl: null,
    size: 17906916,
    label: 'Upscayl 數位藝術（同 Real-ESRGAN x4plus anime 6B，插畫/動漫）',
  },
};

function cacheKeyFor(key) {
  return new Request(`https://pe-models.local/${key}`);
}

async function openCache() {
  try {
    return await caches.open(CACHE_NAME);
  } catch (err) {
    console.warn('[models] 無法開啟 Cache Storage，略過快取', err);
    return null;
  }
}

// GitHub Pages 單檔上限 100MB，部署時 >90MB 的模型會被切成 <name>.partN。
// manifest.json 有列到的檔名才走分段下載；取不到 manifest（dev 環境本來就沒有這檔）
// 或該檔名不在 manifest 裡，就照舊整檔 fetch，行為完全不變。
let manifestPromise = null;
async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(`${BASE}models/manifest.json`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }
  return manifestPromise;
}

// 分段下載並依序合併成單一 ArrayBuffer；進度依「已收到 bytes / 各段大小總和」合併計算。
async function fetchPartsWithProgress(baseUrl, parts, { signal, onProgress }) {
  // parts 可能是字串陣列（檔名尾碼，如 "part0"）或物件陣列（{ suffix, size }），兩種都支援
  const list = parts.map((p) => (typeof p === 'string' ? { suffix: p, size: 0 } : p));
  const totalKnown = list.reduce((sum, p) => sum + (p.size || 0), 0);
  const buffers = [];
  let receivedTotal = 0;
  for (let i = 0; i < list.length; i++) {
    if (signal && signal.aborted) throw makeAbortError();
    const url = `${baseUrl}.${list[i].suffix}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}（${url}）`);
    const buf = await res.arrayBuffer();
    buffers.push(buf);
    receivedTotal += buf.byteLength;
    if (onProgress) {
      const pct = totalKnown ? Math.min(1, receivedTotal / totalKnown) : (i + 1) / list.length;
      onProgress(pct, `下載模型中 ${Math.round(pct * 100)}%（分段 ${i + 1}/${list.length}）`);
    }
  }
  const out = new Uint8Array(receivedTotal);
  let offset = 0;
  for (const buf of buffers) {
    out.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return out.buffer;
}

async function fetchWithProgress(url, knownSize, { signal, onProgress }) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}（${url}）`);
  const total = Number(res.headers.get('content-length')) || knownSize || 0;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = await res.arrayBuffer();
    if (onProgress) onProgress(1, '下載完成');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) {
      const pct = total ? Math.min(1, received / total) : 0;
      onProgress(pct, `下載模型中 ${total ? Math.round(pct * 100) + '%' : Math.round(received / 1e6) + 'MB'}`);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

// getModel(key, { signal, onProgress }) -> Promise<ArrayBuffer>
export async function getModel(key, { signal, onProgress } = {}) {
  const entry = MODELS[key];
  if (!entry) throw new Error(`未知模型 key: ${key}`);

  const cache = await openCache();
  if (cache) {
    const cached = await cache.match(cacheKeyFor(key));
    if (cached) {
      if (onProgress) onProgress(1, '已使用本機快取模型');
      return cached.arrayBuffer();
    }
  }

  const candidates = [entry.url, entry.fallbackUrl].filter(Boolean);
  if (candidates.length === 0) throw new Error(`模型 ${key} 尚未提供下載來源`);

  const manifest = await loadManifest();
  const fileName = entry.url.split('/').pop();
  const manifestEntry = manifest && manifest[fileName];

  let lastErr = null;
  for (const url of candidates) {
    if (signal && signal.aborted) throw makeAbortError();
    try {
      const buffer =
        url === entry.url && manifestEntry && Array.isArray(manifestEntry.parts) && manifestEntry.parts.length > 0
          ? await fetchPartsWithProgress(url, manifestEntry.parts, { signal, onProgress })
          : await fetchWithProgress(url, entry.size, { signal, onProgress });
      if (cache) {
        try {
          await cache.put(cacheKeyFor(key), new Response(buffer.slice(0)));
        } catch (err) {
          console.warn('[models] 寫入快取失敗（可能超出瀏覽器配額），下次需重新下載', err);
        }
      }
      return buffer;
    } catch (err) {
      if (signal && signal.aborted) throw makeAbortError();
      lastErr = err;
      console.warn(`[models] 下載 ${key} 失敗（${url}），嘗試下一個來源`, err);
    }
  }
  throw lastErr || new Error(`模型 ${key} 下載失敗`);
}

export function getModelEntry(key) {
  return MODELS[key];
}
