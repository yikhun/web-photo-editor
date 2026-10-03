// 啟動、建立版面、註冊工具、頂部分頁「圖片編輯／影片工具」（hash 路由 #/image、#/video）
import { createBus } from './core/bus.js';
import { createDoc } from './core/doc.js';
import { createViewport } from './core/viewport.js';
import { createCompare } from './core/compare.js';
import { createTask } from './core/task.js';
import { createExportMenu } from './core/export.js';
import * as ui from './core/ui.js';
import { toast } from './core/ui.js';
import { t, getLang, setLang, onLangChange } from './core/i18n.js';
import tools from './tools/index.js';

const app = document.getElementById('app');

// ---------- 版面骨架 ----------
const topbar = ui.el('div');
topbar.id = 'topbar';

const logo = ui.el('div', 'topbar-logo', t('線上修圖'));

const tabs = ui.el('div', 'topbar-tabs');
const tabImage = ui.el('button', 'topbar-tab active', t('圖片編輯'));
tabImage.type = 'button';
const tabVideo = ui.el('button', 'topbar-tab', t('影片工具'));
tabVideo.type = 'button';
tabs.appendChild(tabImage);
tabs.appendChild(tabVideo);

function sep() {
  return ui.el('div', 'topbar-sep');
}

const historyGroup = ui.el('div', 'topbar-group');
const undoBtn = ui.button(t('復原'), () => doc.undo());
const redoBtn = ui.button(t('重做'), () => doc.redo());
const resetBtn = ui.button(t('重置'), () => doc.reset());
historyGroup.appendChild(undoBtn);
historyGroup.appendChild(redoBtn);
historyGroup.appendChild(resetBtn);

const compareGroup = ui.el('div', 'topbar-group');
const compareBtn = ui.button(t('按住對比'), null);
compareGroup.appendChild(compareBtn);

const zoomGroup = ui.el('div', 'topbar-group');
const zoomLabel = ui.el('span', 'topbar-zoom', '100%');
const fitBtn = ui.button(t('適合畫面'), () => viewport.fit());
zoomGroup.appendChild(zoomLabel);
zoomGroup.appendChild(fitBtn);

const spacer = ui.el('div', 'topbar-spacer');

// ---------- 語言切換（中 / EN）----------
const langGroup = ui.el('div', 'topbar-group');
const langBtnZh = ui.button('中', () => setLang('zh-TW'));
const langBtnEn = ui.button('EN', () => setLang('en'));
langGroup.appendChild(langBtnZh);
langGroup.appendChild(langBtnEn);
function refreshLangButtons() {
  const lang = getLang();
  langBtnZh.classList.toggle('primary', lang === 'zh-TW');
  langBtnEn.classList.toggle('primary', lang === 'en');
}
refreshLangButtons();

topbar.appendChild(logo);
topbar.appendChild(tabs);
topbar.appendChild(sep());
topbar.appendChild(historyGroup);
topbar.appendChild(sep());
topbar.appendChild(compareGroup);
topbar.appendChild(sep());
topbar.appendChild(zoomGroup);
topbar.appendChild(spacer);
// 匯出選單稍後掛上（需要 doc/bus），語言切換鈕掛在匯出旁邊（最右）

const mainBody = ui.el('div');
mainBody.id = 'main-body';

const sidebar = ui.el('div');
sidebar.id = 'sidebar';

const panel = ui.el('div');
panel.id = 'panel';

const stageWrap = ui.el('div');
stageWrap.id = 'stage-wrap';
const stageCanvas = document.createElement('canvas');
stageCanvas.id = 'stage';
stageWrap.appendChild(stageCanvas);

mainBody.appendChild(sidebar);
mainBody.appendChild(panel);
mainBody.appendChild(stageWrap);

app.appendChild(topbar);
app.appendChild(mainBody);

