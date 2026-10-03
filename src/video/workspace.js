// 影片工作區：去水印 / 去背 / 放大 三個模式共用一份 UI 與管線，供「影片工具」分頁(#/video)
// 與左側「影片去背」工具共用（videoMatting 傳 mode:'matting', allowModeSwitch:false,
// 並額外傳 panelEl/stageEl——此時設定區直接掛進 panelEl、預覽區掛進 stageEl，
// 不建立內部 vw-root/vw-sidebar 外殼；container 參數在此模式下不使用）。
// 全程瀏覽器端處理，不上傳；只在第一次用到時動態載入 ai/esrgan.js（放大）。
import '../styles/video.css';
import {
  readVideoInfo,
  createPreviewSink,
  pickOutputCodecs,
  runPipeline,
  downloadArrayBuffer,
  stripExt,
  containerMime,
  formatTime,
} from './pipeline.js';
import { createVideoTask } from './taskOverlay.js';
import { createFlickerReducer } from './flicker.js';
import { buildSmartMask, applyWatermarkRemoval, boxToMaskCanvas } from './watermark.js';
import { predictFrameAlpha, composeBackground, applyAlphaCurve, applyFeather } from './matting.js';
import { upscaleFrame, computeUpscaledSize, estimateRemainingMs, formatDuration } from './upscale.js';
import { createCanvas, cloneCanvas } from '../core/canvasUtil.js';
import { t, onLangChange } from '../core/i18n.js';

const MODE_LABELS = { watermark: '去水印', matting: '去背', upscale: '放大' };
// 下載檔名用固定英文代稱，不隨介面語系變動（避免中文檔名在部分系統顯示異常）
const FILE_MODE_CODE = { watermark: 'watermark', matting: 'bg-removed', upscale: 'upscaled' };
const BG_COLOR_SWATCHES = ['#00ff00', '#ffffff', '#000000', '#4f8cff', '#ff5a5a'];

