# 線上修圖網站 — 架構合約（所有實作 agent 必讀，照此介面寫）

全程瀏覽器端處理，圖片／影片不送伺服器。唯一網路流量是第一次下載 AI 模型與函式庫。
介面文字一律**繁體中文**（不可簡體）。目標瀏覽器：最新版 Chrome / Edge（WebGPU、WebCodecs）。

## 技術選型
- Vite 5+ ，原生 JavaScript ES modules，不用框架。CSS 單檔 `src/styles/main.css`（CSS 變數，深色主題）。
- `onnxruntime-web`（優先 `webgpu` EP，失敗退回 `wasm`），`mediabunny`（影片解碼/編碼/封裝）。
- dev server 固定 `http://localhost:5173`，`vite.config.js` 設 `server.headers` 與 `preview.headers`：
  `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Embedder-Policy: require-corp`（wasm 多執行緒需要）。
- 啟動：`npm install` → `npm run dev`。

## 目錄
```
index.html
src/main.js                 啟動、建立版面、註冊工具、頂部分頁「圖片編輯／影片工具」（hash 路由 #/image、#/video）
src/core/bus.js             事件匯流排 on/off/emit
src/core/doc.js             文件狀態（目前影像、原圖、歷史）
src/core/history.js         復原/重做/重置
src/core/viewport.js        右側畫布：繪製、縮放、平移、互動、overlay
src/core/compare.js         按住對比原圖、可拖曳前後對比線
src/core/task.js            長任務：「生成中」遮罩、進度、取消
src/core/export.js          匯出 PNG/JPG/WebP
src/core/ui.js              共用 UI 小元件（滑桿、按鈕群組、色票、區塊標題、toast）
src/core/canvasUtil.js      createCanvas、cloneCanvas、loadImageFromFile/Blob 等
src/tools/<id>.js           左側每個工具一個模組（見下）
src/ai/ort.js               ORT 初始化與 session 快取
src/ai/models.js            模型註冊表、下載（進度、Cache Storage 快取、可取消）
src/ai/u2net.js / migan.js / esrgan.js   各模型推論函式
src/video/...               影片工具頁與管線
```

## 版面（index.html 由 main.js 建立）
```
┌──────────────────────────── 上方工具列 #topbar ─────────────────────────────┐
│ Logo │ [圖片編輯][影片工具] │ 復原 重做 重置 │ 按住對比 │ 縮放% 適合畫面 │ 匯出▼ │
├────┬──────────────┬─────────────────────────────────────────────────────────┤
│左側│ 中間設定面板  │ 右側畫布 #stage（viewport）                                 │
│工具│ #panel 300px  │                                                         │
│欄  │               │                                                         │
│72px│               │                                                         │
└────┴──────────────┴─────────────────────────────────────────────────────────┘
```
左側工具順序固定：新增 add、調整 adjust、文字 text、消除圖 erase、摳圖 matting、變清晰 enhance、調色 color、影片摳圖 videoMatting。
「影片工具」分頁（#/video）整頁換成影片工作區：左欄是 去水印 / 去背 / 放大 三個模式。

## 工具模組合約（src/tools/<id>.js）
```js
export default {
  id: 'adjust',
  name: '調整',
  icon: '<svg ...>',              // 24x24 線條 icon 字串，stroke="currentColor"
  needsImage: true,               // 沒圖時面板顯示「請先新增圖片」並引導到新增
  mount(panelEl, ctx) {},         // 每次切到此工具時呼叫，清空並畫出設定面板
  activate(ctx) {},               // 切入：掛 viewport 互動、overlay
  deactivate(ctx) {},             // 切出：拆掉互動、清 overlay、未套用的預覽要還原（ctx.preview(null)）
}
```

