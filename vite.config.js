// Vite 設定：dev 固定 port 5173 並加上 COOP/COEP header（wasm 多執行緒 / onnxruntime-web 需要）。
// GitHub Pages 無法設這兩個 header，所以 build:pages（--mode pages）會關閉它們，
// 並改走子路徑 base + 不複製 public/models（改由 scripts/prepare-pages-models.mjs 處理，見 README）。
import { defineConfig } from 'vite';

const coopCoepHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ mode }) => {
  const isPages = mode === 'pages';
  return {
    // dev / 一般 build 維持 '/'；GitHub Pages 子路徑用 --mode pages 觸發
    base: isPages ? '/web-photo-editor/' : '/',
    server: {
      port: 5173,
      strictPort: true,
      headers: coopCoepHeaders,
    },
    preview: {
      port: 5173,
      strictPort: true,
      headers: coopCoepHeaders,
    },
    // onnxruntime-web 的 wasm/worker 載入方式與 Vite 預先打包不相容，排除讓它以原樣載入
    optimizeDeps: {
      exclude: ['onnxruntime-web'],
    },
    worker: {
      format: 'es',
    },
    // pages 模式不要把 public/models（366MB，含 >100MB 的 u2net.onnx）整包複製進 dist；
    // dist/models 改由 scripts/prepare-pages-models.mjs 在 build 後切段重建。
    // public/ort 目前程式沒有用到（見 src/ai/ort.js 開頭註解），一般 build 仍照舊複製，不影響功能。
    publicDir: isPages ? false : 'public',
  };
});
