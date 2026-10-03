// 對比功能：
// 1. 「按住對比」：按住頂部按鈕或鍵盤 `\` 時顯示原圖，放開恢復目前影像。
// 2. showCompare(before, after)：畫面上顯示可拖曳的垂直分隔線（左 before／右 after，
//    線上有把手與文字標籤），直到下次 commit／切工具或按「關閉對比」。
import { createCanvas } from './canvasUtil.js';
import { t, onLangChange } from './i18n.js';

export function createCompare({ viewport, doc, bus, stageWrapEl }) {
  let holdActive = false;
  let splitActive = false;
  let splitBefore = null;
  let splitAfter = null;
  let splitX = 0.5; // 0~1，影像寬度比例
  let dragging = false;
  let prevInteraction = null;

  // ---------- 關閉對比按鈕（畫布角落）----------
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ui-button compare-close-btn';
  closeBtn.style.display = 'none';
  closeBtn.addEventListener('click', () => closeSplit());
  stageWrapEl.appendChild(closeBtn);

  function refreshCloseBtnText() {
    closeBtn.textContent = `${t('關閉對比')} ✕`;
  }
  refreshCloseBtnText();
  onLangChange(() => {
    refreshCloseBtnText();
    if (splitActive) viewport.requestRender();
  });

  function composeAndPreview() {
    if (!splitBefore || !splitAfter) return;
    const w = splitAfter.width;
    const h = splitAfter.height;
    const out = createCanvas(w, h);
    const c2 = out.getContext('2d');
    c2.drawImage(splitAfter, 0, 0);
    const lineX = Math.round(w * splitX);
    if (lineX > 0) {
      c2.drawImage(splitBefore, 0, 0, lineX, h, 0, 0, lineX, h);
    }
    viewport.preview(out);
  }

  function overlay(ctx2d, view) {
    if (!splitActive || !splitAfter) return;
    const w = splitAfter.width;
    const h = splitAfter.height;
    const lineImgX = w * splitX;
    const top = view.imageToScreen(lineImgX, 0);
    const bottom = view.imageToScreen(lineImgX, h);
    const left = view.imageToScreen(0, 0);
    const right = view.imageToScreen(w, 0);

    // 分隔線
    ctx2d.save();
    ctx2d.strokeStyle = '#ffffff';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(top.x, top.y);
    ctx2d.lineTo(bottom.x, bottom.y);
    ctx2d.stroke();

    // 把手
    const handleY = (top.y + bottom.y) / 2;
    ctx2d.fillStyle = '#ffffff';
    ctx2d.beginPath();
    ctx2d.arc(top.x, handleY, 9, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = '#333';
    ctx2d.beginPath();
    ctx2d.moveTo(top.x - 3, handleY - 4);
    ctx2d.lineTo(top.x - 6, handleY);
    ctx2d.lineTo(top.x - 3, handleY + 4);
    ctx2d.moveTo(top.x + 3, handleY - 4);
    ctx2d.lineTo(top.x + 6, handleY);
    ctx2d.lineTo(top.x + 3, handleY + 4);
    ctx2d.stroke();

    // 文字標籤
    ctx2d.font = '12px sans-serif';
    ctx2d.textBaseline = 'top';
    const labelY = top.y + 8;
    ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
    ctx2d.fillRect(left.x + 8, labelY, 48, 20);
    ctx2d.fillRect(top.x + 8, labelY, 56, 20);
    ctx2d.fillStyle = '#fff';
    ctx2d.fillText(t('原圖'), left.x + 14, labelY + 4);
    ctx2d.fillText(t('處理後'), top.x + 14, labelY + 4);
    ctx2d.restore();
    void right; // 保留供未來延伸（例如右側也加標籤背景寬度計算）
  }

  function hitTestHandle(clientX, clientY) {
    if (!splitActive || !splitAfter) return false;
    const w = splitAfter.width;
    const lineImgX = w * splitX;
    const screen = viewport.imageToScreen(lineImgX, 0);
    return Math.abs(clientX - screen.x) < 12;
  }

  const splitInteraction = {
    cursor: 'ew-resize',
    onPointerDown(e) {
      const rectHit = hitTestHandleFromEvent(e);
      if (rectHit) {
        dragging = true;
      }
    },
    onPointerMove(e, p) {
      if (!dragging || !splitAfter) return;
      const w = splitAfter.width;
      splitX = Math.min(1, Math.max(0, p.x / w));
      composeAndPreview();
    },
    onPointerUp() {
      dragging = false;
    },
  };

  function hitTestHandleFromEvent(e) {
    return hitTestHandle(e.clientX, e.clientY);
  }

  function showSplit(before, after) {
    splitBefore = before;
    splitAfter = after;
    splitX = 0.5;
    splitActive = true;
    closeBtn.style.display = '';
    prevInteraction = null; // 覆蓋目前互動，關閉時不嘗試還原工具互動（工具 activate 會重新掛載）
    viewport.setInteraction(splitInteraction);
    viewport.setOverlay(overlay);
    composeAndPreview();
  }

  function closeSplit() {
    if (!splitActive) return;
    splitActive = false;
    splitBefore = null;
    splitAfter = null;
    closeBtn.style.display = 'none';
    viewport.setOverlay(null);
    viewport.setInteraction(null);
    viewport.preview(null);
  }

  // ---------- 按住對比（顯示原圖）----------
  function startHold() {
    if (holdActive || splitActive) return;
    if (!doc.hasImage()) return;
    holdActive = true;
    viewport.preview(doc.getOriginal());
  }

  function endHold() {
    if (!holdActive) return;
    holdActive = false;
    viewport.preview(null);
  }

  function bindHoldButton(btnEl) {
    btnEl.addEventListener('pointerdown', startHold);
    btnEl.addEventListener('pointerup', endHold);
    btnEl.addEventListener('pointerleave', endHold);
    btnEl.addEventListener('pointercancel', endHold);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== '\\') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    startHold();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key !== '\\') return;
    endHold();
  });

  // commit 或切工具時自動關閉 split 對比
  bus.on('doc:change', () => closeSplit());
  bus.on('tool:change', () => closeSplit());

  return {
    showCompare: showSplit,
    closeCompare: closeSplit,
    bindHoldButton,
    isSplitActive: () => splitActive,
  };
}