## ctx（main.js 建立後傳給工具）
```js
ctx.bus                                   // 事件
ctx.doc.hasImage()
ctx.doc.getImage()        -> HTMLCanvasElement  // 目前影像（唯讀，要改請 clone）
ctx.doc.getOriginal()     -> HTMLCanvasElement  // 最初載入的原圖
ctx.doc.load(canvas, name)                // 新圖：清空歷史、設為原圖
ctx.commit(canvas, label)                 // 寫入歷史並成為目前影像，觸發 'doc:change'
ctx.preview(canvasOrNull)                 // 暫時顯示（不入歷史）；null = 恢復顯示目前影像
ctx.viewport.requestRender()
ctx.viewport.screenToImage(clientX, clientY) -> {x, y}   // 影像像素座標
ctx.viewport.imageToScreen(x, y)          -> {x, y}      // stage 內 CSS 座標
ctx.viewport.getScale()                   // 目前顯示倍率（影像像素→CSS px）
ctx.viewport.setOverlay(fn | null)        // fn(ctx2d, view) 在影像之上畫工具 UI；ctx2d 已是 stage 的 2D context（CSS px 座標），view = {scale, offsetX, offsetY, imageToScreen}
ctx.viewport.setInteraction(handler|null) // handler.onPointerDown/Move/Up(e, p)，p = 影像座標；handler.cursor = 'crosshair' 等
                                          // handler.onDblClick(e, p) 可選；回傳 true 表示工具已處理（viewport 不再 fit）；
                                          // 回傳 false/undefined 或未定義此函式則照舊 fit()
                                          // 空白鍵按住時 viewport 自己吃掉事件做平移，不傳給 handler
ctx.runTask({ title, run })               // run: async ({ signal, progress }) => result
                                          // progress(0~1, '說明文字')；顯示「生成中 xx%」+ 取消鈕
                                          // 取消 → signal.abort()，回傳 null，畫面不變（工具不得在取消後 commit）
                                          // 例外會顯示錯誤 toast 並回傳 null
ctx.showCompare(beforeCanvas, afterCanvas)  // 顯示可拖曳前後對比線，直到下次 commit/切工具或按「關閉對比」
ctx.toast(msg, type = 'info'|'success'|'error')
ctx.ui                                    // src/core/ui.js 的元件工廠
ctx.setTool(id)                           // 程式切換工具
```
事件：`doc:change`、`doc:load`、`tool:change`、`history:change`。

## 共通行為
- 復原／重做：Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z）與頂部按鈕；重置 = 回到原圖（本身也是一筆歷史，可再復原）。
  歷史保留最多 30 筆，超過丟最舊。
- 按住對比：頂部「按住對比」按鈕按住或按住鍵盤 `\` 時顯示原圖，放開恢復。
- 滾輪：以游標為中心縮放（0.05x～32x）；空白鍵按住拖曳平移（游標 grab）；雙擊空白處或按「適合畫面」= fit。
  透明區域畫灰白棋盤格。
- 匯出：PNG / JPG / WebP，JPG/WebP 可調品質；檔名 `<原檔名>-edited.<ext>`。匯出前若有未套用的文字層，先合併。
- AI 任務一律走 ctx.runTask；模型下載也算進度（「下載模型 32%」）。

## AI 函式合約（src/ai/*，影片管線也呼叫這些）
```js
// models.js
getModel(key, { signal, onProgress }) -> Promise<ArrayBuffer>   // 依註冊表下載並快取（Cache Storage 'pe-models-v1'）
// ort.js
getSession(key, { signal, onProgress }) -> Promise<ort.InferenceSession>  // 快取同一 key 的 session
getBackend() -> 'webgpu' | 'wasm'
// u2net.js
predictAlpha(srcCanvas, { model: 'u2net'|'u2netp', signal, onProgress }) -> Promise<Float32Array> // 長度 w*h，0~1，與 srcCanvas 同尺寸
// migan.js
inpaint(imageCanvas, maskCanvas, { signal, onProgress }) -> Promise<HTMLCanvasElement>
//   maskCanvas 同尺寸，白色(alpha>0)=要補的區域；內部自動裁 ROI（mask 外擴 + 上下文邊界）→ 512 推論 → 貼回並羽化
// esrgan.js
upscale(canvas, { model: 'realesrgan-fast'|'upscayl-standard'|'upscayl-digital-art', scale: 2|4, maxSide?, signal, onProgress }) -> Promise<HTMLCanvasElement>
//   分塊（tile）推論含重疊，避免顯示卡記憶體爆掉；scale 2 可用 4x 結果縮小
```

## 影片（src/video/）
- `pipeline.js`：用 mediabunny 讀 MP4/WebM，逐格交給 `processFrame(canvas, index, time) -> canvas`，再編碼輸出；保留音軌；
  支援進度與取消；透明輸出用 WebM + alpha。
- `workspace.js`：`createVideoWorkspace(container, { mode: 'watermark'|'matting'|'upscale', ctx })`，
  影片工具頁三個模式與左側「影片摳圖」工具共用。
- 影片放大輸出上限 4K（長邊 3840）。

## 程式風格
- 每個檔案開頭一行註解說明用途；函式短小；不要引入其他框架。
- 不可在使用者影像上做任何網路請求；console 不要殘留大量 log。