export function createVideoWorkspace(container, opts = {}) {
  const ctx = opts.ctx;
  const ui = ctx.ui;
  const allowModeSwitch = opts.allowModeSwitch !== false;
  const embedded = !!(opts.panelEl || opts.stageEl);

  // ---------- 狀態（每個工作區實例各自獨立）----------
  const state = {
    mode: opts.mode || 'watermark',
    file: null,
    info: null, // readVideoInfo() 結果
    previewSink: null,
    inputContainer: 'mp4',
    currentTime: 0,
    playing: false,
    playRaf: null,
    resultUrl: null,
    originalUrl: null,
    // 去水印
    watermark: { boxes: [], smartDetect: true, drawing: null, container: 'mp4' },
    // 去背
    matting: {
      model: 'u2netp',
      bgMode: 'transparent',
      bgColor: '#00ff00',
      blurPx: 18,
      retain: 0,
      feather: 0,
      flickerOn: true,
      flickerStrength: 50,
    },
    // 放大
    upscale: { model: 'realesrgan-fast', scale: 2 },
  };

  let destroyed = false;
  let resultRefs = null; // { resultPlayBtn, downloadBtn, backBtn }，供語系切換時重新套用文字
  let resultComparePlaying = false;

  // ---------- DOM 骨架 ----------
  // 內嵌模式（傳了 panelEl/stageEl，例如左側「影片去背」工具）：不建立 vw-root/vw-sidebar 外殼，
  // 設定區直接掛進呼叫方給的 panelEl、預覽/時間軸直接掛進呼叫方給的 stageEl。
  let root = null;
  if (!embedded) {
    container.innerHTML = '';
    root = document.createElement('div');
    root.className = 'vw-root' + (allowModeSwitch ? '' : ' vw-embedded');
    container.appendChild(root);
  }

  let sidebarEl = null;
  if (allowModeSwitch && root) {
    sidebarEl = document.createElement('div');
    sidebarEl.className = 'vw-sidebar';
    root.appendChild(sidebarEl);
  }

  const panelEl = opts.panelEl || document.createElement('div');
  if (!opts.panelEl) {
    panelEl.className = 'vw-panel';
    if (root) root.appendChild(panelEl);
  }

  const stageEl = opts.stageEl || document.createElement('div');
  if (!opts.stageEl) {
    stageEl.className = 'vw-stage';
    if (root) root.appendChild(stageEl);
  } else {
    stageEl.classList.add('vw-stage-embedded');
  }

  const task = createVideoTask({ containerEl: stageEl, toast: ctx.toast });

  // ---------- 上傳區 ----------
  const dropzone = document.createElement('div');
  dropzone.className = 'ui-dropzone vw-dropzone';
  dropzone.textContent = t('點擊或拖曳 MP4 / WebM 影片檔到此處');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/mp4,video/webm';
  fileInput.style.display = 'none';
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  // ---------- 預覽畫布 + 時間軸 ----------
  const previewWrap = document.createElement('div');
  previewWrap.className = 'vw-preview-wrap';
  const previewCanvas = document.createElement('canvas');
  previewCanvas.className = 'vw-preview-canvas';
  previewWrap.appendChild(previewCanvas);

  const resultWrap = document.createElement('div');
  resultWrap.className = 'vw-result-wrap';
  resultWrap.style.display = 'none';

  const timelineRow = document.createElement('div');
  timelineRow.className = 'vw-timeline-row';
  const playBtn = ui.button('▶', () => togglePlay());
  const timeInput = document.createElement('input');
  timeInput.type = 'range';
  timeInput.min = '0';
  timeInput.max = '0';
  timeInput.step = '0.01';
  timeInput.value = '0';
  timeInput.className = 'vw-timeline';
  const timeLabel = document.createElement('span');
  timeLabel.className = 'vw-timecode';
  timeLabel.textContent = '00:00.00 / 00:00.00';
  timelineRow.appendChild(playBtn);
  timelineRow.appendChild(timeInput);
  timelineRow.appendChild(timeLabel);

  timeInput.addEventListener('input', () => {
    stopPlay();
    seekTo(Number(timeInput.value));
  });

  stageEl.appendChild(dropzone);
  stageEl.appendChild(previewWrap);
  stageEl.appendChild(resultWrap);
  stageEl.appendChild(timelineRow);
  previewWrap.style.display = 'none';
  timelineRow.style.display = 'none';

  // ============================================================
  // 檔案載入
  // ============================================================
  async function loadFile(file) {
    try {
      resetResult();
      const info = await readVideoInfo(file);
      if (state.previewSink) state.previewSink.dispose();
      state.file = file;
      state.info = info;
      state.inputContainer = /\.webm$/i.test(file.name || '') ? 'webm' : 'mp4';
      state.watermark.boxes = [];
      state.watermark.container = state.inputContainer;
      state.currentTime = 0;
      const needsAlpha = state.mode === 'matting' && state.matting.bgMode === 'transparent';
      state.previewSink = createPreviewSink(info.videoTrack, { alpha: needsAlpha });

      previewCanvas.width = info.width;
      previewCanvas.height = info.height;
      dropzone.style.display = 'none';
      previewWrap.style.display = 'flex';
      timelineRow.style.display = 'flex';
      timeInput.max = String(info.duration);
      timeInput.value = '0';

      renderModePanel();
      await seekTo(0);
      ctx.toast(
        t('已載入影片：{w}×{h}，{d}s，{audio}', {
          w: info.width,
          h: info.height,
          d: info.duration.toFixed(1),
          audio: info.hasAudio ? t('含音軌') : t('無音軌'),
        }),
        'success',
      );
    } catch (err) {
      console.error('[video-workspace] 載入影片失敗', err);
      ctx.toast(t('載入影片失敗：{msg}', { msg: err && err.message ? err.message : err }), 'error');
    }
  }

  // 立刻 revokeObjectURL 會與「對比用 <video> 元素仍在讀取同一個 blob URL」race：
  // 若此時影片還在載入/緩衝中（例如一顯示結果就馬上按返回編輯），revoke 會讓該元素
  // 原本就在飛行中的讀取請求失敗，在 console 看到兩筆（before/after 各一）
  // 「Failed to load resource: net::ERR_FILE_NOT_FOUND」（已用隔離測試重現並確認成因）。
  // 做法比照本檔 downloadArrayBuffer() 既有的延遲 revoke 慣例：先讓 <video> 停止播放、
  // 清空 src 並移出 DOM，revoke 延後一小段時間執行，讓飛行中的讀取有機會先結束。
  function resetResult() {
    const oldResultUrl = state.resultUrl;
    const oldOriginalUrl = state.originalUrl;
    state.resultUrl = null;
    state.originalUrl = null;
    resultRefs = null;
    resultComparePlaying = false;
    for (const video of resultWrap.querySelectorAll('video')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    resultWrap.innerHTML = '';
    resultWrap.style.display = 'none';
    if (oldResultUrl || oldOriginalUrl) {
      setTimeout(() => {
        if (oldResultUrl) URL.revokeObjectURL(oldResultUrl);
        if (oldOriginalUrl) URL.revokeObjectURL(oldOriginalUrl);
      }, 2000);
    }
    previewWrap.style.display = state.info ? 'flex' : 'none';
  }

  // ============================================================
  // 時間軸 / 預覽
  // ============================================================
  async function seekTo(time) {
    if (!state.info || !state.previewSink) return;
    state.currentTime = Math.max(0, Math.min(state.info.duration, time));
    timeInput.value = String(state.currentTime);
    timeLabel.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.info.duration)}`;
    const frame = await state.previewSink.getFrame(state.currentTime);
    if (!frame || destroyed) return;
    const pctx = previewCanvas.getContext('2d');
    pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    pctx.drawImage(frame, 0, 0, previewCanvas.width, previewCanvas.height);
    drawModeOverlay(pctx);
  }

  function togglePlay() {
    if (state.playing) {
      stopPlay();
    } else {
      startPlay();
    }
  }

  function startPlay() {
    if (!state.info || state.playing) return;
    state.playing = true;
    playBtn.textContent = '⏸';
    let last = performance.now();
    const tick = (now) => {
      if (!state.playing) return;
      const dt = (now - last) / 1000;
      last = now;
      let t = state.currentTime + dt;
      if (t >= state.info.duration) t = 0;
      seekTo(t);
      state.playRaf = requestAnimationFrame(tick);
    };
    state.playRaf = requestAnimationFrame(tick);
  }

  function stopPlay() {
    state.playing = false;
    playBtn.textContent = '▶';
    if (state.playRaf) cancelAnimationFrame(state.playRaf);
    state.playRaf = null;
  }

  function drawModeOverlay(pctx) {
    if (state.mode === 'watermark') {
      pctx.save();
      pctx.lineWidth = 2;
      pctx.strokeStyle = '#4f8cff';
      pctx.fillStyle = 'rgba(79,140,255,0.15)';
      for (const b of state.watermark.boxes) {
        pctx.fillRect(b.x, b.y, b.w, b.h);
        pctx.strokeRect(b.x, b.y, b.w, b.h);
      }
      if (state.watermark.drawing) {
        const d = normalizeDraft(state.watermark.drawing);
        pctx.setLineDash([6, 4]);
        pctx.strokeRect(d.x, d.y, d.w, d.h);
        pctx.setLineDash([]);
      }
      pctx.restore();
    }
  }

  function normalizeDraft(d) {
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    return { x, y, w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
  }

  function canvasPoint(e) {
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  previewCanvas.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'watermark' || !state.info) return;
    const p = canvasPoint(e);
    state.watermark.drawing = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  });
  previewCanvas.addEventListener('pointermove', (e) => {
    if (state.mode !== 'watermark' || !state.watermark.drawing) return;
    const p = canvasPoint(e);
    state.watermark.drawing.x1 = p.x;
    state.watermark.drawing.y1 = p.y;
    seekTo(state.currentTime);
  });
  window.addEventListener('pointerup', () => {
    if (state.mode !== 'watermark' || !state.watermark.drawing) return;
    const d = normalizeDraft(state.watermark.drawing);
    state.watermark.drawing = null;
    if (d.w > 4 && d.h > 4) {
      state.watermark.boxes.push({ ...d, smartMask: null });
      refreshBoxList();
    }
    seekTo(state.currentTime);
  });

  // ============================================================
  // 設定面板（依模式切換）
  // ============================================================
  let boxListEl = null;

  function renderModePanel() {
    panelEl.innerHTML = '';
    if (!state.info) {
      panelEl.appendChild(ui.el('div', 'ui-empty-hint', t('請先上傳影片')));
      return;
    }
    if (state.mode === 'watermark') renderWatermarkPanel();
    else if (state.mode === 'matting') renderMattingPanel();
    else renderUpscalePanel();
  }

  function refreshBoxList() {
    if (!boxListEl) return;
    boxListEl.innerHTML = '';
    state.watermark.boxes.forEach((b, i) => {
      const row = ui.el('div', 'ai-box-list-item');
      row.appendChild(ui.el('span', null, t('框 {n}（{w}×{h}px）', { n: i + 1, w: Math.round(b.w), h: Math.round(b.h) })));
      const delBtn = ui.button(t('刪除'), () => {
        state.watermark.boxes.splice(i, 1);
        refreshBoxList();
        seekTo(state.currentTime);
      });
      row.appendChild(delBtn);
      boxListEl.appendChild(row);
    });
    if (state.watermark.boxes.length === 0) {
      boxListEl.appendChild(ui.el('div', 'ai-hint', t('尚未框選任何區域，在預覽畫面上拖曳畫框（可框多個）')));
    }
  }

  function renderWatermarkPanel() {
    const smartToggle = ui.toggle(t('智慧偵測（Otsu 多幀多數決）'), state.watermark.smartDetect, (v) => {
      state.watermark.smartDetect = v;
      for (const b of state.watermark.boxes) b.smartMask = null;
    });
    boxListEl = ui.el('div', 'ai-box-list');
    refreshBoxList();

    const containerGroup = ui.buttonGroup(
      [
        { id: 'mp4', label: t('輸出 MP4') },
        { id: 'webm', label: t('輸出 WebM') },
      ],
      state.watermark.container,
      (id) => {
        state.watermark.container = id;
      },
    );

    const previewBtn = ui.button(t('預覽此格效果'), () => previewCurrentFrame(), { block: true });
    const runBtn = ui.button(t('處理整支影片並輸出'), () => runWatermarkExport(), { primary: true, block: true });

    panelEl.appendChild(ui.el('div', 'ui-empty-hint', t('{w}×{h}，{d}s', { w: state.info.width, h: state.info.height, d: state.info.duration.toFixed(1) })));
    panelEl.appendChild(ui.section(t('水印框選'), [boxListEl, smartToggle]));
    panelEl.appendChild(ui.section(t('輸出格式'), [containerGroup]));
    panelEl.appendChild(ui.section(t('執行'), [previewBtn, runBtn]));
  }

  function renderMattingPanel() {
    const m = state.matting;
    const modelGroup = ui.buttonGroup(
      [
        { id: 'u2netp', label: t('快速（U²-Netp）') },
        { id: 'u2net', label: t('精準（U²-Net）') },
      ],
      m.model,
      (id) => {
        m.model = id;
      },
    );

    const bgSub = ui.el('div');
    function refreshBgSub() {
      bgSub.innerHTML = '';
      if (m.bgMode === 'color') {
        const swatches = ui.colorSwatches(BG_COLOR_SWATCHES, m.bgColor, (c) => {
          m.bgColor = c;
          seekTo(state.currentTime);
        });
        bgSub.appendChild(swatches);
      } else if (m.bgMode === 'blur') {
        const s = ui.slider(t('模糊強度 (px)'), 2, 40, 1, m.blurPx, (v) => {
          m.blurPx = v;
        });
        bgSub.appendChild(s);
      }
    }
    const bgGroup = ui.buttonGroup(
      [
        { id: 'transparent', label: t('透明（WebM）') },
        { id: 'color', label: t('綠幕/自訂色') },
        { id: 'blur', label: t('模糊原畫面') },
      ],
      m.bgMode,
      (id) => {
        m.bgMode = id;
        if (state.previewSink) {
          state.previewSink.dispose();
          state.previewSink = createPreviewSink(state.info.videoTrack, { alpha: id === 'transparent' });
        }
        refreshBgSub();
      },
    );
    refreshBgSub();

    const retainSlider = ui.slider(t('主體保留'), -50, 50, 1, m.retain, (v) => {
      m.retain = v;
    });
    const featherSlider = ui.slider(t('邊緣羽化 (px)'), 0, 10, 1, m.feather, (v) => {
      m.feather = v;
    });
    const flickerToggle = ui.toggle(t('減少邊緣閃爍（跨格自適應平滑）'), m.flickerOn, (v) => {
      m.flickerOn = v;
    });
    const flickerSlider = ui.slider(t('平滑強度'), 0, 100, 1, m.flickerStrength, (v) => {
      m.flickerStrength = v;
    });

    const previewBtn = ui.button(t('預覽此格效果'), () => previewCurrentFrame(), { block: true });
    const runBtn = ui.button(t('處理整支影片並輸出'), () => runMattingExport(), { primary: true, block: true });

    panelEl.appendChild(ui.el('div', 'ui-empty-hint', t('{w}×{h}，{d}s', { w: state.info.width, h: state.info.height, d: state.info.duration.toFixed(1) })));
    panelEl.appendChild(ui.section(t('AI 模型'), [modelGroup]));
    panelEl.appendChild(ui.section(t('背景'), [bgGroup, bgSub]));
    panelEl.appendChild(ui.section(t('調整'), [retainSlider, featherSlider]));
    panelEl.appendChild(ui.section(t('時間平滑'), [flickerToggle, flickerSlider]));
    panelEl.appendChild(ui.section(t('執行'), [previewBtn, runBtn]));
  }

  function renderUpscalePanel() {
    const u = state.upscale;
    const scaleGroup = ui.buttonGroup(
      [
        { id: '2', label: t('2 倍') },
        { id: '4', label: t('4 倍') },
      ],
      String(u.scale),
      (id) => {
        u.scale = Number(id);
        updateSizeHint();
      },
    );
    const modelGroup = ui.buttonGroup(
      [
        { id: 'realesrgan-fast', label: t('快速') },
        { id: 'upscayl-standard', label: t('標準') },
        { id: 'upscayl-digital-art', label: t('數位插畫') },
      ],
      u.model,
      (id) => {
        u.model = id;
      },
    );
    const sizeHint = ui.el('div', 'ai-hint', '');
    function updateSizeHint() {
      const size = computeUpscaledSize(state.info.width, state.info.height, u.scale);
      const clamped = size.width < state.info.width * u.scale || size.height < state.info.height * u.scale;
      sizeHint.textContent = t('輸出尺寸：{w}×{h}px{clamped}', {
        w: size.width,
        h: size.height,
        clamped: clamped ? t('（已限制為 4K）') : '',
      });
    }
    updateSizeHint();

    const timeHint = ui.el('div', 'ai-hint', t('4x 放大逐格運算非常慢，時間以第一格實測推估。'));
    const previewBtn = ui.button(t('預覽此格效果'), () => previewCurrentFrame(), { block: true });
    const runBtn = ui.button(t('處理整支影片並輸出'), () => runUpscaleExport(), { primary: true, block: true });

    panelEl.appendChild(ui.el('div', 'ui-empty-hint', t('原始 {w}×{h}，{d}s', { w: state.info.width, h: state.info.height, d: state.info.duration.toFixed(1) })));
    panelEl.appendChild(ui.section(t('放大倍率'), [scaleGroup, sizeHint]));
    panelEl.appendChild(ui.section(t('模型'), [modelGroup]));
    panelEl.appendChild(ui.section(t('執行'), [timeHint, previewBtn, runBtn]));
  }

  // ============================================================
  // 智慧偵測遮罩（取樣多幀，僅算一次，所有格共用）
  // ============================================================
  async function ensureSmartMasks(signal) {
    const boxes = state.watermark.boxes.filter((b) => state.watermark.smartDetect && !b.smartMask);
    if (boxes.length === 0 || !state.previewSink) return;
    const samples = [];
    const n = 10;
    for (let i = 0; i < n; i++) {
      if (signal && signal.aborted) return;
      const t = (state.info.duration * i) / n;
      const frame = await state.previewSink.getFrame(t);
      if (frame) samples.push(cloneCanvas(frame));
    }
    for (const b of boxes) {
      b.smartMask = buildSmartMask(samples, b) || null;
    }
  }

  // ============================================================
  // 「預覽此格效果」：只處理目前這一格
  // ============================================================
  async function previewCurrentFrame() {
    if (!state.info) return;
    const frame = await state.previewSink.getFrame(state.currentTime);
    if (!frame) {
      ctx.toast(t('無法取得目前這一格畫面'), 'error');
      return;
    }
    const source = cloneCanvas(frame);
    const result = await task.run({
      title: t('預覽處理中'),
      async run({ signal, progress }) {
        if (state.mode === 'watermark') {
          if (state.watermark.boxes.length === 0) {
            ctx.toast(t('請先框選水印區域'), 'error');
            return null;
          }
          await ensureSmartMasks(signal);
          return applyWatermarkRemoval(source, state.watermark.boxes, { signal, progress });
        }
        if (state.mode === 'matting') {
          const m = state.matting;
          let alpha = await predictFrameAlpha(source, { model: m.model, signal, onProgress: progress });
          alpha = applyAlphaCurve(alpha, m.retain);
          if (m.feather > 0) alpha = applyFeather(alpha, source.width, source.height, m.feather);
          return composeBackground(source, alpha, { bgMode: m.bgMode, bgColor: m.bgColor, blurPx: m.blurPx });
        }
        const u = state.upscale;
        return upscaleFrame(source, { model: u.model, scale: u.scale, signal, onProgress: progress });
      },
    });
    if (!result) return;
    const pctx = previewCanvas.getContext('2d');
    previewCanvas.width = result.width;
    previewCanvas.height = result.height;
    pctx.clearRect(0, 0, result.width, result.height);
    pctx.drawImage(result, 0, 0);
    ctx.toast(t('已顯示此格的處理結果（拖動時間軸可恢復原始畫面）'), 'success');
  }

  // ============================================================
  // 整支影片輸出：去水印
  // ============================================================
  async function runWatermarkExport() {
    if (!state.info) return;
    if (state.watermark.boxes.length === 0) {
      ctx.toast(t('請先框選水印區域'), 'error');
      return;
    }
    const container = state.watermark.container;
    const codecs = await pickOutputCodecs({
      container,
      hasAudio: state.info.hasAudio,
      width: state.info.width,
      height: state.info.height,
      fps: state.info.fps,
    });
    if (!codecs.ok) {
      ctx.toast(codecs.reason, 'error');
      return;
    }
    const totalFrames = Math.max(1, Math.round(state.info.duration * state.info.fps));
    const buffer = await task.run({
      title: t('去水印處理中'),
      async run({ signal, progress }) {
        await ensureSmartMasks(signal);
        let done = 0;
        return runPipeline({
          file: state.file,
          container,
          alpha: false,
          videoCodec: codecs.videoCodec,
          audioCodec: codecs.audioCodec,
          onFrame: () => {
            done += 1;
            progress(done / totalFrames, t('第 {done} / 約 {total} 格', { done, total: totalFrames }));
          },
          onProgress: (p) => progress(p, t('第 {done} / 約 {total} 格', { done, total: totalFrames })),
          async processFrame(canvas, index) {
            return applyWatermarkRemoval(canvas, state.watermark.boxes, { signal });
          },
          signal,
        });
      },
    });
    if (!buffer) return;
    showResult(buffer, container, 'watermark');
  }

  // ============================================================
  // 整支影片輸出：去背
  // ============================================================
  async function runMattingExport() {
    if (!state.info) return;
    const m = state.matting;
    const container = m.bgMode === 'transparent' ? 'webm' : state.inputContainer;
    const alpha = m.bgMode === 'transparent';
    const codecs = await pickOutputCodecs({
      container,
      hasAudio: state.info.hasAudio,
      width: state.info.width,
      height: state.info.height,
      fps: state.info.fps,
    });
    if (!codecs.ok) {
      ctx.toast(codecs.reason, 'error');
      return;
    }
    const totalFrames = Math.max(1, Math.round(state.info.duration * state.info.fps));
    const flicker = createFlickerReducer({
      alphaMin: 0.5 - (m.flickerStrength / 100) * 0.3,
      alphaMax: 0.95,
    });
    const buffer = await task.run({
      title: t('去背處理中'),
      async run({ signal, progress }) {
        let done = 0;
        return runPipeline({
          file: state.file,
          container,
          alpha,
          videoCodec: codecs.videoCodec,
          audioCodec: codecs.audioCodec,
          onFrame: () => {
            done += 1;
            progress(done / totalFrames, t('第 {done} / 約 {total} 格', { done, total: totalFrames }));
          },
          async processFrame(canvas) {
            let a = await predictFrameAlpha(canvas, { model: m.model, signal });
            a = applyAlphaCurve(a, m.retain);
            if (m.feather > 0) a = applyFeather(a, canvas.width, canvas.height, m.feather);
            if (m.flickerOn) a = flicker.apply(a, canvas);
            return composeBackground(canvas, a, { bgMode: m.bgMode, bgColor: m.bgColor, blurPx: m.blurPx });
          },
          signal,
        });
      },
    });
    if (!buffer) return;
    showResult(buffer, container, 'matting');
  }

  // ============================================================
  // 整支影片輸出：放大
  // ============================================================
  async function runUpscaleExport() {
    if (!state.info) return;
    const u = state.upscale;
    const outSize = computeUpscaledSize(state.info.width, state.info.height, u.scale);
    const container = state.inputContainer;
    const codecs = await pickOutputCodecs({
      container,
      hasAudio: state.info.hasAudio,
      width: outSize.width,
      height: outSize.height,
      fps: state.info.fps,
    });
    if (!codecs.ok) {
      ctx.toast(codecs.reason, 'error');
      return;
    }
    const totalFrames = Math.max(1, Math.round(state.info.duration * state.info.fps));
    let firstFrameMs = 0;
    const buffer = await task.run({
      title: t('放大處理中'),
      async run({ signal, progress }) {
        let done = 0;
        return runPipeline({
          file: state.file,
          container,
          alpha: false,
          videoCodec: codecs.videoCodec,
          audioCodec: codecs.audioCodec,
          outputSize: outSize,
          async processFrame(canvas, index) {
            const t0 = performance.now();
            const out = await upscaleFrame(canvas, { model: u.model, scale: u.scale, signal });
            if (index === 0) firstFrameMs = performance.now() - t0;
            done += 1;
            const remain = estimateRemainingMs(firstFrameMs, totalFrames, done);
            progress(
              done / totalFrames,
              t('第 {done} / 約 {total} 格，預估剩餘 {remain}', { done, total: totalFrames, remain: formatDuration(remain) }),
            );
            return out;
          },
          signal,
        });
      },
    });
    if (!buffer) return;
    showResult(buffer, container, 'upscale');
  }

  // ============================================================
  // 結果展示：輸出影片播放 + 前後對比拖曳線 + 下載
  // ============================================================
  function showResult(buffer, container, modeKey) {
    resetResult();
    const mime = containerMime(container);
    const blob = new Blob([buffer], { type: mime });
    state.resultUrl = URL.createObjectURL(blob);
    state.originalUrl = URL.createObjectURL(state.file);

    previewWrap.style.display = 'none';
    timelineRow.style.display = 'none';
    resultWrap.style.display = 'flex';
    resultWrap.innerHTML = '';

    const compareBox = document.createElement('div');
    compareBox.className = 'vw-compare-box' + (modeKey === 'matting' && containerMime(container) === 'video/webm' ? ' vw-checker-bg' : '');

    const beforeVideo = document.createElement('video');
    beforeVideo.className = 'vw-compare-video vw-compare-before';
    beforeVideo.src = state.originalUrl;
    beforeVideo.muted = true;
    beforeVideo.playsInline = true;

    const afterVideo = document.createElement('video');
    afterVideo.className = 'vw-compare-video vw-compare-after';
    afterVideo.src = state.resultUrl;
    afterVideo.playsInline = true;

    const divider = document.createElement('div');
    divider.className = 'vw-compare-divider';

    compareBox.appendChild(beforeVideo);
    compareBox.appendChild(afterVideo);
    compareBox.appendChild(divider);

    const sliderRow = document.createElement('input');
    sliderRow.type = 'range';
    sliderRow.min = '0';
    sliderRow.max = '100';
    sliderRow.value = '50';
    sliderRow.className = 'vw-compare-slider';
    function updateClip() {
      const pct = sliderRow.value;
      afterVideo.style.clipPath = `inset(0 0 0 ${pct}%)`;
      divider.style.left = `${pct}%`;
    }
    sliderRow.addEventListener('input', updateClip);
    updateClip();

    const controlsRow = document.createElement('div');
    controlsRow.className = 'vw-result-controls';
    resultComparePlaying = false;
    const resultPlayBtn = ui.button(t('播放比較'), () => {
      if (beforeVideo.paused) {
        beforeVideo.currentTime = 0;
        afterVideo.currentTime = 0;
        beforeVideo.play();
        afterVideo.play();
        resultComparePlaying = true;
        resultPlayBtn.textContent = t('暫停');
      } else {
        beforeVideo.pause();
        afterVideo.pause();
        resultComparePlaying = false;
        resultPlayBtn.textContent = t('播放比較');
      }
    });
    beforeVideo.addEventListener('timeupdate', () => {
      if (Math.abs(beforeVideo.currentTime - afterVideo.currentTime) > 0.15) {
        afterVideo.currentTime = beforeVideo.currentTime;
      }
    });
    const downloadBtn = ui.button(
      t('下載影片'),
      () => {
        const base = stripExt(state.file.name || '影片');
        const ext = container === 'webm' ? 'webm' : 'mp4';
        downloadArrayBuffer(buffer, `${base}-${FILE_MODE_CODE[modeKey]}.${ext}`, mime);
        ctx.toast(t('已開始下載'), 'success');
      },
      { primary: true },
    );
    const backBtn = ui.button(t('返回編輯'), () => {
      resetResult();
      seekTo(state.currentTime);
    });
    controlsRow.appendChild(resultPlayBtn);
    controlsRow.appendChild(downloadBtn);
    controlsRow.appendChild(backBtn);

    resultWrap.appendChild(compareBox);
    resultWrap.appendChild(sliderRow);
    resultWrap.appendChild(controlsRow);

    resultRefs = { resultPlayBtn, downloadBtn, backBtn };
    ctx.toast(t('處理完成'), 'success');
  }

  // ============================================================
  // 模式切換（側欄，僅 allowModeSwitch 時顯示）
  // ============================================================
  const modeButtons = []; // { key, btn }，供語系切換時重新套用文字
  if (sidebarEl) {
    const makeModeBtn = (key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vw-mode-btn' + (state.mode === key ? ' selected' : '');
      btn.textContent = t(MODE_LABELS[key]);
      btn.addEventListener('click', () => {
        if (state.mode === key) return;
        state.mode = key;
        for (const b of sidebarEl.children) b.classList.remove('selected');
        btn.classList.add('selected');
        if (state.info && state.previewSink) {
          const needsAlpha = key === 'matting' && state.matting.bgMode === 'transparent';
          state.previewSink.dispose();
          state.previewSink = createPreviewSink(state.info.videoTrack, { alpha: needsAlpha });
        }
        renderModePanel();
        if (state.info) seekTo(state.currentTime);
      });
      modeButtons.push({ key, btn });
      return btn;
    };
    sidebarEl.appendChild(makeModeBtn('watermark'));
    sidebarEl.appendChild(makeModeBtn('matting'));
    sidebarEl.appendChild(makeModeBtn('upscale'));
  }

  renderModePanel();

  // ============================================================
  // 語系切換：重畫靜態文字，不影響已載入的影片／框選／設定狀態
  // ============================================================
  function applyLang() {
    dropzone.textContent = t('點擊或拖曳 MP4 / WebM 影片檔到此處');
    for (const { key, btn } of modeButtons) btn.textContent = t(MODE_LABELS[key]);
    renderModePanel();
    if (resultRefs) {
      resultRefs.resultPlayBtn.textContent = resultComparePlaying ? t('暫停') : t('播放比較');
      resultRefs.downloadBtn.textContent = t('下載影片');
      resultRefs.backBtn.textContent = t('返回編輯');
    }
  }
  const unsubscribeLang = onLangChange(applyLang);

  // ============================================================
  // 對外介面
  // ============================================================
  const api = {
    loadFile,
    // 內嵌模式專用：panelEl 內容會被外部（main.js 切工具時）清空，重新掛回來後呼叫這個
    // 把目前狀態的設定面板重畫一次；stageEl 本身不會被清空，不需要重建。
    refreshPanel: renderModePanel,
    destroy() {
      destroyed = true;
      stopPlay();
      unsubscribeLang();
      if (state.previewSink) state.previewSink.dispose();
      resetResult();
      task.destroy();
      if (container) container.innerHTML = '';
    },
  };
  // 測試/除錯用掛鉤：main.js 的 videoWorkspaceHandle 是模組內變數、外部拿不到，
  // 瀏覽器自動化工具沒有原生檔案選取能力時可用 window.__videoWorkspace.loadFile(file) 載入測試影片。
  if (typeof window !== 'undefined') window.__videoWorkspace = api;
  return api;
}
