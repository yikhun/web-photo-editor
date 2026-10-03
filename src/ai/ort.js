// onnxruntime-web 初始化：優先 WebGPU EP，建立 session 失敗自動退回 wasm；session 依 key 快取。
//
// wasm 檔位置：刻意「不」設定 ort.env.wasm.wasmPaths，讓 onnxruntime-web 用它內建的
// `new URL('ort-wasm-*.mjs', import.meta.url)` 自我定位（相對於 node_modules 內的 ort.*.bundle.min.mjs）。
// 實測過兩種做法：
//   1. 把 node_modules/onnxruntime-web/dist 的 wasm/mjs 複製到 public/ort/，並設 wasmPaths='/ort/'
//      → dev 模式下 Vite 的 transform middleware 會拒絕「以 JS import 載入 /public 底下的檔案」
//        （錯誤：This file is in /public ... can only be referenced via HTML tags），整個初始化失敗。
//   2. 完全不覆寫 wasmPaths，交給 onnxruntime-web 預設的自我定位機制
//      → dev 與 `npm run build` 皆正常（build 產物會看到 Vite 自動把對應 .wasm 複製進 dist/assets/
//        並改寫成帶 hash 的檔名，證實這條路徑在兩種模式下都被 Vite 正確處理）。
// 因此採用做法 2；public/ort/ 保留做為「若未來改回手動指定路徑」的備用檔案，目前程式不會用到。
import { getModel } from './models.js';
import { makeAbortError } from './util.js';

let ortPromise = null;
let backend = null;
const sessionCache = new Map();

async function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web/webgpu').then((ort) => {
      ort.env.logLevel = 'error';
      ort.env.debug = false;
      // 沒有 COOP/COEP（例如 GitHub Pages）時 self.crossOriginIsolated 是 false，
      // SharedArrayBuffer 不可用，wasm 多執行緒必須關掉，否則 session 建立會直接丟錯。
      // WebGPU EP 不受影響（走這條路徑時根本不會用到 wasm 執行緒）。
      if (typeof self !== 'undefined' && !self.crossOriginIsolated) {
        ort.env.wasm.numThreads = 1;
      }
      return ort;
    });
  }
  return ortPromise;
}

// 供需要直接建立 Tensor 等 API 的呼叫端使用
export async function getOrt() {
  return loadOrt();
}

export function getBackend() {
  return backend;
}

// getSession(key, { signal, onProgress }) -> Promise<ort.InferenceSession>
export async function getSession(key, { signal, onProgress } = {}) {
  if (sessionCache.has(key)) {
    if (onProgress) onProgress(1, '使用已快取的推論引擎');
    return sessionCache.get(key);
  }

  const ort = await loadOrt();
  const buffer = await getModel(key, {
    signal,
    onProgress: (p, text) => onProgress && onProgress(p * 0.7, text),
  });
  if (signal && signal.aborted) throw makeAbortError();

  const bytes = new Uint8Array(buffer);
  onProgress && onProgress(0.72, '建立推論 session');

  let session;
  try {
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
    backend = 'webgpu';
  } catch (err) {
    console.warn('[ort] WebGPU session 建立失敗，退回 wasm', err);
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    backend = 'wasm';
  }

  if (typeof window !== 'undefined') window.__peBackend = backend;
  sessionCache.set(key, session);
  onProgress && onProgress(1, `推論引擎：${backend}`);
  return session;
}
