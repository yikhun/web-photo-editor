# 線上修圖（純瀏覽器）

圖片與影片只在瀏覽器裡處理，不會上傳。AI 用 onnxruntime-web（優先 WebGPU，沒有時改用 wasm），影片用 mediabunny（WebCodecs）。

## 啟動

```
npm install
npm run fetch-models   # 第一次執行：把 AI 模型下載到 public/models/（約 380MB）
npm run dev            # http://localhost:5173
```

建議使用最新版 Chrome / Edge。WebGPU 和 WebCodecs 都要瀏覽器支援。

## 模型

| 功能 | 模型 | 檔案 |
|---|---|---|
| 去背 | U²-Net / U²-Netp（rembg，MIT） | u2net.onnx、u2netp.onnx |
| 消除圖、影片去水印 | MI-GAN（MIT） | migan.onnx（mask：0＝要補，255＝保留，在 src/ai/migan.js 內轉換） |
| 變清晰：Real-ESRGAN 快速 | realesr-general-x4v3（BSD-3） | realesr-general-x4v3-static384.onnx |
| 變清晰：Upscayl 標準、數位藝術 | 由 Upscayl 官方 ncnn 檔轉成 ONNX（`_research/upscayl/ncnn2onnx.py`） | upscayl-*-4x-128.onnx |

Upscayl 兩個模型轉檔後，和官方 RealESRGAN_x4plus、x4plus_anime_6B 比對數值，PSNR 約 64 dB，可視為同一份權重。

## 已知限制（v1）

- 影片 AI 處理是逐格運算，速度慢。這台機器（Intel Arc 內顯）實測，320×240 影片放大 2 倍約每格 3.6 秒，瓶頸在 onnxruntime-web WebGPU 的 `session.run()`。之後的改善方向是 IO binding 加 `enableGraphCapture`。
- Upscayl 模型第一次執行要編譯 WebGPU shader，400×300 放大 4 倍約 50～70 秒，之後會比較快。
- 如果沒有執行 `fetch-models`，MI-GAN 與 Real-ESRGAN 會改從 Hugging Face 下載模型（只下載模型，不送出圖片），U²-Net 和 Upscayl 則一定要放在本機。
- 「影片工具」頁和左側「影片去背」各自保留一份工作區狀態，切換分頁或工具時不會釋放。

## 部署到 GitHub Pages

```
npm run fetch-models   # 先確保 public/models/ 有齊全部模型檔
npm run build:pages    # vite build --mode pages，之後自動切段模型、寫 manifest.json、補 .nojekyll/404.html
```

產物在 `dist/`，推到 `gh-pages` 分支即可（例如用 `gh-pages` CLI 或 Actions）。對應網址
`https://yikhun.github.io/web-photo-editor/`。重點差異：

- `base` 固定為 `/web-photo-editor/`（`vite.config.js` 依 `--mode pages` 切換），一般 `npm run dev` / `npm run build` 不受影響，base 仍是 `/`。
- `public/models/`（366MB，含 176MB 的 u2net.onnx）**不會**整包複製進 `dist`（pages 模式關閉 `publicDir`）；
  `scripts/prepare-pages-models.mjs` 在 build 後只複製實際有接線的 6 個模型，超過 90MB 的檔案切成
  `<檔名>.part0`、`.part1`…（每段 ≤ 90MB，GitHub 單檔上限 100MB），並寫出 `dist/models/manifest.json`。
  `src/ai/models.js` 的 `getModel()` 會先讀這份 manifest，依序下載各段再組回單一 ArrayBuffer；
  dev 環境沒有這份 manifest，行為完全不變（整檔下載）。
- GitHub Pages 無法設定 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`，所以
  `self.crossOriginIsolated` 會是 `false`、`SharedArrayBuffer` 不可用。`src/ai/ort.js` 偵測到這點時會把
  `ort.env.wasm.numThreads` 設成 `1`，避免 wasm 多執行緒初始化直接丟錯；WebGPU 路徑不受影響
  （優先使用 WebGPU，失敗才退回單執行緒 wasm）。
- `.nojekyll` 避免 Pages 用 Jekyll 處理而忽略底線開頭的檔案；`404.html` 是 `index.html` 的複本，
  子路徑下整頁重新整理時的保險。

## 結構

架構合約見 `ARCHITECTURE.md`。研究與驗收紀錄放在本機 `_research/`，不納入版本控制。