// ---------- 核心模組 ----------
const bus = createBus();
const doc = createDoc({ bus });
const viewport = createViewport({ stageWrapEl: stageWrap, canvasEl: stageCanvas, doc, bus });
const compare = createCompare({ viewport, doc, bus, stageWrapEl: stageWrap });
compare.bindHoldButton(compareBtn);
const task = createTask({ stageWrapEl: stageWrap, toast });
const exportMenu = createExportMenu({ doc, bus, toast });
topbar.appendChild(exportMenu.el);
topbar.appendChild(langGroup);

// ---------- ctx（傳給每個工具）----------
const ctx = {
  bus,
  doc,
  commit(canvas, label) {
    doc.commit(canvas, label);
  },
  preview(canvasOrNull) {
    viewport.preview(canvasOrNull);
  },
  viewport: {
    requestRender: viewport.requestRender,
    screenToImage: viewport.screenToImage,
    imageToScreen: viewport.imageToScreen,
    getScale: viewport.getScale,
    setOverlay: viewport.setOverlay,
    setInteraction: viewport.setInteraction,
  },
  runTask: (opts) => task.run(opts),
  showCompare: (before, after) => compare.showCompare(before, after),
  toast,
  ui,
  setTool: (id) => setTool(id),
};

// ---------- 工具切換 ----------
let currentToolId = null;

function renderSidebar() {
  sidebar.innerHTML = '';
  for (const tool of tools) {
    const btn = ui.el('button', 'tool-btn');
    btn.type = 'button';
    const iconWrap = ui.el('span');
    iconWrap.innerHTML = tool.icon || '';
    btn.appendChild(iconWrap);
    btn.appendChild(ui.el('span', 'tool-btn-label', t(tool.name)));
    btn.addEventListener('click', () => setTool(tool.id));
    btn.dataset.id = tool.id;
    sidebar.appendChild(btn);
  }
  updateSidebarActive();
}

function updateSidebarActive() {
  for (const btn of sidebar.querySelectorAll('.tool-btn')) {
    btn.classList.toggle('active', btn.dataset.id === currentToolId);
  }
}

function renderNeedsImageHint() {
  panel.innerHTML = '';
  const hint = ui.el('div', 'ui-empty-hint', t('請先新增圖片'));
  const goAddBtn = ui.button(t('前往「新增」'), () => setTool('add'), { primary: true });
  hint.appendChild(goAddBtn);
  panel.appendChild(hint);
}

function setTool(id) {
  const tool = tools.find((tl) => tl.id === id);
  if (!tool) return;

  if (currentToolId) {
    const prevTool = tools.find((tl) => tl.id === currentToolId);
    if (prevTool && prevTool.deactivate) {
      try {
        prevTool.deactivate(ctx);
      } catch (err) {
        console.error('[main] 工具 deactivate 失敗', err);
      }
    }
  }
  viewport.setOverlay(null);
  viewport.setInteraction(null);
  viewport.preview(null);

  currentToolId = id;
  updateSidebarActive();

  if (tool.needsImage && !doc.hasImage()) {
    renderNeedsImageHint();
  } else {
    panel.innerHTML = '';
    try {
      tool.mount(panel, ctx);
    } catch (err) {
      console.error(`[main] 工具 ${id} mount 失敗`, err);
    }
    if (tool.activate) {
      try {
        tool.activate(ctx);
      } catch (err) {
        console.error(`[main] 工具 ${id} activate 失敗`, err);
      }
    }
  }
  bus.emit('tool:change', { id });
}

// 圖片載入後，若目前工具因無圖而顯示提示，重新 mount 真正面板；並自動切到「調整」工具（由 add 工具呼叫 ctx.setTool）
bus.on('doc:load', () => {
  const tool = tools.find((tl) => tl.id === currentToolId);
  if (tool && tool.needsImage) {
    setTool(currentToolId);
  }
});

renderSidebar();
setTool(tools[0].id);

// ---------- 歷史按鈕狀態 ----------
function refreshHistoryButtons() {
  undoBtn.disabled = !doc.canUndo();
  redoBtn.disabled = !doc.canRedo();
  resetBtn.disabled = !doc.hasImage();
}
bus.on('history:change', refreshHistoryButtons);
refreshHistoryButtons();

