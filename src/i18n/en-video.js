// 英文字典（video 區）：key = 介面繁中原文，value = 英文
export default {
  // 模式名稱
  '去水印': 'Remove watermark',
  '去背': 'Remove background',
  '放大': 'Upscale',

  // 上傳區
  '點擊或拖曳 MP4 / WebM 影片檔到此處': 'Click or drag an MP4 / WebM video file here',

  // 載入影片
  '已載入影片：{w}×{h}，{d}s，{audio}': 'Video loaded: {w}×{h}, {d}s, {audio}',
  '含音軌': 'with audio',
  '無音軌': 'no audio',
  '載入影片失敗：{msg}': 'Failed to load video: {msg}',
  '找不到視訊軌，請確認檔案是有效的 MP4 或 WebM 影片': 'No video track found. Please check that the file is a valid MP4 or WebM video.',

  // 設定面板（通用）
  '請先上傳影片': 'Please upload a video first',
  '{w}×{h}，{d}s': '{w}×{h}, {d}s',
  '原始 {w}×{h}，{d}s': 'Original {w}×{h}, {d}s',
  '執行': 'Run',
  '模型': 'Model',
  '預覽此格效果': 'Preview this frame',
  '處理整支影片並輸出': 'Process whole video',

  // 去水印面板
  '框 {n}（{w}×{h}px）': 'Box {n} ({w}×{h}px)',
  '刪除': 'Delete',
  '尚未框選任何區域，在預覽畫面上拖曳畫框（可框多個）': 'No areas selected yet — drag on the preview to draw a box (multiple allowed)',
  '智慧偵測（Otsu 多幀多數決）': 'Smart detection (Otsu multi-frame majority vote)',
  '輸出 MP4': 'Export MP4',
  '輸出 WebM': 'Export WebM',
  '水印框選': 'Watermark area',
  '輸出格式': 'Output format',

  // 去背面板
  '快速（U²-Netp）': 'Fast (U²-Netp)',
  '精準（U²-Net）': 'Accurate (U²-Net)',
  '模糊強度 (px)': 'Blur strength (px)',
  '透明（WebM）': 'Transparent (WebM)',
  '綠幕/自訂色': 'Green screen / custom color',
  '模糊原畫面': 'Blur original',
  '主體保留': 'Subject retention',
  '邊緣羽化 (px)': 'Edge feather (px)',
  '減少邊緣閃爍（跨格自適應平滑）': 'Reduce edge flicker (adaptive smoothing across frames)',
  '平滑強度': 'Smoothing strength',
  'AI 模型': 'AI model',
  '背景': 'Background',
  '調整': 'Adjust',
  '時間平滑': 'Temporal smoothing',

  // 放大面板
  '2 倍': '2x',
  '4 倍': '4x',
  '快速': 'Fast',
  '標準': 'Standard',
  '數位插畫': 'Digital art',
  '輸出尺寸：{w}×{h}px{clamped}': 'Output size: {w}×{h}px{clamped}',
  '（已限制為 4K）': ' (capped at 4K)',
  '4x 放大逐格運算非常慢，時間以第一格實測推估。': '4x upscaling is very slow frame-by-frame; time is estimated from the first frame.',
  '放大倍率': 'Upscale factor',
  '放大模型模組（src/ai/esrgan.js）尚未就緒，暫時無法使用放大功能': 'The upscale model module (src/ai/esrgan.js) is not ready yet; the upscale feature is temporarily unavailable',
  '估算中…': 'Estimating…',
  '約 {s} 秒': 'about {s}s',
  '約 {m} 分 {s} 秒': 'about {m}m {s}s',

  // 預覽 / 處理中
  '無法取得目前這一格畫面': 'Could not get the current frame',
  '預覽處理中': 'Processing preview',
  '請先框選水印區域': 'Please draw a watermark box first',
  '已顯示此格的處理結果（拖動時間軸可恢復原始畫面）': 'Showing the processed result for this frame (drag the timeline to restore the original)',
  '去水印處理中': 'Removing watermark',
  '去背處理中': 'Removing background',
  '放大處理中': 'Upscaling',
  '第 {done} / 約 {total} 格': 'Frame {done} / about {total}',
  '第 {done} / 約 {total} 格，預估剩餘 {remain}': 'Frame {done} / about {total}, est. {remain} remaining',

  // 結果展示
  '播放比較': 'Play comparison',
  '暫停': 'Pause',
  '下載影片': 'Download video',
  '已開始下載': 'Download started',
  '返回編輯': 'Back to editing',
  '處理完成': 'Processing complete',

  // pipeline 錯誤訊息
  '此瀏覽器缺少 WebCodecs 或不支援輸出 {container} 所需的視訊編碼（{codecs}）':
    'This browser lacks WebCodecs, or does not support the video codec needed for {container} output ({codecs})',
  '此瀏覽器不支援輸出 {container} 所需的音訊編碼（{codecs}）':
    'This browser does not support the audio codec needed for {container} output ({codecs})',
  '轉檔設定不相容：{reasons}': 'Incompatible conversion settings: {reasons}',
  '轉檔設定不相容': 'Incompatible conversion settings',

  // 任務遮罩
  '處理中': 'Processing',
  '取消': 'Cancel',
  '已有任務執行中，請稍候': 'A task is already running, please wait',
  '執行失敗：{msg}': 'Failed: {msg}',
};