// ---------- 復原/重做/重置：丟棄未套用的預覽與對比線 ----------
// doc.js 的 undo/redo/reset 會在 history 游標已指向新影像、但 'doc:change' 尚未送出前
// 先 emit 'history:navigate'；這裡統一清掉 viewport 的暫時預覽與對比線，
// 各工具（adjust/text）另外各自監聽此事件清自己的暫存狀態（見 ARCHITECTURE.md 事件清單）。
bus.on('history:navigate', () => {
  viewport.preview(null);
  compare.closeCompare();
});

// ---------- 縮放顯示 ----------
bus.on('viewport:zoom', ({ scale }) => {
  zoomLabel.textContent = `${Math.round(scale * 100)}%`;
});

// ---------- 鍵盤快捷鍵：復原/重做（焦點在 input/textarea 時不攔截）----------
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && e.shiftKey) {
    e.preventDefault();
    doc.redo();
  } else if (key === 'z') {
    e.preventDefault();
    doc.undo();
  } else if (key === 'y') {
    e.preventDefault();
    doc.redo();
  }
});

// ---------- 全域拖放與貼上：載入圖片（交給 add 工具的共用邏輯）----------
import { handleIncomingFiles } from './tools/add.js';

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length > 0) handleIncomingFiles(files, ctx);
});
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length > 0) handleIncomingFiles(files, ctx);
});

// ---------- hash 路由：#/image、#/video ----------
let videoWorkspaceHandle = null;

async function showVideoRoute() {
  mainBody.style.display = 'none';
  let videoRoot = document.getElementById('video-root');
  if (!videoRoot) {
    videoRoot = ui.el('div');
    videoRoot.id = 'video-root';
    videoRoot.style.flex = '1 1 auto';
    videoRoot.style.minHeight = '0';
    videoRoot.style.display = 'flex';
    app.appendChild(videoRoot);
  }
  videoRoot.style.display = 'flex';
  if (!videoWorkspaceHandle) {
    try {
      const mod = await import('./video/workspace.js');
      videoWorkspaceHandle = mod.createVideoWorkspace(videoRoot, { mode: 'watermark', ctx });
    } catch (err) {
      console.error('[main] 載入影片工作區失敗', err);
      videoRoot.innerHTML = `<div class="ui-empty-hint">${t('影片工具建置中')}</div>`;
    }
  }
}

function showImageRoute() {
  mainBody.style.display = 'flex';
  const videoRoot = document.getElementById('video-root');
  if (videoRoot) videoRoot.style.display = 'none';
}

function routeFromHash() {
  const hash = window.location.hash || '#/image';
  if (hash.startsWith('#/video')) {
    tabImage.classList.remove('active');
    tabVideo.classList.add('active');
    showVideoRoute();
  } else {
    tabVideo.classList.remove('active');
    tabImage.classList.add('active');
    showImageRoute();
  }
}

tabImage.addEventListener('click', () => {
  window.location.hash = '#/image';
});
tabVideo.addEventListener('click', () => {
  window.location.hash = '#/video';
});
window.addEventListener('hashchange', routeFromHash);
routeFromHash();

viewport.requestRender();

// ---------- 語系切換：重畫頂部工具列、左側工具欄、分頁文字、目前工具面板 ----------
function updateDocumentTitle() {
  document.title = t('線上修圖 — 純瀏覽器影像編輯');
}

onLangChange(() => {
  logo.textContent = t('線上修圖');
  tabImage.textContent = t('圖片編輯');
  tabVideo.textContent = t('影片工具');
  undoBtn.textContent = t('復原');
  redoBtn.textContent = t('重做');
  resetBtn.textContent = t('重置');
  compareBtn.textContent = t('按住對比');
  fitBtn.textContent = t('適合畫面');
  refreshLangButtons();
  updateDocumentTitle();

  renderSidebar();
  if (currentToolId) setTool(currentToolId);
});

updateDocumentTitle();
